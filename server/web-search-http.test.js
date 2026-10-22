import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('fresh project HTTP config enables shared keyless search; persisted disabling is respected', async t=>{
  const project=await mkdtemp(path.join(os.tmpdir(),'web-search-http-'));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),TASK_TREE_PROJECT_ROOT:project,TASK_TREE_STUB_DIR:project,TASK_TREE_GLOBAL_ENV_FILE:path.join(project,'.env')};
  for(const key of Object.keys(env))if(/^(WEB_SEARCH_|OPEN_WEBSEARCH_|TAVILY_API_KEY|BRAVE_SEARCH_API_KEY|EXA_API_KEY)/.test(key))delete env[key];
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server.js')],{cwd:project,env,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.kill('SIGTERM');await exited;});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    ready=await fetch(base+'/api/project').then(r=>r.ok,()=>false);if(ready)break;
    if(child.exitCode!==null)throw new Error('HTTP fixture server exited');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(ready,true);
  const get=async()=>await (await fetch(base+'/api/web-search/config')).json();
  const fresh=await get();
  assert.equal(fresh.config.provider,'openwebsearch');assert.equal(fresh.config.requiresApiKey,false);assert.equal(fresh.config.enabled,true);
  const saved=await fetch(base+'/api/web-search/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});
  assert.equal(saved.status,200);assert.equal((await get()).config.enabled,false);
  const disabled=await (await fetch(base+'/api/web-search/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'disabled search'})})).json();
  assert.deepEqual(disabled.results,[]);assert.equal(disabled.config.enabled,false);
  const batch=await (await fetch(base+'/api/web-search/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({queries:['a','b']})})).json();
  assert.equal(batch.counts.queries,2);assert.equal(batch.counts.uniqueCandidates,0);
  assert.equal(batch.relevanceVerified,false);assert.equal(batch.fullDocumentsFetched,0);
  const invalid=await fetch(base+'/api/web-search/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({queries:['a'],concurrency:0})});
  assert.equal(invalid.status,400);
});
