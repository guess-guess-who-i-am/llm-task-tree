import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createParallelCodexCoordinator } from "../server/codex-coordinator.js";

const root = await mkdtemp(path.join(os.tmpdir(), "task-tree-context-lifecycle-"));
const tree = [
  "# LLM Task Graph",
  "## ROOT - 根目标",
  "- Problem: 让长期工作可以被快速恢复并保持正确目标",
  "- Approach: 任务树保存长期状态，对话保存短期工作记忆",
  "- Metrics: 新旧对话可追踪且不会混淆",
  "- CurrentResult:",
  "",
  "## N2 - 当前阶段",
  "- Problem: 验证上下文轮换",
  "- Metrics: 换代后仍能继续同一分支",
  "- CurrentResult:",
  "- NextIdea: 实现并测试上下文轮换",
  "",
  "# GraphState",
  "- Current: N2",
  "- Next: N2",
  "- NextPlan:",
  "",
  "# Edges",
  ""
].join("\n");
await mkdir(root, { recursive: true });
await (await import("node:fs/promises")).writeFile(path.join(root, "task-tree.md"), tree, "utf8");

const calls = [];
const archivedThreads = [];
const readHandoffs = [];
let workerTurn = 0;
const startTurn = async (options) => {
  calls.push(options);
  if (options.prompt.includes("Automatic Parallel Planner")) {
    return {
      threadId: "planner-thread",
      turnId: "planner-turn",
      resumed: Boolean(options.threadId),
      output: JSON.stringify({
        summary: "两个独立分支验证上下文机制",
        jobs: [
          { taskId: "ui", nodeId: "N2", title: "界面验证", summary: "验证用户能看见上下文代际", instruction: "验证界面上下文状态", writeSet: ["public/**"], dependsOn: [], tests: [] },
          { taskId: "server", nodeId: "N2", title: "服务验证", summary: "验证服务会自动生成交接", instruction: "验证服务上下文轮换", writeSet: ["server/**"], dependsOn: [], tests: [] }
        ],
        integrationTests: []
      })
    };
  }
  if (options.prompt.includes("Integration Coordinator")) {
    return {
      threadId: `coordinator-${calls.filter((item) => item.prompt.includes("Integration Coordinator")).length}`,
      turnId: "coordinator-turn",
      output: JSON.stringify({
        summary: "上下文轮换结果可验证",
        affectedNodes: ["N2"],
        evidence: "交接文件与新旧 thread",
        goalAssessment: { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "完成上下文轮换", remaining: "仍需真实使用验证" }
      })
    };
  }
  if (options.prompt.includes("Continuous Supervisor")) {
    await options.onAccepted?.({ threadId: options.threadId || "supervisor-thread", turnId: "supervisor-turn" });
    return { threadId: options.threadId || "supervisor-thread", turnId: "supervisor-turn", output: JSON.stringify({ action: "finish", summary: "上下文结果可汇总", reason: "两个分支均已完成", newJobs: [] }) };
  }
  if (options.prompt.includes("Supervisor Final Review")) {
    return { threadId: options.threadId || "supervisor-thread", turnId: "supervisor-final-turn", output: JSON.stringify({ summary: "上下文轮换结果可验证", affectedNodes: ["N2"], evidence: "交接文件与新旧 thread", goalAssessment: { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "完成上下文轮换", remaining: "仍需真实使用验证" } }) };
  }
  workerTurn += 1;
  const taskId = options.prompt.match(/Task id: ([^\n]+)/)?.[1] || "worker";
  const generation = options.forceNewThread ? 2 : 1;
  let handoffMarker = "";
  if (options.forceNewThread) {
    assert.match(options.prompt, /Previous generation handoff: \.task-tree-context\/handoff\.json/);
    const handoff = JSON.parse(await readFile(path.join(options.cwd, ".task-tree-context", "handoff.json"), "utf8"));
    handoffMarker = String(handoff.currentResult || "");
    assert.match(handoffMarker, new RegExp(`handoff-marker-${taskId}`));
    readHandoffs.push({ taskId, generation, handoff });
  }
  await options.onAccepted?.({ threadId: `${taskId}-thread-g${generation}`, turnId: `${taskId}-turn-g${generation}` });
  return {
    threadId: `${taskId}-thread-g${generation}`,
    turnId: `${taskId}-turn-g${generation}`,
    resumed: !options.forceNewThread,
    output: options.forceNewThread ? `读取交接并继续 ${taskId}: ${handoffMarker}` : `handoff-marker-${taskId}`,
    tokenUsage: { totalTokens: 950, contextWindow: 1000, percent: 0.95, updatedAt: new Date().toISOString() },
    contextCompactions: 0
  };
};

const workspace = {
  async prepare(runId) { const integrationPath = path.join(root, "integration", runId); await mkdir(integrationPath, { recursive: true }); return { snapshotCommit: "snapshot", integrationPath }; },
  async head() { return "snapshot"; },
  async createWorker(runId, taskId) { const workerPath = path.join(root, "worker", runId, taskId); await mkdir(workerPath, { recursive: true }); return workerPath; },
  async inspectChanges(workerPath = "") { return { changedFiles: [String(workerPath).includes("server") ? "server.js" : "public/app.js"], violations: [] }; },
  async runTests() { return []; },
  async commit() { return "commit"; },
  async integrate() {},
  async summarize() { return { changedFiles: ["public/app.js"], stat: "1 file changed", patchPreview: "diff" }; },
  async removeWorker() {},
  async cleanup() {},
  async accept({ changedFiles }) { return { appliedFiles: changedFiles }; }
};

try {
  const manager = createParallelCodexCoordinator({ projectRoot: root, startTurn, workspace, archiveThread: async (threadId) => { archivedThreads.push(threadId); return true; } });
  const firstPlan = await manager.plan({ objective: "验证上下文可以在长期工作中换代" });
  const firstDraft = await manager.wait(firstPlan.id);
  const firstApproved = await manager.approve(firstPlan.id, { jobs: firstDraft.jobs });
  assert.equal(firstApproved.status, "approved");
  const firstReview = await manager.wait(firstPlan.id);
  assert.equal(firstReview.status, "review", firstReview.error || "first run failed");
  await manager.reject(firstPlan.id);

  const secondPlan = await manager.plan({ objective: "继续验证同一分支并自动换代" });
  const secondDraft = await manager.wait(secondPlan.id);
  assert.ok(secondDraft.jobs.every((job) => job.contextThreadId.endsWith("-g1")));
  await manager.approve(secondPlan.id, { jobs: secondDraft.jobs });
  const secondReview = await manager.wait(secondPlan.id);
  assert.equal(secondReview.status, "review", secondReview.error || "second run failed");
  assert.ok(secondReview.jobs.every((job) => job.contextGeneration === 2));
  assert.ok(secondReview.jobs.every((job) => job.contextHistory?.some((item) => item.threadId.endsWith("-g1"))));
  assert.ok(secondReview.jobs.every((job) => job.threadId.endsWith("-g2")));
  assert.ok(calls.filter((item) => item.forceNewThread).length >= 2);
  assert.equal(readHandoffs.length, 2);
  assert.deepEqual(new Set(readHandoffs.map((item) => item.taskId)), new Set(["ui", "server"]));
  assert.deepEqual(new Set(archivedThreads), new Set(["ui-thread-g1", "server-thread-g1"]));
  const handoffs = await (await import("node:fs/promises")).readdir(path.join(root, ".task-tree-runs", "handoffs"));
  assert.equal(handoffs.length, 2);
  const index = JSON.parse(await readFile(path.join(root, ".task-tree-runs", "context-index.json"), "utf8"));
  assert.equal(Object.keys(index.contexts).length, 2);
  assert.ok(Object.values(index.contexts).every((item) => item.generation === 2 && item.archived.length === 1));
  for (const job of secondReview.jobs) {
    await assert.rejects(access(path.join(root, "worker", secondPlan.id, job.taskId, ".task-tree-context", "handoff.json")));
  }
  console.log("PASS context lifecycle rotates long branch contexts with traceable handoffs");
} finally {
  await rm(root, { recursive: true, force: true });
}
