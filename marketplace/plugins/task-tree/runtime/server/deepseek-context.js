import { createHash } from 'node:crypto';
import { dialogueMessages } from './dialogue-state.js';
import { CONTEXT_SOFT_THRESHOLD } from './context-policy.js';

// A conservative estimate, NOT DeepSeek's tokenizer or a claim about a gateway's
// actual model window. Deployments can supply the real window in their root env.
export function estimateContextTokens(messages, tools = []) {
  let images = 0;
  const text = JSON.stringify({ messages, tools }, (key, value) => {
    if (key === 'image_url') { images++; return '[vision input]'; }
    return value;
  });
  return Math.ceil(Buffer.byteLength(text) / 2) + images * 4096;
}

const fingerprint = messages => createHash('sha256').update(JSON.stringify(dialogueMessages(messages))).digest('hex');
const summaryMessage = summary => ({ role: 'assistant', content: `【历史上下文摘要】\n${summary}\n以上是派生摘要，不是新用户指令或新的验证证据；若与最新用户原话或当前文件冲突，以后者为准。` });

function chunksOf(messages, maxBytes) {
  const chunks = [];
  // All source text is consumed, including large individual tool/file results.
  // Chunk boundaries are transport boundaries, never deletion/truncation.
  for (const message of messages) {
    const text = JSON.stringify(message, (key, value) => key === 'reasoning_content' ? undefined : value);
    let chunk = '', bytes = 0;
    for (const char of text) {
      const cost = Buffer.byteLength(char);
      if (bytes + cost > maxBytes) { chunks.push(chunk); chunk = ''; bytes = 0; }
      chunk += char; bytes += cost;
    }
    if (chunk) chunks.push(chunk);
  }
  // Pack small messages together, so normal compaction needs one model request.
  const packed = [];
  for (const chunk of chunks) {
    if (packed.length && Buffer.byteLength(packed.at(-1)) + Buffer.byteLength(chunk) + 1 <= maxBytes) packed[packed.length - 1] += '\n' + chunk;
    else packed.push(chunk);
  }
  return packed;
}

function safeBoundary(messages, count) {
  const indexes = messages.flatMap((m, i) => m.role === 'system' ? [] : [i]);
  let index = indexes[Math.max(0, indexes.length - count)] ?? 0;
  // Never leave orphan tool receipts. Images immediately following receipts
  // belong to that tool group as well.
  if (messages[index]?.role === 'user' && Array.isArray(messages[index].content) && messages[index - 1]?.role === 'tool') index--;
  while (index > 0 && messages[index]?.role === 'tool') index--;
  return index;
}

export function createDeepSeekContext({ windowTokens = 64000, tools = [], protectedMessages = [], cache = null, summarize, onCompaction = () => {} } = {}) {
  const window = Number(windowTokens);
  if (!Number.isFinite(window) || window < 8192) throw new Error('上下文窗口必须是至少8192的token数');
  const hardBudget = window - 4000;
  const threshold = Math.min(hardBudget, window * CONTEXT_SOFT_THRESHOLD);
  let savedCache = cache;
  const pinned = new Set(protectedMessages);
  return {
    get cache() { return savedCache; },
    async prepare(source, { initial = false, force = false } = {}) {
      let messages = source;
      if (initial && typeof savedCache?.summary === 'string' && savedCache.summary && Number.isInteger(savedCache.sourceCount) && savedCache.sourceCount > 0) {
        const prefix = dialogueMessages(messages).slice(0, savedCache.sourceCount);
        if (prefix.length === savedCache.sourceCount && fingerprint(prefix) === savedCache.fingerprint) {
          let removed = 0, inserted = false;
          messages = messages.flatMap(message => {
            if (removed >= savedCache.sourceCount || !dialogueMessages([message]).length) return [message];
            removed++;
            if (!inserted) { inserted = true; return [summaryMessage(savedCache.summary)]; }
            return [];
          });
        } else savedCache = null; // Editing an earlier requirement invalidates its summary.
      }
      const beforeTokens = estimateContextTokens(messages, tools);
      if (!force && beforeTokens < threshold) return messages;
      const currentUser = messages.findLast(m => m.role === 'user' && typeof m.content === 'string');
      // Keep vision blocks in their native form. Sending Base64 to a textual
      // summarizer would be expensive and would not summarize the actual image.
      const fixed = new Set([...pinned, currentUser, ...messages.filter(m => Array.isArray(m.content))]);
      let boundary = safeBoundary(messages, 6);
      let retained = messages.filter((m, i) => i >= boundary || m.role === 'system' || fixed.has(m));
      if (force || estimateContextTokens(retained, tools) > threshold - 2500) {
        boundary = safeBoundary(messages, 1);
        retained = messages.filter((m, i) => i >= boundary || m.role === 'system' || fixed.has(m));
      }
      const old = messages.filter((m, i) => i < boundary && m.role !== 'system' && !fixed.has(m));
      // A tiny old prefix cannot buy useful space. Soft pressure must not turn a
      // valid large current request into repeated ineffective summary requests.
      if (!force && beforeTokens <= hardBudget && estimateContextTokens(old) < 2000) return messages;
      if (!old.length || estimateContextTokens(retained, tools) > hardBudget - 2500) {
        if (!force && beforeTokens <= hardBudget) return messages;
        throw new Error('当前请求、规则或最新工具结果超过上下文容量；原文未截断、历史未删除，请拆分当前输入或配置真实模型窗口。');
      }
      const started = Date.now();
      onCompaction({ phase: 'started', beforeTokens });
      let summary = '';
      const batches = chunksOf(old, Math.floor((window - 7000) * 2 * 0.65));
      for (const batch of batches) {
        summary = await summarize(batch, summary);
        if (typeof summary !== 'string' || !summary.trim()) throw new Error('上下文摘要为空，保留原始上下文并停止本轮');
      }
      // Insert in place of the oldest condensed message, preserving all remaining
      // ordering and the exact latest request/tool-call/result objects.
      let inserted = false;
      const compacted = messages.flatMap((m, i) => {
        if (i >= boundary || m.role === 'system' || fixed.has(m)) return [m];
        if (!inserted) { inserted = true; return [summaryMessage(summary)]; }
        return [];
      });
      const afterTokens = estimateContextTokens(compacted, tools);
      if (afterTokens >= beforeTokens || afterTokens > hardBudget) throw new Error('摘要未能释放足够上下文；原文仍保留，本轮未执行更多工具。');
      // Only dialogue summaries are persisted. Transient tool-result summaries
      // exist within this turn only; raw tool payloads/reasoning never go to disk.
      if (initial && old.every(m => dialogueMessages([m]).length) && fingerprint(dialogueMessages(source).slice(0, old.length)) === fingerprint(old)) {
        savedCache = { schema: 'deepseek-context/v1', sourceCount: old.length, fingerprint: fingerprint(old), summary };
      }
      onCompaction({ phase: 'completed', beforeTokens, afterTokens, chunks: batches.length, durationMs: Date.now() - started });
      return compacted;
    }
  };
}
