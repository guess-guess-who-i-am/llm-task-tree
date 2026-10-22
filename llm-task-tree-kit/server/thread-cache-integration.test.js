import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGitWorkspaceManager,gitCommand} from './parallel-worktree.js';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';
const graph='# LLM Task Graph\n## ROOT - 并发实验\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
test('eight independent artifacts do not invoke model conflict resolution for refreshed thread-list caches',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'width-thread-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),graph);
  const cache=JSON.stringify({fetchedAt:1,threads:[]});
  await writeFile(path.join(root,'.task-tree-threads.json'),cache);
  // Include an old tracked cache: adding an ignore entry alone cannot fix it.
  await gitCommand(root,['init','-q']);
  await gitCommand(root,['add','.']);
  await gitCommand(root,['-c','user.name=Test','-c','user.email=test@local','commit','-qm','initial']);
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const executor=createDirectNodeWorkspace({projectRoot:root,workspace,reviewTurn:null,
    startTurn:async()=>{throw Error('cache-only conflict must never call a model');}});
  const states=await Promise.all(Array.from({length:8},(_,i)=>executor.prepare(`branch-${i}`)));
  for(let i=0;i<8;i++){
    await writeFile(path.join(states[i].workerPath,`part${i}.txt`),`result${i}`);
    await writeFile(path.join(states[i].workerPath,'.task-tree-threads.json'),JSON.stringify({fetchedAt:i+2,threads:[]}));
  }
  const receipts=await Promise.all(states.map((s,i)=>executor.finish(s,{nodeId:'ROOT',status:'completed',objective:`part${i}`})));
  assert.deepEqual(receipts.map(r=>r.appliedFiles.sort()),Array.from({length:8},(_,i)=>[`part${i}.txt`]));
  assert.equal(await readFile(path.join(root,'.task-tree-threads.json'),'utf8'),cache);
  for(let i=0;i<8;i++)assert.equal(await readFile(path.join(root,`part${i}.txt`),'utf8'),`result${i}`);
  assert.match(await gitCommand(root,['show','HEAD:.task-tree-threads.json']),/fetchedAt/,'live Git history is retained, not deleted');
});
