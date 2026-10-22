import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for(const outcome of ['pass','failed','stopped'])test(`IDE publishes live review activity and a real terminal result (${outcome})`,{timeout:45000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-lifecycle-'));
  const codexHome=path.join(root,'codex');await mkdir(codexHome);
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 只读说明\n- Problem: 说明当前树的用途\n- CurrentResult: 当前树记录任务状态。\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  let release,reviewCalls=0,workerCalls=0;
  const barrier=new Promise(resolve=>{release=resolve;});
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(body.tool_choice==='required'&&body.tools?.some(tool=>tool.function.name==='task_tree_continue_single')) {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'single-readonly',type:'function',function:{name:'task_tree_continue_single',arguments:JSON.stringify({reason:'单一只读说明无需拆分',nextCheckpoint:'解释当前树用途'})}}]},finish_reason:'tool_calls'}]}));
      return;
    }
    if(!body.tools?.some(tool=>tool.function.name==='completion_review_submit')) {
      workerCalls++;
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'当前树记录任务状态。执行者工作已结束，结果待宿主整合验收。'},finish_reason:'stop'}]}));
      return;
    }
    reviewCalls++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'正在核对当前树的说明。'},finish_reason:null}]})+'\n\n');
    await barrier;
    if(res.destroyed)return;
    const verdict={verdict:outcome==='failed'?'failed':'pass',reason:outcome==='failed'?'缺少用户所需的解释':'说明与当前树一致',evidence:['已对照当前树'],dependencyScope:{complete:false,files:[]},treeState:{status:'consistent',reason:'只读说明不改变已有状态'},
      ...(outcome==='failed'?{rootCause:'执行者没有解释具体字段',caseStudy:'从用户要求对照输出，发现字段解释缺失',solution:'补充字段含义后再验收'}:{})};
    res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'verdict',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify(verdict)}}]},finish_reason:'tool_calls'}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const source=path.resolve(import.meta.dirname,'..');
  const child=spawn(process.execPath,[path.join(source,'server.js')],{cwd:source,env:{...process.env,
    CODEX_HOME:codexHome,PORT:'0',TASK_TREE_PROJECT_ROOT:root,TASK_TREE_NO_OPEN:'1',
    TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),TASK_TREE_API_CONNECTIONS_FILE:path.join(root,'api.json'),
    MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${provider.address().port}`,MODEL_AGENT_MAIN_API_KEY:'fixture',
    MODEL_AGENT_MAIN_MODEL:'fixture',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:''},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    release();child.kill();provider.closeAllConnections();
    await new Promise(resolve=>provider.close(resolve));
    if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
    await rm(root,{recursive:true,force:true});
  });
  const url=await new Promise((resolve,reject)=>{
    let log='',err='';const timer=setTimeout(()=>reject(new Error(err||'server startup failed')),12000);
    child.stderr.on('data',chunk=>{err+=chunk;});
    child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('error',reject);
  });
  const accepted=await(await fetch(url+'/api/codex/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({progress:true,treeId:'method',nodeId:'ROOT',prompt:'只读解释当前树，不修改文件，不需要分工。'})})).json();
  const poll=async predicate=>{
    for(let i=0;i<1000;i++){
      const state=await(await fetch(url+'/api/codex/runs')).json();
      const run=state.runs?.find(item=>item.id===accepted.id);
      if(run&&predicate(run))return run;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('expected lifecycle state did not arrive');
  };
  const reviewing=await poll(run=>run.reviewActivity?.receivedChars>0);
  assert.equal(reviewing.status,'running');assert.equal(reviewing.workerCompleted,true);
  assert.match(reviewing.reviewActivity.message,/正在接收验收输出/);
  assert.match(reviewing.output,/结果待宿主/);
  await new Promise(resolve=>setTimeout(resolve,650));
  const saved=JSON.parse(await readFile(path.join(root,'.task-tree-direct-state.json'),'utf8'));
  assert.equal(saved.runs[0].workerCompleted,true);
  assert.equal(saved.runs[0].phase,'checking');
  assert.ok(saved.runs[0].reviewActivity.receivedChars>0);
  assert.ok(!JSON.stringify(saved).includes('正在核对当前树的说明。'),'checker prose is not the user dialogue');
  if(outcome==='stopped')await fetch(`${url}/api/codex/run/${accepted.id}/stop`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({treeId:'method',nodeId:'ROOT'})});
  else release();
  const final=await poll(run=>['completed','failed','stopped'].includes(run.status));
  assert.equal(final.status,outcome==='pass'?'completed':outcome);
  assert.equal(final.progress.estimatedRemainingMs,0);
  assert.equal(reviewCalls,1);assert.equal(workerCalls,1);
  if(outcome!=='stopped')assert.equal(final.review.verdict,outcome);
  if(outcome==='failed')assert.match(final.error,/根因/);
});
