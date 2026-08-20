import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createParallelCodexCoordinator } from "./codex-coordinator.js";

function fakeScopeStore() {
  let sequence = 0;
  return {
    async create(input) {
      return { ...input, scopeId: `scope-${++sequence}`, status: "active" };
    },
    async close(scopeId) {
      return { scopeId, status: "closed" };
    }
  };
}

function fakeWorkspace() {
  let commitNumber = 0;
  const calls = [];
  const taskFromCwd = (cwd) => String(cwd).split("/").at(-1);
  return {
    calls,
    async prepare() {
      return { integrationPath: "integration", snapshotCommit: "snapshot" };
    },
    async head() {
      return "integration-head";
    },
    async createWorker(_runId, taskId) {
      calls.push(["createWorker", taskId]);
      return `worker/${taskId}`;
    },
    async inspectChanges(cwd) {
      const taskId = taskFromCwd(cwd);
      return { changedFiles: [`src/${taskId}/result.txt`], violations: [] };
    },
    async runTests() {
      return [];
    },
    async commit(cwd) {
      return `${cwd}-commit-${++commitNumber}`;
    },
    async integrate() {},
    async removeWorker() {},
    async summarize() {
      return {
        changedFiles: ["src/A/result.txt", "src/B/result.txt"],
        stat: "2 files changed",
        patchPreview: "peer collaboration patch"
      };
    },
    async accept() {
      return { appliedFiles: ["src/A/result.txt", "src/B/result.txt"] };
    },
    async cleanup() {}
  };
}

test("parallel workers can relay one peer question and continue the source context", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-peer-test-"));
  await writeFile(path.join(projectRoot, "task-tree.md"), [
    "# LLM Task Graph",
    "## ROOT - root",
    "- Problem: keep the root goal",
    "- Metrics: evidence",
    "## N1 - A",
    "- Problem: solve A",
    "## N2 - B",
    "- Problem: solve B",
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "# Edges",
    ""
  ].join("\n"), "utf8");
  const calls = [];
  const startTurn = async (options) => {
    calls.push(options.prompt);
    const threadId = options.threadId || (options.cwd.endsWith("A") ? "thread-A" : "thread-B");
    if (options.prompt.includes("Isolated Parallel Worker") && options.cwd.endsWith("A")) {
      const output = JSON.stringify({
        event: "completed",
        changedFiles: ["src/A/result.txt"],
        affectedNodes: ["N1"],
        evidence: "A initial",
        peerRequests: [{ toTaskId: "B", question: "B 的接口返回值是什么？", why: "需要完成 A 的适配" }]
      });
      await options.onAccepted?.({ threadId: "thread-A", turnId: "turn-A-1" });
      return { threadId, turnId: "turn-A-1", output };
    }
    if (options.prompt.includes("Isolated Parallel Worker")) {
      await options.onAccepted?.({ threadId: "thread-B", turnId: "turn-B-1" });
      return {
        threadId,
        turnId: "turn-B-1",
        output: JSON.stringify({ event: "completed", changedFiles: ["src/B/result.txt"], evidence: "B initial", peerRequests: [] })
      };
    }
    if (options.prompt.includes("Peer consultation")) {
      return {
        threadId: "thread-B",
        turnId: "turn-B-peer",
        output: JSON.stringify({
          conclusion: "接口返回 { ok: true }。",
          evidenceRefs: ["src/B/result.txt"],
          unknowns: []
        })
      };
    }
    if (options.prompt.includes("Peer answer received")) {
      return {
        threadId: "thread-A",
        turnId: "turn-A-2",
        output: JSON.stringify({ event: "completed", changedFiles: ["src/A/peer.txt"], evidence: "已采用 B 的回答", peerRequests: [] })
      };
    }
    if (options.prompt.includes("Continuous Supervisor")) {
      await options.onAccepted?.({ threadId: options.threadId || "thread-supervisor", turnId: "turn-supervisor" });
      return {
        threadId: options.threadId || "thread-supervisor",
        turnId: "turn-supervisor",
        resumed: Boolean(options.threadId),
        output: JSON.stringify({ action: "finish", summary: "已具备汇总条件", reason: "两个分支均有证据", newJobs: [] })
      };
    }
    if (options.prompt.includes("Supervisor Final Review")) {
      return {
        threadId: options.threadId || "thread-supervisor",
        turnId: "turn-supervisor-final",
        resumed: true,
        output: JSON.stringify({
          event: "completed",
          summary: "两个分支已完成并完成一次受控协作",
          affectedNodes: ["N1", "N2"],
          evidence: "模拟集成检查通过",
          goalAssessment: { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "协作闭环存在", remaining: "真实模型仍需验证" }
        })
      };
    }
    assert.match(options.prompt, /Integration Coordinator/);
    return {
      threadId: "thread-coordinator",
      turnId: "turn-coordinator",
      output: JSON.stringify({
        event: "completed",
        summary: "两个分支已完成并完成一次受控协作",
        affectedNodes: ["N1", "N2"],
        evidence: "模拟集成检查通过",
        goalAssessment: { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "协作闭环存在", remaining: "真实模型仍需验证" }
      })
    };
  };

  try {
    const coordinator = createParallelCodexCoordinator({
      projectRoot,
      startTurn,
      archiveThread: async () => true,
      scopeStore: fakeScopeStore(),
      workspace: fakeWorkspace()
    });
    const created = await coordinator.start([
      { taskId: "A", nodeId: "N1", instruction: "完成 A", writeSet: ["src/A/**"] },
      { taskId: "B", nodeId: "N2", instruction: "完成 B", writeSet: ["src/B/**"] }
    ]);
    await coordinator.drain();
    const run = await coordinator.get(created.id);

    assert.equal(run.status, "review");
    assert.equal(run.peerMessages.length, 1);
    assert.equal(run.peerMessages[0].status, "answered");
    assert.equal(run.peerMessages[0].fromThreadId, "thread-A");
    assert.equal(run.peerMessages[0].toThreadId, "thread-B");
    assert.deepEqual(run.peerMessages[0].evidenceRefs, ["src/B/result.txt"]);
    assert.deepEqual(run.peerMessages[0].unknowns, []);
    assert.equal(run.peerMessages[0].fromDeepLink, "codex://threads/thread-A");
    assert.equal(run.peerMessages[0].toDeepLink, "codex://threads/thread-B");
    assert.equal(run.supervisor.status, "completed");
    assert.equal(run.supervisor.threadId, "thread-supervisor");
    assert.equal(run.executionTree.nodes.filter((node) => node.status === "completed").length, 2);
    assert.ok(calls.some((prompt) => prompt.includes("Peer consultation")));
    assert.ok(calls.some((prompt) => prompt.includes("Peer answer received")));
    assert.ok(calls.some((prompt) => prompt.includes("Continuous Supervisor")));
    assert.ok(calls.some((prompt) => prompt.includes("Supervisor Final Review")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
