import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviseUserMessage, dialogueSnapshot, dialogueMarkdown, exportDialogueToDesktop } from './dialogue-actions.js';
import { dialogueMessages } from './dialogue-state.js';

test('editing keeps the prefix and original attachments, replaces later turns, and never mutates the old record', () => {
  const history = [{ role: 'user', content: '第一轮' }, { role: 'assistant', content: '回答' },
    { role: 'user', content: '旧要求', attachments: [{ id: 'original', name: '原图' }] }, { role: 'assistant', content: '旧回答' }];
  assert.deepEqual(reviseUserMessage(history, 2, '新要求'), dialogueMessages([...history.slice(0, 2), { ...history[2], content: '新要求' }]));
  assert.equal(history[2].content, '旧要求');
  assert.equal(reviseUserMessage(history, 0, '从头重发').length, 1);
  for (const index of [-1, 1, 4, '0', 0.5]) assert.throws(() => reviseUserMessage(history, index, '新'), { status: 400 });
  assert.throws(() => reviseUserMessage(history, 0, '  '), { status: 400 });
});

test('export snapshots include live text once, never tool logs or reasoning', () => {
  const conversation = { messages: [{ role: 'user', content: '任务' }] };
  const live = { status: 'stopping', streams: { agentMessage: { text: '部分输出' } }, reasoning: '思考', events: [{ text: '工具输出' }] };
  const messages = dialogueSnapshot(conversation, live);
  assert.equal(messages.length, 2);
  const markdown = dialogueMarkdown({ nodeId: 'N1', treeId: 'a', status: live.status, messages });
  assert.match(markdown, /部分输出/); assert.doesNotMatch(markdown, /思考|工具输出/);
  assert.deepEqual(dialogueSnapshot({ messages }, { ...live, status: 'stopped' }), messages);
});

test('desktop export preserves long Unicode text, uses unique safe filenames and does not overwrite', async () => {
  const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'dialogue-export-test-'));
  try {
    const details = { nodeId: '../ROOT', treeId: '中文树', title: '中文标题', status: 'completed', baseUrl: 'http://localhost:9999',
      messages: [{ role: 'user', content: '完整正文'.repeat(20000), attachments: [{ name: '原图.png', url: '/api/chat/attachments/image?nodeId=ROOT' }] }, { role: 'assistant', content: '最后一句' }] };
    const a = await exportDialogueToDesktop(details, { desktopDir }), b = await exportDialogueToDesktop(details, { desktopDir });
    assert.equal(path.dirname(a), desktopDir); assert.notEqual(a, b);
    assert.equal(await readFile(a, 'utf8'), dialogueMarkdown(details));
    assert.match(await readFile(a, 'utf8'), /http:\/\/localhost:9999\/api\/chat\/attachments/);
  } finally { await rm(desktopDir, { recursive: true }); }
});
