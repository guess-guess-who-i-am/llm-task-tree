import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProgress, recordRunDuration, readableExecutionError } from './execution-progress.js';

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
  recordRunDuration(samples,{id:'r',treeId:'a',nodeId:'N',status:'completed',timing:{totalMs:1234},output:'PRIVATE'});
  recordRunDuration(samples,{id:'f',treeId:'a',nodeId:'N',status:'failed',timing:{totalMs:100}});
  assert.equal(samples.length,1);
  assert.deepEqual(Object.keys(samples[0]),['runId','treeId','nodeId','totalMs']);
});

test('gateway HTML errors become a clear Chinese failure, not raw markup', () => {
  assert.equal(readableExecutionError('DeepSeek HTTP 502: <!DOCTYPE html> private dump'),'模型网关返回 HTTP 502，本轮执行已失败；不是仍在执行。请稍后重试，已有成功保存的修改不会自动回滚。');
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
