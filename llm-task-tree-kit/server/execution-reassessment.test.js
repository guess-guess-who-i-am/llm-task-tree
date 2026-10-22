import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionReassessment } from './execution-reassessment.js';
import { NODE_EXECUTION_TOOL, WORKER_SPLIT_TOOL } from './adaptive-node-execution.js';

test('initial routing is an explicit choice once, not a recurring scheduling gate',()=>{
  let now=0;
  const policy=createExecutionReassessment([NODE_EXECUTION_TOOL],{now:()=>now});
  const first=policy.request();
  assert.equal(first.toolChoice,'required');
  assert.deepEqual(first.tools.map(t=>t.function.name),['task_tree_plan_execute','task_tree_continue_single']);
  assert.equal(policy.request().phase,'initial','ignored decisions remain pending');
  policy.continueSingle({reason:'仅一处机械替换',nextCheckpoint:'已有用例通过'});
  assert.equal(policy.request(),null);
  now=600001;
  const later=policy.request();
  assert.equal(later.toolChoice,'auto');
  assert.equal(later.tools,undefined,'later opportunities never remove implementation tools');
  assert.equal(policy.request(),null);
});

test('small tasks choose once and final checkers do not gain a planning call', () => {
  const policy = createExecutionReassessment([NODE_EXECUTION_TOOL]);
  const hint=policy.request();
  assert.equal(hint.phase,'initial');
  assert.equal(hint.exclusive,true);
  assert.equal(hint.tools.length,2);
  policy.continueSingle({reason:'只需替换一个标签，无独立交付',nextCheckpoint:'标签和定向用例完成'});
  policy.toolsCompleted();
  assert.equal(policy.request(), null);
  const checker = createExecutionReassessment([]);
  for (let i=0;i<1000;i++) checker.toolsCompleted();
  assert.equal(checker.request(), null);
});

test('long serial work gets a non-blocking split opportunity without changing the available tools', () => {
  let now=0;
  for (const split of [NODE_EXECUTION_TOOL, WORKER_SPLIT_TOOL]) {
    const policy = createExecutionReassessment([split], {now:()=>now});
    policy.continueSingle({reason:'先核对缺失的统一接口',nextCheckpoint:'接口明确后拆分'});
    for (let i=0;i<12;i++) policy.toolsCompleted();
    assert.equal(policy.request(), null, 'tool counts alone must not manufacture a scheduling round');
    now += 600001;
    const request = policy.request();
    assert.equal(request.exclusive,false);
    assert.equal(request.tools,undefined);
    assert.equal(request.toolChoice,'auto');
    assert.match(request.message,/已完成成果/);
    assert.doesNotMatch(request.message,/必须[^。；]*task_tree_continue_single|临时只保留|已连续执行/);
    assert.equal(policy.request(),null,'the advisory is not repeatedly injected or required to be answered');
    for(let i=0;i<1000;i++)policy.toolsCompleted();
    assert.equal(policy.request(),null,'a large number of short tool batches is not a deadline');
  }
});

test('after the initial choice no recurring exclusive scheduling gate interrupts work',()=>{
  let now=0;
  const policy=createExecutionReassessment([NODE_EXECUTION_TOOL],{now:()=>now});
  assert.equal(policy.request().exclusive,true);
  policy.continueSingle({reason:'单一复现链',nextCheckpoint:'定位首次偏差'});
  assert.equal(policy.request(),null);
  for(let i=0;i<1000;i++)policy.toolsCompleted();
  now=180001;
  assert.equal(policy.request(),null,'the old 180-second gate is gone');
  now=600001;
  const hint=policy.request();
  assert.equal(hint.exclusive,false);
  assert.match(hint.message,/10.?15.*分钟/);
  assert.match(hint.message,/不是.*期限|不.*停止/);
  assert.match(hint.message,/同一.*文档|章节/);
});

test('initial execution explicitly defaults to early delegation of substantive independent work',()=>{
  for(const split of [NODE_EXECUTION_TOOL,WORKER_SPLIT_TOOL]){
    const hint=createExecutionReassessment([split]).request();
    assert.match(hint.message,/默认主动并行/);
    assert.match(hint.message,/尽早.*共享接口.*委派主要/);
    assert.match(hint.message,/微小.*不可拆.*单人例外/);
    assert.match(hint.message,new RegExp(split.function.name));
    assert.equal(hint.toolChoice,'required');
    assert.equal(hint.tools[0],split);
    assert.equal(hint.exclusive,true);
  }
});

test('opportunity hint makes multiple analytical or written deliverables parallel by default',()=>{
  const hint=createExecutionReassessment([NODE_EXECUTION_TOOL]).request();
  assert.match(hint.message,/两个以上.*分别需要.*分析.*推导.*实现.*撰写.*独立成果/);
  assert.match(hint.message,/一次写完.*不.*微小/);
  assert.match(hint.message,/短标签.*机械替换/);
  assert.equal(hint.toolChoice,'required');
  assert.equal(hint.exclusive,true);
});

test('opportunity hint distinguishes agreed vocabulary from unavailable dependency outputs',()=>{
  const hint=createExecutionReassessment([NODE_EXECUTION_TOOL]).request();
  assert.match(hint.message,/共享字段.*术语.*风格.*不.*强依赖/);
  assert.match(hint.message,/固定公共约定再委派/);
  assert.match(hint.message,/必须消费.*尚未产生的实际结果/);
  assert.equal(hint.toolChoice,'required');
  assert.equal(hint.exclusive,true);
});
