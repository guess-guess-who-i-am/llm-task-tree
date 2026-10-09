import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auditTurnMaintenance,repairTurnMaintenance} from './maintenance.js';

const tree='# LLM Task Graph\n\n## ROOT - 验证目标\n- Problem: 如何展开子树？\n- CurrentResult: 子树已建立，实际行动尚待推进。\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n';
test('tree-only expansion and runtime bookkeeping do not demand unrelated engineering step evidence',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tree-only-maintenance-'));
  await mkdir(path.join(root,'subtrees'));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await writeFile(path.join(root,'subtrees/N9-subtree.md'),tree);
  const changedFiles=['task-tree.md','subtrees/N9-subtree.md','.task-tree-direct-state.json','.task-tree-server.json'];
  const repair=await repairTurnMaintenance({projectRoot:root,changedFiles,previousTreeMarkdown:tree});
  assert.equal(repair.repairs.some(r=>r.code==='STEP_EVIDENCE_CREATED'),false);
  const result=await auditTurnMaintenance({projectRoot:root,changedFiles:repair.changedFiles});
  assert.equal(result.ok,true,JSON.stringify(result.issues));
  assert.deepEqual(result.substantiveFiles,[]);
  assert.equal(result.flow,null);
  const metadata=await auditTurnMaintenance({projectRoot:root,changedFiles:['.task-tree-direct-state.json','.task-tree-threads.json']});
  assert.equal(metadata.ok,true);
  const code=await auditTurnMaintenance({projectRoot:root,changedFiles:['src/actual-code.js']});
  assert.equal(code.ok,false);
  assert.ok(code.issues.some(i=>i.code==='TREE_NOT_UPDATED'));
  assert.ok(code.issues.some(i=>i.code==='STEP_EVIDENCE_MISSING'));
});

test('IDE advisory mode records oversized tree warnings without blocking completed work', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'tree-advisory-maintenance-'));
  const big=tree.replace('# GraphState',Array.from({length:45},(_,i)=>`## N${i} - 子问题\n- Problem: 如何推进？\n- Notes: ${'上下文'.repeat(85)}\n\n`).join('')+'# GraphState');
  await writeFile(path.join(root,'task-tree.md'),big);
  const strict=await auditTurnMaintenance({projectRoot:root,changedFiles:['task-tree.md']});
  assert.equal(strict.ok,false);
  const advisory=await auditTurnMaintenance({projectRoot:root,changedFiles:['task-tree.md'],qualityMode:'advisory'});
  assert.equal(advisory.ok,true,JSON.stringify(advisory.issues));
  assert.ok(advisory.warnings.some(w=>w.code==='TREE_FIELDS_OVER_BUDGET'));
  const code=await auditTurnMaintenance({projectRoot:root,changedFiles:['src/actual-code.js'],qualityMode:'advisory'});
  assert.equal(code.ok,false,'advisory quality must not bypass unrelated engineering obligations');
});
