import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspaceManager, gitCommand } from './parallel-worktree.js';

const runId = '73d2d385-453e-4e31-90db-fd6643c27983';
const hostFiles = [`.task-tree-runs/${runId}.json`, `.task-tree-runs/${runId}/execution-tree.json`, '.task-tree-runs/context-index.json'];
const durableFile = '.task-tree-runs/handoffs/keep.json';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-runtime-state-'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'parallel-runtime-worktrees-'));
  t.after(() => Promise.all([root, temporary].map(p => rm(p, { recursive: true, force: true }))));
  for (const file of [...hostFiles, durableFile]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'original\n');
  }
  await gitCommand(root, ['init', '-q']);
  await gitCommand(root, ['add', '.']);
  await gitCommand(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'legacy baseline']);
  const baseline = (await gitCommand(root, ['rev-parse', 'HEAD'])).trim();
  return { root, baseline, workspace: createGitWorkspaceManager({ projectRoot: root, tempRoot: temporary }) };
}

test('derived parallel state stays with the host while durable handoffs and worker artifacts still merge', async t => {
  const { root, workspace } = await fixture(t);
  const prepared = await workspace.prepare('runtime-state');
  const worker = await workspace.createWorker('runtime-state', 'a', prepared.snapshotCommit);
  try {
    for (const file of hostFiles) {
      await assert.rejects(readFile(path.join(worker, file)), { code: 'ENOENT' });
      await mkdir(path.dirname(path.join(worker, file)), { recursive: true });
      await writeFile(path.join(worker, file), 'obsolete worker state\n');
      await writeFile(path.join(root, file), 'new live state\n');
    }
    await writeFile(path.join(worker, durableFile), 'updated handoff\n');
    await writeFile(path.join(worker, 'result.md'), 'real result\n');
    const changes = await workspace.inspectChanges(worker, prepared.snapshotCommit);
    assert.deepEqual(changes.changedFiles, [durableFile, 'result.md']);
    const commit = await workspace.commit(worker, 'product result', prepared.snapshotCommit);
    await workspace.integrate(prepared.integrationPath, commit, prepared.snapshotCommit);
    await workspace.accept({ integrationPath: prepared.integrationPath, snapshotCommit: prepared.snapshotCommit, changedFiles: changes.changedFiles });
    for (const file of hostFiles) assert.equal(await readFile(path.join(root, file), 'utf8'), 'new live state\n');
    assert.equal(await readFile(path.join(root, durableFile), 'utf8'), 'updated handoff\n');
    assert.equal(await readFile(path.join(root, 'result.md'), 'utf8'), 'real result\n');
  } finally {
    await workspace.removeWorker(worker);
    await workspace.cleanup({ ...prepared, runId: 'runtime-state' });
  }
});

test('legacy worker commits cannot create host-state conflicts or replay old logs during recovery', async t => {
  const { root, baseline, workspace } = await fixture(t);
  const prepared = await workspace.prepare('legacy-runtime');
  const worker = await workspace.createWorker('legacy-runtime', 'old', baseline);
  try {
    for (const file of hostFiles) await writeFile(path.join(worker, file), 'old worker version\n');
    await writeFile(path.join(worker, 'result.md'), 'preserved old worker result\n');
    await gitCommand(worker, ['add', '.']);
    await gitCommand(worker, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'legacy product and logs']);
    const commit = (await gitCommand(worker, ['rev-parse', 'HEAD'])).trim();
    for (const file of hostFiles) {
      await mkdir(path.dirname(path.join(prepared.integrationPath, file)), { recursive: true });
      await writeFile(path.join(prepared.integrationPath, file), 'concurrent host state\n');
    }
    await gitCommand(prepared.integrationPath, ['add', '.']);
    await gitCommand(prepared.integrationPath, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'concurrent host state']);
    await workspace.integrate(prepared.integrationPath, commit, baseline);
    for (const file of hostFiles) assert.equal(await readFile(path.join(prepared.integrationPath, file), 'utf8'), 'concurrent host state\n');
    assert.equal(await readFile(path.join(prepared.integrationPath, 'result.md'), 'utf8'), 'preserved old worker result\n');
    assert.equal((await gitCommand(prepared.integrationPath, ['diff', '--name-only', '--diff-filter=U'])).trim(), '');
  } finally {
    await workspace.abortIntegration(prepared.integrationPath).catch(() => {});
    await workspace.removeWorker(worker);
    await workspace.cleanup({ ...prepared, runId: 'legacy-runtime' });
  }
});
