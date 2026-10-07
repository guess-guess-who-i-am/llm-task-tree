import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPlannerPrompt,
  buildWorkerPrompt,
  createParallelCodexCoordinator,
  validateParallelJobs
} from "./codex-coordinator.js";

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

test("planner receives only decision-relevant context while workers keep the complete tree", () => {
  const marker = "END-OF-COMPLETE-CONTEXT";
  const tree = [
    "# LLM Task Graph",
    "## ROOT - 根目标",
    "- Problem: 完成目标",
    "## N1 - 当前阶段",
    "- Problem: 拆分当前工作",
    "- CurrentResult: 当前阶段事实",
    "## N2 - 无关历史",
    `- Notes: ${"x".repeat(50000)}`,
    `- CurrentResult: ${marker}`,
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
    branchContext: tree,
    contextResult: `历史结果\n${marker}`,
    runtimeMetadataPath: "/tmp/parallel-run-metadata"
  }])[0]);
  assert.match(worker, new RegExp(marker));
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
    assert.ok(workerPrompts.every((prompt) => prompt.includes(marker)), "every worker receives the complete task tree");
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
