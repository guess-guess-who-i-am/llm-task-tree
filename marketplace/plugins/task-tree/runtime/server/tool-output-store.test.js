import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectCommandOutput} from './tool-output-store.js';

async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'tool-output-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('small receipts and non-command data keep their exact inline representation',async t=>{
  const codexHome=await fixture(t);
  for(const original of [{ok:true,stdout:'完整短输出\n',stderr:''},{content:'不可外置的方法'.repeat(10000)},null]){
    assert.equal((await projectCommandOutput(original,{inlineTokenBudget:1000,codexHome})).content,JSON.stringify(original));
  }
  await assert.rejects(stat(path.join(codexHome,'task-tree-tool-output')),{code:'ENOENT'});
});
test('multi-megabyte failures preserve both streams, full receipt, Unicode tails and Hook metadata',async t=>{
  const codexHome=await fixture(t);
  const original={ok:false,exitCode:127,timedOut:false,stdout:'历史记录🙂\n'.repeat(180000)+'最后的必要事实',stderr:'错误：命令不存在\n',hookContext:'必须保留的方法',hookBlocked:true};
  const projected=await projectCommandOutput(original,{inlineTokenBudget:50000,codexHome});
  const view=JSON.parse(projected.content);
  assert.equal(view.exitCode,127);assert.equal(view.ok,false);assert.equal(view.hookBlocked,true);assert.equal(view.hookContext,original.hookContext);
  assert.equal(view.archivedOutput.complete,true);
  assert.equal(await readFile(view.archivedOutput.stdoutPath,'utf8'),original.stdout);
  assert.equal(await readFile(view.archivedOutput.stderrPath,'utf8'),original.stderr);
  const raw=await readFile(view.archivedOutput.receiptPath,'utf8');
  assert.equal(raw,JSON.stringify(original));
  assert.equal(createHash('sha256').update(raw).digest('hex'),view.archivedOutput.sha256);
  assert.ok(Buffer.byteLength(projected.content)<5000);
  if(process.platform!=='win32')assert.equal((await stat(view.archivedOutput.receiptPath)).mode&0o777,0o600);
});
test('parallel output archives never overwrite one another',async t=>{
  const codexHome=await fixture(t);
  const results=await Promise.all(Array.from({length:16},async(_,i)=>{
    const original={ok:true,stdout:('分支'+i+'\n').repeat(1000),stderr:''};
    const result=await projectCommandOutput(original,{inlineTokenBudget:100,codexHome});
    assert.equal(await readFile(result.archive.stdoutPath,'utf8'),original.stdout);
    return result.archive.receiptPath;
  }));
  assert.equal(new Set(results).size,16);
});
test('an archive storage failure retains the entire inline output instead of retrying a command or losing data',async t=>{
  const root=await fixture(t),codexHome=path.join(root,'not-a-directory');await writeFile(codexHome,'keep');
  const original={ok:true,stdout:'保留所有输出'.repeat(10000),stderr:''};
  const result=await projectCommandOutput(original,{inlineTokenBudget:100,codexHome});
  assert.equal(result.content,JSON.stringify(original));assert.equal(typeof result.error,'string');
});
