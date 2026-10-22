import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGitWorkspaceManager, gitCommand, gitCommandToFile } from './parallel-worktree.js';
import { reviewEvidence } from './review-evidence.js';

test('final-review evidence bounds inline diffs and references logs and large datasets on demand',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'review-evidence-budget-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  await mkdir(path.join(projectRoot,'.task-tree-runs'),{recursive:true});
  await mkdir(path.join(projectRoot,'data'),{recursive:true});
  await mkdir(path.join(projectRoot,'src'),{recursive:true});
  await writeFile(path.join(projectRoot,'.task-tree-runs/run.json'),'old run\n');
  await writeFile(path.join(projectRoot,'data/people.json'),JSON.stringify({records:Array.from({length:5000},(_,i)=>({id:i,note:`DATASET_PRIVATE_${i}`}))}));
  await writeFile(path.join(projectRoot,'src/app.js'),'export const value = "old";\n');
  const workspace=createGitWorkspaceManager({projectRoot});
  const prepared=await workspace.prepare('review-evidence-budget');
  const worker=await workspace.createWorker('review-evidence-budget','worker',prepared.snapshotCommit);
  try {
    await writeFile(path.join(worker,'.task-tree-runs/run.json'),'RUN_TRACE_PRIVATE '.repeat(12000));
    await writeFile(path.join(worker,'data/people.json'),JSON.stringify({records:Array.from({length:5000},(_,i)=>({id:i,note:`DATASET_PRIVATE_CHANGED_${i}`}))}));
    await writeFile(path.join(worker,'src/app.js'),'export const value = "small-code-sentinel";\n');
    const commit=await workspace.commit(worker,'candidate');
    await workspace.integrate(prepared.integrationPath,commit,prepared.snapshotCommit);
    const summary=await workspace.summarize(prepared.integrationPath,prepared.snapshotCommit,{forReview:true});
    const evidence=reviewEvidence(summary);
    assert.ok(summary.patchPreview.includes('small-code-sentinel'));
    assert.ok(!summary.patchPreview.includes('RUN_TRACE_PRIVATE'));
    assert.ok(!summary.patchPreview.includes('DATASET_PRIVATE_CHANGED'));
    assert.ok(summary.deferredEvidence.files.includes('.task-tree-runs/run.json'));
    assert.ok(summary.deferredEvidence.files.includes('data/people.json'));
    assert.match(evidence,/\.task-tree-runs\/run\.json/);
    assert.match(evidence,/data\/people\.json/);
    assert.ok(!evidence.includes('RUN_TRACE_PRIVATE'));
    assert.ok(!evidence.includes('DATASET_PRIVATE_CHANGED'));
  } finally {
    await workspace.removeWorker(worker);
    await workspace.cleanup({...prepared,runId:'review-evidence-budget'});
  }
});

test('failed git worktree creation removes its incomplete checkout and stale registration',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'failed-worktree-cleanup-'));
  const tempRoot=await mkdtemp(path.join(os.tmpdir(),'failed-worktree-temp-'));
  t.after(()=>Promise.all([projectRoot,tempRoot].map(root=>rm(root,{recursive:true,force:true}))));
  const workspace=createGitWorkspaceManager({projectRoot,tempRoot});
  const prepared=await workspace.prepare('failed-add');
  const workerPath=path.join(prepared.runDir,'worker-invalid');
  await assert.rejects(workspace.createWorker('failed-add','invalid','not-a-commit'));
  await assert.rejects(stat(workerPath),{code:'ENOENT'});
  const registered=await gitCommand(projectRoot,['worktree','list','--porcelain']);
  assert.ok(!registered.includes(workerPath));
  await workspace.cleanup({...prepared,runId:'failed-add'});
});

test('failed persistent worker can reopen its dirty Git worktree without resetting saved files', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'persistent-worker-retry-project-'));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'persistent-worker-retry-state-'));
  t.after(() => Promise.all([projectRoot, tempRoot].map(root => rm(root, { recursive: true, force: true }))));
  await writeFile(path.join(projectRoot, 'result.txt'), 'base\n');
  await gitCommand(projectRoot, ['init', '-q']);
  await gitCommand(projectRoot, ['add', 'result.txt']);
  await gitCommand(projectRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);

  const workspace = createGitWorkspaceManager({ projectRoot, tempRoot });
  const prepared = await workspace.prepare('persistent-worker-retry');
  const contextKey = 'retry-context';
  const workerPath = await workspace.createWorker('persistent-worker-retry', 'task-a', prepared.snapshotCommit, {
    contextKey,
    persistentContext: true
  });
  await writeFile(path.join(workerPath, 'result.txt'), 'partial saved work\n');
  await workspace.removeWorker(workerPath, { preserveContext: true, contextKey });

  const resumedPath = await workspace.resumePersistentWorker(contextKey);
  assert.equal(resumedPath, workerPath);
  await workspace.resumeWorker(resumedPath, { contextKey });
  assert.equal(await readFile(path.join(resumedPath, 'result.txt'), 'utf8'), 'partial saved work\n');
  await workspace.removeWorker(resumedPath, { preserveContext: true, contextKey });
  await workspace.cleanup({ ...prepared, runId: 'persistent-worker-retry' });
});

test('serialized input receipts survive temporary worktree cleanup and manager reconstruction without entering Git',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'persistent-input-recovery-'));
  const taskTemp=await mkdtemp(path.join(os.tmpdir(),'input-worker-temp-'));
  const nextTemp=await mkdtemp(path.join(os.tmpdir(),'input-worker-next-'));
  t.after(()=>Promise.all([projectRoot,taskTemp,nextTemp].map(root=>rm(root,{recursive:true,force:true}))));
  await writeFile(path.join(projectRoot,'.gitignore'),'.task-tree-runs/\n');
  const source=path.join(taskTemp,'worker');await mkdir(source);
  await writeFile(path.join(source,'input.txt'),'persistent input');
  await writeFile(path.join(source,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['input.txt']}));
  const first=createGitWorkspaceManager({projectRoot,tempRoot:taskTemp});
  const receipt=JSON.parse(JSON.stringify(await first.captureReviewInputs(source)));
  assert.equal(path.dirname(path.dirname(receipt.manifestPath)),path.join(projectRoot,'.task-tree-runs/review-inputs'));
  await rm(taskTemp,{recursive:true,force:true});
  const rebuilt=createGitWorkspaceManager({projectRoot,tempRoot:nextTemp});
  const state=await rebuilt.prepare('recovered-inputs');
  try {
    const inventory=await gitCommand(state.integrationPath,['ls-files','-z']);
    assert.ok(!inventory.includes('.task-tree-runs/review-inputs/'));
    const candidate=await rebuilt.createWorker('recovered-inputs','candidate',state.snapshotCommit);
    try {
      await rebuilt.materializeReviewInputs(candidate,[receipt],{register:true});
      assert.equal(await readFile(path.join(candidate,'input.txt'),'utf8'),'persistent input');
      const again=createGitWorkspaceManager({projectRoot,tempRoot:nextTemp});
      assert.deepEqual((await again.inspectChanges(candidate,state.snapshotCommit)).changedFiles,[]);
      const descendant=await again.captureReviewInputs(candidate);
      assert.ok(descendant.supersedes.includes(receipt.manifestPath));
      await again.releaseReviewInputs([descendant]);
    } finally {await rebuilt.removeWorker(candidate);}
    await rebuilt.releaseReviewInputs([receipt]);
  }finally{await rebuilt.cleanup({...state,runId:'recovered-inputs'});}
});

test('input snapshot cleanup is explicit and refuses paths outside its project-owned snapshot directory',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'snapshot-cleanup-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  const workspace=createGitWorkspaceManager({projectRoot});
  await writeFile(path.join(projectRoot,'input.txt'),'preserve original');
  await writeFile(path.join(projectRoot,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['input.txt']}));
  const receipt=await workspace.captureReviewInputs(projectRoot);
  assert.equal((await stat(receipt.manifestPath)).isFile(),true);
  await assert.rejects(workspace.releaseReviewInputs([{snapshotRoot:projectRoot}]),{code:'REVIEW_INPUT_PATH_INVALID'});
  assert.equal(await readFile(path.join(projectRoot,'input.txt'),'utf8'),'preserve original');
  await workspace.releaseReviewInputs([receipt]);
  await assert.rejects(readFile(receipt.manifestPath),{code:'ENOENT'});
  assert.equal(await readFile(path.join(projectRoot,'input.txt'),'utf8'),'preserve original');
});

test('a child input snapshot supersedes its inherited baseline without hiding conflicting sibling inputs',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'snapshot-lineage-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  const workspace=createGitWorkspaceManager({projectRoot});
  await mkdir(path.join(projectRoot,'parent'));
  const parent=path.join(projectRoot,'parent');
  await writeFile(path.join(parent,'input.txt'),'parent version');
  await writeFile(path.join(parent,'.task-tree-review-inputs.json'),JSON.stringify({schema:1,paths:['input.txt']}));
  const baseline=await workspace.captureReviewInputs(parent);
  const snapshots=[];
  for(const name of ['a','b']){
    const child=path.join(projectRoot,name);await mkdir(child);
    await workspace.materializeReviewInputs(child,[baseline],{register:true});
    await chmod(path.join(child,'input.txt'),0o644);
    await writeFile(path.join(child,'input.txt'),`${name} version`);
    snapshots.push(await workspace.captureReviewInputs(child));
  }
  const candidate=path.join(projectRoot,'review');await mkdir(candidate);
  await workspace.materializeReviewInputs(candidate,[baseline,snapshots[0]]);
  assert.equal(await readFile(path.join(candidate,'input.txt'),'utf8'),'a version');
  const other=path.join(projectRoot,'other-review');await mkdir(other);
  await assert.rejects(workspace.materializeReviewInputs(other,[baseline,...snapshots]),{code:'REVIEW_INPUT_COLLISION'});
  await workspace.releaseReviewInputs([baseline,...snapshots]);
});

test('project snapshot carries both paths of a staged tree rename without resurrecting its source',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'snapshot-tree-rename-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  await writeFile(path.join(projectRoot,'old.md'),'# 已迁移的树\n');
  await gitCommand(projectRoot,['init','-q']);
  await gitCommand(projectRoot,['add','.']);
  await gitCommand(projectRoot,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
  await writeFile(path.join(projectRoot,'new.md'),'# 已迁移的树\n');
  await rm(path.join(projectRoot,'old.md'));
  await gitCommand(projectRoot,['add','-A']);
  const workspace=createGitWorkspaceManager({projectRoot});
  const state=await workspace.prepare('renamed-snapshot');
  try {
    await assert.rejects(readFile(path.join(state.integrationPath,'old.md')),{code:'ENOENT'});
    assert.equal(await readFile(path.join(state.integrationPath,'new.md'),'utf8'),'# 已迁移的树\n');
  } finally {await workspace.cleanup({...state,runId:'renamed-snapshot'});}
});

test('ignored subtree artifacts survive snapshot, worker commit, integration and delivery', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'ignored-subtree-delivery-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, '.gitignore'), 'subtrees/\n');
  await writeFile(path.join(projectRoot, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 主树\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  await mkdir(path.join(projectRoot, 'subtrees'));
  await writeFile(path.join(projectRoot, 'subtrees', 'existing.md'), '# 已有子树\n');
  const workspace = createGitWorkspaceManager({ projectRoot });
  const prepared = await workspace.prepare('ignored-subtrees');
  const worker = await workspace.createWorker('ignored-subtrees', 'worker', prepared.snapshotCommit);
  try {
    assert.equal(await readFile(path.join(worker, 'subtrees', 'existing.md'), 'utf8'), '# 已有子树\n');
    const subtree = '# LLM Task Graph\n## PROOT - 人物树\n- Problem: 记录人物\n# GraphState\n- Current: PROOT\n- Next: PROOT\n# Edges\n';
    await writeFile(path.join(worker, 'subtrees', 'people-tree.md'), subtree);
    await writeFile(path.join(worker, 'subtrees', 'people-tree.task.json'), '{"nodeId":"PROOT"}\n');
    await writeFile(path.join(worker, 'subtrees', '.env'), 'not a tree artifact\n');
    await writeFile(path.join(worker, 'subtrees', 'scratch.tmp'), 'not a tree artifact\n');
    const inspected = await workspace.inspectChanges(worker, prepared.snapshotCommit);
    assert.deepEqual(inspected.changedFiles, ['subtrees/people-tree.md', 'subtrees/people-tree.task.json']);
    const commit = await workspace.commit(worker, 'new folded subtree', prepared.snapshotCommit);
    assert.deepEqual((await workspace.integrate(prepared.integrationPath, commit, prepared.snapshotCommit)).conflicts, []);
    const receipt = await workspace.accept({ integrationPath: prepared.integrationPath, snapshotCommit: prepared.snapshotCommit, changedFiles: inspected.changedFiles });
    assert.deepEqual(receipt.appliedFiles, inspected.changedFiles);
    assert.equal(await readFile(path.join(projectRoot, 'subtrees', 'people-tree.md'), 'utf8'), subtree);
    assert.equal(await readFile(path.join(projectRoot, 'subtrees', 'people-tree.task.json'), 'utf8'), '{"nodeId":"PROOT"}\n');
    await assert.rejects(readFile(path.join(projectRoot, 'subtrees', '.env')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(projectRoot, 'subtrees', 'scratch.tmp')), { code: 'ENOENT' });
  } finally {
    await workspace.removeWorker(worker);
    await workspace.cleanup({ ...prepared, runId: 'ignored-subtrees' });
  }
});

test('Git failures preserve context when buffer-mode stderr and stdout are empty', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'empty-git-diagnostics-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fakeBin = path.join(cwd, 'bin');
  await mkdir(fakeBin);
  const fakeGit = path.join(fakeBin, 'git');
  await writeFile(fakeGit, '#!/bin/sh\nexit 17\n');
  await chmod(fakeGit, 0o755);
  await assert.rejects(
    () => gitCommand(cwd, ['diff', '--binary', 'deadbeef'], {
      encoding: 'buffer', env: { PATH: `${fakeBin}:${process.env.PATH}` }
    }),
    error => {
      assert.match(error.message, /git diff 失败/);
      assert.match(error.message, new RegExp(`cwd=${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(error.message, /args=\["diff","--binary","deadbeef"\]/);
      assert.match(error.message, /Git 进程未返回诊断文本|process:/);
      assert.match(error.message, /exit=17/);
      assert.equal(error.cwd, cwd);
      assert.deepEqual(error.args, ['diff', '--binary', 'deadbeef']);
      return true;
    }
  );
});

test('Git diff failures never collapse to an empty diagnostic', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'empty-git-diff-diagnostics-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fakeBin = path.join(cwd, 'bin');
  await mkdir(fakeBin);
  const fakeGit = path.join(fakeBin, 'git');
  await writeFile(fakeGit, '#!/bin/sh\nexit 23\n');
  await chmod(fakeGit, 0o755);
  await assert.rejects(
    () => gitCommandToFile(cwd, ['diff', '--binary', 'deadbeef'], path.join(cwd, 'out.patch'), { env: { PATH: `${fakeBin}:${process.env.PATH}` } }),
    error => {
      assert.match(error.message, /git diff 失败/);
      assert.match(error.message, /process: git exited with code 23/);
      assert.match(error.message, /exit=23/);
      return true;
    }
  );
});

test('accept streams a binary patch larger than the former execFile maxBuffer', { timeout: 60000 }, async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'git-stream-output-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const workspace = createGitWorkspaceManager({ projectRoot });
  const state = await workspace.prepare('stream-output');
  const workerPath = await workspace.createWorker('stream-output', 'large-payload', state.snapshotCommit);
  const blob = randomBytes(52 * 1024 * 1024);
  try {
    await writeFile(path.join(workerPath, 'large.bin'), blob);
    const commit = await workspace.commit(workerPath, 'large binary', state.snapshotCommit);
    await workspace.integrate(state.integrationPath, commit, state.snapshotCommit);
    const receipt = await workspace.accept({
      integrationPath: state.integrationPath,
      snapshotCommit: state.snapshotCommit,
      changedFiles: ['large.bin']
    });
    assert.deepEqual(receipt.appliedFiles, ['large.bin']);
    assert.deepEqual(await readFile(path.join(projectRoot, 'large.bin')), blob);
  } finally {
    await workspace.removeWorker(workerPath);
    await workspace.cleanup({ ...state, runId: 'stream-output' });
  }
});

test('binary Git output streams to disk and reports its byte count', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'git-stream-output-file-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const workspace = createGitWorkspaceManager({ projectRoot });
  const state = await workspace.prepare('stream-output-file');
  const blob = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  try {
    await writeFile(path.join(state.integrationPath, 'large.bin'), blob);
    const commit = await workspace.commit(state.integrationPath, 'large binary', state.snapshotCommit);
    const patchPath = path.join(state.runDir, 'large.patch');
    const result = await gitCommandToFile(state.integrationPath,
      ['diff', '--binary', state.snapshotCommit, commit, '--'], patchPath);
    assert.ok(result.bytes > 2 * 1024 * 1024);
    assert.equal((await stat(patchPath)).size, result.bytes);
  } finally {
    await workspace.cleanup({ ...state, runId: 'stream-output-file' });
  }
});

test('a dialogue atomic-save temporary file is excluded even if it disappears after inventory', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'snapshot-runtime-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const temporary = path.join(projectRoot, '.task-tree-direct-state.json.123.tmp');
  await writeFile(path.join(projectRoot, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 测试\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  await writeFile(temporary, 'atomic temporary state');
  const workspace = createGitWorkspaceManager({ projectRoot });
  workspace.setTimingObserver(async ({ command }) => { if (command === 'ls-files') await rm(temporary, { force: true }); });
  const state = await workspace.prepare('runtime-race');
  try { assert.equal(state.snapshotPaths, 1); }
  finally { await workspace.cleanup({ ...state, runId: 'runtime-race' }); }
});

test('worker artifacts merge freely but cannot overwrite the host-owned chat and unsent drafts', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'worker-full-project-write-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, '.gitignore'), [
    '.task-tree-direct-state.json', '.task-tree-dialogue-drafts.json', '.task-tree-runs/', '.task-tree-scopes/',
    '.task-tree-threads.json', '.task-tree-server.pid'
  ].join('\n') + '\n');
  await writeFile(path.join(projectRoot, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 写入\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  await writeFile(path.join(projectRoot, '.task-tree-direct-state.json'), '{"version":1}\n');
  await writeFile(path.join(projectRoot, '.task-tree-dialogue-drafts.json'), '{"draft":"用户未发送内容"}\n');
  await mkdir(path.join(projectRoot, '.task-tree-runs'), { recursive: true });
  await writeFile(path.join(projectRoot, '.task-tree-runs', 'run.json'), '{"status":"queued"}\n');
  const workspace = createGitWorkspaceManager({ projectRoot, tempRoot: path.join(projectRoot, 'tmp') });
  const prepared = await workspace.prepare('full-project-write');
  const worker = await workspace.createWorker('full-project-write', 'worker', prepared.snapshotCommit);
  try {
    await writeFile(path.join(worker, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 已更新\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
    await writeFile(path.join(worker, '.task-tree-direct-state.json'), '{"version":2}\n');
    await writeFile(path.join(worker, '.task-tree-dialogue-drafts.json'), '{"draft":"旧分支内容"}\n');
    await writeFile(path.join(worker, '.task-tree-runs', 'run.json'), '{"status":"completed"}\n');
    await writeFile(path.join(worker, 'unplanned.txt'), '不在 writeSet 中也要保留\n');
    await writeFile(path.join(worker, '.task-tree-server.pid'), '瞬时文件不交付\n');
    const inspected = await workspace.inspectChanges(worker, prepared.snapshotCommit, ['only-planner-predicted.txt']);
    assert.deepEqual(inspected.changedFiles, ['.task-tree-runs/run.json', 'task-tree.md', 'unplanned.txt']);
    const commit = await workspace.commit(worker, 'worker full project result', prepared.snapshotCommit);
    const integrated = await workspace.integrate(prepared.integrationPath, commit, prepared.snapshotCommit);
    assert.deepEqual(integrated.conflicts, []);
    const receipt = await workspace.accept({
      integrationPath: prepared.integrationPath,
      snapshotCommit: prepared.snapshotCommit,
      changedFiles: inspected.changedFiles
    });
    assert.deepEqual(receipt.appliedFiles, inspected.changedFiles);
    assert.equal(await readFile(path.join(projectRoot, '.task-tree-direct-state.json'), 'utf8'), '{"version":1}\n');
    assert.equal(await readFile(path.join(projectRoot, '.task-tree-dialogue-drafts.json'), 'utf8'), '{"draft":"用户未发送内容"}\n');
    assert.equal(await readFile(path.join(projectRoot, '.task-tree-runs', 'run.json'), 'utf8'), '{"status":"completed"}\n');
    assert.match(await readFile(path.join(projectRoot, 'task-tree.md'), 'utf8'), /已更新/);
    assert.equal(await readFile(path.join(projectRoot, 'unplanned.txt'), 'utf8'), '不在 writeSet 中也要保留\n');
    await assert.rejects(readFile(path.join(projectRoot, '.task-tree-server.pid')), { code: 'ENOENT' });
  } finally {
    await workspace.removeWorker(worker);
    await workspace.cleanup({ ...prepared, runId: 'full-project-write' });
  }
});

test('tracked legacy chat is absent from new snapshots and an old candidate cannot roll it back at delivery',async t=>{
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'legacy-chat-delivery-'));
  t.after(()=>rm(projectRoot,{recursive:true,force:true}));
  const state='.task-tree-direct-state.json';
  await writeFile(path.join(projectRoot,state),'old tracked messages\n');
  await gitCommand(projectRoot,['init','-q']);await gitCommand(projectRoot,['add','.']);
  await gitCommand(projectRoot,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','legacy']);
  const workspace=createGitWorkspaceManager({projectRoot});
  const prepared=await workspace.prepare('legacy-chat');
  const worker=await workspace.createWorker('legacy-chat','old-candidate',prepared.snapshotCommit);
  try{
    await assert.rejects(readFile(path.join(worker,state)),{code:'ENOENT'});
    await writeFile(path.join(worker,state),'branch-owned obsolete history\n');
    await writeFile(path.join(worker,'result.txt'),'real artifact\n');
    // Simulate a candidate made before host-owned files were filtered.
    await gitCommand(worker,['add','--',state,'result.txt']);
    await gitCommand(worker,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','old candidate']);
    const commit=(await gitCommand(worker,['rev-parse','HEAD'])).trim();
    await workspace.integrate(prepared.integrationPath,commit,prepared.snapshotCommit);
    await writeFile(path.join(projectRoot,state),'new live messages\n');
    const receipt=await workspace.accept({integrationPath:prepared.integrationPath,snapshotCommit:prepared.snapshotCommit,changedFiles:[state,'result.txt']});
    assert.deepEqual(receipt.appliedFiles,['result.txt']);
    assert.equal(await readFile(path.join(projectRoot,state),'utf8'),'new live messages\n');
    assert.equal(await readFile(path.join(projectRoot,'result.txt'),'utf8'),'real artifact\n');
  }finally{await workspace.removeWorker(worker);await workspace.cleanup({...prepared,runId:'legacy-chat'});}
});
