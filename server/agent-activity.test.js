import test from 'node:test';
import assert from 'node:assert/strict';
import {recordAgentActivity} from './agent-activity.js';

test('execution strategy reasons and checkpoints remain traceable after normal output overwrites current activity',()=>{
  const job={};
  const trace=recordAgentActivity(job,{method:'execution/strategy',params:{mode:'single',reason:'先发布公共ID映射',nextCheckpoint:'映射测试完成',message:'先发布公共ID映射'}});
  assert.equal(job.executionStrategy.reason,'先发布公共ID映射');
  assert.equal(job.executionStrategy.nextCheckpoint,'映射测试完成');
  assert.equal(job.strategyHistory.length,1);
  assert.equal(trace.method,'execution/strategy');
  recordAgentActivity(job,{method:'model/request-started',params:{round:4}});
  assert.equal(job.strategyHistory[0].reason,'先发布公共ID映射');
});

test('existing notification-only strategy messages preserve the complete decision without tool payloads',()=>{
  const job={};const message='继续单 Agent：先统一输入；下次成果检查点：输入核对后';
  recordAgentActivity(job,{method:'execution/strategy',params:{mode:'single',message,arguments:{secret:'not persisted'}}});
  assert.equal(job.executionStrategy.message,message);
  assert.equal(job.strategyHistory[0].message,message);
  assert.doesNotMatch(JSON.stringify(job),/secret|not persisted/);
});

test('branch compaction and retry activity are visible without copying summaries or reasoning',()=>{
  const job={};
  recordAgentActivity(job,{method:'context/compaction-started',params:{message:'正在整理上下文',inputTokens:40000,summary:'private summary'}});
  assert.equal(job.contextActivity.status,'started');assert.match(job.activity.label,/上下文/);
  recordAgentActivity(job,{method:'context/compaction-completed',params:{message:'上下文整理完成',beforeTokens:40000,afterTokens:3000}});
  assert.equal(job.contextActivity.afterTokens,3000);assert.equal(job.contextActivity.status,'completed');
  recordAgentActivity(job,{method:'model/request-retrying',params:{message:'连接恢复中',attempt:2}});
  assert.equal(job.requestActivity.attempt,2);
  assert.doesNotMatch(JSON.stringify(job),/private summary/);
});
