import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { automaticRotationReason, CONTEXT_ROTATE_THRESHOLD, contextPressureStatus, contextUsagePercent } from "./context-policy.js";

export const MAIN_CONTEXT_STATE_PATH = ".task-tree-maintenance/main-context.json";

export async function applyCodexRolloutSnapshot({ lifecycle, threadId, snapshot } = {}) {
  if (!lifecycle || !threadId || !snapshot) return null;
  let state = await lifecycle.status();
  if (state.threadId !== threadId) state = await lifecycle.observeAccepted({ threadId });
  if (snapshot.tokenUsage) state = await lifecycle.observeUsage({ threadId, tokenUsage: snapshot.tokenUsage });
  const newCompaction = Boolean(snapshot.latestCompactionAt && snapshot.latestCompactionAt !== state.lastCompactionEventId);
  if (newCompaction) {
    state = await lifecycle.observeCompaction({
      threadId,
      turnId: `rollout:${snapshot.latestTaskCompletedAt || snapshot.latestTaskStartedAt}`,
      eventId: snapshot.latestCompactionAt
    });
  }
  const percent = Number(snapshot.tokenUsage?.percent);
  const thresholdReached = Number.isFinite(percent) && percent >= CONTEXT_ROTATE_THRESHOLD;
  if (snapshot.turnComplete
    && (thresholdReached || newCompaction)
    && state.rotationAttemptedGeneration !== state.generation) {
    return lifecycle.completeTurn({
      threadId,
      turnId: `rollout:${snapshot.latestTaskCompletedAt}`,
      tokenUsage: snapshot.tokenUsage,
      status: "completed"
    });
  }
  return { rotated: false, state };
}

function cleanId(value) {
  return String(value || "").trim();
}

function cleanUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: Number(value.inputTokens) || 0,
    outputTokens: Number(value.outputTokens) || 0,
    cachedInputTokens: Number(value.cachedInputTokens) || 0,
    totalTokens: Number(value.totalTokens) || 0,
    contextWindow: Number(value.contextWindow) || 0,
    percent: contextUsagePercent(value),
    updatedAt: String(value.updatedAt || new Date().toISOString())
  };
}

function freshState(threadId, now, previous = null) {
  return {
    version: 1,
    threadId: cleanId(threadId),
    generation: 1,
    status: "active",
    tokenUsage: null,
    contextCompactions: 0,
    lastTurnId: "",
    rotationAttemptedGeneration: 0,
    pendingRotationReason: "",
    warning: "",
    lastRotation: previous?.lastRotation || null,
    updatedAt: now()
  };
}

function normalizeState(value, now) {
  if (!value || typeof value !== "object") return freshState("", now);
  const generation = Math.max(1, Number(value.generation) || 1);
  return {
    ...freshState(value.threadId, now, value),
    ...value,
    version: 1,
    threadId: cleanId(value.threadId),
    generation,
    tokenUsage: cleanUsage(value.tokenUsage),
    contextCompactions: Math.max(0, Number(value.contextCompactions) || 0),
    rotationAttemptedGeneration: Math.max(0, Number(value.rotationAttemptedGeneration) || 0),
    status: value.status === "rotating" ? "rotation_failed" : String(value.status || "active"),
    warning: value.status === "rotating" && !value.warning
      ? "服务重启中断了上一次自动换代；旧会话仍然保留"
      : String(value.warning || "")
  };
}

export function createMainContextLifecycle({
  projectRoot,
  rotateContext,
  readPinnedThread = () => "",
  now = () => new Date().toISOString()
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  if (typeof rotateContext !== "function") throw new Error("rotateContext is required");
  const stateFile = path.join(projectRoot, MAIN_CONTEXT_STATE_PATH);
  let queue = Promise.resolve();
  const rotations = new Map();

  async function readStateDirect() {
    try {
      return normalizeState(JSON.parse(await readFile(stateFile, "utf8")), now);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return freshState("", now);
      throw error;
    }
  }

  async function writeStateDirect(state) {
    const next = { ...state, updatedAt: now() };
    await mkdir(path.dirname(stateFile), { recursive: true });
    const tempFile = `${stateFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rename(tempFile, stateFile);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!["EPERM", "EACCES"].includes(error?.code) || attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
    return next;
  }

  function transaction(change) {
    const run = queue.then(async () => {
      const current = await readStateDirect();
      const result = await change(current);
      if (!result) return current;
      return writeStateDirect(result);
    });
    queue = run.catch(() => {});
    return run;
  }

  async function status() {
    await queue;
    return readStateDirect();
  }

  async function observeAccepted({ threadId, turnId = "" } = {}) {
    const id = cleanId(threadId);
    if (!id) return status();
    return transaction((state) => {
      const next = state.threadId === id ? { ...state } : freshState(id, now, state);
      next.lastTurnId = cleanId(turnId);
      next.warning = "";
      if (!["near_limit", "ready_to_rotate", "rotating"].includes(next.status)) next.status = contextPressureStatus(next.tokenUsage);
      return next;
    });
  }

  async function observeUsage({ threadId, tokenUsage } = {}) {
    const id = cleanId(threadId);
    const usage = cleanUsage(tokenUsage);
    if (!id || !usage) return status();
    return transaction((state) => {
      if (state.threadId !== id) return null;
      const pressure = contextPressureStatus(usage);
      return {
        ...state,
        tokenUsage: usage,
        status: state.status === "rotating" ? state.status : pressure,
        pendingRotationReason: pressure === "ready_to_rotate" ? "context_threshold" : state.pendingRotationReason
      };
    });
  }

  async function observeCompaction({ threadId, turnId = "", eventId = "" } = {}) {
    const id = cleanId(threadId);
    if (!id) return status();
    return transaction((state) => {
      if (state.threadId !== id) return null;
      if (eventId && state.lastCompactionEventId === cleanId(eventId)) return null;
      return {
        ...state,
        contextCompactions: state.contextCompactions + 1,
        lastCompactionTurnId: cleanId(turnId),
        lastCompactionEventId: cleanId(eventId) || state.lastCompactionEventId || "",
        status: state.status === "rotating" ? state.status : "ready_to_rotate",
        pendingRotationReason: "context_compaction"
      };
    });
  }

  async function completeTurn({ threadId, turnId = "", tokenUsage = null, contextCompactions = 0, status: turnStatus = "completed" } = {}) {
    const id = cleanId(threadId);
    if (!id || turnStatus === "failed") return { rotated: false, state: await status() };
    const prepared = await transaction((state) => {
      if (state.threadId !== id) return null;
      const usage = cleanUsage(tokenUsage) || state.tokenUsage;
      let totalCompactions = state.contextCompactions;
      if (Number(contextCompactions) > 0 && state.lastCompactionTurnId !== cleanId(turnId)) {
        totalCompactions += Number(contextCompactions);
      }
      const reason = state.pendingRotationReason || automaticRotationReason({ tokenUsage: usage, contextCompactions });
      const next = {
        ...state,
        tokenUsage: usage,
        contextCompactions: totalCompactions,
        lastTurnId: cleanId(turnId) || state.lastTurnId,
        status: reason ? "ready_to_rotate" : contextPressureStatus(usage),
        pendingRotationReason: reason
      };
      if (!reason || state.rotationAttemptedGeneration === state.generation) {
        return state.status === "rotation_failed" ? { ...next, status: "rotation_failed" } : next;
      }
      return {
        ...next,
        status: "rotating",
        rotationAttemptedGeneration: state.generation,
        warning: ""
      };
    });

    const generation = prepared.generation;
    const reason = prepared.pendingRotationReason;
    if (prepared.threadId !== id || prepared.status !== "rotating" || prepared.rotationAttemptedGeneration !== generation) {
      return { rotated: false, state: prepared };
    }
    const pinnedThreadId = cleanId(readPinnedThread());
    if (pinnedThreadId && pinnedThreadId !== id) {
      const state = await transaction((current) => current.threadId === id && current.generation === generation ? {
        ...current,
        status: "rotation_failed",
        warning: "自动换代前用户已切换会话；旧会话未改动"
      } : null);
      return { rotated: false, state };
    }

    const key = `${id}:${generation}`;
    if (rotations.has(key)) return rotations.get(key);
    const running = (async () => {
      try {
        const result = await rotateContext({ sourceThreadId: id, reason, automatic: true });
        const successorId = cleanId(result?.threadId);
        if (!successorId) throw new Error("自动换代没有返回继任会话 id");
        if (result?.bound === false) {
          const state = await transaction((current) => current.threadId === id && current.generation === generation ? {
            ...current,
            status: "rotation_failed",
            warning: "自动换代期间用户切换了会话；继任会话已保留，但未覆盖当前选择"
          } : null);
          return { rotated: false, result, state };
        }
        const state = await transaction((current) => {
          if (current.threadId !== id || current.generation !== generation) return null;
          return {
            ...freshState(successorId, now, current),
            generation: generation + 1,
            lastRotation: {
              sourceThreadId: id,
              threadId: successorId,
              generation: generation + 1,
              reason,
              checkpointMode: result.checkpointMode || "",
              warning: result.checkpointWarning || result.archiveWarning || "",
              rotatedAt: now()
            }
          };
        });
        return { rotated: state.threadId === successorId, result, state };
      } catch (error) {
        const state = await transaction((current) => {
          if (current.threadId !== id || current.generation !== generation) return null;
          return {
            ...current,
            status: "rotation_failed",
            warning: `自动换代失败，仍继续使用旧会话：${error.message}`
          };
        });
        return { rotated: false, error, state };
      } finally {
        rotations.delete(key);
      }
    })();
    rotations.set(key, running);
    return running;
  }

  async function recordManualRotation({ sourceThreadId, result } = {}) {
    const source = cleanId(sourceThreadId);
    const successor = cleanId(result?.threadId);
    if (!successor) return status();
    return transaction((state) => ({
      ...freshState(successor, now, state),
      generation: state.threadId === source ? state.generation + 1 : 1,
      lastRotation: {
        sourceThreadId: source,
        threadId: successor,
        generation: state.threadId === source ? state.generation + 1 : 1,
        reason: "manual",
        checkpointMode: result.checkpointMode || "",
        warning: result.checkpointWarning || result.archiveWarning || "",
        rotatedAt: now()
      }
    }));
  }

  return {
    stateFile,
    status,
    observeAccepted,
    observeUsage,
    observeCompaction,
    completeTurn,
    recordManualRotation
  };
}
