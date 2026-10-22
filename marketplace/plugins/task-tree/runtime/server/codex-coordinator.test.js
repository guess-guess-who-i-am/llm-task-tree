import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildPlannerPrompt,
  buildBranchPlannerPrompt,
  buildBranchInputContext,
  buildWorkerPrompt,
  compactWorkerOutput,
  canWorkerSplit,
  MAX_DYNAMIC_SPLIT_DEPTH,
  createParallelCodexCoordinator,
  normalizeParallelPlan,
  validateParallelJobs
} from "./codex-coordinator.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";
import { saveAttachment } from './chat-attachments.js';
import { updateNodeMaterial } from './node-materials.js';

const exec = promisify(execFile);

test('planner delivery contracts survive normalization and reach the worker without duplicating history', () => {
  const contract = { deliverables: [{ path: 'subtrees/body.md', mode: 'update', nodeIds: ['BODY'] }], acceptanceCriteria: ['节点内说明真实输入输出，不外引文档'] };
  const [job] = validateParallelJobs([{ taskId: 'body', nodeId: 'ROOT', instruction: '改写身体节点', ...contract }]);
  assert.deepEqual(job.deliverables, contract.deliverables);
  assert.deepEqual(job.acceptanceCriteria, contract.acceptanceCriteria);
  const prompt = buildWorkerPrompt(job);
  assert.match(prompt, /subtrees\/body.md/);
  assert.match(prompt, /节点内说明真实输入输出/);
});

test('worker report suggests brevity without truncating any output', () => {
  const prompt = buildWorkerPrompt({ taskId: 'short', nodeId: 'ROOT', instruction: '完成指定功能', writeSet: [], singleFinalReview: true });
  assert.match(prompt, /建议.*简要|简要说明/);
  assert.match(prompt, /关键验证/);
  assert.doesNotMatch(prompt, /\d+字|字符上限|最多\d+项验证/);
  const longReport = '很长的报告'.repeat(100);
  assert.equal(compactWorkerOutput(longReport), longReport);
  const longEvidence = '证据'.repeat(500);
  const stored = JSON.parse(compactWorkerOutput('', { event: 'completed', evidence: longEvidence }));
  assert.equal(stored.evidence, longEvidence);
});

test('a provider stopped worker is visible and resumes the same session until it completes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-worker-stop-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 恢复\n- Problem: 完成任务\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const calls = [];
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'base' }; },
    async head() { return 'base'; },
    async createWorker(_runId, taskId) { return `worker/${taskId}`; },
    async inspectChanges() { return { changedFiles: ['result.txt'], violations: [] }; },
    async commit() { return 'worker-commit'; },
    async integrate() {},
    async removeWorker() {},
    async summarize() { return { changedFiles: ['result.txt'], stat: '1 file', patchPreview: 'result', patchTruncated: false }; },
    async accept() { return { appliedFiles: ['result.txt'] }; },
    async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn: async options => {
    calls.push({ prompt: options.prompt, threadId: options.threadId || '' });
    await options.onAccepted?.({ threadId: 'deepseek-worker-session', turnId: `turn-${calls.length}` });
    if (calls.length === 1) return { status: 'stopped', threadId: 'deepseek-worker-session', output: '已完成读取，尚未写入' };
    return { status: 'completed', threadId: 'deepseek-worker-session', output: '{"event":"completed","evidence":"result.txt 已写入","peerRequests":[]}' };
  }});
  const run = await coordinator.start([{ taskId: 'recoverable', nodeId: 'ROOT', instruction: '完成 result.txt', writeSet: ['result.txt'], dependsOn: [] }]);
  const finished = await coordinator.wait(run.id);
  await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].threadId, 'deepseek-worker-session');
  assert.ok(finished.events.some(event => event.type === 'worker_stopped'));
  assert.ok(finished.events.some(event => event.type === 'worker_retrying'));
  assert.equal(finished.jobs[0].status, 'completed');
});

for(const afterRestart of [false,true])test(`explicit resume retries failed and dependency-blocked jobs without rerunning completed jobs${afterRestart?' after a restart with interrupted siblings':''}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-explicit-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 恢复失败任务\n- Problem: 只重试未完成分支\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const attempts = new Map();
  const resumedContexts = [];
  const prompts = [];
  const persistentContexts = new Set();
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'base' }; },
    async head() { return 'base'; },
    async createWorker(_runId, taskId, _commit, { contextKey } = {}) { persistentContexts.add(contextKey); return `worker/${contextKey || taskId}`; },
    async resumePersistentWorker(contextKey) {
      if (!persistentContexts.has(contextKey)) return '';
      resumedContexts.push(contextKey);
      return `worker/${contextKey}`;
    },
    async resumeWorker(workerPath) { return workerPath; },
    async inspectChanges() { return { changedFiles: [], violations: [] }; },
    async commit() { return 'worker-commit'; },
    async integrate() {}, async removeWorker() {},
    async summarize() { return { changedFiles: [], stat: '', patchPreview: '' }; },
    async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const startTurn=async options => {
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    prompts.push({ taskId, prompt: options.prompt });
    const attempt = (attempts.get(taskId) || 0) + 1;
    attempts.set(taskId, attempt);
    if (['A','D'].includes(taskId) && attempt === 1) return { status: 'failed', error: new Error('临时网关超时'), output: '此前输出' };
    await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `${taskId}-${attempt}` });
    return { status: 'completed', threadId: `thread-${taskId}`, output: JSON.stringify({ event: 'completed', evidence: `${taskId} 完成`, peerRequests: [] }) };
  };
  let coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn });
  const started = await coordinator.start([
    { taskId: 'A', nodeId: 'ROOT', instruction: '完成 A', writeSet: [], dependsOn: [] },
    { taskId: 'B', nodeId: 'ROOT', instruction: '完成 B', writeSet: [], dependsOn: ['A'] },
    { taskId: 'C', nodeId: 'ROOT', instruction: '完成 C', writeSet: [], dependsOn: [] },
    ...(afterRestart?[{taskId:'D',nodeId:'ROOT',instruction:'完成 D',writeSet:[],dependsOn:[]}]:[])
  ]);
  const first = await coordinator.wait(started.id);
  assert.equal(first.status, 'failed');
  assert.deepEqual(Object.fromEntries(first.jobs.map(job => [job.taskId, job.status])), { A: 'failed', B: 'blocked', C: 'completed',...(afterRestart?{D:'failed'}:{}) });
  if(afterRestart){
    await coordinator.drain();
    const file=path.join(root,'.task-tree-runs',`${started.id}.json`);
    const saved=JSON.parse(await readFile(file,'utf8'));
    saved.status='running';saved.jobs.find(j=>j.taskId==='D').status='running';
    await writeFile(file,JSON.stringify(saved));
    coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,startTurn});
  }

  await coordinator.resume(started.id);
  const finished = await coordinator.wait(started.id);
  await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error);
  assert.deepEqual(Object.fromEntries(finished.jobs.map(job => [job.taskId, job.status])), { A: 'completed', B: 'completed', C: 'completed',...(afterRestart?{D:'completed'}:{}) });
  assert.deepEqual(Object.fromEntries(attempts), { A: 2, B: 1, C: 1,...(afterRestart?{D:2}:{}) });
  assert.ok(prompts.find(item => item.taskId === 'A' && item.prompt.includes('此前失败原因'))?.prompt.includes('临时网关超时'));
  assert.equal(resumedContexts.length, afterRestart?2:1, 'failed and interrupted workers resume their persistent Git workspaces');
});

test('retrying a failed merge reuses the completed worker output without another model turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-merge-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 合并恢复\n- Problem: 保留成果\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  let turns = 0, integrations = 0;
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'base' }; },
    async head() { return 'base'; }, async createWorker() { return 'saved-worker'; },
    async resumePersistentWorker() { return 'saved-worker'; }, async resumeWorker() {},
    async inspectChanges() { return { changedFiles: ['result.md'], violations: [] }; },
    async commit() { return 'worker-commit'; },
    async integrate() { if (++integrations === 1) throw new Error('独立合并失败：临时断线'); },
    async removeWorker() {}, async summarize() { return { changedFiles: ['result.md'], stat: '', patchPreview: '' }; },
    async accept() { return { appliedFiles: ['result.md'] }; }, async cleanup() {}
  };
  const startTurn = async () => {
    turns++;
    return { status: 'completed', threadId: 'saved-thread', timing: { rounds: [{ finishReason: 'stop' }] }, output: JSON.stringify({ event: 'completed', evidence: '实际文件已保存', peerRequests: [] }) };
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn });
  const run = await coordinator.start([{ taskId: 'A', nodeId: 'ROOT', instruction: '交付结果', writeSet: [], dependsOn: [] }]);
  assert.equal((await coordinator.wait(run.id)).status, 'failed');
  await coordinator.drain();
  const file = path.join(root, '.task-tree-runs', `${run.id}.json`);
  const old = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(old.jobs[0].workerCompleted, true);
  delete old.jobs[0].workerCompleted;
  await writeFile(file, JSON.stringify(old));
  const restarted = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn });
  await restarted.resume(run.id);
  const done = await restarted.wait(run.id);
  await restarted.drain();
  assert.equal(done.status, 'accepted', done.error);
  assert.equal(turns, 1, 'completed worker must not be replayed merely because delivery failed');
  assert.equal(integrations, 2);
});

test('a genuinely indivisible node can plan one ready task', () => {
  const plan = normalizeParallelPlan(JSON.stringify({ summary: '单项交付', jobs: [{
    taskId: 'one', nodeId: 'N1', title: '交付', instruction: '完成唯一结果', writeSet: [], dependsOn: []
  }] }), '# LLM Task Graph\n## ROOT - 项目\n## N1 - 阶段\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n');
  assert.equal(plan.jobs.length, 1);
});

test('shared interface and work estimates survive planning normalization and reach all concurrent workers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 项目\n## N1 - 附件\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n');
  const sharedContract = '成功返回{id,url,mime}，失败返回{error}；storage负责接口，input负责消费。';
  const jobs = ['storage', 'input'].map(taskId => ({ taskId, nodeId: 'N1', instruction: `完成${taskId}并验证`, writeSet: [], dependsOn: [], workEstimate: `中：${taskId}有独立边界` }));
  const normalized = normalizeParallelPlan(JSON.stringify({ jobs, sharedContract }), '');
  assert.equal(normalized.sharedContract, sharedContract);
  assert.equal(normalized.jobs[0].workEstimate, jobs[0].workEstimate);
  assert.ok(buildBranchPlannerPrompt('', 'N1', '追加附件任务', jobs.map(job => ({ ...job, sharedContract }))).includes(sharedContract));
  const prompts = [], workerOptions = [];
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'snapshot' }; },
    async head() { return 'head'; }, async createWorker(_, id) { return `isolated/${id}`; },
    async inspectChanges() { return { changedFiles: [] }; }, async commit() { return null; },
    async integrate() {}, async removeWorker() {}, async summarize() { return { changedFiles: [], patchPreview: '' }; },
    async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn: async options => {
    if (options.prompt.includes('Automatic Parallel Planner')) return { output: JSON.stringify({ jobs, sharedContract }), threadId: 'planner' };
    prompts.push(options.prompt);
    workerOptions.push(options);
    assert.ok(options.prompt.includes(sharedContract));
    assert.match(options.prompt, /可以运行任务相关测试/);
    assert.match(options.prompt, /树回写 one-shot/);
    assert.doesNotMatch(options.prompt, /Do not run tests/);
    return { output: '{"event":"completed","evidence":"验证通过"}' };
  } });
  const planned = await coordinator.plan({ objective: '完成附件' });
  await coordinator.wait(planned.id); await coordinator.drain();
  assert.equal(prompts.length, 2);
  const direct = await coordinator.start(jobs, { sharedContract, objective: '完成附件' });
  await coordinator.wait(direct.id); await coordinator.drain();
  assert.equal(prompts.length, 4, 'both planning entry points propagate the same contract');
  for (const options of workerOptions) {
    assert.doesNotMatch(options.developerInstructions, /Do not run tests/);
    assert.match(options.developerInstructions, /运行相关测试/);
  }
  const gate = {};
  gate.promise = new Promise(resolve => { gate.release = resolve; });
  const appendCoordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn: async options => {
    assert.ok(options.prompt.includes(sharedContract));
    await gate.promise;
    return { status: 'completed', output: '完成' };
  } });
  const running = await appendCoordinator.start(jobs, { sharedContract, objective: '完成附件' });
  assert.equal(running.sharedContract, sharedContract);
  const appended = await appendCoordinator.append(running.id, { jobs: [{ taskId: 'extra', nodeId: 'N1', instruction: '追加工作' }] });
  assert.equal(appended.jobs.at(-1).sharedContract, sharedContract);
  gate.release();
  await appendCoordinator.wait(running.id); await appendCoordinator.drain();
});

test('80 parallel workers receive task context without replaying the full parent dialogue', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-worker-context-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 项目\n## N1 - 阶段\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n');
  const workerCalls = [];
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'snapshot' }; },
    async head() { return 'head'; }, async createWorker(_, id) { return `isolated/${id}`; },
    async inspectChanges() { return { changedFiles: [] }; }, async commit() { return null; },
    async integrate() {}, async removeWorker() {}, async summarize() { return { changedFiles: [], stat: '', patchPreview: '' }; },
    async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn: async options => {
    workerCalls.push(options);
    return { status: 'completed', output: '完成当前分支' };
  } });
  const oldRunHistory = Array.from({ length: 80 }, (_, i) => ({ role: 'assistant', content: `第${i + 1}个agent完整报告：` + '历史细节'.repeat(100) }));
  const parentDialogue = [{ role: 'user', content: '当前用户目标：完成一个明确的独立子任务' }, ...oldRunHistory];
  const jobs = Array.from({ length: 80 }, (_, index) => ({ taskId: `branch-${index + 1}`, nodeId: 'N1', instruction: `只完成分支${index + 1}` }));
  const run = await coordinator.start(jobs, {
    nodeId: 'N1', objective: '完成一个明确的独立子任务', contextMessages: parentDialogue, historyMessages: parentDialogue
  });
  await coordinator.wait(run.id);
  await coordinator.drain();
  assert.equal(workerCalls.length, 80);
  for (const [index, options] of workerCalls.entries()) {
    assert.equal(options.messages, undefined, 'worker starts from its task prompt, not a copy of parent chat');
    assert.equal(options.dialogueContext, undefined, 'parent archive is not duplicated into every worker archive');
    assert.doesNotMatch(JSON.stringify(options), /第80个agent完整报告/);
    assert.match(options.prompt, new RegExp(`只完成分支${index + 1}`));
  }
});

test('planner receives branch materials; concurrent workers receive shared-stage and own-node materials from the source project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-node-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 项目\n## N1 - 阶段\n## A - 子任务\n## B - 子任务\n## OTHER - 无关\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n## E1 - 分支\n- Endpoints: N1, A\n## E2 - 分支\n- Endpoints: N1, B\n');
  for (const [nodeId, content, enabled] of [['N1', 'SHARED_STAGE_MATERIAL', true], ['A', 'A_ONLY_MATERIAL', true], ['B', 'B_ONLY_MATERIAL', true], ['A', 'DISABLED_MATERIAL', false], ['OTHER', 'UNRELATED_MATERIAL', true]]) {
    const scope = { projectRoot: root, treeId: 'method', nodeId };
    const ref = await saveAttachment({ ...scope, name: '资料.txt', bytes: Buffer.from(content) });
    await updateNodeMaterial(scope, { action: 'add', id: ref.id, enabled });
  }
  let active = 0, maximum = 0;
  const jobs = ['A', 'B'].map(nodeId => ({ taskId: nodeId, nodeId, title: nodeId, instruction: '完成独立子任务', writeSet: [], dependsOn: [] }));
  const startTurn = async options => {
    const context = JSON.stringify(options.contextMessages);
    assert.match(context, /SHARED_STAGE_MATERIAL/);
    assert.doesNotMatch(context, /DISABLED_MATERIAL|UNRELATED_MATERIAL/);
    if (options.prompt.includes('Automatic Parallel Planner')) {
      assert.match(context, /A_ONLY_MATERIAL/); assert.match(context, /B_ONLY_MATERIAL/);
      return { threadId: 'planner', output: JSON.stringify({ jobs }) };
    }
    const id = options.prompt.match(/^Task id: (.+)$/m)[1];
    assert.match(context, new RegExp(`${id}_ONLY_MATERIAL`));
    assert.doesNotMatch(context, new RegExp(`${id === 'A' ? 'B' : 'A'}_ONLY_MATERIAL`));
    assert.ok(!options.cwd.startsWith(root), 'worker has no copied private attachment directory');
    active++; maximum = Math.max(maximum, active);
    await options.onAccepted?.({ threadId: `thread-${id}`, turnId: id });
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return { threadId: `thread-${id}`, output: '完成' };
  };
  const workspace = {
    async prepare() { return { integrationPath: 'integration', snapshotCommit: 'snapshot' }; },
    async head() { return 'head'; }, async createWorker(_, id) { return `isolated/${id}`; },
    async inspectChanges() { return { changedFiles: [], violations: [] }; }, async commit() { return null; },
    async integrate() { return { conflicts: [] }; }, async removeWorker() {},
    async summarize() { return { changedFiles: [], stat: '', patchPreview: '', patchTruncated: false }; },
    async accept() { return { appliedFiles: [] }; }, async cleanup() {}
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn, workspace });
  const planned = await coordinator.plan({ objective: '并行完成两项' });
  const finished = await coordinator.wait(planned.id); await coordinator.drain();
  assert.equal(finished.status, 'accepted', finished.error); assert.equal(maximum, 2);
});

const shared = {
  taskId: "A",
  nodeId: "N1",
  instruction: "修改共享文件",
  writeSet: ["task-tree.md"],
  dependsOn: []
};

test("planner validation allows the requested parallel freedom but keeps a runnable DAG", () => {
  assert.equal(validateParallelJobs([shared]).length, 1);
  assert.doesNotThrow(() => validateParallelJobs([
    shared,
    { ...shared, taskId: "B", writeSet: ["task-tree.md"] },
    { ...shared, taskId: "C", writeSet: ["../outside/result.txt"] },
    { ...shared, taskId: "D", writeSet: ["/tmp/direct-result.txt"] },
    { ...shared, taskId: "E", writeSet: [] }
  ]));
  assert.throws(() => validateParallelJobs([shared, { ...shared }]), /任务不能重复/);
  assert.throws(() => validateParallelJobs([{ ...shared, dependsOn: ["missing"] }]), /未知依赖/);
  assert.throws(() => validateParallelJobs([
    { ...shared, taskId: "A", dependsOn: ["B"] },
    { ...shared, taskId: "B", dependsOn: ["A"] }
  ]), /循环依赖/);
});

test("planner and workers receive tree maps and can choose full reads without raw histories", () => {
  const marker = "END-OF-COMPLETE-CONTEXT";
  const tree = [
    "# LLM Task Graph",
    "## ROOT - 根目标",
    "- Problem: 完成目标",
    "## N1 - 当前阶段",
    "- Problem: 拆分当前工作",
    "- CurrentResult: 当前阶段事实",
    "## N2 - 无关历史",
    `- Notes: ${marker}${"x".repeat(50000)}`,
    '- CurrentResult: 其它分支的最新事实',
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "# Edges",
    "## E1 - 当前关系",
    "- Endpoints: ROOT, N1",
    "- Label: 当前关系"
  ].join("\n");
  const prompt = buildPlannerPrompt(tree);
  assert.match(prompt, /最大化有用的就绪前沿/);
  assert.match(prompt, /独立结果有多少就保留多少/);
  assert.match(prompt, /不可再分的结果，保留一个任务/);
  assert.match(prompt, /不设 Worker 上限/);
  assert.match(prompt, /不要写测试命令/);
  assert.match(prompt, /当前阶段事实/);
  assert.doesNotMatch(prompt, new RegExp(marker));
  assert.doesNotMatch(prompt, /"branchContext":/);
  assert.ok(prompt.length < tree.length / 5, "unrelated task-tree history must not dominate the planner input");

  const worker = buildWorkerPrompt(validateParallelJobs([{
    ...shared,
    branchContext: buildBranchInputContext(shared, { markdown: tree }),
    contextResult: `历史结果\n${marker}`,
    runtimeMetadataPath: "/tmp/parallel-run-metadata"
  }])[0]);
  assert.doesNotMatch(worker, new RegExp(marker));
  assert.match(worker, /其它分支的最新事实/);
  assert.match(worker, /task_tree_read/);
  assert.match(worker, /task-tree\.md/);
  assert.match(worker, /Shared run metadata directory .*\/tmp\/parallel-run-metadata/);
  assert.match(worker, /shared run metadata (may be edited|edits are direct)/i);
  assert.doesNotMatch(worker, /验收命令|test command:/i);
});

test('branch worker reports to its execution node without refolding an existing subtree', () => {
  const prompt = buildWorkerPrompt({ taskId: 'docs', nodeId: 'N3', executionNodeId: 'P_docs',
    subtreeFile: 'subtrees/P_docs.md', title: '文档', instruction: '写说明并回报来源N3', writeSet: [] });
  assert.match(prompt, /task_tree_write\(nodeId=P_docs,fields=/);
  assert.doesNotMatch(prompt, /task_tree_subtree\(action=write/);
  assert.match(prompt, /子树已经建立/);
});

test('dynamic worker subdivision is bounded to one generation', () => {
  const root = { taskId: 'root', parentTaskId: '', nodeId: 'ROOT', instruction: '完成根任务', writeSet: [] };
  const child = { taskId: 'root.child', parentTaskId: 'root' };
  const grandchild = { taskId: 'root.child.leaf', parentTaskId: 'root.child' };
  assert.equal(MAX_DYNAMIC_SPLIT_DEPTH, 1);
  assert.equal(canWorkerSplit(root, [root, child, grandchild]), true);
  assert.equal(canWorkerSplit(child, [root, child, grandchild]), false);
  assert.equal(canWorkerSplit(grandchild, [root, child, grandchild]), false);
  assert.match(buildWorkerPrompt(root), /只允许再拆一层/);
});

test('worker prompt only lists sibling branches, not every task in the run', () => {
  const job = { taskId: 'access.identity', parentTaskId: 'access', nodeId: 'ROOT', instruction: '分析身份功能', writeSet: [] };
  const peers = [
    { taskId: 'access.administration', parentTaskId: 'access', title: '管理功能' },
    { taskId: 'business.collection', parentTaskId: 'business', title: '病例采集' },
    ...Array.from({ length: 50 }, (_, i) => ({ taskId: `support.topic${i}`, parentTaskId: 'support', title: `配套主题${i}` }))
  ];
  const prompt = buildWorkerPrompt(job, '', peers);
  assert.match(prompt, /access\.administration/);
  assert.doesNotMatch(prompt, /business\.collection|support\.topic/);
});

test('worker task instruction is sent once and old run bodies are read on demand',()=>{
  const instruction='UNIQUE_WORKER_TASK_交付章节接口和可验证结果';
  const oldBody='HISTORICAL_RUN_BODY_'+ '旧旁白'.repeat(3000);
  const job={taskId:'chapter',nodeId:'N3',instruction,writeSet:[],dependsOn:[],
    acceptancePrompt:`完成“${instruction}”；最终返回实际证据。`,
    branchContext:buildBranchInputContext({taskId:'chapter',nodeId:'N3',instruction},{
      goal:{root:'完成总体文档',immediate:'完成本轮'},
      history:[{runId:'old-run',status:'accepted',immediate:'上轮工作',result:oldBody}]
    })};
  const prompt=buildWorkerPrompt(job);
  assert.equal(prompt.split(instruction).length-1,1,'Task, branch context and acceptance must not copy the whole task');
  assert.doesNotMatch(prompt,/HISTORICAL_RUN_BODY/);
  assert.match(prompt,/old-run/);
  assert.match(prompt,/按需|on demand/);
  assert.match(prompt,/10.?15.*分钟/);
  assert.match(prompt,/章节/);
  assert.match(prompt,/task_tree_review_inputs/);
  assert.match(prompt,/Git.*不携带|Git.*忽略/);
  assert.match(buildPlannerPrompt(''),/10.?15.*分钟/);
});

test('planner and workers default to useful fan-out while keeping indivisible tasks and one-level worker splits',()=>{
  const planner=buildPlannerPrompt('');
  const worker=buildWorkerPrompt({taskId:'module',nodeId:'ROOT',instruction:'完成分配模块',writeSet:[]});
  assert.match(planner,/两个以上分别需要分析、推导、实现或撰写的独立成果，默认主动并行/);
  assert.match(planner,/尽早发布共享接口并委派主要成果/);
  assert.match(planner,/确实不可拆的任务是单人例外/);
  assert.match(planner,/不递归拆分微任务/);
  assert.match(worker,/本 worker 只允许再拆一层/);
  assert.match(worker,/禁止递归拆分微任务/);
});

test('planner and workers classify independent analysis and writing as substantive deliverables',()=>{
  const planner=buildPlannerPrompt('');
  const worker=buildWorkerPrompt({taskId:'module',nodeId:'ROOT',instruction:'完成分配模块',writeSet:[]});
  assert.match(planner,/分别需要分析、推导、实现或撰写的独立成果/);
  assert.match(planner,/短标签机械替换这类微小操作/);
  assert.match(planner,/同一份文档中需分别分析和论证的章节按统一提纲并行撰写/);
  assert.match(worker,/两个以上可独立交付的主要成果/);
  assert.match(worker,/同文档各章节分别分析、统一提纲并行撰写/);
});

test('planner and workers publish common conventions without inventing an output dependency',()=>{
  const prompts=[buildPlannerPrompt(''),buildWorkerPrompt({taskId:'module',nodeId:'ROOT',instruction:'完成分配模块',writeSet:[]})];
  for(const prompt of prompts){
    assert.match(prompt,/共享字段.*术语.*风格.*不.*强依赖/);
    assert.match(prompt,/固定公共约定再委派/);
    assert.match(prompt,/必须消费.*尚未产生的实际结果/);
  }
});

test('document planning example delegates the actual chapters and assigns one final file to the checker',()=>{
  const planner=buildPlannerPrompt('');
  assert.match(planner,/one-shot.*最终.*一份.*\.md/);
  assert.match(planner,/最终检查.*同.*会话.*组装/);
  assert.match(planner,/接口章.*instruction=.*分析/);
  assert.match(planner,/运维章.*instruction=.*分析/);
  const worker=buildWorkerPrompt({taskId:'module',nodeId:'ROOT',instruction:'完成分配模块',writeSet:[]});
  assert.match(worker,/片段.*最终检查.*组装.*用户指定/);
});

test("automatic planning retries a missing dependency and accepts the corrected ready jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-required-plan-"));
  await writeFile(path.join(root, "task-tree.md"), [
    "# LLM Task Graph",
    "## ROOT - 自动并行",
    "- Problem: 每次自动规划都要并行完成目标",
    "## N1 - 当前阶段",
    "- Problem: 拆成多个可执行分支",
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "# Edges"
  ].join("\n"));

  const oneJobPlan = JSON.stringify({ jobs: [{
    taskId: "only-worker", nodeId: "N1", title: "单分支", summary: "错误的未知依赖计划",
    instruction: "完成全部目标", writeSet: ["result.txt"], dependsOn: ["missing"]
  }] });
  const twoJobPlan = JSON.stringify({
    summary: "两个分支同时推进并完成目标。",
    coverage: [{ goal: "全部目标", taskIds: ["implementation", "integration"] }],
    jobs: [
      { taskId: "implementation", nodeId: "N1", title: "实现分支", summary: "完成实现", instruction: "完成实现部分", writeSet: ["result.txt"], dependsOn: [] },
      { taskId: "integration", nodeId: "N1", title: "整合分支", summary: "完成整合", instruction: "完成整合部分", writeSet: ["result.txt"], dependsOn: [] }
    ]
  });
  let planningCalls = 0;
  const planningPrompts = [];
  let active = 0;
  let maximumActive = 0;
  const startTurn = async (options) => {
    if (options.prompt.includes("Automatic Parallel Planner")) {
      planningCalls += 1;
      planningPrompts.push(options.prompt);
      assert.equal(options.model, "gpt-6.1-sol");
      assert.equal(options.config?.model_reasoning_effort, "low");
      assert.equal(options.outputSchema?.properties?.jobs?.minItems, 1);
      assert.equal(options.outputSchema?.properties?.jobs?.items?.additionalProperties, false);
      await options.onAccepted?.({ threadId: "planner", turnId: `planner-${planningCalls}` });
      options.onNotification?.({ params: { item: { type: "reasoning" } } });
      options.onNotification?.({ params: { item: { type: "agentMessage" } } });
      options.onNotification?.({ method: "item/completed", params: { item: { type: "agentMessage" } } });
      return { threadId: "planner", turnId: `planner-${planningCalls}`, output: planningCalls === 1 ? oneJobPlan : twoJobPlan };
    }
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    assert.ok(taskId);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { threadId: `thread-${taskId}`, turnId: `turn-${taskId}`, output: JSON.stringify({ event: "completed", evidence: taskId, peerRequests: [] }) };
  };
  const workspace = {
    async prepare() { return { integrationPath: "integration", snapshotCommit: "snapshot" }; },
    async head() { return "head"; },
    async createWorker(_runId, taskId) { return `worker/${taskId}`; },
    async inspectChanges(workerPath) { return { changedFiles: [`${workerPath}.txt`], violations: [] }; },
    async commit(workerPath) { return `commit-${workerPath}`; },
    async integrate() { return { conflicts: [] }; },
    async removeWorker() {},
    async summarize() { return { changedFiles: ["result.txt"], stat: "1 file", patchPreview: "result", patchTruncated: false }; },
    async accept() { return { appliedFiles: ["result.txt"] }; },
    async cleanup() {}
  };

  try {
    const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn, workspace });
    const planned = await coordinator.plan({ objective: "自动完成当前目标" });
    const finished = await coordinator.wait(planned.id);
    await coordinator.drain();
    assert.equal(finished.status, "accepted", finished.error);
    assert.equal(planningCalls, 2);
    assert.match(planningPrompts[0], /不可再分的结果，保留一个任务/);
    assert.match(planningPrompts[1], /引用了未知依赖/);
    assert.equal(finished.jobs.length, 2);
    assert.equal(maximumActive, 2);
    assert.equal(finished.planner.timing.model, "gpt-6.1-sol");
    assert.equal(finished.planner.timing.reasoningEffort, "low");
    assert.ok(finished.planner.timing.inputChars > 0);
    assert.equal(finished.planner.timing.outputChars, twoJobPlan.length);
    assert.ok(finished.planner.timing.acceptedMs !== null);
    assert.ok(finished.planner.timing.firstReasoningMs !== null);
    assert.ok(finished.planner.timing.firstAgentMessageMs !== null);
    assert.ok(finished.planner.timing.finalAgentMessageMs !== null);
    assert.ok(finished.events.some((event) => event.type === "plan_started" && event.parallelRequired === true && event.workerCount === 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid planning retries with structured failure context, then eight workers run concurrently and auto-apply", {timeout:30000},async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-coordinator-"));
  const marker = "COMPLETE-TREE-END";
  await writeFile(path.join(root, "task-tree.md"), [
    "# LLM Task Graph",
    "## ROOT - 并行执行",
    "- Problem: 自动完成全部目标",
    "- Metrics: 所有 Worker 完成",
    "## N1 - 当前节点",
    "- Problem: 并发执行",
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "# Edges",
    "y".repeat(40000),
    marker
  ].join("\n"));

  let planningCalls = 0;
  const plannerPrompts = [];
  const workerPrompts = [];
  let active = 0;
  let maximumActive = 0;
  const outputMarker = "WORKER-OUTPUT-END";
  let releaseAll;
  const allStarted=new Promise(resolve=>releaseAll=resolve);
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    taskId: `worker-${index + 1}`,
    nodeId: "N1",
    title: `分支${index + 1}`,
    summary: `完成第${index + 1}项`,
    instruction: `完成第${index + 1}项并保留完整上下文`,
    writeSet: ["shared/result.txt"],
    dependsOn: []
  }));
  const validPlan = JSON.stringify({
    summary: "八项工作彼此独立，全部同时执行。",
    coverage: jobs.map((job) => ({ goal: job.instruction, taskIds: [job.taskId] })),
    jobs
  });
  const startTurn = async (options) => {
    if (options.prompt.includes("Automatic Parallel Planner")) {
      planningCalls += 1;
      plannerPrompts.push(options.prompt);
      return {
        threadId: "planner-thread",
        turnId: `planner-${planningCalls}`,
        output: planningCalls === 1 ? "INVALID-PLAN-WITH-FULL-OUTPUT" : validPlan
      };
    }
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    assert.ok(taskId, "unexpected model call");
    workerPrompts.push(options.prompt);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
    if(active===8)releaseAll();
    await allStarted;
    active -= 1;
    return {
      threadId: `thread-${taskId}`,
      turnId: `turn-${taskId}`,
      output: JSON.stringify({ event: "completed", evidence: `${taskId}\n${outputMarker}`, peerRequests: [] })
    };
  };

  let accepted = 0;
  let testCalls = 0;
  const workspace = {
    async prepare() { return { integrationPath: "integration", snapshotCommit: "snapshot" }; },
    async head() { return "head"; },
    async createWorker(_runId, taskId) { return `worker/${taskId}`; },
    async inspectChanges(workerPath) { return { changedFiles: [`${workerPath}.txt`], violations: [] }; },
    async runTests() { testCalls += 1; return []; },
    async commit(workerPath) { return `commit-${workerPath}`; },
    async integrate() { return { conflicts: [] }; },
    async removeWorker() {},
    async summarize() {
      return { changedFiles: ["shared/result.txt"], stat: "1 file", patchPreview: "full patch", patchTruncated: false };
    },
    async accept() { accepted += 1; return { appliedFiles: ["shared/result.txt"] }; },
    async cleanup() {}
  };

  try {
    const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn, workspace });
    const planned = await coordinator.plan({ objective: "立即并行完成全部目标" });
    assert.equal(planned.status, "planning");
    const finished = await coordinator.wait(planned.id);
    await coordinator.drain();

    assert.equal(finished.status, "accepted");
    assert.equal(planningCalls, 2);
    assert.doesNotMatch(plannerPrompts[1], /INVALID-PLAN-WITH-FULL-OUTPUT/);
    assert.match(plannerPrompts[1], /规划结果不是有效 JSON/);
    assert.match(plannerPrompts[1], /outputChars/);
    assert.equal(workerPrompts.length, 8);
    assert.equal(maximumActive, 8, "all ready workers should start without an application-level cap");
    assert.ok(workerPrompts.every((prompt) => prompt.includes('task-tree-summary/v1') && prompt.includes('task_tree_read')), "every worker receives the map and an optional full read");
    assert.match(finished.summary, /8\/8/);
    assert.ok(finished.treeSummary?.fingerprint);
    const snapshot = JSON.parse(await readFile(path.join(root, finished.treeSummary.snapshotPath), 'utf8'));
    assert.equal(snapshot.fingerprint, finished.treeSummary.fingerprint);
    assert.equal(accepted, 1, "successful execution applies automatically");
    assert.equal(testCalls, 0, "the product flow never invokes workspace test commands");
    assert.equal(finished.jobs.length, 8);
    assert.ok(finished.jobs.every((job) => job.output.includes(outputMarker)), "worker output is returned without truncation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic planning preserves twelve and twenty useful workers and starts each ready frontier without a hidden cap", async () => {
  for (const workerCount of [12, 20]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `parallel-wide-frontier-${workerCount}-`));
    await writeFile(path.join(root, "task-tree.md"), [
      "# LLM Task Graph",
      "## ROOT - 最大并行前沿",
      "- Problem: 自动拆出全部独立交付物",
      "## N1 - 当前阶段",
      "- Problem: 每个独立结果都可并行推进",
      "# GraphState",
      "- Current: N1",
      "- Next: N1",
      "# Edges"
    ].join("\n"));

    const jobs = Array.from({ length: workerCount }, (_, index) => ({
      taskId: `wide-${workerCount}-${index + 1}`,
      nodeId: "N1",
      title: `独立结果${index + 1}`,
      summary: `完成第${index + 1}个独立结果`,
      instruction: `完成第${index + 1}个独立结果`,
      writeSet: [`deliverables/result-${index + 1}.txt`],
      dependsOn: []
    }));
    const validPlan = JSON.stringify({
      summary: `将${workerCount}个互不依赖的结果全部放入同一可运行前沿。`,
      coverage: jobs.map((job) => ({ goal: job.instruction, taskIds: [job.taskId] })),
      jobs
    });
    let active = 0;
    let maximumActive = 0;
    let plannerPrompt = "";
    let releaseFrontier;
    const frontierStarted = new Promise(resolve => { releaseFrontier = resolve; });
    const startTurn = async (options) => {
      if (options.prompt.includes("Automatic Parallel Planner")) {
        plannerPrompt = options.prompt;
        return { threadId: `planner-${workerCount}`, turnId: `planner-${workerCount}`, output: validPlan };
      }
      const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
      assert.ok(taskId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === workerCount) releaseFrontier();
      await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
      await frontierStarted;
      active -= 1;
      return { threadId: `thread-${taskId}`, turnId: `turn-${taskId}`, output: JSON.stringify({ event: "completed", evidence: taskId, peerRequests: [] }) };
    };
    const workspace = {
      async prepare() { return { integrationPath: "integration", snapshotCommit: "snapshot" }; },
      async head() { return "head"; },
      async createWorker(_runId, taskId) { return `worker/${taskId}`; },
      async inspectChanges(workerPath) { return { changedFiles: [`${workerPath}.txt`], violations: [] }; },
      async commit(workerPath) { return `commit-${workerPath}`; },
      async integrate() { return { conflicts: [] }; },
      async removeWorker() {},
      async summarize() { return { changedFiles: jobs.map((job) => `deliverables/${job.taskId}.txt`), stat: `${workerCount} files`, patchPreview: "complete", patchTruncated: false }; },
      async accept() { return { appliedFiles: jobs.map((job) => `deliverables/${job.taskId}.txt`) }; },
      async cleanup() {}
    };

    try {
      const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn, workspace });
      const planned = await coordinator.plan({ objective: `并行完成${workerCount}个独立结果` });
      const finished = await coordinator.wait(planned.id);
      await coordinator.drain();
      assert.equal(finished.status, "accepted", finished.error);
      assert.equal(finished.jobs.length, workerCount, `planner output must preserve all ${workerCount} workers`);
      assert.equal(maximumActive, workerCount, `all ${workerCount} ready workers should start together`);
      assert.match(plannerPrompt, /最大化有用的就绪前沿/);
      assert.match(plannerPrompt, /不设 Worker 上限/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("real Git-backed parallel run records workspace-function and Git-command timings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-timing-project-"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "parallel-timing-state-"));
  const git = (cwd, args) => exec("git", args, { cwd });
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Timing Test"]);
    await git(root, ["config", "user.email", "timing@test.local"]);
    await writeFile(path.join(root, "task-tree.md"), [
      "# LLM Task Graph",
      "## ROOT - 计时验证",
      "- Problem: 让每个执行阶段留下可定位的耗时证据",
      "## N1 - 并行阶段",
      "- Problem: 两个独立 Worker 并发交付",
      "# GraphState",
      "- Current: N1",
      "- Next: N1",
      "# Edges"
    ].join("\n"));
    await git(root, ["add", "task-tree.md"]);
    await git(root, ["commit", "-m", "timing fixture"]);

    const jobs = ["alpha", "beta"].map((taskId) => ({
      taskId,
      nodeId: "N1",
      title: taskId,
      instruction: `创建 ${taskId}.txt`,
      writeSet: [`${taskId}.txt`],
      dependsOn: []
    }));
    const plan = JSON.stringify({ summary: "两个独立任务并行运行", coverage: [], jobs });
    const startTurn = async (options) => {
      if (options.prompt.includes("Automatic Parallel Planner")) {
        return { threadId: "timing-planner", turnId: "timing-plan", output: plan };
      }
      const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
      assert.ok(taskId, "unexpected model turn");
      await writeFile(path.join(options.cwd, `${taskId}.txt`), `${taskId}\n`);
      await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
      return {
        threadId: `thread-${taskId}`,
        turnId: `turn-${taskId}`,
        output: JSON.stringify({ event: "completed", evidence: `${taskId}.txt`, peerRequests: [] })
      };
    };
    const coordinator = createParallelCodexCoordinator({
      projectRoot: root,
      startTurn,
      workspace: createGitWorkspaceManager({ projectRoot: root, tempRoot })
    });
    const planned = await coordinator.plan({ objective: "真实 Git 下验证全链路函数级计时" });
    await coordinator.wait(planned.id);
    await coordinator.drain();
    const finished = await coordinator.get(planned.id);

    assert.equal(finished.status, "accepted", finished.error);
    assert.deepEqual(finished.result.appliedFiles.sort(), ["alpha.txt", "beta.txt"]);
    assert.ok(finished.completedAt, "the full run records completion after cleanup");
    assert.ok(finished.totalDurationMs > 0, "the full run duration includes finalization");
    assert.equal(finished.result.cleanup.status, "completed");
    assert.ok(finished.result.cleanup.durationMs >= 0, "final cleanup duration is recorded");
    assert.deepEqual((await Promise.all(["alpha", "beta"].map((taskId) => readFile(path.join(root, `${taskId}.txt`), "utf8")))).sort(), ["alpha\n", "beta\n"]);
    for (const operation of ["prepare", "head", "createWorker", "inspectChanges", "commit", "integrate", "summarize", "accept", "cleanup"]) {
      assert.ok(finished.workspaceTimings[operation]?.calls > 0, `missing timing for ${operation}`);
    }
    assert.ok(finished.workspaceTimings.cleanup.calls >= 2, "accept and final run cleanup calls are counted separately");
    assert.ok(finished.gitCommandTimings.calls > 0, "Git subprocess calls must be timed individually");
    for (const command of ["worktree", "diff", "commit-tree", "cherry-pick", "apply"]) {
      assert.ok(finished.gitCommandTimings.byCommand[command]?.calls > 0, `missing git ${command} timing`);
    }
    assert.ok(finished.events.some((event) => event.type === "workspace_timing" && event.operation === "accept"));
    assert.ok(finished.events.some((event) => event.type === "git_command_timing" && event.command === "cherry-pick"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
