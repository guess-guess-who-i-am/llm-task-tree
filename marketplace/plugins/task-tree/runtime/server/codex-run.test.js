import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { archiveCodexThread, isTaskTreeSystemThread, normalizeThreadTokenUsage, startCodexTurn } from "./codex-run.js";

function fakeAppServer({ requests = [], resumeCwd = "E:\\project", ignoreMethods = [], tokenUsage = null, completeOnTurn = false } = {}) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 0);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === undefined) continue;
        if (ignoreMethods.includes(request.method)) continue;
        const result = request.method === "thread/start"
          ? { thread: { id: "thread-test", cwd: "E:\\project" } }
          : request.method === "thread/fork"
            ? { thread: { id: "thread-forked", cwd: request.params.cwd, forkedFromId: request.params.threadId } }
          : request.method === "thread/resume"
            ? { thread: { id: request.params.threadId, cwd: resumeCwd } }
          : request.method === "turn/start"
            ? { turn: { id: "turn-test" } }
            : {};
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
          if (request.method === "turn/start") {
            if (tokenUsage) child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: result.thread?.id || "thread-test", tokenUsage } })}\n`);
            if (completeOnTurn) child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: result.thread?.id || "thread-test", turn: { id: "turn-test", status: "completed", items: [{ type: "agentMessage", text: "done" }] } } })}\n`);
          }
        });
      }
      done();
    }
  });
  return child;
}

test("task-tree system conversations are separated from project conversations", () => {
  assert.equal(isTaskTreeSystemThread({ name: "任务图 · 自动规划（系统）", preview: "" }), true);
  assert.equal(isTaskTreeSystemThread({ name: "", preview: "【Task Tree · Automatic Parallel Planner】" }), true);
  assert.equal(isTaskTreeSystemThread({ name: "界面讨论", preview: "讨论任务图里的节点交互" }), false);
});

test("normalizes app-server token usage", () => {
  assert.deepEqual(normalizeThreadTokenUsage({ tokenUsage: { totalTokens: 900, contextWindow: 1000 } }).percent, 0.9);
  const currentCodexShape = normalizeThreadTokenUsage({ tokenUsage: { total: { totalTokens: 17464, inputTokens: 17459, outputTokens: 5 }, modelContextWindow: 258400 } });
  assert.equal(currentCodexShape.totalTokens, 17464);
  assert.equal(currentCodexShape.contextWindow, 258400);
  assert.ok(currentCodexShape.percent > 0.067 && currentCodexShape.percent < 0.068);
});

test("reports token usage from app-server notifications", async () => {
  const usage = [];
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "measure context",
    waitForCompletion: true,
    onUsage: (value) => usage.push(value),
    spawnCodex: () => fakeAppServer({ tokenUsage: { totalTokens: 900, contextWindow: 1000 }, completeOnTurn: true })
  });
  assert.equal(result.tokenUsage.percent, 0.9);
  assert.equal(usage.at(-1).percent, 0.9);
});

test("interactive launch returns after Codex accepts the turn", async () => {
  const requests = [];
  const startedAt = performance.now();
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "test",
    spawnCodex: () => fakeAppServer({ requests })
  });
  const elapsed = performance.now() - startedAt;

  assert.equal(result.threadId, "thread-test");
  assert.equal(result.turnId, "turn-test");
  assert.ok(elapsed < 500, `launch took ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(
    requests.map((request) => request.method).slice(0, 4),
    ["initialize", "initialized", "thread/start", "turn/start"]
  );
  assert.equal(requests.find((request) => request.method === "initialized")?.id, undefined);
});

test("optional naming cannot exhaust the budget before turn start", async () => {
  const requests = [];
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "test",
    totalTimeoutMs: 100,
    spawnCodex: () => fakeAppServer({ requests, ignoreMethods: ["thread/name/set"] })
  });

  assert.equal(result.turnId, "turn-test");
  assert.ok(requests.findIndex((request) => request.method === "turn/start") >= 0);
  assert.ok(requests.findIndex((request) => request.method === "turn/start") < requests.findIndex((request) => request.method === "thread/name/set"));
});

test("matching persistent cwd resumes the requested branch context", async () => {
  const requests = [];
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "continue branch",
    threadId: "thread-existing",
    spawnCodex: () => fakeAppServer({ requests })
  });

  assert.equal(result.threadId, "thread-existing");
  assert.equal(result.resumed, true);
  assert.ok(requests.some((request) => request.method === "thread/resume" && request.params.threadId === "thread-existing"));
  assert.equal(requests.some((request) => request.method === "thread/start"), false);
  assert.equal(requests.find((request) => request.method === "turn/start")?.params.threadId, "thread-existing");
});

test("context rotation starts a successor thread instead of resuming the old one", async () => {
  const requests = [];
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "continue from handoff",
    threadId: "thread-old",
    forceNewThread: true,
    spawnCodex: () => fakeAppServer({ requests })
  });
  assert.equal(result.threadId, "thread-test");
  assert.equal(requests.some((request) => request.method === "thread/resume"), false);
  assert.equal(requests.some((request) => request.method === "thread/start"), true);
});

test("old context generations are archived without deletion", async () => {
  const requests = [];
  assert.equal(await archiveCodexThread("thread-old", { spawnCodex: () => fakeAppServer({ requests }) }), true);
  assert.ok(requests.some((request) => request.method === "thread/archive" && request.params.threadId === "thread-old"));
  assert.equal(requests.some((request) => request.method === "thread/delete"), false);
});

test("a selected project conversation is forked into the isolated worker cwd", async () => {
  const requests = [];
  const result = await startCodexTurn({
    cwd: "E:\\isolated-worker",
    prompt: "continue from selected context",
    forkThreadId: "thread-source",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    spawnCodex: () => fakeAppServer({ requests })
  });

  assert.equal(result.threadId, "thread-forked");
  assert.equal(result.forked, true);
  assert.equal(result.resumed, false);
  const fork = requests.find((request) => request.method === "thread/fork");
  assert.equal(fork.params.threadId, "thread-source");
  assert.equal(fork.params.cwd, "E:\\isolated-worker");
  assert.equal(fork.params.sandbox, "workspace-write");
  assert.equal(requests.some((request) => request.method === "thread/start" || request.method === "thread/resume"), false);
});

test("onAccepted exposes the thread before the model completes", async () => {
  const child = fakeAppServer();
  let acceptedInfo;
  let revealAccepted;
  const accepted = new Promise((resolve) => { revealAccepted = resolve; });
  let settled = false;
  const running = startCodexTurn({
    cwd: "E:\\project",
    prompt: "test",
    waitForCompletion: true,
    onAccepted: async (info) => {
      acceptedInfo = info;
      revealAccepted();
    },
    spawnCodex: () => child
  }).finally(() => { settled = true; });

  await accepted;
  assert.deepEqual(acceptedInfo, { threadId: "thread-test", turnId: "turn-test" });
  assert.equal(settled, false, "the task must be visible while the model is still running");
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: "thread-test",
      turn: { id: "turn-test", status: "completed", items: [{ type: "agentMessage", text: "done" }] }
    }
  })}\n`);
  const result = await running;
  assert.equal(result.output, "done");
});

test("completion timeout closes the app-server session", async () => {
  const child = fakeAppServer();
  await assert.rejects(
    startCodexTurn({
      cwd: "E:\\project",
      prompt: "test",
      waitForCompletion: true,
      completionTimeoutMs: 1_000,
      totalTimeoutMs: 20,
      spawnCodex: () => child
    }),
    /等待 Codex 完成 超时/
  );
  assert.equal(child.killed, true);
});
