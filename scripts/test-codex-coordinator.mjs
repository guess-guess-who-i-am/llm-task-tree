import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCoordinatorPrompt,
  buildBranchPlannerPrompt,
  buildGoalAuditPrompt,
  buildPlannerPrompt,
  buildWorkerPrompt,
  assignParallelDraftContexts,
  buildParallelContextOption,
  createParallelCodexCoordinator,
  deriveParallelContextKey,
  deriveParallelGoal,
  goalAssessmentAllowsAccept,
  normalizeGoalAssessment,
  validateParallelJobs
} from "../server/codex-coordinator.js";

const jobs = [
  {
    taskId: "ui",
    nodeId: "N2",
    title: "界面",
    instruction: "改进并行审核界面",
    writeSet: ["public/**"],
    dependsOn: [],
    tests: ["node scripts/test-ui.mjs"]
  },
  {
    taskId: "server",
    nodeId: "N3",
    title: "服务",
    instruction: "实现并行运行状态机",
    writeSet: ["server/**"],
    dependsOn: [],
    tests: ["node scripts/test-server.mjs"]
  }
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

assert.deepEqual(validateParallelJobs(jobs).map((job) => job.taskId), ["ui", "server"]);
assert.equal(validateParallelJobs(jobs)[0].contextKey, deriveParallelContextKey(jobs[0]));
const legacyContext = buildParallelContextOption({ id: "legacy-run", status: "accepted", updatedAt: "2026-08-18T00:00:00Z" }, {
  ...jobs[0],
  status: "completed",
  threadId: "legacy-worker-ui"
});
assert.equal(legacyContext.threadId, "legacy-worker-ui", "legacy completed workers remain reusable without new context fields");
const [scopeMatched] = assignParallelDraftContexts([{ ...jobs[0], writeSet: ["public/app.js"] }], [{ ...legacyContext, writeSet: ["public/**"] }]);
assert.equal(scopeMatched.contextThreadId, "legacy-worker-ui", "a compatible scope should reuse the stable historical branch context");
assert.equal(scopeMatched.contextMatch, "scope");
const [forcedFresh] = assignParallelDraftContexts([{ ...jobs[0], contextPolicy: "new" }], [legacyContext]);
assert.equal(forcedFresh.contextThreadId, "", "an explicit fresh choice must remain fresh");
const queuedJobs = Array.from({ length: 7 }, (_, index) => ({
  taskId: `queued-${index + 1}`,
  nodeId: `N${index + 1}`,
  instruction: `完成排队分支 ${index + 1}`,
  writeSet: [`parallel/branch-${index + 1}.txt`],
  dependsOn: [],
  tests: []
}));
assert.equal(validateParallelJobs(queuedJobs).length, 7, "计划分支数可以超过同时运行的 worker 数");
const humanized = validateParallelJobs([
  { ...jobs[0], title: "状态同步提示契约", instruction: "先完成状态同步规则。再补充详细实现。" },
  { ...jobs[1], title: "业务场景代理夹具", instruction: "建立本地业务测试场景。" }
]);
assert.deepEqual(humanized.map((job) => job.title), ["状态同步规则", "业务测试场景"]);
assert.deepEqual(humanized.map((job) => job.summary), ["先完成状态同步规则", "建立本地业务测试场景"]);
assert.throws(() => validateParallelJobs([jobs[0]]), /至少需要 2/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], taskId: "ui" }]), /任务不能重复/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["public/app.js"] }]), /分支负责修改的文件范围冲突/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["task-tree.md"] }]), /共享状态/);
assert.doesNotThrow(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["scripts/**"] }]));
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["versions/**"] }]), /共享状态/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["../outside"] }]), /越出/);
assert.throws(() => validateParallelJobs([
  jobs[0],
  { ...jobs[1], dependsOn: ["missing"] }
]), /未知依赖/);
assert.match(buildPlannerPrompt("## ROOT - Goal\n- Problem: ship it"), /JSON/);
assert.match(buildPlannerPrompt("## ROOT - Goal\n- Problem: ship it", "只修复失败分支"), /只修复失败分支/);
assert.match(buildPlannerPrompt("## ROOT - Goal\n- Problem: ship it", "只修复失败分支"), /summary.*advances the run goal/);
assert.match(buildPlannerPrompt("## ROOT - Goal\n- Problem: ship it"), /dependencyPrompt.*acceptancePrompt/);
assert.match(buildBranchPlannerPrompt("## ROOT - Goal\n- Problem: ship it\n\n## N3 - 分支\n- Problem: 修复上下文", "N3"), /exactly one new[\s\S]*dependencyPrompt/);
assert.match(buildPlannerPrompt("## ROOT - Goal\n- Problem: ship it", "继续推进", [{
  runId: "previous-run",
  status: "accepted",
  root: "长期保持正确目标",
  stage: "可靠完成自动并行",
  immediate: "完成上一轮并行审核",
  result: "审核链路已运行"
}]), /Previous target anchors[\s\S]*长期保持正确目标/);
assert.match(buildWorkerPrompt(validateParallelJobs(jobs)[0]), /isolated worktree/i);
assert.match(buildWorkerPrompt(validateParallelJobs(jobs)[0]), /do not.*task.tree/i);
assert.match(buildWorkerPrompt(validateParallelJobs([{ ...jobs[0], dependencyPrompt: "先完成接口", acceptancePrompt: "验证问题已解决" }, jobs[1]])[0]), /Dependency note: 先完成接口[\s\S]*Acceptance note: 验证问题已解决/);
assert.match(buildCoordinatorPrompt(validateParallelJobs(jobs)), /integration worktree/i);
assert.match(buildCoordinatorPrompt(validateParallelJobs(jobs), null, { history: [{ runId: "previous-run", root: "长期保持正确目标" }] }), /长期保持正确目标/);
assert.equal(goalAssessmentAllowsAccept({ alignment: "aligned", progress: "progress", continuity: "baseline" }), true);
assert.equal(goalAssessmentAllowsAccept({ alignment: "aligned", progress: "progress", continuity: "stable" }, [{ runId: "previous" }]), true);
assert.equal(goalAssessmentAllowsAccept({ alignment: "aligned", progress: "progress", continuity: "baseline" }, [{ runId: "previous" }]), false);
assert.equal(goalAssessmentAllowsAccept({ alignment: "off_target", progress: "reached" }), false);
assert.equal(goalAssessmentAllowsAccept({ alignment: "aligned", progress: "progress", continuity: "unknown" }), false);
assert.deepEqual(normalizeGoalAssessment({ alignment: "invented", progress: "reached" }).alignment, "unknown");

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-parallel-"));
await writeFile(path.join(projectRoot, "task-tree.md"), [
  "# LLM Task Graph",
  "",
  "## ROOT - 自动协作",
  "- Completion: 进行中",
  "- Problem: 如何自动完成并行开发？",
  "- Approach: 隔离执行并在末尾审核。",
  "- Metrics: 两次人工审核。",
  "- CurrentResult:",
  "- NextIdea:",
  "",
  "## N2 - 前端",
  "- Completion: 进行中",
  "- Problem: 如何审核运行？",
  "- Approach:",
  "- Metrics:",
  "- CurrentResult:",
  "- NextIdea: 实现审核界面。",
  "",
  "# GraphState",
  "- Current: N2",
  "- Next: N2",
  "",
  "# Edges",
  ""
].join("\n"), "utf8");

const plannerOutput = JSON.stringify({
  summary: "前后端两路并行，服务先提供契约，界面独立接入。",
  jobs,
  integrationTests: ["node scripts/test-all.mjs"]
});
const branchPlannerOutput = JSON.stringify({
  job: {
    nodeId: "N2",
    title: "补充分支",
    summary: "补足指定节点尚未覆盖的验证",
    instruction: "实现指定节点的补充验证并记录结果。",
    dependencyPrompt: "确认现有前后端分支已提供稳定接口。",
    acceptancePrompt: "真实入口通过，说明解决的问题和剩余缺口。",
    writeSet: ["docs/parallel-branch/**"],
    dependsOn: [],
    tests: []
  }
});
const calls = [];
const freshThreadCounts = new Map();
let failServer = false;
let auditAssessment = { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "实现与本轮目标一致", remaining: "仍需真实使用验证" };
let holdUi = true;
const uiTurnVisible = deferred();
const releaseUi = deferred();
const startTurn = async (options) => {
  calls.push(options);
  if (options.prompt.includes("Single Parallel Branch Planner")) {
    return { threadId: "branch-planner-thread", turnId: "branch-planner-turn", output: branchPlannerOutput };
  }
  if (options.threadName.includes("规划")) {
    return { threadId: "planner-thread", turnId: "planner-turn", output: plannerOutput };
  }
  if (options.threadName.includes("目标核验")) {
    await options.onAccepted?.({ threadId: "audit-thread", turnId: "audit-turn" });
    return { threadId: "audit-thread", turnId: "audit-turn", output: JSON.stringify(auditAssessment) };
  }
  if (options.prompt.includes("Continuous Supervisor")) {
    await options.onAccepted?.({ threadId: options.threadId || "supervisor-thread", turnId: "supervisor-turn" });
    return { threadId: options.threadId || "supervisor-thread", turnId: "supervisor-turn", output: JSON.stringify({ action: "finish", summary: "当前证据可进入集成", reason: "已审核分支完成", newJobs: [] }) };
  }
  if (options.prompt.includes("Supervisor Final Review")) {
    const continuity = options.prompt.includes("no previous accepted or reviewed run") ? "baseline" : "stable";
    return { threadId: options.threadId || "supervisor-thread", turnId: "supervisor-final-turn", output: JSON.stringify({ event: "completed", summary: "已核验集成结果", affectedNodes: ["N2", "N3"], evidence: "tests passed", goalAssessment: { alignment: "aligned", progress: "progress", continuity, achieved: "前后端闭环可运行", remaining: "仍需真实使用验证" } }) };
  }
  if (options.threadName.includes("汇总")) {
    await options.onAccepted?.({ threadId: "coordinator-thread", turnId: "coordinator-turn" });
    const continuity = options.prompt.includes("no previous accepted or reviewed run") ? "baseline" : "stable";
    return {
      threadId: "coordinator-thread",
      turnId: "coordinator-turn",
      output: JSON.stringify({
        event: "completed",
        summary: "已核验集成结果",
        affectedNodes: ["N2", "N3"],
        evidence: "tests passed",
        goalAssessment: { alignment: "aligned", progress: "progress", continuity, achieved: "前后端闭环可运行", remaining: "仍需真实使用验证" }
      })
    };
  }
  const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
  const freshCount = Number(freshThreadCounts.get(taskId) || 0) + (options.threadId ? 0 : 1);
  if (!options.threadId) freshThreadCounts.set(taskId, freshCount);
  const threadId = options.threadId || `worker-${taskId}${freshCount > 1 ? `-${freshCount}` : ""}`;
  const turnId = `turn-${taskId}`;
  await options.onAccepted?.({ threadId, turnId });
  if (failServer && taskId === "server") {
    const error = new Error("server worker failed");
    error.threadId = threadId;
    throw error;
  }
  if (holdUi && taskId === "ui") {
    uiTurnVisible.resolve();
    await releaseUi.promise;
  }
  return { threadId, turnId, resumed: Boolean(options.threadId), output: '{"event":"completed"}' };
};

const workspaceCalls = [];
let holdPrepare = true;
const prepareStarted = deferred();
const releasePrepare = deferred();
const workspace = {
  async prepare(runId) {
    workspaceCalls.push(["prepare", runId]);
    if (holdPrepare) {
      prepareStarted.resolve();
      await releasePrepare.promise;
      holdPrepare = false;
    }
    return { snapshotCommit: "snapshot", integrationPath: path.join(projectRoot, "integration") };
  },
  async head() { return "snapshot"; },
  async createWorker(runId, taskId) {
    workspaceCalls.push(["createWorker", runId, taskId]);
    return path.join(projectRoot, taskId);
  },
  async inspectChanges(workerPath) {
    const taskId = path.basename(workerPath);
    return { changedFiles: taskId === "ui" ? ["public/app.js"] : ["server/codex-coordinator.js"], violations: [] };
  },
  async runTests(cwd, commands) {
    workspaceCalls.push(["runTests", path.basename(cwd), commands]);
    return commands.map((command) => ({ command, ok: true, exitCode: 0, output: "PASS" }));
  },
  async commit(workerPath) { return `commit-${path.basename(workerPath)}`; },
  async integrate(integrationPath, commit) { workspaceCalls.push(["integrate", commit]); },
  async removeWorker(workerPath) { workspaceCalls.push(["removeWorker", path.basename(workerPath)]); },
  async summarize() {
    return { changedFiles: ["public/app.js", "server/codex-coordinator.js"], stat: "2 files changed", patchPreview: "diff --git ..." };
  },
  async accept(info) { workspaceCalls.push(["accept", info.snapshotCommit]); return { appliedFiles: info.changedFiles }; },
  async cleanup(info) { workspaceCalls.push(["cleanup", info.runId]); }
};

try {
  const acceptedSyncs = [];
  let holdTreeSync = true;
  const releaseTreeSync = deferred();
  const manager = createParallelCodexCoordinator({
    projectRoot,
    startTurn,
    workspace,
    onAccepted: async ({ appliedFiles }) => {
      acceptedSyncs.push(appliedFiles);
      if (holdTreeSync) await releaseTreeSync.promise;
      return { status: "completed", threadId: "tree-sync-thread" };
    }
  });

  // Planning is inert: no writable workspace exists before the first human review.
  const planning = await manager.plan({ objective: "本轮只完成可隔离验证的前后端改动" });
  assert.equal(planning.status, "planning");
  const draft = await manager.wait(planning.id);
  assert.equal(draft.status, "draft");
  assert.equal(draft.jobs.length, 2);
  assert.equal(draft.planner.threadId, "planner-thread");
  assert.equal(draft.objective, "本轮只完成可隔离验证的前后端改动");
  assert.equal(draft.goal.immediate, "本轮只完成可隔离验证的前后端改动");
  assert.equal(draft.goal.stageNodeId, "N2");
  assert.match(calls[0].prompt, /本轮只完成可隔离验证的前后端改动/);
  assert.equal(workspaceCalls.length, 0, "draft planning must not prepare or mutate a workspace");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sandbox, "read-only");
  assert.equal("model" in calls[0], false, "planner must inherit the user's configured model");
  assert.equal("effort" in calls[0], false, "planner must inherit the user's configured reasoning effort");
  assert.match(calls[0].developerInstructions, /Do not call tools/);
  assert.equal(calls[0].completionTimeoutMs, 180_000);
  assert.equal(calls[0].totalTimeoutMs, 180_000);

  const branchProposal = await manager.branchPlan(draft.id, { nodeId: "N2", existingJobs: draft.jobs });
  assert.equal(branchProposal.job.nodeId, "N2");
  assert.equal(branchProposal.job.contextPolicy, "reuse");
  assert.match(branchProposal.job.dependencyPrompt, /稳定接口/);
  assert.match(branchProposal.job.acceptancePrompt, /剩余缺口/);
  assert.equal(branchProposal.planner.status, "completed");
  const storedSystemContexts = JSON.parse(await readFile(path.join(projectRoot, ".task-tree-runs", "system-contexts"), "utf8"));
  assert.equal(storedSystemContexts.planner.threadId, "branch-planner-thread", "planner context must survive a service restart instead of creating another system conversation");
  assert.equal("model" in calls[1], false);
  assert.equal("effort" in calls[1], false);
  assert.match(calls[1].developerInstructions, /Do not call tools/);
  assert.equal(workspaceCalls.length, 0, "single-branch planning must remain read-only until review");

  // One approval runs isolated writable workers and stops at end review.
  const approved = await manager.approve(draft.id, { jobs: draft.jobs, integrationTests: draft.integrationTests });
  assert.equal(approved.status, "approved");
  await prepareStarted.promise;
  const preparing = await manager.get(draft.id);
  assert.equal(preparing.status, "preparing", "snapshot preparation must be visible immediately");
  releasePrepare.resolve();
  await uiTurnVisible.promise;
  const running = await manager.get(draft.id);
  assert.equal(running.status, "running");
  assert.equal(running.jobs.find((job) => job.taskId === "ui").threadId, "worker-ui", "worker task must be visible before completion");
  holdUi = false;
  releaseUi.resolve();
  const review = await manager.wait(draft.id);
  assert.equal(review.status, "review");
  const workerCalls = calls.filter((call) => call.prompt.includes("Isolated Parallel Worker"));
  assert.ok(workerCalls.every((call) => call.sandbox === "workspace-write"));
  assert.ok(workerCalls.every((call) => call.cwd !== projectRoot));
  assert.equal(review.coordinator.threadId, "coordinator-thread");
  assert.deepEqual(review.review.changedFiles, ["public/app.js", "server/codex-coordinator.js"]);
  assert.equal(review.review.goalAssessment.alignment, "aligned");
  assert.equal(review.review.goalAssessment.progress, "progress");
  assert.equal(review.review.readyToAccept, true);
  assert.equal(workspaceCalls.some(([name]) => name === "accept"), false, "end review must happen before main-workspace apply");

  // Final acceptance applies the reviewed result exactly once.
  const accepted = await manager.accept(draft.id);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.review.appliedFiles, review.review.changedFiles);
  assert.ok(["queued", "running"].includes(accepted.review.treeSync.status));
  assert.deepEqual(acceptedSyncs, [], "task-tree sync must run after the fast accept response");
  assert.equal(workspaceCalls.some(([name]) => name === "cleanup"), false, "cleanup must not delay the accept response");
  holdTreeSync = false;
  releaseTreeSync.resolve();
  const finalized = await manager.wait(draft.id);
  assert.equal(finalized.review.treeSync.status, "completed");
  assert.equal(finalized.review.cleanup.status, "completed");
  assert.deepEqual(acceptedSyncs, [review.review.changedFiles]);
  await assert.rejects(() => manager.accept(draft.id), /只能接受待审核/);

  // A later run automatically reuses each stable branch context; the human can still select
  // a different historical conversation for any branch.
  const continuedPlanCallStart = calls.length;
  const continuedPlanning = await manager.plan({ objective: "继续沿用同一批分支上下文" });
  const continuedDraft = await manager.wait(continuedPlanning.id);
  assert.ok(continuedDraft.jobs.every((job) => job.contextPolicy === "reuse" && job.contextThreadId));
  assert.equal(new Set(continuedDraft.jobs.map((job) => job.contextThreadId)).size, 2);
  const continuedPlannerCall = calls.slice(continuedPlanCallStart).find((call) => call.prompt.includes("Automatic Parallel Planner"));
  assert.equal(continuedPlannerCall.threadId, "branch-planner-thread", "full and single-branch planning reuse one system conversation");
  const contextsByNode = new Map(continuedDraft.contextOptions.map((option) => [option.nodeId, option]));
  const selectedJobs = continuedDraft.jobs.map((job) => {
    const option = contextsByNode.get(job.nodeId);
    return {
      ...job,
      contextPolicy: "selected",
      contextKey: option.contextKey,
      contextThreadId: option.threadId,
      contextSource: option.source || "parallel",
      contextLabel: option.title
    };
  });
  await assert.rejects(() => manager.approve(continuedDraft.id, {
    jobs: selectedJobs.map((job) => ({ ...job, contextKey: selectedJobs[0].contextKey, contextThreadId: selectedJobs[0].contextThreadId }))
  }), /同一 Codex 对话不能同时分配/);
  const continuedCallStart = calls.length;
  await manager.approve(continuedDraft.id, { jobs: selectedJobs });
  const continuedReview = await manager.wait(continuedDraft.id);
  const continuedWorkerCalls = calls.slice(continuedCallStart).filter((call) => call.prompt.includes("Isolated Parallel Worker"));
  assert.ok(continuedWorkerCalls.every((call) => call.threadId), "each explicitly selected branch context must resume its own thread");
  assert.equal(new Set(continuedWorkerCalls.map((call) => call.threadId)).size, 2);
  assert.ok(continuedReview.jobs.every((job) => job.contextResumed === true));
  await manager.reject(continuedDraft.id);

  const freshPlanning = await manager.plan({ objective: "让界面分支继承一条普通项目对话" });
  const freshDraft = await manager.wait(freshPlanning.id);
  const freshCallStart = calls.length;
  await manager.approve(freshDraft.id, {
    jobs: freshDraft.jobs.map((job) => job.taskId === "ui" ? {
      ...job,
      contextPolicy: "selected",
      contextKey: "codex-project-source",
      contextThreadId: "project-source-thread",
      contextSource: "codex",
      contextLabel: "用户选择的项目对话"
    } : job)
  });
  const freshReview = await manager.wait(freshDraft.id);
  const freshUiCall = calls.slice(freshCallStart).find((call) => call.prompt.includes("Task id: ui"));
  assert.equal(freshUiCall.threadId, "", "a project conversation must not be resumed directly in an isolated worktree");
  assert.equal(freshUiCall.forkThreadId, "project-source-thread", "the selected conversation must be forked into the branch worktree");
  assert.equal(freshReview.jobs.find((job) => job.taskId === "ui").contextResumed, false);
  assert.notEqual(freshReview.jobs.find((job) => job.taskId === "ui").contextThreadId, "worker-ui");
  await manager.reject(freshDraft.id);

  // Rejection removes isolation state without applying it.
  const rejectedPlanning = await manager.plan();
  const rejectedDraft = await manager.wait(rejectedPlanning.id);
  await manager.approve(rejectedDraft.id);
  const rejectedReview = await manager.wait(rejectedDraft.id);
  assert.match(buildGoalAuditPrompt(rejectedReview), /Run goal:/);
  auditAssessment = { alignment: "off_target", progress: "reached", continuity: "drifted", achieved: "完成了别的功能", remaining: "没有推进本轮目标" };
  const auditing = await manager.audit(rejectedDraft.id);
  assert.equal(auditing.status, "auditing");
  const offTargetReview = await manager.wait(rejectedDraft.id);
  assert.equal(offTargetReview.review.goalAssessment.alignment, "off_target");
  assert.equal(offTargetReview.review.readyToAccept, false, "tests passing cannot override an off-target result");
  auditAssessment = { alignment: "aligned", progress: "progress", continuity: "stable", achieved: "实现与本轮目标一致", remaining: "仍需真实使用验证" };
  await manager.audit(rejectedDraft.id);
  const realignedReview = await manager.wait(rejectedDraft.id);
  assert.equal(realignedReview.review.readyToAccept, true);
  const acceptsBeforeReject = workspaceCalls.filter(([name]) => name === "accept").length;
  const rejected = await manager.reject(rejectedDraft.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(workspaceCalls.filter(([name]) => name === "accept").length, acceptsBeforeReject);

  // A failed worker locks acceptance even when integration tests pass; retry reuses successful work.
  failServer = true;
  const retryPlanning = await manager.plan({ objective: "验证失败分支局部重跑" });
  const retryDraft = await manager.wait(retryPlanning.id);
  await manager.approve(retryDraft.id);
  const failedReview = await manager.wait(retryDraft.id);
  assert.equal(failedReview.status, "review");
  assert.deepEqual(failedReview.review.failedTasks, ["server"]);
  assert.equal(failedReview.review.readyToAccept, false);
  await assert.rejects(() => manager.accept(retryDraft.id), /尚未通过验收/);
  const preparesBeforeRetry = workspaceCalls.filter(([name]) => name === "prepare").length;
  const uiWorkersBeforeRetry = workspaceCalls.filter(([name, , taskId]) => name === "createWorker" && taskId === "ui").length;

  failServer = false;
  const retryApproved = await manager.retry(retryDraft.id, { jobs: failedReview.jobs });
  assert.equal(retryApproved.status, "approved");
  const retriedReview = await manager.wait(retryDraft.id);
  assert.equal(retriedReview.status, "review");
  assert.deepEqual(retriedReview.review.failedTasks, []);
  assert.equal(retriedReview.review.readyToAccept, true);
  const retriedServerCall = calls.filter((call) => call.prompt.includes("Task id: server")).at(-1);
  assert.equal(retriedServerCall.threadId, failedReview.jobs.find((job) => job.taskId === "server").contextThreadId);
  assert.equal(retriedReview.jobs.find((job) => job.taskId === "server").contextResumed, true);
  assert.equal(workspaceCalls.filter(([name]) => name === "prepare").length, preparesBeforeRetry, "retry must reuse the integration worktree");
  assert.equal(workspaceCalls.filter(([name, , taskId]) => name === "createWorker" && taskId === "ui").length, uiWorkersBeforeRetry, "completed workers must not run again");
  const retriedAccepted = await manager.accept(retryDraft.id);
  assert.equal(retriedAccepted.status, "accepted");
  await manager.wait(retryDraft.id);

  // A server restart must not leave an orphaned planning record spinning forever.
  const abandonedId = "abandoned-planning-run";
  await writeFile(path.join(projectRoot, ".task-tree-runs", `${abandonedId}.json`), `${JSON.stringify({
    id: abandonedId,
    status: "planning",
    objective: "",
    summary: "",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    error: "",
    planner: { status: "running", threadId: "", turnId: "", error: "" },
    jobs: [],
    integrationTests: [],
    coordinator: null,
    events: []
  }, null, 2)}\n`, "utf8");
  const restartedManager = createParallelCodexCoordinator({ projectRoot, startTurn, workspace });
  const recovered = await restartedManager.get(abandonedId);
  assert.equal(recovered.status, "draft");
  assert.equal(recovered.planner.status, "fallback");
  assert.match(recovered.summary, /自动恢复/);
  assert.ok(recovered.jobs.length >= 2);

  // A restart during execution preserves completed work and exposes only unfinished branches for retry.
  const interruptedId = "interrupted-execution-run";
  await writeFile(path.join(projectRoot, ".task-tree-runs", `${interruptedId}.json`), `${JSON.stringify({
    id: interruptedId,
    status: "running",
    objective: "",
    summary: "并行执行中",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    error: "",
    planner: { status: "completed", threadId: "planner", turnId: "turn", error: "" },
    jobs: [
      { ...validateParallelJobs(jobs)[0], status: "completed", threadId: "worker-ui", turnId: "turn-ui", changedFiles: ["public/app.js"], testResults: [] },
      { ...validateParallelJobs(jobs)[1], status: "running", threadId: "worker-server", turnId: "turn-server", changedFiles: [], testResults: [] }
    ],
    workspace: { snapshotCommit: "snapshot", integrationPath: path.join(projectRoot, "integration") },
    integrationTests: [],
    coordinator: null,
    review: null,
    events: []
  }, null, 2)}\n`, "utf8");
  const interruptedManager = createParallelCodexCoordinator({ projectRoot, startTurn, workspace });
  const interrupted = await interruptedManager.get(interruptedId);
  assert.equal(interrupted.status, "review");
  assert.equal(interrupted.jobs[0].status, "completed");
  assert.equal(interrupted.jobs[1].status, "failed");
  assert.deepEqual(interrupted.review.failedTasks, ["server"]);
  assert.match(interrupted.review.summary, /保留完成分支/);

  // If every worker completed before a restart, only the final coordinator resumes automatically.
  const coordinatorInterruptedId = "interrupted-coordinator-run";
  await writeFile(path.join(projectRoot, ".task-tree-runs", `${coordinatorInterruptedId}.json`), `${JSON.stringify({
    id: coordinatorInterruptedId,
    status: "coordinating",
    objective: "",
    summary: "等待汇总",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    error: "",
    planner: { status: "completed", threadId: "planner", turnId: "turn", error: "" },
    jobs: validateParallelJobs(jobs).map((job) => ({ ...job, status: "completed", threadId: `worker-${job.taskId}`, turnId: `turn-${job.taskId}`, changedFiles: [], testResults: [] })),
    workspace: { snapshotCommit: "snapshot", integrationPath: path.join(projectRoot, "integration") },
    integrationTests: [],
    coordinator: { status: "running", threadId: "", turnId: "", error: "" },
    review: null,
    events: []
  }, null, 2)}\n`, "utf8");
  const coordinatorRestartedManager = createParallelCodexCoordinator({ projectRoot, startTurn, workspace });
  const coordinatorResuming = await coordinatorRestartedManager.get(coordinatorInterruptedId);
  assert.ok(["approved", "running", "supervising", "coordinating"].includes(coordinatorResuming.status));
  const coordinatorRecovered = await coordinatorRestartedManager.wait(coordinatorInterruptedId);
  assert.equal(coordinatorRecovered.status, "review");
  assert.equal(coordinatorRecovered.coordinator.threadId, "coordinator-thread");
  assert.ok(coordinatorRecovered.events.some((item) => item.type === "coordinator_resume_queued"));

  let activeWorkers = 0;
  let peakWorkers = 0;
  const concurrencyWorkspace = {
    ...workspace,
    async prepare() { return { snapshotCommit: "snapshot", integrationPath: path.join(projectRoot, "many-integration") }; },
    async inspectChanges(workerPath) {
      const taskId = path.basename(workerPath);
      return { changedFiles: [`parallel/${taskId}.txt`], violations: [] };
    },
    async summarize() {
      return { changedFiles: queuedJobs.map((job) => `parallel/${job.taskId}.txt`), stat: "7 files changed", patchPreview: "diff --git ..." };
    }
  };
  const concurrencyManager = createParallelCodexCoordinator({
    projectRoot,
    workspace: concurrencyWorkspace,
    startTurn: async (options) => {
      if (options.prompt.includes("Continuous Supervisor")) {
        await options.onAccepted?.({ threadId: options.threadId || "many-supervisor", turnId: "many-supervisor-turn" });
        return { threadId: options.threadId || "many-supervisor", turnId: "many-supervisor-turn", output: JSON.stringify({ action: "finish", summary: "七个分支可汇总", reason: "全部完成", newJobs: [] }) };
      }
      if (options.prompt.includes("Supervisor Final Review")) {
        return { threadId: options.threadId || "many-supervisor", turnId: "many-supervisor-final", output: JSON.stringify({ event: "completed", summary: "七个分支已汇总", affectedNodes: queuedJobs.map((job) => job.nodeId), evidence: "并发峰值已记录", goalAssessment: { alignment: "aligned", progress: "progress", continuity: "stable", achieved: "多分支排队完成", remaining: "" } }) };
      }
      if (options.threadName.includes("汇总")) {
        await options.onAccepted?.({ threadId: "many-coordinator", turnId: "many-coordinator-turn" });
        return {
          threadId: "many-coordinator",
          turnId: "many-coordinator-turn",
          output: JSON.stringify({
            event: "completed",
            summary: "七个分支已汇总",
            affectedNodes: queuedJobs.map((job) => job.nodeId),
            evidence: "并发峰值已记录",
            goalAssessment: { alignment: "aligned", progress: "progress", continuity: "stable", achieved: "多分支排队完成", remaining: "" }
          })
        };
      }
      const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
      activeWorkers += 1;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
      await options.onAccepted?.({ threadId: `many-${taskId}`, turnId: `many-turn-${taskId}` });
      await new Promise((resolve) => setTimeout(resolve, 100));
      activeWorkers -= 1;
      return { threadId: `many-${taskId}`, turnId: `many-turn-${taskId}`, output: '{"event":"completed"}' };
    },
    onAccepted: async () => ({ status: "completed" })
  });
  const manyRun = await concurrencyManager.start(queuedJobs);
  const manyReview = await concurrencyManager.wait(manyRun.id);
  assert.equal(manyReview.status, "review");
  assert.equal(manyReview.jobs.length, 7);
  assert.equal(peakWorkers, 4, "more planned branches must queue behind the four-worker concurrency limit");

  // New branches join the same scheduler while it is running, and the same
  // integration worktree can continue after a human review.
  const appendJobs = [
    { taskId: "append-ui", nodeId: "N2", title: "追加界面", instruction: "完成追加界面分支", writeSet: ["parallel/append-ui.txt"], dependsOn: [], tests: [] },
    { taskId: "append-api", nodeId: "N3", title: "追加服务", instruction: "完成追加服务分支", writeSet: ["parallel/append-api.txt"], dependsOn: [], tests: [] }
  ];
  const appendStarted = deferred();
  const appendRelease = deferred();
  let appendHold = true;
  const appendWorkspace = {
    ...concurrencyWorkspace,
    async summarize() {
      return { changedFiles: ["parallel/append-ui.txt", "parallel/append-api.txt", "parallel/append-extra.txt", "parallel/append-later.txt"], stat: "4 files changed", patchPreview: "diff --git ..." };
    }
  };
  const appendManager = createParallelCodexCoordinator({
    projectRoot,
    workspace: appendWorkspace,
    startTurn: async (options) => {
      if (options.prompt.includes("Continuous Supervisor")) {
        await options.onAccepted?.({ threadId: options.threadId || "append-supervisor", turnId: "append-supervisor-turn" });
        return { threadId: options.threadId || "append-supervisor", turnId: "append-supervisor-turn", output: JSON.stringify({ action: "finish", summary: "追加分支可汇总", reason: "当前前沿完成", newJobs: [] }) };
      }
      if (options.prompt.includes("Supervisor Final Review")) {
        return { threadId: options.threadId || "append-supervisor", turnId: "append-supervisor-final", output: JSON.stringify({ event: "completed", summary: "追加分支已汇总", affectedNodes: ["N2", "N3"], evidence: "追加调度完成", goalAssessment: { alignment: "aligned", progress: "progress", continuity: "stable", achieved: "动态追加闭环完成", remaining: "" } }) };
      }
      if (options.threadName.includes("汇总")) {
        await options.onAccepted?.({ threadId: "append-coordinator", turnId: "append-coordinator-turn" });
        return {
          threadId: "append-coordinator",
          turnId: "append-coordinator-turn",
          output: JSON.stringify({
            event: "completed",
            summary: "追加分支已汇总",
            affectedNodes: ["N2", "N3", "N4"],
            evidence: "追加分支进入同一调度器",
            goalAssessment: { alignment: "aligned", progress: "progress", continuity: "stable", achieved: "追加运行可持续", remaining: "" }
          })
        };
      }
      const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
      await options.onAccepted?.({ threadId: `append-${taskId}`, turnId: `append-turn-${taskId}` });
      if (taskId === "append-ui" && appendHold) {
        appendStarted.resolve();
        await appendRelease.promise;
        appendHold = false;
      }
      return { threadId: `append-${taskId}`, turnId: `append-turn-${taskId}`, output: '{"event":"completed"}' };
    },
    onAccepted: async () => ({ status: "completed" })
  });
  const appendRun = await appendManager.start(appendJobs);
  await appendStarted.promise;
  const appendLive = await appendManager.get(appendRun.id);
  assert.equal(appendLive.status, "running");
  const queuedAppend = await appendManager.append(appendRun.id, {
    jobs: [{ taskId: "append-extra", nodeId: "N4", title: "追加验证", instruction: "完成追加验证分支", writeSet: ["parallel/append-extra.txt"], dependsOn: [], tests: [] }]
  });
  assert.equal(queuedAppend.status, "running");
  assert.equal(queuedAppend.jobs.at(-1).status, "queued");
  await assert.rejects(() => appendManager.append(appendRun.id, {
    jobs: [{ taskId: "append-conflict", nodeId: "N5", title: "冲突分支", instruction: "不应进入调度器", writeSet: ["parallel/append-ui.txt"], dependsOn: [], tests: [] }]
  }), /分支负责修改的文件范围冲突/);
  appendRelease.resolve();
  const appendReview = await appendManager.wait(appendRun.id);
  assert.equal(appendReview.status, "review");
  assert.ok(appendReview.jobs.some((job) => job.taskId === "append-extra" && job.status === "completed"));
  assert.equal((await appendManager.openThread(appendRun.id, "append-extra")).deepLink, "codex://threads/append-append-extra");
  const continuedAppend = await appendManager.append(appendRun.id, {
    jobs: [{ taskId: "append-later", nodeId: "N6", title: "审核后继续", instruction: "完成审核后的继续分支", writeSet: ["parallel/append-later.txt"], dependsOn: [], tests: [] }]
  });
  assert.equal(continuedAppend.status, "approved");
  const continuedAppendReview = await appendManager.wait(appendRun.id);
  assert.equal(continuedAppendReview.status, "review");
  assert.equal(continuedAppendReview.jobs.find((job) => job.taskId === "append-later").status, "completed");

  await Promise.all([manager.drain(), restartedManager.drain(), coordinatorRestartedManager.drain(), concurrencyManager.drain(), appendManager.drain()]);
  const stored = JSON.parse(await readFile(path.join(projectRoot, ".task-tree-runs", `${draft.id}.json`), "utf8"));
  assert.equal(stored.status, "accepted");
  console.log("PASS automatic parallel Codex plans inert drafts, runs in isolation, and requires final accept/reject");
} finally {
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
