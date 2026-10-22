import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, chmod, lstat, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from './agent-runtime.js';
import { createTaskTreeAgentTools } from './task-tree-agent-tools.js';
import { loadThreadDialogue, loadThreadContext, saveThreadDialogue } from './thread-dialogue-store.js';
import { historySnapshot, createHistoryIndexCache, createHistorySession } from './history-retrieval.js';
import { workerRuntimeRevision } from './runtime-revision.js';

// One executable-generation snapshot per process, not per request. New IDE
// builds cannot attach to a broker still holding an old module/tool catalog;
// in-flight sessions keep their old broker and are never interrupted.
const workerRevision=await workerRuntimeRevision(path.resolve(import.meta.dirname,'..'));

// One private, per-user broker shared by every IDE project. The graph retriever
// remains the existing Codex worker; this broker reuses MCP transports and indexes.
export function sharedAgentSocket(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  // Changed timeout/tool contract must not silently reuse an old in-memory
  // runtime after an IDE upgrade. All upgraded projects still share one broker.
  const digest = createHash('sha256').update(`${path.resolve(codexHome)}:runtime:${workerRevision}`).digest('hex').slice(0,20);
  return process.platform === 'win32' ? `\\\\.\\pipe\\task-tree-agent-${digest}` : path.join(os.tmpdir(), `task-tree-agent-${process.getuid()}`, `${digest}.sock`);
}
function connect(socketPath, signal) {
  return new Promise((resolve,reject) => {
    const socket = net.createConnection({path:socketPath,signal});
    socket.once('error',reject);
    socket.once('connect',() => { socket.removeListener('error',reject); resolve(socket); });
  });
}
async function openWorker(socketPath, signal) {
  if (process.platform !== 'win32') {
    const dir = path.dirname(socketPath);
    await mkdir(dir,{recursive:true,mode:0o700});
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('共享 Worker 目录必须私有且归当前用户所有');
  }
  try { return await connect(socketPath, signal); } catch(error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
  const lock = `${socketPath}.start`;
  for (;;) {
    signal?.throwIfAborted();
    let owner = false;
    try { await mkdir(lock,{mode:0o700}); owner=true; } catch(error) {
      if (error.code!=='EEXIST') throw error;
      const info=await lstat(lock).catch(()=>null);
      if (info && Date.now()-info.mtimeMs>60_000) await rmdir(lock).catch(()=>{});
    }
    if (owner) {
      try {
        try { return await connect(socketPath, signal); } catch(error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
        await unlink(socketPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
        const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve',socketPath],{detached:true,stdio:'ignore',env:process.env});
        let startupError;
        child.on('error',error=>{startupError=error;});
        child.on('exit',(code,sig)=>{startupError ||= new Error(`全局工具 Worker 启动失败（${code ?? sig}）`);});
        child.unref();
        for (;;) {
          signal?.throwIfAborted();
          if(startupError)throw startupError;
          try { return await connect(socketPath, signal); } catch(error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      } finally { await rmdir(lock).catch(()=>{}); }
    } else {
      try { return await connect(socketPath, signal); } catch(error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
}
function rpc(socket) {
  let next=0, buffer='', closed=false;
  const pending=new Map();
  const fail=error=>{closed=true;for(const p of pending.values())p.reject(error);pending.clear();};
  socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    buffer+=chunk;
    for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
      let response;try{response=JSON.parse(line);}catch{continue;}
      const item=pending.get(response.id);if(!item)continue;pending.delete(response.id);
      response.error ? item.reject(new Error(response.error)) : item.resolve(response.result);
    }
  });
  socket.on('error',fail);socket.on('close',()=>fail(new Error('全局工具 Worker 连接已关闭')));
  return (method,params={})=>new Promise((resolve,reject)=>{
    if(closed)return reject(new Error('全局工具 Worker 连接已关闭'));
    const id=++next;
    pending.set(id,{resolve,reject});socket.write(JSON.stringify({id,method,params})+'\n');
  });
}
export async function createSharedAgentRuntime(options={}) {
  const {signal,socketPath=sharedAgentSocket(options.codexHome || options.environment?.CODEX_HOME),...settings}=options;
  if(signal?.aborted)throw new Error('Execution cancelled');
  const socket=await openWorker(socketPath,signal), request=rpc(socket);
  const abort=()=>socket.destroy();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)socket.destroy();
  try {
    const ready=await request('open',{...settings,environment:{...process.env,...settings.environment}});
    return {...ready,
      hooks:(event,input)=>request('hooks',{event,input}),
      call:(name,args)=>request('call',{name,args}),
      loadDialogue:threadId=>request('load_dialogue',{threadId}),
      loadContext:threadId=>request('load_context',{threadId}),
      saveDialogue:(threadId,messages,contextCache)=>request('save_dialogue',{threadId,messages,...(contextCache?{contextCache}:{})}),
      openHistory: async snapshot => {
        await request('history_open', snapshot);
        return (name,args,included) => request('history_query',{name,args,...(Array.isArray(included)?{included}:{})});
      },
      close:async()=>{signal?.removeEventListener('abort',abort);socket.end();}
    };
  } catch(error){signal?.removeEventListener('abort',abort);socket.destroy();throw error;}
}
export async function serveSharedAgentWorker(socketPath) {
  const bridges=new Map();let bridgeStarts=0;
  const historyCache = createHistoryIndexCache();
  const treeBridgeFactory=async({cwd,environment})=>{
    const key=JSON.stringify([cwd,environment.CODEX_HOME,environment.TASK_TREE_CONTEXT_TREE_FILE || '',environment.TASK_TREE_QUALITY_MODE === 'advisory' ? 'advisory' : 'strict']);
    let entry=bridges.get(key);
    if(!entry){bridgeStarts++;entry=createTaskTreeAgentTools({cwd,environment:{...environment,TASK_TREE_EXECUTION_SCOPE:''}}).catch(error=>{bridges.delete(key);throw error;});bridges.set(key,entry);}
    const bridge=await entry;
    return {...bridge,close:async()=>{},call:async(name,args)=>{
      const scope=environment.TASK_TREE_EXECUTION_SCOPE;
      const supportsScope=bridge.tools.find(t=>t.function.name===name)?.function.parameters.properties?.scopeId;
      const scopedArgs=scope && supportsScope ? {...args,scopeId:scope} : args;
      try{return await bridge.call(name,scopedArgs);}catch(error){if(/已关闭|退出/.test(error.message))bridges.delete(key);throw error;}
    }};
  };
  const stats=()=>({pid:process.pid,bridgeCount:bridges.size,bridgeStarts,socketPath});
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.setEncoding('utf8');
    const controller=new AbortController();let runtime, opening, settings, history, buffer='';
    socket.on('error',()=>{});
    socket.on('close',()=>{sockets.delete(socket);controller.abort();void runtime?.close();});
    const handle=async message=>{
      try {
        let result;
        if(message.method==='status')result=stats();
        else if(message.method==='open') {
          if(opening)throw new Error('Runtime already open');
          settings=message.params;
          opening=createAgentRuntime({...message.params,signal:controller.signal,treeBridgeFactory});
          runtime=await opening;
          result={systemPrompt:runtime.systemPrompt,tools:runtime.tools,skillCount:runtime.skillCount,instructionSources:runtime.instructionSources,indexFile:runtime.indexFile,hookSources:runtime.hookSources,worker:stats()};
        } else {
          await opening;if(!runtime)throw new Error('Runtime not open');
          if(message.method==='call')result=await runtime.call(message.params.name,message.params.args);
          else if(message.method==='load_dialogue')result=await loadThreadDialogue({codexHome:settings.codexHome || settings.environment?.CODEX_HOME || path.join(settings.homeDir || os.homedir(),'.codex'),threadId:message.params.threadId});
          else if(message.method==='load_context')result=await loadThreadContext({codexHome:settings.codexHome || settings.environment?.CODEX_HOME || path.join(settings.homeDir || os.homedir(),'.codex'),threadId:message.params.threadId});
          else if(message.method==='save_dialogue')result=await saveThreadDialogue({codexHome:settings.codexHome || settings.environment?.CODEX_HOME || path.join(settings.homeDir || os.homedir(),'.codex'),cwd:settings.cwd,threadId:message.params.threadId,messages:message.params.messages,contextCache:message.params.contextCache});
          else if(message.method==='history_open'){
            // Recompute the version instead of trusting a client-supplied hash.
            const snapshot=historySnapshot(message.params.archive,message.params.scope);
            snapshot.included=message.params.included || [];
            history=createHistorySession(snapshot,historyCache);
            result={version:snapshot.version};
          }
          else if(message.method==='history_query'){
            if(!history)throw new Error('HISTORY_NOT_OPEN');
            result=history(message.params.name,message.params.args,message.params.included);
          }
          else if(message.method==='hooks'){
            result=await runtime.hooks(message.params.event,message.params.input);
            // SessionStart can refresh the catalog; forward the refreshed prompt.
            result.systemPrompt=runtime.systemPrompt;
          } else throw new Error('Unknown worker request');
        }
        if(!socket.destroyed)socket.write(JSON.stringify({id:message.id,result})+'\n');
      }catch(error){if(!socket.destroyed)socket.write(JSON.stringify({id:message.id,error:error.message})+'\n');}
    };
    socket.on('data',chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{void handle(JSON.parse(line));}catch{socket.destroy();}}});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  if(process.platform!=='win32')await chmod(socketPath,0o600);
  const stop=async()=>{
    for(const socket of sockets)socket.destroy();server.close();
    for(const entry of bridges.values()){try{await(await entry).close();}catch{}}
    await unlink(socketPath).catch(()=>{});process.exit(0);
  };
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url) && process.argv[2]==='--serve') {
  await serveSharedAgentWorker(process.argv[3] || sharedAgentSocket());
}
