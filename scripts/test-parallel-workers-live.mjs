import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createParallelCodexCoordinator } from '../server/codex-coordinator.js';
import { startCodexTurn } from '../server/codex-run.js';
import { localNetworkEnvironment } from '../server/network-environment.js';

// Reuse the real planner response: no second paid planning request, no business-tree writes.
const source = path.resolve(import.meta.dirname, '..');
const thread = process.argv.find(arg => arg.startsWith('--reuse-thread='))?.split('=')[1];
assert.match(thread || '', /^deepseek-[0-9a-f-]{36}$/);
const prior = JSON.parse(await readFile(path.join(os.homedir(), '.codex/task-tree-dialogues', thread + '.json'), 'utf8'));
assert.ok(path.basename(prior.cwd).startsWith('parallel-planner-live-'), 'isolated planning probe required');
const markdown = await readFile(path.join(prior.cwd, 'task-tree.md'), 'utf8');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'parallel-workers-live-'));
await writeFile(path.join(fixture, 'task-tree.md'), markdown);
Object.assign(process.env, await localNetworkEnvironment());
process.env.TASK_TREE_GLOBAL_ENV_FILE ||= path.resolve(source, '../.env');
const started = performance.now();
let active = 0, maximumActive = 0, coordinator, run, result, failure = '';
const workerStarts = [], workerResults = [];
try {
  coordinator = createParallelCodexCoordinator({ projectRoot: fixture, startTurn: async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) {
      return { status: 'completed', threadId: thread, output: prior.messages.at(-1).content };
    }
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1] || 'resolver';
    active++; maximumActive = Math.max(maximumActive, active);
    workerStarts.push({ taskId, elapsedMs: Math.round(performance.now() - started) });
    console.log(JSON.stringify({ event: 'worker_started', taskId, active }));
    try {
      const turn = await startCodexTurn({ ...options, environment: {
        ...(options.environment || {}), TASK_TREE_PROJECT_ROOT: fixture
      } });
      workerResults.push({ taskId, status: turn.status, timing: turn.timing, error: turn.error?.message || '' });
      console.log(JSON.stringify({ event: 'worker_finished', taskId, status: turn.status, elapsedMs: Math.round(performance.now() - started) }));
      return turn;
    } finally { active--; }
  } });
  run = await coordinator.plan({ objective: '完成六份独立中文使用说明，保留原工程树；不增加审核或测试任务。', nodeId: 'ROOT' });
  result = await coordinator.wait(run.id);
  await coordinator.drain();
  assert.equal(result.status, 'accepted', result.error);
  assert.equal(result.jobs.length, 6);
  assert.equal(maximumActive, 6, 'all independent workers must overlap');
  for (const file of ['navigation.md', 'dialogue.md', 'attachments.md', 'subtrees.md', 'parallel.md', 'recovery.md']) {
    assert.ok((await readFile(path.join(fixture, file), 'utf8')).trim().length > 100, `missing output ${file}`);
  }
  assert.equal(await readFile(path.join(fixture, 'task-tree.md'), 'utf8'), markdown);
  for (const job of result.jobs) await readFile(path.join(fixture, job.subtreeFile));
} catch (error) {
  failure = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  const report = { ok: !process.exitCode, fixture, reusedPlannerThread: thread, runId: run?.id,
    status: result?.status, error: result?.error || failure, totalMs: Math.round(performance.now() - started),
    maximumConcurrentWorkers: maximumActive, workerStarts, workerResults,
    workspaceTimings: result?.workspaceTimings, gitCommandTimings: result?.gitCommandTimings,
    jobs: result?.jobs?.map(({ taskId, status, error, changedFiles, subtreeFile }) => ({ taskId, status, error, changedFiles, subtreeFile })),
    limitation: '复用真实规划响应，真实 DeepSeek Worker、工具和 Git 在隔离工程执行；只验证链路与交付物，不证明这些示例文档的业务正确性或复杂代码任务的拆分最优性。' };
  await writeFile(path.join(source, 'docs/parallel-workers-live.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'finished', ok: report.ok, status: report.status, totalMs: report.totalMs, fixture }));
}
