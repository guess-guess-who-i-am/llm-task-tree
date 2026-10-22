import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createParallelCodexCoordinator} from './codex-coordinator.js';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';
import {createAdaptiveNodeExecution,NODE_EXECUTION_TOOL} from './adaptive-node-execution.js';
import {registerReviewInputs} from './review-input-materials.js';

const tree='# LLM Task Graph\n## ROOT - 动态并行\n- Problem: 完成全部交付\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'adaptive-expansion-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);return root;
}

test('declared ignored inputs survive root to worker to child to the single final reviewer', {timeout:30000},async t=>{
  const root=await fixture(t);let checks=0,children=0;
  await writeFile(path.join(root,'.gitignore'),'local/\n');
  await mkdir(path.join(root,'local'));
  await writeFile(path.join(root,'local','root.json'),'root-input');
  await registerReviewInputs(root,{action:'register',paths:['local/root.json']});
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    assert.equal(await readFile(path.join(options.cwd,'local/root.json'),'utf8'),'root-input');
    if(id==='large'){
      await writeFile(path.join(options.cwd,'local/parent.json'),'parent-input');
      await registerReviewInputs(options.cwd,{action:'register',paths:['local/parent.json']});
      const split=await options.toolHandler('task_tree_split_work',{reason:'两份独立片段共享已登记输入',jobs:['a','b'].map(taskId=>({taskId,instruction:`完成${taskId}`}))});
      return {status:'completed',output:split.hostCompletion.output};
    }
    if(id.startsWith('large.')){
      children++;
      assert.equal(await readFile(path.join(options.cwd,'local/parent.json'),'utf8'),'parent-input');
      assert.match(options.prompt,/只读输入|检查输入/);
    }
    await writeFile(path.join(options.cwd,`${id}.txt`),id);
    return {status:'completed',output:`已交付${id}`};
  },reviewTurn:async options=>{
    checks++;
    assert.equal(await readFile(path.join(options.cwd,'local/root.json'),'utf8'),'root-input');
    assert.equal(await readFile(path.join(options.cwd,'local/parent.json'),'utf8'),'parent-input');
    for(const file of ['large.a.txt','large.b.txt','sibling.txt'])await readFile(path.join(options.cwd,file));
    return {status:'completed',output:'{"verdict":"pass","reason":"片段与实际输入均已验证"}'};
  }});
  const run=await coordinator.start(['large','sibling'].map(taskId=>({taskId,nodeId:'ROOT',instruction:`交付${taskId}`})),{nodeId:'ROOT',incremental:true,objective:'完整交付'});
  const result=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(result.status,'accepted',result.error);assert.equal(children,2);assert.equal(checks,1);
  assert.ok(result.jobs.find(job=>job.taskId==='large').reviewInputs.fileCount>=2);
  assert.ok(!result.result.appliedFiles.some(file=>file.startsWith('local/')||file.includes('review-inputs')),'input channel must not leak into deliverables');
});

test('edited parent hands off its interface and all results receive one final review', {timeout:30000}, async t=>{
  const root=await fixture(t);
  const direct=createDirectNodeWorkspace({projectRoot:root});
  const state=await direct.prepare('parent');let checks=0;
  await writeFile(path.join(state.workerPath,'interface.txt'),'共同输入');
  await writeFile(path.join(root,'unrelated.txt'),'用户并发修改');
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    assert.equal(await readFile(path.join(options.cwd,'interface.txt'),'utf8'),'共同输入');
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    await writeFile(path.join(options.cwd,`${id}.txt`),id);return {status:'completed',output:id};
  },reviewTurn:async options=>{
    checks++;
    const manifest=JSON.parse(await readFile(path.join(options.cwd,'.task-tree-runs/coordination-evidence.json'),'utf8'));
    assert.ok(manifest.initialReceipt.appliedFiles.includes('interface.txt'));
    for(const file of ['interface.txt','a.txt','b.txt','unrelated.txt'])await readFile(path.join(options.cwd,file));
    return {status:'completed',output:'{"verdict":"pass","reason":"全部交付已验证"}'};
  }});
  t.after(()=>coordinator.drain());
  const handler=createAdaptiveNodeExecution({coordinator,workspace:direct,state,nodeId:'ROOT',treeScope:{tree:{id:'method',path:'task-tree.md'}},objective:'完整交付'});
  const result=await handler(NODE_EXECUTION_TOOL.function.name,{reason:'实现接口后发现可独立处理',jobs:['a','b'].map(taskId=>({taskId,title:taskId,instruction:`完成${taskId}`}))});
  assert.equal(result.ok,true,result.error);assert.equal(checks,1);
  assert.ok(result.appliedFiles.includes('interface.txt'));
  assert.equal(await readFile(path.join(root,'unrelated.txt'),'utf8'),'用户并发修改');
  await direct.finish(state,{status:'completed'});assert.equal(checks,1);
});

test('running worker splits remaining work in the same pipeline while its sibling continues', {timeout:30000}, async t=>{
  const root=await fixture(t);
  const sibling=deferred(),bothChildren=deferred();let children=0,peak=0,active=0,checks=0;
  t.after(()=>sibling.resolve());
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    if(id==='large'){
      await writeFile(path.join(options.cwd,'shared-interface.txt'),'输入已就绪');
      assert.ok(options.tools.some(tool=>tool.function.name==='task_tree_split_work'),'workers need an executable split tool');
      const result=await options.toolHandler('task_tree_split_work',{reason:'发现两批独立数据',jobs:['a','b'].map(taskId=>({taskId,title:taskId,instruction:`完成数据批次${taskId}`}))});
      assert.equal(result.ok,true);assert.equal(result.hostCompletion.status,'completed');
      const repeated=await options.toolHandler('task_tree_split_work',{reason:'网络重复投递',jobs:[]});
      assert.deepEqual(repeated.taskIds,result.taskIds,'a retried handoff must not spawn duplicate children');
      return {status:'completed',output:result.hostCompletion.output};
    }
    if(id==='consumer'){
      assert.equal(children,2);
      for(const file of ['large.a.txt','large.b.txt'])await readFile(path.join(options.cwd,file));
    }
    else if(id==='sibling'){await sibling.promise;await writeFile(path.join(options.cwd,'sibling.txt'),'sibling');}
    else{
      assert.equal(await readFile(path.join(options.cwd,'shared-interface.txt'),'utf8'),'输入已就绪');
      peak=Math.max(peak,++active);if(++children===2)bothChildren.resolve();
      await bothChildren.promise;
      await writeFile(path.join(options.cwd,`${id.replaceAll('/','_')}.txt`),id);active--;sibling.resolve();
    }
    return {status:'completed',output:id};
  },reviewTurn:async options=>{checks++;assert.equal(children,2);await readFile(path.join(options.cwd,'shared-interface.txt'));
    return {status:'completed',output:'{"verdict":"pass","reason":"动态拆分全部完成"}'};}});
  t.after(()=>coordinator.drain());
  const run=await coordinator.start(['large','sibling','consumer'].map(taskId=>({taskId,nodeId:'ROOT',instruction:`完成${taskId}`,dependsOn:taskId==='consumer'?['large']:[]})),{nodeId:'ROOT',incremental:true,objective:'完整大任务',sharedContract:'输入使用shared-interface.txt'});
  const result=await coordinator.wait(run.id);
  assert.equal(result.status,'accepted',result.error);assert.equal(peak,2);assert.equal(checks,1);
  assert.equal(result.jobs.length,5);assert.ok(result.jobs.every(job=>job.status==='completed'));
  assert.deepEqual(result.jobs.find(job=>job.taskId==='consumer').dependsOn,['large.a','large.b']);
  const plan=JSON.parse(await readFile(path.join(root,result.branchTree.planPath),'utf8'));
  assert.deepEqual(plan.jobs.find(job=>job.taskId==='consumer').dependsOn,['large.a','large.b']);
  assert.ok(plan.jobs.every(job=>job.executionNodeId),'saved plan retains every execution identity');
  assert.ok(result.events.some(event=>event.type==='worker_subdivided'));
});

test('a subdivision cannot make its downstream consumer a prerequisite or publish edits on invalid input', {timeout:30000}, async t=>{
  const root=await fixture(t);let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    if(id==='large'){
      await writeFile(path.join(options.cwd,'partial.txt'),'尚未交付');
      await assert.rejects(options.toolHandler('task_tree_split_work',{reason:'错误依赖',jobs:[
        {taskId:'one',instruction:'独立一'},{taskId:'two',instruction:'独立二'},
        {taskId:'three',instruction:'等待消费者',dependsOn:['consumer']}
      ]}),/循环|环|cycle/i);
      await assert.rejects(readFile(path.join(root,'partial.txt')),{code:'ENOENT'});
    }
    return {status:'completed',output:id};
  },reviewTurn:async()=>{checks++;return {status:'completed',output:'{"verdict":"pass","reason":"未接受错误拆分"}'};}});
  const run=await coordinator.start([{taskId:'large',nodeId:'ROOT',instruction:'大任务'},
    {taskId:'consumer',nodeId:'ROOT',instruction:'消费者',dependsOn:['large']}],{incremental:true,nodeId:'ROOT'});
  const result=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(result.status,'accepted',result.error);assert.equal(result.jobs.length,2);assert.equal(checks,1);
});

test('one-level children complete their remaining parts without recursive splits, keeping shared contract and one final review', {timeout:30000}, async t=>{
  const root=await fixture(t);let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    assert.match(options.prompt,/相同接口v3/);
    if(id==='large'){
      const names=['group','leaf'];
      const result=await options.toolHandler('task_tree_split_work',{reason:'发现独立剩余部分',jobs:names.map(taskId=>({taskId,instruction:`交付${taskId}`}))});
      return {status:'completed',output:result.hostCompletion.output};
    }
    if(id==='large.group'){
      assert.ok(!options.tools.some(tool=>tool.function.name==='task_tree_split_work'));
      await assert.rejects(options.toolHandler('task_tree_split_work',{jobs:[{taskId:'one'},{taskId:'two'}]}),/最多允许 1 层/);
      for(const part of ['one','two'])await writeFile(path.join(options.cwd,`${id}.${part}.txt`),part);
    }
    if(id==='consumer')for(const file of ['large.leaf','large.group.one','large.group.two'])await readFile(path.join(options.cwd,`${file}.txt`));
    else await writeFile(path.join(options.cwd,`${id}.txt`),id);
    return {status:'completed',output:id};
  },reviewTurn:async()=>{checks++;return {status:'completed',output:'{"verdict":"pass","reason":"递归拆分全部交付"}'};}});
  const run=await coordinator.start([{taskId:'large',nodeId:'ROOT',instruction:'完成大任务'},
    {taskId:'consumer',nodeId:'ROOT',instruction:'读取全部结果',dependsOn:['large']}],{incremental:true,nodeId:'ROOT',sharedContract:'相同接口v3'});
  const result=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(result.status,'accepted',result.error);assert.equal(checks,1);
  assert.deepEqual(new Set(result.jobs.find(job=>job.taskId==='consumer').dependsOn),new Set(['large.leaf','large.group']));
  assert.equal(result.executionTree.nodes.find(node=>node.id==='large.group').parentId,'large');
});

test('100 ready workers reach the model concurrently using isolated Git worktrees', {timeout:180000}, async t=>{
  const root=await fixture(t),barrier=deferred();let arrived=0,active=0,peak=0;
  const started=performance.now();let lastStarted=0;
  t.after(()=>barrier.resolve());
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1];
    peak=Math.max(peak,++active);
    if(++arrived===100){lastStarted=performance.now();barrier.resolve();}
    await barrier.promise;active--;return {status:'completed',output:`${id}已完成只读任务`};
  }});
  t.after(()=>coordinator.drain());
  const run=await coordinator.start(Array.from({length:100},(_,i)=>({taskId:`data-${i}`,nodeId:'ROOT',instruction:`读取独立数据分片${i}`})),{nodeId:'ROOT',incremental:true});
  const result=await coordinator.wait(run.id);
  assert.equal(result.status,'accepted',result.error);assert.equal(peak,100);
  assert.equal(new Set(result.jobs.map(job=>job.contextKey)).size,100);
  t.diagnostic(JSON.stringify({peak,workers:100,allStartedMs:Math.round(lastStarted-started),totalMs:Math.round(performance.now()-started)}));
});
