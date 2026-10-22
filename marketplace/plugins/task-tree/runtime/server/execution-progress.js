const phaseLabels={queued:'请求已收到',loading:'正在加载共享工具',planning:'正在复评独立剩余任务的并发执行方式',model:'正在等待模型响应',summarizing:'正在整理长上下文，完成后继续执行',retrying:'网关暂时异常，正在自动恢复',streaming:'正在接收模型输出',tool:'正在调用工具',saving:'正在保存结果',merging:'正在整合结果，尚未完成',checking:'正在独立检查整合结果（最终验收），尚未完成',repairing:'正在修复检查发现的问题',finalizing:'执行者已输出，正在收尾，尚未完成'};

import { contextLimitDetails } from './model-context-error.js';

// Review notifications have a separate owner. They must never overwrite the
// executing agent's answer, streams or model timing, nor mark the run accepted.
export function recordIntegrationProgress(run,message) {
  const method=message?.method||'',params=message?.params||{};
  let activity='';
  if(method==='runtime/loading')activity='正在加载最后验收的共享工具';
  else if(method==='model/request-started')activity='正在等待验收模型响应';
  else if(method==='item/updated'&&params.item?.type==='agentMessage')activity='正在接收验收输出，整轮尚未结束';
  else if(method==='item/updated'&&params.item?.type==='reasoning')activity='验收模型正在分析，整轮尚未结束';
  else if(method==='model/round-completed')activity='验收模型本次响应已结束，正在处理结果';
  else if(method==='model/request-retrying')activity='验收请求正在自动重试';
  else if(method==='tool/started')activity=`验收调用 ${params.toolName||'工具'}`;
  else if(method==='tool/completed')activity=`验收${params.result?.ok===false?'工具失败':'工具完成'}：${params.toolName||'工具'}`;
  else if(method==='execution/finalizing')activity='验收输出已收到，正在执行收尾 Hook';
  else if(method==='hook/completed'&&params.event==='Stop')activity='验收收尾 Hook 已返回，正在处理验收结果';
  else if(method==='execution/saving')activity='正在保存验收结果，整轮尚未结束';
  else if(method==='execution/continuing')activity=params.message;
  else if(method==='model/continuing')activity=params.message;
  else if(method.startsWith('context/compaction-'))activity=params.message||'正在整理验收上下文';
  if(activity) {
    const previous=run.reviewActivity||{},now=new Date().toISOString();
    run.reviewActivity={...previous,message:activity,at:now,startedAt:previous.startedAt||now,
      round:(previous.round||0)+(method==='model/request-started'?1:0),
      receivedChars:(previous.receivedChars||0)+(method==='item/updated'?String(params.item?.delta||'').length:0)};
    if(method==='model/continuing')run.reviewActivity.continuation={reason:params.reason||'',detail:params.detail||'',at:now};
    if(method==='model/round-completed')run.reviewActivity.lastModelRound=Object.fromEntries(
      ['round','requestMs','streamMs','totalMs','toolCalls','finishReason','outputChars','reasoningChars','errorCode'].filter(key=>params[key]!==undefined).map(key=>[key,params[key]]));
  }
  return activity;
}

export function recordCompactionProgress(run, method) {
  if (method === 'context/compaction-started') run.phase = 'summarizing';
  if (['context/compaction-completed', 'context/compaction-deferred', 'context/compaction-failed', 'context/compaction-capacity-warning'].includes(method)) {
    run.phase = 'model';
    delete run.retryAt;
  }
}

export function recordRunDuration(samples,run) {
  const totalMs=Date.parse(run.updatedAt)-Date.parse(run.createdAt);
  if(run.status!=='completed'||!Number.isFinite(totalMs)||totalMs<=0) return;
  const sample={runId:run.id,treeId:run.treeId,nodeId:run.nodeId,totalMs};
  const index=samples.findIndex(s=>s.runId===run.id);
  if(index<0)samples.push(sample);else samples[index]=sample;
}

export function readableExecutionError(error) {
  const raw=String(error||'');
  const capacity=contextLimitDetails(raw);
  if(capacity && !raw.startsWith('上下文摘要失败'))return `上下文容量恢复未完成${capacity.inputTokens?`：输入 ${capacity.inputTokens} token，模型窗口 ${capacity.windowTokens} token`:''}；不是普通网络故障。原文与已保存成果保留，留空发送可继续恢复。`;
  if (/^git diff 失败(?::\s*)?$/i.test(raw.trim())) {
    return 'Git 差异读取失败：后端没有返回具体诊断；已保留本轮工作区，重新执行会重新建立差异。请检查项目是否仍是 Git 仓库及工作区权限。';
  }
  if (raw.startsWith('上下文摘要失败')) {
    const http = raw.match(/HTTP (\d+)/), code = raw.match(/MODEL_[A-Z_]*TIMEOUT/);
    return `上下文摘要失败${http ? `（网关 HTTP ${http[1]}）` : code ? `（${code[0]}）` : ''}，当前输入需要压缩才能继续；本轮已结束。原文和已保存结果保留，留空点击发送可重试摘要并继续。`;
  }
  if (raw === 'DeepSeek 请求超时') return '本轮累计执行达到时间上限，已结束；不是单次 API 请求超时。输入框留空点击发送可继续，已保存结果不回滚。';
  const http=raw.match(/(?:DeepSeek|模型) HTTP (\d+)/);
  if(http) {
    const retries=raw.match(/已重试 (\d+) 次/);
    return `模型网关返回 HTTP ${http[1]}${retries?`（已自动重试 ${retries[1]} 次，仍失败）`:''}，本轮执行已失败；不是仍在执行。请稍后重试，已有成功保存的修改不会自动回滚。`;
  }
  return raw;
}

export function executionProgress(run,samples=[],now=Date.now()) {
  const terminal=['completed','failed','stopped'].includes(run.status);
  const started=Date.parse(run.createdAt);
  const ended=terminal?Date.parse(run.updatedAt):now;
  const elapsedMs=Number.isFinite(started)?Math.max(0,(Number.isFinite(ended)?ended:now)-started):0;
  const durations=samples.filter(s=>s.treeId===run.treeId&&s.nodeId===run.nodeId&&Number.isFinite(s.totalMs)&&s.totalMs>0).map(s=>s.totalMs).sort((a,b)=>a-b);
  const mid=Math.floor(durations.length/2);
  const median=durations.length?(durations.length%2?durations[mid]:(durations[mid-1]+durations[mid])/2):null;
  const overEstimate=!terminal&&median!==null&&elapsedMs>=median;
  const countdown=run.phase==='retrying'&&Number.isFinite(run.retryAt)?`（约 ${Math.max(0,Math.ceil((run.retryAt-now)/1000))} 秒后再次请求）`:'';
  const parallelJobs=run.parallel?.jobs||[];
  const parallelProgress=parallelJobs.length?`（${parallelJobs.filter(job=>job.status==='completed').length}/${parallelJobs.length} 完成，${parallelJobs.filter(job=>job.status==='failed').length} 失败，${parallelJobs.filter(job=>job.status==='blocked').length} 阻塞，${parallelJobs.filter(job=>['running','preparing','retrying'].includes(job.status)).length} 进行中）`:'';
  return {phase:terminal?run.status:run.phase||'model',label:terminal?(run.status==='completed'?'本轮已结束，执行完成':run.status==='stopped'?'本轮已停止':'本轮已结束，执行失败'):run.status==='stopping'?'正在停止模型和工具':run.phase==='coordinating'?'协调器正在从已保存检查点恢复，尚未结束':run.phase==='parallel'?`正在执行拆分任务${parallelProgress}`:(phaseLabels[run.phase]||phaseLabels.model)+countdown,
    elapsedMs,lastActivityAt:run.updatedAt||run.createdAt,
    estimatedRemainingMs:terminal?0:median!==null&&!overEstimate?Math.round(median-elapsedMs):null,
    estimatedTotalMs:median,estimateRangeMs:durations.length?[Math.max(0,durations[0]-elapsedMs),Math.max(0,durations.at(-1)-elapsedMs)]:null,
    estimateBasis:durations.length?`同树同节点历史 ${durations.length} 次成功实测的中位耗时；仅供参考，不是完成承诺`:'暂无同节点成功实测，无法可靠预估',sampleCount:durations.length,overEstimate};
}
