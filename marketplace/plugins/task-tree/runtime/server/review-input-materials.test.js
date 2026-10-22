import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerReviewInputs,captureReviewInputs,materializeReviewInputs,REVIEW_INPUTS_TOOL} from './review-input-materials.js';

async function fixture(t) {
  const base=await mkdtemp(path.join(os.tmpdir(),'review-inputs-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const sourceRoot=path.join(base,'worker'),candidatePath=path.join(base,'candidate'),snapshotRoot=path.join(base,'snapshots');
  await Promise.all([sourceRoot,candidatePath].map(p=>mkdir(p)));
  return {base,sourceRoot,candidatePath,snapshotRoot};
}

test('registered ignored input is snapshotted before worker deletion, isolated and not confused with code',async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.sourceRoot,'corpus'));
  await writeFile(path.join(f.sourceRoot,'corpus/data.json'),'original input');
  await writeFile(path.join(f.sourceRoot,'not-selected.txt'),'not a dependency');
  assert.equal(REVIEW_INPUTS_TOOL.name,'task_tree_review_inputs');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['corpus']});
  const receipt=await captureReviewInputs({...f});
  await rm(f.sourceRoot,{recursive:true,force:true});
  const overlay=await materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]});
  assert.equal(await readFile(path.join(f.candidatePath,'corpus/data.json'),'utf8'),'original input');
  assert.equal((await stat(path.join(f.candidatePath,'corpus/data.json'))).mode&0o222,0);
  await assert.rejects(readFile(path.join(f.candidatePath,'not-selected.txt')),{code:'ENOENT'});
  assert.match(overlay.prompt,/corpus/);
  assert.match(overlay.prompt,/只读/);
  assert.match(overlay.prompt,/不要.*find/);
});

test('source changes after capture do not mutate final review input',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.sourceRoot,'dataset.txt'),'version one');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['dataset.txt']});
  const receipt=await captureReviewInputs(f);
  await writeFile(path.join(f.sourceRoot,'dataset.txt'),'version two');
  await materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]});
  assert.equal(await readFile(path.join(f.candidatePath,'dataset.txt'),'utf8'),'version one');
});

test('registration rejects missing paths, traversal, root selection and symlink escape',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.base,'outside'),'not scoped');
  await symlink(f.base,path.join(f.sourceRoot,'escape'));
  for(const p of ['missing','../outside','.','/tmp','escape/outside']){
    await assert.rejects(registerReviewInputs(f.sourceRoot,{action:'register',paths:[p]}),error=>
      ['REVIEW_INPUT_MISSING','REVIEW_INPUT_PATH_INVALID','REVIEW_INPUT_SYMLINK'].includes(error.code));
  }
  await assert.rejects(readFile(path.join(f.sourceRoot,'.task-tree-review-inputs.json')),{code:'ENOENT'});
});

test('nested symlink or credential files are not copied from a registered directory',async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.sourceRoot,'data'));
  await writeFile(path.join(f.sourceRoot,'data/ok.txt'),'ok');
  await writeFile(path.join(f.sourceRoot,'data/.env'),'SECRET');
  await symlink(f.base,path.join(f.sourceRoot,'data/escape'));
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['data']});
  await assert.rejects(captureReviewInputs(f),{code:'REVIEW_INPUT_SYMLINK'});
  await rm(path.join(f.sourceRoot,'data/escape'));
  const receipt=await captureReviewInputs(f);
  await materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]});
  await assert.rejects(readFile(path.join(f.candidatePath,'data/.env')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(f.candidatePath,'data/ok.txt'),'utf8'),'ok');
});

test('candidate code and conflicting branch inputs cannot be silently overwritten',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.sourceRoot,'data.txt'),'input');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['data.txt']});
  const one=await captureReviewInputs(f);
  await writeFile(path.join(f.candidatePath,'data.txt'),'candidate code');
  await assert.rejects(materializeReviewInputs({candidatePath:f.candidatePath,receipts:[one]}),{code:'REVIEW_INPUT_COLLISION'});
  assert.equal(await readFile(path.join(f.candidatePath,'data.txt'),'utf8'),'candidate code');
  await rm(path.join(f.candidatePath,'data.txt'));
  await writeFile(path.join(f.sourceRoot,'data.txt'),'different input');
  const two=await captureReviewInputs(f);
  await assert.rejects(materializeReviewInputs({candidatePath:f.candidatePath,receipts:[one,two]}),{code:'REVIEW_INPUT_COLLISION'});
});

test('missing registered source and tampered snapshot are explicit input failures, not model failures',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.sourceRoot,'data.txt'),'input');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['data.txt']});
  await rm(path.join(f.sourceRoot,'data.txt'));
  await assert.rejects(captureReviewInputs(f),{code:'REVIEW_INPUT_MISSING'});
  await writeFile(path.join(f.sourceRoot,'data.txt'),'input');
  const receipt=await captureReviewInputs(f);
  const manifest=JSON.parse(await readFile(receipt.manifestPath,'utf8'));
  const file=manifest.files[0];
  // Simulate disk corruption; snapshots are otherwise read-only.
  const {chmod}=await import('node:fs/promises');
  await chmod(path.join(receipt.snapshotRoot,'blobs',file.sha256),0o644);
  await writeFile(path.join(receipt.snapshotRoot,'blobs',file.sha256),'corrupt');
  await assert.rejects(materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]}),{code:'REVIEW_INPUT_SNAPSHOT_CHANGED'});
});

test('legacy runs without a declaration get precise source locations instead of an implicit filesystem search',async t=>{
  const f=await fixture(t);
  const receipt=await captureReviewInputs(f);
  assert.equal(receipt.fileCount,0);
  assert.equal(receipt.registered,false);
  const result=await materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]});
  assert.match(result.prompt,/未登记/);
  assert.ok(result.prompt.includes(f.sourceRoot));
  assert.match(result.prompt,/find/);
});

test('parallel registrations preserve each other and empty required directories survive',async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.sourceRoot,'empty'));
  await writeFile(path.join(f.sourceRoot,'one.txt'),'1');
  await writeFile(path.join(f.sourceRoot,'two.txt'),'2');
  await Promise.all(['empty','one.txt','two.txt'].map(file=>registerReviewInputs(f.sourceRoot,{action:'register',paths:[file]})));
  assert.deepEqual((await registerReviewInputs(f.sourceRoot,{action:'list'})).paths,['empty','one.txt','two.txt']);
  const receipt=await captureReviewInputs(f);
  await materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]});
  assert.ok((await stat(path.join(f.candidatePath,'empty'))).isDirectory());
});

test('candidate parent symlink never writes input outside the candidate',async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.sourceRoot,'data'));
  await writeFile(path.join(f.sourceRoot,'data/input.txt'),'input');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['data']});
  const receipt=await captureReviewInputs(f);
  await symlink(f.base,path.join(f.candidatePath,'data'));
  await assert.rejects(materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]}),{code:'REVIEW_INPUT_SYMLINK'});
  await assert.rejects(readFile(path.join(f.base,'input.txt')),{code:'ENOENT'});
});

test('candidate file versus input directory fails precisely and preserves candidate code',async t=>{
  const f=await fixture(t);
  await mkdir(path.join(f.sourceRoot,'data'));
  await writeFile(path.join(f.sourceRoot,'data/input.txt'),'input');
  await registerReviewInputs(f.sourceRoot,{action:'register',paths:['data']});
  const receipt=await captureReviewInputs(f);
  await writeFile(path.join(f.candidatePath,'data'),'candidate module');
  await assert.rejects(materializeReviewInputs({candidatePath:f.candidatePath,receipts:[receipt]}),{code:'REVIEW_INPUT_COLLISION'});
  assert.equal(await readFile(path.join(f.candidatePath,'data'),'utf8'),'candidate module');
});

test('100 independent input handoffs can capture and materialize concurrently',async t=>{
  const f=await fixture(t),started=performance.now();
  await Promise.all(Array.from({length:100},async(_,index)=>{
    const sourceRoot=path.join(f.base,`worker-${index}`),candidatePath=path.join(f.base,`review-${index}`);
    await Promise.all([sourceRoot,candidatePath].map(p=>mkdir(p)));
    const value=`dataset-${index}:`+'x'.repeat(32768);
    await writeFile(path.join(sourceRoot,'input.txt'),value);
    await registerReviewInputs(sourceRoot,{action:'register',paths:['input.txt']});
    const receipt=await captureReviewInputs({sourceRoot,snapshotRoot:f.snapshotRoot});
    await materializeReviewInputs({candidatePath,receipts:[receipt]});
    assert.equal(await readFile(path.join(candidatePath,'input.txt'),'utf8'),value);
  }));
  t.diagnostic(`100 independent local input handoffs: ${Math.round(performance.now()-started)} ms; this is filesystem concurrency, not a 100-model benchmark`);
});
