import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';

const index = '# LLM Task Graph\n\n## N9 - 主树索引\n- Folded: true\n- SubtreeFile: subtrees/N9-subtree.md\n- SubtreeCount: 2\n- Problem:\n- NextIdea:\n\n# GraphState\n- Current: N9\n- Next: N9\n\n# Edges\n';
const details = '# LLM Task Graph Subtree\n\n> Fold root: N9\n\n## N9 - 身体计划\n- Problem: 保持身体健康并规划时间\n- NextIdea: 先落实睡眠与休息\n- Notes: 完整事实\n- Position: 1,2\n\n## N9_1 - 睡眠\n- Problem: 固定作息\n\n# Edges\n';
async function fixture(t, main=index, subtree=details) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mcp-folded-node-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  await mkdir(path.join(cwd,'subtrees'));
  await writeFile(path.join(cwd,'task-tree.md'), main);
  if(subtree !== null) await writeFile(path.join(cwd,'subtrees/N9-subtree.md'),subtree);
  const tools = await createTaskTreeAgentTools({cwd, environment:{TASK_TREE_EXECUTION_SCOPE:''}});
  t.after(() => tools.close());
  return {cwd, tools};
}

test('folded node reads real root fields without losing its main-tree index', async t => {
  const {cwd, tools} = await fixture(t);
  const node = await tools.call('task_tree_node', {nodeId:'N9'});
  assert.equal(node.fields.Problem,'保持身体健康并规划时间');
  assert.equal(node.fields.NextIdea,'先落实睡眠与休息');
  assert.equal(node.fields.SubtreeFile,'subtrees/N9-subtree.md');
  assert.equal(node.file,'subtrees/N9-subtree.md');
  assert.equal(node.title,'身体计划');
  assert.equal(node.index.file,'task-tree.md');
  assert.equal(node.index.title,'主树索引');
  assert.equal(node.index.fields.Folded,'true');
  assert.equal(node.fields.Position,undefined);
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),index);
  assert.equal(await readFile(path.join(cwd,node.file),'utf8'),details);
});

test('active-tree explicit pointer wins over an unrelated subtree with the same ID', async t => {
  const {cwd,tools} = await fixture(t);
  await mkdir(path.join(cwd,'trees'));
  await writeFile(path.join(cwd,'trees/active.md'),index.replace('N9-subtree.md','selected.md'));
  await writeFile(path.join(cwd,'subtrees/selected.md'),details.replace('完整事实','活动树事实'));
  await writeFile(path.join(cwd,'task-trees.json'),JSON.stringify({activeMethod:'active',trees:[{id:'active',role:'method',path:'trees/active.md'}]}));
  const node = await tools.call('task_tree_node',{nodeId:'N9'});
  assert.equal(node.fields.Notes,'活动树事实');
  assert.equal(node.index.file,'trees/active.md');
});

test('bad folded pointers report the real defect instead of returning an empty root', async t => {
  const {cwd,tools} = await fixture(t,index,null);
  await assert.rejects(tools.call('task_tree_node',{nodeId:'N9'}),/子树.*不存在/);
  await writeFile(path.join(cwd,'subtrees/N9-subtree.md'),details.replace('## N9 -','## OTHER -'));
  await assert.rejects(tools.call('task_tree_node',{nodeId:'N9'}),/子树.*缺少.*N9/);
  await writeFile(path.join(cwd,'task-tree.md'),index.replace('subtrees/N9-subtree.md','../outside.md'));
  await assert.rejects(tools.call('task_tree_node',{nodeId:'N9'}),/子树路径.*工作区/);
});

test('unfolded and child-node reads keep their existing full-field contract', async t => {
  const {cwd,tools} = await fixture(t);
  const child = await tools.call('task_tree_node',{nodeId:'N9_1'});
  assert.equal(child.fields.Problem,'固定作息');
  assert.equal(child.index,undefined);
  await writeFile(path.join(cwd,'task-tree.md'),details);
  const node = await tools.call('task_tree_node',{nodeId:'N9'});
  assert.equal(node.fields.Notes,'完整事实');
  assert.equal(node.file,'task-tree.md');
  assert.equal(node.index,undefined);
  await assert.rejects(tools.call('task_tree_node',{nodeId:'unknown'}),/没有节点/);
});
