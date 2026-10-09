import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';

const root=path.resolve(import.meta.dirname,'..');
const main='# LLM Task Graph\n\n## ROOT - 根\n- Problem: 保留目标\n\n## N9 - 子节点\n- Notes: 保留事实\n\n# GraphState\n- Current: ROOT\n- Next: N9\n- NextPlan: 用户备忘\n\n# Edges\n## E1 - 分支\n- Endpoints: ROOT, N9\n';
const fullText='中文事实不截断'.repeat(2200);
async function fixture(t,mode='strict',{mcpMode=mode}={}) {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'mcp-quality-'));
  const codexHome=await mkdtemp(path.join(os.tmpdir(),'mcp-quality-home-'));
  await writeFile(path.join(cwd,'task-tree.md'),main);
  const environment={CODEX_HOME:codexHome,TASK_TREE_QUALITY_MODE:mode};
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...process.env,...environment,PORT:'0',TASK_TREE_PROJECT_ROOT:cwd,TASK_TREE_NO_OPEN:'1'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  const url=await new Promise((resolve,reject)=>{
    let output='',stderr=''; const timer=setTimeout(()=>reject(new Error('fixture startup timeout: '+stderr)),10000);
    child.stderr.on('data',c=>stderr+=c);
    child.stdout.on('data',c=>{output+=c;const match=output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('error',reject);
  });
  // PORT=0 fixtures must publish their actual listening port; otherwise MCP
  // starts a second server in its own mode and conceals mixed-mode reuse bugs.
  await writeFile(path.join(cwd,'.task-tree-port'),new URL(url).port+'\n');
  const tools=await createTaskTreeAgentTools({cwd,environment:{...environment,TASK_TREE_QUALITY_MODE:mcpMode}});t.after(()=>tools.close());
  const post=async(endpoint,body)=>{const response=await fetch(url+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  return {cwd,tools,post};
}

test('advisory MCP check/write/subtree allow complete oversized text and expose warnings',async t=>{
  const {cwd,tools}=await fixture(t,'advisory');
  assert.doesNotMatch(tools.instructions,/自带备份和精炼门禁/);
  for(const name of ['task_tree_check_compact','task_tree_write','task_tree_subtree']) assert.doesNotMatch(tools.tools.find(t=>t.function.name===name).function.description,/不过就拒绝|ok=false 表示本轮不能结束|同样过门禁/);
  await writeFile(path.join(cwd,'task-tree.md'),main.replace('保留事实',fullText));
  const check=await tools.call('task_tree_check_compact',{});
  assert.equal(check.ok,true);assert.equal(check.advisory,true);assert.ok(check.violations.length);
  const saved=await tools.call('task_tree_write',{nodeId:'N9',fields:{NextIdea:fullText},reason:'保留完整文字'});
  assert.equal(saved.ok,true);assert.equal(saved.advisory,true);assert.ok(saved.warnings.violations.length);
  assert.ok((await readFile(path.join(cwd,'task-tree.md'),'utf8')).includes('- NextIdea: '+fullText));
  const subtree='# LLM Task Graph Subtree\n\n> Fold root: N9\n\n## N9 - 子节点\n- Notes: '+fullText+'\n\n# GraphState\n- Current: N9\n- Next: N9\n\n# Edges\n';
  const written=await tools.call('task_tree_subtree',{action:'write',path:'subtrees/N9-subtree.md',markdown:subtree,reason:'完整子树'});
  assert.equal(written.ok,true);assert.equal(written.advisory,true);assert.ok(written.warnings.violations.length);
  assert.equal(await readFile(path.join(cwd,'subtrees/N9-subtree.md'),'utf8'),subtree);
  await assert.rejects(tools.call('task_tree_write',{markdown:subtree,reason:'错误主树覆盖'}),/子树/);
  await assert.rejects(tools.call('task_tree_write',{nodeId:'N9',fields:{Next:'ROOT'},reason:'错误焦点修改'}),/GraphState/);
});

test('advisory HTTP node-patch does not reject a long field; focus and authorization remain enforced',async t=>{
  const {cwd,post}=await fixture(t,'advisory');
  const saved=await post('/api/tree/node-patch',{nodeId:'N9',fields:{Notes:fullText},reason:'完整保留'});
  assert.equal(saved.status,200);assert.equal(saved.ok,true);assert.equal(saved.advisory,true);assert.ok(saved.warnings.violations.length);
  const content=await readFile(path.join(cwd,'task-tree.md'),'utf8');assert.ok(content.includes(fullText));assert.match(content,/- NextPlan: 用户备忘/);
  assert.notEqual((await post('/api/tree/node-patch',{nodeId:'N9',fields:{Next:'ROOT'},reason:'错误焦点'})).status,200);
  const created=await post('/api/execution-scopes',{targetNodeIds:['N9'],writableNodeIds:['N9']});
  assert.equal(created.status,201);
  const unauthorized=await post('/api/tree/node-patch',{nodeId:'ROOT',fields:{Notes:'不应写入'},reason:'范围外写',scopeId:created.scope.scopeId});
  assert.notEqual(unauthorized.status,200);assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),content);
});

test('strict MCP and HTTP quality gates are unchanged by advisory support',async t=>{
  const {cwd,tools,post}=await fixture(t);
  await assert.rejects(tools.call('task_tree_write',{nodeId:'N9',fields:{Notes:fullText},reason:'严格拒绝'}),/门禁/);
  assert.equal((await post('/api/tree/node-patch',{nodeId:'N9',fields:{Notes:fullText},reason:'严格拒绝'})).status,422);
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),main);
  await writeFile(path.join(cwd,'task-tree.md'),main.replace('保留事实',fullText));
  assert.equal((await tools.call('task_tree_check_compact',{})).ok,false);
});

test('advisory MCP can reuse a strict IDE without inheriting its blocking quality gate',async t=>{
  const {cwd,tools,post}=await fixture(t,'strict',{mcpMode:'advisory'});
  const saved=await tools.call('task_tree_write',{nodeId:'N9',fields:{Notes:fullText},reason:'当前Worker按提示模式写入'});
  assert.equal(saved.ok,true);assert.equal(saved.advisory,true);assert.ok(saved.warnings.violations.length);
  assert.ok((await readFile(path.join(cwd,'task-tree.md'),'utf8')).includes(fullText));
  const before=await readFile(path.join(cwd,'task-tree.md'),'utf8');
  assert.equal((await post('/api/tree/node-patch',{nodeId:'N9',fields:{Notes:fullText},reason:'未指定模式仍严格'})).status,422);
  const strict=await createTaskTreeAgentTools({cwd,environment:{TASK_TREE_QUALITY_MODE:'strict'}});t.after(()=>strict.close());
  await assert.rejects(strict.call('task_tree_write',{nodeId:'N9',fields:{Notes:fullText},reason:'严格Worker仍拒绝'}),/门禁/);
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),before);
  await assert.rejects(tools.call('task_tree_write',{nodeId:'N9',fields:{Next:'ROOT'},reason:'提示模式不能改焦点'}),/GraphState/);
});
