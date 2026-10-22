import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dialogueMessages } from './dialogue-state.js';
import { contextLimitDetails } from './model-context-error.js';

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
const transientStrategyMessage = message => message?.role === 'system'
  && /^【(?:并行机会提示|首次执行方式选择)/.test(String(message.content || ''));
const accountingMessages = messages => messages.filter(message => !transientStrategyMessage(message));
const strategyTokenEstimate = messages => estimateContextTokens(messages.filter(transientStrategyMessage));

// Split transport text only, never discard source or cut a UTF-8 code point.
function splitSummaryInput(text) {
  const middle = Math.floor(Buffer.byteLength(text) / 2);
  let offset = 0, bytes = 0;
  for (const char of text) {
    if (bytes >= middle && offset) break;
    bytes += Buffer.byteLength(char); offset += char.length;
  }
  return [text.slice(0, offset), text.slice(offset)];
}

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

function completedReceipts(messages) {
  const complete = new Set();
  let ids = new Set(), receipts = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      ids = new Set(message.tool_calls.map(call => call.id)); receipts = [];
    } else if (message.role === 'tool' && ids.has(message.tool_call_id)) {
      receipts.push(message); ids.delete(message.tool_call_id);
      if (!ids.size) for (const receipt of receipts) complete.add(receipt);
    } else { ids = new Set(); receipts = []; }
  }
  return complete;
}

export function createDeepSeekContext({ windowTokens = 270000, compactionThresholdTokens, tools = [], protectedMessages = [], cache = null, getArchive, getAccountingKey = () => '', summarize, signal, onCompaction = () => {}, summaryRetryLimit = 8 } = {}) {
  const window = Number(windowTokens);
  if (!Number.isFinite(window) || window < 8192) throw new Error('上下文窗口必须是至少8192的token数');
  const hardBudget = window - 4000;
  const threshold = compactionThresholdTokens === undefined
    ? Math.min(200000, hardBudget)
    : Number(compactionThresholdTokens);
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > hardBudget) {
    throw new Error('上下文压缩阈值必须是正整数，并且不能超过上下文窗口扣除回复预留后的容量');
  }
  let savedCache = cache;
  let deferredAtEstimate = null;
  const pinned = new Set(protectedMessages);
  const memories = new WeakMap();
  const positions = new WeakMap();
  // Tool originals live only with this running model view, never in the durable
  // text-dialogue cache. Replacing a receipt does not mutate or replay its call.
  const receiptOriginals = new WeakMap();
  let lastWarning = '';
  let archive = [];
  let acceptedInput = null;
  // A compatible gateway can accept more than the configured fallback window.
  // Do not recondense every tiny receipt against an already irreducible floor.
  // This is a bounded, local growth allowance, not a learned model window. It
  // never ratchets forward on successive usage observations or skips recovery.
  let acceptedPressure = null;
  const growthRoom = Math.min(8000, Math.floor(window / 8));
  const pressureKey = messages => createHash('sha256').update(JSON.stringify([
    { key: getAccountingKey(), tools },
    ...accountingMessages(messages).filter(m => m.role === 'system').map(m => JSON.stringify(m)).sort(),
    ...messages.filter(m => pinned.has(m) || Array.isArray(m.content)),
    messages.findLast(m => m.role === 'user' && typeof m.content === 'string')
  ])).digest('hex');
  const resetGrowthRoom = messages => {
    if (acceptedPressure?.key === pressureKey(messages)) {
      acceptedPressure.limit = estimateContextTokens(messages, tools) + growthRoom;
    }
  };
  const inputTokens = messages => {
    const estimate = estimateContextTokens(messages, tools);
    const accountingView = accountingMessages(messages);
    // Only an exact, unchanged accepted prefix earns credit. New data always
    // pays the full conservative estimate; no model-wide byte/token ratio is
    // applied to unseen text. Transient execution-strategy notices are moved
    // between turns, so exclude them from prefix identity but count the current
    // notice at its full estimate. Replacement/compaction falls back to estimation.
    if (!acceptedInput || acceptedInput.key !== getAccountingKey()
      || acceptedInput.tools !== JSON.stringify(tools) || accountingView.length < acceptedInput.messages.length
      || !acceptedInput.messages.every((text, i) => text === JSON.stringify(accountingView[i]))) return estimate;
    const accountingEstimate = estimateContextTokens(accountingView, tools);
    return Math.max(0, acceptedInput.tokens + accountingEstimate - acceptedInput.estimate + strategyTokenEstimate(messages));
  };
  return {
    get cache() { return savedCache; },
    measure(messages) {
      const rawEstimateTokens = estimateContextTokens(messages, tools);
      const estimatedInputTokens = inputTokens(messages);
      return { rawEstimateTokens, estimatedInputTokens, windowTokens: window, compactionThresholdTokens: threshold, responseReserveTokens: 4000,
        basis: rawEstimateTokens === estimatedInputTokens ? 'local-estimate' : 'accepted-usage-plus-estimated-delta' };
    },
    observeUsage(messages, requestTools, usage, { conversationMessages } = {}) {
      const tokens = usage?.inputTokens;
      // Zero/missing usage is common on compatible gateways; it is not evidence
      // that the input costs zero and must not erase the last valid baseline.
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      let baseline = messages, baselineTools = requestTools, extraToolTokens = 0;
      if (conversationMessages !== undefined) {
        // The caller must identify the exact durable model view. Only explicit
        // trailing system strategy instructions may be absent next round. Their
        // accepted cost is NOT subtracted: usage is for the whole real request.
        if (!Array.isArray(conversationMessages) || conversationMessages.length > messages.length
          || !conversationMessages.every((message, i) => JSON.stringify(message) === JSON.stringify(messages[i]))
          || !messages.slice(conversationMessages.length).every(message => message.role === 'system')) return;
        baseline = conversationMessages;
        baselineTools = tools;
        const sent = requestTools.map(tool => JSON.stringify(tool));
        const missing = tools.filter(tool => {
          const index = sent.indexOf(JSON.stringify(tool));
          if (index < 0) return true;
          sent.splice(index, 1); return false;
        });
        // A strategy may send only a subset. Charge every unseen definition at
        // its full local estimate; never apply a learned byte/token discount to
        // new tools or assume the temporary strategy's tokens were free.
        extraToolTokens = estimateContextTokens([], missing) - estimateContextTokens([], []);
      }
      const normalizedBaseline = accountingMessages(baseline);
      acceptedInput = { key: getAccountingKey(),
        tokens: Math.max(0, tokens + extraToolTokens - strategyTokenEstimate(baseline)),
        tools: JSON.stringify(baselineTools),
        messages: normalizedBaseline.map(message => JSON.stringify(message)),
        estimate: estimateContextTokens(normalizedBaseline, baselineTools) };
      const key = pressureKey(baseline);
      if (acceptedPressure?.key !== key) acceptedPressure = null;
      if (tokens > hardBudget && !acceptedPressure) {
        acceptedPressure = { key, limit: estimateContextTokens(baseline, tools) + growthRoom };
      }
    },
    async prepare(source, { initial = false, force = false, handoff = false } = {}) {
      signal?.throwIfAborted();
      if (force) { acceptedInput = null; acceptedPressure = null; } // A real rejection overrides earlier usage.
      let messages = source;
      // The archive and model projection can differ (attachments, tool turns).
      // Match the exact ordered dialogue, never count ephemeral tool receipts as
      // archived turns and never infer coverage from the length of model input.
      if (getArchive) archive = dialogueMessages(getArchive());
      else if (initial || !archive.length) archive = dialogueMessages(source.filter(m => !memories.has(m)));
      else {
        const fresh = source.filter(m => !memories.has(m) && !positions.has(m));
        archive.push(...dialogueMessages(fresh));
      }
      if(initial && savedCache){
        const indexes=savedCache.coveredIndexes;
        const coverageValid=indexes===undefined? savedCache.schema!=='deepseek-context/v2'
          :Array.isArray(indexes) && indexes.length>0 && indexes.every((n,i)=>Number.isInteger(n)&&n>=0&&n<savedCache.sourceCount&&(i===0||indexes[i-1]<n));
        if(typeof savedCache.summary!=='string'||!savedCache.summary.trim()||!Number.isInteger(savedCache.sourceCount)
          ||savedCache.sourceCount<=0||savedCache.sourceCount>archive.length||typeof savedCache.fingerprint!=='string'||!coverageValid)savedCache=null;
      }
      if (initial && savedCache) {
        const prefix = archive.slice(0, savedCache.sourceCount);
        const projectedPrefix = dialogueMessages(source).slice(0, savedCache.sourceCount);
        if (prefix.length === savedCache.sourceCount && fingerprint(prefix) === savedCache.fingerprint
          && projectedPrefix.length === prefix.length && fingerprint(projectedPrefix) === fingerprint(prefix)) {
          let removed = 0, inserted = false;
          const covered = new Set(savedCache.coveredIndexes || Array.from({ length: savedCache.sourceCount }, (_, i) => i));
          messages = messages.flatMap(message => {
            if (removed >= savedCache.sourceCount || !dialogueMessages([message]).length) return [message];
            if (!covered.has(removed++)) return [message];
            if (!inserted) {
              inserted = true;
              const memory = summaryMessage(savedCache.summary);
              memories.set(memory, { summary: savedCache.summary, sourceCount: savedCache.sourceCount, coveredIndexes: [...covered] });
              return [memory];
            }
            return [];
          });
        } else savedCache = null; // Editing an earlier requirement invalidates its summary.
      }
      let cursor = 0;
      const knownCovered = new Set(savedCache?.coveredIndexes || []);
      for (const message of messages) {
        const memory = memories.get(message);
        if (memory) { for (const i of memory.coveredIndexes || []) knownCovered.add(i); continue; }
        if (!dialogueMessages([message]).length) continue;
        while (knownCovered.has(cursor)) cursor++;
        if (cursor < archive.length && fingerprint([message]) === fingerprint([archive[cursor]])) positions.set(message, ++cursor);
      }
      const beforeTokens = inputTokens(messages);
      const beforeEstimateTokens = estimateContextTokens(messages, tools);
      if (acceptedPressure?.key !== pressureKey(messages)) acceptedPressure = null;
      // Usage-based calibration may forgive a conservative-estimate false alarm,
      // but it must never suppress the configured compaction threshold.
      if (!force && !handoff && acceptedPressure && beforeTokens <= threshold
        && beforeEstimateTokens <= acceptedPressure.limit) return messages;
      if (!force && !handoff && beforeTokens <= threshold) return messages;
      // Only unchanged pressure can defer a non-recoverable optional failure.
      // Recoverable failures retry inside the same handoff; any input growth
      // re-enables preparation rather than waiting for an arbitrary 25% jump.
      if (deferredAtEstimate !== null && !force && !handoff
        && beforeEstimateTokens <= deferredAtEstimate) return messages;
      const currentUser = messages.findLast(m => m.role === 'user' && typeof m.content === 'string');
      // Keep vision blocks in their native form. Sending Base64 to a textual
      // summarizer would be expensive and would not summarize the actual image.
      const fixed = new Set([...pinned, currentUser, ...messages.filter(m => Array.isArray(m.content))]);
      let boundary = safeBoundary(messages, 6);
      let retained = messages.filter((m, i) => i >= boundary || m.role === 'system' || fixed.has(m));
      if (force || handoff || inputTokens(retained) > threshold - 2500) {
        boundary = safeBoundary(messages, 1);
        retained = messages.filter((m, i) => i >= boundary || m.role === 'system' || fixed.has(m));
      }
      let old = messages.filter((m, i) => i < boundary && m.role !== 'system' && !fixed.has(m));
      const pressure = { windowTokens: window, responseReserveTokens: 4000, beforeTokens, beforeEstimateTokens,
        components: { rules: estimateContextTokens(messages.filter(m => m.role === 'system')),
          toolDefinitions: estimateContextTokens([], tools), currentRequest: estimateContextTokens([...fixed].filter(Boolean)),
          recentTools: estimateContextTokens(retained.filter(m => m.role === 'tool')), history: estimateContextTokens(old) } };
      const capacityWarning = error => {
        if (force) throw Object.assign(new Error('模型网关已拒绝上下文容量，且当前规则、请求或工具调用无法继续缩小；原文及已保存成果保留。请核对该网关的真实模型窗口。', { cause: error }),
          { code: 'MODEL_CONTEXT_CAPACITY', stage: 'context-recovery' });
        const warningKey = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
        if (warningKey !== lastWarning) onCompaction({ phase: 'capacity-warning', ...pressure, ...(error ? { error: String(error.message || error) } : {}) });
        lastWarning = warningKey;
        // The estimate is not a tokenizer or a provider rejection. Let the real
        // model decide whether this irreducible input fits its actual window.
        return messages;
      };
      // Soft pressure is advisory: if even the smallest protected tail cannot
      // reach the soft target, summarizing its small prefix buys no relief and
      // repeats on the next loop. Wait until that tool group becomes history.
      // The estimate guides compaction, but only an explicit provider rejection
      // can require recovery to succeed. Never strip latest reasoning/IDs.
      if (!force && !handoff && beforeTokens <= hardBudget && inputTokens(retained) > threshold - 2500) return messages;
      // A tiny old prefix cannot buy useful space. Soft pressure must not turn a
      // valid large current request into repeated ineffective summary requests.
      if (!force && !handoff && beforeTokens <= hardBudget && estimateContextTokens(old) < 2000) return messages;
      const started = Date.now();
      const originalMessages = messages;
      let chunks = 0, resultCount = 0;
      const summarizeAll = async (input, previous = '', purpose = 'history', maxOutputTokens = Math.min(6000, Math.floor(hardBudget / 4))) => {
        let summary = previous;
        let transportByteCap = Infinity;
        // The previous 8K-window target was only about 1.5KB, so one large
        // receipt became dozens of serial summary requests. Reserve space for
        // the requested summary and send a useful batch in one request; large
        // inputs still cross lossless transport boundaries and are all used.
        const outputReserve = Math.min(maxOutputTokens, purpose === 'tool-results' || purpose === 'tool-result' ? 1800 : 3200);
        const inputBytes = Math.max(4096, Math.floor((window - 2500 - outputReserve) * 3.5));
        const batches = chunksOf(input, inputBytes);
        if (!batches.length) throw new Error('没有新的可交接内容，保留现有上下文');
        // Account for rolling memory and second JSON escaping. Carry partial
        // pieces over source transport boundaries instead of sending a tiny
        // extra summary request at each original chunk end.
        const availableBytes = () => {
          const bytes = Math.floor((window - 4000 - estimateContextTokens([{ role: 'user', content: summary }]) - 1000) * 2 * 0.45);
          if (bytes < 256) throw new Error('前段摘要过大，无法安全接纳增量；原文仍保留');
          return Math.min(bytes, transportByteCap);
        };
        let maxBytes = availableBytes(), piece = '', bytes = 0;
        const compressPart = async (text, prior, kind = purpose, maxOutputBytes = maxOutputTokens * 2) => {
          let retryReason, payload = text, memory = prior, requestKind = kind, outputTarget = maxOutputBytes;
          let failures = 0, transientFailures = 0, unknownFailures = 0;
          const oversizedDrafts = new Set();
          // A single compaction piece may retry transient gateway failures, but
          // it must not keep a worker alive forever when the summary endpoint is
          // unavailable. This is a per-piece API recovery bound, not a task or
          // tool-round timeout; the caller can resume with the saved work.
          const maxRecoveryAttempts = Math.max(1, Number(summaryRetryLimit) || 8);
          const retry = (error, reason) => {
            retryReason = String(error.message || error);
            if (reason === 'summary-transient' && ++transientFailures > maxRecoveryAttempts) {
              throw Object.assign(new Error(`上下文摘要网关连续重试 ${maxRecoveryAttempts} 次仍未成功：${retryReason}`), {
                code: 'SUMMARY_RETRY_EXHAUSTED', cause: error
              });
            }
            failures += 1;
            onCompaction({phase:'retrying',kind:requestKind,reason,error:retryReason,attempt:failures,maxAttempts:maxRecoveryAttempts});
          };
          for (;;) {
            signal?.throwIfAborted();
            try {
              const next = await summarize(payload, memory, {
                purpose:requestKind,maxOutputTokens:Math.min(maxOutputTokens,Math.ceil(outputTarget/2)),
                maxOutputBytes:outputTarget,...(retryReason?{retryReason}: {}) }); chunks++;
              signal?.throwIfAborted();
              if(typeof next!=='string'||!next.trim())throw Object.assign(new Error('上下文摘要为空，正在重新生成；原文保留'),{code:'SUMMARY_EMPTY'});
              if(Buffer.byteLength(next)>maxOutputBytes){
                const draftKey=createHash('sha256').update(next).digest('hex');
                if(oversizedDrafts.has(draftKey))throw Object.assign(new Error('摘要精炼返回了重复的超长草稿，没有释放空间；保留原文和已保存成果，不再重复压缩同一内容。'),{code:'CONTEXT_SUMMARY_NO_PROGRESS'});
                oversizedDrafts.add(draftKey);
                // Keep refining the full derived draft; never restart all raw
                // history or abandon a handoff after an attempt-count limit.
                // Repeatedly requesting the same target can plateau just over
                // the acceptance budget. Tighten the requested semantic target
                // after each oversized response, not after transport failures.
                // The acceptance budget is unchanged and every complete draft
                // (including its tail constraints) is the next repair input.
                payload=next;memory='';requestKind='summary-repair';outputTarget=Math.max(128,Math.floor(outputTarget*0.7));
                retry(new Error(`摘要正文${Buffer.byteLength(next)}字节，超过${maxOutputBytes}字节预算；请语义精炼完整草稿，不截断末尾约束`),'summary-output');
                continue;
              }
              return next;
            } catch(error) {
              signal?.throwIfAborted();
              const code=String(error.code||error.cause?.code||'');
              const timeout=/TIMEOUT|ETIMEDOUT/.test(code);
              if(error.name==='AbortError'||timeout||['CONTEXT_SUMMARY_IRREDUCIBLE','CONTEXT_SUMMARY_NO_PROGRESS'].includes(code))throw error;
              if(code==='MODEL_CONTEXT_REJECTED'||contextLimitDetails(error)){
                retry(error,'summary-capacity');
                // The configured execution window is not proof that the
                // summary endpoint accepts this payload. Adapt to rejection.
                const payloadBytes=Buffer.byteLength(payload),memoryBytes=Buffer.byteLength(memory);
                if(memoryBytes>256&&(memoryBytes>=payloadBytes||payloadBytes<512)){
                  memory=await compressPart(memory,'','summary-repair',Math.min(maxOutputBytes,Math.floor(memoryBytes/2)));
                  continue;
                }
                const [left,right]=splitSummaryInput(payload);
                if(!right)throw Object.assign(new Error('摘要模型连最小片段及固定摘要指令也无法接纳；请核对该端点的真实窗口。原文保留。',{cause:error}),{code:'CONTEXT_SUMMARY_IRREDUCIBLE'});
                transportByteCap=Math.min(transportByteCap,Math.max(Buffer.byteLength(left),Buffer.byteLength(right)));
                const first=await compressPart(left,memory,requestKind,maxOutputBytes);
                return compressPart(right,first,requestKind,maxOutputBytes);
              }
              // Automatic pressure and forced recovery use the same retry
              // policy. A failed piece is not permission to send huge raw
              // history to the main model. API wait timeouts remain explicit.
              if(error.requestExhausted||['MODEL_STREAM_INCOMPLETE','SUMMARY_EMPTY','SUMMARY_INCOMPLETE'].includes(code)
                ||/SOCKET|ECONNRESET|EPIPE/.test(code)){
                retry(error,'summary-transient');
                await delay(Math.min(10000,250*2**Math.min(failures-1,5)),undefined,{signal});
                continue;
              }
              // Authentication, invalid model parameters and programming
              // errors cannot be cured by endlessly retrying unchanged input.
              if(unknownFailures++)throw error;
              retry(error,'summary-error');
            }
          }
        };
        const consume = async () => {
          // Commit no partial cache; keep completed memory across failed pieces.
          summary = await compressPart(piece, summary);
          piece = ''; bytes = 0; maxBytes = availableBytes();
        };
        for (const batch of batches) for (const char of batch) {
          const cost = Buffer.byteLength(char);
          if (bytes + cost > maxBytes) await consume();
          piece += char; bytes += cost;
        }
        if (piece) await consume();
        return summary;
      };
      try {
      if (inputTokens(retained) > hardBudget - 2500) {
        const complete = completedReceipts(messages);
        const receipts = retained.filter(m => complete.has(m) && typeof m.content === 'string' && Buffer.byteLength(m.content) > 512)
          .sort((a, b) => Buffer.byteLength(b.content) - Buffer.byteLength(a.content));
        const bare = retained.map(m => receipts.includes(m) ? { ...m, content: '' } : m);
        if (!receipts.length) {
          if (!old.length) return capacityWarning();
        } else {
        onCompaction({ phase: 'started', ...pressure, kind: 'tool-results' });
        const replacements = new Map();
        const availableResultTokens = hardBudget - 2500 - inputTokens(bare);
        if (!force && availableResultTokens < 384) {
          deferredAtEstimate = beforeEstimateTokens;
          onCompaction({ phase: 'deferred', ...pressure, reason: 'summary-budget-too-small',
            error: '剩余上下文预算不足 768 字节，跳过低收益摘要请求；等待上下文增长或模型实际拒绝后再压缩。' });
          return messages;
        }
        const resultBudget = Math.min(2000, Math.max(384, availableResultTokens));
        // One model request summarizes the complete ready tool group. Keep the
        // protocol-required receipt for every tool call, but place the shared
        // factual summary only on the largest receipt and use short references
        // for the remaining receipts; this avoids duplicating the same summary.
        const originals = receipts.map(receipt => receiptOriginals.get(receipt) || receipt);
        const summary = await summarizeAll(originals, '', 'tool-results', resultBudget);
        for (const [index, receipt] of receipts.entries()) {
          const content = index === 0
            ? `【工具批次摘要】\n${summary}\n本批已返回：${receipts.map(item => item.tool_call_id).join('、')}。不要重放已完成调用；摘要不是新的验证证据。`
            : `【工具返回已汇总】调用 ${receipt.tool_call_id} 已纳入同一批次摘要，保留调用配对，不要重放。`;
          const replacement = { ...receipt, content };
          if (estimateContextTokens([replacement]) >= estimateContextTokens([receipt])) {
            throw new Error('工具批次摘要没有释放足够空间，原始结果保留');
          }
          replacements.set(receipt, replacement);
        }
        // Commit the entire group atomically only after every summary succeeds.
        // IDs, call arguments and the assistant's reasoning remain exact.
        const projected = messages.map(m => replacements.get(m) || m);
        for (const [receipt, replacement] of replacements) receiptOriginals.set(replacement, receiptOriginals.get(receipt) || receipt);
        messages = projected;
        resultCount = replacements.size;
        retained = messages.filter((m, i) => i >= boundary || m.role === 'system' || fixed.has(m));
        old = messages.filter((m, i) => i < boundary && m.role !== 'system' && !fixed.has(m));
        if (estimateContextTokens(messages, tools) < estimateContextTokens(originalMessages, tools)
          && (inputTokens(messages) <= hardBudget || !old.length)) {
          deferredAtEstimate = inputTokens(messages) > hardBudget ? estimateContextTokens(messages, tools) : null;
          resetGrowthRoom(messages);
          onCompaction({ phase: 'completed', ...pressure, afterTokens: inputTokens(messages), afterEstimateTokens: estimateContextTokens(messages, tools), kind: 'tool-results', resultCount, chunks, durationMs: Date.now() - started });
          return messages;
        }
        }
      }
      if (!old.length) return capacityWarning();
      // A large immutable floor is not a reason to resend arbitrarily growing
      // history. Reclaim useful old content even if the heuristic target cannot
      // be reached; only a real gateway rejection establishes actual capacity.
      if (!force && !handoff && inputTokens(retained) > hardBudget - 2500
        && estimateContextTokens(old) < 2000) return capacityWarning();
      if (!resultCount) onCompaction({ phase: 'started', ...pressure, kind: 'history' });
      const previousMemories = old.filter(m => memories.has(m));
      let summary = previousMemories.map(m => memories.get(m).summary).join('\n');
      const delta = old.filter(m => !memories.has(m));
      if (!delta.length && summary) {
        // A gateway can reject an already condensed view. Re-condense its
        // derived memory, retaining the same exact archive coverage, rather
        // than requiring new raw history or resending an unchanged request.
        summary = await summarizeAll([{ role: 'assistant', content: summary }], '', 'history',
          Math.min(6000, Math.max(128, Math.floor(estimateContextTokens([{ role: 'assistant', content: summary }]) / 2))));
      } else summary = await summarizeAll(delta, summary);
      // Insert in place of the oldest condensed message, preserving all remaining
      // ordering and the exact latest request/tool-call/result objects.
      let inserted = false, memoryMessage;
      const compacted = messages.flatMap((m, i) => {
        if (i >= boundary || m.role === 'system' || fixed.has(m)) return [m];
        if (!inserted) { inserted = true; memoryMessage = summaryMessage(summary); return [memoryMessage]; }
        return [];
      });
      const afterTokens = inputTokens(compacted);
      if (estimateContextTokens(compacted, tools) >= estimateContextTokens(originalMessages, tools)) throw new Error('摘要未能释放足够上下文；原文仍保留，本轮未执行更多工具。');
      // Commit only a contiguous, actually replaced dialogue prefix. Keep raw
      // archives untouched. Memory may describe tool-reported progress, but no
      // raw calls/results or reasoning are stored in this checkpoint.
      const coveredIndexes = [...new Set([...previousMemories.flatMap(m => memories.get(m).coveredIndexes || []),
        ...old.map(m => positions.get(m)).filter(Boolean).map(n => n - 1)])].sort((a, b) => a - b);
      const sourceCount = coveredIndexes.length ? coveredIndexes.at(-1) + 1 : 0;
      memories.set(memoryMessage, { summary, sourceCount, coveredIndexes });
      if (sourceCount > 0) savedCache = { schema: 'deepseek-context/v2', generation: (savedCache?.generation || 0) + 1,
        sourceCount, coveredIndexes, fingerprint: fingerprint(archive.slice(0, sourceCount)), summary };
      onCompaction({ phase: 'completed', beforeTokens, afterTokens, beforeEstimateTokens, afterEstimateTokens: estimateContextTokens(compacted, tools), sourceCount, generation: savedCache?.generation || 0,
        chunks, resultCount, durationMs: Date.now() - started, components: pressure.components });
      // Do not repeatedly condense identical derived memory just because fixed
      // rules remain over a conservative target. Growth and forced provider
      // recovery still re-enable compaction immediately.
      deferredAtEstimate = afterTokens > hardBudget ? estimateContextTokens(compacted, tools) : null;
      resetGrowthRoom(compacted);
      return compacted;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        if (error?.code === 'MODEL_CONTEXT_CAPACITY') throw error;
        const optional = !force;
        onCompaction({ phase: optional ? 'deferred' : 'failed', beforeTokens, durationMs: Date.now() - started,
          error: String(error.message || error), ...(error.code ? { errorCode: error.code } : {}) });
        if (optional) {
          deferredAtEstimate = beforeEstimateTokens;
          // No provider rejection yet: a conservative local estimate must not
          // turn a failed auxiliary summary into a task failure.
          if (beforeTokens > hardBudget) onCompaction({ phase: 'capacity-warning', ...pressure, error: String(error.message || error) });
          return originalMessages;
        }
        throw Object.assign(new Error(`上下文摘要失败，当前输入需要压缩才能继续；原文与已保存结果保留。原因：${error.message || error}`, { cause: error }),
          { code: error.code || 'CONTEXT_SUMMARY_FAILED', stage: 'context-summary' });
      }
    }
  };
}
