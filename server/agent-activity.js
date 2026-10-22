// Store useful live progress without copying tool arguments/results or reasoning.
export function recordAgentActivity(job, notification) {
  const {method, params={}}=notification;
  const at=new Date().toISOString();
  const item=params.item;
  let label,trace;
  if(method==='item/updated'&&item?.type==='agentMessage') {
    job.liveOutput=(job.liveOutput||'')+(item.delta||'');
    job.hasStreamedOutput=true;
    label='正在输出';
  } else if(method==='item/updated'&&item?.type==='reasoning') label='正在思考';
  else if(method==='item/completed'&&item?.type==='agentMessage') {
    if(!job.hasStreamedOutput&&item.text)job.liveOutput=(job.liveOutput||'')+item.text;
    label='模型本次回复完成';
  } else if(method==='tool/started') {
    job.activeTools ||= {};
    job.activeTools[params.toolCallId||params.toolName]=params.toolName;
    label=`正在调用 ${params.toolName}`;
  } else if(method==='tool/completed') {
    delete job.activeTools?.[params.toolCallId||params.toolName];
    job.completedTools=(job.completedTools||0)+1;
    label=`${params.result?.ok===false?'调用失败':'已完成'} ${params.toolName}`;
  } else if(method==='execution/strategy') {
    // Keep the decision, not tool arguments/reasoning. A later stream update
    // must not erase why this branch stayed single or where it will split.
    const strategy={at,mode:params.mode||'single',message:params.message||'',
      ...(typeof params.reason==='string'?{reason:params.reason}:{}),
      ...(typeof params.nextCheckpoint==='string'?{nextCheckpoint:params.nextCheckpoint}:{})};
    job.executionStrategy=strategy;
    (job.strategyHistory ||= []).push(strategy);
    label=params.message||params.reason||'已更新执行方式';
    trace={method,...strategy};
  } else if(method.startsWith('context/compaction-')) {
    const context={at,status:method.slice('context/compaction-'.length),message:params.message||'正在整理本分支上下文'};
    for(const key of ['inputTokens','beforeTokens','afterTokens','inputChars','summaryChars','durationMs'])
      if(Number.isFinite(params[key]))context[key]=params[key];
    job.contextActivity=context;label=context.message;trace={method,...context};
  } else if(method==='model/request-retrying'||method==='model/request-started') {
    job.requestActivity={at,status:method==='model/request-started'?'waiting':'retrying',
      ...(Number.isFinite(params.round)?{round:params.round}:{}),
      ...(Number.isFinite(params.attempt)?{attempt:params.attempt}:{})};
    label=params.message||(method==='model/request-started'?'等待模型响应':'正在重试模型请求');
    if(method==='model/request-retrying')trace={method,...job.requestActivity,message:label};
  } else if(method.startsWith('execution/')) {
    label=params.message;
    if(label)trace={method,at,message:label};
  }
  if(label)job.activity={label,at};
  return trace;
}
