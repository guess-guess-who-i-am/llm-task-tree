import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';

test('IDE startup automatically resumes original dirty node workspace and accepts one final review over HTTP',{timeout:60000},t=>exercise(t,false));
test('IDE startup after worker completion resumes only final checking, never the worker',{timeout:60000},t=>exercise(t,true));
test('failed final checking can resume the saved completed worker through the public route',{timeout:60000},t=>exercise(t,true,true));
test('explicit fresh resume keeps the stopped workspace and reads its full checkpoint through the public route',{timeout:60000},t=>exercise(t,false,false,true));
async function exercise(t,workerCompleted,failedReview=false,explicitFresh=false) {
  const source=path.resolve(import.meta.dirname,'..');
  const root=await mkdtemp(path.join(os.tmpdir(),'ide-recovery-http-'));
  const codexHome=path.join(root,'codex');await mkdir(codexHome);
  let child,workerPid;const bodies=[],providerErrors=[];
  const provider=http.createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);bodies.push(body);
      const checking=body.tools?.some(t=>t.function.name==='completion_review_submit');
      const choosing=body.tool_choice==='required'&&body.tools?.some(t=>t.function.name==='task_tree_continue_single');
      let message;
      if(checking)message={tool_calls:[{id:'review-final',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify({verdict:'pass',reason:'真实文件保留前半段并完成后半段',evidence:['partial.txt与final.txt存在']})}}]};
      else if(choosing)message={tool_calls:[{id:'resume-single',type:'function',function:{name:'task_tree_continue_single',arguments:JSON.stringify({reason:'前半段已完成，只需续写一个文件',nextCheckpoint:'保留partial.txt并写入final.txt'})}}]};
      else if(!body.messages.some(m=>m.role==='tool'&&m.name==='exec_command')) {
        if(explicitFresh){
          assert.ok(JSON.stringify(body.messages).includes('从检查点继续'));
          assert.ok(!body.messages.some(m=>m.role==='assistant'&&m.content==='部分输出已保存'),'old assistant history stays on demand, not replayed');
        }else{
          assert.ok(JSON.stringify(body.messages).includes('服务重启续跑'));
          assert.ok(JSON.stringify(body.messages).includes('部分输出已保存'));
        }
        const check=explicitFresh?"const c=JSON.parse(await readFile('.task-tree-runs/original-run.coordination-checkpoint.json','utf8'));if(c.previousThreadId!=='old-persisted-thread'||c.output!=='部分输出已保存')throw Error('lost recovery source');":'';
        message={tool_calls:[{id:'resume-write',type:'function',function:{name:'exec_command',arguments:JSON.stringify({command:`${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify("import{readFile,writeFile}from'node:fs/promises';"+check+"if(await readFile('partial.txt','utf8')!=='已完成前半段')throw Error('lost checkpoint');await writeFile('final.txt','完成后半段');console.log('resume-verified');")}`})}}]};
      }else message={content:'已保留前半段并接续完成'};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
    }catch(error){if(!providerErrors.includes(error.message))providerErrors.push(error.message);res.writeHead(400);res.end(error.message);}
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
    if(workerPid)try{process.kill(workerPid,'SIGTERM');}catch{}
    await new Promise(r=>{provider.close(r);provider.closeAllConnections();});
    await rm(root,{recursive:true,force:true});
  });
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 恢复验证\n- Problem: 完成前后两部分\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const workspace=createDirectNodeWorkspace({projectRoot:root});
  const checkpoint=await workspace.prepare('original-run');
  await writeFile(path.join(checkpoint.workerPath,'partial.txt'),'已完成前半段');
  if(workerCompleted)await writeFile(path.join(checkpoint.workerPath,'final.txt'),'完成后半段');
  await writeFile(path.join(root,'.task-tree-direct-state.json'),JSON.stringify({schema:'task-tree-direct-state/v2',runs:[{
    id:'original-run',treeId:'method',nodeId:'ROOT',conversationId:'original-conversation',status:explicitFresh?'stopped':failedReview?'failed':'running',threadId:explicitFresh?'old-persisted-thread':'',
    prompt:'完成前后两部分',messages:[{role:'user',content:'完成前后两部分'}],output:'部分输出已保存',checkpoint,workerCompleted,
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  }],conversations:[]}));
  child=spawn(process.execPath,[path.join(source,'server.js')],{cwd:source,env:{...process.env,
    PORT:'0',TASK_TREE_PROJECT_ROOT:root,TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'missing.env'),TASK_TREE_API_CONNECTIONS_FILE:path.join(root,'api.json'),
    CODEX_HOME:codexHome,TASK_TREE_NO_OPEN:'1',MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${provider.address().port}`,
    MODEL_AGENT_MAIN_API_KEY:'fixture-only',MODEL_AGENT_MAIN_MODEL:'fixture-model',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:'',MODEL_AGENT_MAIN_FALLBACK_MODELS:''
  },stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{
    let log='',errors='';const timer=setTimeout(()=>reject(new Error('startup timeout '+errors)),10000);
    child.stderr.on('data',c=>errors+=c);child.stdout.on('data',c=>{log+=c;const m=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
    child.once('error',reject);
  });
  if(failedReview||explicitFresh) {
    assert.equal(bodies.length,0,'terminal failures do not restart without a user request');
    const response=await fetch(base+'/api/codex/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      progress:true,treeId:'method',nodeId:'ROOT',resumeRunId:'original-run',prompt:'继续验收已完成成果',...(explicitFresh?{fresh:true}:{})
    })});
    assert.equal(response.status,202,await response.text());
  }
  let run;
  for(let i=0;i<1200;i++) {
    const response=await fetch(base+'/api/codex/run/original-run');const body=await response.json();run=body.run;
    workerPid=run?.timing?.workerPid||workerPid;
    if(providerErrors.length)break;
    if(run&&['completed','failed','stopped'].includes(run.status))break;
    await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(run?.status,'completed',JSON.stringify({error:run?.error,phase:run?.phase,activity:run?.activity,requests:bodies.length,providerErrors}));
  assert.equal(run.id,'original-run');assert.equal(run.review.verdict,'pass');
  assert.equal(await readFile(path.join(root,'partial.txt'),'utf8'),'已完成前半段');
  assert.equal(await readFile(path.join(root,'final.txt'),'utf8'),'完成后半段');
  assert.equal(bodies.filter(b=>b.tools?.some(t=>t.function.name==='completion_review_submit')).length,1);
  assert.equal(bodies.length,workerCompleted?1:4);
  const saved=JSON.parse(await readFile(path.join(root,'.task-tree-direct-state.json'),'utf8'));
  assert.equal(saved.runs[0].recoveryPending,false);
  assert.ok(saved.conversations[0].messages.some(m=>m.content==='部分输出已保存'));
  assert.ok(!JSON.stringify(saved).includes('resume-write'));
}
