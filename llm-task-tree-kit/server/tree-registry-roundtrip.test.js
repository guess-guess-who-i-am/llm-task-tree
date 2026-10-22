import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addTree, defaultTreeRegistry, loadTreeRegistry } from './tree-registry.js';

test('new tree registration rejects unrenderable edges before publishing or creating the file',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'registry-edge-contract-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  const registryFile=path.join(projectRoot,'task-trees.json');
  const registry=defaultTreeRegistry();
  const markdown='# LLM Task Graph\n## ROOT - 根\n## N1 - 子\n# GraphState\n- Current: ROOT\n- Next: N1\n# Edges\n## DOC_E1 - 关系\n- Endpoints: ROOT, N1\n';
  await assert.rejects(addTree({projectRoot,registryFile,registry,input:{id:'bad-edge',createFile:true,markdown}}),/边 ID/);
  await assert.rejects(readFile(path.join(projectRoot,'trees/bad-edge.md')),{code:'ENOENT'});
  assert.equal((await loadTreeRegistry({projectRoot,registryFile})).trees.some(t=>t.id==='bad-edge'),false);
  const created=await addTree({projectRoot,registryFile,registry,input:{id:'good-edge',createFile:true,markdown:markdown.replace('## DOC_E1','## E_DOC_1')}});
  assert.equal(created.tree.id,'good-edge');
  assert.match(await readFile(path.join(projectRoot,'trees/good-edge.md'),'utf8'),/E_DOC_1/);
});

test('loading a parallel registry preserves its plan reference and full description', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'registry-roundtrip-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const registryFile = path.join(projectRoot, 'task-trees.json');
  const parallel = { id: 'parallel-run', path: 'trees/parallel-run.md',
    title: '中文交付目标'.repeat(40), description: '完整的分支背景'.repeat(110),
    planPath: 'trees/parallel-run.plan.json', role: 'reference', editable: true, flowEnabled: false };
  await writeFile(registryFile, JSON.stringify({ ...defaultTreeRegistry(), trees: [...defaultTreeRegistry().trees, parallel] }));
  for (let i = 0; i < 2; i++) {
    const result = await loadTreeRegistry({ projectRoot, registryFile });
    const branch = result.trees.find(tree => tree.id === parallel.id);
    assert.equal(branch.planPath, parallel.planPath);
    assert.equal(branch.title, parallel.title);
    assert.equal(branch.description, parallel.description);
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).trees.find(tree => tree.id === parallel.id), branch);
  }
});

test('reading an equivalent registry does not rewrite object key order or whitespace', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'registry-read-order-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const registryFile = path.join(projectRoot, 'task-trees.json');
  const original = defaultTreeRegistry();
  const reversed = { trees: original.trees.map(t => Object.fromEntries(Object.entries(t).reverse())), activeMethod: original.activeMethod, schema: original.schema };
  const bytes = JSON.stringify(reversed, null, 4) + '\n';
  await writeFile(registryFile, bytes);
  assert.deepEqual(await loadTreeRegistry({ projectRoot, registryFile }), original);
  assert.equal(await readFile(registryFile, 'utf8'), bytes, 'read-only access must not create metadata churn');
});
