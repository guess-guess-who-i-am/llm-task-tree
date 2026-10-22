import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createDirectNodeWorkspace } from './direct-node-workspace.js';
import { createGitWorkspaceManager } from './parallel-worktree.js';
import { buildCompletionReviewPrompt } from './node-completion-review.js';
import { createParallelCodexCoordinator } from './codex-coordinator.js';

const exec = promisify(execFile);
const graph = '# LLM Task Graph\n## ROOT - 验收\n- Problem: 交付模块\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
const pass = { status: 'completed', output: '{"verdict":"pass","reason":"已按目标实际验证"}' };

test('staged durable context is merged while host thread cache and transient files stay private', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-self-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), graph);
  const workspace = createGitWorkspaceManager({ projectRoot: root, tempRoot: root });
  let checks = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, workspace, reviewTurn: async options => {
    checks++;
    await writeFile(path.join(options.cwd, '.task-tree-port'), '1234');
    await writeFile(path.join(options.cwd, 'repair.txt'), 'fixed');
    await exec('git', ['add', '-A'], { cwd: options.cwd });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'reviewer commit'], { cwd: options.cwd });
    await writeFile(path.join(options.cwd, '.task-tree-threads.json'), '{"threads":[]}');
    await exec('git', ['add', '.task-tree-threads.json'], { cwd: options.cwd });
    await mkdir(path.join(options.cwd,'.task-tree-context'),{recursive:true});
    await writeFile(path.join(options.cwd,'.task-tree-context','evidence.json'),'{"result":"durable"}');
    return pass;
  } });
  const state = await executor.prepare('self-commit');
  await writeFile(path.join(state.workerPath, 'result.txt'), 'result');
  const receipt = await executor.finish(state, { nodeId: 'ROOT', status: 'completed' });
  assert.equal(checks, 1);
  assert.deepEqual(receipt.appliedFiles.sort(), ['.task-tree-context/evidence.json', 'repair.txt', 'result.txt']);
  assert.equal(await readFile(path.join(root, 'repair.txt'), 'utf8'), 'fixed');
  await assert.rejects(readFile(path.join(root, '.task-tree-port')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root,'.task-tree-threads.json')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(root,'.task-tree-context','evidence.json'),'utf8'),'{"result":"durable"}');
});

test('registry normalization of the base does not discard a reviewed new entry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-registry-base-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), graph);
  const before = { activeMethod: 'a', schema: 'task-tree-registry/v1', trees: [{ id: 'a', path: 'task-tree.md' }] };
  const candidate = { ...before, trees: [...before.trees, { id: 'b', path: 'trees/b.md' }] };
  await writeFile(path.join(root, 'task-trees.json'), JSON.stringify(before));
  let checks = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async () => {
    checks++;
    await writeFile(path.join(root, 'task-trees.json'), JSON.stringify({ trees: before.trees, schema: before.schema, activeMethod: 'a' }, null, 2));
    return pass;
  } });
  const state = await executor.prepare('base-order');
  await writeFile(path.join(state.workerPath, 'task-trees.json'), JSON.stringify(candidate));
  await executor.finish(state, { nodeId: 'ROOT', status: 'completed' });
  assert.equal(checks, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'task-trees.json'), 'utf8')), candidate);
});

for (const kind of ['registry-value', 'registry-array-order', 'ordinary-json', 'mode']) {
  test(`real ${kind} change invalidates a candidate and increments review attempt`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), `review-${kind}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'task-tree.md'), graph);
    const file = kind === 'ordinary-json' ? 'data.json' : kind === 'mode' ? 'run.sh' : 'task-trees.json';
    const before = { active: 'a', trees: ['a', 'b'] };
    const candidate = { ...before, active: 'candidate' };
    await writeFile(path.join(root, file), JSON.stringify(before));
    const timings = [];
    let checks = 0, resolves = 0;
    const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
      checks++;
      if (checks === 1) {
        if (kind === 'mode') await chmod(path.join(root, file), 0o755);
        else {
          const live = kind === 'registry-array-order' ? { ...before, trees: ['b', 'a'] } : { ...before, active: 'live' };
          await writeFile(path.join(root, file), JSON.stringify(live));
        }
      }
      return pass;
    }, startTurn: async options => {
      resolves++;
      await writeFile(path.join(options.cwd, file), JSON.stringify({ ...candidate, resolved: true }));
      await exec('git', ['add', file], { cwd: options.cwd });
      return { status: 'completed', output: '真实冲突已协调' };
    } });
    const state = await executor.prepare('actual-change');
    await writeFile(path.join(state.workerPath, file), JSON.stringify(candidate));
    await executor.finish(state, { nodeId: 'ROOT', status: 'completed', onTiming: sample => timings.push(sample) });
    assert.equal(checks, 2, 'real change must still require checking a new candidate');
    assert.deepEqual(timings.filter(x => x.role === 'review').map(x => x.attempt), [0, 1]);
    const invalidation = timings.find(x => x.role === 'review-invalidated');
    assert.equal(invalidation.file, file);
    assert.ok(invalidation.candidateId);
    assert.ok(resolves <= 1);
  });
}

test('final review prompt asks only for functional verification and a short verdict', () => {
  const prompt = buildCompletionReviewPrompt('只验收一个分支');
  assert.match(prompt, /检查目标功能/);
  assert.match(prompt, /最多 3 条验证证据/);
  assert.doesNotMatch(prompt, /改动文件|执行者报告|完整差异|教程|示例/);
  assert.match(prompt, /有缺陷就修复并复验/);
  assert.doesNotMatch(prompt, /本轮只做一个未解决的连贯工作单元/);
});

test('independent coordinator integration records real attempts, invalidation and model usage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-coordinator-observation-'));
  await writeFile(path.join(root, 'task-tree.md'), graph);
  await writeFile(path.join(root, 'result.txt'), 'base');
  let checks = 0;
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn: async options => {
    const resolving = options.prompt.includes('Merge conflict resolution');
    await writeFile(path.join(options.cwd, 'result.txt'), resolving ? 'combined' : 'candidate');
    if (resolving) await exec('git', ['add', 'result.txt'], { cwd: options.cwd });
    return { status: 'completed', output: '成果已保存', threadId: 'review-observation-worker' };
  }, reviewTurn: async () => {
    checks++;
    if (checks === 1) await writeFile(path.join(root, 'result.txt'), 'concurrent');
    return { ...pass, timing: { totalMs: 20, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
  } });
  t.after(async () => { await coordinator.drain(); await rm(root, { recursive: true, force: true }); });
  const run = await coordinator.start([{ taskId: 'one', nodeId: 'ROOT', instruction: '完成 result.txt' }]);
  const finished = await coordinator.wait(run.id);
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(checks, 2);
  const timings = finished.events.filter(event => event.type === 'integration_review_turn_timing');
  assert.deepEqual(timings.map(event => event.attempt), [0, 1]);
  assert.ok(timings.every(event => event.candidateId && event.timing.usage.totalTokens === 15));
  const invalidation = finished.events.find(event => event.type === 'candidate_invalidated');
  assert.equal(invalidation.file, 'result.txt');
  assert.equal(invalidation.attempt, 0);
  assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'combined');
});
