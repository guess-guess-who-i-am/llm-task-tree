import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadThreadDialogue, saveThreadDialogue, archiveThreadDialogue } from './thread-dialogue-store.js';

const newThread = () => `deepseek-${randomUUID()}`;

test('deletion clears live lookup and keeps a recoverable full text archive', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-delete-'));
  const threadId = newThread();
  const messages = [{ role: 'user', content: '完整历史' }];
  await saveThreadDialogue({ codexHome, threadId, messages });
  await archiveThreadDialogue({ codexHome, threadId });
  assert.deepEqual(await loadThreadDialogue({ codexHome, threadId }), []);
  const folder = path.join(codexHome, 'task-tree-dialogues', 'deleted');
  const files = await readdir(folder);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, files[0]), 'utf8')).messages, messages);
});

test('rejects invalid ids before any path access', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-id-'));
  for (const threadId of ['../outside', '../../x', '/tmp/a', 'deepseek-../x', 'deepseek-short', '', null, 'deepseek-00000000-0000-0000-0000-000000000000/../x']) {
    await assert.rejects(loadThreadDialogue({ codexHome, threadId }), /threadId/);
    await assert.rejects(saveThreadDialogue({ codexHome, threadId, messages: [] }), /threadId/);
  }
  assert.deepEqual(await readdir(codexHome), []);
  assert.deepEqual(await loadThreadDialogue({ codexHome, threadId: newThread() }), []);
});

test('stores full dialogue text only with private permissions and cwd metadata', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-text-'));
  const threadId = newThread();
  const text = '原文🙂\n'.repeat(100000);
  const messages = [{ role: 'user', content: text }, { role: 'assistant', content: '回答', reasoning_content: 'SECRET_REASONING', tool_calls: [{ id: 'secret' }] }, { role: 'tool', content: 'SECRET_RESULT' }, { role: 'system', content: 'SECRET_SYSTEM' }];
  await saveThreadDialogue({ codexHome, threadId, cwd: '/project/甲', messages });
  assert.deepEqual(await loadThreadDialogue({ codexHome, threadId }), [{ role: 'user', content: text }, { role: 'assistant', content: '回答' }]);
  const folder = path.join(codexHome, 'task-tree-dialogues');
  const file = path.join(folder, `${threadId}.json`);
  const serialized = await readFile(file, 'utf8');
  assert.doesNotMatch(serialized, /SECRET|tool_calls|reasoning_content/);
  assert.equal(JSON.parse(serialized).cwd, '/project/甲');
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(folder), [`${threadId}.json`]);
});

test('eight thread files write concurrently without context mixing', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-parallel-'));
  const ids = Array.from({ length: 8 }, newThread);
  await Promise.all(ids.map((threadId, i) => saveThreadDialogue({ codexHome, threadId, cwd: `/project/${i}`, messages: [{ role: 'user', content: `线程${i}` }] })));
  const messages = await Promise.all(ids.map(threadId => loadThreadDialogue({ codexHome, threadId })));
  assert.deepEqual(messages, ids.map((_, i) => [{ role: 'user', content: `线程${i}` }]));
});

test('same-file concurrent calls preserve write order and create independent snapshots', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-order-'));
  const threadId = newThread();
  const firstMessages = [{ role: 'user', content: 'first' }];
  const first = saveThreadDialogue({ codexHome, threadId, messages: firstMessages });
  firstMessages[0].content = 'MUTATION_MUST_NOT_LEAK';
  await Promise.all([first, ...Array.from({ length: 20 }, (_, i) => saveThreadDialogue({ codexHome, threadId, messages: [{ role: 'user', content: `${i}` }] }))]);
  assert.deepEqual(await loadThreadDialogue({ codexHome, threadId }), [{ role: 'user', content: '19' }]);
  assert.equal((await readdir(path.join(codexHome, 'task-tree-dialogues'))).length, 1);
});

test('fresh module instance restores from real disk rather than process memory', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'thread-dialogue-restart-'));
  const threadId = newThread();
  const messages = [{ role: 'user', content: '关机前的问题' }, { role: 'assistant', content: '关机前的答案' }];
  await saveThreadDialogue({ codexHome, threadId, messages });
  const restarted = await import(`./thread-dialogue-store.js?restart=${randomUUID()}`);
  assert.deepEqual(await restarted.loadThreadDialogue({ codexHome, threadId }), messages);
});
