// One final Agent owns completion checks, a targeted repair and its verification.
// Hook/global-method loading remains the normal runtime lifecycle.
import {executionErrorDetails} from './execution-error.js';
export const WORKER_RESULT_SCHEMA={type:'object',additionalProperties:false,required:['event','evidence'],properties:{
  event:{type:'string',enum:['completed','blocked']},evidence:{type:'string',minLength:1},
  peerRequests:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['toTaskId','question'],properties:{toTaskId:{type:'string'},question:{type:'string'},why:{type:'string'},expect:{type:'string'}}}}
}};
export const COMPLETION_REVIEW_TOOL = {type:'function',function:{
  name:'completion_review_submit',
  description:'完成所有必要验收及修复后单独调用，提交本候选最终判定并结束检查；无需再发一轮文字。不得与其它工具同批。',
  parameters:{type:'object',additionalProperties:false,required:['verdict','reason','evidence'],properties:{
    verdict:{type:'string',enum:['pass','failed']},reason:{type:'string',minLength:1},
    evidence:{type:'array',minItems:1,maxItems:3,items:{type:'string'}},rootCause:{type:'string'},caseStudy:{type:'string'},
    sources:{type:'array',maxItems:3,items:{type:'object',required:['url','finding'],properties:{url:{type:'string'},finding:{type:'string'}}}},solution:{type:'string'},
    treeState:{type:'object',additionalProperties:false,required:['status','reason'],properties:{status:{type:'string',enum:['consistent']},reason:{type:'string',minLength:1}},description:'核对宿主指定节点后，确认树的交付物、结论和剩余缺口与实际产物一致。若不一致，先更新必要字段；不为重复汇报强迫改树。'}
  }}
}};

// Some OpenAI-compatible gateways ignore the terminal tool schema and return
// the reviewer's handoff prose instead.  This is a terminal failure report,
// not a reason to keep sending the same prompt forever.  Require both the
// unresolved-list marker and the explicit host-handoff marker so ordinary
// discussion of a remaining issue is not mistaken for a terminal report.
export function parseUnfinalizedHandoffNarrative(output) {
  const text = String(output || '').trim();
  if (!text || !/(?:仍未解决|尚未解决)/.test(text)
    || !/(?:执行者工作已结束|结果待宿主整合验收|待宿主整合验收)/.test(text)) return null;
  return {
    verdict: 'failed',
    failureCategory: 'review-format',
    reason: '检查者只返回了未解决事项清单，没有提交最终验收判定。',
    evidence: [text],
    rootCause: '最终检查模型未按约定调用 completion_review_submit，返回了交接旁白。',
    caseStudy: '已收到完整未解决事项及“待宿主整合验收”边界，但没有可解析的 pass/failed 工具回执；按失败收尾，避免运行状态无限等待。',
    sources: [],
    solution: '根据清单补齐未解决事项后重新发送；若只需保留当前成果，可继续对话要求模型提交明确的最终验收判定。',
    rawOutput: text
  };
}

export function buildCompletionReviewPrompt(context) {
  return [context,
    '检查目标功能，在候选工作区运行相关测试或关键流程；有缺陷就修复并复验。',
    '验收范围以用户目标和交付合同为准：说明、分析或树内容任务核对事实与实际节点回写，不额外要求启动未被修改的业务服务；软件行为改动仍须验证相关行为，未实测的不要宣称已实测。',
    '检查完成后单独调用 completion_review_submit，提交判定、简短原因和最多 3 条验证证据。'
  ].join('\n\n');
}

export function parseCompletionReview(output) {
  let result;
  const text = String(output || '').trim();
  // Some gateways wrap the final structured reply in one Markdown fence.
  // Unwrap only a whole-message JSON fence; never fish a pass from narration,
  // multiple objects, partial streams or a conflicting trailing statement.
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  try { result = JSON.parse(fence ? fence[1] : text); } catch {}
  if (!result || !['pass', 'failed'].includes(result.verdict) || typeof result.reason !== 'string') {
    const error = new Error('检查回复格式无效：需要一个明确的 pass 或 failed JSON；本次未合入，不重复整轮检查。');
    error.code = 'COMPLETION_REVIEW_FAILED';
    error.review = { verdict: 'failed', reason: error.message, rawOutput:text, rootCause: '检查输出不符合约定，具体生成原因未知', caseStudy: '最终回复无法解析为单个判定 JSON', sources: [], solution: '检查模型/网关的结构化输出支持及返回内容，再由用户决定重试' };
    throw error;
  }
  return result;
}

export function completionReviewFailure(review) {
  const sources = (Array.isArray(review.sources) ? review.sources : []).map(source =>
    typeof source === 'string' ? source : `${source.url || ''}：${source.finding || ''}`).join('\n');
  const titles = {'task-tree-maintenance':'任务树维护未完成','hook-blocked':'Hook 阻塞',
    'hook-execution':'Hook 执行异常','model-response-timeout':'模型响应超时',
    'model-gateway':'模型网关请求失败','model-context':'模型上下文交接异常',
    'review-format':'最终检查未提交有效判定','review-interrupted':'最后检查执行中断'};
  const interruption = Boolean(titles[review.failureCategory]);
  const error = new Error(interruption ? [
    `${titles[review.failureCategory]}：${review.reason}`,
    `发生环节：${review.stage || 'final-review'} · 原始错误码：${review.causeCode || '未提供'}`,
    ...(review.maintenanceIssues?.length ? [`维护问题码：${review.maintenanceIssues.join('、')}`] : []),
    ...(review.nonMaintenanceBlockers?.length ? [`阻塞来源：${review.nonMaintenanceBlockers.join('、')}`] : []),
    `根因：${review.rootCause || '未确认'}`,
    `原始原因：${(review.evidence || []).join('\n')}`,
    `处理方式：${review.solution || '保留候选与原始诊断，不标记任务成功'}`
  ].join('\n') : [
    `检查修复失败：${review.reason}`,
    `根因：${review.rootCause || '未确认'}`,
    `案例调查：${review.caseStudy || '未提供；不能声称完成详细调查'}`,
    `权威资料：${sources || '未提供或无法访问，尚无资料支持'}`,
    `建议方案：${review.solution || '暂无经证据支持的方案'}`
  ].join('\n'));
  error.code = 'COMPLETION_REVIEW_FAILED';
  error.failureCategory = review.failureCategory || 'product-rejected';
  error.stage = review.stage || 'final-review';
  error.review = review;
  return error;
}

export function completionReviewInterruption(cause) {
  if (cause.code === 'COMPLETION_REVIEW_FAILED') return cause;
  const postflight = cause.code === 'STOP_HOOK_BLOCKED';
  const maintenance = postflight && cause.maintenanceOnly === true;
  const category = maintenance ? 'task-tree-maintenance' : postflight ? 'hook-blocked'
    : cause.code === 'HOOK_EXECUTION_FAILED' ? 'hook-execution'
    : ['MODEL_HEADERS_TIMEOUT','MODEL_STREAM_IDLE_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause.code) ? 'model-response-timeout'
    : ['MODEL_REQUEST_EXHAUSTED','MODEL_STREAM_INCOMPLETE'].includes(cause.code) ? 'model-gateway'
    : ['MODEL_CONTEXT_CAPACITY','MODEL_CONTEXT_REJECTED'].includes(cause.code) ? 'model-context'
    : cause.code === 'TREE_REFERENCE_MISSING' ? 'tree-reference' : 'review-interrupted';
  const reason = maintenance
    ? `最后检查未完成：维护 Hook 仍有未闭环事项（${(cause.maintenanceIssues || []).join('、') || '维护状态待处理'}）`
    : postflight ? `最后检查未完成：非维护 Hook 阻塞（${(cause.nonMaintenanceBlockers || []).join('、') || 'Hook 拒绝或策略阻塞'}）`
    : `最后检查未完成：${cause.message}`;
  const error = completionReviewFailure({ verdict: 'failed', reason,
    failureCategory:category, causeCode:cause.code || '', stage:cause.stage || (postflight?'postflight':'final-review'),
    ...(cause.maintenanceIssues ? {maintenanceIssues:cause.maintenanceIssues} : {}),
    ...(cause.nonMaintenanceBlockers ? {nonMaintenanceBlockers:cause.nonMaintenanceBlockers} : {}),
    ...(cause.hookReports ? {hookReports:cause.hookReports} : {}),
    evidence: [cause.cause?.message || cause.message], rootCause: maintenance
      ? '收尾 Hook 检测到任务树维护欠项；产物判定与维护状态是两件事，不能据此认定产物错误或 API 故障'
      : postflight ? '收尾 Hook 被非维护策略阻塞；不是任务树欠项或产物验收失败的证明'
      : category==='hook-execution' ? 'Hook 命令或返回协议执行失败；按 Hook 来源排查，不归因产物或模型网关'
      : category==='model-response-timeout' ? '模型请求等待响应头或流数据超时；本次没有完成最终验收，不证明产物错误'
      : category==='tree-reference' ? cause.message
      : '检查执行中断；底层根因未确认，不能据此认定产物错误或上游故障',
    caseStudy: postflight
      ? `检查候选未获最终验收，已整合成果不因此回滚；阻塞分类为${maintenance ? '维护欠项' : '非维护 Hook'}：${cause.message}`
      : `检查候选未获最终验收，已整合成果不因此回滚；最后检查边界返回错误：${cause.message}`,
    sources: [], solution: maintenance
      ? '保留候选产物，在原检查会话按具体维护码更新任务树、步骤证据或 flow 后再次提交原判定；不重做产物验收。'
      : postflight
        ? '保留候选产物，单独检查被阻塞的 Hook 及其策略/权限；不要把普通 Hook 阻塞包装成 TREE_NOT_UPDATED。'
        : category==='tree-reference' ? '候选成果已保留。更新报错所指的树注册入口或 SubtreeFile，或恢复被引用的树文件，再续接验收；不重新执行已完成任务。'
        : '保留候选产物，按错误追踪请求、工具与 Hook 的首次失败；目前未完成权威资料调查，不继续自动修改' });
  error.cause = cause;
  Object.assign(error, executionErrorDetails(cause), {code:'COMPLETION_REVIEW_FAILED',failureCategory:category,stage:error.review.stage});
  return error;
}
