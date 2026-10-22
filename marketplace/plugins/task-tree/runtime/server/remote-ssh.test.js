import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRemoteBundle, createRemoteSshManager, normalizeSshProfile, runProcess, shellQuote, sshArguments } from './remote-ssh.js';
import { bootstrapRemoteWorkspace } from '../scripts/remote-workspace-bootstrap.mjs';

test('SSH aliases, paths and shell quoting preserve exact arguments', async () => {
  const profile = normalizeSshProfile({ host: 'hyf', projectRoot: "/home/hyf/project's space" });
  const args = sshArguments(profile, '/tmp/tt-socket');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(!args.includes('-p'), 'inherit SSH alias port and identity');
  assert.equal(await runProcess('sh', ['-c', `printf %s ${shellQuote(profile.projectRoot)}`]), profile.projectRoot);
  for (const input of [{host:'-bad',projectRoot:'/a'}, {host:'hyf',projectRoot:'/'}, {host:'hyf',projectRoot:'relative'}, {host:'hyf',projectRoot:'/a',port:0.5}]) assert.throws(() => normalizeSshProfile(input));
});

test('runtime archive contains protocols and assets, excludes project data and credentials', async () => {
  const bundle = await buildRemoteBundle(path.resolve(import.meta.dirname, '..'));
  try {
    const files = await runProcess('tar', ['-tzf', bundle.archive]);
    for (const file of ['server.js','public/remote-ssh.js','scripts/remote-workspace-bootstrap.mjs','AGENTS.task-tree.md','AGENTS.node-writing.md','templates/task-tree.starter.md','skills/task-tree-grill/SKILL.md']) assert.ok(files.includes('./'+file), file);
    assert.doesNotMatch(files, /(?:^|\/)\.env|api-connections\.json|\.ssh\/|\.git\/|\.test\.js|\.\/task-tree\.md|\/steps\/|\/worker\//m);
    const manifest=JSON.parse(await runProcess('tar',['-xOzf',bundle.archive,'./package.json']));
    const lock=JSON.parse(await runProcess('tar',['-xOzf',bundle.archive,'./package-lock.json']));
    assert.equal(manifest.dependencies['@vscode/ripgrep'],lock.packages['node_modules/@vscode/ripgrep'].version);
    for(const arch of ['x64','arm64'])assert.deepEqual(lock.packages[`node_modules/@vscode/ripgrep-linux-${arch}`].os,['linux'],
      'SSH installs must resolve remote Linux binaries rather than copying a macOS executable');
  } finally { await rm(bundle.temporary, { recursive:true, force:true }); }
});

test('parallel connection requests share deployment, persisted aliases survive manager recreation, identity mismatch fails', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(),'ssh-manager-'));
  await mkdir(path.join(home,'.ssh')); await writeFile(path.join(home,'.ssh/config'),'Host hyf other\n HostName 192.168.4.194\nHost *.example.com\n');
  const calls = [];
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const run = async (cmd, args) => {
    calls.push(args);
    const last = args.at(-1);
    if (last.includes?.('process.versions.node')) { await barrier; return JSON.stringify({node:'/home/hyf/.local/bin/node',home:'/home/hyf'}); }
    if (last.includes?.('remote-workspace-bootstrap.mjs')) return JSON.stringify({port:5518,root:'/home/hyf/memes',hostname:'remote',revision:'test',reused:true});
    return '';
  };
  const bundleBuilder = async () => ({temporary:await mkdtemp(path.join(os.tmpdir(),'ssh-bundle-')),archive:'/unused',revision:'test'});
  let mismatch = false;
  const probe = async () => ({root:mismatch?'/wrong':'/home/hyf/memes',executionHost:{mode:'ssh',hostname:'remote'}});
  try {
    const manager = createRemoteSshManager({kitDir:'/kit',homeDir:home,run,bundleBuilder,probe});
    const input = {host:'hyf',projectRoot:'/home/hyf/memes'};
    const [a,b] = await Promise.all([manager.connect(input),manager.connect(input)]);
    assert.equal(a.id,b.id); release();
    while(a.status === 'running') await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(a.status,'completed',a.error);
    assert.equal(calls.filter(args=>args.at(-1).includes?.('remote-workspace-bootstrap.mjs')).length,1);
    assert.deepEqual((await manager.list()).aliases,['hyf','other']);
    const fresh = createRemoteSshManager({kitDir:'/kit',homeDir:home,run,bundleBuilder,probe});
    assert.equal((await fresh.list()).profiles[0].host,'hyf');
    mismatch = true;
    const failed = await fresh.connect({id:a.profileId});
    while(failed.status === 'running') await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(failed.status,'failed'); assert.match(failed.error,/身份/);
    assert.ok(calls.some(args=>args.includes('cancel')), 'failed identity probe closes its new tunnel');
    await manager.disconnect(a.profileId);
    assert.ok(calls.some(args=>args.includes('exit')));
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('concurrent remote bootstrap creates one backend, reconnect preserves tree and live service', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'ssh-bootstrap-'));
  const root = path.join(dir,'project'), runtime=path.join(dir,'runtime');
  await mkdir(path.join(runtime,'scripts'),{recursive:true}); await mkdir(root);
  await writeFile(path.join(root,'task-tree.md'),'existing tree');
  await writeFile(path.join(runtime,'scripts/install-linux-project.mjs'),`if(!process.argv.includes('--preserve-existing-trees'))throw Error('must preserve tree');`);
  await writeFile(path.join(runtime,'server.js'),`const http=require('node:http'),fs=require('node:fs');const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({root:process.env.TASK_TREE_PROJECT_ROOT,executionHost:{mode:'ssh'}}))});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.TASK_TREE_REMOTE_READY_FILE,JSON.stringify({port:server.address().port})));`);
  let service;
  try {
    const config={projectRoot:root,runtime,revision:'v1',stateBase:path.join(dir,'state')};
    const [a,b]=await Promise.all([bootstrapRemoteWorkspace(config),bootstrapRemoteWorkspace(config)]);
    service=a;
    assert.equal(a.pid,b.pid); assert.equal(a.port,b.port); assert.notEqual(a.reused,b.reused);
    const again=await bootstrapRemoteWorkspace({...config,revision:'v2'});
    assert.equal(again.pid,a.pid);assert.equal(again.revision,'v1','do not replace active service to upgrade runtime');
    assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),'existing tree');
    assert.equal((await readFile(path.join(root,'.task-tree-port'),'utf8')).trim(),String(a.port));
    await rm(path.join(root,'.task-tree-port'));
    await bootstrapRemoteWorkspace(config);
    assert.equal((await readFile(path.join(root,'.task-tree-port'),'utf8')).trim(),String(a.port),'reconnect repairs MCP port discovery');
  } finally { if(service?.pid) process.kill(service.pid,'SIGTERM'); await rm(dir,{recursive:true,force:true}); }
});

test('remote bootstrap loads persistent network configuration before Node starts, preserving loopback access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-network-'));
  const root = path.join(dir, 'project'), runtime = path.join(dir, 'runtime'), configDir = path.join(dir, 'config');
  await mkdir(path.join(runtime, 'scripts'), { recursive: true }); await mkdir(root); await mkdir(configDir);
  await writeFile(path.join(configDir, 'network.json'), JSON.stringify({ HTTPS_PROXY: 'http://127.0.0.1:17891', HTTP_PROXY: 'http://127.0.0.1:17891', NO_PROXY: 'internal.example', MODEL_AGENT_MAIN_MODEL: 'must-not-inject' }));
  await writeFile(path.join(runtime, 'scripts/install-linux-project.mjs'), '');
  await writeFile(path.join(runtime, 'server.js'), `const http=require('node:http'),fs=require('node:fs');const server=http.createServer((req,res)=>res.end(JSON.stringify({root:process.env.TASK_TREE_PROJECT_ROOT,executionHost:{mode:'ssh'},network:Object.fromEntries(['HTTPS_PROXY','HTTP_PROXY','NODE_USE_ENV_PROXY','NO_PROXY'].map(k=>[k,process.env[k]]))})));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.TASK_TREE_REMOTE_READY_FILE,JSON.stringify({port:server.address().port})));`);
  let service;
  try {
    const config = { projectRoot: root, runtime, revision: 'network', stateBase: path.join(dir, 'state'), globalEnvFile: path.join(configDir, '.env') };
    service = await bootstrapRemoteWorkspace(config);
    const info = await fetch(`http://127.0.0.1:${service.port}/api/project`).then(r => r.json());
    assert.equal(info.network.HTTPS_PROXY, 'http://127.0.0.1:17891');
    assert.equal(info.network.HTTP_PROXY, 'http://127.0.0.1:17891');
    assert.equal(info.network.NODE_USE_ENV_PROXY, '1');
    for (const host of ['internal.example', 'localhost', '127.0.0.1', '::1']) assert.ok(info.network.NO_PROXY.split(',').includes(host));
    assert.equal((await bootstrapRemoteWorkspace(config)).pid, service.pid, 'reconnect preserves service and its network');
  } finally { if (service?.pid) process.kill(service.pid, 'SIGTERM'); await rm(dir, { recursive: true, force: true }); }
});

test('dependency download retries a mirror only on network errors, not broken package installs', async () => {
  for (const failure of ['ETIMEDOUT network download', 'ELIFECYCLE broken install']) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ssh-install-'));
    const installs = [];
    const run = async (_command, args) => {
      const script = args.at(-1);
      if (script.includes('process.versions.node')) return JSON.stringify({ node: '/usr/bin/node', home: '/home/hyf' });
      if (script.startsWith('test -f')) throw Error('not installed');
      if (script.includes('npm ci')) { installs.push(script); if (installs.length === 1) throw Error(failure); }
      if (script.includes('remote-workspace-bootstrap.mjs')) return JSON.stringify({ port: 5518, root: '/home/hyf/memes', hostname: 'remote' });
      return '';
    };
    try {
      const manager = createRemoteSshManager({ kitDir: '/kit', homeDir: home, run,
        bundleBuilder: async () => ({ temporary: await mkdtemp(path.join(os.tmpdir(), 'ssh-archive-')), archive: '/unused', revision: 'test' }),
        probe: async () => ({ root: '/home/hyf/memes', executionHost: { mode: 'ssh', hostname: 'remote' } }) });
      const job = await manager.connect({ host: 'hyf', projectRoot: '/home/hyf/memes' });
      while (job.status === 'running') await new Promise(resolve => setTimeout(resolve, 5));
      if (failure.startsWith('ETIMEDOUT')) {
        assert.equal(job.status, 'completed', job.error); assert.equal(installs.length, 2);
        assert.match(installs[1], /registry.npmmirror.com/);
      } else { assert.equal(job.status, 'failed'); assert.equal(installs.length, 1); }
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});
