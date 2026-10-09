import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createParallelCodexCoordinator, deriveParallelGoal } from './codex-coordinator.js';
import { createGitWorkspaceManager } from './parallel-worktree.js';
import { createTaskTreeAgentTools } from './task-tree-agent-tools.js';

const exec = promisify(execFile);
const tree = id => `# LLM Task Graph\n## ROOT - 项目\n- Problem: 完成项目\n## ${id} - 阶段\n- Problem: 完成独立结果\n# GraphState\n- Current: ${id}\n- Next: ${id}\n# Edges\n`;
test('the default parallel objective executes the node NextIdea, never the stale GraphState NextPlan', () => {
  const markdown = tree('SOURCE').replace('- Problem: 完成独立结果', '- Problem: 完成独立结果\n- NextIdea: 修复编辑按钮')
    .replace('- Next: SOURCE', '- Next: SOURCE\n- NextPlan: 已废弃的旧计划');
  assert.equal(deriveParallelGoal(markdown).immediate, '修复编辑按钮');
  assert.equal(deriveParallelGoal(markdown, '用户最新目标').immediate, '用户最新目标');
});
async function fixture(t, initialized = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree('SOURCE'));
  if (initialized) {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
  }
  return root;
}

test('parallel snapshot initializes a plain project and an unborn Git repository without staging user files', async t => {
  for (const unborn of [false, true]) {
    const root = await fixture(t);
    if (unborn) await exec('git', ['init', '-q'], { cwd: root });
    await writeFile(path.join(root, '.env'), 'PRIVATE_SENTINEL=never-snapshot\n');
    await writeFile(path.join(root, '.gitignore'), '.task-tree-runs/\n');
    const manager = createGitWorkspaceManager({ projectRoot: root });
    const prepared = await manager.prepare('bootstrap');
    try {
      assert.equal(await readFile(path.join(prepared.integrationPath, 'task-tree.md'), 'utf8'), tree('SOURCE'));
      await assert.rejects(readFile(path.join(prepared.integrationPath, '.env')), { code: 'ENOENT' });
      assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, '');
    } finally { await manager.cleanup({ ...prepared, runId: 'bootstrap' }); }
  }
});

test('a failed model result cannot be committed, integrated or reported as completed', async t => {
  const root = await fixture(t);
  let commits = 0;
  const workspace = {
    async prepare() { return { integrationPath: root, snapshotCommit: 'base' }; },
    async head() { return 'base'; }, async createWorker() { return root; },
    async inspectChanges() { return { changedFiles: ['partial.txt'] }; },
    async commit() { commits++; return 'partial'; }, async integrate() {}, async removeWorker() {},
    async summarize() { return { changedFiles: [] }; }, async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace,
    startTurn: async () => ({ status: 'failed', threadId: 'failed-thread', output: 'partial text', error: { message: 'HTTP 502' } }) });
  const run = await coordinator.start([{ taskId: 'A', nodeId: 'SOURCE', instruction: '完成结果', writeSet: [], dependsOn: [] }]);
  const finished = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(finished.status, 'failed');
  assert.equal(finished.jobs[0].status, 'failed');
  assert.match(finished.jobs[0].error, /502/);
  assert.equal(commits, 0);
});

test('tool-server PID and port files never cause spurious merges, while task metadata edits remain allowed', async t => {
  const root = await fixture(t, true);
  const manager = createGitWorkspaceManager({ projectRoot: root });
  const prepared = await manager.prepare('runtime-files');
  const worker = await manager.createWorker('runtime-files', 'A', prepared.snapshotCommit);
  try {
    await writeFile(path.join(worker, '.task-tree-server.pid'), '12345');
    await writeFile(path.join(worker, '.task-tree-port'), '12345');
    await writeFile(path.join(worker, 'result.txt'), 'real result');
    const inspected = await manager.inspectChanges(worker, prepared.snapshotCommit);
    assert.deepEqual(inspected.changedFiles, ['result.txt']);
    const commit = await manager.commit(worker, 'worker', prepared.snapshotCommit);
    const files = (await exec('git', ['diff', '--name-only', prepared.snapshotCommit, commit], { cwd: worker })).stdout;
    assert.equal(files, 'result.txt\n');
  } finally { await manager.removeWorker(worker); await manager.cleanup({ ...prepared, runId: 'runtime-files' }); }
});

test('explicit tool workspace wins over provider root; branch field patches cannot overwrite the live source tree', { timeout: 30000 }, async t => {
  const source = await fixture(t);
  const worker = await fixture(t);
  await mkdir(path.join(worker, 'subtrees'));
  await writeFile(path.join(worker, 'subtrees/BRANCH.md'), tree('BRANCH'));
  const bridge = await createTaskTreeAgentTools({ cwd: worker, environment: {
    TASK_TREE_PROJECT_ROOT: source, TASK_TREE_CONTEXT_TREE_FILE: 'subtrees/BRANCH.md'
  } });
  try {
    const focus = await bridge.call('task_tree_focus');
    assert.equal(focus.projectRoot, worker);
    assert.equal(focus.nextNode.id, 'BRANCH');
    const receipt = await bridge.call('task_tree_write', { nodeId: 'BRANCH', fields: { CurrentResult: '只修改隔离分支。' }, reason: '验证隔离字段补丁' });
    assert.ok(receipt.changes.some(change => change.nodeId === 'BRANCH' && change.after === '只修改隔离分支。'));
    assert.match(await readFile(path.join(worker, 'subtrees/BRANCH.md'), 'utf8'), /只修改隔离分支/);
    assert.equal(await readFile(path.join(source, 'task-tree.md'), 'utf8'), tree('SOURCE'));
    assert.equal(await readFile(path.join(worker, 'task-tree.md'), 'utf8'), tree('SOURCE'));
  } finally {
    await bridge.close();
    const pid = Number(await readFile(path.join(worker, '.task-tree-server.pid'), 'utf8').catch(() => 0));
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
});

test('selected tree becomes eight real editable branch subtrees, runs concurrently and merges every result', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  await mkdir(path.join(root, 'trees'));
  await writeFile(path.join(root, 'trees/selected.md'), tree('SELECTED'));
  await writeFile(path.join(root, 'task-trees.json'), JSON.stringify({ activeMethod: 'method', trees: [
    { id: 'method', role: 'method', path: 'task-tree.md', title: '主树' },
    { id: 'selected', role: 'reference', path: 'trees/selected.md', title: '选中树' }
  ] }));
  const jobs = Array.from({ length: 8 }, (_, i) => ({ taskId: `job${i}`, nodeId: 'SELECTED', title: `结果${i}`,
    instruction: `写入独立结果${i}`, writeSet: [`result${i}.txt`], dependsOn: [] }));
  let started = 0, active = 0, maximum = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const startTurn = async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) {
      assert.match(options.prompt, /SELECTED/);
      return { threadId: 'planner', output: JSON.stringify({ summary: '八项结果', jobs }) };
    }
    const id = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    const call = options.initialToolCalls[0];
    const nodeId = JSON.parse(call.function.arguments).nodeId;
    assert.notEqual(nodeId, 'SELECTED', 'each worker must receive its own materialized node');
    const relative = options.prompt.match(/^Branch subtree: (.+)$/m)?.[1];
    assert.ok(relative, 'worker must be told exactly where its editable subtree lives');
    const markdown = await readFile(path.join(options.cwd, relative), 'utf8');
    assert.match(markdown, new RegExp(`## ${nodeId} -`));
    active++; maximum = Math.max(maximum, active);
    if (++started === jobs.length) release();
    await barrier;
    await writeFile(path.join(options.cwd, `${id}.txt`), `result ${id}\n`);
    await writeFile(path.join(options.cwd, relative), markdown.replace('- CurrentResult:', `- CurrentResult: 已保存 ${id} 的独立结果`));
    active--;
    return { status: 'completed', threadId: `thread-${id}`, output: JSON.stringify({ event: 'completed', evidence: id }) };
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn });
  t.after(() => { release(); });
  const run = await coordinator.plan({ objective: '完成八项独立结果', treeId: 'selected', nodeId: 'SELECTED' });
  const finished = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(maximum, 8);
  assert.equal(finished.sourceTree.path, 'trees/selected.md');
  const registry = JSON.parse(await readFile(path.join(root, 'task-trees.json'), 'utf8'));
  assert.equal(registry.activeMethod, 'method', 'do not move the human project focus');
  assert.ok(registry.trees.some(item => item.id === finished.branchTree.id));
  const runTree = await readFile(path.join(root, finished.branchTree.path), 'utf8');
  assert.equal((runTree.match(/- SubtreeFile:/g) || []).length, 8);
  assert.equal(new Set(finished.jobs.map(j => j.executionNodeId)).size, 8);
  for (const job of finished.jobs) {
    assert.equal(await readFile(path.join(root, `${job.taskId}.txt`), 'utf8'), `result ${job.taskId}\n`);
    assert.match(await readFile(path.join(root, job.subtreeFile), 'utf8'), new RegExp(`已保存 ${job.taskId}`));
  }
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree('SOURCE'));
  assert.equal((await exec('git', ['ls-files', '--unmerged'], { cwd: root })).stdout, '');
});

test('new branches are materialized before scheduling and start before the original branches finish', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  let release, started, extraStarted;
  const hold = new Promise(resolve => { release = resolve; });
  const firstReady = new Promise(resolve => { started = resolve; });
  const extraReady = new Promise(resolve => { extraStarted = resolve; });
  let count = 0;
  const jobs = ['a', 'b'].map(taskId => ({ taskId, nodeId: 'SOURCE', title: taskId, instruction: '独立结果', writeSet: [], dependsOn: [] }));
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn: async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) return { output: JSON.stringify({ jobs }) };
    if (options.prompt.includes('Single Parallel Branch Planner')) return { output: JSON.stringify({ job: { ...jobs[0], taskId: 'extra' } }) };
    const id = options.prompt.match(/^Task id: (.+)$/m)[1];
    const relative = options.prompt.match(/^Branch subtree: (.+)$/m)[1];
    await readFile(path.join(options.cwd, relative));
    const taskFile = relative.replace(/\.md$/, '.task.json');
    const instructions = JSON.parse(await readFile(path.join(options.cwd, taskFile), 'utf8'));
    assert.equal(instructions.taskId, id);
    if (!['a', 'b'].includes(id)) extraStarted();
    else { if (++count === 2) started(); await hold; }
    await writeFile(path.join(options.cwd, id + '.txt'), id);
    return { status: 'completed', output: JSON.stringify({ event: 'completed', evidence: id }) };
  } });
  t.after(() => { release(); });
  const run = await coordinator.plan();
  const wait = promise => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(async () => {
      const state = await coordinator.get(run.id);
      reject(new Error(JSON.stringify({ status: state.status, error: state.error, jobs: state.jobs.map(j => ({ taskId: j.taskId, status: j.status, error: j.error })) })));
    }, 5000); timer.unref();
  })]);
  await wait(firstReady);
  const appended = await coordinator.addBranch(run.id, { nodeId: 'SOURCE' });
  assert.equal(appended.jobs.length, 3);
  await wait(extraReady);
  release();
  const result = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(result.status, 'accepted', result.error);
  const appendedId = appended.jobs.at(-1).taskId;
  assert.equal(await readFile(path.join(root, appendedId + '.txt'), 'utf8'), appendedId);
  assert.equal((await readFile(path.join(root, result.branchTree.path), 'utf8')).match(/- SubtreeFile:/g).length, 3);
});
