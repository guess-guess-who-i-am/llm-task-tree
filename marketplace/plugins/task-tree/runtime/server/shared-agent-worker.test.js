import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {workerRuntimeRevision} from './runtime-revision.js';
import {sharedAgentSocket} from './shared-agent-worker.js';

test('warm worker identity follows actual executable revision rather than a manually bumped constant',async()=>{
  const home=path.resolve('/tmp/context-worker-generation-test');
  const revision=await workerRuntimeRevision(path.resolve(import.meta.dirname,'..'));
  const digest=createHash('sha256').update(`${home}:runtime:${revision}`).digest('hex').slice(0,20);
  assert.ok(sharedAgentSocket(home).includes(digest),'updated clients must not silently reuse an older loaded runtime');
});
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgentRuntime } from './shared-agent-worker.js';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { historySnapshot } from './history-retrieval.js';

test('concurrent worker sessions resolve relative skills and keep caller command paths with bundled rg',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'shared-worker-tools-'));
  const home=path.join(root,'home'),cwd=path.join(root,'project'),socketPath=path.join(root,'worker.sock');
  const skill='llm-task-tree/skills/demo/SKILL.md';
  await mkdir(home);await mkdir(path.dirname(path.join(cwd,skill)),{recursive:true});
  await writeFile(path.join(cwd,skill),'---\nname: demo\n---\n完整方法');
  await writeFile(path.join(cwd,'marker.txt'),'双录入测试');
  let runtimes=[];
  t.after(async()=>{
    await Promise.all(runtimes.map(r=>r.close()));
    if(runtimes[0])try{process.kill(runtimes[0].worker.pid,'SIGTERM');}catch{}
    await rm(root,{recursive:true,force:true});
  });
  runtimes=await Promise.all(Array.from({length:4},(_,i)=>createSharedAgentRuntime({cwd,homeDir:home,codexHome:home,socketPath,
    environment:{PATH:path.join(root,`caller-${i}`)}})));
  assert.equal(new Set(runtimes.map(r=>r.worker.pid)).size,1);
  const started=performance.now();
  await Promise.all(runtimes.map(async(r,i)=>{
    const [method,search,env]=await Promise.all([
      r.call('skills_read',{name:skill}),r.call('exec_command',{command:'rg -n 双录入 marker.txt'}),
      r.call('exec_command',{command:`"${process.execPath}" -e 'console.log(process.env.PATH)'`})]);
    assert.equal(method.content,'---\nname: demo\n---\n完整方法');
    assert.equal(search.ok,true,search.stderr);assert.match(search.stdout,/1:双录入测试/);
    assert.ok(env.stdout.trim().split(path.delimiter).includes(path.join(root,`caller-${i}`)));
    assert.ok(!env.stdout.trim().split(path.delimiter).includes(path.join(root,`caller-${(i+1)%4}`)));
  }));
  console.log(JSON.stringify({parallelToolCalls:12,totalMs:performance.now()-started}));
});

test('shared history RPC isolates concurrent nodes, reuses indexes and rebuilds from durable dialogue after restart',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'history-rpc-')),home=path.join(root,'home');await mkdir(home);
  const socketPath=path.join(root,'worker.sock'),runtimes=[];let pid;
  const open=async()=>{
    const r=await createSharedAgentRuntime({cwd:root,codexHome:home,homeDir:home,socketPath});
    runtimes.push(r);pid=r.worker.pid;return r;
  };
  t.after(async()=>{await Promise.all(runtimes.map(r=>r.close()));if(pid)try{process.kill(pid,'SIGTERM');}catch{}});
  const [a,b,c]=await Promise.all([open(),open(),open()]);
  const threadId='deepseek-'+randomUUID(),archive=[{role:'user',content:'讨论导出'},
    {role:'assistant',content:'  CSV完整原文\n中文保留。  '},{role:'user',content:'可以'}];
  await a.saveDialogue(threadId,archive);
  const snapshot=historySnapshot(archive,{project:root,node:'A',threadId});
  const [readA,readB,readC]=await Promise.all([
    a.openHistory(snapshot),b.openHistory(snapshot),
    c.openHistory(historySnapshot([{role:'user',content:'节点C独有内容'}],{project:root,node:'C'}))
  ]);
  const [x,y,z]=await Promise.all([readA('history_search',{query:'CSV'}),readB('history_search',{query:'CSV'}),readC('history_search',{query:'CSV'})]);
  assert.deepEqual(x.sources.map(s=>s.content),archive.map(s=>s.content));
  assert.equal(y.indexReused,true);assert.equal(z.sources.length,0);
  await assert.rejects(readC('history_read',{sourceIds:x.sourceIds}),/UNKNOWN_HISTORY_SOURCE/);
  const all=await Promise.all(Array.from({length:100},()=>readA('history_search',{query:'CSV'})));
  assert.ok(all.every(r=>r.indexMs===0&&r.modelCalls===0));
  await Promise.all(runtimes.map(r=>r.close()));process.kill(pid,'SIGTERM');
  for(let i=0;i<100;i++){
    let alive;try{process.kill(pid,0);alive=true;}catch{alive=false;}
    if(!alive)break;await new Promise(r=>setTimeout(r,20));
  }
  const next=await open(),saved=await next.loadDialogue(threadId);
  assert.deepEqual(saved,archive);
  const restored=await next.openHistory(historySnapshot(saved,{project:root,node:'A',threadId}));
  const result=await restored('history_search',{query:'CSV'});
  assert.equal(result.indexReused,false);assert.deepEqual(result.sourceIds,x.sourceIds);
  const edited=await next.openHistory(historySnapshot([...saved.slice(0,-1),{role:'user',content:'改为 JSON'}],{project:root,node:'A',threadId}));
  await assert.rejects(edited('history_read',{sourceIds:x.sourceIds}),/UNKNOWN_HISTORY_SOURCE/);
});

test('shared worker RPC keeps an hour-long tool alive; manual stop still closes only that caller',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'long-rpc-')),socketPath=path.join(root,'worker.sock');
  let release,ready;const called=new Promise(r=>ready=r);const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');let buffer='';
    socket.on('data',chunk=>{buffer+=chunk;for(;;){const at=buffer.indexOf('\n');if(at<0)break;
      const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(message.method==='open')socket.write(JSON.stringify({id:message.id,result:{tools:[]}})+'\n');
      else {release=()=>socket.write(JSON.stringify({id:message.id,result:{ok:true}})+'\n');ready();}
    }});
  });
  await new Promise(r=>server.listen(socketPath,r));
  const controller=new AbortController(),runtime=await createSharedAgentRuntime({cwd:root,socketPath,signal:controller.signal});
  t.after(async()=>{await runtime.close();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));});
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const operation=runtime.call('long_tool',{});await called;t.mock.timers.tick(3600000);release();
  assert.deepEqual(await operation,{ok:true});
  const cancelled=runtime.call('other_tool',{});controller.abort();await assert.rejects(cancelled,/关闭|abort/i);
});

test('eight callers in two projects share a worker and warm MCP; cancellation and projects stay isolated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shared-agent-'));
  const home = path.join(root, 'home'); await mkdir(home);
  const projects = await Promise.all(['a','b'].map(async name => {
    const cwd = path.join(root, name); await mkdir(cwd);
    await writeFile(path.join(cwd, 'task-tree.md'), `# LLM Task Graph\n\n## ROOT - ${name}\n- Completion: 进行中\n- Problem: ${name}\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n`);
    await writeFile(path.join(cwd, 'marker.txt'), name); return cwd;
  }));
  const socketPath = path.join(root, 'worker.sock');
  const controllers = Array.from({length:8}, () => new AbortController());
  const started = performance.now();
  const runtimes = await Promise.all(controllers.map((c,i) => createSharedAgentRuntime({cwd:projects[i%2],codexHome:home,homeDir:home,socketPath,signal:c.signal})));
  let finalPid=runtimes[0].worker.pid;
  t.after(async () => { await Promise.all(runtimes.map(r => r.close())); try { process.kill(finalPid, 'SIGTERM'); } catch {} });
  assert.equal(new Set(runtimes.map(r => r.worker.pid)).size, 1);
  const values = await Promise.all(runtimes.map(r => r.call('read_file',{path:'marker.txt'})));
  values.forEach((v,i) => assert.equal(v.content, i%2 ? 'b' : 'a'));
  const focus = await Promise.all(runtimes.map(r => r.call('task_tree_focus',{})));
  focus.forEach((v,i) => assert.equal(v.projectRoot,projects[i%2]));
  const cancelledCall = runtimes[0].call('exec_command', { command: `"${process.execPath}" -e 'require("node:fs").writeFileSync("active-tool.pid",String(process.pid));setTimeout(()=>{},30000)'` }).then(() => false, () => true);
  let toolPid;
  for (let i = 0; i < 100 && !toolPid; i++) {
    toolPid = Number(await readFile(path.join(projects[0], 'active-tool.pid'), 'utf8').catch(() => ''));
    if (!toolPid) await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(toolPid, 'real tool process must be running before cancellation');
  controllers[0].abort();
  assert.equal(await cancelledCall, true);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(toolPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(alive, false, 'cancel kills the active tool process, not just its progress polling');
  await assert.rejects(runtimes[0].call('read_file',{path:'marker.txt'}));
  assert.equal((await runtimes[2].call('read_file',{path:'marker.txt'})).content,'a');
  await Promise.all(runtimes.map(r => r.close()));
  const warmStart = performance.now();
  const warm = await createSharedAgentRuntime({cwd:projects[0],codexHome:home,homeDir:home,socketPath});
  assert.equal(warm.worker.pid,runtimes[0].worker.pid);
  assert.equal(warm.worker.bridgeCount,2);
  assert.equal(warm.worker.bridgeStarts,2);
  console.log(JSON.stringify({coldEightMs:performance.now()-started,warmMs:performance.now()-warmStart,pid:warm.worker.pid,bridgeStarts:warm.worker.bridgeStarts}));
  await warm.close();
  // Global instructions are not frozen in the service: a new turn reads updates.
  await writeFile(path.join(home,'AGENTS.md'),'UPDATED_GLOBAL_INSTRUCTIONS');
  const updated = await createSharedAgentRuntime({cwd:projects[1],codexHome:home,homeDir:home,socketPath});
  assert.match(updated.systemPrompt,/UPDATED_GLOBAL_INSTRUCTIONS/);
  const threadId='deepseek-'+randomUUID();
  const contextCache={schema:'deepseek-context/v1',sourceCount:1,fingerprint:'fixture',summary:'目标与进度摘要'};
  await updated.saveDialogue(threadId,[{role:'user',content:'完整文字'},{role:'tool',content:'不存工具'},{role:'assistant',content:'已完成',tool_calls:[{id:'omit'}]}],contextCache);
  await updated.close();
  process.kill(finalPid,'SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,100));
  const recovered=await createSharedAgentRuntime({cwd:projects[0],codexHome:home,homeDir:home,socketPath});
  finalPid=recovered.worker.pid;
  assert.notEqual(finalPid,runtimes[0].worker.pid);
  assert.deepEqual(await recovered.loadDialogue(threadId),[{role:'user',content:'完整文字'},{role:'assistant',content:'已完成'}]);
  assert.deepEqual(await recovered.loadContext(threadId),contextCache);
  await recovered.close();
});

test('warm MCP transports are isolated by quality mode for both arrival orders', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'shared-quality-'));
  const home=path.join(root,'home');await mkdir(home);
  const socketPath=path.join(root,'worker.sock'), runtimes=[];
  let pid;
  t.after(async()=>{await Promise.all(runtimes.map(r=>r.close()));if(pid)try{process.kill(pid,'SIGTERM');}catch{}});
  for(const [index,modes] of [['a',['strict','advisory','strict']],['b',['advisory','strict','advisory']]]) {
    const cwd=path.join(root,index);await mkdir(cwd);
    await writeFile(path.join(cwd,'task-tree.md'),'# LLM Task Graph\n\n## ROOT - 根\n- Notes: '+'完整文字'.repeat(3000)+'\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n');
    for(const mode of modes) {
      const runtime=await createSharedAgentRuntime({cwd,codexHome:home,homeDir:home,socketPath,environment:{TASK_TREE_QUALITY_MODE:mode}});
      runtimes.push(runtime);pid=runtime.worker.pid;
      const checked=await runtime.call('task_tree_check_compact',{});
      assert.equal(checked.ok,mode==='advisory',`mode ${mode} must not reuse a different policy MCP process`);
      assert.ok(checked.violations.length);
      await runtime.close();
    }
  }
  const warm=await createSharedAgentRuntime({cwd:path.join(root,'a'),codexHome:home,homeDir:home,socketPath,environment:{TASK_TREE_QUALITY_MODE:'strict'}});
  runtimes.push(warm);
  assert.equal(warm.worker.bridgeStarts,4,'two projects times two policies; same policy stays warm');
});
