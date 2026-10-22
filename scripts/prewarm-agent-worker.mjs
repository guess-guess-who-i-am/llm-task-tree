import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgentRuntime } from '../server/shared-agent-worker.js';
import { warmGraphPool } from './graph-pool-prewarm.mjs';

const codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
const graph=path.join(codexHome,'skill-registry/skills.graph.json');
const python=path.join(codexHome,'tools/graph-tool-call-venv/bin/python');
const indexer=path.join(codexHome,'hooks/graph_skill_index.py');
const digest=createHash('sha256').update(graph).digest('hex').slice(0,24);
const socketPath=path.join('/tmp',`codex-graph-${process.getuid()}`,`${digest}.sock`);
let lastGraphPid;
function queryGraph(query='') {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);let buffer='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('GraphToolCall prewarm timeout')),55_000);
    socket.setEncoding('utf8');socket.on('error',error=>finish(error));socket.on('close',()=>finish(new Error('Graph worker closed')));
    socket.on('connect',()=>socket.write(JSON.stringify({query,top_k:1,deadline:Date.now()+55_000})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\n'))return;try{const value=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));finish(value.ok?null:new Error(value.error),value);}catch(error){finish(error);}});
  });
}
async function prewarm() {
  const started=performance.now();
  const runtime=await createSharedAgentRuntime({cwd:process.env.TASK_TREE_PREWARM_PROJECT || path.resolve(import.meta.dirname,'..'),codexHome});
  const tools=runtime.worker;await runtime.close();
  let retrieval;
  if(existsSync(graph)&&existsSync(python)&&existsSync(indexer)) {
    try { retrieval=await queryGraph(); } catch(error) {
      if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;
      await mkdir(path.dirname(socketPath),{recursive:true,mode:0o700});
      const child=spawn(python,[indexer,'serve','--graph',graph,'--socket',socketPath,'--idle-timeout','0'],{detached:true,stdio:'ignore'});
      child.on('error',()=>{});child.unref();
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){try{retrieval=await queryGraph();break;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,100));}}
      if(!retrieval)throw new Error('Graph worker did not start');
    }
    if(retrieval.pid!==lastGraphPid || retrieval.loads===0) {
      retrieval=await warmGraphPool(queryGraph);
      lastGraphPid=retrieval.pid;
    }
  }
  console.log(JSON.stringify({ready:true,durationMs:Math.round(performance.now()-started),tools,...(retrieval?{graphPid:retrieval.pid,graphLoads:retrieval.loads,warmedProcesses:retrieval.warmedProcesses,warmedProcessPids:retrieval.warmedProcessPids}:{})}));
}
await prewarm();
if(process.argv.includes('--keep-alive')) {
  // Only reheat when a worker has restarted; status queries do not perform retrieval.
  setInterval(()=>void prewarm().catch(e=>console.error(e.message)),60_000);
}
