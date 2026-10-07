import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveCodexThread, startCodexTurn, threadDeepLink } from "./codex-run.js";
import { CONTEXT_ROTATE_THRESHOLD, CONTEXT_SOFT_THRESHOLD } from "./context-policy.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";
import { parseTreeNodeFields } from "./tree-quality.js";

// Planner context is supplied explicitly in the prompt. Reusing an ever-growing
// conversation made the first response increasingly slow. Keep the turn short
// and fail fast so a wedged app-server request cannot block the whole run.
const PLANNER_TIMEOUT_MS = Math.max(30_000, Number(process.env.TASK_TREE_PLANNER_TIMEOUT_MS) || 90_000);
// Keep planning on the same high-quality model requested for implementation. Planning
// still uses a separate effort because a small structured decomposition does not need
// the xhigh setting that previously exhausted the whole completion timeout.
const PLANNER_MODEL = String(process.env.TASK_TREE_PLANNER_MODEL || "deepseek-v4.1-flash").trim();
const PLANNER_REASONING_EFFORT = String(process.env.TASK_TREE_PLANNER_REASONING_EFFORT || "low").trim();
const ABANDONED_PLANNING_MS = PLANNER_TIMEOUT_MS + 5 * 1000;
const WORKER_HANDOFF_PATH = ".task-tree-context/handoff.json";
const CONTEXT_POLICIES = new Set(["reuse", "new", "selected"]);

function parsePlannerEnv(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, index).trim()] = value;
  }
  return values;
}

async function deepSeekPlannerConfig(projectRoot) {
  let fileEnv = {};
  try { fileEnv = parsePlannerEnv(await readFile(path.join(projectRoot, ".env"), "utf8")); } catch {}
  const env = { ...fileEnv, ...process.env };
  const baseUrl = String(env.TASK_TREE_PLANNER_BASE_URL || env.MODEL_AGENT_MAIN_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.TASK_TREE_PLANNER_API_KEY || env.MODEL_AGENT_MAIN_API_KEY || "").trim();
  const model = String(env.TASK_TREE_PLANNER_MODEL || env.MODEL_AGENT_MAIN_MODEL || PLANNER_MODEL).trim();
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

async function requestDeepSeekPlanner({ projectRoot, prompt, outputSchema }) {
  const config = await deepSeekPlannerConfig(projectRoot);
  if (!config) return null;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "你是任务拆分器。只返回符合要求的 JSON，不调用工具，不解释过程。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 3000,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`DeepSeek 返回非 JSON：${raw.slice(0, 300)}`); }
    if (!response.ok) throw new Error(data?.error?.message || `DeepSeek HTTP ${response.status}`);
    const output = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!output) throw new Error("DeepSeek 返回空计划");
    return {
      output,
      threadId: `deepseek-planner-${randomUUID()}`,
      turnId: `deepseek-turn-${randomUUID()}`,
      resumed: false,
      timing: { provider: "deepseek", model: config.model, completedMs: Date.now() - startedAt, outputChars: output.length },
      outputSchema
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`DeepSeek Planner 超时（${Math.round(PLANNER_TIMEOUT_MS / 1000)}s）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "coverage", "jobs"],
  properties: {
    summary: { type: "string", minLength: 1 },
    coverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["goal", "taskIds"],
        properties: {
          goal: { type: "string", minLength: 1 },
          taskIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
        }
      }
    },
    jobs: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "nodeId", "title", "instruction", "writeSet", "dependsOn"],
        properties: {
          taskId: { type: "string", minLength: 1 },
          nodeId: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          instruction: { type: "string", minLength: 1 },
          writeSet: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } }
        }
      }
    }
  }
};
const BRANCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["job"],
  properties: {
    job: {
      ...PLANNER_OUTPUT_SCHEMA.properties.jobs.items
    }
  }
};

function cleanId(value, fallback = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function cleanObjective(value) {
  return String(value || "").trim();
}

function compactGoalText(value) {
  return String(value || "").trim();
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
      dependsOn: job.dependsOn || [],
      threadId: job.contextThreadId || job.threadId || "",
      evidence: compactGoalText(job.evidence || job.error || "", 180)
    })),
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
  const durableRun = ["accepted", "failed"].includes(String(run?.status || ""));
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
    lastOutput: String(job?.output || job?.contextResult || ""),
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
  return [...merged.values()].reverse();
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

function parsePlannerEdges(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const edges = [];
  let inEdges = false;
  let edge = null;
  const flush = () => {
    if (edge?.endpoints?.length >= 2) edges.push(edge);
    edge = null;
  };
  for (const line of lines) {
    if (/^# Edges\s*$/.test(line)) {
      inEdges = true;
      continue;
    }
    if (!inEdges) continue;
    const heading = line.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (heading) {
      flush();
      edge = { id: heading[1], title: heading[2].trim(), endpoints: [], label: "" };
      continue;
    }
    if (!edge) continue;
    const endpoints = line.match(/^-\s+Endpoints:\s*(.+)$/);
    if (endpoints) {
      edge.endpoints = endpoints[1].split(",").map((item) => cleanId(item)).filter(Boolean);
      continue;
    }
    const label = line.match(/^-\s+Label:\s*(.*)$/);
    if (label) edge.label = label[1].trim();
  }
  flush();
  return edges;
}

function plannerNodeRecord(node) {
  if (!node) return null;
  const allowed = [
    "Completion", "Problem", "Approach", "Input", "Output", "Metrics", "Notes",
    "CodeLoc", "CurrentResult", "RootCauseAnalysis", "CaseStudy", "NextIdea",
    "SelectedSkills", "Folded", "SubtreeFile", "SubtreeCount"
  ];
  const fields = Object.fromEntries(allowed
    .filter((field) => String(node.fields?.[field] || "").trim())
    .map((field) => [field, String(node.fields[field]).trim()]));
  return { id: node.id, title: node.title, fields };
}

export function buildPlannerContext(markdown, objective = "") {
  const nodes = parseTreeNodeFields(markdown);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const goal = deriveParallelGoal(markdown, objective);
  const currentNodeId = cleanId(graphStateValue(markdown, "Current"));
  const focusIds = new Set(["ROOT", currentNodeId, goal.stageNodeId].filter(Boolean));
  const edgeAnchors = new Set([currentNodeId, goal.stageNodeId].filter(Boolean));
  const allEdges = parsePlannerEdges(markdown);
  const relatedEdges = allEdges.filter((edge) => edge.endpoints.some((id) => edgeAnchors.has(id)));
  const relatedNodeIds = new Set();
  for (const edge of relatedEdges) {
    for (const endpoint of edge.endpoints) {
      if (!focusIds.has(endpoint)) relatedNodeIds.add(endpoint);
    }
  }
  return {
    rootGoal: goal.root,
    currentNodeId,
    activeStageNodeId: goal.stageNodeId,
    activeStageGoal: goal.stage,
    runGoal: goal.immediate,
    successBasis: goal.success,
    focusNodes: [...focusIds].map((id) => plannerNodeRecord(byId.get(id))).filter(Boolean),
    relatedNodes: [...relatedNodeIds].map((id) => {
      const node = byId.get(id);
      if (!node) return null;
      return {
        id: node.id,
        title: node.title,
        completion: String(node.fields?.Completion || "").trim(),
        currentResult: String(node.fields?.CurrentResult || "").trim()
      };
    }).filter(Boolean),
    relatedEdges
  };
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
  return {
    runId: cleanId(run?.id),
    status: String(run?.status || "").trim(),
    failures: [...(run?.planningFailures || []), ...(run?.jobs || []).filter((job) => job.error).map((job) => ({ nodeId: job.nodeId, taskId: job.taskId, error: job.error, output: job.output || "" }))],
    root: compactGoalText(goal.root, 120),
    stage: compactGoalText(goal.stage, 120),
    immediate: compactGoalText(goal.immediate || run?.objective, 140),
    result: compactGoalText(run?.result?.summary || run?.summary, 140),
    jobs: (run?.jobs || []).map(({ taskId, nodeId, instruction, output, error }) => ({ taskId, nodeId, instruction, output, error }))
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
      .filter((run) => run && run.id !== excludeRunId && run.goal)
      .sort((left, right) => Date.parse(left.updatedAt || left.createdAt || "") - Date.parse(right.updatedAt || right.createdAt || ""))
      .map(compactGoalHistoryItem);
  } catch {
    return [];
  }
}

function formatGoalHistory(history = []) {
  const selected = history
    .filter((item) => item.status === "failed" || item.result || item.immediate)
    .slice(-3)
    .map((item) => ({
      runId: item.runId,
      status: item.status,
      runGoal: item.immediate,
      result: item.result,
      failures: (item.failures || []).map(plannerFailureSummary)
    }));
  return selected.length ? JSON.stringify(selected) : "(no relevant previous run)";
}

function humanizeTitle(value, fallback = "并行任务") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim();
  return text
    .replace(/业务场景代理夹具/g, "业务测试场景")
    .replace(/根目标语义回归/g, "目标一致性校验")
    .replace(/状态同步提示契约/g, "状态同步规则")
    .replace(/契约/g, "规则")
    .replace(/夹具/g, "测试场景")
    .replace(/语义回归/g, "目标校验");
}

function conciseInstruction(value) {
  return String(value || "").trim();
}

function normalizeScope(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
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

export function validateParallelJobs(input, { minimum = 1, knownTaskIds = [], existingJobs = [] } = {}) {
  if (!Array.isArray(input) || input.length < minimum) {
    throw new Error(minimum <= 1 ? "至少需要 1 个 worker" : "并行运行至少需要 2 个 worker");
  }

  const seenTasks = new Set();
  const jobs = input.map((job, index) => {
    const nodeId = cleanId(job?.nodeId);
    const taskId = cleanId(job?.taskId || job?.id || nodeId, `worker-${index + 1}`);
    const instruction = String(job?.instruction || "").trim();
    if (!nodeId) throw new Error(`worker ${index + 1} 缺少 nodeId`);
    if (seenTasks.has(taskId.toLowerCase())) throw new Error(`任务不能重复：${taskId}`);
    if (!instruction) throw new Error(`worker ${taskId} 缺少任务说明`);
    seenTasks.add(taskId.toLowerCase());

    const writeSet = [...new Set((Array.isArray(job.writeSet) ? job.writeSet : []).map(normalizeScope).filter(Boolean))];

    return {
      id: taskId,
      taskId,
      nodeId,
      title: humanizeTitle(job.title, conciseInstruction(instruction)),
      instruction,
      branchContext: String(job.branchContext || ""),
      summary: conciseInstruction(job.summary || instruction),
      dependencyPrompt: compactGoalText(job.dependencyPrompt, 420),
      acceptancePrompt: compactGoalText(job.acceptancePrompt, 520),
      writeSet,
      dependsOn: [...new Set((Array.isArray(job.dependsOn) ? job.dependsOn : []).map((item) => cleanId(item)).filter(Boolean))],
      contextPolicy: CONTEXT_POLICIES.has(job.contextPolicy) ? job.contextPolicy : "reuse",
      contextKey: cleanId(job.contextKey) || deriveParallelContextKey({ nodeId, writeSet }),
      contextThreadId: String(job.contextThreadId || "").trim(),
      contextSource: String(job.contextSource || "").trim() || "parallel",
      contextLabel: contextLabel({ ...job, nodeId, taskId }),
      contextPreview: String(job.contextPreview || ""),
      contextResult: String(job.contextResult || ""),
      runtimeMetadataPath: String(job.runtimeMetadataPath || "")
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
      contextResult: match?.option.lastOutput || job.contextResult || "",
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

  const ownerByContext = new Map((validationOptions.existingJobs || []).map((job) => [job.contextKey, job.taskId]));
  const ownerByThread = new Map((validationOptions.existingJobs || []).filter((job) => job.contextThreadId).map((job) => [job.contextThreadId, job.taskId]));
  for (const job of resolved) {
    const owner = ownerByContext.get(job.contextKey);
    if (owner || ownerByThread.has(job.contextThreadId)) {
      job.contextKey = `${job.contextKey}-${job.taskId}-${randomUUID()}`;
      if (job.contextThreadId) job.contextSource = "codex"; // Fork shared history; never run two turns on the same thread.
    }
    ownerByContext.set(job.contextKey, job.title || job.taskId);
    if (job.contextThreadId) {
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
    currentResult: String(job.output || job.contextResult || job.contextPreview || ""),
    changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles : [],
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

function plannerFailureSummary(failure = {}) {
  const parsed = parseJsonObject(failure.output);
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  return {
    nodeId: cleanId(failure.nodeId),
    taskId: cleanId(failure.taskId),
    error: String(failure.error || "").trim(),
    outputShape: parsed ? {
      keys: Object.keys(parsed),
      jobCount: jobs.length,
      taskIds: jobs.map((job) => cleanId(job?.taskId || job?.id)).filter(Boolean)
    } : {
      validJson: false,
      outputChars: String(failure.output || "").length
    }
  };
}

function formatPlannerFailures(failures = []) {
  const selected = failures.slice(-4).map(plannerFailureSummary);
  return selected.length ? JSON.stringify(selected) : "(none)";
}

export function buildPlannerPrompt(markdown, objective = "", history = []) {
  const context = buildPlannerContext(markdown, objective);
  return [
    "【Task Tree · Automatic Parallel Planner】",
    "只做任务拆分，只输出一次完整 JSON；不要调用工具，不要写测试命令。",
    "覆盖：先把每个明确目标或验收条件写入 coverage，并映射到至少一个 taskId，不能漏项。",
    "并行：最大化当前可运行前沿。每个能独立推进、上下文不同且有可观察结果的交付物单独成任务；真实强依赖才写 dependsOn。至少两个任务必须无依赖立即运行，不设 Worker 上限，也不制造重复或占位任务。",
    "粒度：API、UI、文档等独立结果分开；六至八个独立结果就生成六至八个，十二或二十个也全部保留。看似单一的目标也必须拆成至少两个共同完成目标的实质分支。",
    "冲突：writeSet 只是提示，可重叠，可包含 task-tree.md、项目元数据或明确要求的外部路径；最终合并处理真实冲突。",
    "边界：不要仅因任务图里存在相关节点就创建任务；只拆本轮目标直接需要的交付物。基线、测试、评审、文档只有在本轮明确要求它们成为交付物时才单独成 Worker。",
    "字段：title 用简短中文；instruction 写完整可执行结果；dependsOn 只用 taskId。branchContext、依赖说明和验收说明由协调器补齐，Planner 不要生成。",
    "当前相关任务图上下文：",
    JSON.stringify(context),
    "最近相关运行：",
    formatGoalHistory(history),
    "",
    "严格按此形状返回 JSON：",
    '{"summary":"覆盖和拆分理由","coverage":[{"goal":"目标或验收条件","taskIds":["short-id"]}],"jobs":[{"taskId":"short-id","nodeId":"N2","title":"中文结果名","instruction":"完整可执行结果","writeSet":["public/**"],"dependsOn":[]}]}'
  ].join("\n");
}

function enrichPlannedJobs(jobs, { markdown = "", goal = {}, history = [] } = {}) {
  const byId = new Map(jobs.map((job) => [job.taskId, job]));
  return jobs.map((job) => {
    const dependencyNames = job.dependsOn.map((taskId) => {
      const dependency = byId.get(taskId);
      return dependency ? `${taskId}（${dependency.title || dependency.nodeId}）` : taskId;
    });
    return {
      ...job,
      summary: job.summary || job.instruction,
      branchContext: [
        `根目标：${goal.root || "(未记录)"}`,
        `当前阶段（${goal.stageNodeId || "ROOT"}）：${goal.stage || "(未记录)"}`,
        `本轮目标：${goal.immediate || "(未记录)"}`,
        `本分支来源节点：${job.nodeId}`,
        `本分支任务：${job.instruction}`,
        "Current task tree (complete):",
        markdown,
        "Previous run history (complete):",
        JSON.stringify(history)
      ].join("\n"),
      dependencyPrompt: dependencyNames.length
        ? `等待 ${dependencyNames.join("、")} 完成并由协调器合入后开始；只使用已经合入的真实结果。`
        : "无前置任务，可立即开始。",
      acceptancePrompt: `完成“${job.instruction}”；最终返回实际 changedFiles、affectedNodes 和可核验证据，未完成则返回 blocked。`
    };
  });
}

export function buildWorkerPrompt(job, handoffPath = "", peerJobs = []) {
  const peerRoster = peerJobs
    .filter((peer) => peer?.taskId && peer.taskId !== job.taskId)
    .map((peer) => `${peer.taskId}（${peer.title || peer.nodeId}）${peer.threadId ? ` · ${threadDeepLink(peer.threadId)}` : " · 会话尚未建立"}`)
    .join("\n");
  return [
    "【Task Tree · Isolated Parallel Worker】",
    `Task id: ${job.taskId}`,
    `Source node: ${job.nodeId}${job.title ? ` - ${job.title}` : ""}`,
    `Task: ${job.instruction}`,
    `Advisory file context (overlap is allowed): ${job.writeSet.join(", ") || "not specified"}`,
    `Dependency note: ${job.dependencyPrompt || "none recorded; verify prerequisites before coding"}`,
    `Acceptance note: ${job.acceptancePrompt || "state the solved problem, evidence, and remaining gap"}`,
    job.dependsOn?.length ? `Dependencies already integrated: ${job.dependsOn.join(", ")}` : "Dependencies: none",
    `Prior branch description: ${job.contextPreview || "(none)"}`,
    `Prior branch result (complete): ${job.contextResult || "(none)"}`,
    `Branch input context (complete): ${job.branchContext || "(none)"}`,
    `Shared run metadata directory (direct shared state, not Git-isolated): ${job.runtimeMetadataPath || "(not available)"}`,
    peerRoster ? `Peer branches that may be consulted by taskId:\n${peerRoster}` : "Peer branches: none have a visible conversation yet; use the taskId from this run if consultation is needed.",
    `Branch context generation: ${Number(job.contextGeneration) || 1}`,
    handoffPath ? `Previous generation handoff: ${handoffPath}` : "",
    handoffPath ? "Start by reading this short handoff and the current task-tree checkpoint. Treat the handoff as evidence, not as a replacement for the current tree." : "",
    "",
    "You are working in an isolated Git worktree. Implement the assigned result completely. Do not run tests, linters, git diff checks, validation commands, code review, or approval stages.",
    "You may edit task-tree.md, task-trees.json, tracked flow JSON, versions, run metadata, and any project file required by the task. Project edits are merged like ordinary Git changes; shared run metadata edits are direct concurrent effects.",
    "Do not delegate implementation. The advisory file context is not an enforcement boundary. Modify outside-worktree paths only when the task explicitly calls for those paths; report them as direct effects, since Git cannot merge them.",
    "If a concrete fact from another branch is required, request one consultation in peerRequests using a target taskId; the coordinator will relay it after the initial turns. Do not invent a conversation link as evidence.",
    "Your final answer must be concise and end with one JSON object: {\"event\":\"completed|blocked\",\"changedFiles\":[],\"affectedNodes\":[],\"evidence\":\"...\",\"peerRequests\":[{\"toTaskId\":\"other-task-id\",\"question\":\"...\",\"why\":\"...\",\"expect\":\"...\"}]}. Use an empty peerRequests array when no consultation is needed."
  ].filter(Boolean).join("\n");
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
      question: String(request?.question || request?.message || "").replace(/\s+/g, " ").trim(),
      why: String(request?.why || request?.reason || "").replace(/\s+/g, " ").trim(),
      expect: String(request?.expect || request?.expected || "").replace(/\s+/g, " ").trim()
    }))
    .filter((request) => request.toTaskId && request.toTaskId !== sourceTaskId && known.has(request.toTaskId) && request.question);
}

function normalizePeerAnswer(output) {
  const parsed = parseJsonObject(output);
  if (!parsed || typeof parsed !== "object") return null;
  const conclusion = String(parsed.conclusion || parsed.response || "").replace(/\s+/g, " ").trim();
  if (!conclusion) return null;
  return {
    conclusion,
    evidenceRefs: [...new Set((Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter((item) => item && !/^codex:\/\//i.test(item)))],
    unknowns: [...new Set((Array.isArray(parsed.unknowns) ? parsed.unknowns : [])
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))]
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

export function buildBranchPlannerPrompt(markdown, nodeId, objective = "", existingJobs = []) {
  const nodes = parseTreeNodeFields(markdown);
  const node = nodes.find((item) => item.id === cleanId(nodeId)) || nodes.find((item) => item.id !== "ROOT");
  const existing = existingJobs.map((job) => `${job.taskId}: ${job.title || job.nodeId} [${(job.writeSet || []).join(", ")}]`).join("\n") || "(none)";
  return [
    "【Task Tree · Single Parallel Branch Planner】",
    "只输出一个新增 Worker 的 JSON，不调用工具，不写测试命令。",
    "从根目标、当前阶段和所选节点推导一个具体可执行结果；不要重复现有分支。writeSet 可与现有分支重叠。",
    "branchContext、依赖说明和验收说明由协调器补齐，Planner 不要生成。",
    "当前相关上下文：",
    JSON.stringify({
      ...buildPlannerContext(markdown, objective),
      selectedNode: plannerNodeRecord(node)
    }),
    "现有分支：",
    existing,
    "",
    "严格按此形状返回 JSON：",
    '{"job":{"nodeId":"N3","title":"中文结果名","instruction":"完整可执行结果","writeSet":["public/**"],"dependsOn":[]}}'
  ].join("\n");
}

function normalizeBranchPlan(output, markdown, nodeId, objective = "", existingJobs = []) {
  const parsed = parseJsonObject(output);
  const input = parsed?.job || parsed;
  if (!input || typeof input !== "object") throw new Error("规划结果不是有效 JSON");
  const taskId = nextBranchTaskId(nodeId, existingJobs);
  const job = validateParallelJobs([{ ...input, taskId, nodeId: input.nodeId || nodeId, contextPolicy: input.contextPolicy || "reuse" }], {
    minimum: 1,
    knownTaskIds: existingJobs.map((item) => item.taskId),
    existingJobs
  }).at(0);
  return { summary: compactGoalText(parsed.summary || "已生成一个分支", 240), job };
}

function normalizePlan(output, markdown, objective = "", { minimum = 2 } = {}) {
  const parsed = parseJsonObject(output);
  if (!parsed?.jobs) throw new Error("规划结果不是有效 JSON，缺少 jobs");
  const jobs = validateParallelJobs(parsed.jobs, { minimum });
  const readyJobs = jobs.filter((job) => job.dependsOn.length === 0);
  if (readyJobs.length < 2) {
    throw new Error("自动并行计划必须至少有 2 个无前置依赖的可立即并行 Worker");
  }
  return {
    summary: String(parsed.summary || "自动生成的并行计划").trim(),
    jobs,
    coverage: Array.isArray(parsed.coverage) ? parsed.coverage : []
  };
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    objective: run.objective || "",
    goal: run.goal || null,
    summary: run.summary || "",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt || "",
    acceptedAt: run.acceptedAt || "",
    completedAt: run.completedAt || "",
    totalDurationMs: Number.isFinite(run.totalDurationMs) ? run.totalDurationMs : null,
    error: run.error || "",
    planner: run.planner || null,
    jobs: (run.jobs || []).map(({ workerPath, commit, sourceCommit, ...job }) => ({
      ...job,
      reportChars: job.output?.length || 0,
      deepLink: job.threadId ? threadDeepLink(job.threadId) : ""
    })),
    peerMessages: (run.peerMessages || []).map((message) => ({
      ...message,
      fromDeepLink: message.fromThreadId ? threadDeepLink(message.fromThreadId) : "",
      toDeepLink: message.toThreadId ? threadDeepLink(message.toThreadId) : ""
    })),
    contextOptions: run.contextOptions || [],
    mergeConflicts: run.mergeConflicts || [],
    coverage: run.coverage || [],
    workspaceTimings: run.workspaceTimings || {},
    gitCommandTimings: run.gitCommandTimings || null,
    executionTree: runtimeTree(run),
    events: run.events || [],
    result: run.result || null
  };
}

export function createParallelCodexCoordinator({
  projectRoot,
  startTurn = startCodexTurn,
  archiveThread = archiveCodexThread,
  workspace = createGitWorkspaceManager({ projectRoot }),
} = {}) {
  const injectedStartTurn = startTurn !== startCodexTurn;
  if (!injectedStartTurn) {
    const providerStartTurn = startTurn;
    startTurn = (options = {}) => providerStartTurn({
      ...options,
      environment: {
        ...(options.environment || {}),
        TASK_TREE_PROJECT_ROOT: projectRoot
      }
    });
  }
  // Keep per-run timings for every workspace operation.  This is deliberately
  // outside the Git manager: it measures the real coordinator boundary (the
  // part that can become a bottleneck) without changing Git semantics.
  const workspaceRuns = new Map();
  const workspaceTimingContext = new AsyncLocalStorage();
  const rawWorkspace = workspace;
  const workspaceTiming = new Proxy(rawWorkspace, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args) => {
        const startedAt = Date.now();
        let run = workspaceTimingContext.getStore() || null;
        const first = args[0];
        if (!run && typeof first === "string") run = workspaceRuns.get(first) || workspaceRuns.get(path.resolve(first)) || null;
        if (!run && first && typeof first === "object") {
          run = workspaceRuns.get(String(first.runId || ""))
            || workspaceRuns.get(path.resolve(String(first.integrationPath || "")))
            || null;
        }
        let result;
        try {
          const invoke = () => Reflect.apply(value, receiver, args);
          result = await (run ? workspaceTimingContext.run(run, invoke) : invoke());
          if (run && property === "prepare" && result?.integrationPath) {
            workspaceRuns.set(path.resolve(result.integrationPath), run);
            if (result.runDir) workspaceRuns.set(path.resolve(result.runDir), run);
          }
          if (run && property === "createWorker" && result) workspaceRuns.set(path.resolve(String(result)), run);
          return result;
        } finally {
          if (run) {
            run.workspaceTimings ||= {};
            const key = String(property);
            const entry = run.workspaceTimings[key] || { calls: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
            const elapsed = Date.now() - startedAt;
            entry.calls += 1;
            entry.totalMs += elapsed;
            entry.maxMs = Math.max(entry.maxMs, elapsed);
            entry.lastMs = elapsed;
            run.workspaceTimings[key] = entry;
            event(run, "workspace_timing", { operation: key, durationMs: elapsed, calls: entry.calls });
          }
        }
      };
    }
  });
  if (typeof rawWorkspace.setTimingObserver === "function") {
    rawWorkspace.setTimingObserver((detail) => {
      const run = workspaceTimingContext.getStore();
      if (!run) return;
      run.gitCommandTimings ||= { calls: 0, totalMs: 0, maxMs: 0, byCommand: {} };
      const timings = run.gitCommandTimings;
      const command = String(detail.command || "unknown");
      const entry = timings.byCommand[command] || { calls: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      timings.calls += 1;
      timings.totalMs += detail.durationMs;
      timings.maxMs = Math.max(timings.maxMs, detail.durationMs);
      entry.calls += 1;
      entry.totalMs += detail.durationMs;
      entry.maxMs = Math.max(entry.maxMs, detail.durationMs);
      entry.lastMs = detail.durationMs;
      timings.byCommand[command] = entry;
      event(run, "git_command_timing", { command, args: detail.args, durationMs: detail.durationMs, failed: Boolean(detail.failed) });
    });
  }
  workspace = workspaceTiming;
  const registerWorkspaceRun = (run) => workspaceRuns.set(run.id, run);
  const runs = new Map();
  const pending = new Map();
  const background = new Map();
  const additions = new Map();
  const wakeups = new Map();
  const runsDir = path.join(projectRoot, ".task-tree-runs");
  const systemContextsFile = path.join(runsDir, "system-contexts");
  let systemContextsPromise = null;
  let persistQueue = Promise.resolve();
  let plannerQueue = Promise.resolve();

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

  async function runWorker(run, job, integrate) {
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
        }];
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
        prompt: buildWorkerPrompt(job, handoffPath, run.jobs),
        cwd: job.workerPath,
        threadId: job.contextSource === "codex" ? "" : (job.contextThreadId || ""),
        forkThreadId: job.contextSource === "codex" ? (job.contextThreadId || "") : "",
        forceNewThread: rotateContext,
        threadName: `任务图 · 并行 ${String(run.jobs.indexOf(job) + 1).padStart(2, "0")} · ${humanizeTitle(job.title, job.taskId)}`,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        developerInstructions: "Implement the assigned task. File scopes are advisory; task-tree, project metadata, and shared run metadata may be edited. Do not run tests, lint, diff checks, validation commands, or reviews. Changes outside the worktree are direct concurrent effects and are not Git-isolated.",
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
      if (result.timing) event(run, "worker_turn_timing", { taskId: job.taskId, nodeId: job.nodeId, timing: result.timing });
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
      job.output = String(result.output || "");
      if (parseJsonObject(job.output)?.event === "blocked") throw new Error(job.output);
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
      if (job.workerPath) await workspace.removeWorker(job.workerPath, { preserveContext: true, contextKey: job.contextKey }).catch(() => {});
      delete job.workerPath;
      await persist(run);
    }
  }

  async function resolveMergeConflict(run, sourceJob, files, integrationPath = run.workspace.integrationPath, liveWorkspace = false) {
    const conflictFiles = [...new Set(files)].sort();
    const peers = run.jobs.filter((job) => job.taskId !== sourceJob?.taskId
      && (job.changedFiles || []).some((file) => conflictFiles.includes(file)));
    const participants = [sourceJob, ...peers].filter(Boolean);
    const threadLinks = participants.map((job) => ({
      taskId: job.taskId,
      threadId: job.contextThreadId || job.threadId || "",
      deepLink: job.contextThreadId || job.threadId ? threadDeepLink(job.contextThreadId || job.threadId) : "",
      instruction: job.instruction,
      output: job.output || ""
    }));
    run.mergeConflicts ||= [];
    const conflict = {
      id: randomUUID(),
      at: new Date().toISOString(),
      files: conflictFiles,
      sourceTaskId: sourceJob?.taskId || "",
      participantTaskIds: participants.map((job) => job.taskId),
      status: "resolving",
      consultationMode: "single-resolver",
      consultationCount: 0,
      messages: []
    };
    run.mergeConflicts.push(conflict);
    event(run, "merge_conflict_detected", { taskId: sourceJob?.taskId || "", files: conflictFiles, participants: conflict.participantTaskIds });
    await persist(run);

    const sourceThread = sourceJob?.contextThreadId || sourceJob?.threadId || "";
    try {
      if (!sourceThread) throw new Error(`无法协商合并冲突：${sourceJob?.taskId || "worker"} 没有可用上下文`);
      // The old implementation opened one model turn per peer and waited for each
      // turn before starting the resolver. That made conflict latency grow with
      // the number of participants even though every worker's original task,
      // branch context, and result were already available to the coordinator.
      // Send one complete, lossless participant packet to the source context and
      // let one resolver turn reconcile it. This keeps the semantic decision in a
      // worker conversation while reducing the normal path to one model round.
      const participantPacket = participants.map((job) => ({
        taskId: job.taskId,
        nodeId: job.nodeId,
        title: job.title,
        instruction: job.instruction,
        summary: job.summary,
        dependencyPrompt: job.dependencyPrompt,
        acceptancePrompt: job.acceptancePrompt,
        writeSet: job.writeSet,
        dependsOn: job.dependsOn,
        branchContext: job.branchContext || "",
        output: job.output || "",
        evidence: job.evidence || "",
        changedFiles: job.changedFiles || [],
        threadId: job.contextThreadId || job.threadId || "",
        deepLink: job.contextThreadId || job.threadId ? threadDeepLink(job.contextThreadId || job.threadId) : ""
      }));
      const resolutionStartedAt = Date.now();
      conflict.resolutionStartedAt = new Date().toISOString();
      await persist(run);
      const result = await startTurn({
        prompt: [
          "【Task Tree · Merge conflict resolution】",
          `Git has paused a cherry-pick with conflicts in: ${conflictFiles.join(", ")}.`,
          "You are the source worker whose commit is being integrated. Resolve every conflict in the current worktree, preserving both branches' stated intent where compatible.",
          liveWorkspace ? "The current side also contains the user's latest live workspace edits. Preserve those edits as well as the worker results." : "",
          "The following packet is the complete context collected before this conflict. It includes every participant's task, branch context, output, changed files, and conversation link. Do not start separate peer consultations; use this packet and inspect the actual conflict markers.",
          `Participant packet: ${JSON.stringify(participantPacket)}`,
          `All participant conversation links: ${JSON.stringify(threadLinks)}`,
          "Inspect the conflict markers and edit the current integration worktree. Stage the resolved files with git add. Do not commit or continue/abort the cherry-pick; the host does that. Do not discard another worker merely to make Git clean. Do not run tests. Finish by explaining the merged intent in JSON: {\"event\":\"completed|blocked\",\"evidence\":\"...\",\"peerRequests\":[]}."
        ].join("\n"),
        cwd: integrationPath,
        forkThreadId: sourceThread,
        threadName: `任务图 · 冲突合并 · ${sourceJob.taskId}`,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        developerInstructions: "Resolve only the active Git conflict in the integration worktree. Preserve both worker intents and do not edit outside this Git project.",
        waitForCompletion: true,
        completionTimeoutMs: PLANNER_TIMEOUT_MS
      });
      conflict.resolverTiming = result.timing || null;
      if (result.timing) event(run, "merge_resolver_turn_timing", { taskId: sourceJob.taskId, timing: result.timing });
      conflict.messages.push({
        fromTaskId: sourceJob.taskId,
        toTaskId: peers.map((job) => job.taskId).join(","),
        mode: "single-resolver",
        conclusion: String(result.output || "")
      });
      if (parseJsonObject(result.output)?.event === "blocked") throw new Error(String(result.output));
      await workspace.continueIntegration(integrationPath);
      conflict.status = "resolved";
      conflict.resolvedAt = new Date().toISOString();
      conflict.durationMs = Date.now() - resolutionStartedAt;
      event(run, "merge_conflict_resolved", {
        taskId: sourceJob.taskId,
        files: conflictFiles,
        consultationMode: conflict.consultationMode,
        consultationCount: conflict.consultationCount,
        durationMs: conflict.durationMs
      });
    } catch (error) {
      await workspace.abortIntegration(integrationPath);
      conflict.status = "failed";
      conflict.error = error.message;
      event(run, "merge_conflict_failed", { taskId: sourceJob?.taskId || "", files: conflictFiles, error: error.message });
      throw error;
    } finally {
      await persist(run);
    }
  }

  async function execute(run) {
    try {
      registerWorkspaceRun(run);
      run.status = run.workspace?.integrationPath ? "running" : "preparing";
      run.error = "";
      run.result = null;
      run.finishedAt = "";
      if (!run.workspace?.integrationPath) {
        event(run, "snapshot_started");
        await persist(run);
        run.workspace = await workspace.prepare(run.id);
        run.status = "running";
        event(run, "run_started", { snapshotCommit: run.workspace.snapshotCommit });
      } else {
        event(run, "run_resumed");
      }
      await persist(run);

      let integrationQueue = Promise.resolve();
      const integrate = (commit, sourceCommit, job) => {
        const next = integrationQueue.then(async () => {
          try {
            return await workspace.integrate(run.workspace.integrationPath, commit, sourceCommit);
          } catch (error) {
            if (error.code !== "CHERRY_PICK_CONFLICT") throw error;
            return resolveMergeConflict(run, job, error.files || []);
          }
        });
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

        for (const { source, request } of requests) {
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
          await persist(run);

          let targetPath = "";
          let sourcePath = "";
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
              const continuation = await startTurn({
                prompt: buildPeerAnswerPrompt(source, target, request, {
                  conclusion: message.response,
                  evidenceRefs: message.evidenceRefs,
                  unknowns: message.unknowns
                }),
                cwd: sourcePath,
                threadId: source.contextThreadId,
                sandbox: "danger-full-access",
                approvalPolicy: "never",
                developerInstructions: "Continue the assigned worker task using the peer answer. The write set is only a planning hint: you may edit task-tree.md, task-trees.json, project metadata, and any path required by the explicit task. Do not ask another peer during this continuation.",
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
              source.changedFiles = [...new Set([...(source.changedFiles || []), ...inspected.changedFiles])].sort();
              source.commit = await workspace.commit(sourcePath, `peer continuation ${source.taskId}`, sourceBase);
              await integrate(source.commit, sourceBase, source);
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
              if (sourcePath) await workspace.removeWorker(sourcePath, { preserveContext: true }).catch(() => {});
            }
          }
          await persist(run);
        }
      }
      const queued = new Set(run.jobs
        .filter((job) => ["queued", "planned"].includes(job.status))
        .map((job) => job.taskId));
      const active = new Map();

      while (queued.size || active.size || additions.get(run.id)?.size || run.jobs.some((job) => ["queued", "planned"].includes(job.status))) {
        const awakened = new Promise((resolve) => wakeups.set(run.id, () => resolve(null)));
        const byId = new Map(run.jobs.map((job) => [job.taskId, job]));
        // New jobs appended through the API enter this same scheduler immediately.
        for (const job of run.jobs) {
          if (!active.has(job.taskId)
            && ["queued", "planned"].includes(job.status)) {
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
        while (ready.length) {
          const taskId = ready.shift();
          queued.delete(taskId);
          const job = byId.get(taskId);
          const promise = runWorker(run, job, (commit, sourceCommit) => integrate(commit, sourceCommit, job)).then(() => taskId);
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
        if (active.size || additions.get(run.id)?.size) {
          const finished = await Promise.race([...active.values(), awakened]);
          active.delete(finished);
        }
        wakeups.delete(run.id);
      }
      await integrationQueue;
      await relayPeerRequests();
      await integrationQueue;

      run.status = "applying";
      await persist(run);
      const summary = await workspace.summarize(run.workspace.integrationPath, run.workspace.snapshotCommit);
      const failedTasks = run.jobs.filter((job) => job.status !== "completed").map((job) => job.taskId);
      run.result = {
        ...summary,
        summary: run.summary || "本轮执行结束",
        affectedNodes: [...new Set(run.jobs.map((job) => job.nodeId))],
        failedTasks,
        warnings: failedTasks.length ? [`${failedTasks.length} 个分支未完成`] : []
      };
      run.summary = run.result.summary;
      run.finishedAt = new Date().toISOString();
      if (run.jobs.some((job) => ["queued", "planned"].includes(job.status))) return execute(run);
      if (failedTasks.length) {
        run.status = "failed";
        run.error = run.jobs.filter((job) => job.status !== "completed").map((job) => `${job.taskId}: ${job.error || job.status}`).join("\n");
      } else {
        await applyRun(run);
      }
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      event(run, "run_failed", { error: error.message });
    }
    await persist(run);
    return publicRun(run);
  }

  function requestPlan(run, prompt, normalize, nodeId, outputSchema = PLANNER_OUTPUT_SCHEMA) {
    // One reusable planner conversation cannot accept simultaneous turns. Workers
    // remain concurrent; only planning turns sharing this conversation are queued.
    const result = plannerQueue.catch(() => {}).then(() => requestPlanTurn(run, prompt, normalize, nodeId, outputSchema));
    plannerQueue = result;
    return result;
  }

  async function requestPlanTurn(run, prompt, normalize, nodeId, outputSchema) {
    const records = await readGoalHistory(runsDir, run.id);
    const failures = records.flatMap((record) => (record.failures || [])
      .filter((failure) => !failure.nodeId || failure.nodeId === nodeId));
    const seen = new Set();
    let plannerAttempt = 0;
    for (;;) {
      const plannerStartedAt = Date.now();
      const plannerPrompt = [prompt, "本节点最近规划失败（只纠正这些失败，不重放完整历史输出）：", formatPlannerFailures(failures)].join("\n");
      const plannerTiming = {
        startedAt: new Date(plannerStartedAt).toISOString(),
        model: PLANNER_MODEL,
        reasoningEffort: PLANNER_REASONING_EFFORT,
        inputChars: plannerPrompt.length,
        outputChars: null,
        acceptedMs: null,
        firstReasoningMs: null,
        firstAgentMessageMs: null,
        finalAgentMessageMs: null,
        completedMs: null
      };
      const markPlannerItem = (message) => {
        const itemType = message?.params?.item?.type;
        const elapsed = Date.now() - plannerStartedAt;
        if (itemType === "reasoning" && plannerTiming.firstReasoningMs === null) plannerTiming.firstReasoningMs = elapsed;
        if (itemType === "agentMessage" && plannerTiming.firstAgentMessageMs === null) plannerTiming.firstAgentMessageMs = elapsed;
        if (message?.method === "item/completed" && itemType === "agentMessage" && plannerTiming.finalAgentMessageMs === null) {
          plannerTiming.finalAgentMessageMs = elapsed;
        }
      };
      let result;
      try {
      result = await requestDeepSeekPlanner({ projectRoot, prompt: plannerPrompt, outputSchema });
      // Tests may inject a deterministic startTurn; production has no Codex fallback.
      if (!result && injectedStartTurn) result = await startTurn({
        prompt: plannerPrompt,
        cwd: projectRoot,
        threadId: "",
        threadName: "任务图 · 自动规划（系统）",
        ...(PLANNER_MODEL ? { model: PLANNER_MODEL } : {}),
        ...(PLANNER_REASONING_EFFORT ? { config: { model_reasoning_effort: PLANNER_REASONING_EFFORT } } : {}),
        outputSchema,
        sandbox: "read-only", approvalPolicy: "never",
        developerInstructions: "All supplied text is complete. Return only a JSON plan. Do not call tools or edit files.",
        waitForCompletion: true,
        completionTimeoutMs: PLANNER_TIMEOUT_MS,
        totalTimeoutMs: PLANNER_TIMEOUT_MS,
        forceNewThread: true,
          onAccepted: async ({ threadId, turnId }) => {
          plannerTiming.acceptedMs = Date.now() - plannerStartedAt;
          run.planner = {
            ...(run.planner || {}),
            status: "running",
            threadId: threadId || "",
            turnId: turnId || "",
            timing: plannerTiming
          };
          event(run, "planner_turn_started", { nodeId, threadId, turnId, timing: plannerTiming });
          await rememberPlannerThread(threadId);
          await persist(run);
          },
          onNotification: markPlannerItem
        });
      if (!result) throw new Error("缺少 DeepSeek Planner 配置：请在项目 .env 设置 MODEL_AGENT_MAIN_BASE_URL、MODEL_AGENT_MAIN_API_KEY、MODEL_AGENT_MAIN_MODEL");
        if (result.timing) plannerTiming.codexTurn = result.timing;
      } catch (error) {
        plannerTiming.completedMs = Date.now() - plannerStartedAt;
        run.planner = {
          ...(run.planner || {}),
          status: "failed",
          error: error.message,
          timing: plannerTiming
        };
        event(run, "planner_turn_failed", { nodeId, error: error.message, timing: plannerTiming });
        await persist(run);
        // A slow or wedged reused context is not evidence that the plan is
        // impossible. Retry once in a clean thread; the full failure is kept in
        // the run record and passed to the next prompt for diagnosis.
        if (plannerAttempt === 0 && /超时|timeout/i.test(String(error.message || error))) {
          plannerAttempt += 1;
          failures.push({ nodeId, error: error.message, output: "Planner completion timeout; retrying with a fresh thread." });
          event(run, "planning_retry", { nodeId, error: error.message, reason: "fresh_planner_thread_after_timeout" });
          await persist(run);
          continue;
        }
        throw error;
      }
      plannerTiming.completedMs = Date.now() - plannerStartedAt;
      plannerTiming.outputChars = String(result.output || "").length;
      result.plannerTiming = plannerTiming;
      await rememberPlannerThread(result.threadId);
      try {
        return { plan: normalize(result.output), result };
      } catch (error) {
        const failure = { nodeId, error: error.message, output: String(result.output || "") };
        run.planningFailures ||= [];
        run.planningFailures.push(failure);
        failures.push(failure);
        event(run, "planning_retry", { nodeId, error: error.message });
        await persist(run);
        const key = JSON.stringify([failure.error, failure.output]);
        if (seen.has(key)) throw new Error(`Planner 重复返回相同不可执行计划：${error.message}`);
        seen.add(key);
      }
    }
  }

  async function generatePlan(run, objective) {
    try {
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      run.objective = cleanObjective(objective);
      run.goal = deriveParallelGoal(markdown, objective);
      [run.goal.history, run.contextOptions] = await Promise.all([
        readGoalHistory(runsDir, run.id), readContextOptions(runsDir, run.id)
      ]);
      const { plan, result } = await requestPlan(run,
        buildPlannerPrompt(markdown, objective, run.goal.history),
        (output) => normalizePlan(output, markdown, objective, { minimum: 2 }), run.goal.stageNodeId);
      run.summary = plan.summary;
      const enrichedJobs = enrichPlannedJobs(plan.jobs, {
        markdown,
        goal: run.goal,
        history: run.goal.history
      });
      const jobs = assignParallelDraftContexts(enrichedJobs, run.contextOptions);
      run.jobs = executionContexts(jobs, [], run.contextOptions).map((job) => ({
        ...job,
        runtimeMetadataPath: runsDir,
        status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
      }));
      run.coverage = plan.coverage || [];
      run.planner = { status: "completed", threadId: result.threadId, turnId: result.turnId,
        contextResumed: Boolean(result.resumed), error: "", output: String(result.output || ""),
        timing: result.plannerTiming || run.planner?.timing || null };
      run.status = "queued";
      event(run, "plan_started", {
        jobs: run.jobs.map((job) => job.taskId),
        automatic: true,
        parallelRequired: true,
        workerCount: run.jobs.length
      });
      await persist(run);
      return execute(run);
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      run.planner = { ...run.planner, status: "failed", error: error.message };
      event(run, "planning_failed", { error: error.message });
      await persist(run);
      return publicRun(run);
    }
  }

  async function recoverAbandonedPlan(run) {
    if (run.status !== "planning" || pending.has(run.id)) return run;
    const lastUpdate = Date.parse(run.updatedAt || run.createdAt || "");
    if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < ABANDONED_PLANNING_MS) return run;
    event(run, "planning_recovered");
    const promise = Promise.resolve().then(() => generatePlan(run, run.objective)).finally(() => pending.delete(run.id));
    pending.set(run.id, promise);
    return run;
  }

  async function recoverAbandonedExecution(run) {
    if (pending.has(run.id) || !["queued", "preparing", "running", "applying"].includes(run.status)) return run;
    // An interrupted model turn may have made direct external edits. Resume only
    // preparation or application automatically; don't replay a worker's side effects.
    if (!run.workspace?.integrationPath || run.jobs.every((job) => job.status === "completed")) {
      run.jobs = run.jobs.map((job) => job.status === "completed" ? job : { ...job, status: "queued" });
      run.status = "queued";
      event(run, "execution_requeued_after_restart");
      await persist(run);
      const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return run;
    }
    run.jobs = run.jobs.map((job) => job.status === "completed" ? job : {
      ...job, status: "failed", error: "运行服务中断；已保留分支上下文与隔离结果"
    });
    run.status = "failed";
    run.error = "运行服务中断；重新规划时会带上本轮失败记录";
    event(run, "execution_recovered");
    await persist(run);
    return run;
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

  async function applyRun(run) {
    registerWorkspaceRun(run);
    if (run.status === "accepted") return publicRun(run);
    const applied = await workspace.accept({
      integrationPath: run.workspace.integrationPath,
      snapshotCommit: run.workspace.snapshotCommit,
      changedFiles: run.result?.changedFiles || [],
      resolveConflict: (integrationPath, files) => {
        const source = [...run.jobs].reverse().find((job) => job.changedFiles?.some((file) => files.includes(file))) || run.jobs.at(-1);
        return resolveMergeConflict(run, source, files, integrationPath, true);
      }
    });
    run.result ||= {};
    run.result.appliedFiles = applied.appliedFiles;
    run.result.cleanup = { status: "queued", error: "" };
    run.status = "accepted";
    run.acceptedAt = new Date().toISOString();
    event(run, "accepted", { appliedFiles: applied.appliedFiles, automatic: true });
    await persist(run);
    scheduleBackground(run.id, () => finalizeAcceptedRun(run));
    return publicRun(run);
  }

  async function finalizeAcceptedRun(run) {
    if (["queued", "running"].includes(run.result?.cleanup?.status)) {
      const cleanupStartedAt = Date.now();
      run.result.cleanup = { status: "running", error: "", startedAt: new Date(cleanupStartedAt).toISOString() };
      await persist(run);
      try {
        await workspace.cleanup({ ...run.workspace, runId: run.id });
        run.result.cleanup = { status: "completed", error: "" };
      } catch (error) {
        run.result.cleanup = { status: "failed", error: error.message };
      }
      const completedAt = new Date().toISOString();
      run.result.cleanup.completedAt = completedAt;
      run.result.cleanup.durationMs = Date.now() - cleanupStartedAt;
      run.completedAt = completedAt;
      run.totalDurationMs = Math.max(0, Date.parse(completedAt) - Date.parse(run.createdAt || completedAt));
      event(run, "run_finalized", { cleanupDurationMs: run.result.cleanup.durationMs, totalDurationMs: run.totalDurationMs });
      await persist(run);
    }
    return publicRun(run);
  }

  async function recoverAcceptedFinalization(run) {
    if (run.status !== "accepted" || background.has(run.id)) return run;
    const needsCleanup = ["queued", "running"].includes(run.result?.cleanup?.status);
    if (needsCleanup) scheduleBackground(run.id, () => finalizeAcceptedRun(run));
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

    async addBranch(id, { nodeId = "", objective = "" } = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (!["queued", "preparing", "running"].includes(run.status)) {
        throw new Error("当前并行运行已在收尾，不能新增分支");
      }
      const token = randomUUID();
      if (!additions.has(run.id)) additions.set(run.id, new Set());
      additions.get(run.id).add(token);
      try {
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      const submittedJobs = run.jobs || [];
      const selectedNodeId = cleanId(nodeId || run.goal?.stageNodeId);
      const { plan, result } = await requestPlan(run,
        buildBranchPlannerPrompt(markdown, selectedNodeId, objective || run.objective, submittedJobs),
        (output) => normalizeBranchPlan(output, markdown, selectedNodeId, objective || run.objective, submittedJobs),
        selectedNodeId,
        BRANCH_OUTPUT_SCHEMA);
      const [enriched] = enrichPlannedJobs([plan.job], {
        markdown,
        goal: run.goal || deriveParallelGoal(markdown, objective || run.objective),
        history: run.goal?.history || []
      });
      enriched.branchContext = [enriched.branchContext, "Existing branches:", JSON.stringify(submittedJobs)].join("\n");
      return await this.append(id, { jobs: [enriched] });
      } finally {
        additions.get(run.id)?.delete(token);
        wakeups.get(run.id)?.();
      }
    },

    async append(id, changes = {}) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (!["queued", "preparing", "running", "failed"].includes(run.status)) {
        throw new Error("本轮已在收尾，请在下一轮添加任务");
      }
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      const jobsInput = Array.isArray(changes.jobs) ? changes.jobs : [];
      run.contextOptions = mergeContextOptions(await readContextOptions(runsDir, run.id), run.contextOptions || []);
      const existingIds = new Set(run.jobs.map((job) => job.taskId.toLowerCase()));
      const duplicate = jobsInput.find((job) => existingIds.has(cleanId(job?.taskId || job?.id).toLowerCase()));
      if (duplicate) throw new Error(`任务不能重复：${duplicate.taskId || duplicate.id}`);
      const jobs = assignParallelDraftContexts(jobsInput, run.contextOptions.filter((option) =>
        !run.jobs.some((job) => job.contextThreadId === option.threadId)));
      const appended = executionContexts(jobs, [], run.contextOptions, {
        knownTaskIds: run.jobs.map((job) => job.taskId), existingJobs: run.jobs
      }).map((job) => ({
        ...job,
        runtimeMetadataPath: runsDir,
        branchContext: [job.branchContext, "Current task tree:", markdown,
          "Previous run history:", JSON.stringify(run.goal?.history || []),
          "Existing branches:", JSON.stringify(run.jobs)].filter(Boolean).join("\n"),
        status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
      }));
      // Recheck after async context reads: application must have a fixed set of jobs.
      if (!["queued", "preparing", "running", "failed"].includes(run.status)) {
        throw new Error("本轮已在收尾，请在下一轮添加任务");
      }
      run.jobs.push(...appended);
      wakeups.get(run.id)?.();
      event(run, "branches_appended", { taskIds: appended.map((job) => job.taskId) });
      await persist(run);
      if (!pending.has(run.id)) {
        const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
        pending.set(run.id, promise);
      }
      return publicRun(run);
    },

    async start(input) {
      const now = new Date().toISOString();
      const markdown = await readFile(path.join(projectRoot, "task-tree.md"), "utf8");
      const contextOptions = await readContextOptions(runsDir);
      const history = await readGoalHistory(runsDir);
      const jobs = executionContexts(assignParallelDraftContexts(validateParallelJobs(input), contextOptions), [], contextOptions);
      const run = {
        id: randomUUID(), status: "queued", objective: "", summary: "直接执行的并行计划",
        createdAt: now, updatedAt: now, error: "",
        goal: { ...deriveParallelGoal(markdown), history },
        planner: { status: "manual", threadId: "", turnId: "", error: "" },
        contextOptions,
        jobs: jobs.map((job) => ({
          ...job, branchContext: [job.branchContext, markdown, JSON.stringify(history)].filter(Boolean).join("\n"),
          runtimeMetadataPath: runsDir,
          status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
        })),
        events: [], peerMessages: []
      };
      runs.set(run.id, run);
      await persist(run);
      const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return publicRun(run);
    },

    async get(id) {
      const run = await load(id);
      if (!run) return null;
      await recoverAbandonedPlan(run);
      await recoverAbandonedExecution(run);
      await ensureGoalState(run);
      await recoverAcceptedFinalization(run);
      return publicRun(run);
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
