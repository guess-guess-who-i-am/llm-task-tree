import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveCodexThread, startCodexTurn, threadDeepLink } from "./codex-run.js";
import { CONTEXT_ROTATE_THRESHOLD, CONTEXT_SOFT_THRESHOLD } from "./context-policy.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";
import { parseTreeNodeFields } from "./tree-quality.js";
import { startDeepSeekTurn, loadDeepSeekConfig } from './deepseek-run.js';
import { nodeMaterialContext, branchMaterialNodeIds } from './node-materials.js';
import { loadTreeRegistry } from './tree-registry.js';
import { buildTreeSummary, readTreeSummary, TREE_CONTEXT_TOOLS, treeContextHandler, buildRunOutcomeSummary } from './tree-context.js';
import { materializeParallelBranches, readParallelSource, recordParallelBranchResults } from './parallel-branch-tree.js';
import { assertWorkspaceTreeFiles } from './tree-write-safety.js';
import { createDirectNodeWorkspace } from './direct-node-workspace.js';
import { createPeerMailbox, PEER_EXCHANGE_TOOL } from './peer-mailbox.js';
import { recordAgentActivity } from './agent-activity.js';
import { buildCompletionReviewPrompt, parseCompletionReview, completionReviewFailure, completionReviewInterruption, WORKER_RESULT_SCHEMA } from './node-completion-review.js';
import {executionErrorDetails} from './execution-error.js';
import {WORKER_SPLIT_TOOL} from './adaptive-node-execution.js';
import {validateReviewScopeFiles} from './review-input-watch.js';
import {readLinkedTreeFiles} from './tree-node-location.js';
import {JOB_DELIVERY_PROPERTIES,normalizeDeliveryContract,snapshotDeliverables,inspectDeliverables,recoveryDecision,coordinationEvidence,stageCoordinationEvidence} from './execution-coordination.js';

// Planner context is supplied explicitly in the prompt. Reusing an ever-growing
// conversation made the first response increasingly slow. Keep context concise;
// API liveness is enforced per request, never by an overall planning deadline.
// Keep planning on the same high-quality model requested for implementation. Planning
// still uses a separate effort because a small structured decomposition does not need
// the xhigh setting that previously exhausted the whole completion timeout.
const PLANNER_MODEL = String(process.env.TASK_TREE_PLANNER_MODEL || "gpt-6.1-sol").trim();
const PLANNER_REASONING_EFFORT = String(process.env.TASK_TREE_PLANNER_REASONING_EFFORT || "low").trim();
const WORKER_HANDOFF_PATH = ".task-tree-context/handoff.json";
const CONTEXT_POLICIES = new Set(["reuse", "new", "selected"]);
export const MAX_DYNAMIC_SPLIT_DEPTH = 1;

export function canWorkerSplit(job, jobs = []) {
  const byId = new Map(jobs.map((item) => [item.taskId, item]));
  let depth = 0;
  let parentTaskId = job?.parentTaskId || "";
  const seen = new Set();
  while (parentTaskId && !seen.has(parentTaskId)) {
    seen.add(parentTaskId);
    const parent = byId.get(parentTaskId);
    if (!parent) break;
    depth += 1;
    parentTaskId = parent.parentTaskId || "";
  }
  return depth < MAX_DYNAMIC_SPLIT_DEPTH;
}

function assertTurnCompleted(result) {
  if (result.status && result.status !== 'completed') {
    const error = Object.assign(new Error(result.error?.message || `模型执行${result.status === 'stopped' ? '已停止' : '失败'}：${result.status}`, {cause:result.error}), executionErrorDetails(result.error));
    error.threadId = result.threadId;
    throw error;
  }
}

async function deepSeekPlannerConfig(projectRoot) {
  try { return loadDeepSeekConfig(projectRoot, { role: 'planner' }); }
  catch (error) {
    if (error.message.startsWith('缺少 DeepSeek 配置')) return null;
    throw error;
  }
}

export async function requestDeepSeekPlanner({ projectRoot, prompt, outputSchema, onNotification, contextMessages = [], historyMessages = [], dialogueContext = historyMessages, sourceTree }) {
  const config = await deepSeekPlannerConfig(projectRoot);
  if (!config) return null;
  const startedAt = Date.now();
    const result = await startDeepSeekTurn({
      cwd: projectRoot, prompt, model: config.model, contextMessages,
      ...(historyMessages.length ? { messages: [...historyMessages, { role: 'user', content: prompt }] } : {}),
      ...(dialogueContext.length ? { dialogueContext: [...dialogueContext, { role: 'user', content: prompt }] } : {}),
      environment: { MODEL_AGENT_MAIN_BASE_URL: config.baseUrl, MODEL_AGENT_MAIN_API_KEY: config.apiKey, MODEL_AGENT_MAIN_MODEL: config.model,
        TASK_TREE_QUALITY_MODE: 'advisory',
        MODEL_AGENT_MAIN_FALLBACK_BASE_URLS: config.baseUrls.slice(1).join(','),
        MODEL_AGENT_MAIN_FALLBACK_MODELS: config.fallbackModels.join(','),
        MODEL_AGENT_MAIN_HEADERS_TIMEOUT_MS: String(config.headersTimeoutMs),
        MODEL_AGENT_MAIN_STREAM_IDLE_TIMEOUT_MS: String(config.streamIdleTimeoutMs),
        ...(sourceTree ? { TASK_TREE_CONTEXT_TREE_FILE: sourceTree.path } : {}) },
      systemPrompt: '你是任务拆分器。遵守共享的全局规则、Hook 和适用技能。只规划，不执行工作或修改文件；最终只返回要求的 JSON。可读取必要的 Skill 和上下文。',
      runtimeToolNames: ['skills_list', 'skills_read', 'read_file', 'task_tree_focus', 'task_tree_node'],
      tools: TREE_CONTEXT_TOOLS, toolHandler: treeContextHandler(projectRoot, sourceTree),
      outputSchema, temperature: 0.1,
      waitForCompletion: true, onNotification
    });
    assertTurnCompleted(result);
    const output = String(result.structuredOutput || result.messages?.at(-1)?.content || result.output || '').trim();
    if (!output) throw new Error("DeepSeek 返回空计划");
    return {
      output,
      threadId: result.threadId,
      turnId: result.turnId,
      resumed: false,
      timing: { ...result.timing, provider: "deepseek", model: result.timing?.model || config.model, completedMs: Date.now() - startedAt, outputChars: output.length },
      outputSchema
    };
}
const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "coverage", "jobs"],
  properties: {
    summary: { type: "string", minLength: 1 },
    sharedContract: { type: 'string' },
    acceptanceCriteria: JOB_DELIVERY_PROPERTIES.acceptanceCriteria,
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
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "nodeId", "title", "instruction", "writeSet", "dependsOn"],
        properties: {
          taskId: { type: "string", minLength: 1 },
          nodeId: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          instruction: { type: "string", minLength: 1 },
          workEstimate: { type: 'string' },
          ...JOB_DELIVERY_PROPERTIES,
          sharedContract: { type: 'string' },
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

export function compactWorkerOutput(value, parsed) {
  if (parsed && typeof parsed === 'object') {
    return JSON.stringify({
      event: parsed.event,
      evidence: String(parsed.evidence || '')
    });
  }
  return String(value || '').trim();
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
    preview: compactGoalText(job?.evidence || job?.error || job?.contextPreview || job?.summary || job?.instruction || "", 96),
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
    "Completion", "Problem", "Approach", "Metrics", "CurrentResult", "NextIdea",
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
    immediate: compactGoalText(objective, 320) || compactGoalText(stage.fields.NextIdea) || stageGoal || rootGoal,
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
      ...normalizeDeliveryContract(job),
      workEstimate: String(job.workEstimate || ''),
      parentTaskId: String(job.parentTaskId || ''),
      sharedContract: String(job.sharedContract || ''),
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

export function buildPlannerPrompt(markdown, objective = "", history = [], treeSummary = buildTreeSummary(markdown)) {
  const context = buildPlannerContext(markdown, objective);
  context.focusNodes = context.focusNodes.map(node => {
    const actual = treeSummary.nodes.find(n => n.id === node.id);
    return actual ? { ...node, title: actual.title, fields: { ...node.fields, ...actual.fields } } : node;
  });
  return [
    "【Task Tree · Automatic Parallel Planner】",
    "只做任务拆分，用 structured_result_submit 一次提交完整计划，JSON由宿主序列化；不要写测试命令。先使用所给摘要；只有需要更多信息时才调用只读工具。task_tree_read 可读完整主树，read_file 可读指定子树；折叠不等于丢失，勿无条件展开所有子树。",
    "覆盖：先把每个明确目标或验收条件写入 coverage，并映射到至少一个 taskId，不能漏项。",
    "并行：有两个以上分别需要分析、推导、实现或撰写的独立成果，默认主动并行；尽早发布共享接口并委派主要成果，最大化有用的就绪前沿。共享字段、术语或风格不等于强依赖，固定公共约定再委派；仅必须消费他支尚未产生的实际结果才写 dependsOn。能一次写完或规格具体不等于微小；只有短标签机械替换这类微小操作、确实不可拆的任务是单人例外。若只有一个不可再分的结果，保留一个任务；独立结果有多少就保留多少，不设 Worker 上限，不递归拆分微任务。",
    "粒度：现有树是项目框架；本轮只丰富所选节点形成可验证交付物。每个任务有清楚输入、成果和负责节点；强耦合步骤放在同一个任务，低耦合结果分开。可跨文件，文件相同也不自动视为依赖。最终由 Worker 将真实成果写回自己的节点或必要子节点，逐步丰富整棵树。",
    '负载均衡：除总体协调者外，以每个Agent约10–15分钟可交付的连贯成果为分工软目标，不是执行期限；不要把布局、画像、生成器、测试等多个模块全留给最长分支。同一份文档中需分别分析和论证的章节按统一提纲并行撰写；同一产物按模块或数据分片，约定输入输出后各自产出片段再组装。Worker在执行中继续拆分较大的独立剩余范围，不因估时超出而停止。',
    "冲突：writeSet 只是提示，可重叠，可包含 task-tree.md、项目元数据或明确要求的外部路径；最终合并处理真实冲突。",
    "边界：不要仅因任务图里存在相关节点就创建任务；只拆本轮目标直接需要的交付物。基线、测试、评审、文档只有在本轮明确要求它们成为交付物时才单独成 Worker。",
    "字段：title 用简短中文；instruction 写完整可执行结果；dependsOn 只用 taskId。branchContext 和依赖说明由宿主补齐，不重复生成。为实际文件/树修改填写 deliverables（实际所属路径、update/present/delete，树再给nodeIds）和 acceptanceCriteria（可观察的业务完成依据）；只读论证不强造文件。宿主核对落盘，独立检查Agent判定语义质量。coverage只是目标分工映射，不是已完成证据。",
    '接口与工作量：有跨分支接口时，在 sharedContract 一次约定调用形状、字段、失败语义、接口负责人；协调器把相同原文发给全部 Worker。instruction 明确输入、成果、边界、完成依据和回写节点。workEstimate 写相对工作量及理由，按工作量与耦合分组，合并多个小操作，复杂独立交付单列；不按文件数平均，不保证精确耗时。',
    'one-shot 示例：最终只交付一份 docs/guide.md，不等于只建一个任务。sharedContract="沿用既有API；片段均用##章标题；最终检查在同一会话按接口章、运维章顺序组装为docs/guide.md"；接口章 instruction="分析兼容与错误边界，写api.md"、workEstimate="中：接口论证"；运维章 instruction="分析监控与回滚，写ops.md"、workEstimate="中：恢复论证"；二者无dependsOn，全部正文并行产出，片段不是最终交付。示例路径和约定须换为本轮实际值。',
    "当前相关任务图上下文：",
    JSON.stringify(context),
    '完整主树地图（摘要，不含折叠后代；可按需读取主树原文）：',
    JSON.stringify(treeSummary),
    "最近相关运行：",
    formatGoalHistory(history),
    "",
    "严格按此形状返回 JSON：",
    '{"summary":"覆盖和拆分理由","sharedContract":"本轮共享接口约定，无则省略","coverage":[{"goal":"目标或验收条件","taskIds":["short-id"]}],"jobs":[{"taskId":"short-id","nodeId":"N2","title":"中文结果名","instruction":"输入、交付物、接口职责、边界、完成依据和回写节点","workEstimate":"相对工作量及理由","deliverables":[{"path":"subtrees/N2.md","mode":"update","nodeIds":["N2"]}],"acceptanceCriteria":["节点用大白话说明业务输入输出，内容直接保存在节点内"],"writeSet":["subtrees/N2.md"],"dependsOn":[]}]}'
  ].join("\n");
}

export function buildBranchInputContext(job, { markdown = '', goal = {}, history = [], treeSummary = buildTreeSummary(markdown) } = {}) {
  return [
    '【任务树分支上下文：摘要优先】',
    `根目标：${goal.root || '(未记录)'}`,
    `当前阶段（${goal.stageNodeId || 'ROOT'}）：${goal.stage || '(未记录)'}`,
    `本轮目标：${goal.immediate || '(未记录)'}`,
    `本分支来源节点：${job.nodeId}`,
    '主树地图摘要（由最新文件生成；不含折叠后代）：', JSON.stringify(treeSummary),
    '最近运行索引（完整结果按需从共享运行元数据读取，不重复投入历史正文）：',
    JSON.stringify(history.slice(-3).map(item=>({runId:item.runId,status:item.status,goal:item.immediate}))),
    '按需展开：task_tree_read 读完整主树；task_tree_node(nodeId) 读指定节点；task_tree_subtree(action=read,path) 读指定子树。整文件写入前先读取最新原文，字段补丁无需读全部。',
    job.branchContext && !job.branchContext.startsWith('【任务树分支上下文：摘要优先】') ? `调用方额外分支要求：\n${job.branchContext}` : ''
  ].join('\n');
}

function enrichPlannedJobs(jobs, { markdown = "", goal = {}, history = [], treeSummary } = {}) {
  const byId = new Map(jobs.map((job) => [job.taskId, job]));
  return jobs.map((job) => {
    const dependencyNames = job.dependsOn.map((taskId) => {
      const dependency = byId.get(taskId);
      return dependency ? `${taskId}（${dependency.title || dependency.nodeId}）` : taskId;
    });
    return {
      ...job,
      summary: job.summary || job.instruction,
      branchContext: buildBranchInputContext(job, { markdown, goal, history, treeSummary }),
      dependencyPrompt: dependencyNames.length
        ? `等待 ${dependencyNames.join("、")} 完成并由协调器合入后开始；只使用已经合入的真实结果。`
        : "无前置任务，可立即开始。",
      acceptancePrompt: '完成上述 Task；简短提交实际验证证据，未完成则返回 blocked。'
    };
  });
}

export function buildWorkerPrompt(job, handoffPath = "", peerJobs = []) {
  // Restored runs may still contain the old generated copies of the full task.
  const branchContext=String(job.branchContext||'(none)').replace(`本分支任务：${job.instruction}\n`,'');
  const acceptance=String(job.acceptancePrompt||'state the solved problem, evidence, and remaining gap')
    .replaceAll(String(job.instruction||'\u0000'),'上述 Task');
  const peerRoster = peerJobs
    .filter((peer) => peer?.taskId && peer.taskId !== job.taskId)
    .filter((peer) => (peer.parentTaskId || "") === (job.parentTaskId || ""))
    .map((peer) => `${peer.taskId}（${peer.title || peer.nodeId}）${peer.threadId ? ` · ${threadDeepLink(peer.threadId)}` : " · 会话尚未建立"}`)
    .join("\n");
  return [
    "【Task Tree · Isolated Parallel Worker】",
    `Task id: ${job.taskId}`,
    `Source node: ${job.nodeId}${job.title ? ` - ${job.title}` : ""}`,
    ...(job.subtreeFile ? [
      `Execution node: ${job.executionNodeId}`,
      `Branch subtree: ${job.subtreeFile}`,
      `本轮按分配任务执行，不执行全局 GraphState.Next。分支子树已经建立，上述分支节点用于执行汇报，汇报不能替代业务交付；Task或交付合同要求改业务树时，修改隔离工作区中实际所属树文件和节点，不能只改汇报节点。完成后用 task_tree_write(nodeId=${job.executionNodeId},fields=需要更新的字段,reason=原因) 简要回写实际结果，不整份覆盖子树。多个分支可修改来源树，真实冲突由Git合并处理。`
    ] : []),
    `Task: ${job.instruction}`,
    ...(job.deliverables?.length ? [`交付合同（必须实际落盘，不是仅在聊天展示）：${JSON.stringify(job.deliverables)}`] : []),
    ...(job.acceptanceCriteria?.length ? [`完成依据：${JSON.stringify(job.acceptanceCriteria)}`] : []),
    ...(job.recovery?.action==='complete-delivery' ? [`协调器定点补交：${job.retryReason}。保留已完成成果，只补当前缺口；不要再次仅输出完成旁白。`] : []),
    `Planner shared contract（本轮各分支共同约定）：${job.sharedContract || '无跨分支接口约定；复用已有接口，不自行猜测其它分支接口。'}`,
    `Work estimate（规划估计，不是完成证据）：${job.workEstimate || '未估计'}`,
    `Advisory file context (overlap is allowed): ${job.writeSet.join(", ") || "not specified"}`,
    `Dependency note: ${job.dependencyPrompt || "none recorded; verify prerequisites before coding"}`,
    `Acceptance note: ${acceptance}`,
    job.dependsOn?.length ? `Dependencies already integrated: ${job.dependsOn.join(", ")}` : "Dependencies: none",
    `Prior branch description: ${job.contextPreview || "(none)"}`,
    'Prior branch result: use the summary above; complete saved output is available in the shared run metadata if needed.',
    `Branch input context (summary first): ${branchContext}`,
    `Shared run metadata directory (direct shared state, not Git-isolated): ${job.runtimeMetadataPath || "(not available)"}`,
    peerRoster ? `Peer branches that may be consulted by taskId:\n${peerRoster}` : "Peer branches: none have a visible conversation yet; use the taskId from this run if consultation is needed.",
    `Branch context generation: ${Number(job.contextGeneration) || 1}`,
    handoffPath ? `Previous generation handoff: ${handoffPath}` : "",
    handoffPath ? "Start by reading this short handoff and the current task-tree checkpoint. Treat the handoff as evidence, not as a replacement for the current tree." : "",
    "",
    '你在独立 Git 工作区完整实现分配的交付物。可以运行任务相关测试和必要验证；复用已有测试，无需另建繁琐评审或用户确认。把实际命令、退出结果及证据文件提供给最后检查 Agent；未执行的验证不得声称通过。遵守 Planner 共享接口，不擅自更改其它分支依赖的约定。',
    '生成器或测试需要但Git忽略的本地输入，用 task_tree_review_inputs({action:"register",paths:["corpus/normalized"]}) 登记实际项目相对路径；宿主交接时快照供最终检查原路径复用，无需登记已追踪代码、提交数据或再次调用检查模型。',
    '树回写 one-shot：实际实现并验证后，一次 task_tree_write(nodeId=上述Execution node,fields={Completion:"已完成",CurrentResult:"附件保存已实现；成功与失败用例通过，证据见 docs/attachment-test.md，无本轮缺口。",NextIdea:"本轮已完成。"},reason="回写实际成果")；只按持久化 changes 报告，不把原始命令、数据或 Evidence 子字段写进状态，成功后不为措辞反复回读或重写。',
    "You may edit task-tree.md, task-trees.json, tracked flow JSON, versions, run metadata, and any project file required by the task. Project edits are merged like ordinary Git changes; shared run metadata edits are direct concurrent effects.",
    `剩余范围确实包含两个以上可独立交付的主要成果时，才调用 task_tree_split_work；本 worker 只允许再拆一层，子任务必须直接完成各自范围，禁止递归拆分微任务。不能仅因有多个子主题就拆分；先判断能否在当前会话用一次源码调查和一次树/文档写入完成。拆分后端到端任务数可能增长，优先保证每个分支能交付，不能为了并行度制造更小任务。共享字段、术语或风格不等于强依赖，固定公共约定再委派；仅必须消费他支尚未产生的实际结果才有依赖。以约10–15分钟可交付成果为分工软目标，不是停止期限；宿主保存已有成果，子分支沿用共享接口，最后统一验收一次。同文档各章节分别分析、统一提纲并行撰写，片段由最终检查同一会话组装为用户指定文件；同产物按模块分。只拆自己未完成的范围，不重复其他分支。独立搜索、读取和下载批量调用，脚本用并发池。`,
    "The advisory file context is not an enforcement boundary. Modify outside-worktree paths only when the task explicitly calls for those paths; report them as direct effects, since Git cannot merge them.",
    "执行中有真实的接口、边界或集成疑问时，尽早用 task_tree_peer_exchange 将同一接收分支的多个问题合成一条发送；实现中可批量通报接口决定和证据。发送时记录 resume（自己当前进度和下一动作），之后继续不依赖答案的工作；消息在现有轮次边界送达，不打断工具、不另开同会话回答。回复后回到自己的检查点，不接管对方任务，不把咨询当重复验收。",
    job.singleFinalReview
      ? '交付后用中文简要说明状态、关键验证和未完成项（如有）；无需复述任务背景。'
      : '完成后单独调用 structured_result_submit 提交 event、简短 evidence 和必要 peerRequests；未完成时提交 blocked 与具体缺口。'
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

export function buildBranchPlannerPrompt(markdown, nodeId, objective = "", existingJobs = [], treeSummary = buildTreeSummary(markdown), sharedContract = '') {
  const nodes = parseTreeNodeFields(markdown);
  const node = nodes.find((item) => item.id === cleanId(nodeId)) || nodes.find((item) => item.id !== "ROOT");
  const existing = existingJobs.map((job) => `${job.taskId}: ${job.title || job.nodeId} [${(job.writeSet || []).join(", ")}]`).join("\n") || "(none)";
  return [
    "【Task Tree · Single Parallel Branch Planner】",
    "最终只输出一个新增 Worker 的 JSON，不写测试命令。先使用摘要，需要更多信息再调用 task_tree_read 或其它只读工具；不要无条件展开折叠子树。",
    "从根目标、当前阶段和所选节点推导一个具体可执行结果；不要重复现有分支。writeSet 可与现有分支重叠。",
    "branchContext、依赖说明和验收说明由协调器补齐，Planner 不要生成。",
    'instruction 必须包含输入、交付物、接口职责、边界、完成依据和回写节点；沿用现有分支共享接口，并写相对工作量及理由，不修改已经发布给其它分支的约定。',
    `已发布公共接口原文：${sharedContract || existingJobs.find(job => job.sharedContract)?.sharedContract || '(无)'}`,
    "当前相关上下文：",
    JSON.stringify({
      ...buildPlannerContext(markdown, objective),
      selectedNode: plannerNodeRecord(node)
    }),
    '完整主树地图摘要：', JSON.stringify(treeSummary),
    "现有分支：",
    existing,
    "",
    "严格按此形状返回 JSON：",
    '{"job":{"nodeId":"N3","title":"中文结果名","instruction":"完整可执行结果","workEstimate":"相对工作量及理由","writeSet":["public/**"],"dependsOn":[]}}'
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

function normalizePlan(output, markdown, objective = "", { minimum = 1 } = {}) {
  const parsed = parseJsonObject(output);
  if (!parsed?.jobs) throw new Error("规划结果不是有效 JSON，缺少 jobs");
  const jobs = validateParallelJobs(parsed.jobs, { minimum });
  const readyJobs = jobs.filter((job) => job.dependsOn.length === 0);
  if (!readyJobs.length) {
    throw new Error("自动计划至少需要一个可立即执行的任务");
  }
  return {
    summary: String(parsed.summary || "自动生成的并行计划").trim(),
    sharedContract: String(parsed.sharedContract || ''),
    acceptanceCriteria: normalizeDeliveryContract({acceptanceCriteria:parsed.acceptanceCriteria}).acceptanceCriteria,
    jobs,
    coverage: Array.isArray(parsed.coverage) ? parsed.coverage : []
  };
}

export { normalizePlan as normalizeParallelPlan };

function publicJob({ workerPath, commit, sourceCommit, ...job }) {
  return {...job, reportChars: job.output?.length || 0, deepLink: job.threadId ? threadDeepLink(job.threadId) : ''};
}

// Progress is an explicit projection, built directly from the cached run before
// serializing. Never spread a full run/job here: output and history grow without
// bounds. The selected-job endpoint retains complete text and messages.
function progressRun(run) {
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
  return {
    ...pick(run,['id','status','objective','summary','createdAt','updatedAt','finishedAt','acceptedAt','completedAt','totalDurationMs','error','branchTree','coordination']),
    goal:run.goal?pick(run.goal,['immediate','stageNodeId']):null,
    result:run.result?{cleanup:run.result.cleanup?pick(run.result.cleanup,['status']):null}:null,
    jobs:(run.jobs||[]).map(job=>({...pick(job,['taskId','nodeId','title','status','summary','error','activity','acceptingGuidance','startedAt','finishedAt','completedTools','activeTools','contextResumed','contextGeneration']),
      summary:job.summary||job.instruction||'',reportChars:job.output?.length||0}))
  };
}

function publicRun(run, {view} = {}) {
  if(view==='progress')return progressRun(run);
  return {
    id: run.id,
    status: run.status,
    objective: run.objective || "",
    goal: run.goal || null,
    summary: run.summary || "",
    sharedContract: run.sharedContract || '',
    coordination: run.coordination || null,
    acceptanceCriteria: run.acceptanceCriteria || [],
    ...(run.reviewScopeFiles === undefined ? {} : {reviewScopeFiles:[...run.reviewScopeFiles]}),
    workspacePath: run.workspacePath || '',
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt || "",
    acceptedAt: run.acceptedAt || "",
    completedAt: run.completedAt || "",
    totalDurationMs: Number.isFinite(run.totalDurationMs) ? run.totalDurationMs : null,
    error: run.error || "",
    sourceTree: run.sourceTree || null,
    branchTree: run.branchTree || null,
    planner: run.planner || null,
    jobs: (run.jobs || []).map(publicJob),
    peerMessages: (run.peerMessages || []).map((message) => ({
      ...message,
      fromDeepLink: message.fromThreadId ? threadDeepLink(message.fromThreadId) : "",
      toDeepLink: message.toThreadId ? threadDeepLink(message.toThreadId) : ""
    })),
    userMessages: run.userMessages || [],
    contextOptions: run.contextOptions || [],
    mergeConflicts: run.mergeConflicts || [],
    review: run.review || null,
    coverage: run.coverage || [],
    workspaceTimings: run.workspaceTimings || {},
    gitCommandTimings: run.gitCommandTimings || null,
    executionTree: runtimeTree(run),
    events: run.events || [],
    result: run.result || null,
    treeSummary: run.treeSummary || null, summaryWarning: run.summaryWarning || ''
  };
}

export function createParallelCodexCoordinator({
  projectRoot,
  startTurn = startCodexTurn,
  reviewTurn,
  repairTurn,
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
        // Keep an explicitly supplied candidate/worktree root. Final checkers
        // must not write into the live project and trigger their own recheck.
        TASK_TREE_PROJECT_ROOT: options.environment?.TASK_TREE_PROJECT_ROOT || projectRoot,
        TASK_TREE_QUALITY_MODE: 'advisory'
      }
    });
  }
  // Test doubles for Worker turns do not constitute an independent reviewer.
  // Production always starts a fresh review conversation; focused tests may
  // inject reviewTurn explicitly to exercise this boundary.
  const independentReview = reviewTurn === undefined ? (injectedStartTurn ? null : startTurn) : reviewTurn;
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
  const executionOptions = new Map();
  const incrementalWorkspace = createDirectNodeWorkspace({ projectRoot, workspace, startTurn, reviewTurn: independentReview });
  const unreviewedWorkspace = createDirectNodeWorkspace({ projectRoot, workspace, startTurn, reviewTurn: null });
  const pending = new Map();
  const background = new Map();
  const additions = new Map();
  const wakeups = new Map();
  const mailboxes = new Map();
  const activityTimers = new Map();
  const workerSplits = new Map();
  function expandDependencies(run,ids){
    const byId=new Map(run.jobs.map(job=>[job.taskId,job]));
    const expand=id=>byId.get(id)?.splitChildren?.length?byId.get(id).splitChildren.flatMap(expand):[id];
    return [...new Set(ids.flatMap(expand))];
  }
  function workerNotification(run, job, message) {
    const trace=recordAgentActivity(job, message);
    if(trace)event(run,'worker_execution',{taskId:job.taskId,...trace});
    executionOptions.get(run.id)?.onProgress?.({id:run.id,taskId:job.taskId,notification:message,jobs:run.jobs});
    if(!activityTimers.has(run.id))activityTimers.set(run.id,setTimeout(()=>{
      activityTimers.delete(run.id);
      void persist(run).catch(error=>{run.progressSaveWarning=error.message;});
    },750));
  }
  const runsDir = path.join(projectRoot, ".task-tree-runs");
  async function materialContext(run, nodeIds) {
    if (!run.materialTreeId) {
      const registry = await loadTreeRegistry({ projectRoot, registryFile: path.join(projectRoot, 'task-trees.json'), create: false });
      run.materialTreeId = run.sourceTree?.id || registry.trees.find(tree => tree.path === 'task-tree.md')?.id || registry.activeMethod;
    }
    return nodeMaterialContext({ projectRoot, treeId: run.materialTreeId, nodeIds });
  }
  async function plannerMaterialContext(run, nodeId) {
    return materialContext(run, await branchMaterialNodeIds({ projectRoot, nodeId }));
  }
  const systemContextsFile = path.join(runsDir, "system-contexts");
  let systemContextsPromise = null;
  let persistQueue = Promise.resolve();
  let plannerQueue = Promise.resolve();
  let branchTreeQueue = Promise.resolve();

  function stageBranches(run, appended, splitParent) {
    const next = branchTreeQueue.catch(() => {}).then(async () => {
      const childIds=appended?.map(job=>job.taskId)||[];
      const nextJobs=appended?[...run.jobs,...appended]:run.jobs;
      const candidateJobs=splitParent?nextJobs.map(job=>job.dependsOn.includes(splitParent.taskId)
        ?{...job,dependsOn:[...new Set(job.dependsOn.flatMap(id=>id===splitParent.taskId?childIds:[id]))]}:job):nextJobs;
      if(splitParent)assertAcyclic(candidateJobs);
      const candidate=appended?{...run,jobs:candidateJobs}:run;
      await materializeParallelBranches(projectRoot, candidate, appended || run.jobs);
      // materialization assigns branchTree on its argument, and execution node
      // identities on jobs. Keep those durable references on the running state.
      run.branchTree=candidate.branchTree;
      if(splitParent)for(const job of run.jobs)job.dependsOn=candidateJobs.find(candidate=>candidate.taskId===job.taskId).dependsOn;
      if (appended) run.jobs.push(...appended);
    });
    branchTreeQueue = next;
    return next;
  }

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
    const options = executionOptions.get(run.id);
    options?.onProgress?.({ id: run.id, status: run.status, jobs: run.jobs, coordination: run.coordination, event: type, detail: data });
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

  async function integrateWorkerOutput(run,job,integrate) {
    if(workspace.captureReviewInputs)job.reviewInputs=await workspace.captureReviewInputs(job.workerPath);
    const inspected = await workspace.inspectChanges(job.workerPath, job.sourceCommit, job.writeSet);
    job.changedFiles = inspected.changedFiles;
    if(job.deliverables?.length&&!job.splitChildren?.length&&!job.checkpointingSplit) {
      const started=performance.now();
      try {job.deliveryReceipt=await inspectDeliverables(job.workerPath,job,{projectRoot});}
      finally {event(run,'coordination_delivery_timing',{taskId:job.taskId,operation:'inspectDeliverables',durationMs:performance.now()-started});}
      const missing=job.deliveryReceipt.filter(item=>item.status!=='satisfied');
      if(missing.length) {
        job.workerCompleted=false;
        throw Object.assign(new Error(`交付合同尚未满足：${missing.map(item=>`${item.path}：${item.reason}`).join('；')}`),{code:'DELIVERY_CONTRACT_UNSATISFIED'});
      }
    }
    if(run.incremental && run.finalReviewOnly && !inspected.changedFiles.length){
      // Read-only branches have no candidate to merge. The final checker still
      // receives their reports; skip empty worktrees, commits and live snapshots.
      job.appliedFiles=[];job.treeChanges=[];job.acceptanceStatus='pending';job.commit=job.sourceCommit;
      return;
    }
    if (run.incremental) {
      const finalReviewOnly=executionOptions.get(run.id)?.finalReviewOnly ?? run.finalReviewOnly;
      if (finalReviewOnly) job.acceptanceStatus = 'pending';
      const candidatePath = await workspace.createWorker(run.id, `candidate-${job.taskId}-${randomUUID()}`, job.sourceCommit);
      try {
        const receipt = await (finalReviewOnly ? unreviewedWorkspace : incrementalWorkspace).finish({ runId: run.id, workerPath: job.workerPath,
          integrationPath: candidatePath, snapshotCommit: job.sourceCommit }, {
          nodeId: job.executionNodeId || job.nodeId,
          objective: `${job.instruction}\n宿主要求回写自己的分支执行节点及其自动备份；任务说明中不改树的限制仅针对来源树和其它分支，不禁止此执行汇报。`,
          output: job.output, status: 'completed', sharedContract:job.sharedContract || run.sharedContract || '',
          ...(job.reviewInputs?{reviewInputs:[job.reviewInputs]}:{}),
          historyMessages:executionOptions.get(run.id)?.contextMessages || [],dialogueContext:executionOptions.get(run.id)?.historyMessages,
          treeFile:job.subtreeFile || run.sourceTree?.path,threadId:job.threadId,signal:executionOptions.get(run.id)?.signal,keepWorkspace:true,
          onTiming:sample=>event(run,'worker_integration_timing',{taskId:job.taskId,...sample}),
          onPhase:(phase,message)=>event(run,'worker_phase',{taskId:job.taskId,phase,message})
        });
        job.appliedFiles=receipt.appliedFiles;job.treeChanges=receipt.treeChanges||[];job.changedFiles=receipt.changedFiles;job.review=receipt.review;
      } finally {await workspace.removeWorker(candidatePath).catch(()=>{});}
    }
    job.commit=await workspace.commit(job.workerPath,`parallel ${job.taskId}`,job.sourceCommit);
    await integrate(job.commit,job.sourceCommit);
  }

  function splitWorker(run,job,args,integrate) {
    const key=`${run.id}:${job.taskId}`;
    const completed=()=>({ok:true,taskIds:job.splitChildren,hostCompletion:{status:'completed',output:job.splitOutput}});
    if(job.splitChildren?.length)return Promise.resolve(completed());
    if(workerSplits.has(key))return workerSplits.get(key);
    const pendingSplit=(async()=>{
      const signal=executionOptions.get(run.id)?.signal;
      signal?.throwIfAborted();
      if(!run.incremental || !run.finalReviewOnly)throw new Error('继续拆分需要本轮统一整合及一次最终验收');
      if(!canWorkerSplit(job, run.jobs))throw new Error(`动态拆分最多允许 ${MAX_DYNAMIC_SPLIT_DEPTH} 层；请在当前任务内完成剩余子主题`);
      const input=args.jobs;
      if(!Array.isArray(input)||input.length<2)throw new Error('请至少提供两个可独立交付的剩余任务');
      const idMap=new Map(input.map(child=>[String(child.taskId),`${job.taskId}.${cleanId(child.taskId)}`]));
      const jobs=validateParallelJobs(input.map(child=>({...child,taskId:idMap.get(String(child.taskId)),nodeId:job.nodeId,parentTaskId:job.taskId,
        dependsOn:expandDependencies(run,(child.dependsOn||[]).filter(id=>id!==job.taskId).map(id=>idMap.get(id)||id)),
        sharedContract:run.sharedContract,contextPolicy:'new'})),{minimum:2,knownTaskIds:run.jobs.map(item=>item.taskId),existingJobs:run.jobs});
      const already=new Set(run.jobs.map(item=>item.taskId.toLowerCase()));
      if(jobs.some(child=>already.has(child.taskId.toLowerCase())))throw new Error('剩余任务已经提交，请勿重复拆分');
      const done=new Set(run.jobs.filter(item=>item.status==='completed').map(item=>item.taskId));
      if(jobs.filter(child=>child.dependsOn.every(id=>done.has(id))).length<2)throw new Error('该拆分没有至少两个可立即执行的任务');
      const childIds=jobs.map(child=>child.taskId);
      const rewired=run.jobs.map(consumer=>({...consumer,dependsOn:consumer.dependsOn.flatMap(id=>id===job.taskId?childIds:[id])}));
      assertAcyclic([...rewired,...jobs]);
      event(run,'worker_subdivision_started',{taskId:job.taskId,reason:args.reason});
      if(!job.splitCheckpoint){
        job.output='已保存本分支已有成果，剩余工作交由子分支继续；整体尚待最终验收。';
        job.checkpointingSplit=true;
        try {await integrateWorkerOutput(run,job,integrate);} finally {delete job.checkpointingSplit;}
        job.splitCheckpoint=true;await persist(run);
      }
      await api.append(run.id,{jobs,reason:args.reason},job);
      return completed();
    })().finally(()=>workerSplits.delete(key));
    workerSplits.set(key,pendingSplit);return pendingSplit;
  }

  async function runWorker(run, job, integrate) {
    let workerHandoffStaged = false;
    try {
      if(job.splitChildren?.length){
        job.status='completed';job.output=job.splitOutput;
        event(run,'worker_handoff_recovered',{taskId:job.taskId,taskIds:job.splitChildren});return;
      }
      job.status = "preparing";
      job.finishedAt = '';
      job.acceptingGuidance = true;
      job.startedAt ||= new Date().toISOString();
      executionOptions.get(run.id)?.signal?.throwIfAborted();
      event(run, "worker_preparing", { taskId: job.taskId, nodeId: job.nodeId });
      await persist(run);
      if (job.resumeAfterRestart && job.workerPath && job.sourceCommit && workspace.resumeWorker) {
        await workspace.resumeWorker(job.workerPath, { contextKey: job.contextKey });
      } else {
        const persistentPath = job.resumeAfterRestart && job.contextKey && workspace.resumePersistentWorker
          ? await workspace.resumePersistentWorker(job.contextKey)
          : "";
        if (persistentPath) {
          job.workerPath = persistentPath;
          await workspace.resumeWorker?.(persistentPath, { contextKey: job.contextKey });
        } else {
          job.sourceCommit = await workspace.head(run.workspace.integrationPath);
          job.workerPath = await workspace.createWorker(run.id, job.taskId, job.sourceCommit, {
            contextKey: job.contextKey,
            persistentContext: true
          });
        }
      }
      const inheritedInputs=[run.workspace.reviewInputs,run.initialReceipt?.reviewInputs,
        run.jobs.find(parent=>parent.taskId===job.parentTaskId)?.reviewInputs].flat().filter(Boolean);
      const inputMaterials=workspace.materializeReviewInputs&&inheritedInputs.length
        ?await workspace.materializeReviewInputs(job.workerPath,inheritedInputs,{register:true}):null;
      // Appended tasks may not exist in the original snapshot. Seed only their
      // own branch file; never copy another worker's ongoing edits.
      for (const relative of [job.subtreeFile, job.taskFile].filter(Boolean)) {
        try { await readFile(path.join(job.workerPath, relative)); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(path.dirname(path.join(job.workerPath, relative)), { recursive: true });
          await writeFile(path.join(job.workerPath, relative), await readFile(path.join(projectRoot, relative)));
        }
      }
      if(job.deliverables?.length&&!job.deliveryBaseline) {
        const started=performance.now();
        try {job.deliveryBaseline=await snapshotDeliverables(job.workerPath,job.deliverables,{projectRoot});}
        finally {event(run,'coordination_delivery_timing',{taskId:job.taskId,operation:'snapshotDeliverables',durationMs:performance.now()-started});}
        await persist(run);
      }
      // Delivery is a separate durable checkpoint from execution. A failed
      // merge must not ask a successful worker to rediscover or rewrite work.
      if (job.resumeAfterRestart && job.workerCompleted
        && !run.userMessages?.some(message => message.taskId === job.taskId && message.status === 'queued')) {
        job.acceptingGuidance = false;
        job.activity = { label: '复用已完成成果，仅恢复整合', at: new Date().toISOString() };
        event(run, 'worker_integration_resumed', { taskId: job.taskId });
        await integrateWorkerOutput(run, job, integrate);
        job.status = 'completed';
        job.error = '';
        delete job.retryReason;
        delete job.resumeAfterRestart;
        event(run, 'completed', { taskId: job.taskId, nodeId: job.nodeId, changedFiles: job.changedFiles });
        return;
      }
      job.workerCompleted = false;
      job.contextPersistent = true;
      const recoveryRotation=job.recovery?.action==='fresh-context';
      const rotateContext = recoveryRotation || shouldRotateContext(job);
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
        delete job.contextUsage;
        delete job.contextUsagePercent;
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
      const workerPrompt=buildWorkerPrompt(job, handoffPath, run.jobs) + (inputMaterials?`\n${inputMaterials.prompt}`:'') + (job.resumeAfterRestart ? `\n【失败分支续跑】复用原隔离目录${recoveryRotation?'，使用新会话从任务、当前树和已保存检查点继续，不重新载入失败的超长历史':'和会话'}；先核对已落盘成果，不重放成功操作，只继续本分支剩余工作。${job.retryReason ? `\n此前失败原因：${job.retryReason}` : ''}` : '')
        + (recoveryRotation ? `\n本分支运行中的用户指导（最新优先）：${JSON.stringify((run.userMessages||[]).filter(message=>message.taskId===job.taskId))}`:'');
      const workerTurnOptions = {
        signal: executionOptions.get(run.id)?.signal,
        onNotification: message => workerNotification(run,job,message),
        prompt: workerPrompt,
        // A branch receives its scoped task prompt and node materials. Copying
        // parent dialogue here multiplies every prior agent report by fan-out.
        contextMessages: await materialContext(run, [run.goal?.stageNodeId, job.nodeId]),
        systemPrompt: '你是并行分支 Worker。用中文报告进度，只执行本次 Task id 对应的分支说明。父节点对话和资料是背景，不是再次执行整个父目标的指令；不要重复其他分支。完成实际交付后保存自己相关节点的结果。',
        cwd: job.workerPath,
        environment: { TASK_TREE_PROJECT_ROOT: projectRoot, TASK_TREE_CONTEXT_NODE_ID: job.executionNodeId || job.nodeId, TASK_TREE_QUALITY_MODE: 'advisory',
          ...(job.subtreeFile ? { TASK_TREE_CONTEXT_TREE_FILE: job.subtreeFile } : {}) },
        tools: [...TREE_CONTEXT_TOOLS, PEER_EXCHANGE_TOOL,
          ...(run.incremental && canWorkerSplit(job, run.jobs) ? [WORKER_SPLIT_TOOL] : [])],
        toolHandler: (name,args) => name===WORKER_SPLIT_TOOL.function.name
          ? splitWorker(run,job,args,integrate)
          : name===PEER_EXCHANGE_TOOL.function.name
          ? mailboxes.get(run.id).exchange(job.taskId,args)
          : treeContextHandler(job.workerPath, run.sourceTree)(name,args),
        beforeModelRequest: () => mailboxes.get(run.id).drain(job.taskId),
        initialToolCalls: [{ id: `host-node-${randomUUID()}`, type: 'function', function: { name: 'task_tree_node', arguments: JSON.stringify({ nodeId: job.executionNodeId || job.nodeId }) } }],
        threadId: job.contextSource === "codex" ? "" : (job.contextThreadId || ""),
        forkThreadId: job.contextSource === "codex" ? (job.contextThreadId || "") : "",
        forceNewThread: rotateContext,
        threadName: `任务图 · 并行 ${String(run.jobs.indexOf(job) + 1).padStart(2, "0")} · ${humanizeTitle(job.title, job.taskId)}`,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        developerInstructions: "完成分配任务并运行相关测试。",
        // Worker narration is an ordinary report. Host Git inspection supplies
        // actual file receipts; there is no formatting-only inference round.
        ...(executionOptions.get(run.id)?.finalReviewOnly ? {} : {outputSchema: WORKER_RESULT_SCHEMA}),
        waitForCompletion: true,
        onAccepted: async ({ threadId, turnId }) => {
          job.hasStreamedOutput=false;
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
      };
      let result = await startTurn(workerTurnOptions);
      if(job.splitChildren?.length)result={...result,status:'completed',output:job.splitOutput,error:undefined};
      // A provider can end a turn with status=stopped without the user having
      // pressed Stop (for example a transient worker/session interruption).
      // That is recoverable execution state, not a completed task. Keep the
      // same Git worktree and conversation, publish the state, and continue
      // until the model actually completes or the user's signal is aborted.
      while ((result?.status === 'stopped' || (['completed',undefined].includes(result?.status)
        && run.userMessages?.some(message=>message.taskId===job.taskId&&message.status==='queued')))
        && !executionOptions.get(run.id)?.signal?.aborted) {
        const guidanceContinuation=result?.status!=='stopped';
        job.output = compactWorkerOutput(result.output || job.output || '');
        if(!guidanceContinuation) {
        job.status = 'retrying';
        job.error = '模型会话意外停止，正在使用同一工作区和会话续跑';
        event(run, 'worker_stopped', { taskId: job.taskId, nodeId: job.nodeId, threadId: result.threadId || job.contextThreadId || job.threadId || '', output: job.output });
        await persist(run);
        executionOptions.get(run.id)?.signal?.throwIfAborted();
        job.status = 'running';
        job.retryCount = Number(job.retryCount || 0) + 1;
        event(run, 'worker_retrying', { taskId: job.taskId, nodeId: job.nodeId, retryCount: job.retryCount, threadId: result.threadId || job.contextThreadId || job.threadId || '' });
        } else event(run,'worker_guidance_continuing',{taskId:job.taskId});
        await persist(run);
        result = await startTurn({
          ...workerTurnOptions,
          prompt: guidanceContinuation ? '用户在本分支收尾时发来了新指导，请读取本轮用户消息，落实或回答后再交付；保留已有成果，不重放已完成操作。'
            : `【自动续跑】上一轮模型会话意外停止，未完成本分支任务。保留已落盘的工作区和已有会话上下文；先检查当前成果和未完成项，不重放已成功的工具调用，继续完成原 Task id ${job.taskId}，完成后提交完整结果。${job.output ? `上一轮已输出片段：\n${job.output}` : ''}`,
          threadId: result.threadId || job.contextThreadId || job.threadId || '',
          forkThreadId: '',
          forceNewThread: false
        });
      }
      if (result.timing) event(run, "worker_turn_timing", { taskId: job.taskId, nodeId: job.nodeId, timing: result.timing });
      job.acceptingGuidance=false;
      job.activeTools={};
      job.activity={label:'正在整合分支成果',at:new Date().toISOString()};
      try { assertTurnCompleted(result); }
      catch (error) {
        job.output = compactWorkerOutput(result.output || '');
        throw error;
      }
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
      if (rotateContext && !recoveryRotation && job.parentThreadId) {
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
      const rawOutput = String(result.structuredOutput || result.messages?.at(-1)?.content || result.output || "");
      const parsedOutput = parseJsonObject(rawOutput);
      job.output = compactWorkerOutput(rawOutput, parsedOutput);
      if (parsedOutput?.event === "blocked") throw new Error(job.output);
      job.evidence = compactGoalText(parsedOutput?.evidence || rawOutput);
      delete job.retryReason;
      delete job.resumeAfterRestart;
      job.peerRequests = normalizePeerRequests(rawOutput, run.jobs, job.taskId);
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

      job.workerCompleted = true;
      await persist(run);
      if(!job.splitChildren?.length)await integrateWorkerOutput(run,job,integrate);
      job.status = "completed";
      job.error = '';
      delete job.recovery;
      if(run.coordination?.taskId===job.taskId)run.coordination={phase:'executing',message:'该分支已恢复并整合，继续推进其余任务',updatedAt:new Date().toISOString()};
      event(run, "completed", { taskId: job.taskId, nodeId: job.nodeId, changedFiles: job.changedFiles });
    } catch (error) {
      job.status = executionOptions.get(run.id)?.signal?.aborted ? 'stopped' : 'failed';
      job.error = error.message;
      if (error.code === 'COMPLETION_REVIEW_FAILED') { job.reviewFailed = true; job.review = error.review || null; }
      if (error.workspacePath) job.workspacePath = error.workspacePath;
      if (error.threadId) {
        job.threadId = error.threadId;
        job.contextThreadId = error.threadId;
        rememberRunContext(run, job);
      }
      job.failure={message:error.message,...executionErrorDetails(error)};
      const recovery=recoveryDecision(job,error,{aborted:executionOptions.get(run.id)?.signal?.aborted});
      if(recovery&&workspace.resumePersistentWorker) {
        job.recovery=recovery;job.recoveryHistory=[...(job.recoveryHistory||[]),recovery];
        job.retryReason=error.message;job.resumeAfterRestart=true;job.status='queued';
        if(recovery.action!=='integrate-only')job.workerCompleted=false;
        run.coordination={phase:'recovering',taskId:job.taskId,action:recovery.action,message:recovery.action==='fresh-context'?'保留工作区，从任务树和检查点换新上下文继续':recovery.action==='integrate-only'?'复用已完成成果，仅重试整合':'交付物未落盘，已定点回派原分支补交',updatedAt:recovery.at};
        event(run,'coordination_recovery_scheduled',{taskId:job.taskId,...run.coordination,reason:recovery.reason});
      } else event(run, "blocked", { taskId: job.taskId, nodeId: job.nodeId, error: error.message });
    } finally {
      job.acceptingGuidance=false;
      job.activeTools={};
      job.finishedAt=new Date().toISOString();
      if (workerHandoffStaged && job.workerPath) await removeWorkerHandoff(job.workerPath).catch(() => {});
      if (job.workerPath) await workspace.removeWorker(job.workerPath, { preserveContext: true, contextKey: job.contextKey }).catch(() => {});
      delete job.workerPath;
      rememberRunContext(run, job);
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
        contextMessages: await materialContext(run, [run.goal?.stageNodeId, sourceJob.nodeId]),
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
        waitForCompletion: true
      });
      assertTurnCompleted(result);
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
      mailboxes.set(run.id,createPeerMailbox(run,{persist,onEvent:(type,detail)=>event(run,type,detail)}));
      registerWorkspaceRun(run);
      run.status = run.workspace?.integrationPath ? "running" : "preparing";
      run.error = "";
      run.projectRoot = projectRoot;
      run.coordination={phase:'executing',message:'就绪分支并行执行；完成即整合，最后统一验收',updatedAt:new Date().toISOString()};
      run.result = null;
      run.finishedAt = "";
      if (!run.workspace?.integrationPath) {
        event(run, "snapshot_started");
        await persist(run);
        run.workspace = await workspace.prepare(run.id,{captureInputs:true});
        run.status = "running";
        event(run, "run_started", { snapshotCommit: run.workspace.snapshotCommit });
      } else {
        event(run, "run_resumed");
      }
      await persist(run);

      let integrationQueue = Promise.resolve();
      let peerRelayQueue = Promise.resolve();
      let peerRelayError = null;
      const integrate = (commit, sourceCommit, job) => {
        const next = integrationQueue.then(async () => {
          if (run.incremental) {
            const live = await workspace.prepare(`sync-${randomUUID()}`);
            try { return await workspace.syncIntegration(run.workspace.integrationPath, live.snapshotCommit); }
            finally { await workspace.cleanup({ ...live, runId: path.basename(live.runDir) }); }
          }
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
        if (run.incremental) return;
        const jobsById = new Map(run.jobs.map((job) => [job.taskId, job]));
        const handled = new Set((run.peerMessages || []).map((message) => message.id));
        const requests = run.jobs.flatMap((job) => (job.peerRequests || [])
          .filter((request) => !handled.has(request.id) && job.status === 'completed'
            && jobsById.get(request.toTaskId)?.status === 'completed')
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
              contextMessages: await materialContext(run, [run.goal?.stageNodeId, target.nodeId]),
              cwd: targetPath,
              threadId: target.contextThreadId,
              sandbox: "read-only",
              approvalPolicy: "never",
              developerInstructions: "Answer one peer consultation from the existing branch context. Do not edit files or delegate.",
              waitForCompletion: true
            });
            assertTurnCompleted(answer);
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
                contextMessages: await materialContext(run, [run.goal?.stageNodeId, source.nodeId]),
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
                waitForCompletion: true
              });
              assertTurnCompleted(continuation);
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
      const schedulePeerRelay = () => {
        const next = peerRelayQueue.catch(() => {}).then(relayPeerRequests).catch(error => {
          peerRelayError ||= error;
          event(run, 'peer_relay_failed', { error: error.message });
        });
        peerRelayQueue = next;
        return next;
      };
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
          if (job.dependsOn.some((id) => ["failed", "blocked", "stopped"].includes(byId.get(id)?.status))) {
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
          const promise = runWorker(run, job, (commit, sourceCommit) => integrate(commit, sourceCommit, job))
            .then(() => { void schedulePeerRelay().catch(() => {}); return taskId; });
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
      await schedulePeerRelay();
      await peerRelayQueue;
      if (peerRelayError) throw peerRelayError;
      await integrationQueue;

      run.status = "applying";
      await persist(run);
      const summary = await workspace.summarize(run.workspace.integrationPath, run.workspace.snapshotCommit);
      const failedTasks = run.jobs.filter((job) => job.status !== "completed").map((job) => job.taskId);
      run.result = {
        ...summary,
        summary: buildRunOutcomeSummary(run),
        affectedNodes: [...new Set(run.jobs.map((job) => job.nodeId))],
        failedTasks,
        warnings: failedTasks.length ? [`${failedTasks.length} 个分支未完成`] : []
      };
      if (run.incremental) run.result.appliedFiles = [...new Set([...(run.initialReceipt?.appliedFiles||[]),...run.jobs.flatMap(job => job.appliedFiles || [])])];
      if (run.incremental) run.result.treeChanges = [...(run.initialReceipt?.treeChanges||[]),...run.jobs.flatMap(job => job.treeChanges || [])];
      run.summary = run.result.summary;
      if (run.jobs.some((job) => ["queued", "planned"].includes(job.status))) return execute(run);
      if (failedTasks.length) {
        run.status = "failed";
        run.error = run.jobs.filter((job) => job.status !== "completed").map((job) => `${job.taskId}: ${job.error || job.status}`).join("\n");
      } else if (run.incremental) {
        if ((executionOptions.get(run.id)?.finalReviewOnly ?? run.finalReviewOnly) && independentReview) {
          run.status = 'checking';
          run.coordination={phase:'checking',message:'分支已整合，独立检查Agent按完整交付清单最终验收',updatedAt:new Date().toISOString()};
          if(run.branchTree)await recordParallelBranchResults(projectRoot,run);
          event(run, 'final_review_started');
          const receipt = await incrementalWorkspace.reviewIntegrated({ ...run.workspace, snapshotCommit:run.reviewBaselineCommit || run.workspace.snapshotCommit, runId: run.id }, {
            nodeId: run.sourceSelection?.nodeId || run.goal?.stageNodeId,
            objective: run.objective,
            changedFiles:run.result.appliedFiles,
            onPhase: (phase,message) => event(run,'final_review_phase',{phase,message}),
            onNotification: notification => event(run,'final_review_progress',{notification}),
            userGuidance: run.userMessages || [],
            sharedContract: run.sharedContract,
            delegationReceipt: coordinationEvidence(run),
            ...(run.reviewScopeFiles === undefined ? {} : {reviewScopeFiles:run.reviewScopeFiles}),
            // These are host-created copies of the complete tasks and their
            // execution bookkeeping, not the user's source/business trees.
            // The jobs above already carry instructions and reports verbatim.
            executionFiles:[run.branchTree?.path,run.branchTree?.planPath,...run.jobs.flatMap(job=>[job.taskFile,job.subtreeFile])].filter(Boolean),
            reviewInputs:[run.workspace.reviewInputs,run.initialReceipt?.reviewInputs,...run.jobs.map(job=>job.reviewInputs)].flat().filter(Boolean),
            historyMessages: executionOptions.get(run.id)?.contextMessages || [],
            dialogueContext: executionOptions.get(run.id)?.historyMessages,
            treeFile: run.sourceTree?.path,
            signal: executionOptions.get(run.id)?.signal,
            onTiming: sample => event(run, 'final_review_timing', sample),
          });
          run.review = { status:'passed', ...receipt.review };
          run.result.appliedFiles = [...new Set([...run.result.appliedFiles, ...receipt.appliedFiles])];
          run.result.treeChanges = [...(run.result.treeChanges || []), ...(receipt.treeChanges || [])];
          for (const job of run.jobs) job.acceptanceStatus = 'passed';
          event(run, 'final_review_completed', { review: run.review });
        }
        run.result.appliedFiles ||= [...new Set(run.jobs.flatMap(job => job.appliedFiles || []))];
        run.result.cleanup = { status: 'queued', error: '' };
        run.status = 'accepted';
        run.acceptedAt = new Date().toISOString();
        event(run, 'accepted', { appliedFiles: run.result.appliedFiles, automatic: true, incremental: true });
        scheduleBackground(run.id, () => finalizeAcceptedRun(run));
      } else {
        await applyRun(run);
      }
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      if (error.review) run.review = { status:'failed', ...error.review };
      if (run.finalReviewOnly) for (const job of run.jobs) job.acceptanceStatus = 'failed';
      if (error.workspacePath) run.workspacePath = error.workspacePath;
      event(run, "run_failed", { error: error.message });
    }
    run.finishedAt = new Date().toISOString();
    run.coordination={phase:run.status==='accepted'?'completed':'blocked',message:run.status==='accepted'?'真实成果已整合，最终独立验收通过':run.error||'尚未通过最终验收',updatedAt:run.finishedAt};
    clearTimeout(activityTimers.get(run.id));
    activityTimers.delete(run.id);
    mailboxes.delete(run.id);
    await refreshRunSummary(run);
    await persist(run);
    return publicRun(run);
  }

  async function refreshRunSummary(run) {
    // Derived from post-merge facts, not the planner's original promises.
    try {
      if (run.branchTree) await recordParallelBranchResults(projectRoot, run);
      const fresh = await readTreeSummary({ projectRoot, tree: run.sourceTree, persist: true });
      run.treeSummary = { snapshotPath: fresh.snapshotPath, fingerprint: fresh.fingerprint, generatedAt: fresh.generatedAt };
      delete run.summaryWarning;
    } catch (error) { run.summaryWarning = error.message; }
    run.summary = buildRunOutcomeSummary(run);
    if (run.result) run.result.summary = run.summary;
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
      const contextMessages = await plannerMaterialContext(run, nodeId);
      const historyMessages = executionOptions.get(run.id)?.contextMessages || [];
      result = injectedStartTurn ? null : await requestDeepSeekPlanner({ projectRoot, prompt: plannerPrompt, outputSchema, onNotification: markPlannerItem, contextMessages, historyMessages, dialogueContext: executionOptions.get(run.id)?.historyMessages || historyMessages, sourceTree: run.sourceTree });
      // Tests may inject a deterministic startTurn; production has no Codex fallback.
      if (!result && injectedStartTurn) result = await startTurn({
        prompt: plannerPrompt,
        ...(historyMessages.length ? { messages: [...historyMessages, { role: 'user', content: plannerPrompt }] } : {}),
        contextMessages,
        cwd: projectRoot,
        threadId: "",
        threadName: "任务图 · 自动规划（系统）",
        ...(PLANNER_MODEL ? { model: PLANNER_MODEL } : {}),
        ...(PLANNER_REASONING_EFFORT ? { config: { model_reasoning_effort: PLANNER_REASONING_EFFORT } } : {}),
        outputSchema,
        sandbox: "read-only", approvalPolicy: "never",
        developerInstructions: "Start with the supplied tree summary. Read full task-tree.md or a specific subtree only if needed. Return a JSON plan; never edit files.",
        waitForCompletion: true,
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
      assertTurnCompleted(result);
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
      const source = await readParallelSource(projectRoot, run.sourceSelection);
      run.sourceTree = source.tree;
      let markdown = source.markdown;
      if (source.nodeId) markdown = markdown.replace(/(^- (?:Current|Next):)[^\r\n]*/gm, `$1 ${source.nodeId}`);
      const treeSummary = await readTreeSummary({ projectRoot, tree: source.tree, markdown, persist: true });
      run.objective = cleanObjective(objective);
      run.goal = deriveParallelGoal(markdown, objective);
      [run.goal.history, run.contextOptions] = await Promise.all([
        readGoalHistory(runsDir, run.id), readContextOptions(runsDir, run.id)
      ]);
      const { plan, result } = await requestPlan(run,
        buildPlannerPrompt(markdown, objective, run.goal.history, treeSummary),
        (output) => normalizePlan(output, markdown, objective, { minimum: 1 }), run.goal.stageNodeId);
      run.summary = plan.summary;
      const enrichedJobs = enrichPlannedJobs(plan.jobs, {
        markdown,
        goal: run.goal,
        history: run.goal.history, treeSummary
      });
      run.sharedContract = plan.sharedContract;
      const jobs = assignParallelDraftContexts(enrichedJobs.map(job => ({ ...job, sharedContract: plan.sharedContract || job.sharedContract })), run.contextOptions);
      run.jobs = executionContexts(jobs, [], run.contextOptions).map((job) => ({
        ...job,
        runtimeMetadataPath: runsDir,
        status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
      }));
      run.coverage = plan.coverage || [];
      run.acceptanceCriteria = plan.acceptanceCriteria || [];
      run.planner = { status: "completed", threadId: result.threadId, turnId: result.turnId,
        contextResumed: Boolean(result.resumed), error: "", output: String(result.output || ""),
        timing: result.plannerTiming || run.planner?.timing || null };
      await stageBranches(run);
      event(run, 'branch_tree_created', { treeId: run.branchTree.id, path: run.branchTree.path });
      run.status = "queued";
      event(run, "plan_started", {
        jobs: run.jobs.map((job) => job.taskId),
        automatic: true,
        parallelRequired: run.jobs.length > 1,
        workerCount: run.jobs.length
      });
      await persist(run);
      return execute(run);
    } catch (error) {
      run.status = "failed";
      run.error = error.message;
      run.planner = { ...run.planner, status: "failed", error: error.message };
      event(run, "planning_failed", { error: error.message });
      await refreshRunSummary(run);
      await persist(run);
      return publicRun(run);
    }
  }

  async function recoverAbandonedPlan(run) {
    if (run.status !== "planning" || pending.has(run.id)) return run;
    // Missing local execution ownership (after restart), not elapsed wall time,
    // identifies abandoned planning. An active planner is protected by pending.
    event(run, "planning_recovered");
    const promise = Promise.resolve().then(() => generatePlan(run, run.objective)).finally(() => pending.delete(run.id));
    pending.set(run.id, promise);
    return run;
  }

  async function recoverAbandonedExecution(run) {
    if (pending.has(run.id) || !["queued", "preparing", "running", "applying", "checking"].includes(run.status)) return run;
    {
      // Completed branches keep their receipts. Interrupted branches continue
      // in their existing dirty worktrees; createWorker would reset those edits.
      run.jobs = run.jobs.map((job) => job.status === "completed" || ["failed","blocked","stopped"].includes(job.status) ? job : { ...job, status: "queued", resumeAfterRestart: true });
      run.status = "queued";
      event(run, "execution_requeued_after_restart");
      // Claim ownership before awaiting disk I/O; concurrent status polling or
      // a direct-node recovery cannot schedule the same branches twice.
      const promise = Promise.resolve().then(async () => { await persist(run); return execute(run); }).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return run;
    }
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
    const validateCandidate = independentReview ? async (candidatePath, liveBaseCommit, { attempt = 0, candidateId } = {}) => {
      run.review = { status: 'running', candidateCommit: await workspace.head(candidatePath), error: '' };
      event(run, 'review_started', { candidateCommit: run.review.candidateCommit, attempt, candidateId });
      await persist(run);
      const reviewPrompt = buildCompletionReviewPrompt([
          '【功能验收】直接在当前候选工作区验证用户要求的行为。',
          `用户目标：${run.objective || run.goal?.immediate || ''}`,
          ...(run.userMessages?.length ? [`用户补充要求：\n${run.userMessages.slice(-8).map(message => String(message.content || '').trim().slice(0,500)).filter(Boolean).join('\n').slice(0,2400)}`] : []),
          ...(run.sharedContract ? [`共享接口约定：${run.sharedContract}`] : []),
          await stageCoordinationEvidence(candidatePath,coordinationEvidence(run))
        ].join('\n\n'));
      const response = await independentReview({
        completionReview:true,
        cwd: candidatePath, prompt: reviewPrompt,
        // The review prompt already contains the objective, worker instructions,
        // shared contract and candidate evidence. Do not copy planner/chat
        // history into this one-shot checker or persist its internal exchange.
        persistDialogue: false,
        environment: { TASK_TREE_PROJECT_ROOT: candidatePath, TASK_TREE_CONTEXT_NODE_ID: run.sourceSelection?.nodeId || run.goal?.stageNodeId || '', TASK_TREE_QUALITY_MODE: 'advisory',
          ...(run.sourceTree?.path ? { TASK_TREE_CONTEXT_TREE_FILE: run.sourceTree.path } : {}) },
        stopHookPolicy: 'fail',
        forceNewThread: true, waitForCompletion: true
      });
      event(run, 'integration_review_turn_timing', { role: 'review', attempt, candidateId, timing: response.timing || null, status: response.status });
      assertTurnCompleted(response);
      const verdict = parseCompletionReview(response.messages?.at(-1)?.content || response.output);
      run.review = { ...verdict, status: verdict.verdict === 'pass' ? 'passed' : 'failed', candidateCommit: run.review.candidateCommit };
      event(run, verdict.verdict === 'pass' ? 'review_passed' : 'review_failed', { reason: run.review.reason });
      await persist(run);
      if (verdict.verdict === 'failed') throw completionReviewFailure(verdict);
      await assertWorkspaceTreeFiles(candidatePath, (await workspace.inspectChanges(candidatePath, liveBaseCommit)).changedFiles);
      await workspace.commitCandidateRepairs(candidatePath);
    } : undefined;
    let applied;
    try { applied = await workspace.accept({
      integrationPath: run.workspace.integrationPath,
      snapshotCommit: run.workspace.snapshotCommit,
      changedFiles: run.result?.changedFiles || [],
      onInvalidated: sample => event(run, 'candidate_invalidated', sample),
      resolveConflict: (integrationPath, files) => {
        const source = [...run.jobs].reverse().find((job) => job.changedFiles?.some((file) => files.includes(file))) || run.jobs.at(-1);
        return resolveMergeConflict(run, source, files, integrationPath, true);
      },
      validateCandidate: validateCandidate ? async (...args) => {
        try { await validateCandidate(...args); }
        catch (error) { throw completionReviewInterruption(error); }
      } : undefined
    }); } catch (error) {
      if (error.code === 'COMPLETION_REVIEW_FAILED') {
        run.review = { ...error.review, status: 'failed', workspacePath: error.workspacePath || '' };
        run.workspacePath = error.workspacePath || '';
        await persist(run);
      }
      throw error;
    }
    run.result ||= {};
    run.result.appliedFiles = applied.appliedFiles;
    run.result.treeChanges = applied.treeChanges || [];
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

  const api = {
    async plan({ objective = "", treeId, subtree, nodeId } = {}) {
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(),
        status: "planning",
        objective: cleanObjective(objective),
        sourceSelection: { treeId, subtree, nodeId },
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
      const { markdown } = await readParallelSource(projectRoot, run.sourceSelection);
      const treeSummary = await readTreeSummary({ projectRoot, tree: run.sourceTree, markdown });
      const submittedJobs = run.jobs || [];
      const selectedNodeId = cleanId(nodeId || run.goal?.stageNodeId);
      const { plan, result } = await requestPlan(run,
        buildBranchPlannerPrompt(markdown, selectedNodeId, objective || run.objective, submittedJobs, treeSummary, run.sharedContract),
        (output) => normalizeBranchPlan(output, markdown, selectedNodeId, objective || run.objective, submittedJobs),
        selectedNodeId,
        BRANCH_OUTPUT_SCHEMA);
      const [enriched] = enrichPlannedJobs([plan.job], {
        markdown,
        goal: run.goal || deriveParallelGoal(markdown, objective || run.objective),
        history: run.goal?.history || [], treeSummary
      });
      return await this.append(id, { jobs: [enriched] });
      } finally {
        additions.get(run.id)?.delete(token);
        wakeups.get(run.id)?.();
      }
    },

    async append(id, changes = {}, splitParent) {
      const run = await load(id);
      if (!run) throw new Error("找不到这次并行运行");
      if (!["queued", "preparing", "running", "failed"].includes(run.status)) {
        throw new Error("本轮已在收尾，请在下一轮添加任务");
      }
      const token = randomUUID();
      if (!additions.has(run.id)) additions.set(run.id, new Set());
      additions.get(run.id).add(token);
      try {
      const { markdown } = await readParallelSource(projectRoot, run.sourceSelection);
      const treeSummary = await readTreeSummary({ projectRoot, tree: run.sourceTree, markdown });
      const jobsInput = Array.isArray(changes.jobs) ? changes.jobs.map(job=>({...job,dependsOn:expandDependencies(run,job.dependsOn||[])})) : [];
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
        singleFinalReview:run.finalReviewOnly,
        sharedContract: run.sharedContract || job.sharedContract || '',
        runtimeMetadataPath: runsDir,
        branchContext: buildBranchInputContext(job, { markdown, goal: run.goal || {}, history: run.goal?.history || [], treeSummary }),
        status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
      }));
      // Recheck after async context reads: application must have a fixed set of jobs.
      if (!["queued", "preparing", "running", "failed"].includes(run.status)) {
        throw new Error("本轮已在收尾，请在下一轮添加任务");
      }
      if (run.branchTree) await stageBranches(run, appended, splitParent);
      else run.jobs.push(...appended);
      if(splitParent){
        // Persist subdivision and dependency replacement with the appended jobs
        // before waking the scheduler. Restart never sees a half-handoff.
        const childIds=appended.map(job=>job.taskId);
        for(const consumer of run.jobs){
          if(!childIds.includes(consumer.taskId)&&consumer.dependsOn.includes(splitParent.taskId)){
            consumer.dependsOn=[...new Set(consumer.dependsOn.flatMap(id=>id===splitParent.taskId?childIds:[id]))];
          }
        }
        splitParent.splitChildren=childIds;
        splitParent.splitOutput=`已有成果已保存；剩余任务已加入当前流水线：${childIds.join('、')}。子分支继续执行，整体最后统一验收。`;
        event(run,'worker_subdivided',{taskId:splitParent.taskId,taskIds:childIds,reason:changes.reason});
      }
      wakeups.get(run.id)?.();
      event(run, "branches_appended", { taskIds: appended.map((job) => job.taskId) });
      await persist(run);
      if (!pending.has(run.id)) {
        const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
        pending.set(run.id, promise);
      }
      return publicRun(run);
      } finally {
        additions.get(run.id)?.delete(token);
        wakeups.get(run.id)?.();
      }
    },

    async start(input, options = {}) {
      if (options.reviewScopeFiles !== undefined) validateReviewScopeFiles(options.reviewScopeFiles);
      options = { ...options, finalReviewOnly: options.finalReviewOnly ?? options.incremental === true };
      const now = new Date().toISOString();
      const source = await readParallelSource(projectRoot, options);
      let markdown = source.markdown;
      if (source.nodeId) markdown = markdown.replace(/(^- (?:Current|Next):)[^\r\n]*/gm, `$1 ${source.nodeId}`);
      const treeSummary = await readTreeSummary({ projectRoot, tree: source.tree, markdown });
      const contextOptions = await readContextOptions(runsDir);
      const history = await readGoalHistory(runsDir);
      const sharedContract = String(options.sharedContract || '');
      const jobs = executionContexts(assignParallelDraftContexts(validateParallelJobs(input).map(job => ({ ...job, sharedContract: sharedContract || job.sharedContract })), contextOptions), [], contextOptions);
      const linkedTrees=await readLinkedTreeFiles({projectRoot,treeFile:source.tree.path,markdown});
      const availableNodes = new Set(linkedTrees.flatMap(tree=>tree.nodes.map(node=>node.id)));
      if (options.incremental && jobs.some(job => !availableNodes.has(job.nodeId))) throw new Error('拆分任务引用了当前分支中不存在的节点，请使用当前节点或已有子节点 ID。');
      const run = {
        id: randomUUID(), status: "queued", objective: options.objective || "", summary: "按需拆分执行",
        sourceTree: source.tree, sourceSelection: { treeId: options.treeId, subtree: options.subtree, nodeId: options.nodeId },
        incremental: options.incremental === true,
        finalReviewOnly: options.finalReviewOnly === true,
        reviewBaselineCommit: options.reviewBaselineCommit || '', initialReceipt:options.initialReceipt,
        ...(options.reviewScopeFiles === undefined ? {} : {reviewScopeFiles:options.reviewScopeFiles}),
        sharedContract,
        acceptanceCriteria: normalizeDeliveryContract({acceptanceCriteria:options.acceptanceCriteria}).acceptanceCriteria,
        coverage: options.coverage || [],
        createdAt: now, updatedAt: now, error: "",
        goal: { ...deriveParallelGoal(markdown, options.objective || ''), history },
        planner: { status: "manual", threadId: "", turnId: "", error: "" },
        contextOptions,
        jobs: jobs.map((job) => ({
          ...job, singleFinalReview: options.finalReviewOnly,
          branchContext: buildBranchInputContext(job, { markdown, goal: deriveParallelGoal(markdown), history, treeSummary }),
          runtimeMetadataPath: runsDir,
          status: "queued", threadId: job.contextThreadId || "", turnId: "", changedFiles: [], error: ""
        })),
        events: [], peerMessages: []
      };
      runs.set(run.id, run);
    executionOptions.set(run.id, options);
      if (options.incremental) await stageBranches(run);
      await persist(run);
      const promise = Promise.resolve().then(() => execute(run)).finally(() => pending.delete(run.id));
      pending.set(run.id, promise);
      return publicRun(run);
    },

    async get(id, options = {}) {
      const run = await load(id);
      if (!run) return null;
      await recoverAbandonedPlan(run);
      await recoverAbandonedExecution(run);
      await ensureGoalState(run);
      await recoverAcceptedFinalization(run);
      return publicRun(run, options);
    },

    async snapshot(id, options = {}) { const run=await load(id);return run?publicRun(run, options):null; },
    async getJob(id, taskId) {
      const run=await load(id),job=run?.jobs?.find(job=>job.taskId===taskId);
      if(!job)return null;
      return {runId:run.id,job:publicJob(job),
        userMessages:(run.userMessages||[]).filter(message=>message.taskId===taskId),
        peerMessages:(run.peerMessages||[]).filter(message=>message.fromTaskId===taskId||message.toTaskId===taskId)};
    },
    async sendAgentMessage(id, body) {
      const run=await load(id);
      if(!run)throw Object.assign(new Error('找不到这次并行运行'),{code:'RUN_NOT_FOUND',statusCode:404});
      // Use the same durable mailbox even while workers are being prepared.
      const mailbox=mailboxes.get(id)||createPeerMailbox(run,{persist,onEvent:(type,detail)=>event(run,type,detail)});
      const message=await mailbox.sendUserMessage(body);
      return {message,run:publicRun(run)};
    },
    async resume(id, options = {}) {
      const run = await load(id);
      if(!run)throw new Error('找不到需要续跑的并行任务');
      if (options.reviewScopeFiles !== undefined) {
        run.reviewScopeFiles = validateReviewScopeFiles(options.reviewScopeFiles);
        await persist(run);
      }
      // Migrate only old records with evidence of successful model completion
      // followed by delivery failure. A partial or timed-out model response is
      // never a completed checkpoint, even if it contains reassuring prose.
      for (const job of run.jobs.filter(job => job.status === 'failed' && !job.workerCompleted
        && job.evidence && /^独立合并失败：/.test(job.error || ''))) {
        const lastTurn = run.events?.filter(event => event.type === 'worker_turn_timing' && event.taskId === job.taskId).at(-1);
        const lastRound = lastTurn?.timing?.rounds?.at(-1);
        if (lastRound?.finishReason === 'stop' && !lastRound.error) job.workerCompleted = true;
      }
      const previousOptions = executionOptions.get(id) || {};
      executionOptions.set(id,{...previousOptions,...options,finalReviewOnly:run.finalReviewOnly,incremental:run.incremental});
      // An explicit user retry also revives failed siblings while unaffected
      // workers are running. Do not start a second scheduler or replay them.
      if (pending.has(id)) {
        const retryable = run.jobs.filter(job => ['failed', 'blocked', 'stopped'].includes(job.status));
        for (const job of retryable) {
          job.retryReason = job.error || job.retryReason || '上次运行未完成';
          job.status = 'queued'; job.error = ''; job.finishedAt = ''; job.resumeAfterRestart = true;
        }
        if (retryable.length) {
          event(run, 'run_retry_requested', { taskIds: retryable.map(job => job.taskId) });
          await persist(run);
          wakeups.get(id)?.();
        }
        return publicRun(run);
      }
      if (["queued", "preparing", "running", "applying", "checking"].includes(run.status)) {
        // After restart, some siblings can already be failed while others
        // were interrupted. An explicit retry revives both in one scheduler.
        const retryable = run.jobs.filter(job => ['failed', 'blocked', 'stopped'].includes(job.status));
        for (const job of retryable) {
          job.retryReason = job.error || job.retryReason || '上次运行未完成';
          job.status = 'queued'; job.error = ''; job.finishedAt = ''; job.resumeAfterRestart = true;
        }
        if (retryable.length) {
          run.error = ''; run.finishedAt = '';
          event(run, 'run_retry_requested', { taskIds: retryable.map(job => job.taskId) });
        }
        await recoverAbandonedExecution(run);
        return publicRun(run);
      }
      if (run.status !== "failed") throw new Error(`当前运行状态 ${run.status} 不支持续跑`);

      const retryable = run.jobs.filter(job => job.status !== "completed");
      for (const job of retryable) {
        job.retryReason = job.error || job.retryReason || "上次运行未完成";
        job.status = "queued";
        job.error = "";
        job.finishedAt = "";
        job.resumeAfterRestart = true;
      }
      run.status = "queued";
      run.error = "";
      run.result = null;
      run.finishedAt = "";
      event(run, "run_retry_requested", { taskIds: retryable.map(job => job.taskId) });
      const promise = Promise.resolve().then(async () => { await persist(run); return execute(run); }).finally(() => pending.delete(id));
      pending.set(id, promise);
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
      while (pending.size || background.size) {
        await Promise.allSettled([...pending.values(), ...background.values()]);
      }
      await persistQueue.catch(() => {});
    }
  };
  return api;
}
