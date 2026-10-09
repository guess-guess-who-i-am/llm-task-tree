// Durable context deliberately excludes transient tool calls/results and reasoning.
export function dialogueMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && ['user', 'assistant'].includes(message.role)
      && typeof message.content === 'string' && message.content.trim().length > 0)
    .map(({ role, content, attachments }) => ({ role, content,
      ...(role === 'user' && Array.isArray(attachments) && attachments.length ? { attachments: attachments.map(({ id, name, kind, size, warning, url }) => ({ id, name, kind, size, warning, url })) } : {}) }));
}

const values = collection => collection instanceof Map ? [...collection.values()]
  : Array.isArray(collection) ? collection : [];
const text = value => typeof value === 'string' ? value : '';
const interrupted = status => ['starting', 'running', 'stopping'].includes(status);

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
    const messages = dialogueMessages(conversation?.messages || run.messages);
    if (!conversation && run.output.trim() && !(messages.at(-1)?.role === 'assistant' && messages.at(-1).content === run.output)) {
      messages.push({ role: 'assistant', content: run.output });
    }
    run.conversationId = id;
    conversations.push({ id, nodeId: run.nodeId, treeId: run.treeId, messages,
      activeRunId: '', threadId: conversation?.threadId || run.threadId });
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
      nodeId: text(run.nodeId),
      conversationId: text(run.conversationId),
      prompt: text(run.prompt),
      messages: dialogueMessages(run.messages),
      output: text(run.output) || text(run.streams?.agentMessage?.text),
      status: text(run.status),
      threadId: text(run.threadId),
      turnId: text(run.turnId),
      error: text(run.error),
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
    run.status = 'failed';
    run.error = run.error ? `${run.error}\n服务已重启，本轮执行中断；可在原会话继续。`
      : '服务已重启，本轮执行中断；可在原会话继续。';
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
    if (run.output.trim() && !(pending.at(-1)?.role === 'assistant' && pending.at(-1).content === run.output)) {
      pending.push({ role: 'assistant', content: run.output });
    }
    conversation.messages = mergeHistory(conversation.messages, pending);
    conversation.threadId ||= run.threadId;
  }
  for (const conversation of conversations) conversation.activeRunId = '';
  return { runs, conversations };
}
