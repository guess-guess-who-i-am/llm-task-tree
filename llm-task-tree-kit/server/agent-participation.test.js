import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPeerMailbox} from './peer-mailbox.js';
import {recordAgentActivity} from './agent-activity.js';
import {createParallelCodexCoordinator} from './codex-coordinator.js';

const fixture=()=>({status:'running',jobs:[{taskId:'a',status:'running',instruction:'完成A'},{taskId:'b',status:'running',instruction:'完成B'}]});
test('human guidance is durable, idempotent, scoped and delivered with peer mail once',async()=>{
  const run=fixture();let saves=0;
  let mailbox=createPeerMailbox(run,{persist:async()=>{saves++;}});
  const body={taskId:'a',content:'请使用中文，补齐错误处理',clientMessageId:'human-1'};
  const message=await mailbox.sendUserMessage(body);
  assert.equal(message.status,'queued');
  assert.equal((await mailbox.sendUserMessage(body)).id,message.id);
  assert.equal(run.userMessages.length,1);
  await assert.rejects(mailbox.sendUserMessage({...body,taskId:'b'}),{code:'MESSAGE_ID_CONFLICT'});
  await assert.rejects(mailbox.sendUserMessage({...body,content:'不同内容'}),{code:'MESSAGE_ID_CONFLICT'});
  await assert.rejects(mailbox.sendUserMessage({...body,content:' '}),{code:'INVALID_AGENT_MESSAGE'});
  await assert.rejects(mailbox.sendUserMessage({...body,taskId:'unknown'}),{code:'AGENT_NOT_FOUND'});
  // Reconstruct from persisted state before delivery, like a service restart.
  const restored=JSON.parse(JSON.stringify(run));mailbox=createPeerMailbox(restored);
  await mailbox.exchange('b',{resume:'继续B',questions:[{toTaskId:'a',question:'接口字段？'}]});
  const b=await mailbox.drain('b');assert.deepEqual(b,[]);
  const a=await mailbox.drain('a');
  assert.equal(a.length,2);assert.match(a[0].content,/接口字段/);assert.match(a[1].content,/请使用中文/);
  assert.equal(restored.userMessages[0].status,'delivered');
  assert.deepEqual(await mailbox.drain('a'),[]);
  restored.jobs[0].acceptingGuidance=false;
  await assert.rejects(mailbox.sendUserMessage({...body,clientMessageId:'late'}),{code:'AGENT_NOT_RUNNING'});
  assert.ok(saves>=2);
});

test('live activity keeps overlapping tools, full text and retry state without tool payloads',()=>{
  const job={};
  const notify=(method,params)=>recordAgentActivity(job,{method,params});
  notify('tool/started',{toolCallId:'1',toolName:'read_file',arguments:{secret:'not copied'}});
  notify('tool/started',{toolCallId:'2',toolName:'read_file'});
  notify('tool/completed',{toolCallId:'1',toolName:'read_file',result:{ok:true,content:'not copied'}});
  assert.equal(Object.keys(job.activeTools).length,1);
  notify('item/updated',{item:{type:'agentMessage',delta:'第一段\n'}});
  notify('item/updated',{item:{type:'agentMessage',delta:'第二段'}});
  notify('item/completed',{item:{type:'agentMessage',text:'第一段\n第二段'}});
  assert.equal(job.liveOutput,'第一段\n第二段');assert.equal(job.completedTools,1);
  notify('model/request-retrying',{message:'网关重试中'});
  assert.equal(job.activity.label,'网关重试中');assert.doesNotMatch(JSON.stringify(job),/secret|not copied/);
});

const workspace={
  async prepare(){return {integrationPath:'integration',snapshotCommit:'base'};},
  async head(){return 'base';},async createWorker(_,id){return `worker/${id}`;},
  async inspectChanges(){return {changedFiles:[],violations:[]};},async commit(){return null;},async integrate(){},async removeWorker(){},
  async summarize(){return {changedFiles:[],patchPreview:''};},async accept(){return {appliedFiles:[]};},async cleanup(){}
};
test('two running workers stay concurrent; only the addressed worker receives guidance in its existing request boundary',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agent-participation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 项目\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const started=new Map(),releases=new Map(),mail=new Map();let calls=0;
  const ready=Promise.withResolvers();
  const coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,startTurn:async options=>{
    calls++;
    const id=options.prompt.match(/Task id: (\S+)/)?.[1]||options.prompt.match(/Task id[^\n]*\n/)?.[0];
    assert.ok(id,'task id exists');
    await options.onAccepted({threadId:`thread-${id}`,turnId:`turn-${id}`});
    started.set(id,options);if(started.size===2)ready.resolve();
    options.onNotification({method:'item/updated',params:{item:{type:'agentMessage',delta:`${id} 正在执行`}}});
    await new Promise(resolve=>releases.set(id,resolve));
    mail.set(id,await options.beforeModelRequest());
    return {status:'completed',threadId:`thread-${id}`,output:`${id}完成`};
  }});
  t.after(()=>{for(const release of releases.values())release();});
  const run=await coordinator.start(['a','b'].map(taskId=>({taskId,nodeId:'ROOT',instruction:`完成${taskId}`,dependsOn:[]})));
  await ready.promise;
  const live=await coordinator.snapshot(run.id);
  assert.equal(live.jobs.filter(job=>job.status==='running').length,2);
  assert.match(live.jobs[0].liveOutput,/正在执行/);
  const body={taskId:'a',content:'保留边界检查',clientMessageId:'test-message'};
  await coordinator.sendAgentMessage(run.id,body);
  await coordinator.sendAgentMessage(run.id,body);
  const persisted=JSON.parse(await readFile(path.join(root,'.task-tree-runs',`${run.id}.json`),'utf8'));
  assert.equal(persisted.userMessages.length,1);
  releases.get('a')();releases.get('b')();
  const result=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(result.status,'accepted',result.error);assert.equal(calls,2,'no extra task/model turn for steering');
  assert.match(mail.get('a')[0].content,/保留边界检查/);assert.deepEqual(mail.get('b'),[]);
  assert.equal(result.userMessages[0].status,'delivered');
  await assert.rejects(coordinator.sendAgentMessage(run.id,{...body,clientMessageId:'late'}),{code:'AGENT_NOT_RUNNING'});
  await assert.rejects(coordinator.sendAgentMessage('missing',body),{code:'RUN_NOT_FOUND'});
});

test('a message accepted during model finalization resumes the same branch before it is integrated',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agent-late-guidance-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 项目\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const ready=Promise.withResolvers(),hold=Promise.withResolvers();t.after(()=>hold.resolve());
  let calls=0,received=[];
  const coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,startTurn:async options=>{
    calls++;
    if(calls===1){await options.onAccepted({threadId:'same-session',turnId:'first'});ready.resolve();await hold.promise;}
    else {assert.equal(options.threadId,'same-session');received=await options.beforeModelRequest();}
    return {status:'completed',threadId:'same-session',output:'完成'};
  }});
  const run=await coordinator.start([{taskId:'a',nodeId:'ROOT',instruction:'交付完整成果'}]);
  await ready.promise;
  await coordinator.sendAgentMessage(run.id,{taskId:'a',content:'最后补上错误说明',clientMessageId:'late'});
  hold.resolve();
  const result=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(result.status,'accepted',result.error);assert.equal(calls,2);
  assert.match(received[0].content,/最后补上错误说明/);
  assert.equal(result.userMessages[0].status,'delivered');
  assert.ok(result.events.some(event=>event.type==='worker_guidance_continuing'));
  assert.ok(!result.events.some(event=>event.type==='worker_stopped'));
});
