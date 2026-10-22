import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';
import {createParallelCodexCoordinator} from './codex-coordinator.js';

const graph=nodes=>`# LLM Task Graph\n${nodes}\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n`;
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'nested-tree-execution-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'subtrees'));
  await writeFile(path.join(root,'task-tree.md'),graph('## ROOT - 项目\n## N1 - 第一层\n- SubtreeFile: subtrees/one.md'));
  await writeFile(path.join(root,'subtrees/one.md'),graph('## N1 - 第一层\n## N2 - 第二层\n- SubtreeFile: subtrees/two.md'));
  await writeFile(path.join(root,'subtrees/two.md'),graph('## N2 - 第二层\n## LEAF - 实际执行节点\n- Problem: 分析机构审核权限\n- CurrentResult: 尚未核对。'));
  await writeFile(path.join(root,'task-trees.json'),JSON.stringify({activeMethod:'method',trees:[{id:'method',path:'task-tree.md',role:'method',flowEnabled:false}]}));
  return root;
}

test('nested folded node read, patch and dispatch resolve the same actual node',async t=>{
  const root=await fixture(t);
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../server.js')],{env:{...process.env,PORT:'0',TASK_TREE_PROJECT_ROOT:root,TASK_TREE_NO_OPEN:'1',CODEX_HOME:path.join(root,'home'),TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env')},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}});
  const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.once('error',reject);child.stdout.on('data',c=>{log+=c;const m=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
  const tools=await createTaskTreeAgentTools({cwd:root,environment:{CODEX_HOME:path.join(root,'home')}});t.after(()=>tools.close());
  const node=await tools.call('task_tree_node',{treeId:'method',nodeId:'LEAF'});
  assert.equal(node.file,'subtrees/two.md');
  const result=await tools.call('task_tree_write',{treeId:'method',nodeId:'LEAF',fields:{CurrentResult:'源码分析已完成，无业务代码修改。'},reason:'回写实际分析成果'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.match(await readFile(path.join(root,'subtrees/two.md'),'utf8'),/源码分析已完成/);
  assert.doesNotMatch(await readFile(path.join(root,'task-tree.md'),'utf8'),/源码分析已完成/);
  const missing=await fetch(base+'/api/tree/agent-subtree-node-patch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({treeId:'method',nodeId:'MISSING',fields:{CurrentResult:'不能写错节点'},reason:'验证缺失节点'})});
  assert.equal(missing.status,400);
});

test('coordinator allows existing nested node jobs without replaying or recreating their tree',async t=>{
  const root=await fixture(t);let workers=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    workers++;
    return {status:'completed',output:JSON.stringify({event:'completed',evidence:'实际子树节点存在，分析结论已记录'})};
  },reviewTurn:async()=>({status:'completed',output:JSON.stringify({verdict:'pass',reason:'已核对两项分析',evidence:['无实现改动']})})});
  const run=await coordinator.start(['cert','projects'].map(taskId=>({taskId,nodeId:'LEAF',instruction:'分析已有功能，不改业务代码'})),{nodeId:'LEAF',treeId:'method',subtree:'task-tree.md',objective:'并行分析机构功能',incremental:true,finalReviewOnly:true});
  await coordinator.wait(run.id);await coordinator.drain();
  const done=await coordinator.get(run.id);
  assert.equal(done.status,'accepted',done.error);
  assert.equal(workers,2);
});
