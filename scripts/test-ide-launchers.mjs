import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'ide-launcher-links-'));
try {
  for (const name of ['open.command', 'open-project.command']) {
    const link = path.join(fixture, name);
    await symlink(path.join(root, 'macos/IDE', name), link);
    const chained = path.join(fixture, 'desktop-' + name);
    await symlink(name, chained);
    const { stdout } = await promisify(execFile)('bash', [chained], { cwd: fixture,
      env: { ...process.env, NODE_BIN: process.execPath, TASK_TREE_NO_OPEN: '1' } });
    const url = stdout.match(/Task tree: (http:\/\/[^\s]+)/)?.[1];
    assert.ok(url, stdout);
    assert.equal((await (await fetch(url + '/api/project')).json()).root, root);
    console.log(name + ': chained desktop link opens the real IDE project');
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
