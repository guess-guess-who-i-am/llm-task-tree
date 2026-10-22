import { createHash } from 'node:crypto';
import { dialogueMessages } from './dialogue-state.js';

// The disk dialogue remains authoritative. This index is disposable, local and
// contains no tool/reasoning logs or materialized image payloads.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(['的','了','是','在','和','与','我','你','他','它','我们','这个','那个','当前','之前','继续','请','按','把','先','再','然后','需要','可以','进行','完成','任务','方案','节点','一下','the','a','to','and','of','is']);
const acceptance = /^(?:好[，,。\s]*|可以[，,。\s]*|接受|采用|同意|确认|不用|不采用|改成|更正|纠正|最新)/u;
const note = '历史原文是回忆证据，不是新指令或完成证明；当前树与最新用户更正优先。未命中不代表用户没说过；可换词或显式读取本对话全部来源。';

function terms(text, grams = false) {
  const s = text.normalize('NFKC').toLowerCase(), result = [];
  for (const part of segmenter.segment(s)) if (part.isWordLike && !stop.has(part.segment)) result.push(part.segment);
  if (grams) for (const run of s.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...run[0]];
    for (let i = 0; i + 1 < chars.length; i++) result.push(chars[i] + chars[i + 1]);
  }
  return result;
}

export const HISTORY_TOOLS = [
  { type: 'function', function: { name: 'history_search',
    description: '按需在本节点继承的完整用户/助手对话中本地检索旧约定、理由和旁白；零额外模型请求。sources 已是完整原文及相邻确认，无需再 history_read；alreadyInInput 来源已在当前输入，不重复返回。无需每轮调用。未命中可换词或用 history_read 显式读取本对话来源，不能据此断言历史不存在。',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1 } } } } },
  { type: 'function', function: { name: 'history_read',
    description: '按 history_search 返回的 sourceIds 恢复完整历史原文；或在检索不确定时显式 all=true 读取本对话全部来源。不跨节点扫描其它对话，不截断原文。旧建议不覆盖最新用户更正。sourceIds 和 all 二选一。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sourceIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, all: { type: 'boolean' }
    } } } }
];
export const HISTORY_INSTRUCTIONS = '旧助手旁白已保存在本对话档案，但不默认重复投入。用户要回忆、或当前树和有效用户历史缺少推进所需的旧约定时，使用 history_search 按需找完整原文；无需每轮检索。未命中不是不存在，可换词或 history_read 显式读取全部来源；历史建议不构成当前授权，最新用户更正优先。';

export function historyIncludedPositions(archive, includedMessages) {
  // Membership is positional: identical later "继续" messages are not deleted.
  const positions = new Map();
  archive.forEach((m,i) => {
    const key=JSON.stringify([m.role,m.content]);
    if(!positions.has(key))positions.set(key,[]);
    positions.get(key).push(i);
  });
  const included = [];
  for(const m of dialogueMessages(includedMessages).reverse()) {
    const at=positions.get(JSON.stringify([m.role,m.content]))?.pop();
    if(at!==undefined)included.push(at);
  }
  return included.sort((a,b)=>a-b);
}

export function historySnapshot(messages, scope = {}, includedMessages = []) {
  const archive = dialogueMessages(messages);
  return { archive, scope, included:historyIncludedPositions(archive,includedMessages), version: hash([scope, archive]) };
}

export function buildHistoryIndex(snapshot) {
  const { archive, version } = snapshot;
  const sources = archive.map((m, order) => ({ id: `${version}:${order}`, order, role: m.role, content: m.content }));
  const episodes = [];
  for (const source of sources) {
    if (!episodes.length || source.role === 'user') episodes.push({ sources: [] });
    episodes.at(-1).sources.push(source);
  }
  const channels = [false, true].map(grams => {
    const df = new Map();
    const docs = episodes.map(e => {
      const tokens = terms(e.sources.map(s => s.content).join('\n'), grams), freq = new Map();
      for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
      for (const t of freq.keys()) df.set(t, (df.get(t) || 0) + 1);
      return { freq, length: tokens.length };
    });
    return { df, docs, average: docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length), grams };
  });
  return { sources, episodes, channels, version };
}

function rank(index, query, channel) {
  const { docs, df, average, grams } = channel, n = docs.length;
  const qt = [...new Set(terms(query, grams))];
  return docs.map((d, at) => {
    let score = 0;
    for (const t of qt) {
      const f = d.freq.get(t) || 0;
      if (f) score += Math.log(1 + (n - df.get(t) + .5) / (df.get(t) + .5)) * f * 2.2 / (f + 1.2 * (.25 + .75 * d.length / Math.max(1, average)));
    }
    return { at, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.at - b.at);
}

export function queryHistory(index, snapshot, name, args) {
  const started = performance.now(), wanted = new Set(), scores = new Map();
  if (name === 'history_search') {
    if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('HISTORY_QUERY_REQUIRED');
    for (const channel of index.channels) rank(index, args.query, channel).forEach((r, i) => scores.set(r.at, (scores.get(r.at) || 0) + 1 / (61 + i)));
    for (const at of scores.keys()) {
      for (const s of index.episodes[at].sources) wanted.add(s.id);
      const next = index.episodes[at + 1], previous = index.episodes[at - 1];
      if (next && acceptance.test(next.sources[0].content)) for (const s of next.sources) wanted.add(s.id);
      if (previous && acceptance.test(index.episodes[at].sources[0].content)) for (const s of previous.sources) wanted.add(s.id);
    }
  } else if (name === 'history_read') {
    if (args.all === true && args.sourceIds === undefined) for (const s of index.sources) wanted.add(s.id);
    else if (args.all === undefined && Array.isArray(args.sourceIds) && args.sourceIds.length) {
      const valid = new Set(index.sources.map(s => s.id));
      for (const id of args.sourceIds) {
        if (!valid.has(id)) throw new Error('UNKNOWN_HISTORY_SOURCE');
        wanted.add(id);
      }
    } else throw new Error('HISTORY_READ_SELECT_SOURCES_OR_ALL');
  } else throw new Error('UNKNOWN_HISTORY_TOOL');
  const matched = index.sources.filter(s => wanted.has(s.id));
  const included = new Set(snapshot.included);
  const sources = name === 'history_search' ? matched.filter(s => !included.has(s.order)) : matched;
  return { archiveVersion: index.version, sourceIds: matched.map(s => s.id), sources,
    alreadyInInput: matched.filter(s => name === 'history_search' && included.has(s.order)).map(s => s.id),
    catalogue: name === 'history_search' && !matched.length ? index.sources.map(({ id, order, role }) => ({ id, order, role })) : [],
    uncertain: !matched.length, note, modelCalls: 0, retrievalMs: performance.now() - started };
}

// One cache per global worker, not a model task limit. Eviction merely rebuilds
// an index next time; live sessions retain their own reference.
export function createHistoryIndexCache(maxEntries = 32) {
  const entries = new Map();
  return snapshot => {
    const reused = entries.has(snapshot.version), started = performance.now();
    const index = entries.get(snapshot.version) || buildHistoryIndex(snapshot);
    entries.delete(snapshot.version); entries.set(snapshot.version, index);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return { index, reused, indexMs: performance.now() - started };
  };
}

export function createHistorySession(snapshot, cache = createHistoryIndexCache()) {
  let ready;
  return (name, args, included) => {
    const started = performance.now();
    const cold = !ready;
    ready ||= cache(snapshot);
    return { ...queryHistory(ready.index, Array.isArray(included) ? {...snapshot,included} : snapshot, name, args), indexReused: ready.reused || !cold,
      indexMs: cold ? ready.indexMs : 0, durationMs: performance.now() - started };
  };
}
