import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompletionReview,completionReviewInterruption,parseUnfinalizedHandoffNarrative,buildCompletionReviewPrompt,COMPLETION_REVIEW_TOOL,WORKER_RESULT_SCHEMA} from './node-completion-review.js';
const verdict={verdict:'pass',reason:'真实验收通过',evidence:['测试已执行']};
test('review acceptance follows the requested artifact instead of inventing a running business-service requirement',()=>{
 const prompt=buildCompletionReviewPrompt('目标：在医生节点中解释入组流程，不更改业务功能');
 assert.match(prompt,/验收范围以用户目标和交付合同为准/);
 assert.match(prompt,/说明.*不.*启动.*业务服务/);
});
test('dependency inventory is optional for older reviewers and complete for new declarations',()=>{
 const schema=COMPLETION_REVIEW_TOOL.function.parameters;
 assert.ok(!schema.required.includes('dependencyScope'));
 assert.deepEqual(schema.properties.dependencyScope.required,['complete','files']);
 assert.equal(schema.properties.dependencyScope.properties.complete.type,'boolean');
 const receipt={...verdict,dependencyScope:{complete:true,files:['docs/report.md','src/auth']}};
 assert.deepEqual(parseCompletionReview(JSON.stringify(receipt)),receipt);
 assert.deepEqual(parseCompletionReview(JSON.stringify(verdict)),verdict);
});
test('worker and final-review outputs have no character caps or host-derived file inventories',()=>{
 const worker=WORKER_RESULT_SCHEMA.properties;
 assert.equal(worker.evidence.maxLength,undefined);
 assert.equal(worker.changedFiles,undefined);
 assert.equal(worker.affectedNodes,undefined);
 const review=COMPLETION_REVIEW_TOOL.function.parameters.properties;
 assert.equal(review.reason.maxLength,undefined);
 assert.equal(review.evidence.maxItems,3);
 assert.equal(review.evidence.items.maxLength,undefined);
 assert.equal(review.rootCause.maxLength,undefined);
 assert.equal(review.caseStudy.maxLength,undefined);
 assert.equal(review.solution.maxLength,undefined);
 const prompt=buildCompletionReviewPrompt('目标：验证行为');
 assert.match(prompt,/候选工作区运行相关测试/);
 assert.match(prompt,/检查完成后.*单独调用 completion_review_submit/);
 assert.doesNotMatch(prompt,/(?:只调用|只能调用) completion_review_submit/);
 assert.doesNotMatch(prompt,/防御性|执行者报告|完整差异|科普|one-shot/);
});
test('maintenance and policy interruptions retain distinct categories, codes and original evidence',()=>{
 const original='TREE_NOT_UPDATED: 修改了一个文件但缺少状态更新';
 const cause=Object.assign(new Error(original),{code:'STOP_HOOK_BLOCKED',stage:'postflight',maintenanceOnly:true,maintenanceIssues:['TREE_NOT_UPDATED'],hookReports:[{event:'Stop',source:'project-hook',blocked:true}]});
 const error=completionReviewInterruption(cause);
 assert.equal(error.review.failureCategory,'task-tree-maintenance');
 assert.equal(error.review.causeCode,'STOP_HOOK_BLOCKED');
 assert.equal(error.review.stage,'postflight');
 assert.deepEqual(error.review.maintenanceIssues,['TREE_NOT_UPDATED']);
 assert.deepEqual(error.review.hookReports,cause.hookReports);
 assert.equal(error.review.evidence[0],original);
 assert.match(error.message,/任务树维护未完成/);
 assert.doesNotMatch(error.message,/检查修复失败|权威资料：未提供/);
 const policy=completionReviewInterruption(Object.assign(new Error('权限拒绝'),{code:'STOP_HOOK_BLOCKED',stage:'postflight',maintenanceOnly:false,nonMaintenanceBlockers:['policy-hook']}));
 assert.equal(policy.review.failureCategory,'hook-blocked');
 assert.match(policy.message,/Hook 阻塞/);
 assert.doesNotMatch(policy.review.rootCause,/维护.*未闭环/);
});
test('transport, Hook command and unknown interruptions do not become product rejection',()=>{
 for(const [code,category] of [['MODEL_HEADERS_TIMEOUT','model-response-timeout'],['HOOK_EXECUTION_FAILED','hook-execution'],['UNCLASSIFIED','review-interrupted']]){
  const error=completionReviewInterruption(Object.assign(new Error('原始失败'),{code,stage:'request'}));
  assert.equal(error.review.failureCategory,category);
  assert.equal(error.review.causeCode,code);
  assert.equal(error.review.evidence[0],'原始失败');
  assert.doesNotMatch(error.message,/检查修复失败/);
 }
});
test('a known postflight block reports its actual boundary instead of an unknown API cause',()=>{
 const cause=Object.assign(new Error('STEP_EVIDENCE_MISSING'),{code:'STOP_HOOK_BLOCKED',stage:'postflight'});
 const error=completionReviewInterruption(cause);
 assert.equal(error.code,'COMPLETION_REVIEW_FAILED');
 assert.match(error.review.rootCause,/收尾 Hook/);
 assert.doesNotMatch(error.review.rootCause,/底层根因未确认/);
 assert.equal(error.cause,cause);
});
test('postflight error separates maintenance debt from unrelated Hook blocking',()=>{
 const maintenance=completionReviewInterruption(Object.assign(new Error('TREE_NOT_UPDATED'),{code:'STOP_HOOK_BLOCKED',maintenanceOnly:true,maintenanceIssues:['TREE_NOT_UPDATED']}));
 assert.match(maintenance.review.reason,/维护 Hook/);assert.match(maintenance.review.solution,/维护码/);
 const policy=completionReviewInterruption(Object.assign(new Error('权限策略阻止'),{code:'STOP_HOOK_BLOCKED',maintenanceOnly:false,nonMaintenanceBlockers:['global-hook']}));
 assert.match(policy.review.reason,/非维护 Hook/);assert.match(policy.review.solution,/权限/);assert.doesNotMatch(policy.review.reason,/TREE_NOT_UPDATED/);
});
test('a single complete JSON fence is transport formatting, not another model review',()=>{
 assert.deepEqual(parseCompletionReview('```json\n'+JSON.stringify(verdict)+'\n```'),verdict);
 assert.deepEqual(parseCompletionReview('```\n'+JSON.stringify({...verdict,verdict:'failed'})+'\n```'),{...verdict,verdict:'failed'});
});
test('contradictory narration, multiple verdicts and malformed fences remain rejected',()=>{
 for(const text of [
  '通过。'+JSON.stringify(verdict),
  '```json\n'+JSON.stringify(verdict)+'\n```\n但是失败',
  '```json\n'+JSON.stringify(verdict)+'\n```\n```json\n'+JSON.stringify(verdict)+'\n```',
  JSON.stringify(verdict)+JSON.stringify({...verdict,verdict:'failed'}),
  '```javascript\n'+JSON.stringify(verdict)+'\n```',
  '```json\n'+JSON.stringify(verdict)
 ])assert.throws(()=>parseCompletionReview(text),{code:'COMPLETION_REVIEW_FAILED'});
});
test('invalid output is preserved exactly for diagnosis, not silently accepted',()=>{
 const raw='全部23项通过。\n'+JSON.stringify(verdict);
 try {parseCompletionReview(raw);assert.fail('must reject narrative');}catch(error){assert.equal(error.review.rawOutput,raw);}
});
test('unfinalized handoff prose becomes one explicit failed review instead of hanging',()=>{
 const text='##### 仍未解决\n\n1. 尚未完成真实验证。\n\n执行者工作已结束，结果待宿主整合验收。';
 const review=parseUnfinalizedHandoffNarrative(text);
 assert.equal(review.verdict,'failed');
 assert.equal(review.evidence[0],text);
 assert.match(review.reason,/没有提交最终验收判定/);
 assert.equal(parseUnfinalizedHandoffNarrative('仍未解决：需要继续实现。'),null);
});
