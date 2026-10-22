import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeRevision, projectServiceIdle } from './runtime-revision.js';
import * as revisions from './runtime-revision.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('worker generation follows transitive runtime imports but ignores unrelated IDE experiments',async t=>{
  const root=await fixture(t);
  await mkdir(path.join(root,'server'));await mkdir(path.join(root,'scripts'));
  await writeFile(path.join(root,'server/shared-agent-worker.js'),"import './agent-runtime.js';");
  await writeFile(path.join(root,'server/agent-runtime.js'),"export {ready} from './nested.js';");
  await writeFile(path.join(root,'server/nested.js'),"export const ready=1; import('./agent-runtime.js');");
  await writeFile(path.join(root,'scripts/mcp-server.mjs'),'export const tool=1;');
  assert.equal(typeof revisions.workerRuntimeRevision,'function');
  const first=await revisions.workerRuntimeRevision(root);
  await writeFile(path.join(root,'scripts/unrelated-experiment.mjs'),'changed');
  await writeFile(path.join(root,'server/unrelated-ui.js'),'changed');
  assert.equal(await revisions.workerRuntimeRevision(root),first);
  await writeFile(path.join(root,'server/nested.js'),'export const ready=2;');
  assert.notEqual(await revisions.workerRuntimeRevision(root),first);
});

test('runtime revision changes with executable content, not secrets, dialogue or tests', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'server')); await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'server.js'), 'original');
  await writeFile(path.join(root, 'server', 'context.js'), 'first');
  const before = await runtimeRevision(root);
  assert.match(before, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, '.env'), 'not part of revision');
  await writeFile(path.join(root, 'server', 'context.test.js'), 'test changed');
  assert.equal(await runtimeRevision(root), before);
  await writeFile(path.join(root, 'server', 'context.js'), 'fixed');
  assert.notEqual(await runtimeRevision(root), before);
});

test('only the same idle project may be replaced; active or unknown status stays untouched', async t => {
  const root = await fixture(t);
  const probe = (runs, actualRoot = root) => projectServiceIdle('http://fixture.invalid', root, {
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/api/project') ? { root: actualRoot } : { runs }))
  });
  assert.equal(await probe([{ status: 'failed' }]), true);
  assert.equal(await probe([{ status: 'running' }]), false);
  assert.equal(await probe([{ status: 'unknown-new-state' }]), false);
  assert.equal(await probe(undefined), false);
  assert.equal(await probe([], os.tmpdir()), false);
  await mkdir(path.join(root, '.task-tree-runs'), { recursive: true });
  await writeFile(path.join(root, '.task-tree-runs', 'planner.json'), JSON.stringify({status:'planning'}));
  assert.equal(await probe([]), false);
});
