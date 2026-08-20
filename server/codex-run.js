/**
 * Starts a Codex conversation from the task graph UI, so a click is enough to get the interactive
 * graph into the desktop app.
 *
 * The `codex://threads/new?prompt=` deeplink only prefills the composer — the app's route handler
 * does `navigate("/", { focusComposerNonce, prefillPrompt })` and nothing in the bundle can submit
 * it, so that path always ends with the user pressing Enter. The app-server protocol has no such
 * limit: `thread/start` + `turn/start` run a turn outright, and the thread lands in the same store
 * the desktop app lists, so `codex://threads/<id>` opens the running conversation.
 *
 * A turn is also the only way to get the widget rendered. Host-driven calls cannot produce the
 * `mcpToolCall` item that carries `ui://task-tree/graph.html`: `mcpServer/tool/call` returns the
 * result to the caller without touching the transcript, and `thread/inject_items` only writes the
 * model-visible history (`thread/read` still reports zero items). One model turn is the floor.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_GRAPH_PROMPT } from "./codex-prompts.js";

export { OPEN_GRAPH_PROMPT };

/** Shown in the desktop app's thread list, so the pinned conversation is findable without the id. */
export const PINNED_THREAD_NAME = "任务图工作台";

const PIN_FILE = ".task-tree-thread";

/**
 * This build routes every MCP tool through the code-mode `exec` host, which rebuilds results as
 * text and images: 7119 exec calls against 0 direct calls across the newest 60 rollouts. The switch
 * for it, `tool_search_always_defer_mcp_tools`, is a removed-stage feature pinned to its default,
 * so setting it false in config.toml changes nothing (verified). A turn started here therefore gets
 * the tool's text, never the `McpToolCall` event that carries `mcp_app_resource_uri`.
 */

/** Long enough for a slow first model response; the child is killed either way so nothing leaks. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** Failing to even accept the turn should surface fast instead of hanging the button. */
const ACCEPT_TIMEOUT_MS = 60 * 1000;

/**
 * App-server versions have used slightly different names for the usage payload. Keep the
 * normalization here so callers never need to depend on a wire-format detail.
 */
export function normalizeThreadTokenUsage(params = {}) {
  const raw = params?.tokenUsage || params?.usage || params?.token_usage || params || {};
  const totals = raw?.total && typeof raw.total === "object" ? raw.total : raw;
  const pick = (...keys) => keys.map((key) => totals?.[key] ?? raw?.[key]).find((value) => Number.isFinite(Number(value)));
  const inputTokens = Number(pick("inputTokens", "input_tokens", "promptTokens", "prompt_tokens")) || 0;
  const outputTokens = Number(pick("outputTokens", "output_tokens", "completionTokens", "completion_tokens")) || 0;
  const cachedInputTokens = Number(pick("cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens")) || 0;
  const totalTokens = Number(pick("totalTokens", "total_tokens", "tokens")) || inputTokens + outputTokens;
  const contextWindow = Number(pick("modelContextWindow", "model_context_window", "contextWindow", "context_window", "maxContextTokens", "max_context_tokens")) || 0;
  const explicitPercent = Number(pick("usedPercent", "used_percent", "usagePercent", "usage_percent", "percent"));
  const percent = Number.isFinite(explicitPercent)
    ? (explicitPercent > 1 ? explicitPercent / 100 : explicitPercent)
    : (contextWindow > 0 ? totalTokens / contextWindow : null);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    contextWindow,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : null,
    updatedAt: new Date().toISOString()
  };
}

function newestCodexInBinDir(binDir) {
  if (!existsSync(binDir)) return "";
  const candidates = readdirSync(binDir)
    .map((entry) => path.join(binDir, entry, process.platform === "win32" ? "codex.exe" : "codex"))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ candidate, mtime: statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.candidate || "";
}

export function findCodexBinary() {
  const explicit = process.env.TASK_TREE_CODEX;
  if (explicit && existsSync(explicit)) return explicit;

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const managed = newestCodexInBinDir(path.join(local, "OpenAI", "Codex", "bin"));
      if (managed) return managed;
    }
  } else {
    const home = process.env.HOME;
    if (home) {
      const managed = newestCodexInBinDir(path.join(home, ".local", "share", "OpenAI", "Codex", "bin"));
      if (managed) return managed;
    }
  }

  // Falls back to PATH; spawn reports a clear ENOENT if Codex is not installed at all.
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export const spawnAppServer = (environment = {}) => spawn(findCodexBinary(), ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...environment }
});

class AppServerSession {
  constructor(child, { trustedServer = "task_tree" } = {}) {
    this.child = child;
    this.trustedServer = trustedServer;
    this.nextId = 1;
    this.pending = new Map();
    this.notify = () => {};
    this.stderr = "";
    this.buffer = "";

    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.on("exit", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`codex app-server 退出了：${this.stderr.slice(-300) || "没有错误输出"}`));
      }
      this.pending.clear();
    });
  }

  #consume(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }

      // A server->client request carries both a method and an id, and the turn blocks until it is
      // answered. Leaving these unanswered is what used to hang every tool call forever.
      if (message.method && message.id !== undefined) {
        this.#answer(message);
        continue;
      }

      if (message.method) {
        this.notify(message);
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }

  /**
   * Approves the task graph's own tools and refuses everything else. The launch only needs one tool
   * on one server, so a blanket yes would hand a click more authority than it asked for.
   */
  #answer(message) {
    const respond = (result) => this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);

    if (message.method === "mcpServer/elicitation/request") {
      const mine = message.params?.serverName === this.trustedServer;
      respond({ action: mine ? "accept" : "decline", content: mine ? {} : null });
      return;
    }

    // Approval shapes differ per request, but every one of them takes a decision string.
    respond({ decision: "denied" });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  sendNotification(method, params) {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    })}\n`);
  }

  close() {
    this.child.kill();
  }
}

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Which conversation this project's button talks to. Kept in the project rather than in the app so
 * that two projects open from the same desktop app do not fight over one thread.
 */
export function readPinnedThread(projectRoot) {
  try {
    const id = readFileSync(path.join(projectRoot, PIN_FILE), "utf8").replace(/^\uFEFF/, "").trim();
    // Codex hands out UUIDs today, but pinning to that exact shape would silently stop reusing the
    // thread if the format ever changed. This only has to reject junk; an id Codex no longer knows
    // fails the resume and falls back to a new thread anyway.
    return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

export function writePinnedThread(projectRoot, threadId) {
  writeFileSync(path.join(projectRoot, PIN_FILE), `${threadId}\n`, "utf8");
}

/** Runs one short request/response exchange and always reaps the child. */
export async function withSession(spawnCodex, run) {
  const session = new AppServerSession(spawnCodex());
  try {
    await withTimeout(
      session.request("initialize", { clientInfo: { name: "task-tree-ui", title: "任务图", version: "1.0.0" } }),
      ACCEPT_TIMEOUT_MS,
      "连接 codex app-server"
    );
    session.sendNotification("initialized");
    return await run(session);
  } finally {
    session.close();
  }
}

/**
 * The conversations this project can be sent to. Codex stores every thread with the cwd it was
 * started in, so filtering on that keeps another project's history out of the picker.
 */
export async function listProjectThreads({ cwd, limit = 12, spawnCodex = spawnAppServer, maxPages = 6, pageSize = 60 } = {}) {
  const mine = path.resolve(cwd).toLowerCase();

  // `thread/list` is machine-wide and ordered by recency, so one page is whatever the busiest
  // projects did lately. A project that has been quiet for a few days falls off the end of it, and
  // its picker would claim it has no conversations at all. Keep paging until this project's are in.
  return withSession(spawnCodex, async (session) => {
    const found = [];
    let cursor = null;

    for (let page = 0; page < maxPages && found.length < limit; page += 1) {
      const listed = await withTimeout(
        session.request("thread/list", cursor ? { limit: pageSize, cursor } : { limit: pageSize }),
        ACCEPT_TIMEOUT_MS,
        "读取会话列表"
      );

      for (const thread of listed?.data || []) {
        if (!thread?.id || thread.ephemeral) continue;
        if (!thread.cwd || path.resolve(thread.cwd).toLowerCase() !== mine) continue;
        found.push({
          id: thread.id,
          name: thread.name || "",
          // Collapsed: a preview carrying newlines turns one menu row into a paragraph.
          preview: String(thread.preview || "").replace(/\s+/g, " ").trim().slice(0, 80),
          updatedAt: thread.updatedAt || thread.recencyAt || thread.createdAt || 0
        });
      }

      cursor = listed?.nextCursor || null;
      if (!cursor) break;
    }

    return found.slice(0, limit);
  });
}

/**
 * Runs one turn and resolves as soon as Codex accepts it, so the caller can jump to the thread
 * while the model is still working. The child stays alive until the turn ends, because killing the
 * app-server would abort the turn it is running.
 *
 * @returns {Promise<{threadId: string, turnId: string|null, resumed: boolean}>}
 */
export async function startCodexTurn({
  prompt = OPEN_GRAPH_PROMPT,
  cwd,
  threadId: wanted = "",
  forkThreadId = "",
  threadName = PINNED_THREAD_NAME,
  model = null,
  sandbox = null,
  approvalPolicy = null,
  config = null,
  developerInstructions = null,
  environment = null,
  waitForCompletion = false,
  completionTimeoutMs = TURN_TIMEOUT_MS,
  totalTimeoutMs = null,
  forceNewThread = false,
  onUsage = null,
  onContextCompaction = null,
  onNotification = null,
  onAccepted = null,
  onCompleted = null,
  spawnCodex = spawnAppServer
} = {}) {
  const session = new AppServerSession(spawnCodex(environment || {}));
  const startedAt = Date.now();
  const waitFor = (promise, timeoutMs, label) => {
    const remaining = Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0
      ? Math.max(1, totalTimeoutMs - (Date.now() - startedAt))
      : timeoutMs;
    return withTimeout(promise, Math.min(timeoutMs, remaining), label);
  };

  try {
    await waitFor(
      session.request("initialize", { clientInfo: { name: "task-tree-ui", title: "任务图", version: "1.0.0" } }),
      ACCEPT_TIMEOUT_MS,
      "连接 codex app-server"
    );
    session.sendNotification("initialized");

    // Resuming loads the conversation's history, so the turn lands in the thread the user is
    // already working in instead of starting a stranger. A thread that was archived or deleted
    // outside the UI should not turn a click into an error, so that case falls through to a new one.
    let resumed = false;
    let forked = false;
    let started = null;
    if (!forceNewThread && forkThreadId) {
      started = await waitFor(
        session.request("thread/fork", {
          threadId: forkThreadId,
          cwd,
          ...(sandbox ? { sandbox } : {}),
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(config ? { config } : {}),
          ...(model ? { model } : {}),
          ...(developerInstructions ? { developerInstructions } : {})
        }),
        ACCEPT_TIMEOUT_MS,
        "复制已有对话"
      );
      forked = Boolean(started?.thread?.id || started?.threadId);
      if (!forked) throw new Error("Codex 没有返回复制后的对话 id");
    }
    if (!forceNewThread && !started && wanted) {
      try {
        started = await waitFor(session.request("thread/resume", { threadId: wanted }), ACCEPT_TIMEOUT_MS, "恢复会话");
        // A conversation belongs to the directory it was started in, and resuming one from another
        // project would quietly file this project's work under someone else's history. A stale pin
        // is not worth that, so it is dropped and a fresh conversation takes over.
        const home = started?.thread?.cwd;
        if (home && cwd && path.resolve(home).toLowerCase() !== path.resolve(cwd).toLowerCase()) started = null;
        resumed = Boolean(started?.thread?.id);
      } catch {
        started = null;
      }
    }

    if (!started) {
      started = await waitFor(
        session.request("thread/start", {
          cwd,
          ...(sandbox ? { sandbox } : {}),
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(config ? { config } : {}),
          ...(model ? { model } : {}),
          ...(developerInstructions ? { developerInstructions } : {})
        }),
        ACCEPT_TIMEOUT_MS,
        "新建会话"
      );
    }

    const threadId = started?.thread?.id || started?.threadId;
    if (!threadId) throw new Error("codex 没有返回会话 id");

    let failure = "";
    let lastTokenUsage = null;
    let contextCompactions = 0;
    let acceptedTurnId = "";
    let completionDelivered = false;
    let finish = () => {};
    const completed = new Promise((resolve) => { finish = resolve; });
    const deliverCompletion = async (turn) => {
      if (completionDelivered || typeof onCompleted !== "function") return;
      completionDelivered = true;
      await onCompleted({
        threadId,
        turnId: turn?.id || acceptedTurnId || null,
        status: turn?.status || (turn?.error || failure ? "failed" : "completed"),
        error: turn?.error || (failure ? { message: failure } : null),
        tokenUsage: lastTokenUsage,
        contextCompactions
      });
    };

    session.notify = (message) => {
      const params = message.params || {};
      if (params.threadId && params.threadId !== threadId) return;
      Promise.resolve(onNotification?.(message)).catch(() => {});

      if (message.method === "thread/tokenUsage/updated") {
        lastTokenUsage = normalizeThreadTokenUsage(params);
        Promise.resolve(onUsage?.(lastTokenUsage, { threadId, turnId: acceptedTurnId || null })).catch(() => {});
      }
      if (message.method === "item/completed" && params.item?.type === "contextCompaction") {
        contextCompactions += 1;
        Promise.resolve(onContextCompaction?.({ threadId, turnId: acceptedTurnId || null, item: params.item })).catch(() => {});
      }

      // A retrying error is Codex narrating a hiccup ("Reconnecting... 1/5"), not a dead turn.
      if (message.method === "error" && params.willRetry !== true) {
        failure = params.error?.message || "模型这一轮失败了";
      }
      if (message.method === "turn/completed" || message.method === "turn/failed") {
        finish(params.turn || {
          id: params.turnId || null,
          status: message.method === "turn/failed" ? "failed" : "completed",
          items: [],
          error: params.error || null
        });
        if (!waitForCompletion) {
          const turn = params.turn || {
            id: params.turnId || acceptedTurnId || null,
            status: message.method === "turn/failed" ? "failed" : "completed",
            error: params.error || null
          };
          session.request("thread/unsubscribe", { threadId }).catch(() => {}).finally(() => {
            session.close();
            Promise.resolve(deliverCompletion(turn)).catch(() => {});
          });
        }
      }
    };

    const accepted = await waitFor(
      session.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }),
      ACCEPT_TIMEOUT_MS,
      "发起对话"
    );
    acceptedTurnId = accepted?.turn?.id || "";
    // Naming is cosmetic. Start the real work first so an unsupported or slow naming request
    // cannot consume a planner's entire total timeout before turn/start is even sent.
    if (!resumed) {
      session.request("thread/name/set", { threadId, name: threadName }).catch(() => {});
    }
    if (typeof onAccepted === "function") {
      await onAccepted({ threadId, turnId: accepted?.turn?.id || null });
    }

    if (waitForCompletion) {
      const turn = await waitFor(completed, completionTimeoutMs, "等待 Codex 完成");
      const messages = (turn?.items || [])
        .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
        .map((item) => item.text.trim())
        .filter(Boolean);
      const output = messages.at(-1) || "";
      await withTimeout(
        session.request("thread/unsubscribe", { threadId }),
        ACCEPT_TIMEOUT_MS,
        "释放 Codex 会话写入租约"
      ).catch(() => {});
      session.close();
      await deliverCompletion(turn).catch(() => {});
      if (turn?.status === "failed" || turn?.error || failure) {
        const error = new Error(turn?.error?.message || failure || "模型这一轮失败了");
        error.threadId = threadId;
        error.turnId = turn?.id || accepted?.turn?.id || null;
        throw error;
      }
      return {
        threadId,
        turnId: turn?.id || accepted?.turn?.id || null,
        resumed,
        forked,
        status: turn?.status || "completed",
        output
        ,tokenUsage: lastTokenUsage
        ,contextCompactions
      };
    }

    // Nothing awaits the rest of the turn; this only guarantees the child is reaped.
    setTimeout(() => session.close(), TURN_TIMEOUT_MS).unref?.();

    return { threadId, turnId: accepted?.turn?.id || null, resumed, forked, tokenUsage: lastTokenUsage, contextCompactions };
  } catch (error) {
    session.close();
    throw error;
  }
}

export function threadDeepLink(threadId) {
  return `codex://threads/${threadId}`;
}

/** Reads the real model-visible turns so context rotation can preserve recent user corrections. */
export async function readCodexThread(threadId, { spawnCodex = spawnAppServer } = {}) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("threadId is required");
  return withSession(spawnCodex, async (session) => {
    const result = await withTimeout(
      session.request("thread/read", { threadId: id, includeTurns: true }),
      ACCEPT_TIMEOUT_MS,
      "读取 Codex 会话"
    );
    if (!result?.thread?.id) throw new Error("Codex 没有返回会话内容");
    return result.thread;
  });
}

/** Resolves the local rollout file without requesting model-visible turns. */
export async function readCodexThreadRolloutPath(threadId, { spawnCodex = spawnAppServer } = {}) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("threadId is required");
  return withSession(spawnCodex, async (session) => {
    const result = await withTimeout(
      session.request("thread/read", { threadId: id, includeTurns: false }),
      ACCEPT_TIMEOUT_MS,
      "读取 Codex 会话位置"
    );
    const rolloutPath = String(result?.thread?.path || "").trim();
    if (!rolloutPath) throw new Error("Codex 没有返回会话记录位置");
    return rolloutPath;
  });
}

/**
 * Reads only lifecycle events from the tail of a Codex rollout. This observes turns typed directly
 * in the desktop app without loading their message text or taking a writer lease on the thread.
 */
export async function readCodexRolloutContextSnapshot(filePath, { maxBytes = 512 * 1024 } = {}) {
  const target = String(filePath || "").trim();
  if (!target) throw new Error("rollout path is required");
  const handle = await openFile(target, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, Math.max(16 * 1024, Number(maxBytes) || 0));
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    let tokenUsage = null;
    let latestTaskStartedAt = "";
    let latestTaskCompletedAt = "";
    let latestCompactionAt = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "event_msg") continue;
      const type = entry.payload?.type;
      const timestamp = String(entry.timestamp || "");
      if (type === "task_started") latestTaskStartedAt = timestamp;
      if (type === "task_complete") latestTaskCompletedAt = timestamp;
      if (type === "context_compacted") latestCompactionAt = timestamp;
      if (type === "token_count") {
        const usage = entry.payload?.info?.last_token_usage || entry.payload?.info?.total_token_usage || {};
        tokenUsage = normalizeThreadTokenUsage({
          tokenUsage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedInputTokens: usage.cached_input_tokens,
            totalTokens: usage.total_tokens,
            modelContextWindow: entry.payload?.info?.model_context_window
          }
        });
        tokenUsage.updatedAt = timestamp || tokenUsage.updatedAt;
      }
    }
    return {
      filePath: target,
      tokenUsage,
      latestTaskStartedAt,
      latestTaskCompletedAt,
      latestCompactionAt,
      turnComplete: Boolean(latestTaskCompletedAt && (!latestTaskStartedAt || latestTaskCompletedAt >= latestTaskStartedAt))
    };
  } finally {
    await handle.close();
  }
}

/** Archive a completed context generation without deleting its history. */
export async function archiveCodexThread(threadId, { spawnCodex = spawnAppServer } = {}) {
  const id = String(threadId || "").trim();
  if (!id) return false;
  let lastError;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      await withSession(spawnCodex, async (session) => {
        await withTimeout(session.request("thread/archive", { threadId: id }), ACCEPT_TIMEOUT_MS, "归档 Codex 上下文");
      });
      return true;
    } catch (error) {
      lastError = error;
      if (!/active writer/i.test(String(error?.message || "")) || attempt === 6) throw error;
      // Codex can report turn completion before its writer lease is released. The lease normally
      // clears within a few seconds; bounded backoff avoids deleting history or failing rotation.
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * (attempt + 1), 2000)));
    }
  }
  throw lastError;
}

export function isTaskTreeSystemThread(thread) {
  const text = `${thread?.name || ""} ${thread?.preview || ""}`;
  return /(?:【?Task Tree\s*[·:-]|任务图(?:\s*[·：:-]|状态同步|并行|规划))/i.test(text);
}

export function taskTreeSystemThreadKind(thread) {
  const text = `${thread?.name || ""} ${thread?.preview || ""}`;
  if (/Single Parallel Branch Planner|新增并行分支/i.test(text)) return "branch-planner";
  if (/Automatic Parallel Planner|自动规划/i.test(text)) return "planner";
  if (/Isolated Parallel Worker|任务图\s*·\s*并行/i.test(text)) return "worker";
  if (/Parallel Coordinator|任务图\s*·\s*汇总/i.test(text)) return "coordinator";
  if (/Continuous Supervisor|任务图\s*·\s*总控/i.test(text)) return "supervisor";
  if (/状态同步|tree.?sync/i.test(text)) return "sync";
  return "internal";
}

/** Hands the url to the OS so the desktop app comes forward on the thread we just started. */
export function openInCodex(threadId) {
  const url = threadDeepLink(threadId);
  const [command, args] = process.platform === "win32"
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];

  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  return url;
}
