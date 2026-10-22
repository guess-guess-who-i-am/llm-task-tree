import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectServer, stablePortFor } from './projects.js';

test('project switching refreshes a responding managed runtime instead of bypassing version checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-runtime-refresh-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await writeFile(path.join(root, 'task-tree.md'), '# graph');
  await writeFile(path.join(root, 'server.js'), 'fixture');
  let refreshes = 0;
  const result = await ensureProjectServer(root, {
    fetchImpl: async () => new Response(JSON.stringify({root})),
    spawnImpl: () => {throw new Error('already serving; must not spawn another server');},
    refreshImpl: async (project, runtime, port) => {
      assert.equal(project, root); assert.equal(runtime.kitDir, root);
      assert.ok(port > 0); refreshes++;
    }
  });
  assert.equal(refreshes, 1);
  assert.equal(result.started, false);
});

test('switching preserves a validated fallback port rather than starting a second service', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-marker-refresh-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await writeFile(path.join(root, 'task-tree.md'), '# graph');
  await writeFile(path.join(root, 'server.js'), 'fixture');
  await writeFile(path.join(root, '.task-tree-port'), '65000');
  const result = await ensureProjectServer(root, {
    fetchImpl: async url => {
      if (url.includes(':65000/')) return new Response(JSON.stringify({root}));
      throw new Error('preferred port does not serve this project');
    },
    refreshImpl: async (_, __, port) => assert.equal(port, 65000),
    spawnImpl: () => {throw new Error('must not spawn duplicate');}
  });
  assert.equal(result.port, 65000);
  await writeFile(path.join(root, '.task-tree-port'), '65001');
  const recovered = await ensureProjectServer(root, {
    fetchImpl: async url => new Response(JSON.stringify({root:url.includes(':65001/') ? os.tmpdir() : root})),
    refreshImpl: async () => {}, spawnImpl: () => {throw new Error('must not spawn');}
  });
  assert.equal(recovered.port, stablePortFor(root), 'another project on the marker port is ignored');
});
