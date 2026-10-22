// Model input projection only. Never mutate the durable/exported dialogue.
// Semantic natural-language supersession is deliberately not guessed.
export const ACTIVE_HISTORY_POLICY = 'tree-user-history/v1';

function configBlocks(text) {
  const blocks = [];
  const marker = /(?:配置完整JSON|最新更正)[：:]\s*/g;
  for (const match of text.matchAll(marker)) {
    const start = match.index + match[0].length;
    if (text[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, end + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) blocks.push({ start, end: end + 1, value });
        } catch { /* Invalid source is retained verbatim, not repaired. */ }
        break;
      }
    }
  }
  return blocks;
}

export function projectActiveUserHistory(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const lastUser = source.findLastIndex(m => m.role === 'user');
  // Keep the most recent reply for referential requests such as "use option 2".
  const recentReply = source.findLastIndex((m, i) => i < lastUser && m.role === 'assistant');
  const replacements = new Map(), records = new Map();
  for (let i = 0; i < source.length; i++) {
    const message = source[i];
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const blocks = configBlocks(message.content);
    records.set(i, blocks);
    for (const block of blocks) for (const key of Object.keys(block.value)) replacements.set(key, block);
  }
  const projected = source.flatMap((message, i) => {
    // Tool-call groups are current protocol, not historical narration.
    if (message.role === 'assistant' && !message.tool_calls?.length && i !== recentReply && i < lastUser) return [];
    let content = message.content;
    for (const block of (records.get(i) || []).toReversed()) {
      const entries = Object.entries(block.value).filter(([key]) => replacements.get(key) === block);
      if (entries.length !== Object.keys(block.value).length) {
        content = content.slice(0, block.start) + (entries.length ? JSON.stringify(Object.fromEntries(entries)) : '') + content.slice(block.end);
      }
    }
    return content === message.content ? [message] : [{ ...message, content }];
  });
  return { messages: projected, stats: { policy: ACTIVE_HISTORY_POLICY, sourceMessages: source.length,
    projectedMessages: projected.length, sourceBytes: Buffer.byteLength(JSON.stringify(source)),
    projectedBytes: Buffer.byteLength(JSON.stringify(projected)) } };
}
