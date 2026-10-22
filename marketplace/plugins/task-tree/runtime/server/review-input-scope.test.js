import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';
import {createGitWorkspaceManager} from './parallel-worktree.js';
import {createParallelCodexCoordinator} from './codex-coordinator.js';

const tree='# LLM Task Graph\n## ROOT - 当前目标\n- Problem: 交付本任务结果\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
const shell=options=>options.onNotification({method:'tool/started',params:{toolName:'exec_command',arguments:{cmd:'verify declared inputs'}}});
const pass={status:'completed',output:'{"verdict":"pass","reason":"实际产物与声明输入已核对"}'};

for (const dependencyChanged of [false,true]) test(`explicit final-review scope protects dependencies and excludes ambient sourceCommit diffs (${dependencyChanged})`,async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-scope-direct-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await writeFile(path.join(root,'input.txt'),'input-v1');
  let calls=0;
  const samples=[];
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    calls++;
    shell(options);
    // This file also changed between the original run baseline and the final
    // snapshot, so summary.changedFiles contains it. It is another task.
    await writeFile(path.join(root,'other-task.txt'),`unrelated ${calls}`);
    if (dependencyChanged && calls===1) await writeFile(path.join(root,'input.txt'),'input-v2');
    if (dependencyChanged && calls===2) assert.equal(await readFile(path.join(options.cwd,'input.txt'),'utf8'),'input-v2');
    return pass;
  }});
  const state=await executor.prepare('scoped');
  await writeFile(path.join(root,'other-task.txt'),'unrelated initial');
  await writeFile(path.join(state.workerPath,'output.txt'),'owned result');
  const result=await executor.finish(state,{nodeId:'ROOT',objective:'交付本任务结果',status:'completed',
    reviewScopeFiles:['input.txt','output.txt'],onTiming:sample=>samples.push(sample)});
  assert.equal(result.review.verdict,'pass');
  assert.equal(calls,dependencyChanged?2:1);
  assert.ok(samples.some(sample=>sample.role==='review-dependencies'&&sample.strategy==='declared-complete-scope'));
  assert.equal(await readFile(path.join(root,'output.txt'),'utf8'),'owned result');
});

test('a persisted complete boundary survives coordinator reconstruction and final-check-only recovery',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-scope-restart-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await writeFile(path.join(root,'saved.txt'),'integrated');
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const checkpoint=await workspace.prepare('scoped-restart');
  await mkdir(path.join(root,'.task-tree-runs'));
  const record={id:'scoped-restart',status:'failed',workspace:checkpoint,incremental:true,finalReviewOnly:true,
    objective:'交付本任务结果',goal:{immediate:'交付本任务结果',history:[]},
    jobs:[{taskId:'done',nodeId:'ROOT',status:'completed',acceptanceStatus:'pending'}],events:[]};
  await writeFile(path.join(root,'.task-tree-runs','scoped-restart.json'),JSON.stringify(record));
  let reviews=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,
    startTurn:async()=>{throw new Error('must not replay completed workers');},reviewTurn:async options=>{
      reviews++;shell(options);
      await writeFile(path.join(root,'other-task.txt'),'concurrent unrelated change');
      return pass;
    }});
  const scope=['saved.txt'];
  await assert.rejects(coordinator.resume(record.id,{reviewScopeFiles:'saved.txt'}),/reviewScopeFiles/);
  await coordinator.resume(record.id,{reviewScopeFiles:scope});
  await coordinator.drain();
  assert.equal(reviews,1);
  const saved=JSON.parse(await readFile(path.join(root,'.task-tree-runs','scoped-restart.json'),'utf8'));
  assert.deepEqual(saved.reviewScopeFiles,scope);
  assert.equal(saved.status,'accepted',saved.error);
  // Simulate a second process taking over a persisted final-check checkpoint.
  saved.status='checking';
  saved.workspace=await workspace.prepare('second-recovery');
  await writeFile(path.join(root,'.task-tree-runs','scoped-restart.json'),JSON.stringify(saved));
  let recoveredReviews=0;
  const reconstructed=createParallelCodexCoordinator({projectRoot:root,workspace,
    startTurn:async()=>{throw new Error('must not replay completed workers after restart');},
    reviewTurn:async options=>{recoveredReviews++;shell(options);await writeFile(path.join(root,'other-task.txt'),'changed after restart');return pass;}});
  await reconstructed.get(record.id);await reconstructed.drain();
  const recovered=await reconstructed.snapshot(record.id);
  assert.deepEqual(recovered.reviewScopeFiles,scope);
  assert.equal(recovered.status,'accepted',recovered.error);
  assert.equal(recoveredReviews,1);
});

test('resume HTTP route validates and persists the explicit complete scope', {timeout:20000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-scope-http-'));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await mkdir(path.join(root,'.task-tree-runs'));
  await writeFile(path.join(root,'.task-tree-runs','scope-http.json'),JSON.stringify({id:'scope-http',status:'failed',
    jobs:[],events:[],goal:{immediate:'read-only review',history:[]}}));
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server.js')],{env:{...process.env,
    PORT:'0',TASK_TREE_PROJECT_ROOT:root,TASK_TREE_NO_OPEN:'1',CODEX_HOME:path.join(root,'codex'),
    TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),TASK_TREE_API_CONNECTIONS_FILE:path.join(root,'api.json')},
    stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
    await rm(root,{recursive:true,force:true});
  });
  const base=await new Promise((resolve,reject)=>{
    let log='';const timer=setTimeout(()=>reject(new Error('startup timed out')),10000);
    child.once('error',reject);
    child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  const post=scope=>fetch(base+'/api/codex/parallel/scope-http/resume',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({reviewScopeFiles:scope})});
  const rejected=await post('bad');assert.equal(rejected.status,400);assert.match(await rejected.text(),/reviewScopeFiles/);
  const scope=['docs/owned/**','trees/owned.md'];
  const accepted=await post(scope);assert.equal(accepted.status,202,await accepted.clone().text());
  assert.deepEqual((await accepted.json()).run.reviewScopeFiles,scope);
  const saved=JSON.parse(await readFile(path.join(root,'.task-tree-runs','scope-http.json'),'utf8'));
  assert.deepEqual(saved.reviewScopeFiles,scope);
});
