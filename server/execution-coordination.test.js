import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeDeliveryContract,snapshotDeliverables,inspectDeliverables,recoveryDecision,stageCoordinationEvidence,startCoordinatedNodeTurn} from './execution-coordination.js';
import {NODE_EXECUTION_TOOL,WORKER_SPLIT_TOOL} from './adaptive-node-execution.js';
import {buildWorkerPrompt} from './codex-coordinator.js';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'execution-coordination-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}

test('delivery contract validates exact container types and remains optional for old runs',()=>{
  assert.deepEqual(normalizeDeliveryContract({}),{deliverables:[],acceptanceCriteria:[]});
  for(const contract of [{deliverables:{}},{deliverables:[{path:'a',mode:'invented'}]},{deliverables:[{path:'a',mode:'present',nodeIds:'A'}]},{acceptanceCriteria:[null]}])
    assert.throws(()=>normalizeDeliveryContract(contract));
  const properties=NODE_EXECUTION_TOOL.function.parameters.properties.jobs.items.properties;
  assert.deepEqual(properties.deliverables,WORKER_SPLIT_TOOL.function.parameters.properties.jobs.items.properties.deliverables);
});

test('execution reports cannot replace requested business-tree edits or prohibit them in the worker prompt',()=>{
  const prompt=buildWorkerPrompt({taskId:'A',nodeId:'BUSINESS',executionNodeId:'P_A',subtreeFile:'subtrees/P_A.md',instruction:'更新业务节点',writeSet:[],
    deliverables:[{path:'trees/business.md',mode:'update',nodeIds:['BUSINESS']}],singleFinalReview:true});
  assert.doesNotMatch(prompt,/来源树仅作背景|不要把不同分支的结果写到同一个来源节点/);
  assert.match(prompt,/汇报不能替代业务交付/);
  assert.match(prompt,/trees\/business\.md/);
});

test('wrong-tree and unchanged-node edits are not valid delivery; existing-satisfied and deletion remain possible',async t=>{
  const root=await fixture(t);
  const tree='# LLM Task Graph\n## A - 身体\n- Problem: 如何养身体\n## B - 时间\n- Problem: 如何安排时间\n# GraphState\n- Current: A\n- Next: A\n# Edges\n';
  await writeFile(path.join(root,'business.md'),tree);
  const job={deliverables:[{path:'business.md',mode:'update',nodeIds:['A']}]};
  job.deliveryBaseline=await snapshotDeliverables(root,job.deliverables);
  await writeFile(path.join(root,'wrong-tree.md'),tree.replace('如何养身体','实际已改'));
  await writeFile(path.join(root,'business.md'),tree.replace('如何安排时间','如何更有效安排时间'));
  assert.equal((await inspectDeliverables(root,job))[0].status,'missing');
  await writeFile(path.join(root,'business.md'),tree.replace('如何养身体','如何通过睡眠和活动养身体'));
  assert.equal((await inspectDeliverables(root,job))[0].status,'satisfied');
  assert.equal((await inspectDeliverables(root,{deliverables:[{path:'business.md',mode:'present',nodeIds:['A']}]}))[0].status,'satisfied');
  assert.equal((await inspectDeliverables(root,{deliverables:[{path:'business.md',mode:'present',nodeIds:['C']}]}))[0].status,'missing');
  assert.equal((await inspectDeliverables(root,{deliverables:[{path:'removed.md',mode:'delete'}]}))[0].status,'satisfied');
});

test('external paths are direct effects with measured baselines, not forbidden write scopes',async t=>{
  const root=await fixture(t),outside=await fixture(t),file=path.join(outside,'external.txt');
  await writeFile(file,'before');const job={deliverables:[{path:file,mode:'update'}]};
  job.deliveryBaseline=await snapshotDeliverables(root,job.deliverables);
  assert.equal((await inspectDeliverables(root,job))[0].status,'missing');
  await writeFile(file,'after');assert.equal((await inspectDeliverables(root,job))[0].status,'satisfied');
});

test('absolute paths inside the source project resolve to the isolated worker, not the live tree',async t=>{
  const live=await fixture(t),worker=await fixture(t),file=path.join(live,'business.md');
  await writeFile(file,'live');await writeFile(path.join(worker,'business.md'),'before');
  const job={deliverables:[{path:file,mode:'update'}]};
  job.deliveryBaseline=await snapshotDeliverables(worker,job.deliverables,{projectRoot:live});
  await writeFile(path.join(worker,'business.md'),'after');
  assert.equal((await inspectDeliverables(worker,job,{projectRoot:live}))[0].status,'satisfied');
  assert.equal(await readFile(file,'utf8'),'live');
});

test('recovery uses cause identity, respects Stop and final rejection, and stops repeating an unchanged failed remedy',()=>{
  const error=Object.assign(new Error('summary failed'),{cause:{code:'CONTEXT_SUMMARY_NO_PROGRESS'}});
  const recovery=recoveryDecision({},error);assert.equal(recovery.action,'fresh-context');
  assert.equal(recoveryDecision({recoveryHistory:[recovery]},error),null);
  assert.equal(recoveryDecision({},error,{aborted:true}),null);
  assert.equal(recoveryDecision({},Object.assign(new Error('验收失败'),{code:'COMPLETION_REVIEW_FAILED',cause:error})),null);
  assert.equal(recoveryDecision({},new DOMException('user stop','AbortError')),null);
  assert.equal(recoveryDecision({},Object.assign(new Error('bad permissions'),{code:'EACCES'})),null);
  assert.equal(recoveryDecision({workerCompleted:true},Object.assign(new Error('temporary git lock'),{code:'EBUSY'})).action,'integrate-only');
});

test('the evidence manifest is lossless and read on demand, never a copied conversation',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.task-tree-runs'));
  const receipt={jobs:[{taskId:'A',instruction:'完整任务'.repeat(2000),evidence:'完整证据'.repeat(2000)}]};
  const prompt=await stageCoordinationEvidence(root,receipt);
  assert.ok(prompt.length<300);
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'.task-tree-runs/coordination-evidence.json'),'utf8')),receipt);
});

test('a direct node uses the same checkpoint recovery and publishes completion only after the recovered turn',async t=>{
  const root=await fixture(t),state={threadId:'old'};let calls=0,recoveries=0,completions=0;
  await startCoordinatedNodeTurn(async options=>{
    calls++;
    if(calls===1)return options.onCompleted({status:'failed',threadId:'old',output:'已写文件',error:{code:'CONTEXT_SUMMARY_NO_PROGRESS',message:'重复草稿'}});
    assert.equal(options.cwd,root);assert.equal(options.threadId,'');assert.equal(options.forceNewThread,true);
    assert.ok(!options.messages.some(message=>message.role==='assistant'));
    const saved=JSON.parse(await readFile(path.join(root,'.task-tree-runs/direct-test.coordination-checkpoint.json'),'utf8'));
    assert.equal(saved.output,'已写文件');assert.equal(saved.messages[1].content,'旧决定应能按需找回');
    return options.onCompleted({status:'completed',output:'继续完成'});
  },{cwd:root,prompt:'实际原任务',messages:[{role:'user',content:'有效用户要求'},{role:'assistant',content:'旧决定应能按需找回'}],
    onCompleted:result=>{completions++;assert.equal(result.status,'completed');}},
    {state,runId:'direct-test',onRecovery:()=>{recoveries++;}});
  assert.equal(calls,2);assert.equal(recoveries,1);assert.equal(completions,1);
});

test('repeated direct-context failure is not an infinite loop and an explicit Stop is never recovered',async t=>{
  const root=await fixture(t);
  for(const stopped of [false,true]){
    let calls=0,completions=0;
    await startCoordinatedNodeTurn(async options=>{calls++;return options.onCompleted({status:stopped?'stopped':'failed',error:{code:'CONTEXT_SUMMARY_NO_PROGRESS',message:'same'}});},
      {cwd:root,prompt:'原任务',onCompleted:()=>{completions++;}}, {state:{},runId:'same-test'});
    assert.equal(calls,stopped?1:2);assert.equal(completions,1);
  }
});

test('only timeouts in mandatory context summarization request a fresh-context recovery',()=>{
  const timeout=Object.assign(new Error('headers timeout'),{code:'MODEL_HEADERS_TIMEOUT'});
  assert.equal(recoveryDecision({},timeout),null);
  const summaryError=Object.assign(new Error('mandatory summary failed'),{stage:'context-summary',code:timeout.code,cause:timeout});
  assert.equal(recoveryDecision({},summaryError)?.action,'fresh-context');
});

test('explicit restart resume preserves the old thread and partial answer without retrying old context',async t=>{
  const root=await fixture(t),resumeState={threadId:'old-persisted-thread',output:'重启前未完成的答复'};
  let calls=0;
  await startCoordinatedNodeTurn(async options=>{
    calls++;
    assert.equal(options.forceNewThread,true);
    const saved=JSON.parse(await readFile(path.join(root,'.task-tree-runs/explicit-test.coordination-checkpoint.json'),'utf8'));
    assert.equal(saved.previousThreadId,resumeState.threadId);
    assert.equal(saved.output,resumeState.output);
    return options.onCompleted({status:'completed',output:'完成'});
  },{cwd:root,prompt:'原任务',onCompleted:()=>{}},{state:{},runId:'explicit-test',resumeFromCheckpoint:true,resumeState});
  assert.equal(calls,1);
});
