import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildPlannerPrompt,
  buildBranchInputContext,
  buildWorkerPrompt,
  createParallelCodexCoordinator,
  validateParallelJobs
} from "./codex-coordinator.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";
import { saveAttachment } from './chat-attachments.js';
import { updateNodeMaterial } from './node-materials.js';

const exec = promisify(execFile);

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
  assert.match(prompt, /最大化当前可运行前沿/);
  assert.match(prompt, /六至八个独立结果/);
  assert.match(prompt, /十二或二十个也全部保留/);
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

test("automatic planning rejects a one-worker plan and retries until it has parallel workers", async () => {
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
    taskId: "only-worker", nodeId: "N1", title: "单分支", summary: "错误的单分支计划",
    instruction: "完成全部目标", writeSet: ["result.txt"], dependsOn: []
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
      assert.equal(options.model, "deepseek-v4.1-flash");
      assert.equal(options.config?.model_reasoning_effort, "low");
      assert.equal(options.outputSchema?.properties?.jobs?.minItems, 2);
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
    assert.match(planningPrompts[0], /至少两个任务必须无依赖立即运行/);
    assert.match(planningPrompts[1], /并行运行至少需要 2 个 worker/);
    assert.equal(finished.jobs.length, 2);
    assert.equal(maximumActive, 2);
    assert.equal(finished.planner.timing.model, "deepseek-v4.1-flash");
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

test("invalid planning retries with structured failure context, then eight workers run concurrently and auto-apply", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    const startTurn = async (options) => {
      if (options.prompt.includes("Automatic Parallel Planner")) {
        plannerPrompt = options.prompt;
        return { threadId: `planner-${workerCount}`, turnId: `planner-${workerCount}`, output: validPlan };
      }
      const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
      assert.ok(taskId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
      await new Promise((resolve) => setTimeout(resolve, 8));
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
      assert.match(plannerPrompt, /最大化当前可运行前沿/);
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
