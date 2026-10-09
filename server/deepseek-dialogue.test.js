import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDeepSeekTurn } from './deepseek-run.js';

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
