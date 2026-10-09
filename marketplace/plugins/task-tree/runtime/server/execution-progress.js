const phaseLabels={queued:'请求已收到',loading:'正在加载共享工具',model:'正在等待模型响应',retrying:'网关暂时异常，正在自动恢复',streaming:'正在接收模型输出',tool:'正在调用工具',saving:'正在保存结果'};

export function recordRunDuration(samples,run) {
  const totalMs=Number(run.timing?.totalMs) || Date.parse(run.updatedAt)-Date.parse(run.createdAt);
  if(run.status!=='completed'||!Number.isFinite(totalMs)||totalMs<=0||samples.some(s=>s.runId===run.id)) return;
  samples.push({runId:run.id,treeId:run.treeId,nodeId:run.nodeId,totalMs});
}

export function readableExecutionError(error) {
  const raw=String(error||'');
  const http=raw.match(/DeepSeek HTTP (\d+)/);
  if(http) {
    const retries=raw.match(/已重试 (\d+) 次/);
    return `模型网关返回 HTTP ${http[1]}${retries?`（已自动重试 ${retries[1]} 次，仍失败）`:''}，本轮执行已失败；不是仍在执行。请稍后重试，已有成功保存的修改不会自动回滚。`;
  }
  if(/工具执行超过 \d+ 轮/.test(raw)) return '本轮已达到工具调用轮数上限并停止，任务尚未完成；可在原节点继续，不需要新建对话。';
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
  return {phase:terminal?run.status:run.phase||'model',label:terminal?(run.status==='completed'?'本轮已结束，执行完成':run.status==='stopped'?'本轮已停止':'本轮已结束，执行失败'):run.status==='stopping'?'正在停止模型和工具':(phaseLabels[run.phase]||phaseLabels.model)+countdown,
    elapsedMs,lastActivityAt:run.updatedAt||run.createdAt,
    estimatedRemainingMs:terminal?0:median!==null&&!overEstimate?Math.round(median-elapsedMs):null,
    estimatedTotalMs:median,estimateRangeMs:durations.length?[Math.max(0,durations[0]-elapsedMs),Math.max(0,durations.at(-1)-elapsedMs)]:null,
    estimateBasis:durations.length?`同树同节点历史 ${durations.length} 次成功实测的中位耗时；仅供参考，不是完成承诺`:'暂无同节点成功实测，无法可靠预估',sampleCount:durations.length,overEstimate};
}
