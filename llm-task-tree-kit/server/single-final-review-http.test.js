import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

for(const mode of ['pass','failed','peer','expand','late']) test(`real IDE endpoint delegates workers with one final checker (${mode})`, {timeout:60000},async t=>{
  const verdict=mode==='failed'?'failed':'pass';
  const root=await mkdtemp(path.join(os.tmpdir(),'single-final-http-'));
  let child,provider,releaseQuestion,releaseAnswer;
  // One owner and explicit order: the server still persists background state
  // after returning the final HTTP status. Never remove its directory first.
  t.after(async()=>{
    releaseQuestion?.();releaseAnswer?.();
    try {
      if(child&&child.exitCode===null&&child.signalCode===null){
        await new Promise(resolve=>{
          const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
          child.once('exit',()=>{clearTimeout(timer);resolve();});
          child.once('error',()=>{clearTimeout(timer);resolve();});
          child.kill('SIGTERM');
        });
      }
    } finally {
      try {
        if(provider){
          await new Promise(resolve=>{
            provider.close(()=>resolve());
            provider.closeAllConnections();
          });
        }
      } finally {await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
    }
  });
  const codexHome=path.join(root,'codex');await mkdir(codexHome);
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 完整目标\n- Problem: 并行交付A与B\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const calls=[],counts={parent:0,worker:0,review:0,strategy:0};
  let receivedQuestion=false,receivedAnswer=false;
  const questionStored=new Promise(resolve=>releaseQuestion=resolve),answerStored=new Promise(resolve=>releaseAnswer=resolve);
  const replyTool=(name,args)=>({content:null,tool_calls:[{id:`c-${calls.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  provider=http.createServer(async(req,res)=>{
    try {
      let raw='';for await(const c of req)raw+=c;
      const body=JSON.parse(raw);calls.push(body);
      const names=body.tools?.map(t=>t.function.name)||[];
      let message;
      if(names.includes('task_tree_plan_execute')&&body.tool_choice==='required'&&['expand','late'].includes(mode)){
        counts.strategy++;
        message=replyTool('task_tree_continue_single',{reason:'先核对并准备当前已有接口，再委派剩余工作',nextCheckpoint:'准备共享接口后立即发布分工'});
      }else if(names.includes('task_tree_plan_execute')){
        counts.parent++;
        assert.ok(counts.parent<=(mode==='late'?3:mode==='expand'?2:1),'parent must not resume after delegation');
        if(mode==='late'&&counts.parent<=2){
          assert.equal(body.tool_choice,'auto');
          message=replyTool('read_file',{path:'task-tree.md'});
        }else {
        if(mode==='late'){
          assert.equal(body.tool_choice,'auto');
          assert.ok(names.includes('task_tree_plan_execute')&&names.includes('exec_command'));
        }
        message=mode==='expand'&&counts.parent===1
          ?replyTool('exec_command',{command:`${JSON.stringify(process.execPath)} --input-type=module -e "import {writeFile} from 'node:fs/promises';await writeFile('interface.txt','parent-ready');"`})
          :replyTool('task_tree_plan_execute',{reason:'两个独立成果',sharedContract:'两文件均为UTF-8文本',jobs:['A','B'].map(taskId=>({taskId,title:taskId,instruction:`保存${taskId}.txt，内容为${taskId}`}))});
        }
      }else if(names.includes('task_tree_continue_single')&&!names.includes('exec_command')){
        counts.strategy++;
        message=replyTool('task_tree_continue_single',{reason:'本分支只交付一个短文件，等待同轮接口答复，不再拆微任务',nextCheckpoint:'文件保存且收到批量接口答复后'});
      }else if(names.includes('completion_review_submit')){
        if(!body.messages.some(m=>m.role==='tool'&&m.name==='read_file'&&m.content.includes('task-tree-coordination/v1'))){
          message=replyTool('read_file',{path:'.task-tree-runs/coordination-evidence.json'});
        }else{
        counts.review++;
        const text=body.messages.filter(m=>typeof m.content==='string').map(m=>m.content).join('\n');
        assert.match(text,mode==='expand'?/interface\.txt/:/A\.txt/);assert.match(text,/B\.txt/);assert.match(text,/两文件均为UTF-8/);
        if(mode==='expand'){
          assert.equal(await readFile(path.join(root,'interface.txt'),'utf8'),'parent-ready');
          for(const id of ['A.one','A.two'])assert.equal(await readFile(path.join(root,`${id}.txt`),'utf8'),id);
        }else assert.equal(await readFile(path.join(root,'A.txt'),'utf8'),'A');
        assert.equal(await readFile(path.join(root,'B.txt'),'utf8'),'B');
        message=replyTool('completion_review_submit',verdict==='pass'
          ?{verdict:'pass',reason:'A与B均实际交付，接口一致',evidence:['实际文件A.txt内容A','实际文件B.txt内容B'],dependencyScope:{complete:false,files:[]}}
          :{verdict:'failed',reason:'任务还缺少联合入口',evidence:['A和B存在但目标联合入口未交付'],dependencyScope:{complete:false,files:[]},rootCause:'Planner分工遗漏联合入口',caseStudy:'从原目标到分工再到整合文件，首次遗漏在分工阶段',solution:'补齐联合入口的独立任务再执行'});
        }
      }else{
        counts.worker++;
        assert.ok(names.includes('task_tree_peer_exchange'));
        assert.ok(!names.includes('structured_result_submit'),'ordinary worker report needs no terminal format');
        const prompt=body.messages.findLast(m=>typeof m.content==='string'&&m.content.includes('Task id:'))?.content;
        const taskId=prompt.match(/^Task id: (.+)$/m)[1];
        const peerReceipt=body.messages.some(m=>m.role==='tool'&&m.name==='task_tree_peer_exchange');
        const peerMessage=body.messages.findLast(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('【同轮分支消息'));
        if(mode==='expand'&&taskId==='A'){
          assert.ok(names.includes('task_tree_split_work'));
          message=replyTool('task_tree_split_work',{reason:'发现两项独立剩余交付',jobs:['one','two'].map(taskId=>({taskId,title:taskId,instruction:`保存A.${taskId}.txt，内容为A.${taskId}`}))});
        }else if(mode==='peer'&&taskId==='A'&&!peerReceipt){
          message=replyTool('task_tree_peer_exchange',{resume:'A负责A文件，下一步保存A；不接管B',questions:[{toTaskId:'B',key:'text',question:'UTF-8接口的内容是什么？错误依据是什么？'}]});
        }else if(mode==='peer'&&taskId==='B'&&peerMessage&&!peerReceipt){
          const items=JSON.parse(peerMessage.content.split('\n')[1]);
          assert.match(peerMessage.content,/保存B|保存B\.txt/);
          receivedQuestion=true;
          message=replyTool('task_tree_peer_exchange',{resume:'B已保存，下一步提交真实成果',answers:[{requestId:items[0].requestId,answer:'B的内容为B，错误依据是命令退出码'}]});
        }else if(!body.messages.some(m=>m.role==='tool'&&m.name==='exec_command')){
          if(mode==='peer'&&taskId==='A')releaseQuestion();
          if(mode==='peer'&&taskId==='B')await questionStored;
          const program=`import {writeFile} from 'node:fs/promises';await writeFile('${taskId}.txt','${taskId}');console.log('已保存${taskId}');`;
          message=replyTool('exec_command',{command:`${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify(program)}`});
        }else {
          if(mode==='peer'&&taskId==='B'&&peerReceipt)releaseAnswer();
          if(mode==='peer'&&taskId==='A'){
            await answerStored;
            if(peerMessage){assert.match(peerMessage.content,/A负责A文件/);assert.match(peerMessage.content,/B的内容为B/);receivedAnswer=true;}
          }
          message={content:`${taskId}.txt实际保存，命令退出成功。`};
        }
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}]}));
    }catch(error){res.writeHead(400);res.end(error.stack);}
  });
  await new Promise((resolve,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',resolve);});
  const source=path.resolve(import.meta.dirname,'..');
  child=spawn(process.execPath,[path.join(source,'server.js')],{cwd:source,env:{...process.env,
    CODEX_HOME:codexHome,PORT:'0',TASK_TREE_PROJECT_ROOT:root,TASK_TREE_NO_OPEN:'1',
    TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),TASK_TREE_API_CONNECTIONS_FILE:path.join(root,'api.json'),
    MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${provider.address().port}`,MODEL_AGENT_MAIN_API_KEY:'fixture',
    MODEL_AGENT_MAIN_MODEL:'fixture',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:''},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{
    let log='',err='';child.stderr.on('data',c=>err+=c);
    const fail=error=>{clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new Error(err||'启动超时')),15000);
    child.stdout.on('data',c=>{log+=c;const m=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);child.off('exit',exited);child.off('error',fail);resolve(m[1]);}});
    const exited=(code,signal)=>fail(new Error(`测试服务启动前退出：${code??signal} ${err}`));
    child.once('error',fail);child.once('exit',exited);
  });
  const accepted=await(await fetch(url+'/api/codex/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({progress:true,treeId:'method',nodeId:'ROOT',prompt:'并行交付A.txt和B.txt'})})).json();
  let result;
  for(let i=0;i<1500;i++){
    const state=await(await fetch(url+'/api/codex/runs')).json();
    result=state.runs?.find(r=>r.id===accepted.id);
    if(result&&['completed','failed','stopped'].includes(result.status))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(result?.status,verdict==='pass'?'completed':'failed',JSON.stringify(result));
  assert.equal(counts.parent,mode==='late'?3:mode==='expand'?2:1);assert.equal(counts.review,1);
  if(mode==='peer'){assert.ok(receivedQuestion&&receivedAnswer);assert.ok(counts.worker>=6&&counts.worker<=7);}
  else if(mode==='expand'){assert.equal(counts.worker,7);assert.equal(calls.length-counts.strategy,11);}
  else {assert.equal(counts.worker,4);assert.equal(calls.length-counts.strategy,mode==='late'?9:7);}
  assert.equal(result.review.verdict,verdict);
  if(mode==='expand'){
    for(const id of ['A.one','A.two'])assert.equal(await readFile(path.join(root,`${id}.txt`),'utf8'),id);
    assert.ok(result.events.some(event=>event.type==='worker/status'&&event.text.includes('继续拆分为 2 个任务')));
    assert.ok(result.parallel.jobs.some(job=>job.parentTaskId==='A'));
  }else assert.equal(await readFile(path.join(root,'A.txt'),'utf8'),'A');
  assert.equal(await readFile(path.join(root,'B.txt'),'utf8'),'B');
  if(verdict==='pass'){
    assert.ok(result.changedFiles.includes(mode==='expand'?'interface.txt':'A.txt'));assert.ok(result.changedFiles.includes('B.txt'));
  }else assert.match(result.error?.message||result.error,/根因[：:]|Planner分工遗漏/);
});
