import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runReadWaves } from './read-wave.js';

const items = count => Array.from({ length: count }, (_, index) => ({ id: `read-${index}`, index }));

test('eight independent reads execute in one overlapping wave by default', async () => {
  let active = 0, peak = 0;
  const waves = [];
  const output = await runReadWaves(items(8), async item => {
    peak = Math.max(peak, ++active);
    await delay(20);
    active--;
    return { ok: true, index: item.index };
  }, { onWave: wave => waves.push(wave) });
  assert.equal(peak, 8, 'independent reads must not be artificially split into four-read batches');
  assert.deepEqual(waves.map(wave => wave.width), [8]);
  assert.deepEqual(output.map(result => result.index), items(8).map(item => item.index));
  const starts = waves[0].executions.map(item => Date.parse(item.startedAt));
  const ends = waves[0].executions.map(item => Date.parse(item.endedAt));
  assert.ok(Math.max(...starts) < Math.min(...ends), 'all eight reads really overlap');
});

test('25 independent reads grow successful waves while preserving input order', async () => {
  const waves = [];
  const input = items(25);
  const output = await runReadWaves(input, async item => {
    await delay((5 - item.index % 5) * 2);
    return { ok: true, index: item.index };
  }, { initialWidth: 4, onWave: wave => waves.push(wave) });
  assert.deepEqual(output.map(result => result.index), input.map(item => item.index));
  assert.deepEqual(waves.map(wave => wave.width), [4, 5, 6, 7, 3]);
  assert.deepEqual(waves.map(wave => wave.wave), [1, 2, 3, 4, 5]);
  assert.deepEqual(waves.flatMap(wave => wave.itemIds), input.map(item => item.id));
  assert.ok(waves.every(wave => wave.failed === 0));
});

test('concurrency never exceeds 20 even when requested higher', async () => {
  let active = 0, peak = 0;
  const waves = [];
  await runReadWaves(items(45), async () => {
    peak = Math.max(peak, ++active);
    await delay(5);
    active--;
    return { ok: true };
  }, { initialWidth: 80, maxWidth: 100, onWave: wave => waves.push(wave) });
  assert.equal(peak, 20);
  assert.deepEqual(waves.map(wave => wave.width), [20, 20, 5]);
});

test('failed objects halve width without retries or skipped independent consumers', async () => {
  const waves = [], executed = [];
  const output = await runReadWaves(items(15), async item => {
    executed.push(item.index);
    if (item.index === 1) return { ok: false };
    if (item.index === 5) return { error: 'read failed' };
    if (item.index === 6) return { timedOut: true };
    return { ok: true };
  }, { initialWidth: 4, onWave: wave => waves.push(wave) });
  assert.deepEqual(waves.map(wave => wave.width), [4, 2, 1, 1, 2, 3, 2]);
  assert.deepEqual(waves.map(wave => wave.failed), [1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(executed, items(15).map(item => item.index));
  assert.equal(output.length, 15);
});

test('records actual overlapping execution intervals instead of only configured width', async () => {
  const waves = [];
  await runReadWaves(items(4), async () => {
    await delay(20);
    return { ok: true };
  }, { onWave: wave => waves.push(wave) });
  const wave = waves[0];
  assert.equal(wave.executions.length, 4);
  const starts = wave.executions.map(item => Date.parse(item.startedAt));
  const ends = wave.executions.map(item => Date.parse(item.endedAt));
  assert.ok(Math.max(...starts) < Math.min(...ends), 'all four reads really overlap');
  assert.ok(wave.durationMs >= 15);
  assert.ok(wave.executions.every(item => item.durationMs >= 15 && item.status === 'fulfilled'));
  assert.ok(Date.parse(wave.startedAt) <= Math.min(...starts));
  assert.ok(Date.parse(wave.endedAt) >= Math.max(...ends));
});

test('a rejected read is recorded then rethrown unchanged after active siblings settle', async () => {
  const failure = new Error('transport failed');
  const completed = [], waves = [];
  await assert.rejects(runReadWaves(items(8), async item => {
    if (item.index === 1) throw failure;
    await delay(10);
    completed.push(item.index);
    return { ok: true };
  }, { initialWidth: 4, onWave: wave => waves.push(wave) }), error => error === failure);
  assert.deepEqual(completed, [0, 2, 3]);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].failed, 1);
  assert.equal(waves[0].executions[1].status, 'rejected');
});

test('cancellation during a wave starts no later wave and preserves abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  const started = [], waves = [];
  await assert.rejects(runReadWaves(items(10), async item => {
    started.push(item.index);
    await delay(5);
    if (item.index === 0) controller.abort(reason);
    return { ok: true };
  }, { initialWidth: 4, signal: controller.signal, onWave: wave => waves.push(wave) }), error => error === reason);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(waves.length, 1);
});

test('pre-aborted signal starts nothing; empty list has no wave', async () => {
  const signal = AbortSignal.abort(new Error('already cancelled'));
  let called = false;
  await assert.rejects(runReadWaves(items(1), async () => { called = true; }, { signal }), /already cancelled/);
  assert.equal(called, false);
  assert.deepEqual(await runReadWaves([], async () => { called = true; }), []);
  assert.equal(called, false);
});

test('configured lower cap and synchronous exceptions follow the same contracts', async () => {
  const waves = [];
  await runReadWaves(items(7), item => ({ ok: true, index: item.index }), {
    initialWidth: 4, maxWidth: 2, onWave: wave => waves.push(wave)
  });
  assert.deepEqual(waves.map(wave => wave.width), [2, 2, 2, 1]);
  const error = new Error('sync failure');
  await assert.rejects(runReadWaves(items(1), () => { throw error; }), result => result === error);
});
