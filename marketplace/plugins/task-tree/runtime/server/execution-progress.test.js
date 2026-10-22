import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProgress, recordRunDuration, readableExecutionError, recordCompactionProgress, recordIntegrationProgress } from './execution-progress.js';

test('review progress preserves worker answer and running status until final acceptance',()=>{
  const run={status:'running',phase:'checking',output:'本轮全部完成',streams:{agentMessage:{text:'原输出'}},createdAt:new Date().toISOString()};
  const before=JSON.stringify(run.streams);
  const activity=recordIntegrationProgress(run,{method:'tool/started',params:{toolName:'read_file'}});
  assert.equal(activity,'验收调用 read_file');assert.equal(run.status,'running');
  assert.equal(run.output,'本轮全部完成');assert.equal(JSON.stringify(run.streams),before);
  assert.match(executionProgress(run).label,/最终验收.*尚未完成/);
  recordIntegrationProgress(run,{method:'item/updated',params:{item:{type:'agentMessage',delta:'私有验收输出'}}});
  assert.match(run.reviewActivity.message,/正在接收验收输出/);
  assert.equal(run.reviewActivity.receivedChars,'私有验收输出'.length);
  assert.ok(!JSON.stringify(run.reviewActivity).includes('私有验收输出'));
  run.status='failed';assert.match(executionProgress(run).label,/本轮已结束.*失败/);
});

test('review progress distinguishes reasoning, Hook completion and durable saving without claiming acceptance',()=>{
  const run={status:'running',phase:'checking'};
  recordIntegrationProgress(run,{method:'model/request-started'});
  assert.equal(run.reviewActivity.round,1);
  recordIntegrationProgress(run,{method:'item/updated',params:{item:{type:'reasoning',delta:'private thought'}}});
  assert.match(run.reviewActivity.message,/验收模型正在分析/);
  recordIntegrationProgress(run,{method:'hook/completed',params:{event:'Stop'}});
  assert.match(run.reviewActivity.message,/收尾 Hook 已返回/);
  recordIntegrationProgress(run,{method:'execution/saving'});
  assert.match(run.reviewActivity.message,/保存验收结果/);
  assert.equal(run.status,'running');
  assert.ok(!JSON.stringify(run.reviewActivity).includes('private thought'));
});

test('summary HTTP failure retains its actual stage in the public Chinese error', () => {
  const message = readableExecutionError('上下文摘要失败，当前输入需要压缩才能继续；原文与已保存结果保留。原因：模型 HTTP 502（deepseek-v4.1-flash）（已重试 2 次）: private html');
  assert.match(message,/上下文摘要失败/);
  assert.match(message,/HTTP 502/);
  assert.doesNotMatch(message,/private html/);
});

test('compaction deferred/completed clears retry phase without claiming task completion', () => {
  for (const method of ['context/compaction-deferred','context/compaction-completed','context/compaction-failed','context/compaction-capacity-warning']) {
    const run={status:'running',phase:'retrying',retryAt:Date.now()+5000};
    recordCompactionProgress(run,method);
    assert.equal(run.phase,'model'); assert.equal(run.status,'running');
    assert.equal(Object.hasOwn(run,'retryAt'),false);
  }
  const run={status:'running',phase:'model'};
  recordCompactionProgress(run,'context/compaction-started');
  assert.equal(run.phase,'summarizing');
  recordCompactionProgress(run,'other'); assert.equal(run.phase,'summarizing');
});

test('legacy turn timeout is neutral and explains that sending can continue', () => {
  const message = readableExecutionError('DeepSeek 请求超时');
  assert.match(message, /累计.*上限/);
  assert.match(message, /发送.*继续/);
  assert.doesNotMatch(message, /DeepSeek 请求超时/);
});

test('summarizing is an explicit running phase, not a terminal state', () => {
  const progress = executionProgress({ status: 'running', phase: 'summarizing', createdAt: new Date().toISOString() });
  assert.equal(progress.phase, 'summarizing');
  assert.match(progress.label, /整理长上下文/);
});

test('parallel progress exposes failed and blocked branches instead of counting only merged work',()=>{
  const progress=executionProgress({status:'running',phase:'parallel',createdAt:new Date().toISOString(),parallel:{jobs:[
    {status:'completed'},{status:'completed'},{status:'failed'},{status:'blocked'},{status:'running'}
  ]}});
  assert.match(progress.label,/2\/5 完成，1 失败，1 阻塞，1 进行中/);
});

test('integration, independent check and repair remain visible running phases', () => {
  const run = { status: 'running', createdAt: new Date().toISOString() };
  for (const [phase, label] of [['merging', '整合'], ['checking', '独立检查'], ['repairing', '修复']]) {
    const progress = executionProgress({ ...run, phase });
    assert.equal(progress.phase, phase);
    assert.match(progress.label, new RegExp(label));
  }
});

test('stopped is terminal, freezes elapsed time and never becomes a successful ETA sample', () => {
  const run = { treeId: 'a', nodeId: 'N1', status: 'stopped', createdAt: new Date(1000).toISOString(), updatedAt: new Date(2500).toISOString() };
  const progress = executionProgress(run, [], 9000);
  assert.equal(progress.elapsedMs, 1500); assert.equal(progress.estimatedRemainingMs, 0); assert.match(progress.label, /已停止/);
  const samples = []; recordRunDuration(samples, run); assert.deepEqual(samples, []);
  assert.match(executionProgress({ ...run, status: 'stopping' }).label, /正在停止/);
});

test('no invented ETA, terminal state and elapsed time are explicit', () => {
  const run={treeId:'a',nodeId:'N9',status:'running',createdAt:new Date(1000).toISOString(),updatedAt:new Date(2000).toISOString(),phase:'model'};
  assert.equal(executionProgress(run,[],5000).estimatedRemainingMs,null);
  assert.equal(executionProgress(run,[],5000).elapsedMs,4000);
  const completed={...run,status:'failed',updatedAt:new Date(3500).toISOString()};
  assert.equal(executionProgress(completed,[],9000).elapsedMs,2500);
  assert.equal(executionProgress(completed,[],9000).label,'本轮已结束，执行失败');
});

test('only same node measured successes inform transparent historical ETA', () => {
  const run={treeId:'a',nodeId:'N9',status:'running',createdAt:new Date(1000).toISOString()};
  const samples=[{treeId:'a',nodeId:'N9',totalMs:10000},{treeId:'a',nodeId:'N9',totalMs:20000},{treeId:'b',nodeId:'N9',totalMs:999999}];
  const progress=executionProgress(run,samples,6000);
  assert.equal(progress.sampleCount,2);
  assert.equal(progress.estimatedRemainingMs,10000);
  assert.deepEqual(progress.estimateRangeMs,[5000,15000]);
  assert.match(progress.estimateBasis,/历史.*2/);
  assert.equal(executionProgress(run,samples,30000).estimatedRemainingMs,null);
  assert.equal(executionProgress(run,samples,30000).overEstimate,true);
});

test('duration records carry no dialogue or tools and never use failures as ETA samples', () => {
  const samples=[];
  recordRunDuration(samples,{id:'r',treeId:'a',nodeId:'N',status:'completed',createdAt:new Date(1000).toISOString(),updatedAt:new Date(2234).toISOString(),timing:{totalMs:100},output:'PRIVATE'});
  recordRunDuration(samples,{id:'f',treeId:'a',nodeId:'N',status:'failed',timing:{totalMs:100}});
  assert.equal(samples.length,1);
  assert.equal(samples[0].totalMs,1234);
  assert.deepEqual(Object.keys(samples[0]),['runId','treeId','nodeId','totalMs']);
});

test('invalid or nonpositive wall time never creates a misleading model-only sample', () => {
  const samples=[];
  for(const updatedAt of [undefined,'invalid',new Date(1000).toISOString(),new Date(500).toISOString()])
    recordRunDuration(samples,{id:String(updatedAt),status:'completed',createdAt:new Date(1000).toISOString(),updatedAt,timing:{totalMs:500}});
  assert.deepEqual(samples,[]);
});

test('completed duration includes independent review and merge, not just the shorter model turn', () => {
  const samples=[];
  recordRunDuration(samples,{id:'whole',treeId:'a',nodeId:'N',status:'completed',
    createdAt:new Date(1000).toISOString(),updatedAt:new Date(11000).toISOString(),timing:{totalMs:1000}});
  assert.equal(samples[0].totalMs,10000);
});

test('same run duration is refreshed from terminal timestamps without duplicate samples', () => {
  const samples=[{runId:'same',treeId:'a',nodeId:'N',totalMs:1000}];
  const run={id:'same',treeId:'a',nodeId:'N',status:'completed',createdAt:new Date(1000).toISOString(),updatedAt:new Date(11000).toISOString()};
  recordRunDuration(samples,run);recordRunDuration(samples,run);
  assert.deepEqual(samples,[{runId:'same',treeId:'a',nodeId:'N',totalMs:10000}]);
});

test('gateway HTML errors become a clear Chinese failure, not raw markup', () => {
  assert.equal(readableExecutionError('DeepSeek HTTP 502: <!DOCTYPE html> private dump'),'模型网关返回 HTTP 502，本轮执行已失败；不是仍在执行。请稍后重试，已有成功保存的修改不会自动回滚。');
  assert.equal(readableExecutionError('模型 HTTP 502（glm-5.3）（已重试 2 次）: private dump'),'模型网关返回 HTTP 502（已自动重试 2 次，仍失败），本轮执行已失败；不是仍在执行。请稍后重试，已有成功保存的修改不会自动回滚。');
});

test('a context HTTP400 explains the actual capacity failure, not a generic gateway outage',()=>{
  const raw='模型 HTTP 400（deepseek-v4.1-flash）: '+JSON.stringify({error:{message:JSON.stringify({msg:'prompt is too long: 1743408 tokens \\u003e 1048576 maximum'})}});
  const message=readableExecutionError(raw);
  assert.match(message,/上下文/);assert.match(message,/1743408/);assert.match(message,/1048576/);
  assert.doesNotMatch(message,/请稍后重试/);
});

test('empty git diff errors explain the recoverable failure', () => {
  assert.match(readableExecutionError('git diff 失败:'), /Git 差异读取失败/);
  assert.match(readableExecutionError('git diff 失败:'), /Git 仓库/);
});

test('recovery is a running phase; exhausted retries are explicit and terminal', () => {
  const run={status:'running',phase:'retrying',createdAt:new Date().toISOString()};
  assert.match(executionProgress(run).label,/自动恢复/);
  assert.equal(executionProgress(run).phase,'retrying');
  const now=Date.now();
  assert.match(executionProgress({...run,retryAt:now+120000},[],now).label,/120 秒后再次请求/);
  assert.match(executionProgress({...run,retryAt:now+120000},[],now+30000).label,/90 秒后再次请求/);
  assert.match(readableExecutionError('DeepSeek HTTP 502（已重试 2 次）: <html>'),/已自动重试 2 次，仍失败/);
});
