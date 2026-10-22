import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createReviewInputWatch } from './review-input-watch.js';

const run = promisify(execFile);

test('asynchronous watcher exhaustion never terminates the IDE process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-error-'));
  try {
    await writeFile(path.join(root, 'source.txt'), 'before');
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';
      fs.watch=()=>{const emitter=new EventEmitter();emitter.close=()=>{};setImmediate(()=>emitter.emit('error',Object.assign(new Error('watch limit'),{code:'ENOSPC'})));return emitter;};syncBuiltinESMExports();
      const {createReviewInputWatch}=await import(${JSON.stringify(new URL('./review-input-watch.js', import.meta.url).href)});
      const input=await createReviewInputWatch({projectRoot:process.argv[1],candidatePath:process.argv[1],files:['source.txt'],platform:'darwin'});
      await new Promise(resolve=>setTimeout(resolve,30));try{await input.validate()}catch(e){if(e.code!=='REVIEW_INPUT_CHANGED')throw e;}finally{input.close()}console.log('survived');`;
    const result = await run(process.execPath, ['--input-type=module', '-e', script, root]);
    assert.match(result.stdout, /survived/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux uses bounded inventory validation and still invalidates shell dependencies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-linux-'));
  let input;
  try {
    await run('git', ['init', '-q', root]);
    await writeFile(path.join(root, 'source.txt'), 'before');
    input = await createReviewInputWatch({ projectRoot: root, candidatePath: root, platform: 'linux' });
    await input.observe({ method: 'tool/started', params: { toolName: 'exec_command', arguments: { cmd: 'test' } } });
    await input.validate();
    await writeFile(path.join(root, 'source.txt'), 'changed');
    await assert.rejects(input.validate(), { code: 'REVIEW_INPUT_CHANGED' });
  } finally { input?.close(); await rm(root, { recursive: true, force: true }); }
});

test('shell validation compares content, not timestamps or Git staging', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-content-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await run('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'source.txt'), 'same bytes');
  const input = await createReviewInputWatch({projectRoot:root,candidatePath:root,platform:'linux'});
  t.after(() => input.close());
  await input.observe({method:'tool/started',params:{toolName:'exec_command',arguments:{cmd:'test'}}});
  await utimes(path.join(root, 'source.txt'), new Date(0), new Date(0));
  await run('git', ['-C',root,'add','source.txt']);
  await input.validate();
});

test('a complete declared dependency boundary excludes unrelated work but retains actual reads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-scope-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await run('git', ['init', '-q', root]);
  for (const file of ['output.txt','dependency.txt','other-task.txt']) await writeFile(path.join(root,file),'before');
  const input = await createReviewInputWatch({projectRoot:root,candidatePath:root,platform:'linux',
    dependencyScope:{complete:true,files:['output.txt','dependency.txt']}});
  t.after(() => input.close());
  await input.observe({method:'tool/started',params:{toolName:'exec_command',arguments:{cmd:'test'}}});
  await writeFile(path.join(root,'other-task.txt'),'unrelated task changed');
  await input.validate();
  await writeFile(path.join(root,'dependency.txt'),'real dependency changed');
  await assert.rejects(input.validate(),{code:'REVIEW_INPUT_CHANGED',file:'dependency.txt'});
});

test('explicit read outside declared shell dependencies remains protected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-extra-read-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await run('git', ['init', '-q', root]);
  await writeFile(path.join(root,'extra.txt'),'before');
  const input = await createReviewInputWatch({projectRoot:root,candidatePath:root,platform:'linux',
    dependencyScope:{complete:true,files:['declared.txt']}});
  t.after(() => input.close());
  await input.observe({method:'tool/started',params:{toolName:'read_file',arguments:{path:'extra.txt'}}});
  await writeFile(path.join(root,'extra.txt'),'changed');
  await assert.rejects(input.validate(),{code:'REVIEW_INPUT_CHANGED',file:'extra.txt'});
});

test('an incomplete scope never narrows unknown shell dependencies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watch-unknown-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await run('git', ['init', '-q', root]);
  await writeFile(path.join(root,'unknown.txt'),'before');
  const input = await createReviewInputWatch({projectRoot:root,candidatePath:root,platform:'linux',
    dependencyScope:{files:[]}});
  t.after(() => input.close());
  await input.observe({method:'tool/started',params:{toolName:'exec_command',arguments:{cmd:'test'}}});
  await writeFile(path.join(root,'unknown.txt'),'changed');
  await assert.rejects(input.validate(),{code:'REVIEW_INPUT_CHANGED'});
});

test('declared Git pathspecs detect new/deleted dependencies without watching sibling tasks', async t => {
  for (const mutation of ['add','delete']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'watch-scope-inventory-'));
    t.after(() => rm(root, {recursive:true,force:true}));
    await run('git',['init','-q',root]);
    await mkdir(path.join(root,'owned'));
    await writeFile(path.join(root,'owned','old.txt'),'before');
    const input=await createReviewInputWatch({projectRoot:root,candidatePath:root,platform:'linux',
      dependencyScope:{complete:true,files:['owned/**']}});
    t.after(()=>input.close());
    await writeFile(path.join(root,'sibling.txt'),'unrelated');
    await input.validate();
    if (mutation==='add') await writeFile(path.join(root,'owned','new.txt'),'new');
    else await rm(path.join(root,'owned','old.txt'));
    await assert.rejects(input.validate(),{code:'REVIEW_INPUT_CHANGED',file:`owned/${mutation==='add'?'new':'old'}.txt`});
  }
});
