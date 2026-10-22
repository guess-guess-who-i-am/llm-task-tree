import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDirectNodeWorkspace } from './direct-node-workspace.js';
import { createGitWorkspaceManager } from './parallel-worktree.js';
import { createTaskTreeAgentTools } from './task-tree-agent-tools.js';
import { createAdaptiveNodeExecution, NODE_EXECUTION_TOOL } from './adaptive-node-execution.js';

const exec = promisify(execFile);
test('final checker preserves IDE advisory mode when repairing an oversized selected subtree through real MCP', {timeout:30000}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'review-advisory-subtree-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'subtrees'));
  await writeFile(path.join(root,'task-tree.md'),tree());
  const file='subtrees/doctor.md';
  const original='# LLM Task Graph Subtree\n\n> Fold root: A\n\n## A - 医生说明\n- Problem: 用大白话解释入组。\n- Notes: '+ '已有其他节点的完整事实。'.repeat(600)+'\n\n# GraphState\n- Current: A\n- Next: A\n\n# Edges\n';
  await writeFile(path.join(root,file),original);
  let checks=0;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    checks++;
    const bridge=await createTaskTreeAgentTools({cwd:options.cwd,environment:options.environment});
    try {
      const saved=await bridge.call('task_tree_write',{nodeId:'A',fields:{CurrentResult:'因为需要筛选适合研究的人，所以先按条件判断能否入组。'},reason:'只修复指定医生节点'});
      assert.equal(saved.ok,true);
      assert.equal(saved.advisory,true);
      assert.ok(saved.changes.some(change=>change.nodeId==='A'&&change.field==='CurrentResult'));
      assert.equal(await readFile(path.join(root,file),'utf8'),original,'candidate repairs stay isolated');
    } finally {
      await bridge.close();
      const pid=Number(await readFile(path.join(options.cwd,'.task-tree-server.pid'),'utf8').catch(()=>0));
      if(pid)try{process.kill(pid,'SIGTERM');}catch{}
    }
    return {status:'completed',output:JSON.stringify({verdict:'pass',reason:'指定节点说明已回写，原有事实完整保留',evidence:['MCP实际回执与候选文件一致']})};
  }});
  const state=await executor.prepare('advisory-check');
  try {
    const result=await executor.finish(state,{nodeId:'A',treeFile:file,objective:'在节点中解释入组，不修改软件功能',status:'completed'});
    assert.equal(checks,1);
    assert.ok(result.appliedFiles.includes(file));
    const persisted=await readFile(path.join(root,file),'utf8');
    assert.ok(persisted.includes('已有其他节点的完整事实。'.repeat(600)));
    assert.match(persisted,/因为需要筛选适合研究的人/);
  } finally {await executor.abandon(state);}
});

test('one final review checks the candidate directly without inline diffs or execution reports',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-input-dedupe-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree());
  const samples=[];
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    assert.match(options.prompt,/完整任务原文EXECUTE_THIS_REAL_TASK/);
    assert.doesNotMatch(options.prompt,/BUSINESS_SOURCE_SENTINEL|HOST_TASK_DUPLICATE_SENTINEL|改动文件|执行者报告|diff --git/);
    assert.ok(!options.prompt.includes('HOST_TASK_DUPLICATE_SENTINEL'),'host copy must be addressable, not another inline task');
    assert.equal(await readFile(path.join(options.cwd,'business.md'),'utf8'),'BUSINESS_SOURCE_SENTINEL');
    assert.equal(JSON.parse(await readFile(path.join(options.cwd,'subtrees/P_test.task.json'),'utf8')).instruction,'HOST_TASK_DUPLICATE_SENTINEL');
    return {status:'completed',output:'{"verdict":"pass","reason":"业务产物与原任务一致"}'};
  }});
  const state=await executor.prepare('review-dedupe');
  await mkdir(path.join(state.workerPath,'subtrees'));
  await writeFile(path.join(state.workerPath,'business.md'),'BUSINESS_SOURCE_SENTINEL');
  await writeFile(path.join(state.workerPath,'subtrees/P_test.task.json'),JSON.stringify({instruction:'HOST_TASK_DUPLICATE_SENTINEL'}));
  const receipt=await executor.finish(state,{nodeId:'ROOT',status:'completed',objective:'完整任务原文EXECUTE_THIS_REAL_TASK',
    executionFiles:['subtrees/P_test.task.json'],onTiming:value=>samples.push(value)});
  assert.equal(receipt.review.verdict,'pass');
  const measured=samples.find(value=>value.role==='review-input');
  assert.ok(measured.promptChars>0&&measured.deferredFiles>=1);
});
test('initial worker inherits project-declared inputs once without adding them to its Git changes',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'initial-worker-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'.gitignore'),'corpus/\n');
  await mkdir(path.join(root,'corpus'));
  await writeFile(path.join(root,'corpus/input.json'),'project input');
  await writeFile(path.join(root,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['corpus']}));
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const executor=createDirectNodeWorkspace({projectRoot:root,workspace,reviewTurn:null});
  const state=await executor.prepare('initial-input');
  try {
    assert.equal(await readFile(path.join(state.workerPath,'corpus/input.json'),'utf8'),'project input');
    assert.deepEqual(JSON.parse(await readFile(path.join(state.workerPath,'.task-tree-review-inputs.json'),'utf8')).paths,['corpus']);
    assert.deepEqual((await workspace.inspectChanges(state.workerPath,state.snapshotCommit)).changedFiles,[]);
    assert.equal(state.reviewInputs[0].fileCount,1);
  }finally{await executor.abandon(state);}
});
test('single worker final review can use restored local inputs without listing them in its prompt',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-local-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'.gitignore'),'corpus/\n.task-tree-review-inputs.json\n');
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    assert.equal(await readFile(path.join(options.cwd,'corpus/input.json'),'utf8'),'local dataset');
    assert.doesNotMatch(options.prompt,/corpus\/input\.json|改动文件|执行者报告|diff --git/);
    return {status:'completed',output:'{"verdict":"pass","reason":"本地输入齐全，测试可复现"}'};
  }});
  const state=await executor.prepare('local-input');
  await mkdir(path.join(state.workerPath,'corpus'));
  await writeFile(path.join(state.workerPath,'corpus/input.json'),'local dataset');
  await writeFile(path.join(state.workerPath,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['corpus']}));
  await writeFile(path.join(state.workerPath,'result.txt'),'generated result');
  try {
    const receipt=await executor.finish(state,{nodeId:'A',objective:'用corpus生成result.txt',status:'completed'});
    assert.deepEqual(receipt.appliedFiles,['result.txt']);
    await assert.rejects(readFile(path.join(root,'corpus/input.json')),{code:'ENOENT'});
    await assert.rejects(readFile(path.join(root,'.task-tree-review-inputs.json')),{code:'ENOENT'});
  } finally {await executor.abandon(state).catch(()=>{});}
});
test('integrated final check uses branch snapshots after branch deletion and never delivers overlays',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-branch-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'result.txt'),'before');
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const state=await workspace.prepare('branch-input');
  const worker=await workspace.createWorker('branch-input','source',state.snapshotCommit);
  await mkdir(path.join(worker,'local-data'));
  await writeFile(path.join(worker,'local-data/input.json'),'branch input');
  await writeFile(path.join(worker,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['local-data']}));
  const reviewInputs=[await workspace.captureReviewInputs(worker)];
  await workspace.removeWorker(worker);
  const executor=createDirectNodeWorkspace({projectRoot:root,workspace,reviewTurn:async options=>{
    assert.equal(await readFile(path.join(options.cwd,'local-data/input.json'),'utf8'),'branch input');
    await writeFile(path.join(options.cwd,'result.txt'),'review repaired');
    return {status:'completed',output:'{"verdict":"pass","reason":"分支输入可用，完成最终修复"}'};
  }});
  try {
    const receipt=await executor.reviewIntegrated({...state,runId:'branch-input'},{nodeId:'A',objective:'完成result.txt',reviewInputs});
    assert.deepEqual(receipt.appliedFiles,['result.txt']);
    assert.equal(await readFile(path.join(root,'result.txt'),'utf8'),'review repaired');
    await assert.rejects(readFile(path.join(root,'local-data/input.json')),{code:'ENOENT'});
  }finally{await workspace.cleanup({...state,runId:'branch-input'});}
});
test('final review accepts a subtree migration and applies its new registered tree once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-tree-migration-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'subtrees/people-tree.md'), tree('旧人物树'));
  let checks = 0;
  const executor = createDirectNodeWorkspace({projectRoot:root, reviewTurn:async () => {
    checks++;
    return {status:'completed',output:'{"verdict":"pass","reason":"人物树已迁移并注册"}'};
  }});
  const state = await executor.prepare('tree-migration');
  await mkdir(path.join(state.workerPath, 'trees'));
  const delivered = '# LLM Task Graph\n## PERSON - 人物树\n- CurrentResult: 已交付人物树\n';
  await writeFile(path.join(state.workerPath, 'trees/people.md'), delivered);
  await rm(path.join(state.workerPath, 'subtrees/people-tree.md'));
  await writeFile(path.join(state.workerPath, 'task-trees.json'), JSON.stringify({trees:[
    {id:'method',path:'task-tree.md'}, {id:'people',path:'trees/people.md'}
  ]}));
  const receipt = await executor.finish(state, {nodeId:'ROOT',status:'completed',objective:'将人物子树迁为独立树'});
  assert.equal(checks, 1);
  assert.equal(receipt.status, 'completed');
  assert.ok(receipt.appliedFiles.includes('subtrees/people-tree.md'));
  assert.equal(await readFile(path.join(root, 'trees/people.md'), 'utf8'), delivered);
  await assert.rejects(readFile(path.join(root, 'subtrees/people-tree.md')), {code:'ENOENT'});
});

test('identical renamed subtree removes the old path as well as delivering the destination', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-tree-rename-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'subtrees/old.md'), tree());
  const executor = createDirectNodeWorkspace({projectRoot:root,reviewTurn:async () => ({status:'completed',output:'{"verdict":"pass","reason":"迁移完成"}'})});
  const state = await executor.prepare('rename-tree');
  await mkdir(path.join(state.workerPath, 'trees'));
  await writeFile(path.join(state.workerPath, 'trees/new.md'), tree());
  await rm(path.join(state.workerPath, 'subtrees/old.md'));
  const receipt = await executor.finish(state, {nodeId:'ROOT',status:'completed'});
  assert.deepEqual(receipt.appliedFiles.sort(), ['subtrees/old.md','trees/new.md']);
  await assert.rejects(readFile(path.join(root, 'subtrees/old.md')), {code:'ENOENT'});
  assert.equal(await readFile(path.join(root, 'trees/new.md'), 'utf8'), tree());
});

test('concurrent edit of a deleted subtree invalidates the candidate instead of opening a missing file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-tree-delete-race-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'subtrees/old.md'), tree('原始'));
  const workspace = createGitWorkspaceManager({projectRoot:root});
  const state = await workspace.prepare('delete-race');
  const worker = await workspace.createWorker('delete-race', 'node', state.snapshotCommit);
  await rm(path.join(worker, 'subtrees/old.md'));
  const commit = await workspace.commit(worker, '移除旧树', state.snapshotCommit);
  await workspace.integrate(state.integrationPath, commit, state.snapshotCommit);
  let reviews = 0;
  await assert.rejects(workspace.accept({integrationPath:state.integrationPath,snapshotCommit:state.snapshotCommit,changedFiles:['subtrees/old.md'],
    validateCandidate:async () => {reviews++;await writeFile(path.join(root,'subtrees/old.md'),tree('并发更新'));},
    onInvalidated: () => {throw Object.assign(new Error('已正确检测到并发更新'),{code:'RACE_DETECTED'});}
  }), {code:'RACE_DETECTED'});
  assert.equal(reviews, 1);
  assert.equal(await readFile(path.join(root,'subtrees/old.md'),'utf8'), tree('并发更新'));
  await workspace.removeWorker(worker);await workspace.cleanup({...state,runId:'delete-race'});
});

for (const reference of ['registry', 'unchanged-sibling', 'main']) test(`final review preserves candidate and identifies a missing tree referenced by ${reference}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-missing-tree-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'subtrees/people-tree.md'), tree());
  if (reference === 'registry') await writeFile(path.join(root, 'task-trees.json'), JSON.stringify({trees:[{id:'people',path:'subtrees/people-tree.md'}]}));
  if (reference === 'unchanged-sibling') await writeFile(path.join(root, 'subtrees/index.md'), tree().replace('- Problem: 两个节点共同完成', '- Problem: 两个节点共同完成\n- Folded: true\n- SubtreeFile: subtrees/people-tree.md'));
  const executor = createDirectNodeWorkspace({projectRoot:root,reviewTurn:async () => ({status:'completed',output:'{"verdict":"pass","reason":"完成"}'})});
  const state = await executor.prepare('missing-tree');
  const deleted = reference === 'main' ? 'task-tree.md' : 'subtrees/people-tree.md';
  await rm(path.join(state.workerPath, deleted));
  await assert.rejects(executor.finish(state, {nodeId:'ROOT',status:'completed'}), error => {
    assert.equal(error.review.causeCode, 'TREE_REFERENCE_MISSING');
    assert.equal(error.review.stage, 'tree-validation');
    assert.match(error.message, new RegExp(deleted.replaceAll('.', '\\.')));
    return true;
  });
  assert.equal(await readFile(path.join(root, deleted), 'utf8'), tree());
  assert.equal(await readFile(path.join(state.workerPath, 'task-tree.md'), 'utf8').catch(e => e.code), reference === 'main' ? 'ENOENT' : tree());
  await executor.abandon(state);
});

test('final checker reads the candidate workspace without inline archives or diff context',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-packet-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const executor=createDirectNodeWorkspace({projectRoot:root,workspace,reviewTurn:async options=>{
    assert.doesNotMatch(options.prompt,/CURRENT_DELIVERY_SENTINEL|HISTORY_BACKUP_SENTINEL|source\.pdf|PDF_ENCODING_SENTINEL|RUNTIME_TRACE_SENTINEL|CURRENT_TASK_INSTRUCTION_SENTINEL|git --literal-pathspecs diff|改动文件|执行者报告/);
    assert.ok((await readFile(path.join(options.cwd,'result.txt'),'utf8')).startsWith('CURRENT_DELIVERY_SENTINEL'));
    assert.equal(await readFile(path.join(options.cwd,'versions/20261014_backup.md'),'utf8'),'HISTORY_BACKUP_SENTINEL'.repeat(400));
    assert.equal(await readFile(path.join(options.cwd,'.task-tree-runs/sample.json'),'utf8'),JSON.stringify({events:'RUNTIME_TRACE_SENTINEL'.repeat(400)}));
    assert.equal(await readFile(path.join(options.cwd,'source.pdf'),'utf8').then(value=>value.includes('PDF_ENCODING_SENTINEL')),true);
    assert.equal(JSON.parse(await readFile(path.join(options.cwd,'subtrees/current.task.json'),'utf8')).instruction,'CURRENT_TASK_INSTRUCTION_SENTINEL');
    return {status:'completed',output:'{"verdict":"pass","reason":"当前产物已核对","evidence":["备份全文可访问"]}'};
  }});
  const state=await executor.prepare('archive-evidence');
  await writeFile(path.join(state.workerPath,'result.txt'),'CURRENT_DELIVERY_SENTINEL'.repeat(400));
  await mkdir(path.join(state.workerPath,'versions'),{recursive:true});
  await writeFile(path.join(state.workerPath,'versions/20261014_backup.md'),'HISTORY_BACKUP_SENTINEL'.repeat(400));
  // Git can classify a PDF without NUL bytes as text. Its encoded bytes still
  // must not become a megabyte of fake natural-language review context.
  await writeFile(path.join(state.workerPath,'source.pdf'),'%PDF-1.4\nPDF_ENCODING_SENTINEL'.repeat(400));
  await mkdir(path.join(state.workerPath,'.task-tree-runs'),{recursive:true});
  await writeFile(path.join(state.workerPath,'.task-tree-runs/sample.json'),JSON.stringify({events:'RUNTIME_TRACE_SENTINEL'.repeat(400)}));
  await mkdir(path.join(state.workerPath,'subtrees'),{recursive:true});
  await writeFile(path.join(state.workerPath,'subtrees/current.task.json'),JSON.stringify({instruction:'CURRENT_TASK_INSTRUCTION_SENTINEL'}));
  const receipt=await executor.finish(state,{nodeId:'A',objective:'创建result.txt',status:'completed'});
  assert.ok(receipt.appliedFiles.includes('versions/20261014_backup.md'));
  assert.ok(receipt.appliedFiles.includes('.task-tree-runs/sample.json'));
});
test('text-only worker cannot bypass final goal checking when it changed no files',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'direct-text-only-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let checks=0;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async()=>{
    checks++;
    return {status:'completed',output:JSON.stringify({verdict:'failed',reason:'只有计划，没有交付指定文件',evidence:['result.txt 不存在']})};
  }});
  const state=await executor.prepare('text-only');
  await assert.rejects(executor.finish(state,{nodeId:'A',objective:'创建 result.txt',output:'下一步可以创建 result.txt',status:'completed'}),/只有计划/);
  assert.equal(checks,1);
  await assert.rejects(readFile(path.join(root,'result.txt')),{code:'ENOENT'});
  await executor.abandon(state);
});
test('no-diff worker final checker repairs are applied once and reported to the user',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'direct-no-diff-repair-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let checks=0;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    checks++;
    await writeFile(path.join(options.cwd,'result.txt'),'实际交付');
    return {status:'completed',output:'{"verdict":"pass","reason":"已补齐缺失产物","evidence":["result.txt 已写入并读回"]}'};
  }});
  const state=await executor.prepare('no-diff-repair');
  const receipt=await executor.finish(state,{nodeId:'A',objective:'创建 result.txt',output:'准备写入',status:'completed'});
  assert.equal(checks,1);
  assert.equal(receipt.review.verdict,'pass');
  assert.deepEqual(receipt.appliedFiles,['result.txt']);
  assert.deepEqual(receipt.changedFiles,['result.txt']);
  assert.equal(await readFile(path.join(root,'result.txt'),'utf8'),'实际交付');
});

test('folded tree updates report their real file and node, not the main-tree index', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subtree-receipt-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'subtrees/A.md'), tree('旧结论'));
  const executor = createDirectNodeWorkspace({projectRoot:root,reviewTurn:async () => ({status:'completed',output:'{"verdict":"pass","reason":"子树准确"}'})});
  const state = await executor.prepare('subtree-receipt');
  await writeFile(path.join(state.workerPath, 'subtrees/A.md'), tree('子树新结论'));
  const receipt = await executor.finish(state, {nodeId:'A',status:'completed'});
  assert.deepEqual(receipt.appliedFiles, ['subtrees/A.md']);
  assert.deepEqual(receipt.treeChanges.map(t => [t.treePath,t.changes.map(c => [c.nodeId,c.field,c.before,c.after])]),
    [['subtrees/A.md',[['A','CurrentResult','旧结论','子树新结论']]]]);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree());
});
test('legitimate read-only response passes one final check without inventing a file change',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'direct-read-only-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let checks=0;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async()=>{
    checks++;return {status:'completed',output:'{"verdict":"pass","reason":"只读解释准确，无需修改","evidence":["已对照原文件"]}'};
  }});
  const state=await executor.prepare('read-only');
  const receipt=await executor.finish(state,{nodeId:'A',objective:'解释已有实现，不修改',status:'completed'});
  assert.equal(checks,1);
  assert.equal(receipt.review.verdict,'pass');
  assert.deepEqual(receipt.appliedFiles,[]);
});
test('single final reviewer forwards live progress without mixing worker output or starting another checker',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-progress-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const notifications=[],phases=[];let checks=0;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    checks++;
    options.onNotification({method:'tool/started',params:{toolName:'read_file'}});
    options.onNotification({method:'item/updated',params:{item:{type:'agentMessage',delta:'核对真实产物'}}});
    return {status:'completed',output:'{"verdict":"pass","reason":"符合用户目标"}'};
  }});
  const state=await executor.prepare('progress');await writeFile(path.join(state.workerPath,'result.txt'),'完整产物');
  const pending=executor.finish(state,{nodeId:'A',objective:'交付',output:'全部完成',status:'completed',onNotification:m=>notifications.push(m),onPhase:p=>phases.push(p)});
  const receipt=await pending;
  assert.equal(receipt.review.verdict,'pass');assert.equal(checks,1);
  assert.ok(phases.includes('checking'));
  assert.deepEqual(notifications.map(m=>m.method),['tool/started','item/updated']);
});
const tree = (a = '', b = '') => [
  '# LLM Task Graph',
  '## ROOT - 项目',
  '- Problem: 两个节点共同完成',
  '## A - A节点',
  `- CurrentResult: ${a}`,
  '## B - B节点',
  `- CurrentResult: ${b}`,
  '# GraphState',
  '- Current: A',
  '- Next: A',
  '# Edges',
  ''
].join('\n');

test('final repairs rebase after accept input changes instead of failing or accepting stale review',async()=>{
  let snapshot=0,checks=0,accepts=0,cleanups=0;
  const workspace={
    prepare:async()=>({snapshotCommit:`base-${++snapshot}`,integrationPath:`integration-${snapshot}`}),
    createWorker:async()=>`worker-${snapshot}`,
    inspectChanges:async()=>({changedFiles:['repair.txt']}),
    summarize:async()=>({changedFiles:['repair.txt'],patchPreview:'repair'}),
    commitCandidateRepairs:async()=>{},commit:async()=>`repair-${snapshot}`,integrate:async()=>{},
    accept:async options=>{if(++accepts===1)await options.resolveConflict('candidate',['repair.txt']);return {appliedFiles:['repair.txt']};},
    removeWorker:async()=>{cleanups++;},cleanup:async()=>{}
  };
  // Real tree validation uses only task-tree files; repair.txt needs no tree read.
  const executor=createDirectNodeWorkspace({projectRoot:os.tmpdir(),workspace,reviewTurn:async()=>{
    checks++;return {status:'completed',output:'{"verdict":"pass","reason":"当前基线验证通过"}'};
  }});
  const receipt=await executor.reviewIntegrated({runId:'rebase',snapshotCommit:'original'},{nodeId:'A',objective:'交付',output:'完成'});
  assert.equal(checks,2);assert.equal(accepts,2);
  assert.deepEqual(receipt.appliedFiles,['repair.txt']);
  assert.equal(cleanups,2);
});

test('final checker receives only user constraints/current images and never archives its internal prompt',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-history-material-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree());
  const image={role:'user',content:[{type:'text',text:'合成附件'}, {type:'image_url',image_url:{url:'data:image/png;base64,synthetic'}}]};
  const raw=[{role:'user',content:'原始文字'}, {role:'assistant',content:'旧的完整约定'}];
  let options;
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async input=>{
    options=input;return {status:'completed',output:'{"verdict":"pass","reason":"已验证"}'};
  }});
  const state=await executor.prepare('material');await writeFile(path.join(state.workerPath,'result.txt'),'完成');
  await executor.finish(state,{nodeId:'A',objective:'交付',output:'完成',status:'completed',historyMessages:[image],dialogueContext:raw});
  assert.deepEqual(options.messages[0],image);
  assert.equal(options.messages.at(-1).content,options.prompt);
  assert.equal(options.dialogueContext,undefined);
  assert.equal(options.persistDialogue,false);
  assert.ok(!JSON.stringify(options.messages).includes('旧的完整约定'));
  assert.equal(options.environment.TASK_TREE_CONTEXT_NODE_ID,'A');
});

test('parent returns the final delegation receipt without another review or continuation', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'incremental-parent-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const prompts = [];
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    prompts.push(options.prompt);
    return { status: 'completed', output: '{"verdict":"pass","reason":"只核对父节点新增汇报"}' };
  } });
  const state = await executor.prepare('parent');
  const jobs = ['a', 'b'].map(id => ({ taskId: id, title: id, instruction: `完成${id}`, status: 'completed', appliedFiles: [`child-${id}.txt`] }));
  const handler = createAdaptiveNodeExecution({ state, workspace: executor, nodeId: 'A', treeScope: { tree: { id: 'method', path: 'task-tree.md' } }, objective: '完成两个独立文件',
    coordinator: {
      async start() { return { id: 'children', status: 'running', jobs }; },
      async wait() {
        await Promise.all(jobs.map(j => writeFile(path.join(root, j.appliedFiles[0]), `accepted ${j.taskId}`)));
        return { id: 'children', status: 'accepted', jobs, result: { appliedFiles: jobs.flatMap(j => j.appliedFiles) } };
      }
    } });
  const receipt = await handler(NODE_EXECUTION_TOOL.function.name, { reason: '独立并发交付', jobs });
  assert.equal(receipt.ok, true);
  const result = await executor.finish(state, { nodeId: 'A', objective: '完成两个独立文件', status: 'completed', output: '父节点汇总已完成',
    historyMessages:[{role:'user',content:'用户验收：完整保留两个分支'}] });
  assert.equal(prompts.length, 0);
  assert.deepEqual(result.appliedFiles.sort(), ['child-a.txt','child-b.txt']);
  for (const job of jobs) assert.equal(await readFile(path.join(root, job.appliedFiles[0]), 'utf8'), `accepted ${job.taskId}`);
});

test('two direct nodes use isolated Git worktrees, keep both tree reports and both code changes', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-nodes-'));
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, 'task-tree.md'), tree());
  await exec('git', ['init', '-q'], { cwd: projectRoot });
  await exec('git', ['add', '.'], { cwd: projectRoot });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: projectRoot });

  let checks = 0;
  let resolves = 0;
  const workspace = createGitWorkspaceManager({ projectRoot, tempRoot: path.join(root, 'worktrees') });
  const executor = createDirectNodeWorkspace({ projectRoot, workspace, startTurn: async options => {
    if (options.prompt.includes('【独立合并处理】')) {
      resolves++;
      await writeFile(path.join(options.cwd, 'task-tree.md'), tree('A已完成', 'B已完成'));
      await exec('git', ['add', 'task-tree.md'], { cwd: options.cwd });
      return { status: 'completed', output: '双方节点成果已保留' };
    }
    if (options.prompt.includes('【功能验收】')) {
      checks++;
      assert.doesNotMatch(options.prompt,/改动文件|执行者报告|diff --git|a\.txt|b\.txt/);
      const node = options.environment.TASK_TREE_CONTEXT_NODE_ID;
      assert.match(await readFile(path.join(options.cwd,'task-tree.md'),'utf8'),new RegExp(`${node}已完成`));
      assert.equal(await readFile(path.join(options.cwd,`${node.toLowerCase()}.txt`),'utf8'),`${node} code\n`);
      return { status: 'completed', output: '{"verdict":"pass","reason":"改动符合目标"}' };
    }
    throw new Error('unexpected model turn');
  } });
  const [a, b] = await Promise.all([executor.prepare('a'), executor.prepare('b')]);
  assert.notEqual(a.workerPath, b.workerPath);
  assert.notEqual(a.workerPath, projectRoot);
  await Promise.all([
    writeFile(path.join(a.workerPath, 'task-tree.md'), tree('A已完成')),
    writeFile(path.join(b.workerPath, 'task-tree.md'), tree('', 'B已完成')),
    writeFile(path.join(a.workerPath, 'a.txt'), 'A code\n'),
    writeFile(path.join(b.workerPath, 'b.txt'), 'B code\n')
  ]);
  const [ra, rb] = await Promise.all([
    executor.finish(a, { nodeId: 'A', objective: '完成A', output: 'A', status: 'completed' }),
    executor.finish(b, { nodeId: 'B', objective: '完成B', output: 'B', status: 'completed' })
  ]);
  assert.equal(ra.status, 'completed');
  assert.equal(rb.status, 'completed');
  assert.equal(await readFile(path.join(projectRoot, 'task-tree.md'), 'utf8'), tree('A已完成', 'B已完成'));
  assert.equal(await readFile(path.join(projectRoot, 'a.txt'), 'utf8'), 'A code\n');
  assert.equal(await readFile(path.join(projectRoot, 'b.txt'), 'utf8'), 'B code\n');
  assert.equal(resolves, 0, 'different node fields should merge without a model negotiation');
  assert.ok(checks >= 2);
});

test('malformed final review fails once instead of repeating the whole review', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-review-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let checks = 0;
  const timingSamples = [];
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async options => {
    checks++;
    assert.equal(options.responseFormat, undefined, 'tool-capable checking must not force every response into a JSON answer');
    return { status: 'completed', timing: { totalMs: 123, runtimeMs: 4 }, output: checks === 1
      ? '<｜｜DSML｜｜ calls>invoke name="exec_command"</｜｜DSML｜｜ calls>'
      : '{"verdict":"pass","reason":"已核对实际改动"}' };
  } });
  const state = await executor.prepare('review-json');
  await writeFile(path.join(state.workerPath, 'a.txt'), '完成\n');
  await assert.rejects(executor.finish(state, { nodeId: 'A', objective: '交付 a.txt', status: 'completed', onTiming: sample => timingSamples.push(sample) }), /检查.*格式/);
  assert.equal(checks, 1);
  assert.deepEqual(timingSamples.filter(s=>s.role==='review').map(s => [s.role, s.attempt, s.timing.totalMs]), [['review', 0, 123]]);
  await assert.rejects(readFile(path.join(root, 'a.txt')), { code: 'ENOENT' });
});

test('the final reviewer can repair and verify code in one turn before applying it', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'final-review-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let turns = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    turns++;
    assert.notDeepEqual(options.runtimeToolNames, [], 'reviewer must retain Skill and verification tools');
    assert.match(options.prompt, /有缺陷就修复并复验/);
    assert.doesNotMatch(options.prompt, /示例|教程/);
    await writeFile(path.join(options.cwd, 'result.mjs'), 'export default () => 42;\n');
    assert.equal((await exec(process.execPath, ['--input-type=module', '-e', "import f from './result.mjs'; if(f()!==42)process.exit(1)"], { cwd: options.cwd })).stderr, '');
    return { status: 'completed', output: '{"verdict":"pass","reason":"已修复并验证返回42","evidence":["实际执行返回值验证通过"]}' };
  }, startTurn: async () => { throw new Error('must not launch a second repair Agent'); } });
  const state = await executor.prepare('repair-once');
  await writeFile(path.join(state.workerPath, 'result.mjs'), 'export default () => 0;\n');
  const receipt = await executor.finish(state, { nodeId: 'A', objective: '返回42', status: 'completed' });
  assert.equal(turns, 1);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.review.verdict, 'pass');
  assert.deepEqual(receipt.review.evidence, ['实际执行返回值验证通过']);
  assert.equal(await readFile(path.join(root, 'result.mjs'), 'utf8'), 'export default () => 42;\n');
});

test('review runtime failure is final, preserves candidate and cannot fall back to parent repair', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'final-review-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    assert.equal(options.stopHookPolicy, 'fail');
    return { status: 'failed', error: { message: 'HTTP 502 after retries' } };
  } });
  const state = await executor.prepare('runtime-failure');
  await writeFile(path.join(state.workerPath, 'draft.txt'), '未合入');
  let failure;
  try { await executor.finish(state, { nodeId: 'A', status: 'completed' }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'COMPLETION_REVIEW_FAILED');
  assert.match(failure.review.rootCause, /未确认/);
  assert.equal(await readFile(path.join(failure.workspacePath, 'draft.txt'), 'utf8'), '未合入');
  await assert.rejects(readFile(path.join(root, 'draft.txt')), { code: 'ENOENT' });
});

test('direct final-check wrapper preserves maintenance diagnostics from the turn result',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'review-maintenance-roundtrip-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree());
  const details={message:'TREE_NOT_UPDATED: 未更新指定节点',code:'STOP_HOOK_BLOCKED',stage:'postflight',maintenanceOnly:true,maintenanceIssues:['TREE_NOT_UPDATED'],nonMaintenanceBlockers:[],hookReports:[{event:'Stop',source:'project-hook',blocked:true}]};
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async()=>({status:'failed',error:details})});
  const state=await executor.prepare('maintenance-roundtrip');
  await writeFile(path.join(state.workerPath,'draft.txt'),'保留候选');
  await assert.rejects(executor.finish(state,{nodeId:'A',status:'completed'}),error=>{
    assert.equal(error.review.failureCategory,'task-tree-maintenance');
    assert.deepEqual(error.review.maintenanceIssues,details.maintenanceIssues);
    assert.deepEqual(error.review.hookReports,details.hookReports);
    assert.match(error.message,/任务树维护未完成/);
    assert.doesNotMatch(error.message,/检查修复失败/);
    return true;
  });
  await assert.rejects(readFile(path.join(root,'draft.txt')),{code:'ENOENT'});
});

test('final reviewer can repair a malformed tree before the post-repair render check', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'final-review-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let reviews = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    reviews++;
    await writeFile(path.join(options.cwd, 'task-tree.md'), tree('已修复并验证'));
    return { status: 'completed', output: '{"verdict":"pass","reason":"修复图结构"}' };
  } });
  const state = await executor.prepare('tree-repair');
  await writeFile(path.join(state.workerPath, 'task-tree.md'), tree().replace('## A -', '## A.1 -'));
  const receipt = await executor.finish(state, { nodeId: 'A', status: 'completed' });
  assert.equal(reviews, 1); assert.equal(receipt.review.verdict, 'pass');
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree('已修复并验证'));
});

test('failed reviewer reports its case study and stops without another repair or applying changes', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'final-review-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let reviews = 0, repairs = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    reviews++;
    await writeFile(path.join(options.cwd, 'draft.txt'), '失败的修复草稿');
    return { status: 'completed', output: JSON.stringify({ verdict: 'failed', reason: '修复后仍失败', rootCause: '本地依赖缺失', caseStudy: '复现调用失败，定位模块加载而非任务拆分', sources: [{ url: 'https://nodejs.org/api/modules.html', finding: '模块解析规则' }], solution: '安装正确依赖再重试', evidence: ['MODULE_NOT_FOUND'] }) };
  }, startTurn: async () => { repairs++; throw new Error('unexpected repair'); } });
  const state = await executor.prepare('failed-final');
  await writeFile(path.join(state.workerPath, 'draft.txt'), '原草稿');
  let failure;
  try { await executor.finish(state, { nodeId: 'A', objective: '交付可运行模块', status: 'completed' }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'COMPLETION_REVIEW_FAILED');
  assert.match(failure.message, /本地依赖缺失/);
  assert.match(failure.message, /模块加载/);
  assert.match(failure.message, /https:\/\/nodejs.org/);
  assert.equal(reviews, 1); assert.equal(repairs, 0);
  await assert.rejects(readFile(path.join(root, 'draft.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(failure.workspacePath, 'draft.txt'), 'utf8'), '失败的修复草稿');
});

test('a failed direct turn keeps unmerged work recoverable', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const executor = createDirectNodeWorkspace({ projectRoot: root });
  const state = await executor.prepare('failed');
  await writeFile(path.join(state.workerPath, 'draft.txt'), '草稿');
  const result = await executor.finish(state, { nodeId: 'A', status: 'failed' });
  assert.equal(result.status, 'failed');
  assert.equal(result.workspacePath, state.workerPath);
  assert.equal(await readFile(path.join(state.workerPath, 'draft.txt'), 'utf8'), '草稿');
  await assert.rejects(readFile(path.join(root, 'draft.txt')), { code: 'ENOENT' });
  await executor.abandon(state);
});

test('overlapping edits to the same tree field require one resolver and a review of the rebased result', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let resolves = 0;
  const reviewed = [];
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async options => {
    if (options.prompt.includes('【独立合并处理】')) {
      resolves++;
      await writeFile(path.join(options.cwd, 'task-tree.md'), tree('两个节点的成果都保留'));
      await exec('git', ['add', 'task-tree.md'], { cwd: options.cwd });
      return { status: 'completed', output: '冲突已处理' };
    }
    if (options.prompt.includes('【功能验收】')) {
      reviewed.push({prompt:options.prompt,tree:await readFile(path.join(options.cwd,'task-tree.md'),'utf8')});
      return { status: 'completed', output: '{"verdict":"pass","reason":"已核对"}' };
    }
    throw new Error('unexpected turn');
  } });
  const [a, b] = await Promise.all([executor.prepare('same-a'), executor.prepare('same-b')]);
  await Promise.all([
    writeFile(path.join(a.workerPath, 'task-tree.md'), tree('A的成果')),
    writeFile(path.join(b.workerPath, 'task-tree.md'), tree('B的成果'))
  ]);
  await Promise.all([
    executor.finish(a, { nodeId: 'A', objective: '完成A', status: 'completed' }),
    executor.finish(b, { nodeId: 'B', objective: '完成B', status: 'completed' })
  ]);
  assert.equal(resolves, 1);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree('两个节点的成果都保留'));
  assert.ok(reviewed.length >= 2 && reviewed.length <= 3, 'a candidate checked before a competing field applies must be rechecked against the latest result');
  assert.ok(reviewed.some(review => review.tree.includes('两个节点的成果都保留')), 'the merged live candidate must be reviewed');
});

test('six candidate reviews overlap and an early result applies before a slow review completes', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'six-node-reviews-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let active = 0, maxActive = 0, started = 0;
  let releaseReviews, releaseSlow;
  const barrier = new Promise(resolve => { releaseReviews = resolve; });
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  t.after(() => { releaseReviews(); releaseSlow(); });
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async options => {
    active++; started++; maxActive = Math.max(maxActive, active);
    if (started === 6) releaseReviews();
    await barrier;
    if (options.prompt.includes('节点：slow')) await slow;
    active--;
    return { status: 'completed', output: '{"verdict":"pass","reason":"独立交付物完整"}' };
  } });
  const states = await Promise.all(Array.from({ length: 6 }, (_, i) => executor.prepare(`review-${i}`)));
  await Promise.all(states.map((state, i) => writeFile(path.join(state.workerPath, `part-${i}.txt`), String(i))));
  const tasks = states.map((state, i) => executor.finish(state, { nodeId: i === 5 ? 'slow' : String(i), status: 'completed', objective: `交付 ${i}` }));
  await Promise.race([Promise.all(tasks.slice(0, 5)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('reviews were serialized')), 10000); timer.unref(); })]);
  assert.equal(maxActive, 6);
  assert.equal(await readFile(path.join(root, 'part-0.txt'), 'utf8'), '0');
  await assert.rejects(readFile(path.join(root, 'part-5.txt')), { code: 'ENOENT' });
  releaseSlow();
  await tasks[5];
  assert.equal(await readFile(path.join(root, 'part-5.txt'), 'utf8'), '5');
});

test('six independent modules with identical registry creation need exactly one review per branch', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'identical-registry-reviews-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let checks = 0;
  let release;
  const firstReviews = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async () => {
    checks++;
    if (checks === 6) release();
    await firstReviews;
    return { status: 'completed', output: '{"verdict":"pass","reason":"独立模块已完整检查"}' };
  } });
  const states = await Promise.all(Array.from({ length: 6 }, (_, i) => executor.prepare(`registry-${i}`)));
  const registry = JSON.stringify({ schema: 'task-tree-registry/v1', activeMethod: 'method', trees: [{ id: 'method', path: 'task-tree.md' }] });
  await Promise.all(states.map(async (state, i) => {
    await writeFile(path.join(state.workerPath, 'task-trees.json'), registry);
    await writeFile(path.join(state.workerPath, `module-${i}.txt`), `result-${i}`);
  }));
  await Promise.all(states.map((state, i) => executor.finish(state, { nodeId: String(i), status: 'completed', objective: `完成独立模块${i}` })));
  assert.equal(await readFile(path.join(root, 'task-trees.json'), 'utf8'), registry);
  for (let i = 0; i < 6; i++) assert.equal(await readFile(path.join(root, `module-${i}.txt`), 'utf8'), `result-${i}`);
  assert.equal(checks, 6, 'byte-identical concurrent registry writes must not invalidate an already reviewed independent module');
});

test('reviewer-created thread-list cache does not replace host cache or trigger another check', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-runtime-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const cache = JSON.stringify({ fetchedAt: 1, threads: [] });
  await writeFile(path.join(root, '.task-tree-threads.json'), cache);
  let checks = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    checks++;
    await writeFile(path.join(options.cwd, '.task-tree-port'), '5194\n');
    if (checks === 1) await writeFile(path.join(options.cwd, '.task-tree-threads.json'), JSON.stringify({ fetchedAt: 2, threads: [] }));
    await writeFile(path.join(options.cwd, 'repair.txt'), 'necessary repair');
    await writeFile(path.join(options.cwd, 'task-tree.md'), tree('A完成'));
    return { status: 'completed', output: '{"verdict":"pass","reason":"实际修复并验证"}' };
  } });
  const state = await executor.prepare('runtime');
  await writeFile(path.join(state.workerPath, 'result.txt'), 'result');
  const receipt = await executor.finish(state, { nodeId: 'A', objective: '完成A', status: 'completed' });
  assert.equal(checks, 1, 'reviewer runtime cache refresh must not cause another model check');
  assert.deepEqual(receipt.appliedFiles.sort(), ['repair.txt', 'result.txt', 'task-tree.md']);
  assert.equal(await readFile(path.join(root, '.task-tree-threads.json'), 'utf8'), cache);
  await assert.rejects(readFile(path.join(root, '.task-tree-port')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'repair.txt'), 'utf8'), 'necessary repair');
});

test('semantically identical registry serializations retain one check and live bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-registry-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const before = { schema: 'task-tree-registry/v1', activeMethod: 'a', trees: [{ id: 'a', path: 'task-tree.md' }] };
  const live = { trees: [{ path: 'task-tree.md', id: 'a' }], activeMethod: 'a', schema: 'task-tree-registry/v1' };
  await writeFile(path.join(root, 'task-trees.json'), JSON.stringify(before));
  let checks = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, reviewTurn: async options => {
    checks++;
    if (checks === 1) {
      await writeFile(path.join(options.cwd, 'task-trees.json'), JSON.stringify({ activeMethod: 'a', schema: before.schema, trees: before.trees }, null, 2));
      await writeFile(path.join(root, 'task-trees.json'), JSON.stringify(live));
    }
    return { status: 'completed', output: '{"verdict":"pass","reason":"只改变序列化，模块正确"}' };
  } });
  const state = await executor.prepare('registry-order');
  await writeFile(path.join(state.workerPath, 'result.txt'), 'result');
  const receipt = await executor.finish(state, { nodeId: 'A', status: 'completed' });
  assert.equal(checks, 1);
  assert.deepEqual(receipt.appliedFiles, ['result.txt']);
  assert.equal(await readFile(path.join(root, 'task-trees.json'), 'utf8'), JSON.stringify(live));
});

test('identical deletion, executable and symlink merge with independent tree fields without re-review', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'redundant-entry-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  await writeFile(path.join(root, 'obsolete.txt'), 'old');
  let checks = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async () => {
    checks++;
    if (checks === 2) release();
    await barrier;
    return { status: 'completed', output: '{"verdict":"pass","reason":"结果符合目标"}' };
  } });
  const states = await Promise.all(['a', 'b'].map(id => executor.prepare(`entries-${id}`)));
  await Promise.all(states.map(async (state, i) => {
    await rm(path.join(state.workerPath, 'obsolete.txt'));
    await writeFile(path.join(state.workerPath, 'shared-executable'), 'same');
    await chmod(path.join(state.workerPath, 'shared-executable'), 0o755);
    await symlink('shared-executable', path.join(state.workerPath, 'shared-link'));
    await writeFile(path.join(state.workerPath, 'task-tree.md'), i ? tree('', 'B完成') : tree('A完成'));
  }));
  const receipts = await Promise.all(states.map((state, i) => executor.finish(state, { nodeId: i ? 'B' : 'A', status: 'completed', objective: '独立树字段与共同文件处理' })));
  for (const [i, receipt] of receipts.entries()) {
    assert.equal(receipt.treeChanges.length, 1, 'receipt attributes only this atomic apply, not the other worker');
    assert.equal(receipt.treeChanges[0].treePath, 'task-tree.md');
    assert.deepEqual(receipt.treeChanges[0].changes.map(c => [c.nodeId, c.field, c.before, c.after]),
      [[i ? 'B' : 'A', 'CurrentResult', '', i ? 'B完成' : 'A完成']]);
  }
  assert.equal(checks, 2);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree('A完成', 'B完成'));
  await assert.rejects(lstat(path.join(root, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'shared-executable'), 'utf8'), 'same');
  assert.ok((await lstat(path.join(root, 'shared-executable'))).mode & 0o111);
  assert.equal(await readlink(path.join(root, 'shared-link')), 'shared-executable');
  for (const file of ['obsolete.txt', 'shared-executable', 'shared-link']) assert.equal(receipts.filter(r => r.appliedFiles.includes(file)).length, 1);
});

test('a rejected integrated candidate never reaches the live project and remains recoverable', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-rejected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async () => ({
    status: 'completed', output: '{"verdict":"failed","reason":"成果尚未满足目标，修复无法实施"}'
  }) });
  const state = await executor.prepare('rejected');
  await writeFile(path.join(state.workerPath, 'task-tree.md'), tree('尚未完成'));
  await assert.rejects(executor.finish(state, { nodeId: 'A', objective: '完成A', status: 'completed' }), /成果尚未满足目标/);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree());
  assert.equal(await readFile(path.join(state.workerPath, 'task-tree.md'), 'utf8'), tree('尚未完成'));
  await executor.abandon(state);
});

test('a direct candidate receives final checker repairs without another review turn', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  let checks = 0;
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async options => {
    if (options.prompt.includes('【功能验收】')) {
      checks++;
      await writeFile(path.join(options.cwd, 'repair.txt'), '补齐\n');
      return { status: 'completed', output: '{"verdict":"pass","reason":"已经补齐并复验"}' };
    }
    throw new Error('unexpected turn');
  } });
  const state = await executor.prepare('repair');
  await writeFile(path.join(state.workerPath, 'original.txt'), '原成果\n');
  const result = await executor.finish(state, { nodeId: 'A', objective: '完成并补齐A', status: 'completed' });
  assert.equal(checks, 1);
  assert.deepEqual(result.appliedFiles.sort(), ['original.txt', 'repair.txt']);
  assert.equal(await readFile(path.join(root, 'original.txt'), 'utf8'), '原成果\n');
  assert.equal(await readFile(path.join(root, 'repair.txt'), 'utf8'), '补齐\n');
});

test('an actual node tree-tool write stays isolated until the direct run is accepted', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'direct-tree-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree());
  const executor = createDirectNodeWorkspace({ projectRoot: root, startTurn: async () => ({
    status: 'completed', output: '{"verdict":"pass","reason":"已核对候选差异"}'
  }) });
  const state = await executor.prepare('tree-tool');
  const bridge = await createTaskTreeAgentTools({ cwd: state.workerPath, environment: {
    TASK_TREE_PROJECT_ROOT: root, TASK_TREE_CONTEXT_TREE_FILE: 'task-tree.md'
  } });
  try {
    const receipt = await bridge.call('task_tree_write', { nodeId: 'A', fields: { CurrentResult: '已由节点执行者完成' }, reason: '验证直接执行树回写' });
    assert.ok(receipt.changes.some(change => change.nodeId === 'A'));
    assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree());
  } finally {
    await bridge.close();
    const pid = Number(await readFile(path.join(state.workerPath, '.task-tree-server.pid'), 'utf8').catch(() => 0));
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const result = await executor.finish(state, { nodeId: 'A', objective: '完成A并回写树', status: 'completed' });
  assert.ok(result.appliedFiles.includes('task-tree.md'));
  assert.match(await readFile(path.join(root, 'task-tree.md'), 'utf8'), /已由节点执行者完成/);
});
