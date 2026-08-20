import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCodexRolloutSnapshot, createMainContextLifecycle, MAIN_CONTEXT_STATE_PATH } from "./main-context-lifecycle.js";

const lowUsage = { totalTokens: 690, contextWindow: 1000, percent: 0.69 };
const softUsage = { totalTokens: 700, contextWindow: 1000, percent: 0.70 };
const highUsage = { totalTokens: 900, contextWindow: 1000, percent: 0.90 };

async function fixture({ rotate = async () => ({ threadId: "thread-next" }), pinned = "thread-old" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-tree-main-context-"));
  let currentPin = pinned;
  const lifecycle = createMainContextLifecycle({
    projectRoot: root,
    rotateContext: rotate,
    readPinnedThread: () => currentPin,
    now: () => "2026-08-20T00:00:00.000Z"
  });
  return {
    root,
    lifecycle,
    setPin(value) { currentPin = value; },
    async cleanup() { await rm(root, { recursive: true, force: true }); }
  };
}

test("70% only marks context near its limit and does not rotate", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-1" });
    await f.lifecycle.observeUsage({ threadId: "thread-old", tokenUsage: lowUsage });
    assert.equal((await f.lifecycle.status()).status, "active");
    await f.lifecycle.observeUsage({ threadId: "thread-old", tokenUsage: softUsage });
    const completed = await f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: softUsage });
    assert.equal(completed.rotated, false);
    assert.equal(completed.state.status, "near_limit");
  } finally {
    await f.cleanup();
  }
});

test("90% automatically rotates after the current turn and persists the successor", async () => {
  let calls = 0;
  const f = await fixture({
    rotate: async ({ sourceThreadId, reason, automatic }) => {
      calls += 1;
      assert.deepEqual({ sourceThreadId, reason, automatic }, {
        sourceThreadId: "thread-old",
        reason: "context_threshold",
        automatic: true
      });
      return { threadId: "thread-next", checkpointMode: "compiled" };
    }
  });
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-1" });
    await f.lifecycle.observeUsage({ threadId: "thread-old", tokenUsage: highUsage });
    const completed = await f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: highUsage });
    assert.equal(completed.rotated, true);
    assert.equal(calls, 1);
    assert.equal(completed.state.threadId, "thread-next");
    assert.equal(completed.state.generation, 2);
    assert.equal(completed.state.lastRotation.reason, "context_threshold");
    const saved = JSON.parse(await readFile(path.join(f.root, MAIN_CONTEXT_STATE_PATH), "utf8"));
    assert.equal(saved.threadId, "thread-next");
  } finally {
    await f.cleanup();
  }
});

test("a Codex context compaction triggers rotation even below 90%", async () => {
  let reason = "";
  const f = await fixture({ rotate: async (request) => {
    reason = request.reason;
    return { threadId: "thread-after-compaction" };
  } });
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-compact" });
    await f.lifecycle.observeUsage({ threadId: "thread-old", tokenUsage: lowUsage });
    await f.lifecycle.observeCompaction({ threadId: "thread-old", turnId: "turn-compact" });
    const completed = await f.lifecycle.completeTurn({
      threadId: "thread-old",
      turnId: "turn-compact",
      tokenUsage: lowUsage,
      contextCompactions: 1
    });
    assert.equal(completed.rotated, true);
    assert.equal(reason, "context_compaction");
    assert.equal(completed.state.contextCompactions, 0);
  } finally {
    await f.cleanup();
  }
});

test("concurrent completion signals create only one successor", async () => {
  let calls = 0;
  let release;
  let revealStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { revealStarted = resolve; });
  const f = await fixture({ rotate: async () => {
    calls += 1;
    revealStarted();
    await gate;
    return { threadId: "thread-only-successor" };
  } });
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-1" });
    await f.lifecycle.observeUsage({ threadId: "thread-old", tokenUsage: highUsage });
    const first = f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: highUsage });
    const second = f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: highUsage });
    await started;
    assert.equal(calls, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results.filter((value) => value.rotated).length, 1);
    assert.equal((await f.lifecycle.status()).threadId, "thread-only-successor");
  } finally {
    await f.cleanup();
  }
});

test("failed automatic rotation keeps the old thread and is not retried in the same generation", async () => {
  let calls = 0;
  const f = await fixture({ rotate: async () => {
    calls += 1;
    throw new Error("summary upstream unavailable");
  } });
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-1" });
    const first = await f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: highUsage });
    assert.equal(first.rotated, false);
    assert.equal(first.state.threadId, "thread-old");
    assert.equal(first.state.status, "rotation_failed");
    assert.match(first.state.warning, /仍继续使用旧会话/);
    const second = await f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-2", tokenUsage: highUsage });
    assert.equal(second.rotated, false);
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});

test("automatic rotation does not override a conversation selected during compilation", async () => {
  let calls = 0;
  const f = await fixture({ rotate: async () => {
    calls += 1;
    return { threadId: "thread-next" };
  } });
  try {
    await f.lifecycle.observeAccepted({ threadId: "thread-old", turnId: "turn-1" });
    f.setPin("thread-user-selected");
    const completed = await f.lifecycle.completeTurn({ threadId: "thread-old", turnId: "turn-1", tokenUsage: highUsage });
    assert.equal(completed.rotated, false);
    assert.equal(calls, 0);
    assert.equal(completed.state.threadId, "thread-old");
    assert.match(completed.state.warning, /用户已切换会话/);
  } finally {
    await f.cleanup();
  }
});

test("a completed turn typed directly in Codex rotates from its rollout snapshot without a UI action", async () => {
  let calls = 0;
  const f = await fixture({ rotate: async () => {
    calls += 1;
    return { threadId: "thread-direct-successor" };
  } });
  try {
    const result = await applyCodexRolloutSnapshot({
      lifecycle: f.lifecycle,
      threadId: "thread-old",
      snapshot: {
        tokenUsage: highUsage,
        latestTaskStartedAt: "2026-08-20T00:00:00.000Z",
        latestTaskCompletedAt: "2026-08-20T00:00:10.000Z",
        latestCompactionAt: "",
        turnComplete: true
      }
    });
    assert.equal(result.rotated, true);
    assert.equal(calls, 1);
    assert.equal(result.state.threadId, "thread-direct-successor");
  } finally {
    await f.cleanup();
  }
});
