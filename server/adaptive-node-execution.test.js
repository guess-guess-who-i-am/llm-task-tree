import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveNodeExecution, NODE_EXECUTION_TOOL, WORKER_SPLIT_TOOL, ADAPTIVE_NODE_INSTRUCTIONS } from './adaptive-node-execution.js';

test('allocation guidance distinguishes specification clarity from implementation workload',()=>{
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/规格具体不等于工作量小/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/实现和边界验证/);
  assert.doesNotMatch(ADAPTIVE_NODE_INSTRUCTIONS,/粗目标若/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/可靠完成/);
});

test('allocation guidance targets short useful branches without a forced scheduling handshake',()=>{
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/10.?15.*分钟/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/软目标/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/同一.*文档/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/章节/);
  assert.doesNotMatch(ADAPTIVE_NODE_INSTRUCTIONS,/要求复评/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/执行中.*继续拆分/);
});

test('ordinary separable work actively delegates major deliverables before doing them alone',()=>{
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/默认主动并行/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/尽早.*共享接口.*委派主要/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/微小.*不可拆.*单人例外/);
  assert.doesNotMatch(ADAPTIVE_NODE_INSTRUCTIONS,/均可调用|若由单人实施和检查容易/);
  assert.ok(ADAPTIVE_NODE_INSTRUCTIONS.length<2250,'replace old optional wording rather than append another long strategy layer');
});

test('delegation tools and guidance define substantive work instead of treating all writing as tiny',()=>{
  for(const tool of [NODE_EXECUTION_TOOL,WORKER_SPLIT_TOOL]){
    assert.match(tool.function.description,/默认主动/);
    assert.match(tool.function.description,/两个以上.*独立成果/);
    assert.doesNotMatch(tool.function.description,/按需 Planner|有收益时使用/);
  }
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/两个以上.*分别需要.*分析.*推导.*实现.*撰写.*独立成果/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/一次写完.*不.*微小/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/短标签.*机械替换/);
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/章节.*分析.*并行/);
  assert.doesNotMatch(ADAPTIVE_NODE_INSTRUCTIONS,/一组简单文案/);
});

test('shared fields and style do not turn independently writable results into dependencies',()=>{
  for(const text of [ADAPTIVE_NODE_INSTRUCTIONS,NODE_EXECUTION_TOOL.function.description,WORKER_SPLIT_TOOL.function.description]){
    assert.match(text,/共享字段.*术语.*风格.*不.*强依赖/);
    assert.match(text,/固定公共约定再委派/);
    assert.match(text,/必须消费.*尚未产生的实际结果/);
  }
});

test('single-file delivery example contains a runnable delegation call and owns final assembly',()=>{
  const match=ADAPTIVE_NODE_INSTRUCTIONS.match(/task_tree_plan_execute\((\{[^\n]+\})\)/);
  assert.ok(match,'show the real delegation call, not only permission to split');
  const example=JSON.parse(match[1]);
  assert.ok(example.jobs.length>=2);
  assert.equal(new Set(example.jobs.map(job=>job.taskId)).size,example.jobs.length);
  assert.ok(example.jobs.every(job=>job.title&&job.instruction&&!(job.dependsOn?.length)));
  assert.match(example.sharedContract,/最终检查.*同.*会话.*组装.*\.md/);
  assert.ok(example.jobs.every(job=>/分析.*写.*\.md/.test(job.instruction)),'major writing is delegated, not only helper searches');
  assert.match(ADAPTIVE_NODE_INSTRUCTIONS,/片段不是最终交付/);
  assert.ok(ADAPTIVE_NODE_INSTRUCTIONS.length<1650,'replace the old example rather than stack another strategy layer');
});

test('adaptive delegation reuses the selected source and starts six tasks without a second planner', async () => {
  const operations = [];
  const jobs = Array.from({ length: 6 }, (_, i) => ({ taskId: `task${i}`, title: `交付${i}`, instruction: `完成独立交付${i}` }));
  const signal = new AbortController().signal;
  const contextMessages = [{ role: 'user', content: '本轮资料和历史' }];
  const historyMessages = [{ role: 'user', content: '本轮原始对话' },{role:'assistant',content:'早期独有约定'}];
  const state = { snapshotCommit: 'before-children' };
  const sharedContract = '接口：保存附件返回{id,url,mime}；失败返回{error}。';
  const handler = createAdaptiveNodeExecution({ nodeId: 'N9', treeScope: { tree: { id: 'custom', path: 'trees/custom.md' } }, objective: '完成N9', state,
    contextMessages, historyMessages, workspace: { async hasChanges() { return false; }, async refresh() { operations.push('refresh'); } },
    coordinator: {
      async start(input, options) {
        assert.equal(input.length, 6); assert.ok(input.every(j => j.nodeId === 'N9'));
        assert.equal(options.treeId, 'custom'); assert.equal(options.subtree, 'trees/custom.md');
        assert.equal(options.signal, signal); assert.equal(options.incremental, true);
        assert.equal(options.contextMessages, contextMessages);
        assert.equal(options.historyMessages, historyMessages);
        assert.equal(options.sharedContract, sharedContract);
        operations.push('start'); return { id: 'run', jobs: input, status: 'queued' };
      },
      async wait() { operations.push('wait'); return { id: 'run', status: 'accepted', jobs: jobs.map(j => ({ ...j, status: 'completed' })), result: { appliedFiles: ['a.txt'] } }; }
    } });
  const result = await handler(NODE_EXECUTION_TOOL.function.name, { reason: '六个独立交付物', jobs, sharedContract }, { signal });
  assert.equal(result.ok, true); assert.deepEqual(operations, ['start', 'wait']);
  assert.equal(state.delegationReceipt.runId, result.runId);
  assert.equal(result.hostCompletion.status,'completed','delegation ends the parent without another model round');
  assert.equal(Object.hasOwn(state, 'delegationBaseCommit'), false);
  await assert.rejects(handler(NODE_EXECUTION_TOOL.function.name, { jobs }, { signal }), /已提交/);
});

test('a failed final branch review stops the parent instead of reimplementing that branch', async () => {
  let refreshed = false;
  const handler = createAdaptiveNodeExecution({ state: {}, nodeId: 'A', treeScope: { tree: {} },
    workspace: { async hasChanges() { return false; }, async refresh() { refreshed = true; } },
    coordinator: { async start(jobs) { return { id: 'run', jobs }; }, async wait() { return { status: 'failed', jobs: [{ taskId: 'x', status: 'failed', reviewFailed: true, error: '检查修复失败：根因是接口不匹配' }], result: { appliedFiles: ['successful-sibling.txt'] } }; } }
  });
  await assert.rejects(handler(NODE_EXECUTION_TOOL.function.name, { jobs: [{ taskId: 'x' }, { taskId: 'y' }] }), /接口不匹配/);
  assert.equal(refreshed, false, 'parent does not refresh an abandoned workspace');
});

test('a serial-only split and a cancelled request never checkpoint or start workers', async () => {
  let starts = 0;
  const make = dirty => createAdaptiveNodeExecution({ state: {}, nodeId: 'A', treeScope: { tree: {} },
    workspace: { async hasChanges() { return dirty; } }, coordinator: { async start() { starts++; } } });
  const jobs = [{ taskId: 'A', instruction: 'A', dependsOn: [] }, { taskId: 'B', instruction: 'B', dependsOn: ['A'] }];
  await assert.rejects(make(false)(NODE_EXECUTION_TOOL.function.name, { jobs }), /同时开始/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(make(false)(NODE_EXECUTION_TOOL.function.name, { jobs }, { signal: controller.signal }), /abort/i);
  assert.equal(starts, 0);
});

test('delegation after editing checkpoints existing work and keeps its original review baseline', async () => {
  const state = {snapshotCommit:'original',workerPath:'private'};
  const checkpoint = {appliedFiles:['contract.js'],treeChanges:[]};
  const calls=[];
  const handler=createAdaptiveNodeExecution({state,nodeId:'ROOT',treeScope:{tree:{id:'method',path:'task-tree.md'}},objective:'完整目标',
    workspace:{async hasChanges(){return true;},async checkpoint(actual,details){
      assert.equal(actual,state);assert.equal(details.objective,'完整目标');calls.push('checkpoint');return checkpoint;
    }},coordinator:{async start(jobs,options){
      assert.equal(options.reviewBaselineCommit,'original');assert.deepEqual(options.initialReceipt,checkpoint);
      calls.push('start');return {id:'expanded',jobs};
    },async wait(){return {status:'accepted',jobs:[],result:{appliedFiles:['contract.js','a.js','b.js']}};}}});
  const result=await handler(NODE_EXECUTION_TOOL.function.name,{reason:'发现两项独立剩余工作',jobs:[{taskId:'a'},{taskId:'b'}]});
  assert.equal(result.ok,true);assert.deepEqual(calls,['checkpoint','start']);
});
