const validWidth = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('concurrency must be a positive safe integer');
  return number;
};

const failedResult = result => Boolean(result && typeof result === 'object' && (
  result.ok === false || result.error || result.timedOut === true || result.timeout === true ||
  result.status === 'timeout' || result.status === 'timed_out'
));

/**
 * Execute an already-proven independent read set. Writes, ordering barriers and
 * dependencies belong to the caller; this function neither guesses nor retries.
 * The historical onWave contract now reports one rolling pool, including actual
 * per-item intervals and peak concurrency. Completed slots refill immediately.
 */
export async function runReadWaves(items, execute, { initialWidth = 100, maxWidth = 100, onWave, signal } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  signal?.throwIfAborted();
  const width = Math.min(validWidth(initialWidth), validWidth(maxWidth), items.length);
  if (!items.length) return [];
  const output = new Array(items.length);
  const executions = new Array(items.length), started = performance.now(), startedAt = new Date().toISOString();
  let next = 0, active = 0, peak = 0, failure, rejected = false;
  const worker = async () => {
    while (next < items.length && !rejected && !signal?.aborted) {
      const index = next++, item = items[index];
      const itemId = item?.id ?? item?.toolCallId ?? index;
      const start = performance.now();
      const execution = { itemId, index, startedAt: new Date().toISOString() };
      peak = Math.max(peak, ++active);
      try {
        output[index] = await execute(item, index, { signal });
        execution.status = 'fulfilled';
        execution.failed = failedResult(output[index]);
      } catch (cause) {
        if (!rejected) failure = cause;
        rejected = true;execution.status = 'rejected';execution.failed = true;
      } finally {
        active--;
        execution.endedAt = new Date().toISOString();
        execution.durationMs = performance.now() - start;
        executions[index] = execution;
      }
    }
  };
  await Promise.all(Array.from({length:width}, worker));
  const completed = executions.filter(Boolean);
  if (onWave) await onWave({wave:1,mode:'rolling',width:peak,concurrency:width,itemCount:completed.length,
    itemIds:completed.map(item=>item.itemId),startedAt,endedAt:new Date().toISOString(),
    durationMs:performance.now()-started,failed:completed.filter(item=>item.failed).length,executions:completed});
  if (rejected) throw failure;
  signal?.throwIfAborted();
  return output;
}
