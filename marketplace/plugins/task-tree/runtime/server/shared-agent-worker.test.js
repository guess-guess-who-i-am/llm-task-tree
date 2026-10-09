import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgentRuntime } from './shared-agent-worker.js';
import { randomUUID } from 'node:crypto';

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
  controllers[0].abort();
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
  await updated.saveDialogue(threadId,[{role:'user',content:'完整文字'},{role:'tool',content:'不存工具'},{role:'assistant',content:'已完成',tool_calls:[{id:'omit'}]}]);
  await updated.close();
  process.kill(finalPid,'SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,100));
  const recovered=await createSharedAgentRuntime({cwd:projects[0],codexHome:home,homeDir:home,socketPath});
  finalPid=recovered.worker.pid;
  assert.notEqual(finalPid,runtimes[0].worker.pid);
  assert.deepEqual(await recovered.loadDialogue(threadId),[{role:'user',content:'完整文字'},{role:'assistant',content:'已完成'}]);
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
