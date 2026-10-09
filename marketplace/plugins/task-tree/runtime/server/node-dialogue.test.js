import test from 'node:test';
import assert from 'node:assert/strict';
import { latestNodeRuns, nodeConversationId, normalizeNodeDialogues, serializeDialogueState } from './dialogue-state.js';

test('one latest run per tree/node, not updatedAt or thread identity', () => {
  const runs = [
    { id: 'old', treeId: 'a', nodeId: 'N1', createdAt: '1', updatedAt: '9' },
    { id: 'new', treeId: 'a', nodeId: 'N1', createdAt: '2' },
    { id: 'other', treeId: 'b', nodeId: 'N1', createdAt: '1' },
  ];
  assert.deepEqual(latestNodeRuns(runs).map(r => r.id), ['new', 'other']);
  assert.notEqual(nodeConversationId('a', 'N1'), nodeConversationId('b', 'N1'));
  assert.notEqual(nodeConversationId('a:b', 'c'), nodeConversationId('a', 'b:c'));
  assert.throws(() => nodeConversationId('', 'N1'));
});

test('latest node dialogue keeps full multi-turn text and selects, not joins, independent threads', () => {
  const messages = [{ role: 'user', content: '继续' }, { role: 'assistant', content: '全文'.repeat(20000) }, { role: 'user', content: '继续' }, { role: 'assistant', content: '答复' }];
  const state = { runs: [
    { id: 'old', treeId: 'a', nodeId: 'N1', conversationId: 'old-thread', createdAt: '1', status: 'completed', output: '旧独立话题' },
    { id: 'new', treeId: 'a', nodeId: 'N1', conversationId: 'new-thread', createdAt: '2', status: 'completed', output: '答复' },
  ], conversations: [{ id: 'new-thread', treeId: 'a', nodeId: 'N1', messages, threadId: 'thread' }] };
  const normalized = normalizeNodeDialogues(state);
  assert.equal(normalized.runs.length, 1);
  assert.equal(normalized.conversations.length, 1);
  assert.deepEqual(normalized.conversations[0].messages, messages);
  assert.equal(normalized.conversations[0].id, nodeConversationId('a', 'N1'));
  assert.deepEqual(normalizeNodeDialogues(serializeDialogueState(normalized)), normalized);
});

test('interrupted latest turn recovers partial output once; another tree never mixes', () => {
  const state = { runs: [
    { id: 'a', treeId: 'a', nodeId: 'ROOT', conversationId: 'ROOT', status: 'running', prompt: '甲', output: '部分' },
    { id: 'b', treeId: 'b', nodeId: 'ROOT', conversationId: 'ROOT', status: 'completed', messages: [{ role: 'user', content: '乙' }], output: '乙答' },
  ], conversations: [{ id: 'ROOT', treeId: 'a', nodeId: 'ROOT', messages: [{ role: 'user', content: '甲' }] }] };
  const normalized = normalizeNodeDialogues(state);
  assert.deepEqual(normalized.conversations[0].messages, [{ role: 'user', content: '甲' }, { role: 'assistant', content: '部分' }]);
  assert.deepEqual(normalized.conversations[1].messages, [{ role: 'user', content: '乙' }, { role: 'assistant', content: '乙答' }]);
});

test('old single-tree records without a tree ID are visible under the method tree', () => {
  const normalized = normalizeNodeDialogues({ runs: [
    { id: 'old', nodeId: 'N12', createdAt: '1', status: 'completed', output: '旧轮' },
    { id: 'new', nodeId: 'N12', createdAt: '2', status: 'completed', prompt: '新轮', messages: [{ role: 'user', content: '新轮' }], output: '新答' },
  ] }, { defaultTreeId: 'method' });
  assert.equal(normalized.runs.length, 1);
  assert.equal(normalized.runs[0].id, 'new');
  assert.equal(normalized.runs[0].treeId, 'method');
  assert.equal(normalized.conversations[0].id, nodeConversationId('method', 'N12'));
});
