import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import {describeProjects, registerProject, readRegistry} from './projects.js';

async function fixture(t) {
  // Registration intentionally excludes os.tmpdir(); exercise a durable experiment
  // like the real benchmark, using a private hidden fixture and private registry.
  const base=await mkdtemp(path.join(process.cwd(),'.project-visibility-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const homeDir=path.join(base,'home'),file=path.join(homeDir,'LLMTaskTree/projects.json');
  const project=async name=>{
    const root=path.join(base,name);
    await mkdir(root,{recursive:true});
    await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph');
    return root;
  };
  return {base,homeDir,file,project};
}

test('internal experiments never enter recent projects, while real projects still register',async t=>{
  const f=await fixture(t),real=await f.project('real-project'),internal=await f.project('bench/complex-w8');
  await writeFile(path.join(f.base,'bench/.task-tree-internal-project'),'Internal experiment workspaces; not user projects.\n');
  registerProject(real,{file:f.file});registerProject(internal,{file:f.file});
  assert.deepEqual(readRegistry(f.file),[real]);
});

test('old manifest, per-project records, services and folder discovery all hide marked experiments without deleting them',async t=>{
  const f=await fixture(t),real=await f.project('real-project');
  const legacy=await f.project('bench/legacy'),recorded=await f.project('bench/recorded');
  const service=await f.project('bench/service'),discovered=await f.project('bench/discovered');
  const sameNameReal=await f.project('test-runs/ordinary-user-project');
  // Register before opting out, reproducing records written by old server versions.
  registerProject(recorded,{file:f.file});
  await mkdir(path.dirname(f.file),{recursive:true});
  const original=JSON.stringify({projects:[legacy,real,sameNameReal]});
  await writeFile(f.file,original);
  const services=path.join(f.homeDir,'Library/LaunchAgents');await mkdir(services,{recursive:true});
  await writeFile(path.join(services,'local.task-tree.project-fixture.plist'),`<key>WorkingDirectory</key><string>${service}</string>`);
  await writeFile(path.join(f.base,'bench/.task-tree-internal-project'),'internal\n');
  const options={file:f.file,homeDir:f.homeDir,currentRoot:real,searchRoots:[path.join(f.base,'bench')]};
  const roots=describeProjects(options).map(p=>p.root);
  assert.deepEqual(new Set(roots),new Set([real,sameNameReal]));
  assert.equal(await readFile(f.file,'utf8'),original,'filtering must not rewrite the registry');
  for(const root of [legacy,recorded,service,discovered])assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),'# LLM Task Graph');
  assert.equal(describeProjects({...options,currentRoot:legacy})[0].root,legacy,'an explicitly opened internal workspace stays usable');
});

test('a symlink cannot expose an internal workspace, nor hide an ordinary neighbouring project',async t=>{
  const f=await fixture(t),real=await f.project('real'),internal=await f.project('bench/worker');
  await writeFile(path.join(f.base,'bench/.task-tree-internal-project'),'internal\n');
  await mkdir(path.dirname(f.file),{recursive:true});
  const alias=path.join(f.base,'ordinary-looking-alias');await symlink(internal,alias,'dir');
  await writeFile(f.file,JSON.stringify([real,alias]));
  assert.deepEqual(describeProjects({file:f.file,currentRoot:real,homeDir:f.homeDir,searchRoots:[]}).map(p=>p.root),[real]);
});

test('a project-local marker also opts out when no current workspace is supplied',async t=>{
  const f=await fixture(t),internal=await f.project('custom-fixture-location');
  await writeFile(path.join(internal,'.task-tree-internal-project'),'internal\n');
  registerProject(internal,{file:f.file});
  assert.deepEqual(readRegistry(f.file),[]);
  await mkdir(path.dirname(f.file),{recursive:true});await writeFile(f.file,JSON.stringify([internal]));
  assert.deepEqual(describeProjects({file:f.file,homeDir:f.homeDir,searchRoots:[]}),[]);
});
