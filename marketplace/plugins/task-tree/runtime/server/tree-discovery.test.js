import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTreeRegistry, addTree, starterTreeMarkdown } from './tree-registry.js';
import { describeProjects } from './projects.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('independent tree files are recovered into the registry; folded files and documents are not', async t => {
  const projectRoot = await fixture(t), registryFile = path.join(projectRoot, 'task-trees.json');
  await mkdir(path.join(projectRoot, 'trees'));
  await mkdir(path.join(projectRoot, 'subtrees'));
  const original = await loadTreeRegistry({projectRoot,registryFile});
  await writeFile(path.join(projectRoot, 'trees/people.md'), starterTreeMarkdown({title:'人物树',role:'method'}));
  await writeFile(path.join(projectRoot, 'trees/readme.md'), '# 使用说明\n普通文档');
  await writeFile(path.join(projectRoot, 'subtrees/N1.md'), starterTreeMarkdown({title:'子树',role:'method'}));
  await writeFile(path.join(projectRoot, 'trees/folded.md'), '> Fold root: N1\n' + starterTreeMarkdown({title:'折叠',role:'method'}));
  await writeFile(path.join(projectRoot, 'trees/architecture.md'), starterTreeMarkdown({title:'任务图系统稳定架构',role:'architecture'}));
  const next = await loadTreeRegistry({projectRoot,registryFile});
  assert.deepEqual(next.trees.map(t => t.id), ['method','people']);
  assert.equal(next.trees[1].title, '人物树');
  assert.equal(next.activeMethod, original.activeMethod);
  assert.equal(JSON.parse(await readFile(registryFile,'utf8')).trees[1].path, 'trees/people.md');
  assert.deepEqual(await loadTreeRegistry({projectRoot,registryFile}),next);
});

test('concurrent tree registration preserves every independent tree and latest active method', async t => {
  const projectRoot = await fixture(t), registryFile = path.join(projectRoot, 'task-trees.json');
  const registry = await loadTreeRegistry({projectRoot,registryFile});
  await Promise.all(Array.from({length:12},(_,i) => addTree({projectRoot,registryFile,registry,input:{id:`t${i}`,title:`树${i}`}})));
  const saved = await loadTreeRegistry({projectRoot,registryFile});
  assert.equal(saved.trees.length,13);
  assert.equal(saved.activeMethod,'method');
  assert.equal(new Set(saved.trees.map(t => t.path)).size,13);
});

test('registering an existing tree preserves content and metadata; invalid registry is never reset',async t=>{
  const projectRoot=await fixture(t),registryFile=path.join(projectRoot,'task-trees.json');
  const input={id:'people',title:'人物',description:'真实观察',role:'method',flowEnabled:false,createFile:true};
  const created=await addTree({projectRoot,registryFile,input});
  const file=path.join(projectRoot,created.tree.path),original=await readFile(file,'utf8');
  const registered=await addTree({projectRoot,registryFile,input:{id:'people',title:'人物关系',registerExisting:true}});
  assert.equal(registered.tree.description,'真实观察');assert.equal(registered.tree.flowEnabled,false);
  assert.equal(await readFile(file,'utf8'),original);
  await assert.rejects(()=>addTree({projectRoot,registryFile,input:{...input,id:'overwrite',path:created.tree.path,markdown:'覆盖'}}),/already registered/);
  await assert.rejects(()=>addTree({projectRoot,registryFile,input:{...input,id:'missing',path:'trees/missing.md',registerExisting:true}}),/不存在/);
  await writeFile(registryFile,'{broken');
  await assert.rejects(()=>loadTreeRegistry({projectRoot,registryFile}),/保留原文件/);
  assert.equal(await readFile(registryFile,'utf8'),'{broken');
});

test('project discovery finds installed desktop workspaces without Windows installer records', async t => {
  const homeDir = await fixture(t);
  const desktop = path.join(homeDir,'Desktop');
  const currentRoot = path.join(desktop,'当前项目'), other = path.join(desktop,'建模世界');
  for (const dir of [currentRoot,other,path.join(desktop,'普通目录')]) await mkdir(dir,{recursive:true});
  for (const dir of [currentRoot,other]) await writeFile(path.join(dir,'task-tree.md'),'# LLM Task Graph');
  const options = {file:path.join(homeDir,'missing.json'),currentRoot,searchRoots:[desktop],homeDir};
  assert.deepEqual(describeProjects(options).map(p=>p.root),[currentRoot,other]);
  await rm(other,{recursive:true});
  assert.deepEqual(describeProjects(options).map(p=>p.root),[currentRoot]);
});
