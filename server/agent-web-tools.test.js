import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from './agent-runtime.js';

test('published npm search package is usable without rebuilding missing TypeScript sources', async () => {
  const { resolveSearchInstallation } = await import('./open-websearch-installation.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'search-install-'));
  const packageDir = path.join(root, 'node_modules/open-websearch');
  await mkdir(path.join(packageDir, 'build'), { recursive:true });
  await writeFile(path.join(packageDir, 'package.json'), '{"name":"open-websearch"}');
  await writeFile(path.join(packageDir, 'build/index.js'), '');
  assert.deepEqual(resolveSearchInstallation(root, root), { dir:packageDir, entry:path.join(packageDir,'build/index.js'), packaged:true });
});

test('search service explicitly receives runtime proxy and respects explicit disabling', async () => {
  const { searchDaemonEnvironment } = await import('./open-websearch-installation.js');
  assert.equal(searchDaemonEnvironment({ HTTPS_PROXY:'http://127.0.0.1:7890' }).PROXY_URL, 'http://127.0.0.1:7890');
  assert.equal(searchDaemonEnvironment({ HTTPS_PROXY:'http://127.0.0.1:7890' }).USE_PROXY, 'true');
  assert.equal(searchDaemonEnvironment({ HTTPS_PROXY:'http://127.0.0.1:7890', USE_PROXY:'false' }).USE_PROXY, 'false');
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-web-'));
  const controller = new AbortController();
  const calls = [];
  const runtime = await createAgentRuntime({ cwd:root, homeDir:root, codexHome:path.join(root,'codex'), signal:controller.signal,
    treeBridgeFactory:async()=>({ tools:[], instructions:'', close:async()=>{}, call:async(name,args)=>{calls.push({name,args});return {query:args.query,results:[{title:'paper',url:'https://example.com/paper.pdf'}]};} }) });
  const server = http.createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/paper.pdf'});res.end();return;}
    if(req.url==='/404'){res.writeHead(404);res.end('not found');return;}
    if(req.url==='/slow'){res.writeHead(200);res.write('partial');return;}
    if(req.url==='/paper.pdf'){res.writeHead(200,{'content-type':'application/pdf'});res.end('%PDF-1.7\nfixture\n%%EOF');return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<html><head><title>测试</title></head><body><h1>正文</h1><p>'+ '完整内容'.repeat(10000) +'</p><a href="/paper.pdf">PDF 原文</a><script>SECRET_SCRIPT</script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();});
  return {root,runtime,controller,calls,base:`http://127.0.0.1:${server.address().port}`};
}

test('all execution runtimes expose keyless search, full page reading and download with distinct contracts', async t => {
  const {runtime,calls}=await fixture(t);
  for(const name of ['web_search','web_search_batch','fetch_url','download_file','read_document']) assert.ok(runtime.tools.some(tool=>tool.function.name===name),name);
  assert.match(runtime.systemPrompt,/web_search/);
  const result=await runtime.call('web_search',{query:'public paper',topK:3});
  assert.equal(result.results.length,1);
  assert.deepEqual(calls,[{name:'task_tree_knowledge',args:{action:'web',query:'public paper',topK:3}}]);
  await runtime.call('web_search_batch',{queries:['a','b'],topK:15});
  assert.deepEqual(calls[1],{name:'task_tree_knowledge',args:{action:'web_batch',queries:['a','b'],topK:15}});
});

test('fetch returns complete readable text and resolved links, not scripts or a truncated preview', async t => {
  const {runtime,base}=await fixture(t);
  const result=await runtime.call('fetch_url',{url:base});
  assert.equal(result.title,'测试');
  assert.ok(result.content.includes('完整内容'.repeat(10000)));
  assert.ok(!result.content.includes('SECRET_SCRIPT'));
  assert.ok(result.links.some(link=>link.url===base+'/paper.pdf'));
  assert.equal(result.truncated,false);
});

test('download follows redirects, verifies PDF and returns full persisted receipt without clobber', async t => {
  const {runtime,root,base}=await fixture(t);
  const result=await runtime.call('download_file',{url:base+'/redirect',path:'知识库/paper.pdf'});
  assert.equal(result.finalUrl,base+'/paper.pdf');
  assert.equal(result.path,path.join(root,'知识库/paper.pdf'));
  assert.equal(result.bytes, (await readFile(result.path)).length);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.verifiedType,'pdf');
  await assert.rejects(runtime.call('download_file',{url:base+'/paper.pdf',path:'知识库/paper.pdf'}),/已存在/);
  await assert.rejects(runtime.call('download_file',{url:base,path:'fake.pdf'}),/PDF/);
  await assert.rejects(readFile(path.join(root,'fake.pdf')),/ENOENT/);
  await assert.rejects(runtime.call('download_file',{url:base+'/404',path:'missing.pdf'}),/404/);
  await assert.rejects(readFile(path.join(root,'missing.pdf')),/ENOENT/);
  assert.ok(!(await readdir(root)).some(name=>name.includes('.download-')));
});

test('cancelled download preserves existing target and cleans partial temporary files', async t => {
  const {runtime,root,base,controller}=await fixture(t);
  await writeFile(path.join(root,'existing.txt'),'user content');
  const pending=runtime.call('download_file',{url:base+'/slow',path:'existing.txt',overwrite:true});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending,/abort|取消/i);
  assert.equal(await readFile(path.join(root,'existing.txt'),'utf8'),'user content');
  assert.ok(!(await readdir(root)).some(name=>name.includes('.download-')));
});
