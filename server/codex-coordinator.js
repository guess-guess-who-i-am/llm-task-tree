import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveCodexThread, startCodexTurn, threadDeepLink } from "./codex-run.js";
import { CONTEXT_ROTATE_THRESHOLD, CONTEXT_SOFT_THRESHOLD } from "./context-policy.js";
import { createExecutionScopeStore, executionScopeEnvironment } from "./execution-scope.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";
import { parseTreeNodeFields } from "./tree-quality.js";

const MAX_WORKERS = 4;
const MAX_REPORT_CHARS = 24000;
const MAX_EVENTS = 120;
const MAX_PEER_REQUESTS = 8;
const MAX_PEER_MESSAGES = 24;
const MAX_PEER_RESPONSE_CHARS = 6000;
const MAX_SUPERVISOR_ROUNDS = 8;
const MAX_SUPERVISOR_JOBS_PER_ROUND = 4;
const MAX_SUPERVISOR_JOBS = 24;
const MAX_SUPERVISOR_MESSAGES = 40;
const PLANNER_TIMEOUT_MS = 3 * 60 * 1000;
const PLANNER_MODEL = String(process.env.TASK_TREE_PLANNER_MODEL || "").trim();
const ABANDONED_PLANNING_MS = PLANNER_TIMEOUT_MS + 5 * 1000;
const GOAL_ALIGNMENTS = new Set(["aligned", "off_target", "unknown"]);
const GOAL_PROGRESS = new Set(["reached", "progress", "no_progress", "unknown"]);
const GOAL_CONTINUITY = new Set(["baseline", "stable", "drifted", "unknown"]);
const MAX_GOAL_HISTORY = 6;
const MAX_CONTEXT_OPTIONS = 24;
const WORKER_HANDOFF_PATH = ".task-tree-context/handoff.json";
const CONTEXT_POLICIES = new Set(["reuse", "new", "selected"]);
const RESERVED_FILES = [
  "task-tree.md",
  "task-trees.json",
  "scripts/project.json",
  "scripts/run.json"
];
const RESERVED_DIRECTORIES = [
  "versions/",
  ".task-tree-runs/",
  ".task-tree-scopes/",
  ".task-tree-context/"
];

function cleanId(value, fallback = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function cleanObjective(value) {
  return String(value || "").trim().slice(0, 4000);
}

function compactGoalText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function runtimeTree(run) {
  return {
    version: 1,
    runId: run.id,
    root: {
      id: "RUN",
      title: compactGoalText(run.goal?.immediate || run.objective || "本轮自动并行", 80),
      status: run.status
    },
    nodes: (run.jobs || []).map((job) => ({
      id: job.taskId,
      parentId: job.parentTaskId || "RUN",
      nodeId: job.nodeId,
      title: job.title,
      summary: job.summary || "",
      status: job.status === "queued" ? "planned" : job.status,
      round: Number(job.supervisorRound) || 0,
      dependsOn: job.dependsOn || [],
      threadId: job.contextThreadId || job.threadId || "",
      evidence: compactGoalText(job.evidence || job.error || "", 180)
    })),
    supervisor: run.supervisor ? {
      status: run.supervisor.status,
      rounds: Number(run.supervisor.rounds) || 0,
      lastDecision: run.supervisor.lastDecision || "",
      threadId: run.supervisor.threadId || ""
    } : null,
    updatedAt: run.updatedAt
  };
}

export function deriveParallelContextKey({ nodeId = "", writeSet = [] } = {}) {
  const node = cleanId(nodeId, "node").toLowerCase();
  const scope = [...new Set((Array.isArray(writeSet) ? writeSet : []).map((item) => String(item || "").trim().replace(/\\/g, "/").toLowerCase()).filter(Boolean))]
    .sort()
    .join("\n");
  const digest = createHash("sha256").update(`${node}\n${scope}`).digest("hex").slice(0, 10);
  return `${node}-${digest}`;
}

function contextLabel(job) {
  return compactGoalText(job?.contextLabel || job?.title || job?.nodeId || job?.taskId || "并行分支", 48);
}

export function buildParallelContextOption(run, job, { allowActive = false } = {}) {
  const durableRun = ["accepted", "rejected", "failed"].includes(String(run?.status || ""));
  const durableJob = ["completed", "failed", "blocked"].includes(String(job?.status || ""));
  const explicitlyPersistent = job?.contextPersistent === true;
  if (allowActive ? !explicitlyPersistent && !(durableRun && durableJob) : !(durableRun && durableJob)) return null;
  const contextKey = cleanId(job?.contextKey) || deriveParallelContextKey(job);
  const threadId = String(job?.contextThreadId || job?.threadId || "").trim();
  if (!contextKey || !threadId) return null;
  return {
    contextKey,
    threadId,
    nodeId: cleanId(job.nodeId),
    title: contextLabel(job),
    preview: compactGoalText(job?.contextPreview || job?.summary || job?.instruction || "", 96),
    lastOutput: String(job?.output || job?.contextResult || "").replace(/\s+/g, " ").trim().slice(-1200),
    source: job?.contextSource || "parallel",
    writeSet: Array.isArray(job.writeSet) ? [...job.writeSet] : [],
    generation: Number(job.contextGeneration) || 1,
    status: job.contextStatus || "active",
    tokenUsage: job.contextUsage || null,
    parentThreadId: job.parentThreadId || "",
    handoffPath: job.contextHandoffPath || "",
    runId: cleanId(run?.id),
    updatedAt: run?.updatedAt || run?.createdAt || ""
  };
}

function mergeContextOptions(...groups) {
  const merged = new Map();
  const items = groups.flat().filter(Boolean).sort((left, right) => Date.parse(left.updatedAt || "") - Date.parse(right.updatedAt || ""));
  for (const item of items) {
    const key = cleanId(item.contextKey);
    const threadId = String(item.threadId || "").trim();
    if (!key || !threadId) continue;
    merged.set(key, { ...item, contextKey: key, threadId });
  }
  return [...merged.values()].slice(-MAX_CONTEXT_OPTIONS).reverse();
}

async function readContextOptions(runsDir, excludeRunId = "") {
  try {
    const names = (await readdir(runsDir)).filter((name) => name.endsWith(".json") && name !== "context-index.json");
    const records = await Promise.all(names.map(async (name) => {
      try {
        return JSON.parse(await readFile(path.join(runsDir, name), "utf8"));
      } catch {
        return null;
      }
    }));
    return mergeContextOptions(records
      .filter((run) => run && run.id !== excludeRunId)
      .flatMap((run) => (run.jobs || []).map((job) => buildParallelContextOption(run, job))));
  } catch {
    return [];
  }
}

function graphStateValue(markdown, field) {
  const text = String(markdown || "");
  const start = text.search(/^# GraphState\s*$/m);
  if (start < 0) return "";
  const tail = text.slice(start);
  const end = tail.search(/^# Edges\s*$/m);
  const section = end >= 0 ? tail.slice(0, end) : tail;
  return section.match(new RegExp(`^-\\s+${field}:\\s*(.*)$`, "m"))?.[1]?.trim() || "";
}

export function deriveParallelGoal(markdown, objective = "") {
  const nodes = parseTreeNodeFields(markdown);
  const root = nodes.find((node) => node.id === "ROOT") || { fields: {} };
  const stageNodeId = cleanId(graphStateValue(markdown, "Next"));
  const stage = nodes.find((node) => node.id === stageNodeId) || root;
  const rootGoal = compactGoalText(root.fields.Problem || root.title, 220);
  const stageGoal = compactGoalText(stage.fields.Problem || stage.title || rootGoal, 220);
  return {
    root: rootGoal,
    stageNodeId: stage.id || "ROOT",
    stage: stageGoal,
    immediate: compactGoalText(objective, 320) || stageGoal || rootGoal,
    success: compactGoalText(stage.fields.Metrics || root.fields.Metrics, 320)
  };
}

function compactGoalHistoryItem(run) {
  const goal = run?.goal || {};
  const assessment = run?.review?.goalAssessment || {};
  return {
    runId: cleanId(run?.id),
    status: String(run?.status || "").trim(),
    root: compactGoalText(goal.root, 120),
    stage: compactGoalText(goal.stage, 120),
    immediate: compactGoalText(goal.immediate || run?.objective, 140),
    result: compactGoalText(run?.review?.summary || run?.summary, 140),
    alignment: String(assessment.alignment || "unknown"),
    progress: String(assessment.progress || "unknown")
  };
}

async function readGoalHistory(runsDir, excludeRunId = "") {
  try {
    const names = (await readdir(runsDir)).filter((name) => name.endsWith(".json") && name !== "context-index.json");
    const records = await Promise.all(names.map(async (name) => {
      try {
        return JSON.parse(await readFile(path.join(runsDir, name), "utf8"));
      } catch {
        return null;
      }
    }));
    return records
      .filter((run) => run && run.id !== excludeRunId && ["accepted", "review"].includes(run.status) && run.goal)
      .sort((left, right) => Date.parse(left.updatedAt || left.createdAt || "") - Date.parse(right.updatedAt || right.createdAt || ""))
      .slice(-MAX_GOAL_HISTORY)
      .map(compactGoalHistoryItem);
  } catch {
    return [];
  }
}

function formatGoalHistory(history = []) {
  if (!history.length) return "(no previous accepted or reviewed run; use baseline)";
  return history.map((item) => [
    `${item.status || "review"} ${item.runId || "unknown"}`,
    `root=${item.root || "unknown"}`,
    `stage=${item.stage || "unknown"}`,
    `run=${item.immediate || "unknown"}`,
    `result=${item.result || "unknown"}`
  ].join(" | ")).join("\n");
}

export function normalizeGoalAssessment(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const alignment = GOAL_ALIGNMENTS.has(input.alignment) ? input.alignment : "unknown";
  const progress = GOAL_PROGRESS.has(input.progress) ? input.progress : "unknown";
  return {
    alignment,
    progress,
    continuity: GOAL_CONTINUITY.has(input.continuity) ? input.continuity : "unknown",
    achieved: compactGoalText(input.achieved, 180),
    remaining: compactGoalText(input.remaining, 180)
  };
}

export function goalAssessmentAllowsAccept(assessment, history = []) {
  const normalized = normalizeGoalAssessment(assessment);
  const requiredContinuity = Array.isArray(history) && history.length ? "stable" : "baseline";
  return normalized.alignment === "aligned"
    && ["reached", "progress"].includes(normalized.progress)
    && normalized.continuity === requiredContinuity;
}

function humanizeTitle(value, fallback = "并行任务") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim();
  return text
    .replace(/业务场景代理夹具/g, "业务测试场景")
    .replace(/根目标语义回归/g, "目标一致性校验")
    .replace(/状态同步提示契约/g, "状态同步规则")
    .replace(/契约/g, "规则")
    .replace(/夹具/g, "测试场景")
    .replace(/语义回归/g, "目标校验")
    .slice(0, 28);
}

function conciseInstruction(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const first = text.split(/[。！？；;]/)[0] || text;
  const colon = first.indexOf("：");
  return (colon > 8 ? first.slice(0, colon) : first).slice(0, 72);
}

function normalizeScope(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) throw new Error("每个分支都要填写至少一个负责修改的文件范围");
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) throw new Error(`负责修改的文件范围必须是项目内相对路径：${raw}`);
  const parts = raw.split("/");
  if (parts.includes("..")) throw new Error(`负责修改的文件范围不能越出项目目录：${raw}`);
  return raw.replace(/\/{2,}/g, "/");
}

function scopeBase(scope) {
  const wildcard = scope.search(/[*!?\[]/);
  if (wildcard >= 0) return scope.slice(0, wildcard).replace(/[^/]*$/, "").toLowerCase();
  return scope.toLowerCase();
}

function scopesOverlap(left, right) {
  const a = scopeBase(left);
  const b = scopeBase(right);
  if (!a || !b) return true;
  if (a === b) return true;
  const aDirectory = left.endsWith("/") || /[*!?\[]/.test(left);
  const bDirectory = right.endsWith("/") || /[*!?\[]/.test(right);
  return (aDirectory && b.startsWith(a.endsWith("/") ? a : `${a}/`))
    || (bDirectory && a.startsWith(b.endsWith("/") ? b : `${b}/`));
}

function assertScopeAllowed(scope) {
  const lower = scope.toLowerCase();
  if (RESERVED_FILES.includes(lower)) {
    throw new Error(`共享状态只能由 coordinator 维护，不能租给 worker：${scope}`);
  }
  for (const directory of RESERVED_DIRECTORIES) {
    const name = directory.slice(0, -1);
    const base = scopeBase(lower);
    if (lower === name || lower.startsWith(directory) || base === directory || base.startsWith(directory)) {
      throw new Error(`共享状态只能由 coordinator 维护，不能租给 worker：${scope}`);
    }
  }
}

function assertAcyclic(jobs) {
  const byId = new Map(jobs.map((job) => [job.taskId, job]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new Error(`并行计划存在循环依赖：${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn || []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const job of jobs) visit(job.taskId);
}

export function validateParallelJobs(input, { minimum = 2, knownTaskIds = [], existingJobs = [] } = {}) {
  if (!Array.isArray(input) || input.length < minimum) {
    throw new Error(minimum <= 1 ? "至少需要 1 个 worker" : "并行运行至少需要 2 个 worker");
  }

  const seenTasks = new Set();
  const leases = [];
  for (const existing of Array.isArray(existingJobs) ? existingJobs : []) {
    for (const scope of Array.isArray(existing?.writeSet) ? existing.writeSet : []) {
      leases.push({ taskId: existing.taskId, scope });
    }
  }
  const jobs = input.map((job, index) => {
    const nodeId = cleanId(job?.nodeId);
    const taskId = cleanId(job?.taskId || job?.id || nodeId, `worker-${index + 1}`);
    const instruction = String(job?.instruction || "").trim();
    if (!nodeId) throw new Error(`worker ${index + 1} 缺少 nodeId`);
    if (seenTasks.has(taskId.toLowerCase())) throw new Error(`任务不能重复：${taskId}`);
    if (!instruction) throw new Error(`worker ${taskId} 缺少任务说明`);
    seenTasks.add(taskId.toLowerCase());

    const writeSet = [...new Set((Array.isArray(job.writeSet) ? job.writeSet : []).map(normalizeScope))];
    if (!writeSet.length) throw new Error(`分支 ${taskId} 至少需要一个负责修改的文件范围`);
    for (const scope of writeSet) {
      assertScopeAllowed(scope);
      for (const lease of leases) {
        if (scopesOverlap(scope, lease.scope)) throw new Error(`分支负责修改的文件范围冲突：${taskId}:${scope} 与 ${lease.taskId}:${lease.scope}`);
      }
      leases.push({ taskId, scope });
    }

    return {
      id: taskId,
      taskId,
      nodeId,
      title: humanizeTitle(job.title, conciseInstruction(instruction)),
      instruction,
      summary: conciseInstruction(job.summary || instruction),
      dependencyPrompt: compactGoalText(job.dependencyPrompt, 420),
      acceptancePrompt: compactGoalText(job.acceptancePrompt, 520),
      writeSet,
      dependsOn: [...new Set((Array.isArray(job.dependsOn) ? job.dependsOn : []).map((item) => cleanId(item)).filter(Boolean))],
      tests: [...new Set((Array.isArray(job.tests) ? job.tests : []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 6),
      contextPolicy: CONTEXT_POLICIES.has(job.contextPolicy) ? job.contextPolicy : "reuse",
      contextKey: cleanId(job.contextKey) || deriveParallelContextKey({ nodeId, writeSet }),
      contextThreadId: String(job.contextThreadId || "").trim(),
      contextSource: String(job.contextSource || "").trim() || "parallel",
      contextLabel: contextLabel({ ...job, nodeId, taskId })
    };
  });

  const known = new Set([
    ...jobs.map((job) => job.taskId),
    ...(Array.isArray(knownTaskIds) ? knownTaskIds.map((id) => cleanId(id)).filter(Boolean) : [])
  ]);
  for (const job of jobs) {
    const unknown = job.dependsOn.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`任务 ${job.taskId} 引用了未知依赖：${unknown.join(", ")}`);
    if (job.dependsOn.includes(job.taskId)) throw new Error(`任务不能依赖自己：${job.taskId}`);
  }
  assertAcyclic([...(Array.isArray(existingJobs) ? existingJobs : []), ...jobs]);
  return jobs;
}

function contextReuseScore(job, option) {
  if (!option?.threadId || option.source === "codex" || cleanId(option.nodeId) !== cleanId(job.nodeId)) return 0;
  if (option.contextKey === job.contextKey) return 1000;
  const currentScopes = Array.isArray(job.writeSet) ? job.writeSet : [];
  const priorScopes = Array.isArray(option.writeSet) ? option.writeSet : [];
  if (currentScopes.some((left) => priorScopes.some((right) => scopesOverlap(left, right)))) return 100;
  if (contextLabel(job) === compactGoalText(option.title, 48)) return 70;
  return 0;
}

export function assignParallelDraftContexts(jobs, options = []) {
  const claimedThreads = new Set();
  return jobs.map((job) => {
    const policy = CONTEXT_POLICIES.has(job.contextPolicy) ? job.contextPolicy : "reuse";
    const inherit = policy !== "new";
    if (!inherit) {
      return {
        ...job,
        contextPolicy: policy,
        contextThreadId: "",
        contextSource: "parallel",
        contextPreview: "",
        contextLabel: contextLabel(job),
        contextMatch: "new"
      };
    }
    if (job.contextThreadId) {
      claimedThreads.add(job.contextThreadId);
      return { ...job, contextPolicy: policy, contextMatch: job.contextMatch || "existing" };
    }
    const match = options
      .filter((option) => !claimedThreads.has(option.threadId))
      .map((option) => ({ option, score: contextReuseScore(job, option) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || Date.parse(right.option.updatedAt || 0) - Date.parse(left.option.updatedAt || 0))[0];
    if (match) claimedThreads.add(match.option.threadId);
    return {
      ...job,
      contextPolicy: policy,
      contextKey: match?.option.contextKey || job.contextKey,
      contextThreadId: match?.option.threadId || "",
      contextSource: match?.option.source || job.contextSource || "parallel",
      contextPreview: match?.option.preview || job.contextPreview || "",
      contextLabel: match?.option.title || contextLabel(job),
      contextGeneration: Number(match?.option.generation || job.contextGeneration || 1),
      contextStatus: match?.option.status || job.contextStatus || "active",
      contextUsage: match?.option.tokenUsage || job.contextUsage || null,
      contextMatch: match ? (match.score >= 1000 ? "exact" : match.score >= 100 ? "scope" : "title") : "new"
    };
  });
}

function executionContexts(input, previous = [], options = [], validationOptions = {}) {
  const jobs = validateParallelJobs(input, validationOptions);
  const previousById = new Map(previous.map((job) => [job.taskId, job]));
  const optionsByKey = new Map(options.map((item) => [item.contextKey, item]));
  const resolved = jobs.map((job) => {
    const prior = previousById.get(job.taskId) || {};
    const requestedPolicy = job.contextPolicy;
    if (requestedPolicy === "new") {
      return {
        ...job,
        contextPolicy: "reuse",
        contextKey: `${deriveParallelContextKey(job)}-${randomUUID().slice(0, 8)}`,
        contextThreadId: "",
        contextSource: "parallel",
        contextLabel: contextLabel(job)
      };
    }

    if (requestedPolicy === "selected") {
      const selected = optionsByKey.get(job.contextKey) || (job.contextThreadId
        ? { contextKey: job.contextKey || `codex-${cleanId(job.contextThreadId)}`, threadId: job.contextThreadId, title: job.contextLabel, source: job.contextSource || "codex", preview: job.contextPreview || "" }
        : null);
      if (!selected?.threadId) throw new Error(`找不到已选择的分支上下文：${job.contextLabel || job.taskId}`);
      return {
        ...job,
        contextPolicy: "reuse",
        contextKey: selected.contextKey,
        contextThreadId: selected.threadId,
        contextSource: selected.source || "parallel",
        contextPreview: selected.preview || "",
        contextLabel: selected.title || contextLabel(job),
        contextGeneration: Number(selected.generation || job.contextGeneration || 1),
        contextStatus: selected.status || job.contextStatus || "active",
        contextUsage: selected.tokenUsage || job.contextUsage || null,
        contextResult: selected.lastOutput || job.contextResult || ""
      };
    }

    const derivedKey = deriveParallelContextKey(job);
    const identityChanged = prior.taskId && deriveParallelContextKey(prior) !== derivedKey;
    const contextKey = identityChanged ? derivedKey : (job.contextKey || prior.contextKey || derivedKey);
    const samePrior = prior.contextKey === contextKey ? prior : null;
    const match = optionsByKey.get(contextKey);
    return {
      ...job,
      contextPolicy: "reuse",
      contextKey,
      contextThreadId: samePrior?.contextThreadId || job.contextThreadId || match?.threadId || "",
      contextSource: samePrior?.contextSource || job.contextSource || match?.source || "parallel",
      contextPreview: samePrior?.contextPreview || job.contextPreview || match?.preview || "",
      contextLabel: samePrior?.contextLabel || match?.title || contextLabel(job),
      contextGeneration: Number(samePrior?.contextGeneration || match?.generation || job.contextGeneration || 1),
      contextStatus: samePrior?.contextStatus || match?.status || job.contextStatus || "active",
      contextUsage: samePrior?.contextUsage || match?.tokenUsage || job.contextUsage || null,
      contextResult: samePrior?.contextResult || match?.lastOutput || job.contextResult || ""
    };
  });

  const ownerByContext = new Map();
  const ownerByThread = new Map();
  for (const job of resolved) {
    const owner = ownerByContext.get(job.contextKey);
    if (owner) throw new Error(`同一 Codex 对话不能同时分配给多个分支：${owner}、${job.title || job.taskId}`);
    ownerByContext.set(job.contextKey, job.title || job.taskId);
    if (job.contextThreadId) {
      const threadOwner = ownerByThread.get(job.contextThreadId);
      if (threadOwner) throw new Error(`同一 Codex 对话不能同时分配给多个分支：${threadOwner}、${job.title || job.taskId}`);
      ownerByThread.set(job.contextThreadId, job.title || job.taskId);
    }
  }
  return resolved;
}

function rememberRunContext(run, job) {
  const current = buildParallelContextOption(run, job, { allowActive: true });
  if (!current) return;
  run.contextOptions = mergeContextOptions(run.contextOptions || [], [current]);
}

function contextUsagePercent(job) {
  const percent = Number(job?.contextUsage?.percent ?? job?.contextUsagePercent);
  return Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : null;
}

function shouldRotateContext(job) {
  const percent = contextUsagePercent(job);
  return Boolean(job?.contextThreadId && percent !== null && percent >= CONTEXT_ROTATE_THRESHOLD);
}

async function writeContextHandoff(runsDir, run, job) {
  const directory = path.join(runsDir, "handoffs");
  await mkdir(directory, { recursive: true });
  const generation = Number(job.contextGeneration) || 1;
  const fileName = `${cleanId(job.contextKey || job.taskId, "context")}-g${generation}-${cleanId(run.id, "run")}.json`;
  const relativePath = `.task-tree-runs/handoffs/${fileName}`;
  const target = path.join(directory, fileName);
  const handoff = {
    version: 1,
    createdAt: new Date().toISOString(),
    runId: run.id,
    branchId: job.contextKey || job.taskId,
    nodeId: job.nodeId,
    generation,
    parentThreadId: job.contextThreadId || job.threadId || "",
    rootGoal: run.goal?.root || "",
    stageGoal: run.goal?.stage || "",
    runGoal: run.goal?.immediate || run.objective || "",
    task: job.instruction || "",
    currentResult: String(job.output || job.contextResult || job.contextPreview || "").replace(/\s+/g, " ").trim().slice(-1200),
    changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles : [],
    tests: Array.isArray(job.testResults) ? job.testResults.map((item) => ({ command: item.command, ok: item.ok })) : [],
    nextAction: job.acceptancePrompt || job.instruction || "",
    evidence: [relativePath]
  };
  const content = `${JSON.stringify(handoff, null, 2)}\n`;
  await writeFile(target, content, "utf8");
  return { archivePath: relativePath, content };
}

async function stageWorkerHandoff(workerPath, content) {
  const target = path.join(workerPath, ...WORKER_HANDOFF_PATH.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return WORKER_HANDOFF_PATH;
}

async function removeWorkerHandoff(workerPath) {
  if (!workerPath) return;
  await rm(path.join(workerPath, ".task-tree-context"), { recursive: true, force: true });
}

export function buildPlannerPrompt(markdown, objective = "", history = []) {
  const goal = deriveParallelGoal(markdown, objective);
  return [
    "【Task Tree · Automatic Parallel Planner】",
    "Create a concrete execution plan for 2-4 Codex workers. The plan will be shown to a human before any writable work starts.",
    "Use the task tree's ROOT purpose and active-stage goals. Ignore stale NextPlan. Exclude work that requires a human or external system; do not disguise review as implementation.",
    "Decompose broad nodes when that creates genuinely independent write scopes. A source node may own multiple taskIds.",
    "Each worker needs a disjoint project-relative writeSet. Never include task-tree.md, task-trees.json, scripts/project.json, scripts/run.json, versions/, .task-tree-runs/, or .task-tree-scopes/.",
    "title is user-facing: use plain Chinese, 4-12 characters, and name the concrete result. Avoid IDs, English, and abstract words such as 契约、夹具、oracle. taskId is a hidden machine id and may remain English.",
    "summary is user-facing: use one plain Chinese sentence of 16-36 characters explaining how this branch advances the run goal. Do not repeat implementation steps.",
    "Dependencies must reference taskId. Prefer an immediately runnable frontier rather than a linear chain. Include narrow verification commands that can run without interaction.",
    "For every worker, also write dependencyPrompt for a human-editable prerequisite explanation and acceptancePrompt for a human-editable proof-of-completion explanation. Do not hide these in instruction.",
    `Root goal: ${goal.root || "(not recorded)"}`,
    `Active stage (${goal.stageNodeId}): ${goal.stage || "(not recorded)"}`,
    `Run goal: ${goal.immediate || "(not recorded)"}`,
    `Success basis: ${goal.success || "(not recorded)"}`,
    "Previous target anchors (do not replace the root goal with a local implementation target):",
    formatGoalHistory(history),
    "",
    "Return JSON only, with this exact shape:",
    '{"summary":"why these branches are sufficient","jobs":[{"taskId":"short-id","nodeId":"N2","title":"short title","summary":"contribution to the run goal","instruction":"observable deliverable and completion test","dependencyPrompt":"human-editable prerequisite explanation","acceptancePrompt":"human-editable proof and remaining gap","writeSet":["public/**"],"dependsOn":[],"tests":["node scripts/test-example.mjs"]}],"integrationTests":["node scripts/test-example.mjs"]}',
    "",
    "Current task tree:",
    String(markdown || "").slice(0, 64000)
  ].join("\n");
}

export function buildWorkerPrompt(job, scope = null, handoffPath = "", peerJobs = []) {
  const peerRoster = peerJobs
    .filter((peer) => peer?.taskId && peer.taskId !== job.taskId)
    .map((peer) => `${peer.taskId}（${peer.title || peer.nodeId}）${peer.threadId ? ` · ${threadDeepLink(peer.threadId)}` : " · 会话尚未建立"}`)
    .join("\n");
  return [
    "【Task Tree · Isolated Parallel Worker】",
    `Task id: ${job.taskId}`,
    `Source node: ${job.nodeId}${job.title ? ` - ${job.title}` : ""}`,
    `Task: ${job.instruction}`,
    `Branch-owned file scope (must not overlap another branch): ${job.writeSet.join(", ")}`,
    `Dependency note: ${job.dependencyPrompt || "none recorded; verify prerequisites before coding"}`,
    `Acceptance note: ${job.acceptancePrompt || "state the solved problem, evidence, and remaining gap"}`,
    job.dependsOn?.length ? `Dependencies already integrated: ${job.dependsOn.join(", ")}` : "Dependencies: none",
    job.tests?.length ? `Verification: ${job.tests.join(" ; ")}` : "Verification: choose a proportionate non-interactive check",
    peerRoster ? `Peer branches that may be consulted by taskId:\n${peerRoster}` : "Peer branches: none have a visible conversation yet; use the taskId from this run if consultation is needed.",
    scope?.scopeId ? `Execution scope: ${scope.scopeId}` : "",
    `Branch context generation: ${Number(job.contextGeneration) || 1}`,
    handoffPath ? `Previous generation handoff: ${handoffPath}` : "",
    handoffPath ? "Start by reading this short handoff and the current task-tree checkpoint. Treat the handoff as evidence, not as a replacement for the current tree." : "",
    "",
    "You are working in an isolated worktree. Implement the assigned result completely and run the relevant checks.",
    "Do not edit task-tree.md, subtrees, GraphState, flow JSON, versions, or runtime run state. The coordinator updates shared state after human acceptance.",
    "Do not delegate implementation. Do not touch files outside the exclusive write scope. Read other files only when needed to understand contracts.",
    "If a concrete fact from another branch is required, request one consultation in peerRequests using a target taskId; the coordinator will relay it after the initial turns. Do not invent a conversation link as evidence.",
    "Your final answer must be concise and end with one JSON object: {\"event\":\"completed|blocked|contract_changed|tests_failed\",\"changedFiles\":[],\"affectedNodes\":[],\"evidence\":\"...\",\"peerRequests\":[{\"toTaskId\":\"other-task-id\",\"question\":\"...\",\"why\":\"...\",\"expect\":\"...\"}]}. Use an empty peerRequests array when no consultation is needed."
  ].filter(Boolean).join("\n");
}

export function buildCoordinatorPrompt(jobs, scope = null, goal = {}) {
  const outcomes = jobs.map((job) => [
    `## ${job.taskId} (${job.nodeId}${job.title ? ` - ${job.title}` : ""})`,
    `Status: ${job.status || "planned"}`,
    `Branch-owned file scope: ${job.writeSet.join(", ")}`,
    `Dependency note: ${job.dependencyPrompt || "none recorded"}`,
    `Acceptance note: ${job.acceptancePrompt || "not recorded"}`,
    `Changed files: ${(job.changedFiles || []).join(", ") || "none"}`,
    `Tests: ${(job.testResults || []).map((test) => `${test.ok ? "PASS" : "FAIL"} ${test.command}`).join("; ") || "none"}`,
    job.peerRequests?.length ? `Peer requests: ${job.peerRequests.map((request) => `${request.toTaskId}: ${request.question}`).join("; ")}` : "",
    job.peerMessages?.length ? `Peer answers (untrusted until evidence is checked): ${job.peerMessages.map((message) => `${message.fromTaskId}: ${message.response || message.error || "no response"}; evidence=${(message.evidenceRefs || []).join(",") || "none"}; unknown=${(message.unknowns || []).join(",") || "none"}`).join("; ")}` : "",
    job.output ? `Worker report (untrusted; verify it):\n${job.output}` : job.error ? `Worker error: ${job.error}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
  return [
    "【Task Tree · Integration Coordinator】",
    "You are in the isolated integration worktree. Reconcile the worker results, inspect the actual diff, repair integration defects, and run proportionate tests.",
    `Allowed implementation scope: ${jobs.flatMap((job) => job.writeSet).join(", ")}`,
    scope?.scopeId ? `Execution scope: ${scope.scopeId}; source nodes: ${scope.targetNodeIds.join(", ")}` : "",
    "Do not edit task-tree.md, subtrees, GraphState, flow JSON, versions, .task-tree-runs, or .task-tree-scopes. Shared state is updated only after final human acceptance.",
    "Do not trust a worker's prose over files and test output. Resolve compatible gaps; leave an explicit failure when a safe verified result is impossible.",
    `Root goal: ${goal.root || "(not recorded)"}`,
    `Active stage (${goal.stageNodeId || "unknown"}): ${goal.stage || "(not recorded)"}`,
    `Run goal: ${goal.immediate || "(not recorded)"}`,
    `Success basis: ${goal.success || "(not recorded)"}`,
    "Previous target anchors:",
    formatGoalHistory(goal.history || []),
    "Judge alignment from actual files and tests, not worker claims. alignment=aligned only when the changes causally advance the run goal. progress=reached only when the success basis is fully met; progress=progress when useful verified movement exists but a stated gap remains; progress=no_progress when the changes do not create verified movement. continuity=stable only when the result preserves the root goal across the previous accepted/reviewed runs; continuity=drifted when it quietly replaces the long-term goal with a local implementation target; continuity=baseline only when there is no prior accepted/reviewed run; continuity=unknown when the evidence is insufficient.",
    "End with one JSON object: {\"event\":\"completed|tests_failed|blocked\",\"summary\":\"one short result\",\"affectedNodes\":[\"N2\"],\"evidence\":\"tests and key files\",\"goalAssessment\":{\"alignment\":\"aligned|off_target|unknown\",\"progress\":\"reached|progress|no_progress|unknown\",\"continuity\":\"baseline|stable|drifted|unknown\",\"achieved\":\"verified capability\",\"remaining\":\"unresolved gap\"}}.",
    "",
    outcomes
  ].filter(Boolean).join("\n").slice(0, 96000);
}

export function buildSupervisorPrompt(run, userMessages = []) {
  const completed = (run.jobs || []).filter((job) => job.status === "completed").map((job) => ({
    taskId: job.taskId,
    nodeId: job.nodeId,
    title: job.title,
    evidence: compactGoalText(parseJsonObject(job.output)?.evidence || job.error || job.output, 500),
    changedFiles: job.changedFiles || []
  }));
  const failed = (run.jobs || []).filter((job) => ["failed", "blocked"].includes(job.status)).map((job) => ({
    taskId: job.taskId,
    nodeId: job.nodeId,
    title: job.title,
    error: compactGoalText(job.error, 300)
  }));
  const existing = (run.jobs || []).map((job) => ({
    taskId: job.taskId,
    nodeId: job.nodeId,
    title: job.title,
    status: job.status,
    writeSet: job.writeSet || [],
    dependsOn: job.dependsOn || []
  }));
  return [
    "【Task Tree · Continuous Supervisor】",
    "You are the persistent supervisor for one approved parallel run. You schedule workers but never edit project files or task-tree state.",
    "Keep the user's root and active-stage goals fixed. Decide whether the verified worker results are sufficient to enter final integration, or whether another independently verifiable worker task is necessary.",
    "Temporary execution tasks belong to the runtime tree. Do not propose adding them to the durable method tree.",
    "Prefer finishing over inventing work. Add a task only when a concrete unresolved gap blocks the run goal. Never duplicate an existing task, repeat completed work, or create process-only tasks.",
    "Every new job must reference an existing task-tree nodeId, name its contribution to the run goal, declare a non-overlapping project-relative writeSet, dependencies, and an acceptancePrompt. Reserved task-tree and run-state paths are forbidden.",
    `Root goal: ${run.goal?.root || "(not recorded)"}`,
    `Active stage (${run.goal?.stageNodeId || "ROOT"}): ${run.goal?.stage || "(not recorded)"}`,
    `Approved run goal: ${run.goal?.immediate || run.objective || "(not recorded)"}`,
    `Success definition: ${run.goal?.success || "(not recorded)"}`,
    `Supervisor round: ${Number(run.supervisor?.rounds) || 0}`,
    `Existing runtime tasks: ${JSON.stringify(existing)}`,
    `Completed evidence: ${JSON.stringify(completed)}`,
    `Failures or blockers: ${JSON.stringify(failed)}`,
    `Queued user messages: ${JSON.stringify(userMessages.map((item) => item.text))}`,
    "Return JSON only. Use action=continue only when newJobs is non-empty. Use action=finish when final integration should start. Use action=waiting_user only when a decision truly requires the user.",
    '{"action":"finish|continue|waiting_user","summary":"一句话说明当前推进到哪里","reason":"为何收束、继续或需要用户","newJobs":[{"taskId":"stable-id","nodeId":"N1","parentTaskId":"optional-existing-task-id","title":"短标题","summary":"怎样推进本轮目标","instruction":"明确交付物","dependencyPrompt":"开始前确认什么","acceptancePrompt":"如何证明解决了问题，还剩什么未证实","writeSet":["src/area/**"],"dependsOn":["existing-task-id"],"tests":[]}],"messageToUser":"仅 waiting_user 时填写"}'
  ].join("\n");
}

export function normalizeSupervisorDecision(output) {
  const parsed = parseJsonObject(output) || {};
  const action = ["finish", "continue", "waiting_user"].includes(parsed.action) ? parsed.action : "waiting_user";
  return {
    action,
    summary: compactGoalText(parsed.summary, 240),
    reason: compactGoalText(parsed.reason, 360),
    messageToUser: compactGoalText(parsed.messageToUser, 360),
    newJobs: Array.isArray(parsed.newJobs) ? parsed.newJobs.slice(0, MAX_SUPERVISOR_JOBS_PER_ROUND) : []
  };
}

export function buildSupervisorFinalPrompt(run, integration, coordinatorOutput) {
  const queuedMessages = (run.supervisor?.messages || []).filter((message) => message.status === "queued");
  return [
    "【Task Tree · Supervisor Final Review】",
    "All worker execution and integration checks have finished. Give the final concise report to the user from this same supervisor context.",
    "Do not edit files or create more tasks in this turn. Judge the approved run goal, not implementation activity alone.",
    `Root goal: ${run.goal?.root || "(not recorded)"}`,
    `Active-stage goal: ${run.goal?.stage || "(not recorded)"}`,
    `Approved run goal: ${run.goal?.immediate || run.objective || "(not recorded)"}`,
    "Previous accepted or reviewed runs:",
    formatGoalHistory(run.goal?.history || []),
    `Continuity rule: use ${run.goal?.history?.length ? "stable when this run preserves the same long-term goal" : "baseline because no previous accepted or reviewed run exists"}.`,
    `Integration result: ${JSON.stringify(integration)}`,
    `Coordinator report: ${String(coordinatorOutput || "").slice(0, MAX_REPORT_CHARS)}`,
    `Late user messages: ${JSON.stringify(queuedMessages.map((message) => message.text))}`,
    "Return JSON only. Keep summary and evidence concise. goalAssessment must state what is achieved, what remains, and whether the result still follows the stable goal.",
    '{"event":"completed","summary":"最终结果","affectedNodes":["N1"],"evidence":"关键可验证证据","goalAssessment":{"alignment":"aligned|off_target|unknown","progress":"reached|progress|no_progress|unknown","continuity":"baseline|stable|drifted|unknown","achieved":"已经达到什么","remaining":"还缺什么"}}'
  ].join("\n");
}

export function buildGoalAuditPrompt(run) {
  const goal = run.goal || {};
  const tests = (run.integrationTestResults || []).map((test) => `${test.ok ? "PASS" : "FAIL"} ${test.command}`).join("; ") || "none";
  return [
    "【Task Tree · Parallel Goal Audit】",
    `Root goal: ${goal.root || "(not recorded)"}`,
    `Active stage (${goal.stageNodeId || "unknown"}): ${goal.stage || "(not recorded)"}`,
    `Run goal: ${goal.immediate || "(not recorded)"}`,
    `Success basis: ${goal.success || "(not recorded)"}`,
    `Integrated result: ${run.review?.summary || run.summary || "(not recorded)"}`,
    `Changed files: ${(run.review?.changedFiles || []).join(", ") || "none"}`,
    `Tests: ${tests}`,
    "Previous target anchors:",
    formatGoalHistory(goal.history || []),
    "Inspect the integration worktree and judge the result against the stated goals. File existence, tests, and summaries are evidence leads, not proof of goal completion.",
    "Compare the current result with the previous run anchors, not only with this run's wording. Return JSON only: {\"alignment\":\"aligned|off_target|unknown\",\"progress\":\"reached|progress|no_progress|unknown\",\"continuity\":\"baseline|stable|drifted|unknown\",\"achieved\":\"one verified sentence\",\"remaining\":\"one unresolved sentence\"}."
  ].join("\n");
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, raw]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try a contained object */ }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* use fallback */ }
    }
  }
  return null;
}

function normalizePeerRequests(output, jobs = [], sourceTaskId = "") {
  const parsed = parseJsonObject(output);
  const known = new Set(jobs.map((job) => String(job?.taskId || "").trim()).filter(Boolean));
  return (Array.isArray(parsed?.peerRequests) ? parsed.peerRequests : [])
    .map((request, index) => ({
      id: cleanId(request?.id || `${sourceTaskId}-peer-${index + 1}`, `${sourceTaskId || "worker"}-peer-${index + 1}`),
      toTaskId: cleanId(request?.toTaskId || request?.targetTaskId || request?.to || ""),
      question: String(request?.question || request?.message || "").replace(/\s+/g, " ").trim().slice(0, 1600),
      why: String(request?.why || request?.reason || "").replace(/\s+/g, " ").trim().slice(0, 500),
      expect: String(request?.expect || request?.expected || "").replace(/\s+/g, " ").trim().slice(0, 500)
    }))
    .filter((request) => request.toTaskId && request.toTaskId !== sourceTaskId && known.has(request.toTaskId) && request.question)
    .slice(0, MAX_PEER_REQUESTS);
}

function normalizePeerAnswer(output) {
  const parsed = parseJsonObject(output);
  if (!parsed || typeof parsed !== "object") return null;
  const conclusion = String(parsed.conclusion || parsed.response || "").replace(/\s+/g, " ").trim().slice(0, MAX_PEER_RESPONSE_CHARS);
  if (!conclusion) return null;
  return {
    conclusion,
    evidenceRefs: [...new Set((Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter((item) => item && !/^codex:\/\//i.test(item)))].slice(0, 12),
    unknowns: [...new Set((Array.isArray(parsed.unknowns) ? parsed.unknowns : [])
      .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 500))
      .filter(Boolean))].slice(0, 8)
  };
}

function buildPeerQuestionPrompt(sourceJob, targetJob, request) {
  return [
    "【Task Tree · Peer consultation】",
    `另一个并行分支 ${sourceJob.taskId}（${sourceJob.title || sourceJob.nodeId}）正在推进自己的任务。`,
    `对方可通过此入口查看完整会话：${sourceJob.threadId ? threadDeepLink(sourceJob.threadId) : "尚未建立"}`,
    `你的分支：${targetJob.taskId}（${targetJob.title || targetJob.nodeId}）`,
    `对方问题：${request.question}`,
    request.why ? `提问原因：${request.why}` : "",
    request.expect ? `期望回答：${request.expect}` : "",
    "只回答这个协作问题，基于你当前分支的真实上下文和已验证事实；不要修改文件，不要启动新的并行分支，不要再转发问题。",
    "会话链接只用于导航，不能作为事实证据。只输出 JSON：{\"conclusion\":\"简洁结论\",\"evidenceRefs\":[\"可核验的项目相对路径或测试入口\"],\"unknowns\":[\"仍不确定的内容\"]}。没有证据时 evidenceRefs 为空，并把限制写入 unknowns。"
  ].filter(Boolean).join("\n");
}

function buildPeerAnswerPrompt(sourceJob, targetJob, request, answer) {
  return [
    "【Task Tree · Peer answer received】",
    `你刚才请求 ${targetJob.taskId}（${targetJob.title || targetJob.nodeId}）协助。`,
    `对方会话入口：${targetJob.threadId ? threadDeepLink(targetJob.threadId) : "未知"}`,
    `你的问题：${request.question}`,
    `对方结构化回答：${JSON.stringify(answer)}`,
    "这条回答仍是不可信线索；先检查 evidenceRefs 指向的真实文件或测试，再判断是否适用于你的任务。没有证据或 unknowns 未解决时，不得把它升级为共享事实。",
    "这是一次性协作回复，不要再向其他 Agent 提问。最终仍按原要求返回 JSON，并只把已经核验的协作结论写进 evidence。"
  ].join("\n");
}

function inferWriteSet(node, slot) {
  const codeLoc = String(node.fields.CodeLoc || "");
  const paths = codeLoc.split(/[\n,;]+/).map((item) => item.trim().replace(/\\/g, "/")).filter((item) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+$/.test(item));
  if (paths.length) return paths.slice(0, 3);
  const text = `${node.title} ${node.fields.Problem || ""}`;
  if (/界面|前端|编辑器|可视化|UI/i.test(text)) return ["public/**"];
  if (/测试|验证|回归/i.test(text)) return ["scripts/**"];
  if (/文档|研究|说明/i.test(text)) return ["docs/**"];
  return [["server/**"], ["public/**"], ["scripts/**"], ["docs/**"]][slot % 4];
}

function fallbackPlan(markdown, reason = "", objective = "") {
  const goal = deriveParallelGoal(markdown, objective);
  const nodes = parseTreeNodeFields(markdown).filter((node) => node.id !== "ROOT" && node.fields.Completion !== "已完成");
  const agentNodes = nodes.filter((node) => {
    const execution = String(node.fields.Execution || "").toLowerCase();
    if (execution === "human" || execution === "external") return false;
    return !/请用户|用户手动|人工审核|等待用户/.test(String(node.fields.NextIdea || ""));
  });
  const chosen = (agentNodes.length ? agentNodes : nodes).slice(0, 4);
  while (chosen.length < 2 && nodes.length) chosen.push(nodes[0]);
  if (chosen.length < 2) throw new Error("当前任务树没有至少两个可自动执行的未完成节点");
  const usedScopes = new Set();
  const fallbackScopes = ["server/**", "public/**", "scripts/**", "docs/**"];
  const jobs = chosen.slice(0, Math.max(2, Math.min(4, chosen.length))).map((node, index) => ({
    node,
    index
  })).map(({ node, index }) => {
    let writeSet = inferWriteSet(node, index);
    if (writeSet.some((scope) => usedScopes.has(scope.toLowerCase()))) {
      const replacement = fallbackScopes.find((scope) => !usedScopes.has(scope.toLowerCase()));
      if (replacement) writeSet = [replacement];
    }
    for (const scope of writeSet) usedScopes.add(scope.toLowerCase());
    return {
      taskId: cleanId(`${node.id}-${index + 1}`, `worker-${index + 1}`),
      nodeId: node.id,
      title: humanizeTitle(node.title, node.id),
      summary: conciseInstruction(node.fields.Problem || `推进${goal.immediate}`),
      instruction: String(node.fields.NextIdea || node.fields.Problem || `核验并推进 ${node.title}`).trim(),
      dependencyPrompt: "开始前确认该节点的现有接口和依赖分支已满足；没有依赖时明确写无。",
      acceptancePrompt: `说明如何证明“${node.title}”解决了当前问题，并指出仍未覆盖的目标缺口。`,
      writeSet,
      dependsOn: [],
      tests: []
    };
  });
  return {
    summary: `模型规划不可用，已生成可审核的保守草案${reason ? `：${reason}` : ""}`,
    jobs: validateParallelJobs(jobs),
    integrationTests: []
  };
}

function nextBranchTaskId(nodeId, existingJobs = []) {
  const base = cleanId(nodeId, "node");
  const used = new Set(existingJobs.map((job) => String(job?.taskId || "").toLowerCase()));
  let index = 1;
  let taskId = `${base}-branch-${index}`;
  while (used.has(taskId.toLowerCase())) {
    index += 1;
    taskId = `${base}-branch-${index}`;
  }
  return taskId;
}

function fallbackBranchPlan(markdown, nodeId, objective = "", existingJobs = [], reason = "") {
  const nodes = parseTreeNodeFields(markdown);
  const node = nodes.find((item) => item.id === cleanId(nodeId)) || nodes.find((item) => item.id !== "ROOT");
  if (!node) throw new Error("找不到要继续并行的任务节点");
  const instruction = String(node.fields.NextIdea || node.fields.Problem || node.fields.Approach || `推进${node.title}`).trim();
  const occupied = existingJobs.flatMap((job) => job.writeSet || []);
  const candidates = [inferWriteSet(node, existingJobs.length), "server/**", "public/**", "scripts/**", "docs/**"]
    .flat()
    .filter(Boolean);
  const writeSet = candidates.find((scope) => !occupied.some((item) => scopesOverlap(scope, item)))
    || `parallel/${cleanId(node.id)}-${existingJobs.length + 1}/**`;
  return {
    summary: `已按 ${node.id} 生成可审核的单分支草案${reason ? `：${reason}` : ""}`,
    job: validateParallelJobs([{
      taskId: nextBranchTaskId(node.id, existingJobs),
      nodeId: node.id,
      title: humanizeTitle(node.title, node.id),
      summary: conciseInstruction(node.fields.Problem || objective || `推进${node.title}`),
      instruction,
      dependencyPrompt: "开始前确认该节点的现有接口和依赖分支已满足；没有依赖时明确写无。",
      acceptancePrompt: `说明如何证明“${node.title}”解决了当前问题，并指出仍未覆盖的目标缺口。`,
      writeSet: [writeSet],
      dependsOn: [],
      tests: [],
      contextPolicy: "reuse"
    }], { minimum: 1, knownTaskIds: existingJobs.map((job) => job.taskId), existingJobs }).at(0)
  };
}

export function buildBranchPlannerPrompt(markdown, nodeId, objective = "", existingJobs = []) {
  const goal = deriveParallelGoal(markdown, objective);
  const nodes = parseTreeNodeFields(markdown);
  const node = nodes.find((item) => item.id === cleanId(nodeId)) || nodes.find((item) => item.id !== "ROOT");
  const fields = node?.fields || {};
  const existing = existingJobs.map((job) => `${job.taskId}: ${job.title || job.nodeId} [${(job.writeSet || []).join(", ")}]`).join("\n") || "(none)";
  return [
    "【Task Tree · Single Parallel Branch Planner】",
    "Generate exactly one new, independently reviewable worker branch for the human-selected node.",
    "Derive the branch from ROOT purpose, active-stage goals, and the selected node. Do not replace the root goal with a local implementation detail.",
    "The result is a draft for a human to edit. Give a concrete deliverable, a dependency explanation, an acceptance explanation, and a non-overlapping project-relative writeSet.",
    "A dependency explanation is for a person; dependsOn is only the machine taskId list. An acceptance explanation must say what problem is solved, what evidence to inspect, and what remains unproven.",
    "Use plain Chinese titles and short sentences. Never include task-tree.md, flow JSON, versions/, .task-tree-runs/, or .task-tree-scopes/ in writeSet.",
    `Root goal: ${goal.root || "(not recorded)"}`,
    `Active stage (${goal.stageNodeId}): ${goal.stage || "(not recorded)"}`,
    `Run goal: ${goal.immediate || "(not recorded)"}`,
    `Selected node: ${node?.id || nodeId} - ${node?.title || "unknown"}`,
    `Selected node Problem: ${compactGoalText(fields.Problem, 500)}`,
    `Selected node Approach: ${compactGoalText(fields.Approach, 700)}`,
    `Selected node NextIdea: ${compactGoalText(fields.NextIdea, 500)}`,
    "Existing branches and write scopes:",
    existing,
    "",
    "Return JSON only with this shape:",
    '{"job":{"nodeId":"N3","title":"短标题","summary":"说明该分支怎样推进根本目标","instruction":"可执行任务和结果","dependencyPrompt":"开始前要确认什么","acceptancePrompt":"如何判断问题已解决、还缺什么","writeSet":["public/**"],"dependsOn":[],"tests":[]}}'
  ].join("\n");
}

function normalizeBranchPlan(output, markdown, nodeId, objective = "", existingJobs = []) {
  const parsed = parseJsonObject(output);
  const input = parsed?.job || parsed;
  if (!input || typeof input !== "object") return fallbackBranchPlan(markdown, nodeId, objective, existingJobs, "规划结果不是有效 JSON");
  const taskId = nextBranchTaskId(nodeId, existingJobs);
  const job = validateParallelJobs([{ ...input, taskId, nodeId: input.nodeId || nodeId, contextPolicy: input.contextPolicy || "reuse" }], {
    minimum: 1,
    knownTaskIds: existingJobs.map((item) => item.taskId),
    existingJobs
  }).at(0);
  return { summary: compactGoalText(parsed.summary || "已生成一个可审核分支", 240), job };
}

function normalizePlan(output, markdown, objective = "") {
  const parsed = parseJsonObject(output);
  if (!parsed?.jobs) return fallbackPlan(markdown, "规划结果不是有效 JSON", objective);
  return {
    summary: String(parsed.summary || "自动生成的并行计划").trim(),
    jobs: validateParallelJobs(parsed.jobs),
    integrationTests: [...new Set((Array.isArray(parsed.integrationTests) ? parsed.integrationTests : []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 8)
  };
}

  function publicRun(run) {
  const planner = run.planner ? { ...run.planner } : null;
  if (planner) delete planner.output;
  const coordinator = run.coordinator ? { ...run.coordinator } : null;
  if (coordinator) delete coordinator.output;
  const supervisor = run.supervisor ? { ...run.supervisor } : null;
  if (supervisor) {
    delete supervisor.output;
    supervisor.deepLink = supervisor.threadId ? threadDeepLink(supervisor.threadId) : "";
    supervisor.messages = (supervisor.messages || []).slice(-12);
    supervisor.decisions = (supervisor.decisions || []).slice(-8);
  }
  return {
    id: run.id,
    status: run.status,
    objective: run.objective || "",
    goal: run.goal || null,
    summary: run.summary || "",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    approvedAt: run.approvedAt || "",
    finishedAt: run.finishedAt || "",
    error: run.error || "",
    planner,
    jobs: (run.jobs || []).map(({ output, workerPath, commit, sourceCommit, ...job }) => ({
      ...job,
      reportChars: output?.length || 0,
      deepLink: job.threadId ? threadDeepLink(job.threadId) : ""
    })),
    peerMessages: (run.peerMessages || []).map((message) => ({
      ...message,
      fromDeepLink: message.fromThreadId ? threadDeepLink(message.fromThreadId) : "",
      toDeepLink: message.toThreadId ? threadDeepLink(message.toThreadId) : ""
    })),
    contextOptions: run.contextOptions || [],
    integrationTests: run.integrationTests || [],
    integrationTestResults: run.integrationTestResults || [],
    coordinator,
    supervisor,
    executionTree: runtimeTree(run),
    events: (run.events || []).slice(-40),
    review: run.review || null,
    deepLink: run.coordinator?.threadId ? threadDeepLink(run.coordinator.threadId) : ""
  };
}

export function createParallelCodexCoordinator({
  projectRoot,
  startTurn = startCodexTurn,
  archiveThread = archiveCodexThread,
  scopeStore = createExecutionScopeStore({ projectRoot }),
  workspace = createGitWorkspaceManager({ projectRoot }),
  onAccepted = async () => null
} = {}) {
  const runs = new Map();
  const pending = new Map();
  const background = new Map();
  const supervisorTurns = new Map();
  const runsDir = path.join(projectRoot, ".task-tree-runs");
  const systemContextsFile = path.join(runsDir, "system-contexts");
  let systemContextsPromise = null;
  let persistQueue = Promise.resolve();

  async function readSystemContexts() {
    if (!systemContextsPromise) {
      systemContextsPromise = readFile(systemContextsFile, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => ({}));
    }
    return systemContextsPromise;
  }

  async function rememberPlannerThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const contexts = await readSystemContexts();
    contexts.planner = { threadId: id, updatedAt: new Date().toISOString() };
    await mkdir(runsDir, { recursive: true });
    await writeFile(systemContextsFile, `${JSON.stringify(contexts, null, 2)}\n`, "utf8");
  }

  async function plannerThreadId() {
    const contexts = await readSystemContexts();
    if (contexts.planner?.threadId) return String(contexts.planner.threadId);
    try {
      const names = (await readdir(runsDir)).filter((name) => name.endsWith(".json"));
      const records = await Promise.all(names.map(async (name) => {
        try {
          return JSON.parse(await readFile(path.join(runsDir, name), "utf8"));
        } catch {
          return null;
        }
      }));
      const prior = records
        .filter((run) => run?.planner?.threadId)
        .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))[0];
      if (prior?.planner?.threadId) {
        await rememberPlannerThread(prior.planner.threadId);
        return String(prior.planner.threadId);
      }
    } catch {
      // A missing run history only means the first planning turn starts a system thread.
    }
    return "";
  }

  function event(run, type, data = {}) {
    run.events ||= [];
    run.events.push({ id: randomUUID(), at: new Date().toISOString(), type, ...data });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  function persist(run) {
    run.updatedAt = new Date().toISOString();
    const snapshot = `${JSON.stringify(run, null, 2)}\n`;
    const executionTreeSnapshot = `${JSON.stringify(runtimeTree(run), null, 2)}\n`;
    const next = persistQueue.catch(() => {}).then(async () => {
      await mkdir(runsDir, { recursive: true });
      const target = path.join(runsDir, `${run.id}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      let lastError;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rename(temporary, target);
          const executionTreeDir = path.join(runsDir, run.id);
          await mkdir(executionTreeDir, { recursive: true });
          await writeFile(path.join(executionTreeDir, "execution-tree.json"), executionTreeSnapshot, "utf8");
          await updateContextIndex(run).catch(() => {});
          return;
        } catch (error) {
          lastError = error;
          if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
      if (["EPERM", "EACCES", "EBUSY"].includes(lastError?.code)) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await writeFile(target, snapshot, "utf8");
            await updateContextIndex(run).catch(() => {});
            await unlink(temporary).catch(() => {});
            return;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          }
        }
      }
      await unlink(temporary).catch(() => {});
      throw lastError;
    });
    persistQueue = next;
    return next;
  }

  async function updateContextIndex(run) {
    const target = path.join(runsDir, "context-index.json");
    let index = { version: 1, contexts: {} };
    try {
      const parsed = JSON.parse(await readFile(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) index = { version: 1, contexts: parsed.contexts || {} };
    } catch {
      // The first context is expected to create this index.
    }
    for (const job of run.jobs || []) {
      const current = buildParallelContextOption(run, job, { allowActive: true });
      if (!current) continue;
      const key = current.contextKey;
      const archived = Array.isArray(job.contextHistory) ? job.contextHistory : [];
      index.contexts[key] = {
        ...current,
        archived: archived.map((item) => ({
          generation: Number(item.generation) || 1,
          threadId: String(item.threadId || ""),
          status: "archived",
          handoffPath: String(item.handoffPath || "")
        })).filter((item) => item.threadId),
        updatedAt: new Date().toISOString()
      };
    }
    index.updatedAt = new Date().toISOString();
    await writeFile(target, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  async function load(id) {
    if (runs.has(id)) return runs.get(id);
    try {
      const run = JSON.parse(await readFile(path.join(runsDir, `${id}.json`), "utf8"));
      runs.set(id, run);
      return run;
    } catch {
      return null;
    }
  }

  function ensureSupervisor(run) {
    run.supervisor ||= {
      status: "idle",
      threadId: "",
      turnId: "",
      rounds: 0,
      paused: false,
      lastDecision: "",
      error: "",
      messages: [],
      decisions: []
    };
    run.supervisor.messages ||= [];
    run.supervisor.decisions ||= [];
    return run.supervisor;
  }

  async function appendSupervisorJobs(run, decision) {
    if (decision.newJobs.length > MAX_SUPERVISOR_JOBS_PER_ROUND) throw new Error("Supervisor 单轮新增任务过多");
    if (run.jobs.length + decision.newJobs.length > MAX_SUPERVISOR_JOBS) throw new Error("本轮运行任务已达到安全上限，需要用户审核");
    const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
    const validNodeIds = new Set(parseTreeNodeFields(markdown).map((node) => node.id));
    const validParentIds = new Set(["RUN", ...run.jobs.map((job) => job.taskId), ...decision.newJobs.map((job) => cleanId(job?.taskId || job?.id)).filter(Boolean)]);
    for (const job of decision.newJobs) {
      if (!validNodeIds.has(cleanId(job?.nodeId))) throw new Error(`Supervisor 新任务引用了不存在的树节点：${job?.nodeId || "(empty)"}`);
      if (job?.parentTaskId && !validParentIds.has(cleanId(job.parentTaskId))) throw new Error(`Supervisor 新任务引用了不存在的运行树父节点：${job.parentTaskId}`);
      if (!compactGoalText(job?.summary, 400)) throw new Error(`Supervisor 新任务 ${job?.taskId || "(unknown)"} 没有说明对目标的贡献`);
      if (!compactGoalText(job?.acceptancePrompt, 520)) throw new Error(`Supervisor 新任务 ${job?.taskId || "(unknown)"} 没有验收说明`);
    }
    const liveJobs = run.jobs.filter((job) => job.status !== "completed");
    const validated = validateParallelJobs(decision.newJobs, {
      minimum: 1,
      knownTaskIds: run.jobs.map((job) => job.taskId),
      existingJobs: liveJobs
    });
    const rawById = new Map(decision.newJobs.map((job) => [cleanId(job?.taskId || job?.id), job]));
    const appended = executionContexts(validated, run.jobs, run.contextOptions || [], {
      minimum: 1,
      knownTaskIds: run.jobs.map((job) => job.taskId),
      existingJobs: liveJobs
    }).map((job) => ({
      ...job,
      parentTaskId: cleanId(rawById.get(job.taskId)?.parentTaskId) || "RUN",
      supervisorRound: Number(run.supervisor.rounds) || 1,
      status: "queued",
      threadId: job.contextThreadId || "",
      turnId: "",
      changedFiles: [],
      testResults: [],
      error: ""
    }));
    run.jobs.push(...appended);
    event(run, "supervisor_jobs_added", { taskIds: appended.map((job) => job.taskId), round: run.supervisor.rounds });
    return appended;
  }

  async function supervise(run) {
    const supervisor = ensureSupervisor(run);
    if (supervisor.paused) {
      supervisor.status = "paused";
      run.status = "paused";
      await persist(run);
      return { action: "paused", newTaskIds: [] };
    }
    if (supervisor.rounds >= MAX_SUPERVISOR_ROUNDS) {
      supervisor.status = "waiting_user";
      supervisor.lastDecision = "已达到自动调度轮次上限，需要用户决定是否继续。";
      run.status = "waiting_user";
      await persist(run);
      return { action: "waiting_user", newTaskIds: [] };
    }

    const previous = supervisorTurns.get(run.id) || Promise.resolve();
    const turn = previous.catch(() => {}).then(async () => {
      const queuedMessages = supervisor.messages.filter((message) => message.status === "queued");
      queuedMessages.forEach((message) => { message.status = "delivering"; });
      supervisor.status = "running";
      supervisor.error = "";
      supervisor.rounds += 1;
      run.status = "supervising";
      event(run, "supervisor_started", { round: supervisor.rounds, messages: queuedMessages.length });
      await persist(run);
      try {
        const result = await startTurn({
          prompt: buildSupervisorPrompt(run, queuedMessages),
          cwd: run.workspace.integrationPath,
          threadId: supervisor.threadId || "",
          threadName: `任务图 · 总控 · ${humanizeTitle(run.goal?.immediate, "自动并行")}`,
          sandbox: "read-only",
          approvalPolicy: "never",
          developerInstructions: "Supervise this approved run from provided structured state. Do not edit files, task-tree state, flow state, or run metadata. Return JSON only.",
          waitForCompletion: true,
          completionTimeoutMs: PLANNER_TIMEOUT_MS,
          onAccepted: async ({ threadId, turnId }) => {
            supervisor.threadId = threadId;
            supervisor.turnId = turnId;
            event(run, "supervisor_turn_started", { threadId, round: supervisor.rounds });
            await persist(run);
          }
        });
        supervisor.threadId = result.threadId;
        supervisor.turnId = result.turnId;
        supervisor.output = String(result.output || "").slice(0, MAX_REPORT_CHARS);
        queuedMessages.forEach((message) => { message.status = "delivered"; message.deliveredAt = new Date().toISOString(); });
        const decision = normalizeSupervisorDecision(result.output);
        supervisor.lastDecision = decision.summary || decision.reason || decision.action;
        supervisor.decisions.push({
          at: new Date().toISOString(),
          round: supervisor.rounds,
          action: decision.action,
          summary: decision.summary,
          reason: decision.reason,
          taskIds: decision.newJobs.map((job) => cleanId(job?.taskId || job?.id)).filter(Boolean)
        });
        supervisor.decisions = supervisor.decisions.slice(-MAX_SUPERVISOR_MESSAGES);

        if (supervisor.messages.some((message) => message.status === "queued")) {
          supervisor.status = "running";
          supervisor.lastDecision = "已收到新的用户消息，正在同一总控对话中重新决策。";
          event(run, "supervisor_message_followup", { round: supervisor.rounds });
          await persist(run);
          return { action: "continue", newTaskIds: [] };
        }

        if (decision.action === "continue") {
          if (!decision.newJobs.length) throw new Error("Supervisor 要求继续，但没有给出可执行任务");
          const appended = await appendSupervisorJobs(run, decision);
          supervisor.status = "running";
          event(run, "supervisor_continued", { taskIds: appended.map((job) => job.taskId), round: supervisor.rounds });
          await persist(run);
          return { action: "continue", newTaskIds: appended.map((job) => job.taskId) };
        }
        if (decision.action === "waiting_user") {
          supervisor.status = "waiting_user";
          supervisor.lastDecision = decision.messageToUser || supervisor.lastDecision;
          run.status = "waiting_user";
          event(run, "supervisor_waiting_user", { reason: supervisor.lastDecision, round: supervisor.rounds });
          await persist(run);
          return { action: "waiting_user", newTaskIds: [] };
        }
        supervisor.status = "completed";
        event(run, "supervisor_finished", { round: supervisor.rounds, summary: supervisor.lastDecision });
        await persist(run);
        return { action: "finish", newTaskIds: [] };
      } catch (error) {
        queuedMessages.forEach((message) => { if (message.status === "delivering") message.status = "queued"; });
        supervisor.status = "waiting_user";
        supervisor.error = error.message;
        supervisor.lastDecision = `总控无法继续自动调度：${error.message}`;
        run.status = "waiting_user";
        event(run, "supervisor_failed", { error: error.message, round: supervisor.rounds });
        await persist(run);
        return { action: "waiting_user", newTaskIds: [] };
      }
    });
    supervisorTurns.set(run.id, turn);
    try {
      return await turn;
    } finally {
      if (supervisorTurns.get(run.id) === turn) supervisorTurns.delete(run.id);
    }
  }

  async function finalizeSupervisorReview(run, integration, coordinatorOutput, followup = 0) {
    const supervisor = ensureSupervisor(run);
    const queuedMessages = supervisor.messages.filter((message) => message.status === "queued");
    queuedMessages.forEach((message) => { message.status = "delivering"; });
    supervisor.status = "finalizing";
    event(run, "supervisor_finalizing", { messages: queuedMessages.length });
    await persist(run);
    try {
      const result = await startTurn({
        prompt: buildSupervisorFinalPrompt(run, integration, coordinatorOutput),
        cwd: run.workspace.integrationPath,
        threadId: supervisor.threadId || "",
        threadName: `任务图 · 总控 · ${humanizeTitle(run.goal?.immediate, "自动并行")}`,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: "Give the final user-facing review for this supervised run. Do not edit files or state. Return JSON only.",
        waitForCompletion: true,
        completionTimeoutMs: PLANNER_TIMEOUT_MS,
        onAccepted: async ({ threadId, turnId }) => {
          supervisor.threadId = threadId;
          supervisor.turnId = turnId;
          await persist(run);
        }
      });
      supervisor.threadId = result.threadId;
      supervisor.turnId = result.turnId;
      supervisor.output = String(result.output || "").slice(0, MAX_REPORT_CHARS);
      const report = parseJsonObject(supervisor.output) || {};
      supervisor.lastDecision = compactGoalText(report.summary || "并行执行已完成，等待结束审核。", 240);
      supervisor.status = "completed";
      queuedMessages.forEach((message) => { message.status = "delivered"; message.deliveredAt = new Date().toISOString(); });
      event(run, "supervisor_finalized", { summary: supervisor.lastDecision });
      await persist(run);
      if (followup < 3 && supervisor.messages.some((message) => message.status === "queued")) {
        return finalizeSupervisorReview(run, integration, supervisor.output, followup + 1);
      }
      return supervisor.output;
    } catch (error) {
      queuedMessages.forEach((message) => { if (message.status === "delivering") message.status = "queued"; });
      supervisor.status = "failed";
      supervisor.error = error.message;
      event(run, "supervisor_final_review_failed", { error: error.message });
      await persist(run);
      return coordinatorOutput;
    }
  }

  async function runWorker(run, job, integrate) {
    let scope = null;
    let workerHandoffStaged = false;
    try {
      job.status = "preparing";
      event(run, "worker_preparing", { taskId: job.taskId, nodeId: job.nodeId });
      await persist(run);
      job.sourceCommit = await workspace.head(run.workspace.integrationPath);
      job.workerPath = await workspace.createWorker(run.id, job.taskId, job.sourceCommit, {
        contextKey: job.contextKey,
        persistentContext: true
      });
      scope = await scopeStore.create({
        runId: run.id,
        role: "worker",
        targetNodeIds: [job.nodeId],
        writableNodeIds: [],
        writeSet: job.writeSet,
        instruction: job.instruction
      });
      job.scopeId = scope.scopeId;
      job.contextPersistent = true;
      const rotateContext = shouldRotateContext(job);
      let handoffPath = "";
      if (rotateContext) {
        const handoff = await writeContextHandoff(runsDir, run, job);
        handoffPath = await stageWorkerHandoff(job.workerPath, handoff.content);
        workerHandoffStaged = true;
        job.parentThreadId = job.contextThreadId || job.threadId || "";
        job.contextHistory = [...(Array.isArray(job.contextHistory) ? job.contextHistory : []), {
          generation: Number(job.contextGeneration) || 1,
          threadId: job.contextThreadId || job.threadId || "",
          status: "archived",
          handoffPath: handoff.archivePath
        }].slice(-8);
        job.contextGeneration = (Number(job.contextGeneration) || 1) + 1;
        job.contextHandoffPath = handoff.archivePath;
        job.contextStatus = "rotating";
        job.contextThreadId = "";
        job.threadId = "";
        event(run, "context_rotation_started", {
          taskId: job.taskId,
          generation: job.contextGeneration,
          parentThreadId: job.parentThreadId,
          handoffPath: handoff.archivePath,
          workerHandoffPath: handoffPath
        });
      }
      job.status = "running";
      event(run, "worker_started", { taskId: job.taskId, nodeId: job.nodeId });
      await persist(run);

      const result = await startTurn({
        prompt: buildWorkerPrompt(job, scope, handoffPath, run.jobs),
        cwd: job.workerPath,
        threadId: job.contextSource === "codex" ? "" : (job.contextThreadId || ""),
        forkThreadId: job.contextSource === "codex" ? (job.contextThreadId || "") : "",
        forceNewThread: rotateContext,
        threadName: `任务图 · 并行 ${String(run.jobs.indexOf(job) + 1).padStart(2, "0")} · ${humanizeTitle(job.title, job.taskId)}`,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        developerInstructions: "Implement only the assigned task inside its isolated worktree and declared write scope. Never modify task-tree or flow state.",
        environment: executionScopeEnvironment(scope),
        waitForCompletion: true,
        onAccepted: async ({ threadId, turnId }) => {
          job.threadId = threadId;
          job.contextThreadId = threadId;
          job.contextSource = "parallel";
          job.turnId = turnId;
          job.contextResumed = false;
          job.contextStatus = "active";
          rememberRunContext(run, job);
          event(run, "worker_turn_started", { taskId: job.taskId, nodeId: job.nodeId, threadId });
          await persist(run);
        }
      });
      job.threadId = result.threadId;
      job.contextThreadId = result.threadId;
      job.contextSource = "parallel";
      job.contextResumed = Boolean(result.resumed);
      job.contextStatus = "active";
      if (result.tokenUsage) {
        job.contextUsage = result.tokenUsage;
        job.contextUsagePercent = result.tokenUsage.percent;
        if (result.tokenUsage.percent !== null && result.tokenUsage.percent >= CONTEXT_SOFT_THRESHOLD) {
          job.contextStatus = result.tokenUsage.percent >= CONTEXT_ROTATE_THRESHOLD ? "ready_to_rotate" : "near_limit";
          event(run, "context_usage_updated", { taskId: job.taskId, generation: job.contextGeneration, percent: result.tokenUsage.percent, status: job.contextStatus });
        }
      }
      job.contextCompactions = Number(job.contextCompactions || 0) + Number(result.contextCompactions || 0);
      if (rotateContext && job.parentThreadId) {
        try {
          await archiveThread(job.parentThreadId);
          job.contextArchivedAt = new Date().toISOString();
          event(run, "context_archived", { taskId: job.taskId, threadId: job.parentThreadId, generation: job.contextGeneration - 1 });
        } catch (error) {
          job.contextArchiveWarning = error.message;
          event(run, "context_archive_failed", { taskId: job.taskId, threadId: job.parentThreadId, error: error.message });
        }
      }
      rememberRunContext(run, job);
      job.turnId = result.turnId;
      job.output = String(result.output || "").slice(0, MAX_REPORT_CHARS);
      job.evidence = compactGoalText(parseJsonObject(job.output)?.evidence || job.output, 600);
      job.peerRequests = normalizePeerRequests(job.output, run.jobs, job.taskId);
      if (job.peerRequests.length) {
        for (const request of job.peerRequests) {
          event(run, "peer_requested", {
            fromTaskId: job.taskId,
            toTaskId: request.toTaskId,
            requestId: request.id
          });
        }
      }

      if (workerHandoffStaged) {
        await removeWorkerHandoff(job.workerPath);
        workerHandoffStaged = false;
      }

      const inspected = await workspace.inspectChanges(job.workerPath, job.sourceCommit, job.writeSet);
      job.changedFiles = inspected.changedFiles;
      if (inspected.violations.length) throw new Error(`worker 越出写集：${inspected.violations.join(", ")}`);
      job.testResults = await workspace.runTests(job.workerPath, job.tests);
      if (job.testResults.some((test) => !test.ok)) throw new Error("worker 测试失败，改动未进入 integration");
      job.commit = await workspace.commit(job.workerPath, `parallel ${job.taskId}`, job.sourceCommit);
      await integrate(job.commit, job.sourceCommit);
      job.status = "completed";
      event(run, "completed", { taskId: job.taskId, nodeId: job.nodeId, changedFiles: job.changedFiles });
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      if (error.threadId) {
        job.threadId = error.threadId;
        job.contextThreadId = error.threadId;
        rememberRunContext(run, job);
      }
      event(run, "blocked", { taskId: job.taskId, nodeId: job.nodeId, error: error.message });
    } finally {
      if (workerHandoffStaged && job.workerPath) await removeWorkerHandoff(job.workerPath).catch(() => {});
      if (scope) await scopeStore.close(scope.scopeId).catch(() => {});
      if (job.workerPath) await workspace.removeWorker(job.workerPath, { preserveContext: true, contextKey: job.contextKey }).catch(() => {});
      delete job.workerPath;
      await persist(run);
    }
  }

  async function execute(run, { retryTaskIds = null, taskIds = null } = {}) {
    try {
      run.status = run.workspace?.integrationPath ? "running" : "preparing";
      run.error = "";
      run.review = null;
      run.finishedAt = "";
      if (!run.workspace?.integrationPath) {
        event(run, "snapshot_started");
        await persist(run);
        run.workspace = await workspace.prepare(run.id);
        run.status = "running";
        event(run, "run_started", { snapshotCommit: run.workspace.snapshotCommit });
      } else {
        event(run, "retry_started", { taskIds: retryTaskIds || [] });
      }
      await persist(run);

      let integrationQueue = Promise.resolve();
      const integrate = (commit, sourceCommit) => {
        const next = integrationQueue.then(() => workspace.integrate(run.workspace.integrationPath, commit, sourceCommit));
        integrationQueue = next.catch(() => {});
        return next;
      };

      async function relayPeerRequests() {
        const jobsById = new Map(run.jobs.map((job) => [job.taskId, job]));
        const handled = new Set((run.peerMessages || []).map((message) => message.id));
        const requests = run.jobs.flatMap((job) => (job.peerRequests || [])
          .filter((request) => !handled.has(request.id))
          .map((request) => ({ source: job, request })));
        if (!requests.length) return;
        run.peerMessages ||= [];

        for (const { source, request } of requests.slice(0, MAX_PEER_MESSAGES)) {
          const target = jobsById.get(request.toTaskId);
          const message = {
            id: request.id,
            fromTaskId: source.taskId,
            toTaskId: request.toTaskId,
            fromThreadId: source.contextThreadId || source.threadId || "",
            toThreadId: target?.contextThreadId || target?.threadId || "",
            question: request.question,
            why: request.why,
            expect: request.expect,
            status: "queued",
            response: "",
            evidenceRefs: [],
            unknowns: [],
            error: "",
            createdAt: new Date().toISOString()
          };
          run.peerMessages.push(message);
          run.peerMessages = run.peerMessages.slice(-MAX_PEER_MESSAGES);
          await persist(run);

          let targetPath = "";
          let sourcePath = "";
          let sourceScope = null;
          try {
            if (source.status !== "completed") throw new Error("提问分支没有完成初始工作，不能发起续接");
            if (!target || target.status !== "completed") throw new Error("目标分支没有完成初始工作，无法回答");
            if (!target.contextThreadId) throw new Error("目标分支没有可复用的 Codex 会话");
            if (!source.contextThreadId) throw new Error("提问分支没有可继续的 Codex 会话");

            const targetBase = await workspace.head(run.workspace.integrationPath);
            targetPath = await workspace.createWorker(run.id, target.taskId, targetBase, {
              contextKey: target.contextKey,
              persistentContext: true
            });
            const answer = await startTurn({
              prompt: buildPeerQuestionPrompt(source, target, request),
              cwd: targetPath,
              threadId: target.contextThreadId,
              sandbox: "read-only",
              approvalPolicy: "never",
              developerInstructions: "Answer one peer consultation from the existing branch context. Do not edit files or delegate.",
              waitForCompletion: true,
              completionTimeoutMs: PLANNER_TIMEOUT_MS
            });
            target.threadId = answer.threadId;
            target.contextThreadId = answer.threadId;
            target.contextResumed = true;
            target.contextStatus = "active";
            if (answer.tokenUsage) {
              target.contextUsage = answer.tokenUsage;
              target.contextUsagePercent = answer.tokenUsage.percent;
            }
            message.toThreadId = answer.threadId;
            const normalizedAnswer = normalizePeerAnswer(answer.output);
            if (!normalizedAnswer) throw new Error("peer 回答不是带 evidenceRefs/unknowns 的结构化 JSON");
            message.response = normalizedAnswer.conclusion;
            message.evidenceRefs = normalizedAnswer.evidenceRefs;
            message.unknowns = normalizedAnswer.unknowns;
            message.status = "answered";
            event(run, "peer_answered", { requestId: message.id, fromTaskId: message.fromTaskId, toTaskId: message.toTaskId });
          } catch (error) {
            message.status = "failed";
            message.error = error.message;
            event(run, "peer_failed", { requestId: message.id, fromTaskId: message.fromTaskId, toTaskId: message.toTaskId, error: error.message });
          } finally {
            if (targetPath) await workspace.removeWorker(targetPath, { preserveContext: true }).catch(() => {});
          }

          if (message.status === "answered") {
            try {
              const sourceBase = await workspace.head(run.workspace.integrationPath);
              sourcePath = await workspace.createWorker(run.id, source.taskId, sourceBase, {
                contextKey: source.contextKey,
                persistentContext: true
              });
              sourceScope = await scopeStore.create({
                runId: run.id,
                role: "peer-continuation",
                targetNodeIds: [source.nodeId],
                writableNodeIds: [],
                writeSet: source.writeSet,
                instruction: "使用另一个并行分支的回答完成一次受限续接"
              });
              const continuation = await startTurn({
                prompt: buildPeerAnswerPrompt(source, target, request, {
                  conclusion: message.response,
                  evidenceRefs: message.evidenceRefs,
                  unknowns: message.unknowns
                }),
                cwd: sourcePath,
                threadId: source.contextThreadId,
                sandbox: "workspace-write",
                approvalPolicy: "never",
                developerInstructions: "Continue only the assigned worker task using the peer answer. Do not edit task-tree or flow state and do not ask another peer.",
                environment: executionScopeEnvironment(sourceScope),
                waitForCompletion: true,
                completionTimeoutMs: PLANNER_TIMEOUT_MS
              });
              source.threadId = continuation.threadId;
              source.contextThreadId = continuation.threadId;
              source.contextResumed = true;
              source.contextStatus = "active";
              source.turnId = continuation.turnId;
              if (continuation.tokenUsage) {
                source.contextUsage = continuation.tokenUsage;
                source.contextUsagePercent = continuation.tokenUsage.percent;
              }
              const inspected = await workspace.inspectChanges(sourcePath, sourceBase, source.writeSet);
              if (inspected.violations.length) throw new Error(`peer 续接越出写集：${inspected.violations.join(", ")}`);
              const continuationTests = await workspace.runTests(sourcePath, source.tests);
              if (continuationTests.some((test) => !test.ok)) throw new Error("peer 续接后的分支测试失败");
              source.testResults = continuationTests;
              source.changedFiles = [...new Set([...(source.changedFiles || []), ...inspected.changedFiles])].sort();
              source.commit = await workspace.commit(sourcePath, `peer continuation ${source.taskId}`, sourceBase);
              await integrate(source.commit, sourceBase);
              source.peerMessages ||= [];
              source.peerMessages.push({
                requestId: message.id,
                fromTaskId: target.taskId,
                response: message.response,
                evidenceRefs: message.evidenceRefs,
                unknowns: message.unknowns,
                status: "answered"
              });
              event(run, "peer_continued", { requestId: message.id, taskId: source.taskId, changedFiles: inspected.changedFiles });
            } catch (error) {
              message.status = "failed";
              message.error = `提问分支续接失败：${error.message}`;
              source.status = "failed";
              source.error = message.error;
              event(run, "peer_continuation_failed", { requestId: message.id, taskId: source.taskId, error: error.message });
            } finally {
              if (sourceScope) await scopeStore.close(sourceScope.scopeId).catch(() => {});
              if (sourcePath) await workspace.removeWorker(sourcePath, { preserveContext: true }).catch(() => {});
            }
          }
          await persist(run);
        }
      }
      const initialJobIds = new Set(run.jobs.map((job) => job.taskId));
      const restrictedIds = retryTaskIds
        ? new Set(retryTaskIds)
        : taskIds
          ? new Set(taskIds)
          : null;
      const queued = new Set(run.jobs
        .filter((job) => ["queued", "planned"].includes(job.status)
          && (!restrictedIds || restrictedIds.has(job.taskId)))
        .map((job) => job.taskId));
      const active = new Map();

      while (queued.size || active.size || run.jobs.some((job) => ["queued", "planned"].includes(job.status))) {
        const byId = new Map(run.jobs.map((job) => [job.taskId, job]));
        // New jobs appended through the API enter this same scheduler. During a retry,
        // only jobs that did not exist when the retry started are admitted dynamically.
        for (const job of run.jobs) {
          if (!active.has(job.taskId)
            && ["queued", "planned"].includes(job.status)
            && (!restrictedIds || !initialJobIds.has(job.taskId))) {
            queued.add(job.taskId);
          }
        }
        for (const taskId of [...queued]) {
          const job = byId.get(taskId);
          if (!job) {
            queued.delete(taskId);
            continue;
          }
          if (job.dependsOn.some((id) => ["failed", "blocked"].includes(byId.get(id)?.status))) {
            job.status = "blocked";
            job.error = "依赖任务失败";
            queued.delete(taskId);
            event(run, "blocked", { taskId, nodeId: job.nodeId, error: job.error });
          }
        }
        const ready = [...queued].filter((taskId) => byId.get(taskId).dependsOn.every((id) => byId.get(id)?.status === "completed"));
        while (ready.length && active.size < MAX_WORKERS) {
          const taskId = ready.shift();
          queued.delete(taskId);
          const promise = runWorker(run, byId.get(taskId), integrate).then(() => taskId);
          active.set(taskId, promise);
        }
        if (!active.size && queued.size) {
          for (const taskId of queued) {
            const job = byId.get(taskId);
            job.status = "blocked";
            job.error = "没有可执行的依赖前沿";
          }
          queued.clear();
          break;
        }
        if (active.size) {
          const finished = await Promise.race(active.values());
          active.delete(finished);
        }
      }
      await integrationQueue;
      await relayPeerRequests();
      await integrationQueue;

      const supervision = await supervise(run);
      if (supervision.action === "continue") {
        return execute(run, { taskIds: supervision.newTaskIds });
      }
      if (["paused", "waiting_user"].includes(supervision.action)) {
        return publicRun(run);
      }
      const queuedAfterSupervision = run.jobs.filter((job) => ["queued", "planned"].includes(job.status)).map((job) => job.taskId);
      if (queuedAfterSupervision.length) return execute(run, { taskIds: queuedAfterSupervision });

      run.status = "coordinating";
      run.coordinator = { status: "running", threadId: "", turnId: "", error: "" };
      event(run, "coordinator_started");
      await persist(run);
      const coordinatorScope = await scopeStore.create({
        runId: run.id,
        role: "coordinator",
        targetNodeIds: [...new Set(run.jobs.map((job) => job.nodeId))],
        writableNodeIds: [],
        writeSet: run.jobs.flatMap((job) => job.writeSet),
        instruction: "核验并集成并行 worker 的隔离改动"
      });
      try {
        const result = await startTurn({
          prompt: buildCoordinatorPrompt(run.jobs, coordinatorScope, run.goal),
          cwd: run.workspace.integrationPath,
          threadName: "任务图 · 并行汇总",
          sandbox: "workspace-write",
          approvalPolicy: "never",
          developerInstructions: "Verify and repair only the integrated implementation. Never edit task-tree, flow state, version history, or run metadata.",
          environment: executionScopeEnvironment(coordinatorScope),
          waitForCompletion: true,
          onAccepted: async ({ threadId, turnId }) => {
            run.coordinator = { ...run.coordinator, scopeId: coordinatorScope.scopeId, threadId, turnId };
            event(run, "coordinator_turn_started", { threadId });
            await persist(run);
          }
        });
        run.coordinator = {
          status: "completed",
          scopeId: coordinatorScope.scopeId,
          threadId: result.threadId,
          turnId: result.turnId,
          error: "",
          output: String(result.output || "").slice(0, MAX_REPORT_CHARS)
        };
      } finally {
        await scopeStore.close(coordinatorScope.scopeId).catch(() => {});
      }
      const coordinatorChanges = await workspace.inspectChanges(
        run.workspace.integrationPath,
        run.workspace.snapshotCommit,
        run.jobs.flatMap((job) => job.writeSet)
      );
      if (coordinatorChanges.violations.length) {
        throw new Error(`coordinator 越出批准写集：${coordinatorChanges.violations.join(", ")}`);
      }
      await workspace.commit(run.workspace.integrationPath, `parallel integration ${run.id.slice(0, 8)}`, run.workspace.snapshotCommit);
      run.integrationTestResults = await workspace.runTests(run.workspace.integrationPath, run.integrationTests);
      const summary = await workspace.summarize(run.workspace.integrationPath, run.workspace.snapshotCommit);
      const finalSupervisorOutput = await finalizeSupervisorReview(run, {
        changedFiles: summary.changedFiles,
        stat: summary.stat,
        tests: run.integrationTestResults
      }, run.coordinator.output);
      const parsedCoordinator = parseJsonObject(finalSupervisorOutput) || {};
      const goalAssessment = normalizeGoalAssessment(parsedCoordinator.goalAssessment);
      const testsPassed = run.integrationTestResults.every((test) => test.ok);
      const failedTasks = run.jobs.filter((job) => job.status !== "completed").map((job) => job.taskId);
      const readyByImplementation = failedTasks.length === 0 && testsPassed && summary.changedFiles.length > 0;
      run.review = {
        ...summary,
        readyToAccept: readyByImplementation && goalAssessmentAllowsAccept(goalAssessment, run.goal?.history),
        summary: String(parsedCoordinator.summary || run.summary || "并行结果已完成隔离集成").trim(),
        affectedNodes: [...new Set(Array.isArray(parsedCoordinator.affectedNodes) ? parsedCoordinator.affectedNodes.map(cleanId).filter(Boolean) : run.jobs.map((job) => job.nodeId))],
        evidence: String(parsedCoordinator.evidence || "").trim(),
        goalAssessment,
        failedTasks,
        warnings: [
          ...(run.supervisor?.status === "failed" ? [`总控最终反馈失败：${run.supervisor.error}`] : []),
          ...(failedTasks.length ? [`${failedTasks.length} 个分支未完成，接受操作已锁定`] : []),
          ...(testsPassed ? [] : ["集成测试仍有失败，接受操作已锁定"]),
          ...(goalAssessment.alignment === "off_target" ? ["结果偏离本轮目标，接受操作已锁定"] : []),
          ...(goalAssessment.alignment === "unknown" ? ["目标一致性无法判断，接受操作已锁定"] : []),
          ...(goalAssessment.alignment === "aligned" && ["no_progress", "unknown"].includes(goalAssessment.progress) ? ["尚无可验证的目标推进，接受操作已锁定"] : []),
          ...(goalAssessment.continuity === "drifted" ? ["长期目标发生漂移，接受操作已锁定"] : []),
          ...(goalAssessment.continuity === "unknown" ? ["长期目标连续性无法判断，接受操作已锁定"] : []),
          ...(goalAssessment.continuity === "baseline" && run.goal?.history?.length ? ["已有历史运行，不能把本轮当作首次基线，接受操作已锁定"] : [])
        ]
      };
      run.status = "review";
      run.finishedAt = new Date().toISOString();
      event(run, "review_ready", { changedFiles: summary.changedFiles, readyToAccept: run.review.readyToAccept });
      const appendedTaskIds = run.jobs
        .filter((job) => ["queued", "planned"].includes(job.status))
        .map((job) => job.taskId);
      if (appendedTaskIds.length) {
        event(run, "append_continuation", { taskIds: appendedTaskIds });
        await persist(run);
        return execute(run, { taskIds: appendedTaskIds });
      }
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      if (run.coordinator?.status === "running") run.coordinator = { ...run.coordinator, status: "failed", error: error.message };
      event(run, "run_failed", { error: error.message });
    }
    await persist(run);
    return publicRun(run);
  }

  async function generatePlan(run, objective) {
    const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
    run.objective = cleanObjective(objective);
    run.goal = deriveParallelGoal(markdown, objective);
    run.goal.history = await readGoalHistory(runsDir, run.id);
    run.contextOptions = await readContextOptions(runsDir, run.id);
    try {
      const result = await startTurn({
        prompt: buildPlannerPrompt(markdown, objective, run.goal.history),
        cwd: projectRoot,
        threadId: await plannerThreadId(),
        threadName: "任务图 · 自动规划（系统）",
        ...(PLANNER_MODEL ? { model: PLANNER_MODEL } : {}),
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: "All required context is already in the prompt. Do not call tools, inspect files, or edit state. Return only the JSON execution plan.",
        waitForCompletion: true,
        completionTimeoutMs: PLANNER_TIMEOUT_MS,
        totalTimeoutMs: PLANNER_TIMEOUT_MS
      });
      const plan = normalizePlan(result.output, markdown, objective);
      await rememberPlannerThread(result.threadId);
      run.summary = plan.summary;
      run.jobs = assignParallelDraftContexts(plan.jobs, run.contextOptions).map((job) => ({ ...job, status: "planned", threadId: "", turnId: "", changedFiles: [], testResults: [], error: "" }));
      run.integrationTests = plan.integrationTests;
      run.planner = { status: "completed", threadId: result.threadId, turnId: result.turnId, contextResumed: Boolean(result.resumed), error: "", output: String(result.output || "").slice(0, MAX_REPORT_CHARS) };
    } catch (error) {
      let plan;
      try {
        plan = fallbackPlan(markdown, error.message, objective);
      } catch (fallbackError) {
        run.status = "failed";
        run.error = fallbackError.message;
        run.planner = { status: "failed", threadId: error.threadId || "", turnId: error.turnId || "", error: fallbackError.message };
        event(run, "planning_failed", { error: fallbackError.message });
        await persist(run);
        return publicRun(run);
      }
      run.summary = plan.summary;
      run.jobs = assignParallelDraftContexts(plan.jobs, run.contextOptions).map((job) => ({ ...job, status: "planned", threadId: "", turnId: "", changedFiles: [], testResults: [], error: "" }));
      run.integrationTests = plan.integrationTests;
      run.planner = { status: "fallback", threadId: error.threadId || "", turnId: error.turnId || "", error: error.message };
    }
    run.status = "draft";
    event(run, "draft_ready", { jobs: run.jobs.map((job) => job.taskId) });
    await persist(run);
    return publicRun(run);
  }

  async function recoverAbandonedPlan(run) {
    if (run.status !== "planning" || pending.has(run.id)) return run;
    const lastUpdate = Date.parse(run.updatedAt || run.createdAt || "");
    if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < ABANDONED_PLANNING_MS) return run;

    try {
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      run.goal ||= deriveParallelGoal(markdown, run.objective);
      run.goal.history ||= await readGoalHistory(runsDir, run.id);
      run.contextOptions = await readContextOptions(runsDir, run.id);
      const plan = fallbackPlan(markdown, "规划任务已中断，已自动恢复", run.objective);
      run.summary = plan.summary;
      run.jobs = assignParallelDraftContexts(plan.jobs, run.contextOptions).map((job) => ({ ...job, status: "planned", threadId: "", turnId: "", changedFiles: [], testResults: [], error: "" }));
      run.integrationTests = plan.integrationTests;
      run.planner = { status: "fallback", threadId: run.planner?.threadId || "", turnId: run.planner?.turnId || "", error: "规划任务已中断" };
      run.status = "draft";
      event(run, "planning_recovered", { jobs: run.jobs.map((job) => job.taskId) });
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      run.planner = { status: "failed", threadId: run.planner?.threadId || "", turnId: run.planner?.turnId || "", error: error.message };
      event(run, "planning_failed", { error: error.message });
    }
    await persist(run);
    return run;
  }

  async function recoverAbandonedExecution(run) {
    if (pending.has(run.id) || !["approved", "preparing", "running", "supervising", "coordinating"].includes(run.status)) return run;
    if (!run.workspace?.integrationPath) {
      run.status = "draft";
      run.jobs = (run.jobs || []).map((job) => ({ ...job, status: "planned", threadId: "", turnId: "", error: "" }));
      run.summary = "上次启动在隔离区准备完成前中断，请重新确认开始";
      event(run, "execution_reset_after_restart");
      await persist(run);
      return run;
    }

    const unfinished = (run.jobs || []).filter((job) => job.status !== "completed");
    if (!unfinished.length) {
      run.status = "approved";
      run.coordinator = { ...(run.coordinator || {}), status: "queued", error: "" };
      event(run, "coordinator_resume_queued");
      await persist(run);
      const promise = Promise.resolve()
        .then(() => execute(run, { retryTaskIds: [] }))
        .finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return run;
    }

    try {
      const summary = await workspace.summarize(run.workspace.integrationPath, run.workspace.snapshotCommit);
      run.jobs = (run.jobs || []).map((job) => job.status === "completed" ? job : {
        ...job,
        status: "failed",
        error: "运行服务曾中断，请重跑此分支",
        threadId: job.threadId || "",
        turnId: job.turnId || ""
      });
      const failedTasks = run.jobs.filter((job) => job.status !== "completed").map((job) => job.taskId);
      run.status = "review";
      run.finishedAt = new Date().toISOString();
      run.review = {
        ...summary,
        readyToAccept: false,
        summary: "运行服务曾中断；已保留完成分支，可只重跑未完成分支",
        affectedNodes: [...new Set(run.jobs.map((job) => job.nodeId))],
        evidence: "",
        failedTasks,
        warnings: [`${failedTasks.length} 个分支需要重跑，接受操作已锁定`]
      };
      if (run.coordinator?.status === "running") run.coordinator = { ...run.coordinator, status: "failed", error: "运行服务曾中断" };
      event(run, "execution_recovered", { failedTasks });
    } catch (error) {
      run.status = "failed";
      run.error = `运行服务曾中断，隔离结果无法恢复：${error.message}`;
      event(run, "run_failed", { error: run.error });
    }
    await persist(run);
    return run;
  }

  function implementationReady(run) {
    const testsPassed = (run.integrationTestResults || []).every((test) => test.ok);
    const failedTasks = (run.review?.failedTasks || []).length;
    return failedTasks === 0 && testsPassed && (run.review?.changedFiles || []).length > 0;
  }

  function goalWarnings(assessment, history = []) {
    const value = normalizeGoalAssessment(assessment);
    if (value.alignment === "off_target") return ["结果偏离本轮目标，接受操作已锁定"];
    if (value.alignment === "unknown") return ["目标一致性无法判断，接受操作已锁定"];
    if (["no_progress", "unknown"].includes(value.progress)) return ["尚无可验证的目标推进，接受操作已锁定"];
    if (value.continuity === "drifted") return ["长期目标发生漂移，接受操作已锁定"];
    if (value.continuity === "unknown") return ["长期目标连续性无法判断，接受操作已锁定"];
    if (value.continuity === "baseline" && history.length) return ["已有历史运行，不能把本轮当作首次基线，接受操作已锁定"];
    return [];
  }

  async function ensureGoalState(run) {
    let changed = false;
    if (!run.goal?.immediate) {
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      run.goal = deriveParallelGoal(markdown, run.objective);
      changed = true;
    }
    if (run.goal && !Array.isArray(run.goal.history)) {
      run.goal.history = await readGoalHistory(runsDir, run.id);
      changed = true;
    }
    if (run.status === "review" && run.review && !run.review.goalAssessment) {
      run.review.goalAssessment = normalizeGoalAssessment(null);
      run.review.readyToAccept = false;
      run.review.warnings = [...new Set([...(run.review.warnings || []), ...goalWarnings(run.review.goalAssessment, run.goal?.history)])];
      changed = true;
    }
    if (changed) await persist(run);
    return run;
  }

  function scheduleBackground(runId, operation) {
    if (background.has(runId)) return background.get(runId);
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => background.delete(runId));
    background.set(runId, promise);
    return promise;
  }

  async function runGoalAudit(run) {
    try {
      const result = await startTurn({
        prompt: buildGoalAuditPrompt(run),
        cwd: run.workspace.integrationPath,
        threadName: `任务图 · 目标核验 · ${humanizeTitle(run.goal?.immediate, "当前任务")}`,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: "Audit goal alignment from the integration worktree. Do not edit files or task-tree state. Return JSON only.",
        waitForCompletion: true,
        completionTimeoutMs: 3 * 60 * 1000,
        onAccepted: async ({ threadId, turnId }) => {
          run.review.goalAudit = { status: "running", threadId, turnId, error: "" };
          await persist(run);
        }
      });
      const assessment = normalizeGoalAssessment(parseJsonObject(result.output));
      run.review.goalAssessment = assessment;
      run.review.goalAudit = { status: "completed", threadId: result.threadId, turnId: result.turnId, error: "" };
      run.review.warnings = [
        ...(run.review.warnings || []).filter((warning) => !/目标一致性|偏离本轮目标|可验证的目标推进|长期目标/.test(warning)),
        ...goalWarnings(assessment, run.goal?.history)
      ];
      run.review.readyToAccept = implementationReady(run) && goalAssessmentAllowsAccept(assessment, run.goal?.history);
      event(run, "goal_audit_completed", { alignment: assessment.alignment, progress: assessment.progress });
    } catch (error) {
      run.review.goalAssessment = normalizeGoalAssessment(null);
      run.review.goalAudit = { status: "failed", threadId: error.threadId || "", turnId: error.turnId || "", error: error.message };
      run.review.readyToAccept = false;
      run.review.warnings = [...new Set([...(run.review.warnings || []), `目标核验失败：${error.message}`])];
      event(run, "goal_audit_failed", { error: error.message });
    }
    run.status = "review";
    await persist(run);
    return publicRun(run);
  }

  async function finalizeAcceptedRun(run) {
    if (["queued", "running"].includes(run.review?.treeSync?.status)) {
      run.review.treeSync = { ...run.review.treeSync, status: "running", error: "" };
      event(run, "tree_sync_started");
      await persist(run);
      try {
        run.review.treeSync = await onAccepted({ run, appliedFiles: run.review.appliedFiles || [] });
      } catch (error) {
        run.review.treeSync = { status: "failed", error: error.message };
        run.review.warnings = [...new Set([...(run.review.warnings || []), `代码已应用，但任务树自动同步失败：${error.message}`])];
      }
      event(run, "tree_sync_finished", { status: run.review.treeSync?.status || "unknown" });
      await persist(run);
    }
    if (["queued", "running"].includes(run.review?.cleanup?.status)) {
      run.review.cleanup = { status: "running", error: "" };
      await persist(run);
      try {
        await workspace.cleanup({ ...run.workspace, runId: run.id });
        run.review.cleanup = { status: "completed", error: "" };
      } catch (error) {
        run.review.cleanup = { status: "failed", error: error.message };
      }
      await persist(run);
    }
    return publicRun(run);
  }

  async function recoverAcceptedFinalization(run) {
    if (run.status !== "accepted" || background.has(run.id)) return run;
    const needsSync = ["queued", "running"].includes(run.review?.treeSync?.status);
    const needsCleanup = ["queued", "running"].includes(run.review?.cleanup?.status);
    if (needsSync || needsCleanup) scheduleBackground(run.id, () => finalizeAcceptedRun(run));
    return run;
  }

  return {
    async plan({ objective = "" } = {}) {
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(),
        status: "planning",
        objective: cleanObjective(objective),
        summary: "",
        createdAt: now,
        updatedAt: now,
        error: "",
        planner: { status: "running", threadId: "", turnId: "", error: "" },
        jobs: [],
        contextOptions: [],
        integrationTests: [],
        coordinator: null,
        supervisor: { status: "idle", threadId: "", turnId: "", rounds: 0, paused: false, lastDecision: "", error: "", messages: [], decisions: [] },
        events: [],
        peerMessages: []
      };
      runs.set(run.id, run);
      event(run, "planning_started");
      await persist(run);
      const promise = Promise.resolve().then(() => generatePlan(run, objective)).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return publicRun(run);
    },

    async branchPlan(id, { nodeId = "", objective = "", existingJobs = [] } = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (["accepted", "rejected", "auditing"].includes(run.status)) {
        throw new Error("当前并行运行已经结束或正在核验，不能新增分支");
      }
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      const submittedJobs = Array.isArray(existingJobs) && existingJobs.length ? existingJobs : (run.jobs || []);
      const liveJobs = submittedJobs.filter((job) => job.status !== "completed");
      const selectedNodeId = cleanId(nodeId || run.goal?.stageNodeId);
      try {
        const result = await startTurn({
          prompt: buildBranchPlannerPrompt(markdown, selectedNodeId, objective || run.objective, liveJobs),
          cwd: projectRoot,
          threadId: await plannerThreadId(),
          threadName: "任务图 · 自动规划（系统）",
          ...(PLANNER_MODEL ? { model: PLANNER_MODEL } : {}),
          sandbox: "read-only",
          approvalPolicy: "never",
          developerInstructions: "All required context is already in the prompt. Do not call tools, inspect files, or edit state. Return exactly one JSON branch draft.",
          waitForCompletion: true,
          completionTimeoutMs: PLANNER_TIMEOUT_MS,
          totalTimeoutMs: PLANNER_TIMEOUT_MS
        });
        const proposal = normalizeBranchPlan(result.output, markdown, selectedNodeId, objective || run.objective, liveJobs);
        await rememberPlannerThread(result.threadId);
        return { ...proposal, planner: { status: "completed", threadId: result.threadId, turnId: result.turnId, contextResumed: Boolean(result.resumed) } };
      } catch (error) {
        return {
          ...fallbackBranchPlan(markdown, selectedNodeId, objective || run.objective, liveJobs, error.message),
          planner: { status: "fallback", error: error.message }
        };
      }
    },

    async approve(id, changes = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (run.status !== "draft") throw new Error("只能批准待审核的并行草案");
      run.contextOptions = mergeContextOptions(await readContextOptions(runsDir, run.id), run.contextOptions || []);
      const approvedJobs = executionContexts(changes.jobs || run.jobs, run.jobs, run.contextOptions);
      run.jobs = approvedJobs.map((job) => ({ ...job, status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], testResults: [], error: "" }));
      if (changes.objective !== undefined) {
        run.objective = cleanObjective(changes.objective);
        const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
        run.goal = deriveParallelGoal(markdown, run.objective);
        run.goal.history = await readGoalHistory(runsDir, run.id);
      }
      if (changes.summary !== undefined) run.summary = String(changes.summary || "").trim();
      if (changes.integrationTests) run.integrationTests = [...new Set(changes.integrationTests.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 8);
      run.status = "approved";
      run.approvedAt = new Date().toISOString();
      event(run, "approved");
      await persist(run);
      const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return publicRun(run);
    },

    async retry(id, changes = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (run.status !== "review") throw new Error("只能从结束审核重跑失败分支");
      if (!run.workspace?.integrationPath) throw new Error("这次运行的隔离工作区已不存在，请重新规划");

      const retryableIds = new Set(run.jobs.filter((job) => job.status !== "completed").map((job) => job.taskId));
      if (!retryableIds.size) throw new Error("当前没有需要重跑的失败分支");
      run.contextOptions = mergeContextOptions(await readContextOptions(runsDir, run.id), run.contextOptions || []);
      const proposed = executionContexts(changes.jobs || run.jobs, run.jobs, run.contextOptions);
      const proposedIds = new Set(proposed.map((job) => job.taskId));
      if (proposedIds.size !== run.jobs.length || run.jobs.some((job) => !proposedIds.has(job.taskId))) {
        throw new Error("失败分支重跑不能新增、删除或改名任务");
      }
      const proposedById = new Map(proposed.map((job) => [job.taskId, job]));
      run.jobs = run.jobs.map((job) => {
        if (!retryableIds.has(job.taskId)) return job;
        const next = proposedById.get(job.taskId);
        return {
          ...job,
          ...next,
          status: "queued",
          threadId: next.contextThreadId || "",
          turnId: "",
          contextResumed: false,
          output: "",
          changedFiles: [],
          testResults: [],
          error: "",
          commit: "",
          sourceCommit: "",
          scopeId: ""
        };
      });
      if (changes.integrationTests) {
        run.integrationTests = [...new Set(changes.integrationTests.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 8);
      }
      run.retryCount = Number(run.retryCount || 0) + 1;
      run.status = "approved";
      run.approvedAt = new Date().toISOString();
      event(run, "retry_approved", { taskIds: [...retryableIds] });
      await persist(run);
      const promise = Promise.resolve().then(() => execute(run, { retryTaskIds: [...retryableIds] })).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return publicRun(run);
    },

    async append(id, changes = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      const jobsInput = Array.isArray(changes.jobs) ? changes.jobs : [];
      if (!jobsInput.length) throw new Error("至少要添加 1 个并行分支");
      if (["accepted", "rejected"].includes(run.status)) {
        throw new Error("这次并行运行已经结束，请重新开始一轮");
      }
      if (["auditing"].includes(run.status)) {
        throw new Error("目标核验进行中，完成后再添加分支");
      }

      const existingIds = new Set(run.jobs.map((job) => job.taskId.toLowerCase()));
      const duplicate = jobsInput.find((job) => existingIds.has(cleanId(job?.taskId || job?.id).toLowerCase()));
      if (duplicate) throw new Error(`任务不能重复：${duplicate.taskId || duplicate.id}`);
      const liveJobs = run.jobs.filter((job) => job.status !== "completed");
      const validated = validateParallelJobs(jobsInput, {
        minimum: 1,
        knownTaskIds: run.jobs.map((job) => job.taskId),
        existingJobs: liveJobs
      });
      run.contextOptions = mergeContextOptions(await readContextOptions(runsDir, run.id), run.contextOptions || []);
      const appended = executionContexts(validated, run.jobs, run.contextOptions, {
        minimum: 1,
        knownTaskIds: run.jobs.map((job) => job.taskId),
        existingJobs: liveJobs
      }).map((job) => ({
        ...job,
        status: "queued",
        threadId: job.contextThreadId || "",
        turnId: "",
        changedFiles: [],
        testResults: [],
        error: ""
      }));
      run.jobs.push(...appended);
      const appendedTaskIds = appended.map((job) => job.taskId);
      event(run, "branches_appended", { taskIds: appendedTaskIds, nodeIds: appended.map((job) => job.nodeId) });

      if (run.status === "draft") {
        await persist(run);
        return publicRun(run);
      }

      if (["coordinating"].includes(run.status)) {
        // The current coordinator finishes its review first; execute() will pick
        // these queued jobs up immediately afterward in the same run.
        await persist(run);
        return publicRun(run);
      }

      if (!["approved", "preparing", "running", "supervising", "waiting_user", "paused", "review", "failed"].includes(run.status)) {
        throw new Error(`当前状态不能添加分支：${run.status}`);
      }
      const paused = run.status === "paused" || run.supervisor?.paused;
      const shouldStart = !paused && (run.status === "review" || run.status === "failed" || run.status === "waiting_user" || !pending.has(run.id));
      if (["review", "failed", "waiting_user"].includes(run.status)) {
        run.status = "approved";
        run.review = null;
        run.error = "";
        run.finishedAt = "";
      }
      await persist(run);
      if (shouldStart) {
        const promise = Promise.resolve().then(() => execute(run, { taskIds: appendedTaskIds })).finally(() => pending.delete(run.id));
        pending.set(run.id, promise);
      }
      return publicRun(run);
    },

    // Backward-compatible API: supplied jobs still get a draft record, then enter the same state machine.
    async start(input) {
      const now = new Date().toISOString();
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      const run = {
        id: randomUUID(), status: "draft", objective: "", summary: "手动提供的并行计划", createdAt: now, updatedAt: now, error: "",
        goal: { ...deriveParallelGoal(markdown), history: await readGoalHistory(runsDir) },
        planner: { status: "manual", threadId: "", turnId: "", error: "" },
        jobs: validateParallelJobs(input).map((job) => ({ ...job, status: "planned", threadId: "", turnId: "", changedFiles: [], testResults: [], error: "" })),
        integrationTests: [], coordinator: null,
        supervisor: { status: "idle", threadId: "", turnId: "", rounds: 0, paused: false, lastDecision: "", error: "", messages: [], decisions: [] },
        events: [], peerMessages: []
      };
      runs.set(run.id, run);
      await persist(run);
      return this.approve(run.id);
    },

    async get(id) {
      const run = await load(id);
      if (!run) return null;
      await recoverAbandonedPlan(run);
      await recoverAbandonedExecution(run);
      await ensureGoalState(run);
      await recoverAcceptedFinalization(run);
      if (run.status === "draft" && !(run.contextOptions || []).length) {
        const recovered = await readContextOptions(runsDir, run.id);
        if (recovered.length) {
          run.contextOptions = recovered;
          run.jobs = assignParallelDraftContexts(run.jobs || [], recovered);
          await persist(run);
        }
      }
      return publicRun(run);
    },

    async supervisorMessage(id, text) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (["accepted", "rejected"].includes(run.status)) throw new Error("这次并行运行已经结束");
      const message = cleanObjective(text);
      if (!message) throw new Error("消息不能为空");
      const supervisor = ensureSupervisor(run);
      supervisor.messages.push({ id: randomUUID(), text: message, status: "queued", createdAt: new Date().toISOString() });
      supervisor.messages = supervisor.messages.slice(-MAX_SUPERVISOR_MESSAGES);
      event(run, "supervisor_message_queued", { messageId: supervisor.messages.at(-1).id });
      await persist(run);
      if (!supervisor.paused && !pending.has(run.id) && !supervisorTurns.has(run.id)) {
        run.review = null;
        run.finishedAt = "";
        const promise = Promise.resolve().then(() => execute(run, { taskIds: [] })).finally(() => pending.delete(run.id));
        pending.set(run.id, promise);
      }
      return publicRun(run);
    },

    async pause(id) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (["accepted", "rejected"].includes(run.status)) throw new Error("这次并行运行已经结束");
      const supervisor = ensureSupervisor(run);
      supervisor.paused = true;
      supervisor.status = "paused";
      event(run, "supervisor_paused");
      await persist(run);
      return publicRun(run);
    },

    async resume(id) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (["accepted", "rejected"].includes(run.status)) throw new Error("这次并行运行已经结束");
      const supervisor = ensureSupervisor(run);
      supervisor.paused = false;
      supervisor.status = "idle";
      event(run, "supervisor_resumed");
      await persist(run);
      if (!pending.has(run.id) && !supervisorTurns.has(run.id)) {
        run.review = null;
        run.finishedAt = "";
        const promise = Promise.resolve().then(() => execute(run, { taskIds: [] })).finally(() => pending.delete(run.id));
        pending.set(run.id, promise);
      }
      return publicRun(run);
    },

    async openSupervisor(id) {
      const run = await load(id);
      const supervisor = run ? ensureSupervisor(run) : null;
      if (!supervisor?.threadId) {
        const error = new Error("总控对话还没有建立");
        error.code = "THREAD_NOT_READY";
        throw error;
      }
      return { threadId: supervisor.threadId, deepLink: threadDeepLink(supervisor.threadId) };
    },

    async openThread(id, taskId) {
      const run = await load(id);
      const job = run?.jobs?.find((item) => item.taskId === taskId);
      if (!job?.threadId) {
        const error = new Error("这个分支的 Codex 对话还没有建立");
        error.code = "THREAD_NOT_READY";
        throw error;
      }
      return { threadId: job.threadId, deepLink: threadDeepLink(job.threadId) };
    },

    async wait(id) {
      if (pending.has(id)) return pending.get(id);
      if (background.has(id)) return background.get(id);
      return this.get(id);
    },

    async audit(id) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      await ensureGoalState(run);
      if (run.status !== "review") throw new Error("只能核验待审核的并行结果");
      if (!run.workspace?.integrationPath) throw new Error("隔离工作区已不存在，无法核验目标");
      run.status = "auditing";
      run.review.readyToAccept = false;
      run.review.goalAudit = { status: "queued", threadId: "", turnId: "", error: "" };
      event(run, "goal_audit_queued");
      await persist(run);
      scheduleBackground(run.id, () => runGoalAudit(run));
      return publicRun(run);
    },

    async accept(id) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (run.status !== "review") throw new Error("只能接受待审核的并行结果");
      if (!run.review?.readyToAccept || !goalAssessmentAllowsAccept(run.review?.goalAssessment, run.goal?.history)) throw new Error("实现或目标一致性尚未通过验收，不能接受");
      const applied = await workspace.accept({
        integrationPath: run.workspace.integrationPath,
        snapshotCommit: run.workspace.snapshotCommit,
        changedFiles: run.review.changedFiles
      });
      run.review.appliedFiles = applied.appliedFiles;
      run.review.treeSync = { status: "queued", threadId: "", turnId: "", error: "" };
      run.review.cleanup = { status: "queued", error: "" };
      run.status = "accepted";
      run.acceptedAt = new Date().toISOString();
      event(run, "accepted", { appliedFiles: applied.appliedFiles });
      await persist(run);
      scheduleBackground(run.id, () => finalizeAcceptedRun(run));
      return publicRun(run);
    },

    async reject(id) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (run.status !== "review") throw new Error("只能拒绝待审核的并行结果");
      run.status = "rejected";
      run.rejectedAt = new Date().toISOString();
      event(run, "rejected");
      await workspace.cleanup({ ...run.workspace, runId: run.id }).catch((error) => { run.review.cleanupWarning = error.message; });
      await persist(run);
      return publicRun(run);
    },

    async drain() {
      let rounds = 0;
      while ((pending.size || background.size) && rounds < 20) {
        rounds += 1;
        await Promise.allSettled([...pending.values(), ...background.values()]);
      }
      await persistQueue.catch(() => {});
    }
  };
}
