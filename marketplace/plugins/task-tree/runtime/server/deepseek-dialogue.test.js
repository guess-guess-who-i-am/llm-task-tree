import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDeepSeekTurn } from './deepseek-run.js';
import { createSharedAgentRuntime } from './shared-agent-worker.js';

test('provider-native workers resume and fork full saved dialogue without reusing tool messages',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'deepseek-durable-'));
  const codexHome=path.join(cwd,'codex');await mkdir(codexHome);
  await writeFile(path.join(cwd,'marker.txt'),'tool-only-sentinel');
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let s='';for await(const chunk of req)s+=chunk;const body=JSON.parse(s);requests.push(body);
    const message=requests.length===1
      ? {content:'先读取文件',tool_calls:[{id:'read1',type:'function',function:{name:'read_file',arguments:'{"path":"marker.txt"}'}}]}
      : {content:requests.length===2?'first answer':requests.length===6?'{"tool":"search","query":"transient"}':'continued answer'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let pid;
  t.after(async()=>{await new Promise(r=>server.close(r));if(pid)try{process.kill(pid,'SIGTERM');}catch{}});
  const options={cwd,waitForCompletion:true,environment:{CODEX_HOME:codexHome,MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${server.address().port}`,MODEL_AGENT_MAIN_API_KEY:'test',MODEL_AGENT_MAIN_MODEL:'test'}};
  const first=await startDeepSeekTurn({...options,prompt:'first user'});pid=first.timing.workerPid;
  assert.equal(first.status,'completed',JSON.stringify(first.error));
  assert.ok(requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('tool-only-sentinel')));
  const persisted=await readFile(path.join(codexHome,'task-tree-dialogues',`${first.threadId}.json`),'utf8');
  assert.ok(!persisted.includes('tool-only-sentinel'));assert.ok(!persisted.includes('tool_calls'));
  const second=await startDeepSeekTurn({...options,prompt:'second user',threadId:first.threadId});
  assert.equal(second.status,'completed',JSON.stringify(second.error));
  const history=requests[2].messages.filter(m=>m.role!=='system');
  assert.deepEqual(history,[{role:'user',content:'first user'},{role:'assistant',content:'先读取文件'},{role:'assistant',content:'first answer'},{role:'user',content:'second user'}]);
  const fork=await startDeepSeekTurn({...options,prompt:'fork user',forkThreadId:first.threadId});
  assert.equal(fork.status,'completed',JSON.stringify(fork.error));assert.notEqual(fork.threadId,first.threadId);
  assert.ok(requests[3].messages.some(m=>m.role==='user'&&m.content==='second user'));
  assert.equal(requests[3].messages.at(-1).content,'fork user');
  const isolated=await startDeepSeekTurn({...options,prompt:'real question',messages:[{role:'user',content:'TOOL_RESULT search with transient retrieved context'},{role:'user',content:'real question'}],dialogueContext:[{role:'user',content:'real question'}]});
  assert.equal(isolated.status,'completed',JSON.stringify(isolated.error));
  const actual=JSON.parse(await readFile(path.join(codexHome,'task-tree-dialogues',isolated.threadId+'.json'),'utf8'));
  assert.deepEqual(actual.messages,[{role:'user',content:'real question'},{role:'assistant',content:'continued answer'}]);
  const legacyTool=await startDeepSeekTurn({...options,prompt:'real question',dialogueContext:[{role:'user',content:'real question'}],persistAnswer:answer=>!answer.includes('"tool":"search"')});
  assert.equal(legacyTool.status,'completed',JSON.stringify(legacyTool.error));
  const legacyDisk=JSON.parse(await readFile(path.join(codexHome,'task-tree-dialogues',legacyTool.threadId+'.json'),'utf8'));
  assert.deepEqual(legacyDisk.messages,[{role:'user',content:'real question'}]);
});

test('HTTP gateway and shared-worker restart preserve full dialogue and reuse its summary after fifty tool rounds', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'deepseek-context-http-'));
  const codexHome = path.join(cwd, 'codex'); await mkdir(codexHome);
  const requests = []; let modelRounds = 0, writes = 0, pid;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const message = body.stream === false ? { content: '目标：保留完整对话；已经成功保存的序号不得重复；下一步继续未完成序号。' }
      : ++modelRounds <= 50 ? { content: null, tool_calls: [{ id: `write-${modelRounds}`, type: 'function', function: { name: 'save_item', arguments: JSON.stringify({ index: modelRounds }) } }] }
      : { content: '完成了全部50项，原始对话可导出。' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (pid) try { process.kill(pid, 'SIGTERM'); } catch {} });
  const options = { cwd, waitForCompletion: true, runtimeToolNames: [],
    environment: { CODEX_HOME: codexHome, MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${server.address().port}`, MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '32000' },
    runtimeFactory: settings => createSharedAgentRuntime({ ...settings, homeDir: codexHome }),
    tools: [{ type: 'function', function: { name: 'save_item', description: '保存一个序号', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] } } }],
    toolHandler: async (_, { index }) => { assert.equal(index, ++writes); return { ok: true, index, receipt: '临时工具明细'.repeat(120) }; } };
  const messages = [...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史${i}：` + '完整中文原文'.repeat(600) })), { role: 'user', content: '完成50项后停止，保留所有历史原文。' }];
  const first = await startDeepSeekTurn({ ...options, messages }); pid = first.timing.workerPid;
  assert.equal(first.status, 'completed', JSON.stringify(first.error));
  assert.equal(writes, 50); assert.equal(first.timing.tools.length, 50);
  assert.ok(first.timing.compactions.length >= 2, 'both loaded dialogue and accumulated tool results compact');
  const file = path.join(codexHome, 'task-tree-dialogues', `${first.threadId}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.messages.slice(0, messages.length), messages);
  assert.ok(stored.contextCache.summary);
  assert.ok(!JSON.stringify(stored).includes('临时工具明细'));
  const summaries = requests.filter(body => body.stream === false).length;
  process.kill(pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 100));
  const second = await startDeepSeekTurn({ ...options, threadId: first.threadId, prompt: '请继续原有对话' }); pid = second.timing.workerPid;
  assert.equal(second.status, 'completed', JSON.stringify(second.error));
  assert.equal(requests.filter(body => body.stream === false).length, summaries, 'persisted summary reused after real broker restart');
  assert.ok(requests.at(-1).messages.some(m => m.content?.includes('历史上下文摘要')));
  assert.ok(requests.at(-1).messages.some(m => m.content === '请继续原有对话'));
  assert.equal(writes, 50);
});
