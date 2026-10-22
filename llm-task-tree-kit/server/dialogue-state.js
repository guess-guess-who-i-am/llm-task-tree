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

// The Worker cannot know what the final checker repaired or what Git actually
// applied. Attach that host-owned receipt to the final answer/export without
// another model call; never invent edits for a read-only result.
export function dialogueWithCompletionReceipt(messages, run) {
  const result = dialogueMessages(messages);
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
const reviewOutcome = review => review ? {
  verdict: text(review.verdict), reason: text(review.reason),
  ...(review.failureCategory ? {failureCategory:text(review.failureCategory)} : {}),
  ...(review.stage ? {stage:text(review.stage)} : {}),
  ...(review.causeCode ? {causeCode:text(review.causeCode)} : {}),
  evidence: Array.isArray(review.evidence) ? review.evidence.map(text) : [],
  rootCause: text(review.rootCause), caseStudy: text(review.caseStudy),
  sources: Array.isArray(review.sources) ? review.sources.map(source => typeof source === 'string' ? source : { url: text(source.url), finding: text(source.finding) }) : [],
  solution: text(review.solution)
} : null;
const interrupted = status => ['starting', 'running', 'stopping'].includes(status);
const reviewActivity = value => value ? {
  message:text(value.message),at:text(value.at),startedAt:text(value.startedAt),
  round:Number(value.round)||0,receivedChars:Number(value.receivedChars)||0
} : null;
const integrationTimings = values => (Array.isArray(values)?values:[])
  .filter(value=>value?.role==='review-stage')
  .map(value=>({role:'review-stage',operation:text(value.operation),attempt:Number(value.attempt)||0,
    candidateId:text(value.candidateId),durationMs:Number(value.durationMs)||0}));

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
      checkpoint: run.checkpoint ? Object.fromEntries(['runId','workerPath','integrationPath','snapshotCommit','runDir','indexPath'].map(key=>[key,text(run.checkpoint[key])])) : null,
      recoveryPending: run.recoveryPending === true,
      recoveryHistory: Array.isArray(run.recoveryHistory) ? run.recoveryHistory.map(item=>({action:text(item.action),signature:text(item.signature),reason:text(item.reason),codes:(item.codes||[]).map(text),at:text(item.at)})) : [],
      workerCompleted: run.workerCompleted === true,
      phase:text(run.phase),
      reviewActivity:reviewActivity(run.reviewActivity),
      integrationTimings:integrationTimings(run.integrationTimings),
      changedFiles: Array.isArray(run.changedFiles) ? run.changedFiles.map(text) : [],
      appliedFiles: Array.isArray(run.appliedFiles) ? run.appliedFiles.map(text) : [],
      ...(Array.isArray(run.treeChanges) ? {treeChanges:run.treeChanges.map(({treePath,changes}) => ({treePath:text(treePath),
        changes:(Array.isArray(changes)?changes:[]).map(change=>Object.fromEntries(['kind','nodeId','title','field','before','after'].map(key=>[key,text(change[key])]))) }))} : {}),
      review: reviewOutcome(run.review),
      executionMode: text(run.executionMode),
      parallel: run.parallel ? { id: text(run.parallel.id), status: text(run.parallel.status), reason: text(run.parallel.reason),
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
