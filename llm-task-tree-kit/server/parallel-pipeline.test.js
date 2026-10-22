import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createParallelCodexCoordinator, deriveParallelGoal } from './codex-coordinator.js';
import { createGitWorkspaceManager } from './parallel-worktree.js';
import { createTaskTreeAgentTools } from './task-tree-agent-tools.js';

const exec = promisify(execFile);
const tree = id => `# LLM Task Graph\n## ROOT - 项目\n- Problem: 完成项目\n## ${id} - 阶段\n- Problem: 完成独立结果\n# GraphState\n- Current: ${id}\n- Next: ${id}\n# Edges\n`;
test('the default parallel objective executes the node NextIdea, never the stale GraphState NextPlan', () => {
  const markdown = tree('SOURCE').replace('- Problem: 完成独立结果', '- Problem: 完成独立结果\n- NextIdea: 修复编辑按钮')
    .replace('- Next: SOURCE', '- Next: SOURCE\n- NextPlan: 已废弃的旧计划');
  assert.equal(deriveParallelGoal(markdown).immediate, '修复编辑按钮');
  assert.equal(deriveParallelGoal(markdown, '用户最新目标').immediate, '用户最新目标');
});
async function fixture(t, initialized = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), tree('SOURCE'));
  if (initialized) {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
  }
  return root;
}

test('final checker can read the complete host assignment and evidence manifest without copied reports in prompt',async t=>{
  const root=await fixture(t,true);
  let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,
    startTurn:async options=>{await writeFile(path.join(options.cwd,'result.txt'),'完整内容');return {status:'completed',output:'UNIQUE_WORKER_EVIDENCE'};},
    reviewTurn:async options=>{
      checks++;
      const manifestPath=options.prompt.match(/验收证据清单：([^\n]+)/)?.[1];
      assert.ok(manifestPath,'the checker must receive a real manifest locator');
      const manifest=JSON.parse(await readFile(path.join(options.cwd,manifestPath),'utf8'));
      assert.equal(manifest.jobs[0].instruction,'写好完整结果');
      assert.equal(manifest.jobs[0].evidence,'UNIQUE_WORKER_EVIDENCE');
      assert.deepEqual(manifest.jobs[0].acceptanceCriteria,['结果必须是完整内容']);
      assert.equal(manifest.jobs[0].deliveryReceipt[0].status,'satisfied');
      assert.doesNotMatch(options.prompt,/UNIQUE_WORKER_EVIDENCE/);
      return {status:'completed',output:'{"verdict":"pass","reason":"已按合同核对产物"}'};
    }});
  const run=await coordinator.start([{taskId:'A',nodeId:'SOURCE',instruction:'写好完整结果',
    deliverables:[{path:'result.txt',mode:'update'}],acceptanceCriteria:['结果必须是完整内容']}],{incremental:true,finalReviewOnly:true});
  const done=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(done.status,'accepted',done.error);assert.equal(checks,1);
  assert.ok(!done.result.appliedFiles.some(file=>file.endsWith('coordination-evidence.json')));
});

test('coordinator sends a missing declared artifact back only to its owner before final acceptance',async t=>{
  const root=await fixture(t,true),counts=new Map();let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1],n=(counts.get(id)||0)+1;counts.set(id,n);
    if(id==='B'||n>1)await writeFile(path.join(options.cwd,`${id}.txt`),'落盘成果');
    await options.onAccepted?.({threadId:`thread-${id}`,turnId:`${id}-${n}`});
    return {status:'completed',threadId:`thread-${id}`,output:'我已经完成了'};
  },reviewTurn:async()=>{checks++;return {status:'completed',output:'{"verdict":"pass","reason":"两个成果均已存在"}'};}});
  const run=await coordinator.start(['A','B'].map(id=>({taskId:id,nodeId:'SOURCE',instruction:`交付${id}`,deliverables:[{path:`${id}.txt`,mode:'update'}]})),{incremental:true,finalReviewOnly:true});
  const done=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(done.status,'accepted',done.error);
  assert.equal(counts.get('A'),2);assert.equal(counts.get('B'),1);assert.equal(checks,1);
  assert.ok(done.events.some(event=>event.type==='coordination_recovery_scheduled'&&event.taskId==='A'));
});

test('a context-summary failure rotates only the affected worker from its durable checkpoint',async t=>{
  const root=await fixture(t,true),calls=new Map(),directories=new Map();let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async options=>{
    const id=options.prompt.match(/^Task id: (.+)$/m)[1],n=(calls.get(id)||0)+1;calls.set(id,n);
    await options.onAccepted?.({threadId:`thread-${id}-${n}`,turnId:`turn-${id}-${n}`});
    if(id==='A'&&n===1) {
      directories.set(id,options.cwd);await writeFile(path.join(options.cwd,'partial.txt'),'保存的事实');
      return {status:'failed',threadId:'thread-A-1',output:'partial.txt已保存，A.txt未完成',error:{message:'摘要重复',code:'CONTEXT_SUMMARY_NO_PROGRESS'}};
    }
    if(id==='A') {
      assert.equal(options.cwd,directories.get(id));assert.equal(options.forceNewThread,true);assert.equal(options.threadId,'');
      assert.equal(await readFile(path.join(options.cwd,'partial.txt'),'utf8'),'保存的事实');
      const handoff=JSON.parse(await readFile(path.join(options.cwd,'.task-tree-context/handoff.json'),'utf8'));
      assert.match(handoff.currentResult,/partial.txt/);assert.equal(handoff.parentThreadId,'thread-A-1');
    }
    await writeFile(path.join(options.cwd,`${id}.txt`),'已完成');
    return {status:'completed',threadId:`thread-${id}-${n}`,output:'已完成实际交付'};
  },reviewTurn:async()=>{checks++;return {status:'completed',output:'{"verdict":"pass","reason":"检查点续跑后成果完整"}'};}});
  const run=await coordinator.start(['A','B'].map(id=>({taskId:id,nodeId:'SOURCE',instruction:`交付${id}`,deliverables:[{path:`${id}.txt`,mode:'update'}]})),{incremental:true,finalReviewOnly:true});
  const done=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(done.status,'accepted',done.error);assert.equal(calls.get('A'),2);assert.equal(calls.get('B'),1);assert.equal(checks,1);
  assert.equal(done.jobs.find(job=>job.taskId==='A').contextGeneration,2);
});

test('unchanged missing delivery terminates honestly after one targeted remedy, without a whole-run retry',async t=>{
  const root=await fixture(t,true);let calls=0,checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,startTurn:async()=>{calls++;return {status:'completed',output:'只输出文字，没有落盘'};},
    reviewTurn:async()=>{checks++;return {status:'completed',output:'{"verdict":"pass","reason":"不应到这里"}'};}});
  const run=await coordinator.start([{taskId:'A',nodeId:'SOURCE',instruction:'必须写result.txt',deliverables:[{path:'result.txt',mode:'update'}]}],{incremental:true,finalReviewOnly:true});
  const done=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(done.status,'failed');assert.equal(calls,2);assert.equal(checks,0);
  assert.match(done.error,/result.txt.*不存在/);assert.equal(done.coordination.phase,'blocked');
});

test('final-only pipeline publishes reviewer progress while completed workers remain pending acceptance',async t=>{
  const root=await fixture(t,true);
  let release,started;
  const hold=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  t.after(()=>release());
  const progress=[];let checks=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,
    startTurn:async options=>{await writeFile(path.join(options.cwd,'result.txt'),'真实产物');return {status:'completed',output:'本轮全部完成'};},
    reviewTurn:async options=>{
      checks++;options.onNotification({method:'tool/started',params:{toolName:'read_file'}});
      started();await hold;return {status:'completed',output:'{"verdict":"failed","reason":"目标尚未完整实现","rootCause":"缺少指定交付物","solution":"补齐交付物"}'};
    }});
  const run=await coordinator.start([{taskId:'A',nodeId:'SOURCE',instruction:'完成完整任务'}],{incremental:true,finalReviewOnly:true,onProgress:p=>progress.push(p)});
  await ready;
  const pending=await coordinator.get(run.id);
  assert.equal(pending.status,'checking');assert.equal(pending.jobs[0].status,'completed');
  assert.ok(progress.some(p=>p.event==='final_review_progress'&&p.detail.notification.params.toolName==='read_file'));
  release();const finished=await coordinator.wait(run.id);await coordinator.drain();
  assert.equal(finished.status,'failed');assert.equal(checks,1);assert.equal(await readFile(path.join(root,'result.txt'),'utf8'),'真实产物');
});

test('parallel snapshot initializes a plain project and an unborn Git repository without staging user files', async t => {
  for (const unborn of [false, true]) {
    const root = await fixture(t);
    if (unborn) await exec('git', ['init', '-q'], { cwd: root });
    await writeFile(path.join(root, '.env'), 'PRIVATE_SENTINEL=never-snapshot\n');
    await writeFile(path.join(root, '.gitignore'), '.task-tree-runs/\n');
    const manager = createGitWorkspaceManager({ projectRoot: root });
    const prepared = await manager.prepare('bootstrap');
    try {
      assert.equal(await readFile(path.join(prepared.integrationPath, 'task-tree.md'), 'utf8'), tree('SOURCE'));
      await assert.rejects(readFile(path.join(prepared.integrationPath, '.env')), { code: 'ENOENT' });
      assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, '');
    } finally { await manager.cleanup({ ...prepared, runId: 'bootstrap' }); }
  }
});

test('a failed model result cannot be committed, integrated or reported as completed', async t => {
  const root = await fixture(t);
  let commits = 0;
  const workspace = {
    async prepare() { return { integrationPath: root, snapshotCommit: 'base' }; },
    async head() { return 'base'; }, async createWorker() { return root; },
    async inspectChanges() { return { changedFiles: ['partial.txt'] }; },
    async commit() { commits++; return 'partial'; }, async integrate() {}, async removeWorker() {},
    async summarize() { return { changedFiles: [] }; }, async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace,
    startTurn: async () => ({ status: 'failed', threadId: 'failed-thread', output: 'partial text', error: { message: 'HTTP 502' } }) });
  const run = await coordinator.start([{ taskId: 'A', nodeId: 'SOURCE', instruction: '完成结果', writeSet: [], dependsOn: [] }]);
  const finished = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(finished.status, 'failed');
  assert.equal(finished.jobs[0].status, 'failed');
  assert.match(finished.jobs[0].error, /502/);
  assert.equal(commits, 0);
});

test('incremental branch receipts include final-review repairs and verification evidence', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  const evidence = ['实际运行验证返回42'];
  const coordinator = createParallelCodexCoordinator({ projectRoot: root,
    startTurn: async options => {
      await writeFile(path.join(options.cwd, 'original.txt'), '完成\n');
      return { status: 'completed', output: 'original.txt 已完成' };
    }, reviewTurn: async options => {
      await writeFile(path.join(options.cwd, 'verified.mjs'), 'console.log(42);\n');
      assert.equal((await exec(process.execPath, ['verified.mjs'], { cwd: options.cwd })).stdout.trim(), '42');
      return { status: 'completed', output: JSON.stringify({ verdict: 'pass', reason: '补齐验证产物', evidence }) };
    }
  });
  const run = await coordinator.start([{ taskId: 'A', nodeId: 'SOURCE', instruction: '交付原始与验证产物' }], { incremental: true, finalReviewOnly:false });
  const finished = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error);
  assert.ok(finished.jobs[0].changedFiles.includes('verified.mjs'));
  assert.ok(finished.jobs[0].appliedFiles.includes('verified.mjs'));
  assert.deepEqual(finished.jobs[0].review.evidence, evidence);
  assert.equal(await readFile(path.join(root, 'verified.mjs'), 'utf8'), 'console.log(42);\n');
});

test('an independent pipeline reviewer sees the integrated Git candidate and can prevent application', { timeout: 30000 }, async t => {
  for (const verdict of ['failed', 'pass']) {
    const root = await fixture(t, true);
    const reviews = [];
    const coordinator = createParallelCodexCoordinator({
      projectRoot: root,
      workspace: createGitWorkspaceManager({ projectRoot: root }),
      startTurn: async options => {
        const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
        assert.ok(taskId);
        await writeFile(path.join(options.cwd, `${taskId}.txt`), `${taskId}\n`);
        await options.onAccepted?.({ threadId: `worker-${taskId}`, turnId: `turn-${taskId}` });
        return { status: 'completed', threadId: `worker-${taskId}`, output: '{"event":"completed","evidence":"真实文件已写入","peerRequests":[]}' };
      },
      reviewTurn: async options => {
        reviews.push(options);
        assert.match(options.prompt, /按当前目标完成两份文件/);
        assert.doesNotMatch(options.prompt, /diff --git|改动文件|执行者报告|真实改动文件/);
        assert.doesNotMatch(options.prompt, /真实文件已写入|A\.txt|B\.txt/);
        assert.equal(await readFile(path.join(options.cwd, 'A.txt'), 'utf8'), 'A\n');
        assert.equal(await readFile(path.join(options.cwd, 'B.txt'), 'utf8'), 'B\n');
        assert.equal(options.persistDialogue, false);
        assert.equal(options.messages, undefined, 'checker must not receive a copied conversation/context transcript');
        assert.equal(options.dialogueContext, undefined, 'checker exchange must not enter durable user dialogue');
        return { status: 'completed', output: JSON.stringify({ verdict, reason: verdict === 'failed' ? '发现未完成项且无法修复' : '结果完整' }) };
      }
    });
    const run = await coordinator.start([
      { taskId: 'A', nodeId: 'SOURCE', instruction: '创建 A.txt', writeSet: ['A.txt'], dependsOn: [] },
      { taskId: 'B', nodeId: 'SOURCE', instruction: '创建 B.txt', writeSet: ['B.txt'], dependsOn: [] }
    ], { objective: '按当前目标完成两份文件', contextMessages: [{ role: 'user', content: '过期上下文' }],
      historyMessages: [{ role: 'user', content: '聊天归档不应进入最终检查' }] });
    await coordinator.wait(run.id);
    await coordinator.drain();
    const finished = await coordinator.get(run.id);
    assert.equal(reviews.length, 1);
    assert.equal(finished.review.status, verdict === 'pass' ? 'passed' : 'failed');
    assert.equal(finished.status, verdict === 'pass' ? 'accepted' : 'failed');
    if (verdict === 'failed') {
      await assert.rejects(readFile(path.join(root, 'A.txt')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(root, 'B.txt')), { code: 'ENOENT' });
    } else {
      assert.equal(await readFile(path.join(root, 'A.txt'), 'utf8'), 'A\n');
      assert.equal(await readFile(path.join(root, 'B.txt'), 'utf8'), 'B\n');
    }
  }
});

test('the final pipeline reviewer repairs and verifies in one session before application', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  let reviews = 0, repairs = 0;
  const coordinator = createParallelCodexCoordinator({
    projectRoot: root,
    workspace: createGitWorkspaceManager({ projectRoot: root }),
    startTurn: async options => {
      await writeFile(path.join(options.cwd, 'original.txt'), '原成果\n');
      await options.onAccepted?.({ threadId: 'worker-A', turnId: 'turn-A' });
      return { status: 'completed', threadId: 'worker-A', output: '{"event":"completed","peerRequests":[]}' };
    },
    reviewTurn: async options => {
      reviews++;
      assert.match(options.prompt, /有缺陷就修复并复验/);
      await writeFile(path.join(options.cwd, 'repair.txt'), '补齐\n');
      return { status: 'completed', output: JSON.stringify({ verdict: 'pass', reason: '已补齐并验证' }) };
    },
    repairTurn: async options => {
      repairs++;
      await writeFile(path.join(options.cwd, 'repair.txt'), '补齐\n');
      return { status: 'completed', output: '已修复' };
    }
  });
  const run = await coordinator.start([{ taskId: 'A', nodeId: 'SOURCE', instruction: '交付结果', writeSet: ['original.txt'], dependsOn: [] }]);
  await coordinator.wait(run.id);
  await coordinator.drain();
  const finished = await coordinator.get(run.id);
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(finished.review.status, 'passed');
  assert.equal(reviews, 1);
  assert.equal(repairs, 0);
  assert.deepEqual(finished.result.appliedFiles.sort(), ['original.txt', 'repair.txt']);
  assert.equal(await readFile(path.join(root, 'repair.txt'), 'utf8'), '补齐\n');
});

test('tool-server PID and port files never cause spurious merges, while task metadata edits remain allowed', async t => {
  const root = await fixture(t, true);
  const manager = createGitWorkspaceManager({ projectRoot: root });
  const prepared = await manager.prepare('runtime-files');
  const worker = await manager.createWorker('runtime-files', 'A', prepared.snapshotCommit);
  try {
    await writeFile(path.join(worker, '.task-tree-server.pid'), '12345');
    await writeFile(path.join(worker, '.task-tree-port'), '12345');
    await writeFile(path.join(worker, 'result.txt'), 'real result');
    const inspected = await manager.inspectChanges(worker, prepared.snapshotCommit);
    assert.deepEqual(inspected.changedFiles, ['result.txt']);
    const commit = await manager.commit(worker, 'worker', prepared.snapshotCommit);
    const files = (await exec('git', ['diff', '--name-only', prepared.snapshotCommit, commit], { cwd: worker })).stdout;
    assert.equal(files, 'result.txt\n');
  } finally { await manager.removeWorker(worker); await manager.cleanup({ ...prepared, runId: 'runtime-files' }); }
});

test('explicit tool workspace wins over provider root; branch field patches cannot overwrite the live source tree', { timeout: 30000 }, async t => {
  const source = await fixture(t);
  const worker = await fixture(t);
  await mkdir(path.join(worker, 'subtrees'));
  await writeFile(path.join(worker, 'subtrees/BRANCH.md'), tree('BRANCH'));
  const bridge = await createTaskTreeAgentTools({ cwd: worker, environment: {
    TASK_TREE_PROJECT_ROOT: source, TASK_TREE_CONTEXT_TREE_FILE: 'subtrees/BRANCH.md'
  } });
  try {
    const focus = await bridge.call('task_tree_focus');
    assert.equal(focus.projectRoot, worker);
    assert.equal(focus.nextNode.id, 'BRANCH');
    const receipt = await bridge.call('task_tree_write', { nodeId: 'BRANCH', fields: { CurrentResult: '只修改隔离分支。' }, reason: '验证隔离字段补丁' });
    assert.ok(receipt.changes.some(change => change.nodeId === 'BRANCH' && change.after === '只修改隔离分支。'));
    assert.match(await readFile(path.join(worker, 'subtrees/BRANCH.md'), 'utf8'), /只修改隔离分支/);
    assert.equal(await readFile(path.join(source, 'task-tree.md'), 'utf8'), tree('SOURCE'));
    assert.equal(await readFile(path.join(worker, 'task-tree.md'), 'utf8'), tree('SOURCE'));
  } finally {
    await bridge.close();
    const pid = Number(await readFile(path.join(worker, '.task-tree-server.pid'), 'utf8').catch(() => 0));
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
});

test('selected tree becomes eight real editable branch subtrees, runs concurrently and merges every result', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  await mkdir(path.join(root, 'trees'));
  await writeFile(path.join(root, 'trees/selected.md'), tree('SELECTED'));
  await writeFile(path.join(root, 'task-trees.json'), JSON.stringify({ activeMethod: 'method', trees: [
    { id: 'method', role: 'method', path: 'task-tree.md', title: '主树' },
    { id: 'selected', role: 'reference', path: 'trees/selected.md', title: '选中树' }
  ] }));
  const jobs = Array.from({ length: 8 }, (_, i) => ({ taskId: `job${i}`, nodeId: 'SELECTED', title: `结果${i}`,
    instruction: `写入独立结果${i}`, writeSet: [`result${i}.txt`], dependsOn: [] }));
  let started = 0, active = 0, maximum = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const startTurn = async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) {
      assert.match(options.prompt, /SELECTED/);
      return { threadId: 'planner', output: JSON.stringify({ summary: '八项结果', jobs }) };
    }
    const id = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    const call = options.initialToolCalls[0];
    const nodeId = JSON.parse(call.function.arguments).nodeId;
    assert.notEqual(nodeId, 'SELECTED', 'each worker must receive its own materialized node');
    const relative = options.prompt.match(/^Branch subtree: (.+)$/m)?.[1];
    assert.ok(relative, 'worker must be told exactly where its editable subtree lives');
    const markdown = await readFile(path.join(options.cwd, relative), 'utf8');
    assert.match(markdown, new RegExp(`## ${nodeId} -`));
    active++; maximum = Math.max(maximum, active);
    if (++started === jobs.length) release();
    await barrier;
    await writeFile(path.join(options.cwd, `${id}.txt`), `result ${id}\n`);
    await writeFile(path.join(options.cwd, relative), markdown.replace('- CurrentResult:', `- CurrentResult: 已保存 ${id} 的独立结果`));
    active--;
    return { status: 'completed', threadId: `thread-${id}`, output: JSON.stringify({ event: 'completed', evidence: id }) };
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn });
  t.after(() => { release(); });
  const run = await coordinator.plan({ objective: '完成八项独立结果', treeId: 'selected', nodeId: 'SELECTED' });
  const finished = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(maximum, 8);
  assert.equal(finished.sourceTree.path, 'trees/selected.md');
  const registry = JSON.parse(await readFile(path.join(root, 'task-trees.json'), 'utf8'));
  assert.equal(registry.activeMethod, 'method', 'do not move the human project focus');
  assert.ok(registry.trees.some(item => item.id === finished.branchTree.id));
  const runTree = await readFile(path.join(root, finished.branchTree.path), 'utf8');
  assert.equal((runTree.match(/- SubtreeFile:/g) || []).length, 8);
  assert.equal(new Set(finished.jobs.map(j => j.executionNodeId)).size, 8);
  for (const job of finished.jobs) {
    assert.equal(await readFile(path.join(root, `${job.taskId}.txt`), 'utf8'), `result ${job.taskId}\n`);
    assert.match(await readFile(path.join(root, job.subtreeFile), 'utf8'), new RegExp(`已保存 ${job.taskId}`));
  }
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), tree('SOURCE'));
  assert.equal((await exec('git', ['ls-files', '--unmerged'], { cwd: root })).stdout, '');
});

test('new branches are materialized before scheduling and start before the original branches finish', { timeout: 30000 }, async t => {
  const root = await fixture(t, true);
  let release, started, extraStarted;
  const hold = new Promise(resolve => { release = resolve; });
  const firstReady = new Promise(resolve => { started = resolve; });
  const extraReady = new Promise(resolve => { extraStarted = resolve; });
  let count = 0;
  const jobs = ['a', 'b'].map(taskId => ({ taskId, nodeId: 'SOURCE', title: taskId, instruction: '独立结果', writeSet: [], dependsOn: [] }));
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn: async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) return { output: JSON.stringify({ jobs }) };
    if (options.prompt.includes('Single Parallel Branch Planner')) return { output: JSON.stringify({ job: { ...jobs[0], taskId: 'extra' } }) };
    const id = options.prompt.match(/^Task id: (.+)$/m)[1];
    const relative = options.prompt.match(/^Branch subtree: (.+)$/m)[1];
    await readFile(path.join(options.cwd, relative));
    const taskFile = relative.replace(/\.md$/, '.task.json');
    const instructions = JSON.parse(await readFile(path.join(options.cwd, taskFile), 'utf8'));
    assert.equal(instructions.taskId, id);
    if (!['a', 'b'].includes(id)) extraStarted();
    else { if (++count === 2) started(); await hold; }
    await writeFile(path.join(options.cwd, id + '.txt'), id);
    return { status: 'completed', output: JSON.stringify({ event: 'completed', evidence: id }) };
  } });
  t.after(() => { release(); });
  const run = await coordinator.plan();
  const wait = promise => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(async () => {
      const state = await coordinator.get(run.id);
      reject(new Error(JSON.stringify({ status: state.status, error: state.error, jobs: state.jobs.map(j => ({ taskId: j.taskId, status: j.status, error: j.error })) })));
    }, 5000); timer.unref();
  })]);
  await wait(firstReady);
  const appended = await coordinator.addBranch(run.id, { nodeId: 'SOURCE' });
  assert.equal(appended.jobs.length, 3);
  await wait(extraReady);
  release();
  const result = await coordinator.wait(run.id); await coordinator.drain();
  assert.equal(result.status, 'accepted', result.error);
  const appendedId = appended.jobs.at(-1).taskId;
  assert.equal(await readFile(path.join(root, appendedId + '.txt'), 'utf8'), appendedId);
  assert.equal((await readFile(path.join(root, result.branchTree.path), 'utf8')).match(/- SubtreeFile:/g).length, 3);
});
