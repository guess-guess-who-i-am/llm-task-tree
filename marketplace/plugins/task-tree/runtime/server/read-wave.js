const clampWidth = (value, fallback, ceiling) => {
  const number = Number(value);
  return Math.min(ceiling, Math.max(1, Number.isFinite(number) ? Math.floor(number) : fallback));
};

const failedResult = result => Boolean(result && typeof result === 'object' && (
  result.ok === false || result.error || result.timedOut === true || result.timeout === true ||
  result.status === 'timeout' || result.status === 'timed_out'
));

/**
 * Execute an already-proven independent read set. Writes, ordering barriers and
 * dependencies belong to the caller; this function neither guesses nor retries.
 * onWave receives actual execution intervals after each wave has settled.
 */
export async function runReadWaves(items, execute, { initialWidth = 20, maxWidth = 20, onWave, signal } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  signal?.throwIfAborted();
  const ceiling = clampWidth(maxWidth, 20, 20);
  let width = clampWidth(initialWidth, 20, ceiling);
  const output = new Array(items.length);
  let offset = 0, waveNumber = 0;
  while (offset < items.length) {
    signal?.throwIfAborted();
    const waveItems = items.slice(offset, offset + width);
    const waveStart = performance.now();
    const startedAt = new Date().toISOString();
    const settled = await Promise.all(waveItems.map(async (item, relativeIndex) => {
      const index = offset + relativeIndex;
      const itemId = item?.id ?? item?.toolCallId ?? index;
      const start = performance.now();
      const execution = { itemId, index, startedAt: new Date().toISOString() };
      let result, error, rejected = false;
      try {
        result = await execute(item, index, { signal });
      } catch (cause) {
        rejected = true;
        error = cause;
      }
      execution.endedAt = new Date().toISOString();
      execution.durationMs = performance.now() - start;
      execution.failed = rejected || failedResult(result);
      execution.status = rejected ? 'rejected' : 'fulfilled';
      return { result, error, rejected, execution };
    }));
    const executions = settled.map(item => item.execution);
    const failed = executions.filter(item => item.failed).length;
    const wave = {
      wave: ++waveNumber,
      width: waveItems.length,
      itemIds: executions.map(item => item.itemId),
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - waveStart,
      failed,
      executions
    };
    if (onWave) await onWave(wave);
    const rejected = settled.find(item => item.rejected);
    if (rejected) throw rejected.error;
    signal?.throwIfAborted();
    settled.forEach((item, index) => { output[offset + index] = item.result; });
    offset += waveItems.length;
    width = failed ? Math.max(1, Math.floor(width / 2)) : Math.min(ceiling, width + 1);
  }
  return output;
}
