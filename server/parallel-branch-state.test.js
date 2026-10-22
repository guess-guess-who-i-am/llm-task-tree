import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {recordParallelBranchResults} from './parallel-branch-tree.js';
import {parseTreeNodeFields} from './tree-quality.js';

test('host branch index distinguishes implemented pending acceptance from failed and accepted',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'parallel-state-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file='index.md';
  await writeFile(path.join(root,file),'# LLM Task Graph\n## P_run - 本轮\n- Completion: 进行中\n## worker - 分支\n- Completion: 未开始\n# GraphState\n- Current: P_run\n- Next: P_run\n# Edges\n');
  const run={id:'run',status:'checking',finalReviewOnly:true,branchTree:{path:file},jobs:[{executionNodeId:'worker',status:'completed',acceptanceStatus:'pending'}]};
  const fields=async()=>Object.fromEntries(parseTreeNodeFields(await readFile(path.join(root,file),'utf8')).map(node=>[node.id,node.fields]));
  await recordParallelBranchResults(root,run);
  let current=await fields();
  assert.equal(current.worker.Completion,'进行中');assert.match(current.worker.CurrentResult,/已实施.*待.*验收/);
  assert.equal(current.P_run.Completion,'进行中');assert.match(current.P_run.CurrentResult,/待.*验收/);
  run.status='accepted';run.review={verdict:'pass'};await recordParallelBranchResults(root,run);
  current=await fields();assert.equal(current.worker.Completion,'已完成');assert.equal(current.P_run.Completion,'已完成');
  run.status='failed';run.review={verdict:'failed'};await recordParallelBranchResults(root,run);
  current=await fields();assert.equal(current.worker.Completion,'需重做');assert.equal(current.P_run.Completion,'需重做');
});
