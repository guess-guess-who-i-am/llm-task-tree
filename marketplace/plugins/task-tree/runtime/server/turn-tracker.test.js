import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locateProjectRoot } from './turn-tracker.js';

test('explicit isolated workspace wins over the owning project environment', async t => {
  const host = await mkdtemp(path.join(os.tmpdir(), 'tree-root-host-'));
  const candidate = await mkdtemp(path.join(os.tmpdir(), 'tree-root-candidate-'));
  t.after(() => Promise.all([host, candidate].map(dir => rm(dir, { recursive: true, force: true }))));
  await Promise.all([host, candidate].map(dir => writeFile(path.join(dir, 'task-tree.md'), '# tree')));
  const previous = process.env.TASK_TREE_PROJECT_ROOT;
  t.after(() => { if (previous === undefined) delete process.env.TASK_TREE_PROJECT_ROOT; else process.env.TASK_TREE_PROJECT_ROOT = previous; });
  process.env.TASK_TREE_PROJECT_ROOT = host;
  assert.equal(locateProjectRoot({ cwd: candidate, fallbackDir: candidate }), candidate);
  assert.equal(locateProjectRoot(), host, 'environment is still the default when no explicit cwd is provided');
});
