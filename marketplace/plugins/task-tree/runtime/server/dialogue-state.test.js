import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueMessages, serializeDialogueState, restoreDialogueState } from './dialogue-state.js';

const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });

test('restart recovers stopping partial output but preserves a completed stopped record', () => {
  for (const status of ['stopping', 'stopped']) {
    const state = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', nodeId: 'N1', treeId: 'a', status, messages: [user('开始')], output: '完整部分输出' }],
      conversations: [{ id: 'c', treeId: 'a', nodeId: 'N1', messages: status === 'stopped' ? [user('开始'), assistant('完整部分输出')] : [user('开始')] }] });
    assert.equal(state.runs[0].status, status === 'stopping' ? 'failed' : 'stopped');
    assert.deepEqual(state.conversations[0].messages, [user('开始'), assistant('完整部分输出')]);
  }
});

test('durable messages contain only full user and assistant text', () => {
  const full = '完整、不截断的对话🙂\n'.repeat(20000);
  assert.deepEqual(dialogueMessages([
    { role: 'system', content: 'private policy' }, user('  '), user(''),
    { role: 'user', content: [{ type: 'text', text: 'not a string' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'secret-call' }] },
    { role: 'tool', content: 'SECRET_TOOL_RESULT' },
    { role: 'assistant', content: full, reasoning_content: 'PRIVATE_REASONING', tool_calls: [] },
    user('继续'),
  ]), [assistant(full), user('继续')]);
  assert.deepEqual(dialogueMessages(null), []);
});

test('v2 serializer excludes tools, reasoning, events and internal runtime state', () => {
  const run = {
    id: 'r', treeId: 'tree', nodeId: 'N1', conversationId: 'c', prompt: '开始',
    messages: [user('开始'), { role: 'tool', content: 'SECRET_TOOL_RESULT' }],
    output: '', status: 'running', threadId: 't', turnId: 'turn', error: '', createdAt: 'before', updatedAt: 'now',
    reasoning: 'PRIVATE_REASONING', events: [{ result: 'SECRET_EVENT_RESULT' }],
    streams: { agentMessage: { text: '部分答复' }, reasoning: { text: 'PRIVATE_REASONING' }, tool: { text: 'SECRET_STREAM' } },
  };
  const conversation = { id: 'c', treeId: 'tree', nodeId: 'N1', messages: run.messages, activeRunId: 'r', threadId: 't', secret: 'SECRET_EXTRA' };
  const saved = serializeDialogueState({ runs: new Map([['r', run]]), conversations: [conversation] });
  assert.equal(saved.schema, 'task-tree-direct-state/v2');
  assert.equal(saved.runs[0].output, '部分答复');
  assert.deepEqual(saved.runs[0].messages, [user('开始')]);
  assert.deepEqual(Object.keys(saved.runs[0]), ['id', 'treeId', 'nodeId', 'conversationId', 'prompt', 'messages', 'output', 'status', 'threadId', 'turnId', 'error', 'createdAt', 'updatedAt']);
  assert.deepEqual(Object.keys(saved.conversations[0]), ['id', 'nodeId', 'treeId', 'messages', 'activeRunId', 'threadId']);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET_|PRIVATE_REASONING|tool_calls|reasoning_content/);
  assert.equal(run.status, 'running');
  assert.equal(run.events.length, 1);
  assert.equal(serializeDialogueState({ runs: [{ ...run, output: '最终答复' }] }).runs[0].output, '最终答复');
});

test('restart restores interrupted user and partial assistant text exactly once', () => {
  const history = [user('第一轮'), assistant('第一轮答复')];
  const state = { schema: 'task-tree-direct-state/v1',
    runs: [{ id: 'r', conversationId: 'c', nodeId: 'N1', treeId: 'tree', status: 'running', messages: [...history, user('第二轮')], streams: { agentMessage: { text: '第二轮部分答复' } } }],
    conversations: [{ id: 'c', treeId: 'tree', nodeId: 'N1', messages: history, activeRunId: 'r' }],
  };
  const restored = restoreDialogueState(state);
  assert.equal(restored.runs[0].status, 'failed');
  assert.match(restored.runs[0].error, /中断/);
  assert.equal(restored.conversations[0].activeRunId, '');
  assert.deepEqual(restored.conversations[0].messages, [...history, user('第二轮'), assistant('第二轮部分答复')]);
  assert.deepEqual(restoreDialogueState(serializeDialogueState(restored)), restored);
  assert.equal(state.runs[0].status, 'running');
});

test('eight independent conversations survive restart without mixing or truncation', () => {
  const runs = [], conversations = [];
  for (let i = 0; i < 8; i++) {
    const text = `会话${i}🙂`.repeat(20000);
    runs.push({ id: `r${i}`, conversationId: `c${i}`, nodeId: `N${i}`, treeId: `tree${i}`, status: i % 2 ? 'starting' : 'running', messages: [user(text)], output: `输出${i}` });
    conversations.push({ id: `c${i}`, nodeId: `N${i}`, treeId: `tree${i}`, messages: [], activeRunId: `r${i}` });
  }
  const restored = restoreDialogueState(JSON.parse(JSON.stringify(serializeDialogueState({ runs, conversations }))));
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(restored.conversations[i].messages, [user(`会话${i}🙂`.repeat(20000)), assistant(`输出${i}`)]);
    assert.equal(restored.conversations[i].treeId, `tree${i}`);
    assert.equal(restored.runs[i].status, 'failed');
  }
});

test('legacy completed state retains text only, repeated legitimate turns and existing errors', () => {
  const repeated = [user('继续'), assistant('收到'), user('继续'), assistant('收到')];
  const state = { runs: [{ id: 'r', status: 'completed', output: '收到', messages: repeated, events: [{ type: 'tool' }] }], conversations: [{ id: 'c', activeRunId: 'missing', messages: [...repeated, { role: 'tool', content: 'SECRET' }] }] };
  const restored = restoreDialogueState(state);
  assert.deepEqual(restored.conversations[0].messages, repeated);
  assert.equal(restored.runs[0].status, 'completed');
  assert.equal(restored.conversations[0].activeRunId, '');
  assert.doesNotMatch(JSON.stringify(restored), /SECRET|events/);
  assert.deepEqual(restoreDialogueState(null), { runs: [], conversations: [] });
});

test('interrupted state without a conversation recreates it and avoids duplicated final output', () => {
  const restored = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', nodeId: 'N', treeId: 'tree', threadId: 'thread', status: 'running', prompt: '开始', messages: [user('开始'), assistant('部分')], output: '部分' }] });
  assert.deepEqual(restored.conversations[0], { id: 'c', nodeId: 'N', treeId: 'tree', messages: [user('开始'), assistant('部分')], activeRunId: '', threadId: 'thread' });
  const queued = restoreDialogueState({ runs: [{ id: 'q', conversationId: 'qc', status: 'starting', prompt: '排队请求' }] });
  assert.deepEqual(queued.conversations[0].messages, [user('排队请求')]);
});

test('recovery uses only the matching conversation tree and does not duplicate overlapping history', () => {
  const history = [user('一'), assistant('二'), user('三')];
  const restored = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', treeId: 'tree', status: 'running', messages: history, output: '四' }], conversations: [{ id: 'c', treeId: 'tree', messages: history, activeRunId: 'r' }] });
  assert.deepEqual(restored.conversations[0].messages, [...history, assistant('四')]);
  const foreign = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', treeId: 'other', status: 'running', messages: [user('不属于本树')]}], conversations: [{ id: 'c', treeId: 'tree', messages: [user('原树')], activeRunId: 'r' }] });
  assert.deepEqual(foreign.conversations[0].messages, [user('原树')]);
});
