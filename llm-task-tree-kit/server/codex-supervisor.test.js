import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createParallelCodexCoordinator } from "./codex-coordinator.js";

const SUPERVISOR_THREAD_ID = "thread-supervisor";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function initialJobs() {
  return [
    { taskId: "A", nodeId: "N1", instruction: "完成 A", writeSet: ["src/A/**"] },
    { taskId: "B", nodeId: "N2", instruction: "完成 B", writeSet: ["src/B/**"] }
  ];
}

function dynamicJob() {
  return {
    taskId: "C",
    nodeId: "N3",
    title: "整合新发现",
    summary: "整合 A 与 B 的结果，补齐本轮目标的剩余缺口",
    instruction: "根据 A 和 B 的结果完成 C",
    writeSet: ["src/C/**"],
    dependsOn: ["A", "B"],
    acceptancePrompt: "C 的分支结果可验证"
  };
}

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

function fakeWorkspace({ prepareGate, workerGates = new Map() } = {}) {
  let commitNumber = 0;
  const calls = [];
  const changedFiles = new Set();
  const taskFromCwd = (cwd) => path.basename(String(cwd).replaceAll("\\", "/"));
  return {
    calls,
    async prepare() {
      calls.push(["prepare"]);
      if (prepareGate) await prepareGate.promise;
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
      const file = `src/${taskId}/result.txt`;
      changedFiles.add(file);
      return { changedFiles: [file], violations: [] };
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
        changedFiles: [...changedFiles],
        stat: `${changedFiles.size} files changed`,
        patchPreview: "supervisor contract fixture"
      };
    },
    async accept() {
      return { appliedFiles: [...changedFiles] };
    },
    async cleanup() {},
    workerGate(taskId) {
      return workerGates.get(taskId);
    }
  };
}

function isSupervisorTurn(options) {
  return /supervisor/i.test([
    options.threadName,
    options.developerInstructions,
    options.prompt
  ].filter(Boolean).join("\n"));
}

function completedDecision() {
  return {
    action: "finish",
    summary: "本轮目标已经完成",
    reason: "已有结果满足本轮目标",
    newJobs: []
  };
}

function continueExistingDecision() {
  return {
    action: "continue",
    summary: "执行已审核的初始任务",
    reason: "初始任务尚未完成",
    newJobs: []
  };
}

async function createFixture({ supervisorPolicy = completedDecision, prepareGate, workerGates = new Map() } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-supervisor-test-"));
  await writeFile(path.join(projectRoot, "task-tree.md"), [
    "# LLM Task Graph",
    "## ROOT - root",
    "- Problem: keep the root goal",
    "- Metrics: evidence",
    "## N1 - A",
    "- Problem: solve A",
    "## N2 - B",
    "- Problem: solve B",
    "## N3 - C",
    "- Problem: solve C",
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "# Edges",
    ""
  ].join("\n"), "utf8");

  const supervisorCalls = [];
  const workerCalls = [];
  const completedTasks = new Set();
  let activeSupervisorTurns = 0;
  let maxActiveSupervisorTurns = 0;
  const workspace = fakeWorkspace({ prepareGate, workerGates });
  const startTurn = async (options) => {
    if (isSupervisorTurn(options)) {
      supervisorCalls.push(options);
      const turnNumber = supervisorCalls.length;
      const threadId = options.threadId || SUPERVISOR_THREAD_ID;
      await options.onAccepted?.({ threadId, turnId: `turn-supervisor-${turnNumber}` });
      activeSupervisorTurns += 1;
      maxActiveSupervisorTurns = Math.max(maxActiveSupervisorTurns, activeSupervisorTurns);
      try {
        const decision = await supervisorPolicy({
          options,
          turnNumber,
          completedTasks: new Set(completedTasks),
          supervisorCalls
        });
        return {
          threadId,
          turnId: `turn-supervisor-${turnNumber}`,
          output: JSON.stringify(decision)
        };
      } finally {
        activeSupervisorTurns -= 1;
      }
    }

    if (options.prompt.includes("Isolated Parallel Worker")) {
      const taskId = path.basename(String(options.cwd).replaceAll("\\", "/"));
      workerCalls.push({ taskId, options });
      const threadId = options.threadId || `thread-${taskId}`;
      await options.onAccepted?.({ threadId, turnId: `turn-${taskId}` });
      const gate = workspace.workerGate(taskId);
      if (gate) await gate.promise;
      completedTasks.add(taskId);
      return {
        threadId,
        turnId: `turn-${taskId}`,
        output: JSON.stringify({
          event: "completed",
          changedFiles: [`src/${taskId}/result.txt`],
          affectedNodes: [taskId === "A" ? "N1" : taskId === "B" ? "N2" : "N3"],
          evidence: `${taskId} completed`,
          peerRequests: []
        })
      };
    }

    assert.match(options.prompt, /Integration Coordinator/);
    return {
      threadId: "thread-coordinator",
      turnId: "turn-coordinator",
      output: JSON.stringify({
        event: "completed",
        summary: "集成完成",
        affectedNodes: ["N1", "N2", "N3"],
        evidence: "模拟集成检查通过",
        goalAssessment: {
          alignment: "aligned",
          progress: "progress",
          continuity: "baseline",
          achieved: "监督闭环完成",
          remaining: ""
        }
      })
    };
  };

  const coordinator = createParallelCodexCoordinator({
    projectRoot,
    startTurn,
    archiveThread: async () => true,
    scopeStore: fakeScopeStore(),
    workspace
  });
  return {
    coordinator,
    projectRoot,
    supervisorCalls,
    workerCalls,
    workspace,
    get maxActiveSupervisorTurns() {
      return maxActiveSupervisorTurns;
    },
    async cleanup() {
      prepareGate?.resolve();
      for (const gate of workerGates.values()) gate.resolve();
      await coordinator.drain().catch(() => {});
      await rm(projectRoot, { recursive: true, force: true });
    }
  };
}

function executionNode(run, taskId) {
  assert.ok(run.executionTree, "public run must expose executionTree");
  assert.ok(Array.isArray(run.executionTree.nodes), "executionTree.nodes must be an array");
  return run.executionTree.nodes.find((node) => node.taskId === taskId || node.id === taskId);
}

test("approval creates one long-lived Supervisor thread and reuses it", async () => {
  const fixture = await createFixture({
    supervisorPolicy: ({ completedTasks }) => completedTasks.size >= 2
      ? completedDecision()
      : continueExistingDecision()
  });
  try {
    const created = await fixture.coordinator.start(initialJobs());
    await fixture.coordinator.drain();
    const firstRun = await fixture.coordinator.get(created.id);

    assert.equal(firstRun.supervisor.threadId, SUPERVISOR_THREAD_ID);
    assert.equal(firstRun.supervisor.deepLink, `codex://threads/${SUPERVISOR_THREAD_ID}`);
    await fixture.coordinator.supervisorMessage(created.id, "复核长期上下文");
    await fixture.coordinator.drain();
    const run = await fixture.coordinator.get(created.id);

    assert.equal(run.supervisor.threadId, SUPERVISOR_THREAD_ID);
    assert.equal(run.supervisor.deepLink, `codex://threads/${SUPERVISOR_THREAD_ID}`);
    assert.ok(fixture.supervisorCalls.length >= 2, "Supervisor should receive more than one turn in the run");
    assert.equal(fixture.supervisorCalls[0].threadId || "", "", "the first turn creates the Supervisor thread");
    assert.ok(
      fixture.supervisorCalls.slice(1).every((call) => call.threadId === SUPERVISOR_THREAD_ID),
      "all later Supervisor turns must reuse the same thread"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Supervisor can append a job after workers finish and the dynamic job executes", async () => {
  let dispatched = false;
  const fixture = await createFixture({
    supervisorPolicy: ({ completedTasks }) => {
      if (completedTasks.has("A") && completedTasks.has("B") && !dispatched) {
        dispatched = true;
        return {
          action: "continue",
          summary: "需要整合 A 与 B",
          reason: "A 与 B 暴露了一个可验证的新缺口",
          newJobs: [dynamicJob()]
        };
      }
      if (completedTasks.has("C")) return completedDecision();
      return continueExistingDecision();
    }
  });
  try {
    const created = await fixture.coordinator.start(initialJobs());
    await fixture.coordinator.drain();
    const run = await fixture.coordinator.get(created.id);
    const dynamic = run.jobs.find((job) => job.taskId === "C");

    assert.equal(dynamic?.status, "completed");
    assert.ok(fixture.workspace.calls.some(([name, taskId]) => name === "createWorker" && taskId === "C"));
    assert.equal(executionNode(run, "C")?.status, "completed");
    assert.ok(
      fixture.supervisorCalls.filter((call) => call.threadId === SUPERVISOR_THREAD_ID).length >= 1,
      "the dynamic result must return to the same Supervisor context"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("user messages are queued and delivered serially to the same Supervisor thread", async () => {
  const supervisorGate = deferred();
  const fixture = await createFixture({
    supervisorPolicy: async ({ turnNumber }) => {
      if (turnNumber === 1) await supervisorGate.promise;
      return completedDecision();
    }
  });
  try {
    assert.equal(
      typeof fixture.coordinator.supervisorMessage,
      "function",
      "coordinator must expose supervisorMessage(id, message)"
    );
    const created = await fixture.coordinator.start(initialJobs());
    await waitFor(() => fixture.supervisorCalls.length >= 1, "Supervisor turn did not start");

    await Promise.all([
      fixture.coordinator.supervisorMessage(created.id, "优先验证缓存"),
      fixture.coordinator.supervisorMessage(created.id, "不要修改主任务树")
    ]);
    supervisorGate.resolve();
    await waitFor(
      () => fixture.supervisorCalls.some((call) => call.prompt.includes("优先验证缓存") && call.prompt.includes("不要修改主任务树")),
      "queued user messages were not delivered"
    );
    await fixture.coordinator.drain();
    const messageCalls = fixture.supervisorCalls.filter((call) => call.prompt.includes("优先验证缓存") || call.prompt.includes("不要修改主任务树"));
    assert.ok(messageCalls.every((call) => call.threadId === SUPERVISOR_THREAD_ID));
    assert.equal(fixture.maxActiveSupervisorTurns, 1, "turns in one Supervisor thread must be serialized");

    const run = await fixture.coordinator.get(created.id);
    assert.deepEqual(
      run.supervisor.messages.map((message) => message.text),
      ["优先验证缓存", "不要修改主任务树"]
    );
    assert.ok(run.supervisor.messages.every((message) => message.status === "delivered"));
  } finally {
    await fixture.cleanup();
  }
});

test("pause stops automatic dispatch and resume continues the same supervised run", async () => {
  const workerGates = new Map([["A", deferred()], ["B", deferred()]]);
  let dispatched = false;
  const fixture = await createFixture({
    workerGates,
    supervisorPolicy: ({ completedTasks }) => {
      if (completedTasks.has("A") && completedTasks.has("B") && !dispatched) {
        dispatched = true;
        return {
          action: "continue",
          summary: "继续执行 C",
          reason: "C 是收束前的剩余缺口",
          newJobs: [dynamicJob()]
        };
      }
      if (completedTasks.has("C")) return completedDecision();
      return continueExistingDecision();
    }
  });
  try {
    assert.equal(typeof fixture.coordinator.pause, "function", "coordinator must expose pause(id)");
    assert.equal(typeof fixture.coordinator.resume, "function", "coordinator must expose resume(id)");
    const created = await fixture.coordinator.start(initialJobs());
    await waitFor(() => fixture.workerCalls.length === 2, "initial workers did not start");
    await fixture.coordinator.pause(created.id);
    for (const gate of workerGates.values()) gate.resolve();
    await waitFor(async () => {
      const run = await fixture.coordinator.get(created.id);
      return run.jobs.filter((job) => ["A", "B"].includes(job.taskId)).every((job) => job.status === "completed");
    }, "active workers did not finish while paused");

    const paused = await fixture.coordinator.get(created.id);
    assert.equal(paused.supervisor.status, "paused");
    assert.ok(!fixture.workspace.calls.some(([name, taskId]) => name === "createWorker" && taskId === "C"));

    await fixture.coordinator.resume(created.id);
    await fixture.coordinator.drain();
    const resumed = await fixture.coordinator.get(created.id);
    assert.equal(resumed.jobs.find((job) => job.taskId === "C")?.status, "completed");
    assert.ok(fixture.workspace.calls.some(([name, taskId]) => name === "createWorker" && taskId === "C"));
    assert.ok(resumed.events.some((event) => event.type === "supervisor_paused"));
    assert.ok(resumed.events.some((event) => event.type === "supervisor_resumed"));
  } finally {
    await fixture.cleanup();
  }
});

test("public execution tree exposes planned, running, and completed node states", async () => {
  const prepareGate = deferred();
  const workerGates = new Map([["A", deferred()], ["B", deferred()]]);
  const fixture = await createFixture({
    prepareGate,
    workerGates,
    supervisorPolicy: ({ completedTasks }) => completedTasks.size >= 2
      ? completedDecision()
      : continueExistingDecision()
  });
  try {
    const created = await fixture.coordinator.start(initialJobs());
    const planned = await fixture.coordinator.get(created.id);
    assert.equal(executionNode(planned, "A")?.status, "planned");
    assert.equal(executionNode(planned, "B")?.status, "planned");

    prepareGate.resolve();
    await waitFor(() => fixture.workerCalls.length === 2, "workers did not reach running state");
    const running = await fixture.coordinator.get(created.id);
    assert.equal(executionNode(running, "A")?.status, "running");
    assert.equal(executionNode(running, "B")?.status, "running");

    for (const gate of workerGates.values()) gate.resolve();
    await fixture.coordinator.drain();
    const completed = await fixture.coordinator.get(created.id);
    assert.equal(executionNode(completed, "A")?.status, "completed");
    assert.equal(executionNode(completed, "B")?.status, "completed");
  } finally {
    await fixture.cleanup();
  }
});
