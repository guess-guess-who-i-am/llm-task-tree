import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekContext, estimateContextTokens } from './deepseek-context.js';

const history = () => Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}：` + '历史正文'.repeat(450) }));

test('short context is unchanged and makes no summary request', async () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }];
  const context = createDeepSeekContext({ summarize: () => { throw new Error('unexpected'); } });
  assert.deepEqual(await context.prepare(messages), messages);
});

test('summary preserves current request, instructions and complete latest tool group; never mutates history', async () => {
  const current = { role: 'user', content: '最新要求：不要删节点，改用中文' };
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] };
  const tools = ['a', 'b'].map(id => ({ role: 'tool', tool_call_id: id, content: `已保存${id}` }));
  const messages = [{ role: 'system', content: '全局规则' }, ...history(), current, assistant, ...tools, { role: 'system', content: '本轮规则' }];
  const original = JSON.stringify(messages), batches = [];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current], summarize: async (batch, previous) => { batches.push(batch); return `${previous ? '继承先前状态；' : ''}目标：展开子树；已完成：读树；待办：保存；旧用户要求服从最新原话。`; } });
  const compacted = await context.prepare(messages, { initial: true });
  assert.ok(batches.length > 0);
  for (const message of [messages[0], current, assistant, ...tools, messages.at(-1)]) assert.ok(compacted.includes(message));
  assert.ok(compacted.some(m => m.content?.includes('历史上下文摘要')));
  assert.equal(JSON.stringify(messages), original);
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(messages));
  assert.ok(context.cache.sourceCount > 0);
});

test('large messages are fully consumed across chunks, including their final characters', async () => {
  const huge = '开头' + '甲乙丙🙂'.repeat(12000) + '最后的约束';
  const messages = [{ role: 'user', content: huge }, ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: '短消息' })), { role: 'user', content: '当前问题' }];
  const seen = [];
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async batch => { seen.push(batch); return '保留约束的摘要'; } });
  await context.prepare(messages, { initial: true });
  assert.ok(seen.length > 1);
  assert.ok(seen.join('').includes('最后的约束'));
  assert.ok(seen.every(s => !/[\ud800-\udbff]$/.test(s)), 'do not split Unicode surrogate pairs');
  assert.equal(seen.join('').split('甲乙丙🙂').length - 1, 12000, 'every character reaches the summarizer');
});

test('saved summary is reusable after restart, but an edited history invalidates it', async () => {
  const messages = [...history(), { role: 'user', content: '当前问题' }];
  const first = createDeepSeekContext({ windowTokens: 8192, summarize: async () => '目标与状态摘要' });
  await first.prepare(messages, { initial: true });
  const second = createDeepSeekContext({ windowTokens: 8192, cache: first.cache, summarize: () => { throw new Error('cache must be reused'); } });
  assert.ok((await second.prepare(messages, { initial: true })).some(m => m.content?.includes('目标与状态摘要')));
  let requests = 0;
  const edited = messages.map((m, i) => i === 0 ? { ...m, content: '编辑后的新要求' + m.content } : m);
  const third = createDeepSeekContext({ windowTokens: 8192, cache: first.cache, summarize: async () => { requests++; return '新的摘要'; } });
  await third.prepare(edited, { initial: true });
  assert.ok(requests > 0);
});

test('failed compaction and oversized current request do not discard or silently truncate messages', async () => {
  const messages = [...history(), { role: 'user', content: '当前问题' }], original = JSON.stringify(messages);
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async () => { throw new Error('502'); } });
  await assert.rejects(context.prepare(messages), /502/);
  assert.equal(JSON.stringify(messages), original);
  const current = { role: 'user', content: '最新要求'.repeat(20000) };
  const pinned = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current], summarize: async () => '摘要' });
  await assert.rejects(pinned.prepare([current]), /当前请求|上下文/);
});

test('images count as vision inputs, not millions of textual Base64 tokens', () => {
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'a'.repeat(1000000) } }] }];
  assert.ok(estimateContextTokens(messages) < 10000);
});
