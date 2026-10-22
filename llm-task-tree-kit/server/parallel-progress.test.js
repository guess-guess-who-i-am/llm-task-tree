import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import {createServer} from 'node:http';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createParallelCodexCoordinator } from './codex-coordinator.js';

test('public parallel start forwards the same objective and delivery acceptance contract as adaptive planning',async t=>{
  const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
  const routes=source.slice(source.indexOf('    if (reqPath === "/api/codex/parallel" && req.method === "POST")'),source.indexOf('    const parallelResume ='));
  let captured;
  const handler=vm.runInNewContext(`(async function(req,res){const reqPath='/api/codex/parallel';${routes}})`,{
    parallelCodex:{start:async(jobs,options)=>{captured={jobs,options};return {id:'started'};}},
    readBody:async req=>{let raw='';for await(const c of req)raw+=c;return raw;},
    jsonResponse:(res,status,payload)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));}
  });
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const input={jobs:[{taskId:'A',nodeId:'ROOT',instruction:'完成业务节点',deliverables:[{path:'business.md',mode:'update',nodeIds:['A']}]}],
    objective:'用户实际目标',sharedContract:'共享接口',acceptanceCriteria:['业务节点落盘'],coverage:[{requirement:'用户实际目标',taskIds:['A']}],treeId:'business',subtree:'subtrees/business.md',nodeId:'ROOT'};
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/codex/parallel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,202);
  assert.deepEqual(JSON.parse(JSON.stringify(captured)),{jobs:input.jobs,options:Object.fromEntries(Object.entries(input).filter(([key])=>key!=='jobs'))});
});

test('progress projects before serialization; selected detail and legacy snapshot retain complete text', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'parallel-progress-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.task-tree-runs'));
  const output='完整输出😀'.repeat(5000);
  const saved={id:'progress-test',status:'checking',goal:{immediate:'完成',stageNodeId:'ROOT',history:[output]},
    events:[{output}],result:{patchPreview:output,cleanup:{status:'running',output}},
    jobs:Array.from({length:82},(_,i)=>({taskId:`job-${i}`,title:`任务 ${i}`,status:'completed',summary:'摘要',
      instruction:'完整任务',activity:{label:'完成'},startedAt:'2026-01-01',output,liveOutput:output,branchContext:output,
      workerPath:'private-path',commit:'private-commit',sourceCommit:'private-source'})),
    userMessages:[{taskId:'job-0',content:output},{taskId:'job-1',content:'other'}],
    peerMessages:[{fromTaskId:'job-1',toTaskId:'job-0',question:output},{fromTaskId:'job-1',toTaskId:'job-2',question:'other'}]};
  await writeFile(path.join(root,'.task-tree-runs',`${saved.id}.json`),JSON.stringify(saved));
  const coordinator=createParallelCodexCoordinator({projectRoot:root});
  const legacy=await coordinator.snapshot(saved.id);
  const progress=await coordinator.snapshot(saved.id,{view:'progress'});
  assert.equal(progress.jobs.length,82);
  assert.equal(progress.status,'checking');
  assert.equal(progress.jobs[0].summary,'摘要');
  assert.equal(progress.jobs[0].reportChars,output.length);
  for(const field of ['output','liveOutput','branchContext','instruction'])assert.equal(progress.jobs[0][field],undefined,field);
  assert.equal(progress.events,undefined);
  assert.equal(progress.goal.history,undefined);
  assert.deepEqual(progress.result,{cleanup:{status:'running'}});
  assert.ok(Buffer.byteLength(JSON.stringify(progress))<Buffer.byteLength(JSON.stringify(legacy))/20);
  const detail=await coordinator.getJob(saved.id,'job-0');
  assert.equal(detail.job.output,output);
  assert.equal(detail.job.liveOutput,output);
  assert.equal(detail.job.instruction,'完整任务');
  assert.equal(detail.job.workerPath,undefined);
  assert.equal(detail.userMessages.length,1);
  assert.equal(detail.peerMessages.length,1);
  assert.equal(legacy.jobs[0].output,output);
  assert.equal(await coordinator.getJob(saved.id,'missing'),null);
  assert.equal(await coordinator.snapshot('missing',{view:'progress'}),null);
  console.log(JSON.stringify({fullBytes:Buffer.byteLength(JSON.stringify(legacy)),progressBytes:Buffer.byteLength(JSON.stringify(progress)),detailBytes:Buffer.byteLength(JSON.stringify(detail))}));
});

test('HTTP progress, legacy and selected-job routes keep distinct contracts and return errors',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'parallel-progress-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.task-tree-runs'));
  const output='没有截断的完整输出'.repeat(4000);
  await writeFile(path.join(root,'.task-tree-runs/http-test.json'),JSON.stringify({id:'http-test',status:'failed',goal:{immediate:'目标',history:[]},jobs:[{taskId:'task.a',status:'completed',instruction:'任务',output}]}));
  const coordinator=createParallelCodexCoordinator({projectRoot:root});
  const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
  const routes=source.slice(source.indexOf('    const parallelJobMatch ='),source.indexOf('    if (reqPath === "/api/shutdown"'));
  const handler=vm.runInNewContext(`(async function(req,res){const reqPath=new URL(req.url,'http://localhost').pathname;${routes}res.writeHead(404);res.end();})`,{
    URL,parallelCodex:coordinator,jsonResponse:(res,status,payload)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));}});
  const server=createServer((req,res)=>handler(req,res).catch(error=>{res.writeHead(500);res.end(error.message);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const request=async suffix=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/codex/parallel/${suffix}`);return {status:response.status,body:await response.json()};};
  const compact=await request('http-test?view=progress');
  assert.equal(compact.status,200);
  assert.equal(compact.body.run.jobs[0].output,undefined);
  assert.equal(compact.body.run.jobs[0].summary,'任务');
  assert.equal((await request('http-test')).body.run.jobs[0].output,output);
  assert.equal((await request('http-test/jobs/task.a')).body.job.output,output);
  for(const suffix of ['missing?view=progress','http-test/jobs/missing','missing/jobs/task.a'])assert.equal((await request(suffix)).status,404);
  assert.equal((await request('http-test?view=invalid')).status,400);
});
