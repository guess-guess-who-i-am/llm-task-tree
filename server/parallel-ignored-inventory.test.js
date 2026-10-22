import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGitWorkspaceManager} from './parallel-worktree.js';

test('snapshot and worker inventory prune unrelated ignored runtime trees before Git enumeration', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'ignored-inventory-'));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ignored-inventory-workers-'));
  t.after(() => Promise.all([projectRoot, tempRoot].map(root => rm(root, {recursive:true, force:true}))));
  await writeFile(path.join(projectRoot, '.gitignore'), '.cache/\nnode_modules/\nsubtrees/\n.task-tree-*\n');
  const retained = ['subtrees/nested/branch.md', 'subtrees/nested/branch.task.json',
    '.task-tree-runs/run.json', '.task-tree-scopes/scope.json',
    '.task-tree-dialogue-backups/prior.md', '.task-tree-context/memory.json', '.task-tree-thread'];
  const omitted = ['.cache/runtime/mysql/large-data', 'node_modules/vendor/output',
    '.task-tree-runs/review-inputs/receipt/data', 'subtrees/nested/scratch.tmp'];
  for (const file of [...retained, ...omitted]) {
    await mkdir(path.dirname(path.join(projectRoot, file)), {recursive:true});
    await writeFile(path.join(projectRoot, file), 'original\n');
  }
  const manager = createGitWorkspaceManager({projectRoot, tempRoot});
  const commands = [];
  manager.setTimingObserver(event => commands.push(event));
  const state = await manager.prepare('scoped-inventory');
  try {
    for (const file of retained) assert.equal(await readFile(path.join(state.integrationPath, file), 'utf8'), 'original\n');
    for (const file of omitted) await assert.rejects(readFile(path.join(state.integrationPath, file)), {code:'ENOENT'});
    await writeFile(path.join(state.integrationPath, '.gitignore'), '.cache/\nnode_modules/\nsubtrees/\n.task-tree-*\n');
    for (const file of retained) await writeFile(path.join(state.integrationPath, file), 'updated\n');
    await mkdir(path.join(state.integrationPath, '.cache/runtime'), {recursive:true});
    await writeFile(path.join(state.integrationPath, '.cache/runtime/large-data'), 'must not scan\n');
    const changes = await manager.inspectChanges(state.integrationPath, state.snapshotCommit);
    assert.deepEqual(changes.changedFiles, [...retained].sort());
    const ignoredCalls = commands.filter(event => event.command === 'ls-files' && event.args.includes('--ignored'));
    assert.equal(ignoredCalls.length, 2, 'both prepare and inspect must use the restricted inventory');
    for (const call of ignoredCalls) {
      assert.ok(!call.args.slice(call.args.indexOf('--') + 1).includes('.'),
        'never enumerate all ignored files and filter only after buffering their names');
    }
  } finally { await manager.cleanup({...state, runId:'scoped-inventory'}); }
});
