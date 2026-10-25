// Durable context deliberately excludes transient tool calls/results and reasoning.
export function dialogueMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && ['user', 'assistant'].includes(message.role)
      && typeof message.content === 'string' && message.content.trim().length > 0)
    .map(({ role, content, attachments, presentation }) => ({ role, content,
      ...(role === 'assistant' && presentation ? {presentation:dialoguePresentation(presentation)} : {}),
      ...(role === 'user' && Array.isArray(attachments) && attachments.length ? { attachments: attachments.map(({ id, name, kind, size, warning, url }) => ({ id, name, kind, size, warning, url })) } : {}) }));
}

// Display metadata is text only, never reasoning or transient tool payloads.
export function dialoguePresentation(value) {
  return {process:typeof value?.process === 'string' ? value.process : '',
    answer:typeof value?.answer === 'string' ? value.answer : ''};
}

export function dialogueHasRunOutput(messages,run) {
  const last=messages.at(-1);
  if(last?.role!=='assistant')return false;
  if(last.content===run.output||run.output && last.content.startsWith(run.output))return true;
  return Boolean(run.presentation && (last.presentation?.answer===run.presentation.answer
    && last.presentation?.process===run.presentation.process
    || run.presentation.answer && last.content.startsWith(run.presentation.answer)));
}

// The Worker cannot know what the execution repair stage or Git actually
// applied. Attach that host-owned receipt to the final answer/export without
// another model call; never invent edits for a read-only result.
export function dialogueWithCompletionReceipt(messages, run) {
  const result = dialogueMessages(messages);
  const retained = run?.workspacePath || run?.checkpoint?.workerPath;
  if (['failed','stopped'].includes(run?.status) && retained) {
    const receipt = ['【未合入成果回执】',
      `运行：${run.id || '未记录'}；状态：${run.status === 'failed' ? '失败' : '已停止'}。`,
      `候选工作区（最后记录位置，复用前须核对存在性）：${JSON.stringify(retained)}`,
      ...(run.checkpoint?.workerPath&&run.checkpoint.workerPath!==retained?[`原执行者工作区：${JSON.stringify(run.checkpoint.workerPath)}`]:[]),
      ...(run.retainedWorkspaces?.length?[`其它保留候选：${JSON.stringify(run.retainedWorkspaces)}`]:[]),
      '执行者报告不能代表成果已经合入当前主项目；继续时先核对并复用原候选，不要把主目录中不存在误判为产物丢失或直接重新提取。'].join('\n');
    const last = result.at(-1);
    if (last?.role === 'assistant') {
      if (!last.content.endsWith(receipt)) last.content += '\n\n' + receipt;
    } else result.push({role:'assistant',content:receipt});
    return result;
  }
  if (run?.status !== 'completed' || run.review?.verdict !== 'pass') return result;
  const files = Array.isArray(run.appliedFiles) ? run.appliedFiles : [];
  const treeEdits = (run.treeChanges || []).map(({ treePath, changes }) =>
    `树文件：${treePath}\n${changes.map(change => `- ${change.nodeId} · ${change.field}：${change.before || '（空）'} → ${change.after || '（空）'}`).join('\n')}`);
  const receipt = ['【实际交付回执】',
    run.projectRoot ? `主项目：${run.projectRoot}` : '',
    run.treePath ? `执行来源树：${run.treeId} · ${run.treePath} · 节点 ${run.nodeId}` : '',
    `最后检查通过：${run.review.reason}`,
    ...treeEdits,
    files.length && !treeEdits.length ? Array.isArray(run.treeChanges)
      ? '本轮没有树节点字段变化（新增或删除也会在此列出）；文件修改不等于新增树节点。'
      : '旧记录未保存节点差异；不能仅凭文件列表判断树节点是否变化。' : '',
    files.length ? `已合入项目的文件：\n${files.map(file => `- ${file}`).join('\n')}` : '本轮未修改文件；最后检查已按用户目标核对结果。'].join('\n');
  const last = result.at(-1);
  if (last?.role === 'assistant') last.content += '\n\n' + receipt;
  else result.push({role:'assistant',content:receipt});
  return result;
}

const values = collection => collection instanceof Map ? [...collection.values()]
  : Array.isArray(collection) ? collection : [];
const text = value => typeof value === 'string' ? value : '';
const stringList = value => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  : [];
const retainedWorkspace = value => value && typeof value === 'object' && typeof value.workspacePath === 'string' && value.workspacePath.trim()
  ? { workspacePath: value.workspacePath.trim(), sourcePath: text(value.sourcePath), role: text(value.role) }
  : null;
const retainedWorkspaceList = value => (Array.isArray(value) ? value : []).map(retainedWorkspace).filter(Boolean);
const reviewOutcome = review => review ? {
  verdict: text(review.verdict), reason: text(review.reason),
  ...(Array.isArray(review.issues)?{issues:review.issues.map(issue=>({id:text(issue.id),problem:text(issue.problem),...(Array.isArray(issue.files)?{files:issue.files.map(text)}:{}),...(Array.isArray(issue.inputPaths)?{inputPaths:issue.inputPaths.map(text)}:{}),...(issue.acceptanceCriteria?{acceptanceCriteria:text(issue.acceptanceCriteria)}:{})}))}:{}),
  ...(review.repairStatus?{repairStatus:text(review.repairStatus)}:{}),
  ...(review.failureCategory ? {failureCategory:text(review.failureCategory)} : {}),
  ...(review.stage ? {stage:text(review.stage)} : {}),
  ...(review.causeCode ? {causeCode:text(review.causeCode)} : {}),
  evidence: Array.isArray(review.evidence) ? review.evidence.map(text) : [],
  rootCause: text(review.rootCause), caseStudy: text(review.caseStudy),
  sources: Array.isArray(review.sources) ? review.sources.map(source => typeof source === 'string' ? source : { url: text(source.url), finding: text(source.finding) }) : [],
  solution: text(review.solution),
  ...(Array.isArray(review.unrelatedInputChanges)?{unrelatedInputChanges:review.unrelatedInputChanges.map(item=>({file:text(item.file),reason:text(item.reason)}))}:{}),
  ...(review.dependencyScope ? {dependencyScope:{complete:review.dependencyScope.complete===true,
    files:(Array.isArray(review.dependencyScope.files)?review.dependencyScope.files:[]).map(text)}} : {})
} : null;

// A validated delegation plan is durable recovery state, not a model transcript.
// Project only the fields needed to reuse or revise the plan after a restart;
// never persist arbitrary tool payloads, prompts, or reasoning attached by a model.
const deliveryContractItem = value => {
  if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !value.path.trim()
    || !['update','present','delete'].includes(value.mode)) return null;
  return { path: value.path.trim(), mode: value.mode,
    ...(stringList(value.nodeIds).length ? { nodeIds: [...new Set(stringList(value.nodeIds))] } : {}) };
};
const delegationJob = value => {
  if (!value || typeof value !== 'object') return null;
  const job = {
    taskId: text(value.taskId), nodeId: text(value.nodeId), title: text(value.title),
    instruction: text(value.instruction), workEstimate: text(value.workEstimate),
    writeSet: stringList(value.writeSet), dependsOn: stringList(value.dependsOn),
    deliverables: (Array.isArray(value.deliverables) ? value.deliverables : []).map(deliveryContractItem).filter(Boolean),
    acceptanceCriteria: stringList(value.acceptanceCriteria)
  };
  return job.taskId && job.title && job.instruction ? job : null;
};
const delegationError = value => {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(['code','causeCode','stage','message']
    .map(key => [key, text(value[key])]).filter(([, item]) => item));
};
const delegationCheckpoint = value => value && typeof value === 'object' ? {
  status: text(value.status), changedFiles: stringList(value.changedFiles), appliedFiles: stringList(value.appliedFiles),
  workspacePath: text(value.workspacePath), retainedWorkspaces: retainedWorkspaceList(value.retainedWorkspaces),
  ...(reviewOutcome(value.review) ? { review: reviewOutcome(value.review) } : {}),
  ...(Array.isArray(value.treeChanges) ? { treeChanges: value.treeChanges.map(({treePath, changes}) => ({
    treePath: text(treePath), changes: (Array.isArray(changes) ? changes : []).map(change => Object.fromEntries(
      ['kind','nodeId','title','field','before','after'].map(key => [key, text(change?.[key])])
    ))
  })) } : {})
} : null;
export function pendingDelegationState(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    reason: text(value.reason), sharedContract: text(value.sharedContract),
    acceptanceCriteria: stringList(value.acceptanceCriteria),
    jobs: (Array.isArray(value.jobs) ? value.jobs : []).map(delegationJob).filter(Boolean),
    status: text(value.status), stage: text(value.stage), runId: text(value.runId),
    ...(value.error ? { error: delegationError(value.error) } : {}),
    ...(text(value.workspacePath) ? { workspacePath: text(value.workspacePath) } : {}),
    ...(retainedWorkspaceList(value.retainedWorkspaces).length ? { retainedWorkspaces: retainedWorkspaceList(value.retainedWorkspaces) } : {}),
    ...(delegationCheckpoint(value.delegationCheckpoint) ? { delegationCheckpoint: delegationCheckpoint(value.delegationCheckpoint) } : {})
  };
  return result.jobs.length ? result : null;
}
const interrupted = status => ['starting', 'running', 'stopping'].includes(status);
const reviewActivity = value => value ? {
  message:text(value.message),at:text(value.at),startedAt:text(value.startedAt),
  round:Number(value.round)||0,receivedChars:Number(value.receivedChars)||0
} : null;
// Persist performance evidence, not tool arguments/results, prompts, API URLs,
// Hook stdout or private reasoning. Restart must not erase why a review was
// discarded or which function consumed the time.
const fields=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined
  && ['string','number','boolean'].includes(typeof value[key])).map(key=>[key,value[key]]));
const numbers=value=>Object.fromEntries(Object.entries(value||{}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)));
const list=value=>Array.isArray(value)?value:[];
const toolMetric=value=>fields(value,['round','toolName','startedAt','endedAt','preHookMs','executeMs','postHookMs','durationMs']);
const hookReports=values=>(Array.isArray(values)?values:[]).map(value=>fields(value,['source','event','ok','blocked','startedAt','endedAt','durationMs']));
const roundMetric=value=>({...fields(value,['round','requestMs','streamMs','totalMs','toolCalls','requestBytes','model','failedStage','errorCode','finishReason','outputChars','reasoningChars']),
  ...(value?.contextInput?{contextInput:{...numbers(value.contextInput),...fields(value.contextInput,['basis'])}}:{}),
  ...(value?.tokenUsage?{tokenUsage:numbers(value.tokenUsage)}:{}),
  ...(value?.attempts?{attempts:list(value.attempts).map(a=>fields(a,['attempt','status','durationMs','requestMs','totalMs','errorCode']))}:{})});
const performanceTiming=value=>value?{
  ...fields(value,['startedAt','requestMs','totalMs','provider','model','initialModel','runtimeMs']),
  ...(value.contextBudget?{contextBudget:fields(value.contextBudget,['windowTokens','compactionThresholdTokens','windowSource','thresholdSource'])}:{}),
  rounds:list(value.rounds).map(roundMetric),tools:list(value.tools).map(toolMetric),
  hooks:list(value.hooks).map(h=>({...fields(h,['event','durationMs']),reports:hookReports(h.reports)})),
  ...(value.usage?{usage:numbers(value.usage)}:{}),
  ...(value.formatCorrections?{formatCorrections:list(value.formatCorrections).map(c=>fields(c,['round']))}:{}),
  ...(value.continuations?{continuations:list(value.continuations).map(c=>fields(c,['round','reason','maintenanceOnly','issueCount']))}:{}),
  ...(value.receiptProjections?{receiptProjections:list(value.receiptProjections).map(c=>fields(c,['round','savedBytes','duplicateReceipts','durationMs']))}:{}),
  ...(value.summaryRequests?{summaryRequests:list(value.summaryRequests).map(c=>({...fields(c,['requestMs','streamMs','totalMs','purpose','status','errorCode','outputChars','outputBytes','reasoningChars']),
    ...(c.tokenUsage?{tokenUsage:numbers(c.tokenUsage)}:{})}))}:{}),
  ...(value.compactions?{compactions:list(value.compactions).map(c=>fields(c,['phase','durationMs','beforeTokens','afterTokens','errorCode']))}:{})
}:undefined;
const integrationTimings = values => (Array.isArray(values)?values:[])
  .filter(value=>['review-stage','review','review-invalidated','review-input','review-scope','review-dependencies',
    'review-dependency-receipt','review-dependency-clarification','review-model-round','review-tool','review-hook'].includes(value?.role))
  .map(value=>({...fields(value,['role','operation','attempt','candidateId','durationMs','status','errorCode','file','reason','phase','strategy','event','promptChars','promptBytes','changedFiles','deferredFiles','branchCount']),
    ...(Array.isArray(value.changedFiles)?{changedFiles:value.changedFiles.map(text)}:{}),
    ...(Array.isArray(value.reviewScopeFiles)?{reviewScopeFiles:value.reviewScopeFiles.map(text)}:{}),
    ...(value.dependencyScope?{dependencyScope:{complete:value.dependencyScope.complete===true,files:list(value.dependencyScope.files).map(text)}}:{}),
    ...(value.timing?{timing:value.role==='review-model-round'?roundMetric(value.timing):value.role==='review-tool'?toolMetric(value.timing):performanceTiming(value.timing)}:{}),
    ...(value.reports?{reports:hookReports(value.reports)}:{})}));

// Node identity is scoped to a tree, never to a turn or a model thread.
export function nodeConversationId(treeId, nodeId) {
  if (!treeId || !nodeId) throw new Error('节点对话需要 treeId 和 nodeId');
  return JSON.stringify([treeId, nodeId]);
}

export function latestNodeRuns(runs) {
  const latest = new Map();
  for (const run of values(runs)) {
    const key = run.treeId && run.nodeId ? nodeConversationId(run.treeId, run.nodeId) : run.id;
    const previous = latest.get(key);
    if (!previous || String(run.createdAt || '') >= String(previous.createdAt || '')) latest.set(key, run);
  }
  return [...latest.values()];
}

// Select the latest ongoing dialogue; do not concatenate unrelated legacy threads.
export function normalizeNodeDialogues(state, { defaultTreeId = '' } = {}) {
  const restored = restoreDialogueState(state);
  // Before multi-tree execution, an omitted tree meant the active method tree.
  for (const item of [...restored.runs, ...restored.conversations]) item.treeId ||= defaultTreeId;
  const runs = latestNodeRuns(restored.runs);
  const conversations = [];
  for (const run of runs) {
    if (!run.treeId || !run.nodeId) continue;
    const id = nodeConversationId(run.treeId, run.nodeId);
    const conversation = restored.conversations.find(c => c.id === run.conversationId
      && c.treeId === run.treeId && c.nodeId === run.nodeId);
    let messages = dialogueMessages(conversation?.messages || run.messages);
    const runMessages = dialogueMessages(run.messages);
    // A Worker checkpoint can be newer than the conversation while final review
    // is pending. Only extend a shared prefix; divergent edited versions must
    // never be concatenated or silently resurrected.
    if (runMessages.length > messages.length && messages.every((m,i)=>sameMessage(m,runMessages[i]))) messages=runMessages;
    if (!conversation && run.output.trim() && !dialogueHasRunOutput(messages,run)) {
      messages.push({ role: 'assistant', content: run.output,...(run.presentation?{presentation:run.presentation}:{}) });
    }
    run.conversationId = id;
    run.messages = messages;
    conversations.push({ id, nodeId: run.nodeId, treeId: run.treeId, messages,
      activeRunId: run.recoveryPending ? run.id : '', threadId: conversation?.threadId || run.threadId });
  }
  // A node may have text but no retained execution record.
  for (const c of restored.conversations) {
    if (!c.treeId || !c.nodeId) continue;
    const id = nodeConversationId(c.treeId, c.nodeId);
    if (!conversations.some(item => item.id === id)) conversations.push({ ...c, id, activeRunId: '' });
  }
  return { runs, conversations };
}

export function serializeDialogueState({ runs, conversations } = {}) {
  return {
    schema: 'task-tree-direct-state/v2',
    runs: values(runs).filter(Boolean).map(run => ({
      id: text(run.id),
      treeId: text(run.treeId),
      projectRoot: text(run.projectRoot),
      treePath: text(run.treePath),
      nodeId: text(run.nodeId),
      conversationId: text(run.conversationId),
      prompt: text(run.prompt),
      messages: dialogueMessages(run.messages),
      output: text(run.output) || text(run.streams?.agentMessage?.text),
      ...(run.presentation ? {presentation:dialoguePresentation(run.presentation)} : {}),
      status: text(run.status),
      threadId: text(run.threadId),
      turnId: text(run.turnId),
      error: text(run.error),
      workspacePath: text(run.workspacePath),
      ...(Array.isArray(run.retainedWorkspaces)?{retainedWorkspaces:retainedWorkspaceList(run.retainedWorkspaces)}:{}),
      checkpoint: run.checkpoint ? {
        ...Object.fromEntries(['runId','workerPath','integrationPath','snapshotCommit','runDir','indexPath'].map(key=>[key,text(run.checkpoint[key])])),
        ...(pendingDelegationState(run.checkpoint.pendingDelegation) ? { pendingDelegation: pendingDelegationState(run.checkpoint.pendingDelegation) } : {}),
        ...(delegationCheckpoint(run.checkpoint.delegationCheckpoint) ? { delegationCheckpoint: delegationCheckpoint(run.checkpoint.delegationCheckpoint) } : {})
      } : null,
      recoveryPending: run.recoveryPending === true,
      recoveryHistory: Array.isArray(run.recoveryHistory) ? run.recoveryHistory.map(item=>({action:text(item.action),signature:text(item.signature),reason:text(item.reason),codes:(item.codes||[]).map(text),at:text(item.at)})) : [],
      workerCompleted: run.workerCompleted === true,
      phase:text(run.phase),
      reviewActivity:reviewActivity(run.reviewActivity),
      integrationTimings:integrationTimings(run.integrationTimings),
      ...(run.timing?{timing:performanceTiming(run.timing)}:{}),
      changedFiles: Array.isArray(run.changedFiles) ? run.changedFiles.map(text) : [],
      appliedFiles: Array.isArray(run.appliedFiles) ? run.appliedFiles.map(text) : [],
      ...(Array.isArray(run.treeChanges) ? {treeChanges:run.treeChanges.map(({treePath,changes}) => ({treePath:text(treePath),
        changes:(Array.isArray(changes)?changes:[]).map(change=>Object.fromEntries(['kind','nodeId','title','field','before','after'].map(key=>[key,text(change[key])]))) }))} : {}),
      review: reviewOutcome(run.review),
      executionMode: text(run.executionMode),
      ...(Array.isArray(run.reviewScopeFiles) ? {reviewScopeFiles:run.reviewScopeFiles.map(text)} : {}),
      parallel: run.parallel ? { id: text(run.parallel.id), status: text(run.parallel.status), reason: text(run.parallel.reason),
        ...(Number.isInteger(run.parallel.ownerMessageIndex)&&run.parallel.ownerMessageIndex>=0?{ownerMessageIndex:run.parallel.ownerMessageIndex}:{}),
        ...(run.parallel.recoveryRequestedAt?{recoveryRequestedAt:text(run.parallel.recoveryRequestedAt)}:{}),
        coordination:run.parallel.coordination?{phase:text(run.parallel.coordination.phase),taskId:text(run.parallel.coordination.taskId),action:text(run.parallel.coordination.action),message:text(run.parallel.coordination.message),updatedAt:text(run.parallel.coordination.updatedAt)}:null,
        jobs: (run.parallel.jobs || []).map(job => ({ taskId: text(job.taskId), title: text(job.title), status: text(job.status), error: text(job.error), output: text(job.output) })) } : null,
      createdAt: text(run.createdAt),
      updatedAt: text(run.updatedAt),
    })),
    conversations: values(conversations).filter(Boolean).map(conversation => ({
      id: text(conversation.id),
      nodeId: text(conversation.nodeId),
      treeId: text(conversation.treeId),
      messages: dialogueMessages(conversation.messages),
      activeRunId: text(conversation.activeRunId),
      threadId: text(conversation.threadId),
    })),
  };
}

const sameMessage = (a, b) => a.role === b.role && a.content === b.content
  && JSON.stringify(a.attachments || []) === JSON.stringify(b.attachments || []);

// Histories normally share a prefix. Do not globally deduplicate message text:
// asking "continue" in two distinct turns is legitimate conversation content.
function mergeHistory(existing, incoming) {
  if (!incoming.length) return existing;
  const prefixLength = Math.min(existing.length, incoming.length);
  if (existing.slice(0, prefixLength).every((message, i) => sameMessage(message, incoming[i]))) {
    return incoming.length >= existing.length ? incoming : existing;
  }
  for (let overlap = prefixLength; overlap > 0; overlap--) {
    if (existing.slice(-overlap).every((message, i) => sameMessage(message, incoming[i]))) {
      return [...existing, ...incoming.slice(overlap)];
    }
  }
  return [...existing, ...incoming];
}

export function restoreDialogueState(state) {
  // The allowlist also removes transient fields when opening old v1 files.
  const { runs, conversations } = serializeDialogueState(state || {});
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  for (const run of runs) {
    if (!interrupted(run.status)) continue;
    const stopped = run.status === 'stopping';
    run.status = stopped ? 'stopped' : 'starting';
    run.recoveryPending = !stopped;
    run.error = '';
    const conversationId = run.conversationId || run.nodeId || run.id;
    if (!conversationId) continue;
    let conversation = byId.get(conversationId);
    // A stale record must never insert another project's dialogue into this tree.
    if (conversation?.treeId && run.treeId && conversation.treeId !== run.treeId) continue;
    if (!conversation) {
      conversation = { id: conversationId, nodeId: run.nodeId, treeId: run.treeId,
        messages: [], activeRunId: '', threadId: run.threadId };
      conversations.push(conversation);
      byId.set(conversationId, conversation);
    }
    const pending = run.messages.length ? [...run.messages]
      : dialogueMessages([{ role: 'user', content: run.prompt }]);
    if (run.output.trim() && !dialogueHasRunOutput(pending,run)) {
      pending.push({ role: 'assistant', content: run.output,...(run.presentation?{presentation:run.presentation}:{}) });
    }
    conversation.messages = mergeHistory(conversation.messages, pending);
    conversation.threadId ||= run.threadId;
  }
  for (const conversation of conversations) conversation.activeRunId = runs.find(run=>run.recoveryPending&&run.conversationId===conversation.id&&run.treeId===conversation.treeId)?.id || '';
  return { runs, conversations };
}
