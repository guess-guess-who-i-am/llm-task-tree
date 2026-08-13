import http from "node:http";
import https from "node:https";
import { httpsPortFor, loadLocalTls } from "./server/local-tls.js";
import {
  buildExecutionCatalog,
  computeFlowDrift,
  getFlowScript,
  putFlowScript,
  restoreFlowScript,
  syncFlowBlockStatuses,
  autoBuildFlowScript,
  resolveRebuiltFlowFocus
} from "./server/flow-script.js";
import { getFlowStep, listStepPackIndex, putFlowStep } from "./server/flow-step.js";
import { addTree, findTree, loadTreeRegistry, resolveTreeFile, setActiveMethod, starterTreeMarkdown } from "./server/tree-registry.js";
import { auditTurnMaintenance, maskAdvisoryNextPlan, syncMethodFlowStatus } from "./server/maintenance.js";
import {
  listProjectThreads,
  openInCodex,
  readPinnedThread,
  startCodexTurn,
  threadDeepLink,
  writePinnedThread
} from "./server/codex-run.js";
import { buildPresetPrompt, describePresets } from "./server/codex-prompts.js";
import { createParallelCodexCoordinator } from "./server/codex-coordinator.js";
import { createExecutionScopeStore } from "./server/execution-scope.js";
import { patchNodeFields } from "./server/tree-node-patch.js";
import { ACTIVE_METHOD_TREE_MAX_BYTES, inspectTreeMarkdown, parseTreeNodeFields } from "./server/tree-quality.js";
import { changedNodeIds, diffTreeMarkdown } from "./server/tree-diff.js";
import { describeProjects, ensureProjectServer } from "./server/projects.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kitDir = __dirname;
const stubDir = process.env.TASK_TREE_STUB_DIR
  ? path.resolve(process.env.TASK_TREE_STUB_DIR)
  : kitDir;

function loadTaskTreeConfig(baseDir) {
  const configFile = path.join(baseDir, "task-tree.config.json");
  const defaults = { projectRoot: ".", kitDir: "." };
  if (!existsSync(configFile)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(configFile, "utf8")) };
  } catch {
    return defaults;
  }
}

function resolveProjectRoot(baseDir, config) {
  const raw = String(config.projectRoot || ".").trim() || ".";
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
}

const taskTreeConfig = loadTaskTreeConfig(stubDir);
const projectRoot = process.env.TASK_TREE_PROJECT_ROOT
  ? path.resolve(process.env.TASK_TREE_PROJECT_ROOT)
  : resolveProjectRoot(stubDir, taskTreeConfig);
const publicDir = path.join(kitDir, "public");
const treeRegistryFile = path.join(projectRoot, "task-trees.json");
let treeRegistry = await loadTreeRegistry({ projectRoot, registryFile: treeRegistryFile });
let activeTreeEntry = findTree(treeRegistry, treeRegistry.activeMethod);
let treeFile = resolveTreeFile(projectRoot, activeTreeEntry);
const subtreesDir = path.join(projectRoot, "subtrees");
const scriptsDir = path.join(projectRoot, "scripts");
const versionsDir = path.join(projectRoot, "versions");
const CURRENT_VERSION_NAME = "_current.md";
const modelAgentsFile = path.join(projectRoot, "model-agents.json");
const modelHistoryFile = path.join(projectRoot, "model-agent-history.json");
const modelAgentsDir = path.join(projectRoot, "model-agents");
const knowledgeConfigFile = path.join(projectRoot, "knowledge-config.json");
const knowledgeIndexFile = path.join(projectRoot, "knowledge-index.json");
const knowledgeIndicesDir = path.join(projectRoot, "knowledge-indices");
const knowledgeHistoryFile = path.join(projectRoot, "knowledge-chat-history.json");
const modelNodeConversationsFile = path.join(projectRoot, "model-node-conversations.json");
const webSearchConfigFile = path.join(projectRoot, "web-search-config.json");
const envFile = path.join(projectRoot, ".env");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const execFileAsync = promisify(execFile);
const executionScopes = createExecutionScopeStore({ projectRoot });
const parallelCodex = createParallelCodexCoordinator({ projectRoot, scopeStore: executionScopes });
const treeWriteQueues = new Map();
let skillIndexCache = null;
let openWebSearchDaemonPromise = null;
const CODEX_THREAD_CACHE_TTL_MS = 30 * 1000;
const codexThreadCacheFile = path.join(projectRoot, ".task-tree-threads.json");

function loadCodexThreadCache() {
  try {
    const saved = JSON.parse(readFileSync(codexThreadCacheFile, "utf8"));
    return {
      threads: Array.isArray(saved.threads) ? saved.threads.slice(0, 12) : [],
      fetchedAt: Number(saved.fetchedAt) || 0,
      refresh: null
    };
  } catch {
    return { threads: [], fetchedAt: 0, refresh: null };
  }
}

let codexThreadCache = loadCodexThreadCache();

function saveCodexThreadCache(threads) {
  const payload = { fetchedAt: Date.now(), threads: threads.slice(0, 12) };
  return writeFile(codexThreadCacheFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8").catch(() => {});
}

function refreshCodexThreadCache() {
  if (codexThreadCache.refresh) return codexThreadCache.refresh;
  codexThreadCache.refresh = listProjectThreads({ cwd: projectRoot, maxPages: 1, pageSize: 100 })
    .then(async (recent) => {
      const threads = recent.length
        ? recent
        : await listProjectThreads({ cwd: projectRoot, maxPages: 6, pageSize: 100 });
      codexThreadCache = { threads, fetchedAt: Date.now(), refresh: null };
      await saveCodexThreadCache(threads);
      return threads;
    })
    .catch((error) => {
      codexThreadCache.refresh = null;
      throw error;
    });
  return codexThreadCache.refresh;
}

async function readCodexThreadsFast({ refresh = false } = {}) {
  if (refresh) refreshCodexThreadCache().catch(() => {});
  const age = Date.now() - codexThreadCache.fetchedAt;
  if (codexThreadCache.fetchedAt && age <= CODEX_THREAD_CACHE_TTL_MS) {
    return { threads: codexThreadCache.threads, cache: codexThreadCache.refresh ? "refreshing" : "fresh" };
  }
  if (codexThreadCache.fetchedAt) {
    return { threads: codexThreadCache.threads, cache: codexThreadCache.refresh ? "refreshing" : "cached" };
  }
  refreshCodexThreadCache().catch(() => {});
  return { threads: [], cache: "warming" };
}

async function refreshTreeRegistry() {
  treeRegistry = await loadTreeRegistry({ projectRoot, registryFile: treeRegistryFile });
  activeTreeEntry = findTree(treeRegistry, treeRegistry.activeMethod);
  treeFile = resolveTreeFile(projectRoot, activeTreeEntry);
  return treeRegistry;
}

async function resolveRequestedTree(reqUrl, body = {}) {
  const registry = await refreshTreeRegistry();
  const url = new URL(reqUrl, "http://127.0.0.1");
  const treeId = String(body.treeId || body.tree || url.searchParams.get("tree") || registry.activeMethod);
  const tree = findTree(registry, treeId);
  if (!tree) return null;
  return { registry, tree, filePath: resolveTreeFile(projectRoot, tree), active: tree.id === registry.activeMethod };
}

function queueTreeWrite(filePath, operation) {
  const key = path.resolve(filePath).toLowerCase();
  const previous = treeWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tracked = current.finally(() => {
    if (treeWriteQueues.get(key) === tracked) treeWriteQueues.delete(key);
  });
  treeWriteQueues.set(key, tracked);
  return current;
}

async function persistTreeMarkdown(scope, markdown, body = {}) {
  const current = existsSync(scope.filePath) ? await readFile(scope.filePath, "utf8") : "";
  const allowGraphStateFocusChange = body.source === "ui" || body.allowGraphStateFocusChange === true;
  let persisted = mergePreservedNodeFields(markdown, current);
  persisted = mergePreservedGraphStateFocus(persisted, current, { allowChange: allowGraphStateFocusChange });
  const changes = diffTreeMarkdown(current, persisted);
  if (current !== persisted && body.backup !== false) {
    await backupTree(body.reason || "将自动保存图谱修改", scope.tree, scope.filePath);
  }
  await mkdir(path.dirname(scope.filePath), { recursive: true });
  await writeFile(scope.filePath, persisted, "utf8");
  await writeCurrentVersion(persisted, scope.tree);
  let flowSync = { changed: 0, skipped: true };
  if (scope.active && scope.tree.flowEnabled !== false) {
    try {
      flowSync = await syncMethodFlowStatus({ projectRoot, treeFile: scope.filePath });
    } catch (error) {
      flowSync = { changed: 0, skipped: false, error: error.message || "flow status sync failed" };
    }
  }
  return { persisted, changes, flowSync };
}

function resolveOpenWebSearchDir() {
  const candidates = [
    path.join(kitDir, "open-webSearch"),
    path.join(projectRoot, "open-webSearch"),
    path.resolve(kitDir, "..", "open-webSearch"),
    path.resolve(projectRoot, "..", "open-webSearch")
  ];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (existsSync(path.join(resolved, "package.json"))) return resolved;
  }
  return path.join(kitDir, "open-webSearch");
}

function openWebSearchLogDir() {
  const base = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  const hash = crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 12);
  return path.join(base, "LLMTaskTree", "logs", hash);
}

function openWebSearchLauncherLogs() {
  const dir = openWebSearchLogDir();
  return {
    dir,
    log: path.join(dir, "open-websearch-launcher.log"),
    err: path.join(dir, "open-websearch-launcher.err.log")
  };
}

async function cleanupLegacyOpenWebSearchLauncherLogs() {
  for (const name of ["open-websearch-launcher.log", "open-websearch-launcher.err.log"]) {
    const legacy = path.join(projectRoot, name);
    if (!existsSync(legacy)) continue;
    try {
      await unlink(legacy);
    } catch {
      // Legacy file may still be locked by an old daemon; ignore.
    }
  }
}

async function testOpenWebSearchDaemon(baseUrl) {
  try {
    const response = await fetch(joinUrl(baseUrl, "/health"), { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    return response.ok && data.status === "ok";
  } catch {
    return false;
  }
}

async function buildOpenWebSearch(dir) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(path.join(dir, "node_modules"))) {
    await execFileAsync(npm, ["install"], { cwd: dir, timeout: 300000, windowsHide: true });
  }
  await execFileAsync(npm, ["run", "build"], { cwd: dir, timeout: 120000, windowsHide: true });
}

async function ensureOpenWebSearchDaemon() {
  const config = await loadWebSearchConfig();
  if (config.provider !== "openwebsearch") return { ok: true, skipped: true };
  const env = await loadLocalEnv();
  const baseUrl = config.baseUrl || env.WEB_SEARCH_BASE_URL || "http://127.0.0.1:3210";
  if (await testOpenWebSearchDaemon(baseUrl)) {
    return { ok: true, baseUrl, running: true };
  }
  if (openWebSearchDaemonPromise) return openWebSearchDaemonPromise;
  openWebSearchDaemonPromise = (async () => {
    const dir = resolveOpenWebSearchDir();
    const entry = path.join(dir, "build", "index.js");
    const logs = openWebSearchLauncherLogs();
    await mkdir(logs.dir, { recursive: true }).catch(() => {});
    if (!existsSync(entry)) {
      if (!existsSync(path.join(dir, "package.json"))) {
        throw new Error(`open-webSearch not found at ${dir}. Run llm-task-tree-kit/setup-open-websearch.ps1 or set WEB_SEARCH_PROVIDER=tavily with an API key.`);
      }
      try {
        await buildOpenWebSearch(dir);
      } catch (error) {
        await writeFile(logs.err, `open-webSearch build failed: ${error.message}\n`, "utf8").catch(() => {});
        throw new Error(`open-webSearch build failed: ${error.message}. Run: cd "${dir}" && npm install && npm run build`);
      }
    }
    if (!existsSync(entry)) {
      throw new Error(`open-webSearch is not built at ${entry}. Run setup-open-websearch.ps1.`);
    }
    const url = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    const daemonHost = url.hostname || "127.0.0.1";
    const daemonPort = url.port || "3210";
    const engines = String(env.OPEN_WEBSEARCH_ENGINES || "");
    const searchMode = String(env.OPEN_WEBSEARCH_SEARCH_MODE || "request");
    const defaultEngine = engines.split(",").map((item) => item.trim()).filter(Boolean)[0] || "duckduckgo";
    const childEnv = {
      ...process.env,
      OPEN_WEBSEARCH_DAEMON_HOST: daemonHost,
      OPEN_WEBSEARCH_DAEMON_PORT: daemonPort,
      DEFAULT_SEARCH_ENGINE: defaultEngine,
      ALLOWED_SEARCH_ENGINES: engines,
      SEARCH_MODE: searchMode
    };
    const child = spawn(process.execPath, ["build/index.js", "serve", "--host", daemonHost, "--port", daemonPort], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv
    });
    child.unref();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await testOpenWebSearchDaemon(baseUrl)) {
        return { ok: true, baseUrl, running: true, started: true, dir };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`open-webSearch daemon failed to start at ${baseUrl}. See ${logs.err}`);
  })().finally(() => {
    openWebSearchDaemonPromise = null;
  });
  return openWebSearchDaemonPromise;
}

async function getOpenWebSearchStatus() {
  const config = await loadWebSearchConfig();
  if (config.provider !== "openwebsearch") {
    return { provider: config.provider || "", enabled: config.enabled, reachable: null, dir: resolveOpenWebSearchDir() };
  }
  const env = await loadLocalEnv();
  const baseUrl = config.baseUrl || env.WEB_SEARCH_BASE_URL || "http://127.0.0.1:3210";
  const dir = resolveOpenWebSearchDir();
  const built = existsSync(path.join(dir, "build", "index.js"));
  const reachable = await testOpenWebSearchDaemon(baseUrl);
  return {
    provider: "openwebsearch",
    enabled: config.enabled,
    baseUrl,
    dir,
    built,
    reachable,
    logs: openWebSearchLauncherLogs()
  };
}
const homeDir = process.env.USERPROFILE || process.env.HOME || "";
let knowledgeReindexJob = {
  running: false,
  stage: "idle",
  message: "",
  error: "",
  startedAt: "",
  finishedAt: "",
  totalFiles: 0,
  processedFiles: 0,
  totalChunks: 0,
  embeddedChunks: 0,
  percent: 0
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

/**
 * The chat widget's sandbox, which is the only foreign origin allowed to reach this server.
 *
 * Scoped deliberately: a bare `*` would let any page a browser visits read and rewrite the local
 * task tree.
 */
const EMBED_ORIGIN = /^(codex-sandbox|https):\/\/[\w.-]+\.oaiusercontent\.com$/;

/**
 * Chrome treats a request from that sandbox to 127.0.0.1 as public-to-private and preflights it,
 * refusing everything - scripts, styles, fetch, even the frame - until the server opts in. Without
 * this the failures are silent and identical to a server that is not running.
 */
function applyEmbedAccess(req, res) {
  const origin = req.headers.origin;
  if (!origin || !EMBED_ORIGIN.test(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "Origin");
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("access-control-allow-private-network", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "content-type");
    res.setHeader("access-control-max-age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function jsonResponse(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function isoNow() {
  return new Date().toISOString();
}

function safeModelId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 48);
}

function sanitizeGraphId(value) {
  return String(value || "").trim().replace(/\s+/g, "_").replace(/[^\w-]/g, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl, suffix) {
  return `${normalizeBaseUrl(baseUrl)}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadLocalEnv() {
  if (!existsSync(envFile)) return {};
  return parseEnvText(await readFile(envFile, "utf8"));
}

function envKeySegment(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function envBool(value, fallback = true) {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function defaultKnowledgeConfig() {
  return {
    docsDir: "knowledge",
    libraryRoot: "knowledge",
    activeLibraryId: "",
    searchAllLibraries: false,
    embedding: {
      baseUrl: "",
      apiKey: "",
      model: "",
      wireApi: "openai",
      batchSize: 64,
      concurrency: 40
    },
    chat: {
      modelId: ""
    },
    chunk: {
      maxChars: 1600,
      overlapChars: 200
    },
    retrieval: {
      diversify: true,
      maxChunksPerDoc: 1,
      candidatePoolMultiplier: 10
    }
  };
}

function defaultWebSearchConfig() {
  return {
    provider: "",
    apiKey: "",
    baseUrl: "",
    enabled: false,
    maxResults: 8
  };
}

const RETRIEVAL_DEFAULT_TOP_K = 20;
const RETRIEVAL_MAX_TOP_K = 20;
const RETRIEVAL_WEB_DEFAULT_TOP_K = 8;
const RETRIEVAL_WEB_MAX_TOP_K = 12;
const RETRIEVAL_SNIPPET_CHARS = 1600;
const RETRIEVAL_CONTEXT_MAX_CHARS = 36000;

const WEAK_WEB_QUERY_RE = /^(现在|目前|当前|今天|何时|什么时候|几点|时间|what|how|why|when|where|who|is|are|the|a|an)$/i;

const LOW_VALUE_WEB_HOSTS = new Set([
  "beijing-time.org",
  "www.beijing-time.org",
  "time.is",
  "www.time.is",
  "timeanddate.com",
  "www.timeanddate.com",
  "worldtimeapi.org",
  "www.worldtimeapi.org",
  "www.timeanddate.cn",
  "timeanddate.cn",
  "bjtime.org",
  "www.bjtime.org",
  "quanxiaoha.com",
  "www.quanxiaoha.com"
]);

const TIME_JUNK_TEXT_RE = /北京时间|标准北京时间|在线.*校|几点几分|当前时间|现在几点|sunrise|sunset|daylength|time\.is|beijing[- ]time|汉语词语|词语[_-]?百度百科|在线标准时间/i;

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

const KNOWLEDGE_HISTORY_MAX_TURNS = 12;
const KNOWLEDGE_HISTORY_SNIPPET_CHARS = 1600;

function slimKnowledgeHistoryResults(results) {
  return (Array.isArray(results) ? results : []).slice(0, 40).map((item) => ({
    id: item?.id,
    path: String(item?.path || ""),
    title: String(item?.title || ""),
    url: String(item?.url || ""),
    source: String(item?.source || ""),
    score: Number(item?.score) || 0,
    content: String(item?.content || "").slice(0, KNOWLEDGE_HISTORY_SNIPPET_CHARS)
  }));
}

function normalizeKnowledgeHistoryTurn(turn) {
  if (!turn || typeof turn !== "object") return null;
  const kind = turn.kind === "ask" ? "ask" : "search";
  const query = String(turn.query || "").trim();
  if (!query && !String(turn.answer || "").trim()) return null;
  return {
    id: String(turn.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    createdAt: String(turn.createdAt || new Date().toISOString()),
    kind,
    query,
    answer: String(turn.answer || ""),
    summary: String(turn.summary || "").slice(0, 120),
    collapsed: turn.collapsed === true,
    referencesOpen: turn.referencesOpen === true,
    includeWeb: turn.includeWeb === true,
    results: slimKnowledgeHistoryResults(turn.results)
  };
}

async function loadKnowledgeHistory() {
  const data = await readJsonFile(knowledgeHistoryFile, { history: [] });
  const raw = Array.isArray(data?.history) ? data.history : Array.isArray(data) ? data : [];
  return raw.map(normalizeKnowledgeHistoryTurn).filter(Boolean).slice(-KNOWLEDGE_HISTORY_MAX_TURNS);
}

async function saveKnowledgeHistory(history) {
  const normalized = (Array.isArray(history) ? history : [])
    .map(normalizeKnowledgeHistoryTurn)
    .filter(Boolean)
    .slice(-KNOWLEDGE_HISTORY_MAX_TURNS);
  await writeJsonFile(knowledgeHistoryFile, {
    updatedAt: isoNow(),
    history: normalized
  });
  return normalized;
}

const MODEL_NODE_TURNS_MAX = 24;

function normalizeModelNodeTurn(turn) {
  if (!turn || typeof turn !== "object") return null;
  const models = {};
  const rawModels = turn.models && typeof turn.models === "object" ? turn.models : {};
  for (const [modelId, entry] of Object.entries(rawModels)) {
    const id = safeModelId(modelId);
    if (!id || !entry || typeof entry !== "object") continue;
    models[id] = {
      answer: String(entry.answer || "").slice(0, 12000),
      ok: entry.ok !== false,
      error: String(entry.error || "").slice(0, 2000),
      elapsedMs: Number(entry.elapsedMs) || 0,
      toolEvents: Array.isArray(entry.toolEvents) ? entry.toolEvents.slice(0, 6).map((item) => ({
        query: String(item.query || "").slice(0, 240),
        refinedQuery: String(item.refinedQuery || "").slice(0, 240),
        rewriteSource: String(item.rewriteSource || ""),
        queryWasWeak: item.queryWasWeak === true,
        includeWeb: item.includeWeb === true,
        resultCount: Number(item.resultCount) || 0,
        errors: Array.isArray(item.errors) ? item.errors.slice(0, 3).map(String) : []
      })) : []
    };
  }
  const question = String(turn.question || "").trim();
  if (!question && !Object.keys(models).length) return null;
  const auto = turn.autoRetrieval && typeof turn.autoRetrieval === "object" ? {
    executedQuery: String(turn.autoRetrieval.executedQuery || "").slice(0, 240),
    rewriteSource: String(turn.autoRetrieval.rewriteSource || ""),
    resultCount: Number(turn.autoRetrieval.resultCount) || 0,
    includeWeb: turn.autoRetrieval.includeWeb === true
  } : null;
  return {
    id: String(turn.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    createdAt: String(turn.createdAt || new Date().toISOString()),
    question: question.slice(0, 4000),
    collapsed: turn.collapsed === true,
    includeWeb: turn.includeWeb === true,
    useKnowledgeSearch: turn.useKnowledgeSearch !== false,
    summary: String(turn.summary || "").slice(0, 120),
    autoRetrieval: auto,
    models
  };
}

function normalizeModelNodeConversations(data) {
  const nodes = {};
  const rawNodes = data?.nodes && typeof data.nodes === "object" ? data.nodes : {};
  for (const [nodeId, turns] of Object.entries(rawNodes)) {
    const id = sanitizeGraphId(nodeId);
    if (!id || !Array.isArray(turns)) continue;
    const normalized = turns.map(normalizeModelNodeTurn).filter(Boolean).slice(-MODEL_NODE_TURNS_MAX);
    if (normalized.length) nodes[id] = normalized;
  }
  return nodes;
}

async function loadModelNodeConversations() {
  const data = await readJsonFile(modelNodeConversationsFile, { nodes: {} });
  return normalizeModelNodeConversations(data);
}

async function saveModelNodeConversations(nodes) {
  const normalized = normalizeModelNodeConversations({ nodes });
  await writeJsonFile(modelNodeConversationsFile, {
    updatedAt: isoNow(),
    nodes: normalized
  });
  return normalized;
}

function buildModelRunRetrievalHint({ question, nodeMarkdown, histories }) {
  const parts = [];
  for (const turns of Object.values(histories || {})) {
    for (const turn of normalizeModelConversation(turns).slice(-6)) {
      parts.push(`${turn.role === "user" ? "问" : "答"}：${turn.content.slice(0, 400)}`);
    }
  }
  parts.push(`本轮问题：${String(question || "").trim()}`);
  if (nodeMarkdown) parts.push(`当前节点：\n${String(nodeMarkdown).slice(0, 600)}`);
  return parts.filter(Boolean).join("\n\n").slice(0, 1200);
}

function resolveWorkspacePath(value, fallbackRelative) {
  const raw = String(value || fallbackRelative || "").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
  const root = path.resolve(projectRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function sanitizeKnowledgeLibraryId(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return compact || "default";
}

function knowledgeLibraryIndexPath(libraryId) {
  return path.join(knowledgeIndicesDir, `${sanitizeKnowledgeLibraryId(libraryId)}.json`);
}

function relativeDocsDirFromAbsolute(absPath) {
  return path.relative(projectRoot, absPath).replace(/\\/g, "/");
}

async function resolveKnowledgeLibraryRoot(config) {
  const rootRel = String(config.libraryRoot || config.docsDir || "knowledge").trim() || "knowledge";
  return resolveWorkspacePath(rootRel, "knowledge");
}

async function discoverKnowledgeLibraries(config) {
  const rootPath = await resolveKnowledgeLibraryRoot(config);
  if (!rootPath || !existsSync(rootPath)) return [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  const subdirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (subdirs.length) {
    return subdirs.map((name) => {
      const docsPath = path.join(rootPath, name);
      return {
        id: sanitizeKnowledgeLibraryId(name),
        label: name,
        docsDir: relativeDocsDirFromAbsolute(docsPath)
      };
    });
  }
  return [{
    id: "default",
    label: "默认",
    docsDir: relativeDocsDirFromAbsolute(rootPath)
  }];
}

async function enrichKnowledgeLibraries(config) {
  await migrateLegacyKnowledgeIndexIfNeeded(config);
  const libraries = await discoverKnowledgeLibraries(config);
  const enriched = [];
  for (const library of libraries) {
    const index = await loadKnowledgeIndex(library.id);
    const chunks = Array.isArray(index.chunks) ? index.chunks : [];
    enriched.push({
      ...library,
      indexExists: Boolean(index.createdAt && chunks.length),
      totalChunks: chunks.length,
      createdAt: index.createdAt || "",
      embeddingModel: index.embeddingModel || ""
    });
  }
  return enriched;
}

function resolveKnowledgeLibrarySelection(config, { libraryIds, searchAllLibraries } = {}) {
  const libraries = Array.isArray(config.libraries) ? config.libraries : [];
  const knownIds = new Set(libraries.map((item) => item.id));
  if (searchAllLibraries === true) {
    return libraries.map((item) => item.id);
  }
  if (Array.isArray(libraryIds) && libraryIds.length) {
    const picked = libraryIds.map((item) => sanitizeKnowledgeLibraryId(item)).filter((id) => knownIds.has(id));
    if (picked.length) return [...new Set(picked)];
  }
  const active = sanitizeKnowledgeLibraryId(config.activeLibraryId || libraries[0]?.id || "default");
  return knownIds.has(active) ? [active] : (libraries[0] ? [libraries[0].id] : ["default"]);
}

async function migrateLegacyKnowledgeIndexIfNeeded(config) {
  await mkdir(knowledgeIndicesDir, { recursive: true });
  if (!existsSync(knowledgeIndexFile)) return;
  const legacy = await readJsonFile(knowledgeIndexFile, null);
  if (!legacy || !Array.isArray(legacy.chunks) || !legacy.chunks.length) return;
  const libraries = await discoverKnowledgeLibraries(config);
  const targetId = libraries.length === 1
    ? libraries[0].id
    : sanitizeKnowledgeLibraryId(path.basename(String(legacy.docsDir || "").replace(/\\/g, "/")) || "default");
  const targetPath = knowledgeLibraryIndexPath(targetId);
  if (existsSync(targetPath)) return;
  await writeJsonFile(targetPath, {
    ...legacy,
    libraryId: targetId,
    docsDir: libraries.find((item) => item.id === targetId)?.docsDir || legacy.docsDir || ""
  });
}

async function loadKnowledgeConfig({ includeKey = false } = {}) {
  const defaults = defaultKnowledgeConfig();
  const env = await loadLocalEnv();
  const saved = await readJsonFile(knowledgeConfigFile, defaults);
  const embedding = { ...defaults.embedding, ...(saved.embedding || {}) };
  const config = {
    ...defaults,
    ...saved,
    embedding,
    chat: { ...defaults.chat, ...(saved.chat || {}) },
    chunk: { ...defaults.chunk, ...(saved.chunk || {}) },
    retrieval: { ...defaults.retrieval, ...(saved.retrieval || {}) }
  };
  config.docsDir = String(env.KNOWLEDGE_DOCS_DIR || config.docsDir || defaults.docsDir);
  config.libraryRoot = String(env.KNOWLEDGE_LIBRARY_ROOT || config.libraryRoot || config.docsDir || defaults.libraryRoot);
  config.activeLibraryId = sanitizeKnowledgeLibraryId(config.activeLibraryId || "");
  config.searchAllLibraries = config.searchAllLibraries === true;
  config.libraries = await enrichKnowledgeLibraries(config);
  if (!config.activeLibraryId && config.libraries.length) {
    config.activeLibraryId = config.libraries[0].id;
  } else if (config.activeLibraryId && !config.libraries.some((item) => item.id === config.activeLibraryId)) {
    config.activeLibraryId = config.libraries[0]?.id || "";
  }
  config.embedding.baseUrl = normalizeBaseUrl(env.KNOWLEDGE_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL || config.embedding.baseUrl || config.embedding.base_url);
  const envEmbeddingKey = env.KNOWLEDGE_EMBEDDING_API_KEY || env.EMBEDDING_API_KEY;
  const savedEmbeddingKey = saved.embedding?.apiKey || saved.embedding?.api_key;
  config.embedding.apiKey = includeKey ? String(envEmbeddingKey || savedEmbeddingKey || "") : "";
  config.embedding.hasApiKey = Boolean(envEmbeddingKey || savedEmbeddingKey);
  config.embedding.model = String(env.KNOWLEDGE_EMBEDDING_MODEL || env.EMBEDDING_MODEL || config.embedding.model || "");
  config.embedding.batchSize = Math.max(1, Math.min(512, Number(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE || env.EMBEDDING_BATCH_SIZE || config.embedding.batchSize) || defaults.embedding.batchSize));
  config.embedding.concurrency = Math.max(1, Math.min(100, Number(env.KNOWLEDGE_EMBEDDING_CONCURRENCY || env.EMBEDDING_CONCURRENCY || config.embedding.concurrency) || defaults.embedding.concurrency));
  config.chat.modelId = String(env.KNOWLEDGE_CHAT_MODEL_ID || config.chat.modelId || "");
  config.chunk.maxChars = Math.max(400, Math.min(6000, Number(config.chunk.maxChars) || defaults.chunk.maxChars));
  config.chunk.overlapChars = Math.max(0, Math.min(1000, Number(config.chunk.overlapChars) || defaults.chunk.overlapChars));
  config.retrieval.diversify = envBool(env.KNOWLEDGE_RETRIEVAL_DIVERSIFY, config.retrieval.diversify !== false);
  config.retrieval.maxChunksPerDoc = Math.max(1, Math.min(5, Number(env.KNOWLEDGE_RETRIEVAL_MAX_CHUNKS_PER_DOC || config.retrieval.maxChunksPerDoc) || defaults.retrieval.maxChunksPerDoc));
  config.retrieval.candidatePoolMultiplier = Math.max(2, Math.min(30, Number(env.KNOWLEDGE_RETRIEVAL_CANDIDATE_POOL_MULTIPLIER || config.retrieval.candidatePoolMultiplier) || defaults.retrieval.candidatePoolMultiplier));
  return config;
}

async function saveKnowledgeConfig(input) {
  const existing = await loadKnowledgeConfig({ includeKey: true });
  const incomingEmbedding = input?.embedding || {};
  const config = {
    ...defaultKnowledgeConfig(),
    docsDir: String(input?.docsDir || existing.docsDir || "knowledge").trim() || "knowledge",
    libraryRoot: String(input?.libraryRoot || existing.libraryRoot || existing.docsDir || "knowledge").trim() || "knowledge",
    activeLibraryId: sanitizeKnowledgeLibraryId(input?.activeLibraryId || existing.activeLibraryId || ""),
    searchAllLibraries: typeof input?.searchAllLibraries === "boolean" ? input.searchAllLibraries : existing.searchAllLibraries === true,
    embedding: {
      baseUrl: normalizeBaseUrl(incomingEmbedding.baseUrl || incomingEmbedding.base_url || existing.embedding.baseUrl),
      apiKey: String(incomingEmbedding.apiKey || incomingEmbedding.api_key || existing.embedding.apiKey || ""),
      model: String(incomingEmbedding.model || existing.embedding.model || ""),
      wireApi: String(incomingEmbedding.wireApi || incomingEmbedding.wire_api || "openai"),
      batchSize: Math.max(1, Math.min(512, Number(incomingEmbedding.batchSize || incomingEmbedding.batch_size) || existing.embedding.batchSize || 64)),
      concurrency: Math.max(1, Math.min(100, Number(incomingEmbedding.concurrency) || existing.embedding.concurrency || 40))
    },
    chat: {
      modelId: String(input?.chat?.modelId || existing.chat.modelId || "")
    },
    chunk: {
      maxChars: Math.max(400, Math.min(6000, Number(input?.chunk?.maxChars) || existing.chunk.maxChars || 1600)),
      overlapChars: Math.max(0, Math.min(1000, Number(input?.chunk?.overlapChars) || existing.chunk.overlapChars || 200))
    },
    retrieval: {
      diversify: input?.retrieval?.diversify ?? existing.retrieval?.diversify ?? true,
      maxChunksPerDoc: Math.max(1, Math.min(5, Number(input?.retrieval?.maxChunksPerDoc) || existing.retrieval?.maxChunksPerDoc || 1)),
      candidatePoolMultiplier: Math.max(2, Math.min(30, Number(input?.retrieval?.candidatePoolMultiplier) || existing.retrieval?.candidatePoolMultiplier || 10))
    }
  };
  const docsPath = resolveWorkspacePath(config.libraryRoot || config.docsDir, "knowledge");
  if (!docsPath) throw new Error("libraryRoot must stay inside this workspace");
  await mkdir(docsPath, { recursive: true });
  await mkdir(knowledgeIndicesDir, { recursive: true });
  const persisted = { ...config };
  delete persisted.libraries;
  await writeJsonFile(knowledgeConfigFile, persisted);
  return loadKnowledgeConfig();
}

async function walkMarkdownFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".obsidian")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
  }
  return files;
}

function chunkMarkdown(content, { maxChars, overlapChars }) {
  const blocks = String(content || "")
    .replace(/\r\n/g, "\n")
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = overlapChars > 0 ? current.slice(-overlapChars) : "";
    }
    current = current ? `${current}\n\n${block}` : block;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars).trim());
      current = overlapChars > 0 ? current.slice(maxChars - overlapChars) : current.slice(maxChars);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function stableChunkId(relativePath, index, content) {
  return crypto
    .createHash("sha1")
    .update(`${relativePath}\n${index}\n${content}`)
    .digest("hex")
    .slice(0, 16);
}

function sha256Short(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

async function embedTexts(config, texts) {
  const embedding = config.embedding || {};
  if (!embedding.apiKey) throw new Error("missing embedding api_key");
  if (!embedding.model) throw new Error("missing embedding model");
  if (!embedding.baseUrl) throw new Error("missing embedding base_url");
  const response = await fetch(joinUrl(embedding.baseUrl, "/embeddings"), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${embedding.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: embedding.model, input: texts })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`embedding non-json response: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(data.error?.message || text.slice(0, 1000));
  const vectors = (data.data || []).map((item) => item.embedding || item.vec).filter(Array.isArray);
  if (vectors.length !== texts.length) throw new Error("embedding response length mismatch");
  return vectors;
}

async function mapConcurrent(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -Infinity;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return -Infinity;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function updateKnowledgeReindexJob(patch) {
  knowledgeReindexJob = {
    ...knowledgeReindexJob,
    ...patch
  };
}

function knowledgeReindexStatus() {
  const totalWork = knowledgeReindexJob.totalFiles + knowledgeReindexJob.totalChunks;
  const doneWork = knowledgeReindexJob.processedFiles + knowledgeReindexJob.embeddedChunks;
  const percent = knowledgeReindexJob.running && totalWork
    ? Math.max(1, Math.min(99, Math.round((doneWork / totalWork) * 100)))
    : knowledgeReindexJob.percent;
  return { ...knowledgeReindexJob, percent };
}

async function buildKnowledgeIndex({ libraryId, onProgress } = {}) {
  const config = await loadKnowledgeConfig({ includeKey: true });
  const libraries = await discoverKnowledgeLibraries(config);
  const targetId = sanitizeKnowledgeLibraryId(libraryId || config.activeLibraryId || libraries[0]?.id || "default");
  const library = libraries.find((item) => item.id === targetId) || libraries[0];
  if (!library) throw new Error("no knowledge library folders found under libraryRoot");
  const previousIndex = await loadKnowledgeIndex(library.id);
  const reusableEmbeddings = new Map();
  if (previousIndex.embeddingModel === config.embedding.model && Array.isArray(previousIndex.chunks)) {
    for (const chunk of previousIndex.chunks) {
      if (chunk?.id && Array.isArray(chunk.embedding)) reusableEmbeddings.set(chunk.id, chunk.embedding);
    }
  }
  const docsPath = resolveWorkspacePath(library.docsDir, library.docsDir);
  if (!docsPath) throw new Error("library docsDir must stay inside this workspace");
  await mkdir(docsPath, { recursive: true });
  await mkdir(knowledgeIndicesDir, { recursive: true });
  const files = await walkMarkdownFiles(docsPath);
  onProgress?.({ libraryId: library.id, libraryLabel: library.label, stage: "scan", totalFiles: files.length, processedFiles: 0, message: `扫描 ${library.label}：${files.length} 个 Markdown` });
  const chunks = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const filePath = files[fileIndex];
    const info = await stat(filePath);
    const relativePath = path.relative(docsPath, filePath).replace(/\\/g, "/");
    const title = path.basename(filePath, path.extname(filePath));
    const parts = chunkMarkdown(await readFile(filePath, "utf8"), config.chunk);
    parts.forEach((content, index) => {
      chunks.push({
        id: stableChunkId(`${library.id}/${relativePath}`, index, content),
        libraryId: library.id,
        libraryLabel: library.label,
        path: relativePath,
        title,
        content,
        mtimeMs: info.mtimeMs,
        nchars: content.length
      });
    });
    onProgress?.({ libraryId: library.id, libraryLabel: library.label, stage: "chunk", processedFiles: fileIndex + 1, totalChunks: chunks.length, message: `分块 ${library.label}：${relativePath}` });
  }
  let reusedChunks = 0;
  const missingChunks = [];
  for (const chunk of chunks) {
    const existing = reusableEmbeddings.get(chunk.id);
    if (existing) {
      chunk.embedding = existing;
      reusedChunks += 1;
    } else {
      missingChunks.push(chunk);
    }
  }
  const embeddingBatchSize = Math.max(1, Math.min(512, Number(config.embedding?.batchSize) || 64));
  const embeddingConcurrency = Math.max(1, Math.min(100, Number(config.embedding?.concurrency) || 40));
  onProgress?.({
    libraryId: library.id,
    libraryLabel: library.label,
    stage: "embed",
    totalChunks: chunks.length,
    embeddedChunks: reusedChunks,
    message: missingChunks.length
      ? `${library.label}：复用 ${reusedChunks}，新 embed ${missingChunks.length}（batch=${embeddingBatchSize}, concurrency=${embeddingConcurrency}）`
      : `${library.label}：已复用全部 ${reusedChunks} 个片段`
  });
  const batches = [];
  for (let index = 0; index < missingChunks.length; index += embeddingBatchSize) {
    batches.push({
      start: index,
      chunks: missingChunks.slice(index, index + embeddingBatchSize)
    });
  }
  let completedMissingChunks = 0;
  await mapConcurrent(batches, embeddingConcurrency, async (item) => {
    const batch = item.chunks;
    const embeddings = await embedTexts(config, batch.map((chunk) => chunk.content));
    embeddings.forEach((embedding, offset) => {
      batch[offset].embedding = embedding;
    });
    completedMissingChunks += batch.length;
    onProgress?.({
      libraryId: library.id,
      libraryLabel: library.label,
      stage: "embed",
      embeddedChunks: Math.min(reusedChunks + completedMissingChunks, chunks.length),
      totalChunks: chunks.length,
      message: `${library.label}：${Math.min(reusedChunks + completedMissingChunks, chunks.length)} / ${chunks.length}`
    });
  });
  const index = {
    createdAt: isoNow(),
    libraryId: library.id,
    libraryLabel: library.label,
    docsDir: library.docsDir,
    embeddingModel: config.embedding.model,
    chunk: config.chunk,
    chunks
  };
  await writeJsonFile(knowledgeLibraryIndexPath(library.id), index);
  return index;
}

async function buildAllKnowledgeIndices({ onProgress } = {}) {
  const config = await loadKnowledgeConfig({ includeKey: true });
  const libraries = await discoverKnowledgeLibraries(config);
  if (!libraries.length) throw new Error("no knowledge library folders found under libraryRoot");
  const indices = [];
  for (let index = 0; index < libraries.length; index += 1) {
    const library = libraries[index];
    onProgress?.({
      libraryId: library.id,
      libraryLabel: library.label,
      stage: "library",
      libraryIndex: index + 1,
      libraryCount: libraries.length,
      message: `开始索引库 ${index + 1}/${libraries.length}：${library.label}`
    });
    indices.push(await buildKnowledgeIndex({
      libraryId: library.id,
      onProgress: (patch) => onProgress?.({
        ...patch,
        libraryIndex: index + 1,
        libraryCount: libraries.length
      })
    }));
  }
  return indices;
}

async function startKnowledgeReindex({ libraryId, all = false } = {}) {
  if (knowledgeReindexJob.running) return knowledgeReindexStatus();
  const config = await loadKnowledgeConfig();
  const targetLabel = all
    ? "全部知识库"
    : (config.libraries || []).find((item) => item.id === sanitizeKnowledgeLibraryId(libraryId || config.activeLibraryId))?.label || libraryId || config.activeLibraryId || "当前库";
  updateKnowledgeReindexJob({
    running: true,
    stage: "start",
    message: `准备重建索引：${targetLabel}`,
    error: "",
    startedAt: isoNow(),
    finishedAt: "",
    libraryId: all ? "all" : sanitizeKnowledgeLibraryId(libraryId || config.activeLibraryId),
    libraryLabel: targetLabel,
    totalFiles: 0,
    processedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    percent: 0
  });
  const runner = all ? buildAllKnowledgeIndices : () => buildKnowledgeIndex({ libraryId: libraryId || config.activeLibraryId });
  runner({
    onProgress: (patch) => updateKnowledgeReindexJob(patch)
  }).then((result) => {
    const indices = Array.isArray(result) ? result : [result];
    const totalChunks = indices.reduce((sum, item) => sum + (item.chunks?.length || 0), 0);
    updateKnowledgeReindexJob({
      running: false,
      stage: "done",
      message: `索引已建立：${indices.length} 个库 · ${totalChunks} 个片段`,
      error: "",
      finishedAt: isoNow(),
      totalChunks,
      embeddedChunks: totalChunks,
      percent: 100
    });
  }).catch((error) => {
    updateKnowledgeReindexJob({
      running: false,
      stage: "error",
      message: "索引建立失败",
      error: error.message,
      finishedAt: isoNow(),
      percent: 0
    });
  });
  return knowledgeReindexStatus();
}

async function loadKnowledgeIndex(libraryId = "default") {
  const id = sanitizeKnowledgeLibraryId(libraryId);
  const perLibrary = await readJsonFile(knowledgeLibraryIndexPath(id), null);
  if (perLibrary && Array.isArray(perLibrary.chunks)) return perLibrary;
  if (id === "default") {
    const legacy = await readJsonFile(knowledgeIndexFile, { createdAt: "", docsDir: "", embeddingModel: "", chunks: [] });
    if (Array.isArray(legacy.chunks) && legacy.chunks.length) return legacy;
  }
  return { createdAt: "", libraryId: id, docsDir: "", embeddingModel: "", chunks: [] };
}

async function loadKnowledgeChunksForLibraries(libraryIds) {
  const merged = [];
  const meta = [];
  for (const libraryId of libraryIds) {
    const index = await loadKnowledgeIndex(libraryId);
    const chunks = Array.isArray(index.chunks) ? index.chunks : [];
    meta.push({
      libraryId,
      createdAt: index.createdAt || "",
      docsDir: index.docsDir || "",
      embeddingModel: index.embeddingModel || "",
      totalChunks: chunks.length
    });
    for (const chunk of chunks) {
      merged.push({
        ...chunk,
        libraryId: chunk.libraryId || libraryId,
        libraryLabel: chunk.libraryLabel || libraryId
      });
    }
  }
  return { chunks: merged, libraries: meta };
}

function documentKeyFromResult(item) {
  const libraryPrefix = item?.libraryId ? `${item.libraryId}/` : "";
  return `${libraryPrefix}${String(item?.path || item?.title || item?.id || "").trim()}`.toLowerCase() || "(unknown)";
}

function diversifyResultsByDocument(results, limit, { maxPerDoc = 1 } = {}) {
  if (!Array.isArray(results) || !results.length) return [];
  const cap = Math.max(1, Number(limit) || results.length);
  const perDoc = Math.max(1, Number(maxPerDoc) || 1);
  const buckets = new Map();
  for (const item of results) {
    const key = documentKeyFromResult(item);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const diversified = [];
  const docCounts = new Map();
  const keys = [...buckets.keys()];
  while (diversified.length < cap) {
    let added = false;
    for (const key of keys) {
      const bucket = buckets.get(key);
      const used = docCounts.get(key) || 0;
      if (used >= perDoc || !bucket?.length) continue;
      diversified.push(bucket[used]);
      docCounts.set(key, used + 1);
      added = true;
      if (diversified.length >= cap) break;
    }
    if (!added) break;
  }
  return diversified;
}

async function searchKnowledge(query, { topK = 6, libraryIds, searchAllLibraries } = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("query is required");
  const config = await loadKnowledgeConfig({ includeKey: true });
  const selectedLibraryIds = resolveKnowledgeLibrarySelection(config, { libraryIds, searchAllLibraries });
  const { chunks, libraries: libraryMeta } = await loadKnowledgeChunksForLibraries(selectedLibraryIds);
  if (!chunks.length) {
    const labels = (config.libraries || []).filter((item) => selectedLibraryIds.includes(item.id)).map((item) => item.label).join("、") || "选定知识库";
    throw new Error(`knowledge index is empty for ${labels}; rebuild it first`);
  }
  const embeddingModels = [...new Set(libraryMeta.map((item) => item.embeddingModel).filter(Boolean))];
  if (embeddingModels.length > 1) {
    throw new Error(`embedding model mismatch across libraries: ${embeddingModels.join(", ")}`);
  }
  if (embeddingModels[0] && embeddingModels[0] !== config.embedding.model) {
    throw new Error(`embedding model mismatch: index=${embeddingModels[0]}, config=${config.embedding.model}`);
  }
  const retrieval = config.retrieval || {};
  const diversify = retrieval.diversify !== false;
  const maxChunksPerDoc = Math.max(1, Math.min(5, Number(retrieval.maxChunksPerDoc) || 1));
  const poolMultiplier = Math.max(2, Math.min(30, Number(retrieval.candidatePoolMultiplier) || 10));
  const limit = Math.max(1, Math.min(RETRIEVAL_MAX_TOP_K, Number(topK) || RETRIEVAL_DEFAULT_TOP_K));
  const [queryEmbedding] = await embedTexts(config, [text]);
  const queryTokens = tokenize(text);
  const ranked = chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const textScore = lexicalKnowledgeScore(chunk, queryTokens, text);
      const score = Number.isFinite(vectorScore)
        ? (vectorScore * 0.82) + (textScore * 0.18)
        : textScore;
      return {
        id: chunk.id,
        libraryId: chunk.libraryId,
        libraryLabel: chunk.libraryLabel,
        path: chunk.path,
        title: chunk.title,
        content: chunk.content,
        score,
        vectorScore,
        textScore,
        nchars: chunk.nchars
      };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);
  const candidateLimit = diversify
    ? Math.min(ranked.length, Math.max(limit * poolMultiplier, limit * maxChunksPerDoc * 4))
    : limit;
  const candidates = ranked.slice(0, candidateLimit);
  const results = diversify
    ? diversifyResultsByDocument(candidates, limit, { maxPerDoc: maxChunksPerDoc })
    : candidates.slice(0, limit);
  const distinctDocs = new Set(results.map((item) => documentKeyFromResult(item))).size;
  const totalChunks = libraryMeta.reduce((sum, item) => sum + item.totalChunks, 0);
  return {
    query: text,
    results,
    libraryIds: selectedLibraryIds,
    retrieval: {
      diversified: diversify,
      maxChunksPerDoc,
      candidatePool: candidates.length,
      distinctDocs
    },
    index: {
      createdAt: libraryMeta.map((item) => item.createdAt).filter(Boolean).sort().slice(-1)[0] || "",
      libraryIds: selectedLibraryIds,
      libraries: libraryMeta,
      embeddingModel: embeddingModels[0] || config.embedding.model,
      totalChunks
    }
  };
}

function lexicalKnowledgeScore(chunk, queryTokens, queryText) {
  const pathText = String(chunk.path || "").toLowerCase();
  const titleText = String(chunk.title || "").toLowerCase();
  const contentText = String(chunk.content || "").toLowerCase();
  const compactQuery = String(queryText || "").toLowerCase().trim();
  let score = 0;
  if (compactQuery && (pathText.includes(compactQuery) || titleText.includes(compactQuery))) score += 1;
  for (const token of queryTokens) {
    if (pathText.includes(token)) score += 0.6;
    if (titleText.includes(token)) score += 0.5;
    if (contentText.includes(token)) score += 0.18;
  }
  return Math.min(1, score);
}

function isWeakWebSearchQuery(query) {
  const text = String(query || "").trim();
  if (!text) return true;
  if (text.length <= 2) return true;
  if (WEAK_WEB_QUERY_RE.test(text)) return true;
  if (/^(现在|目前|当前)/.test(text) && text.length <= 8) return true;
  return false;
}

function extractNodeSearchHints(nodeMarkdown) {
  const text = String(nodeMarkdown || "");
  const fields = [];
  for (const label of ["Problem", "Approach", "Metrics", "NextIdea", "Input", "Output"]) {
    const match = text.match(new RegExp(`- ${label}:\\s*(.+)$`, "m"));
    if (match?.[1]) fields.push(match[1].trim());
  }
  return fields.join(" ").replace(/\s+/g, " ").trim().slice(0, 420);
}

function buildRetrievalContextHint({ question = "", nodeMarkdown = "", contextHint = "" } = {}) {
  const parts = [
    String(contextHint || "").trim(),
    String(question || "").trim(),
    extractNodeSearchHints(nodeMarkdown)
  ].filter(Boolean);
  return [...new Set(parts)].join("\n").slice(0, 720);
}

function extractSearchIntentFromContext(contextHint) {
  let text = String(contextHint || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stripPatterns = [
    /^(请问|我想知道|帮我查|帮我搜索|帮我|能否|请说明|请解释|请)\s*/u,
    /^(现在|目前|当前|今天)[，,：:\s]+/u,
    /^(现在|目前|当前)\s*(的)?\s*(问题|情况|进展|状态|任务|方案|思路|卡点|困难)\s*(是|是什么|怎样|如何|怎么样)?[？?]?\s*/u
  ];
  for (const pattern of stripPatterns) text = text.replace(pattern, "").trim();
  return text.slice(0, 360);
}

function buildWebSearchQuery(rawQuery, contextHint) {
  const raw = String(rawQuery || "").trim();
  let cleaned = raw
    .replace(/^(现在|目前|当前|今天)[，,：:\s]+/u, "")
    .replace(/[？?]\s*$/u, "")
    .trim();
  const intent = extractSearchIntentFromContext(contextHint);

  if (cleaned && !isWeakWebSearchQuery(cleaned)) {
    return cleaned.slice(0, 240);
  }

  if (intent && !isWeakWebSearchQuery(intent)) {
    return intent.slice(0, 240);
  }
  if (intent && cleaned) {
    const merged = `${intent} ${cleaned}`.replace(/\s+/g, " ").trim();
    if (!isWeakWebSearchQuery(merged)) return merged.slice(0, 240);
  }
  if (intent) return intent.slice(0, 240);
  if (cleaned) return cleaned.slice(0, 240);
  return raw.slice(0, 240);
}

function refineSearchQuery(query, contextHint) {
  const raw = String(query || "").trim();
  const hint = String(contextHint || "").trim();
  if (!raw) return extractSearchIntentFromContext(hint).slice(0, 240);
  if (!isWeakWebSearchQuery(raw)) return raw.slice(0, 240);
  return buildWebSearchQuery(raw, hint);
}

function extractBestSearchPhrase(contextHint, { minLength = 4 } = {}) {
  const text = String(contextHint || "").replace(/\r/g, "").trim();
  if (!text) return "";

  const intent = extractSearchIntentFromContext(text);
  if (intent && !isWeakWebSearchQuery(intent)) return intent.slice(0, 240);

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].sort((a, b) => b.length - a.length)) {
    const cleaned = line
      .replace(/^(上一轮问|上一轮检索|上一轮答|本轮问题|问|答|Q|A)[：:]\s*/u, "")
      .replace(/^(用户|助手|模型)[：:]\s*/u, "")
      .trim();
    if (cleaned.length >= minLength && !isWeakWebSearchQuery(cleaned)) {
      return cleaned.slice(0, 240);
    }
  }
  if (text.length >= minLength && !isWeakWebSearchQuery(text)) return text.slice(0, 240);
  return intent || text.slice(0, 240);
}

function shouldPreferLlmQueryRewrite(rawQuery, hintBundle, heuristicQuery, { includeWeb = false } = {}) {
  const raw = String(rawQuery || "").trim();
  const hint = String(hintBundle || "").trim();
  if (includeWeb) return true;
  if (isWeakWebSearchQuery(raw)) return true;
  if (isWeakWebSearchQuery(heuristicQuery)) return true;
  if (raw.length <= 12 && hint.length > raw.length + 8) return true;
  return false;
}

function parseLlmSearchQueries(text) {
  const raw = String(text || "").trim();
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.map((item) => String(item || "").trim()).filter(Boolean);
      }
      if (typeof parsed.query === "string" && parsed.query.trim()) {
        return [parsed.query.trim()];
      }
    } catch {
      // try next candidate
    }
  }
  const line = raw.split(/\n+/).map((item) => item.trim()).find((item) => item.length >= 4 && !isWeakWebSearchQuery(item));
  return line ? [line.slice(0, 240)] : [];
}

async function resolveKnowledgeChatAgent() {
  const config = await loadKnowledgeConfig();
  const modelId = safeModelId(config.chat?.modelId);
  if (!modelId) return null;
  const agentConfig = await loadModelAgents({ includeKeys: true });
  const agent = agentConfig.models.find((item) => item.id === modelId);
  if (!agent?.apiKey || !agent.model) return null;
  return agent;
}

async function generateSearchQueriesWithLlm({ rawQuery, hintBundle, nodeMarkdown }) {
  const agent = await resolveKnowledgeChatAgent();
  if (!agent) return { queries: [], source: "" };
  const messages = [
    {
      role: "system",
      content: [
        "你是检索 query 生成器，只输出搜索关键词，不回答问题。",
        "输出格式：仅一个 JSON 对象，无其它文字：{\"queries\":[\"检索短语1\",\"检索短语2\"]}",
        "规则：",
        "- 从用户问题和上下文提取 1-2 条检索短语，每条 4-20 汉字或 3-12 个英文词",
        "- 用名词+技术关键词，像 Google/学术搜索框，不要整句问话",
        "- 禁止：指代词（我们/这个/它/那）、<=3 字、时间/释义/百科泛词",
        "- 好例子：[\"LLM RAG 检索 query 改写\",\"multi-agent task graph markdown\"]",
        "- 坏例子：[\"我们\",\"现在怎么办\",\"什么是\"]"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户问题：${String(rawQuery || "").trim()}`,
        hintBundle ? `对话与任务上下文：\n${String(hintBundle).slice(0, 900)}` : "",
        nodeMarkdown ? `当前节点：\n${String(nodeMarkdown).slice(0, 600)}` : ""
      ].filter(Boolean).join("\n\n")
    }
  ];
  try {
    const answer = await callOpenAICompatible(agent, messages);
    const queries = parseLlmSearchQueries(answer)
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter((item) => item && !isWeakWebSearchQuery(item))
      .slice(0, 2);
    return { queries, source: "llm" };
  } catch {
    return { queries: [], source: "" };
  }
}

async function resolveRetrievalQueries({ rawQuery, hintBundle, nodeMarkdown, includeWeb = false, useLlmQuery = true }) {
  const raw = String(rawQuery || "").trim();
  let knowledgeQuery = refineSearchQuery(raw, hintBundle);
  let webQuery = buildWebSearchQuery(raw, hintBundle);
  let rewriteSource = "heuristic";
  let llmQueries = [];

  const preferLlm = useLlmQuery !== false && shouldPreferLlmQueryRewrite(raw, hintBundle, knowledgeQuery, { includeWeb });
  if (preferLlm) {
    const llm = await generateSearchQueriesWithLlm({ rawQuery: raw, hintBundle, nodeMarkdown });
    llmQueries = llm.queries;
    if (llmQueries.length) {
      knowledgeQuery = llmQueries[0];
      webQuery = llmQueries[0];
      rewriteSource = "llm";
    }
  }

  if (isWeakWebSearchQuery(knowledgeQuery)) {
    const fromHint = extractBestSearchPhrase(hintBundle);
    if (fromHint && !isWeakWebSearchQuery(fromHint)) {
      knowledgeQuery = fromHint;
      if (isWeakWebSearchQuery(webQuery)) webQuery = fromHint;
      rewriteSource = rewriteSource === "llm" ? "llm+hint" : "hint";
    }
  }
  if (includeWeb && isWeakWebSearchQuery(webQuery)) {
    webQuery = knowledgeQuery;
  }

  return {
    rawQuery: raw,
    knowledgeQuery,
    webQuery: includeWeb ? webQuery : "",
    queryWasWeak: isWeakWebSearchQuery(raw),
    rewriteSource,
    llmQueries
  };
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isBlockedWebHost(host) {
  const normalized = String(host || "").toLowerCase();
  if (!normalized) return false;
  if (LOW_VALUE_WEB_HOSTS.has(normalized)) return true;
  const blockedSuffixes = ["beijing-time.org", "time.is", "timeanddate.com", "timeanddate.cn", "bjtime.org"];
  return blockedSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isLowValueWebResult(item) {
  const host = hostnameFromUrl(item.url || item.path);
  if (isBlockedWebHost(host)) return true;
  const title = String(item.title || "").trim();
  const content = String(item.content || "").trim();
  const url = String(item.url || item.path || "");
  const blob = `${title}\n${content}\n${url}`;
  if (TIME_JUNK_TEXT_RE.test(blob)) return true;
  if (/baike\.baidu\.com/i.test(url) && /^(现在|当前|时间|北京时间)/.test(title)) return true;
  return false;
}

function diversifyResultsByHost(results, limit) {
  const local = results.filter((item) => item.source === "knowledge");
  const web = results.filter((item) => item.source !== "knowledge");
  const buckets = new Map();
  for (const item of web) {
    const host = hostnameFromUrl(item.url || item.path) || "(unknown)";
    if (!buckets.has(host)) buckets.set(host, []);
    buckets.get(host).push(item);
  }
  const diversified = [];
  const hosts = [...buckets.keys()];
  while (diversified.length < limit && hosts.some((host) => buckets.get(host)?.length)) {
    for (const host of hosts) {
      const bucket = buckets.get(host);
      if (bucket?.length && diversified.length < limit) diversified.push(bucket.shift());
    }
  }
  return [...local, ...diversified];
}

function buildKnowledgeContext(results, { maxChars = RETRIEVAL_CONTEXT_MAX_CHARS, snippetChars = RETRIEVAL_SNIPPET_CHARS } = {}) {
  const blocks = [];
  let used = 0;
  for (let index = 0; index < (results || []).length; index += 1) {
    const item = results[index];
    const header = `[${index + 1}] ${item.libraryLabel ? `[${item.libraryLabel}] ` : ""}${item.title || item.path} (${item.source || "knowledge"}: ${item.url || item.path}, score=${Number(item.score || 0).toFixed(3)})`;
    const remaining = maxChars - used - header.length - 1;
    if (remaining <= 120) break;
    const content = String(item.content || "").slice(0, Math.min(snippetChars, remaining));
    const block = `${header}\n${content}`;
    blocks.push(block);
    used += block.length + 5;
    if (used >= maxChars) break;
  }
  return blocks.join("\n\n---\n\n");
}

async function loadWebSearchConfig({ includeKey = false } = {}) {
  const env = await loadLocalEnv();
  const saved = await readJsonFile(webSearchConfigFile, defaultWebSearchConfig());
  const provider = normalizeWebSearchProvider(env.WEB_SEARCH_PROVIDER || saved.provider || "");
  const envKey = env.WEB_SEARCH_API_KEY || env.TAVILY_API_KEY || env.BRAVE_SEARCH_API_KEY || env.EXA_API_KEY;
  const savedKey = saved.apiKey || saved.api_key;
  const rawBaseUrl = normalizeBaseUrl(env.WEB_SEARCH_BASE_URL || saved.baseUrl || saved.base_url || "");
  return {
    provider,
    apiKey: includeKey ? String(envKey || savedKey || "") : "",
    hasApiKey: Boolean(envKey || savedKey),
    requiresApiKey: !["searxng", "openwebsearch"].includes(provider),
    baseUrl: rawBaseUrl || (provider === "openwebsearch" ? "http://127.0.0.1:3210" : ""),
    enabled: envBool(env.WEB_SEARCH_ENABLED, saved.enabled === true || Boolean(provider)),
    maxResults: Math.max(1, Math.min(15, Number(env.WEB_SEARCH_MAX_RESULTS || saved.maxResults) || 8))
  };
}

async function saveWebSearchConfig(input) {
  const existing = await loadWebSearchConfig({ includeKey: true });
  const config = {
    provider: normalizeWebSearchProvider(input?.provider || existing.provider || ""),
    apiKey: String(input?.apiKey || input?.api_key || existing.apiKey || ""),
    baseUrl: normalizeBaseUrl(input?.baseUrl || input?.base_url || existing.baseUrl || ""),
    enabled: input?.enabled !== false,
    maxResults: Math.max(1, Math.min(15, Number(input?.maxResults) || existing.maxResults || 8))
  };
  await writeJsonFile(webSearchConfigFile, config);
  return loadWebSearchConfig();
}

function normalizeWebSearchProvider(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "openwebsearch") return "openwebsearch";
  if (compact === "searxng") return "searxng";
  if (compact === "tavily") return "tavily";
  if (compact === "brave") return "brave";
  if (compact === "exa") return "exa";
  return String(value || "").trim().toLowerCase();
}

async function searchWeb(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("query is required");
  const config = await loadWebSearchConfig({ includeKey: true });
  if (!config.enabled) return { query: text, results: [], config: await loadWebSearchConfig() };
  if (!config.provider) throw new Error("missing web search provider");
  if (!["searxng", "openwebsearch"].includes(config.provider) && !config.apiKey) throw new Error("missing web search api_key");
  const maxResults = Math.max(1, Math.min(15, Number(options.topK || config.maxResults) || 8));
  if (config.provider === "tavily") return searchTavily(text, config, maxResults);
  if (config.provider === "brave") return searchBrave(text, config, maxResults);
  if (config.provider === "exa") return searchExa(text, config, maxResults);
  if (config.provider === "searxng") return searchSearxng(text, config, maxResults);
  if (config.provider === "openwebsearch") return searchOpenWebSearch(text, config, maxResults);
  throw new Error(`unsupported web search provider: ${config.provider}`);
}

async function searchTavily(query, config, maxResults) {
  const response = await fetch(config.baseUrl || "https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: config.apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false
    })
  });
  const data = await parseProviderResponse(response);
  const results = (data.results || []).map((item) => ({
    source: "web",
    provider: "tavily",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.content || item.snippet || "",
    score: Number(item.score) || 0
  }));
  return { query, results };
}

async function searchBrave(query, config, maxResults) {
  const baseUrl = config.baseUrl || "https://api.search.brave.com/res/v1/web/search";
  const url = new URL(baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "x-subscription-token": config.apiKey
    }
  });
  const data = await parseProviderResponse(response);
  const results = (data.web?.results || []).map((item, index) => ({
    source: "web",
    provider: "brave",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.description || item.extra_snippets?.join("\n") || "",
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results };
}

async function searchExa(query, config, maxResults) {
  const response = await fetch(config.baseUrl || "https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      contents: { text: true }
    })
  });
  const data = await parseProviderResponse(response);
  const results = (data.results || []).map((item) => ({
    source: "web",
    provider: "exa",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.text || item.summary || "",
    score: Number(item.score) || 0
  }));
  return { query, results };
}

async function searchSearxng(query, config, maxResults) {
  if (!config.baseUrl) throw new Error("missing searxng base_url");
  const url = new URL(joinUrl(config.baseUrl, "/search"));
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url);
  const data = await parseProviderResponse(response);
  const results = (data.results || []).slice(0, maxResults).map((item, index) => ({
    source: "web",
    provider: "searxng",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.content || item.snippet || "",
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results };
}

async function searchOpenWebSearch(query, config, maxResults) {
  const baseUrl = config.baseUrl || "http://127.0.0.1:3210";
  await ensureOpenWebSearchDaemon();
  const env = await loadLocalEnv();
  const engines = String(env.OPEN_WEBSEARCH_ENGINES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const searchMode = String(env.OPEN_WEBSEARCH_SEARCH_MODE || "").trim();
  const body = { query, limit: maxResults };
  if (engines.length) body.engines = engines;
  if (searchMode) body.searchMode = searchMode;
  let response;
  try {
    response = await fetch(joinUrl(baseUrl, "/search"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`openwebsearch daemon not reachable at ${baseUrl}: ${error.message}`);
  }
  const envelope = await parseProviderResponse(response);
  if (envelope.status === "error") {
    throw new Error(envelope.error?.message || envelope.hint || "openwebsearch error");
  }
  const data = envelope.data || envelope;
  const failures = Array.isArray(data.partialFailures) && data.partialFailures.length
    ? `\n\nPartial failures: ${data.partialFailures.map((item) => `${item.engine}: ${item.message}`).join("; ")}`
    : "";
  const results = (data.results || []).slice(0, maxResults).map((item, index) => ({
    source: "web",
    provider: "openwebsearch",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: `${item.description || ""}${failures}`,
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results, failures: data.partialFailures || [] };
}

async function stopLocalPort(portValue) {
  const portNumber = Number(portValue);
  if (!Number.isInteger(portNumber) || portNumber <= 0) return;
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$port=${portNumber}`,
    `$self=${process.pid}`,
    "$pids = Get-NetTCPConnection -LocalPort $port | Where-Object { $_.OwningProcess -and $_.OwningProcess -ne $self } | Select-Object -ExpandProperty OwningProcess -Unique",
    "foreach ($pidToStop in $pids) { Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue; & taskkill /PID $pidToStop /F 2>$null | Out-Null }"
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 8000 }).catch(() => {});
}

async function shutdownBackgroundServices() {
  const webConfig = await loadWebSearchConfig();
  if (webConfig.provider === "openwebsearch") {
    const baseUrl = webConfig.baseUrl || "http://127.0.0.1:3210";
    try {
      const url = new URL(baseUrl);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        await stopLocalPort(url.port || 3210);
      }
    } catch {
      // Ignore malformed optional web-search base URL during shutdown.
    }
  }
}

async function parseProviderResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`web search non-json response: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(data.error?.message || data.message || text.slice(0, 1000));
  return data;
}

async function searchRetrieval(query, { topK = RETRIEVAL_DEFAULT_TOP_K, webTopK = RETRIEVAL_WEB_DEFAULT_TOP_K, includeKnowledge = true, includeWeb = false, contextHint = "", nodeMarkdown = "", useLlmQuery = true, libraryIds, searchAllLibraries } = {}) {
  const rawQuery = String(query || "").trim();
  const hintBundle = buildRetrievalContextHint({ question: contextHint, nodeMarkdown, contextHint });
  const knowledgeTopK = Math.max(1, Math.min(RETRIEVAL_MAX_TOP_K, Number(topK) || RETRIEVAL_DEFAULT_TOP_K));
  const effectiveWebTopK = Math.max(1, Math.min(RETRIEVAL_WEB_MAX_TOP_K, Number(webTopK) || RETRIEVAL_WEB_DEFAULT_TOP_K));
  const resolved = await resolveRetrievalQueries({
    rawQuery,
    hintBundle,
    nodeMarkdown,
    includeWeb,
    useLlmQuery
  });
  const knowledgeQuery = resolved.knowledgeQuery;
  const webQuery = resolved.webQuery;
  const queryWasWeak = resolved.queryWasWeak;
  const results = [];
  const errors = [];
  let index = null;
  if (includeKnowledge) {
    try {
      const local = await searchKnowledge(knowledgeQuery, { topK: knowledgeTopK, libraryIds, searchAllLibraries });
      index = local.index;
      results.push(...local.results.map((item) => ({ ...item, source: "knowledge" })));
    } catch (error) {
      const message = String(error.message || error);
      if (message.includes("index is empty")) {
        errors.push("knowledge: 本地索引为空，请点「重建索引」（联网检索仍可继续）");
      } else {
        errors.push(`knowledge: ${message}`);
      }
    }
  }
  if (includeWeb) {
    try {
      const webFetchK = Math.min(RETRIEVAL_WEB_MAX_TOP_K + 4, Math.max(effectiveWebTopK + 2, Math.ceil(effectiveWebTopK * 1.5)));
      const web = await searchWeb(webQuery, { topK: webFetchK });
      const filtered = (web.results || []).filter((item) => !isLowValueWebResult(item));
      results.push(...diversifyResultsByHost(filtered, effectiveWebTopK));
      if (webQuery && webQuery !== rawQuery) {
        const via = resolved.rewriteSource === "llm" ? "大模型提取关键词" : "规则改写";
        errors.push(`web: 已将「${rawQuery}」改写为「${webQuery}」（${via}）`);
      }
      if ((web.results || []).length && !filtered.length) {
        errors.push("web: 联网命中已过滤低价值页面（时间/释义站），可换更具体的技术关键词再搜");
      }
    } catch (error) {
      errors.push(`web: ${error.message}`);
    }
  }
  if (!results.length && errors.length) throw new Error(errors.join("; "));
  return {
    query: rawQuery,
    refinedQuery: knowledgeQuery,
    webQuery,
    executedQuery: includeWeb ? webQuery : knowledgeQuery,
    queryWasWeak,
    rewriteSource: resolved.rewriteSource,
    llmQueries: resolved.llmQueries,
    libraryIds: index?.libraryIds || (Array.isArray(libraryIds) ? libraryIds : searchAllLibraries ? ["all"] : []),
    searchAllLibraries: searchAllLibraries === true,
    results,
    index,
    errors
  };
}

function parseKnowledgeRetrievalBody(body = {}, config = {}) {
  const searchAllLibraries = typeof body?.searchAllLibraries === "boolean"
    ? body.searchAllLibraries
    : config.searchAllLibraries === true;
  const libraryIds = Array.isArray(body?.libraryIds)
    ? body.libraryIds.map((item) => sanitizeKnowledgeLibraryId(item)).filter(Boolean)
    : undefined;
  return { libraryIds, searchAllLibraries };
}

function defaultModelAgentPrompt(name) {
  return [
    `# ${name || "Model Agent"}`,
    "",
    "你是多个独立模型协作者之一，帮助用户分析共享任务图中的当前节点。",
    "",
    "规则：",
    "- 必须用中文回答，除非用户明确要求其它语言。",
    "- 先读系统提供的当前选中任务树，再聚焦当前节点和用户这一次的问题。",
    "- GraphState.NextPlan 只是可能过期的用户备忘，禁止执行；执行焦点只认 GraphState.Next 和该节点的 NextIdea。",
    "- 你会看到系统自动检索出的本地 Markdown 知识库片段，也可能看到联网搜索结果；这些是可用证据，不足时要明确说还缺什么。",
    "- 不要假设其它模型会同意你；独立给出判断、风险、反例和下一步建议。",
    "- 如果当前选中任务树与历史或其它信息冲突，以当前树为准。",
    "- 回答要适合用户横向比较多个模型：结构清楚、不要长篇铺陈、优先给结论和依据。"
  ].join("\n");
}

async function readModelAgentPrompt(agent) {
  await mkdir(modelAgentsDir, { recursive: true });
  const configured = agent.agentFile ? resolveWorkspacePath(agent.agentFile, "") : null;
  const agentPath = configured || path.join(modelAgentsDir, `${agent.id}.md`);
  if (!existsSync(agentPath)) {
    await writeFile(agentPath, defaultModelAgentPrompt(agent.name), "utf8");
  }
  return await readFile(agentPath, "utf8");
}

async function loadModelAgents({ includeKeys = false } = {}) {
  const env = await loadLocalEnv();
  const data = await readJsonFile(modelAgentsFile, { models: [] });
  const models = Array.isArray(data.models) ? [...data.models] : [];
  const envIds = String(env.MODEL_AGENT_IDS || "").split(",").map((item) => safeModelId(item)).filter(Boolean);
  for (const id of envIds) {
    const segment = envKeySegment(id);
    const envAgent = {
      id,
      name: env[`MODEL_AGENT_${segment}_NAME`] || id,
      baseUrl: env[`MODEL_AGENT_${segment}_BASE_URL`] || "",
      model: env[`MODEL_AGENT_${segment}_MODEL`] || "",
      apiKey: env[`MODEL_AGENT_${segment}_API_KEY`] || "",
      enabled: envBool(env[`MODEL_AGENT_${segment}_ENABLED`], true),
      wireApi: env[`MODEL_AGENT_${segment}_WIRE_API`] || "chat",
      agentFile: env[`MODEL_AGENT_${segment}_AGENT_FILE`] || path.join("model-agents", `${id}.md`),
      source: "env"
    };
    const existingIndex = models.findIndex((item) => safeModelId(item.id || item.name || item.model) === id);
    if (existingIndex >= 0) models[existingIndex] = { ...models[existingIndex], ...envAgent };
    else models.push(envAgent);
  }
  return {
    models: models.map((item) => {
      const id = safeModelId(item.id || item.name || item.model) || `model-${Math.random().toString(36).slice(2, 8)}`;
      const key = String(item.apiKey || item.api_key || "");
      return {
        id,
        name: String(item.name || id),
        baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url),
        model: String(item.model || ""),
        apiKey: includeKeys ? key : "",
        hasApiKey: Boolean(key),
        enabled: item.enabled !== false,
        wireApi: String(item.wireApi || item.wire_api || "chat"),
        agentFile: String(item.agentFile || item.agent_file || path.join("model-agents", `${id}.md`)),
        source: item.source || "json"
      };
    })
  };
}

async function saveModelAgents(models) {
  const existing = await readJsonFile(modelAgentsFile, { models: [] });
  const keyById = new Map((Array.isArray(existing.models) ? existing.models : []).map((item) => [
    safeModelId(item.id || item.name || item.model),
    String(item.apiKey || item.api_key || "")
  ]));
  const normalized = (Array.isArray(models) ? models : []).map((item, index) => {
    const id = safeModelId(item.id || item.name || item.model) || `model-${index + 1}`;
    const incomingKey = String(item.apiKey || item.api_key || "");
    return {
      id,
      name: String(item.name || id),
      baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url),
      model: String(item.model || ""),
      apiKey: incomingKey || keyById.get(id) || "",
      enabled: item.enabled !== false,
      wireApi: String(item.wireApi || item.wire_api || "chat"),
      agentFile: String(item.agentFile || item.agent_file || path.join("model-agents", `${id}.md`))
    };
  });
  await writeJsonFile(modelAgentsFile, { models: normalized });
  await mkdir(modelAgentsDir, { recursive: true });
  for (const item of normalized) {
    const configured = resolveWorkspacePath(item.agentFile, "");
    const agentPath = configured || path.join(modelAgentsDir, `${item.id}.md`);
    if (typeof item.agentPrompt === "string" && item.agentPrompt.trim()) {
      await writeFile(agentPath, item.agentPrompt, "utf8");
    } else if (!existsSync(agentPath)) {
      await writeFile(agentPath, defaultModelAgentPrompt(item.name), "utf8");
    }
  }
  return loadModelAgents();
}

async function loadModelAgentDetails() {
  const config = await loadModelAgents({ includeKeys: false });
  const models = [];
  for (const item of config.models) {
    models.push({ ...item, agentPrompt: await readModelAgentPrompt(item) });
  }
  return { models };
}

function extractNodeMarkdown(markdown, nodeId) {
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## ${nodeId} - `));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+[A-Za-z0-9_-]+\s+-\s+/.test(lines[index]) || /^#\s+GraphState\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractGraphStateMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^#\s+GraphState\s*$/i.test(line.trim()));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#\s+Edges\s*$/i.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function parseGraphStateFields(markdown) {
  const state = {
    current: "",
    next: "",
    nextPlan: "",
    chain: "",
    chainAutoAdvance: false,
    chainForceNext: "",
    chainRunStatus: ""
  };
  let inState = false;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    if (/^#\s+GraphState\s*$/i.test(line.trim())) {
      inState = true;
      continue;
    }
    if (inState && /^#\s+Edges\s*$/i.test(line.trim())) break;
    if (!inState) continue;
    const match = line.match(/^-\s+(Current|Next|NextPlan|Chain|ChainAutoAdvance|ChainForceNext|ChainRunStatus):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (match[1] === "Current") state.current = sanitizeGraphId(value);
    if (match[1] === "Next") state.next = sanitizeGraphId(value);
    if (match[1] === "NextPlan") state.nextPlan = value;
    if (match[1] === "Chain") state.chain = value;
    if (match[1] === "ChainAutoAdvance") state.chainAutoAdvance = /^(true|yes|1|是|on)$/i.test(value);
    if (match[1] === "ChainForceNext") state.chainForceNext = sanitizeGraphId(value);
    if (match[1] === "ChainRunStatus") state.chainRunStatus = value.toLowerCase();
  }
  return state;
}

function parseChainNodeIds(chainText) {
  return String(chainText || "")
    .split(/[,，\s]+/)
    .map((item) => sanitizeGraphId(item))
    .filter(Boolean);
}

/**
 * Matches exactly one `- Field: value` line.
 * `\s*` around the colon must not be used here: on an empty field (`- ChainForceNext: `)
 * it crosses the newline and swallows the following line.
 */
function fieldLinePattern(fieldName, { capture = false } = {}) {
  const value = capture ? "([^\\r\\n]*)" : "[^\\r\\n]*";
  return new RegExp(`^-[^\\S\\r\\n]+${fieldName}:[^\\S\\r\\n]*${value}$`, "m");
}

function extractNodeFieldValue(markdown, nodeId, fieldName) {
  const block = extractNodeMarkdown(markdown, nodeId);
  if (!block) return "";
  const match = block.match(fieldLinePattern(fieldName, { capture: true }));
  return match ? match[1].trim() : "";
}

function isNodeChainComplete(markdown, nodeId) {
  const completion = extractNodeFieldValue(markdown, nodeId, "Completion");
  if (completion === "已完成") return { complete: true, reason: "Completion=已完成" };
  if (completion === "需重做") return { complete: false, reason: "Completion=需重做" };
  const result = extractNodeFieldValue(markdown, nodeId, "CurrentResult");
  if (result.length >= 20) return { complete: true, reason: "CurrentResult 已有实质内容" };
  return { complete: false, reason: "Completion 未标记已完成，且 CurrentResult 过短" };
}

function setGraphStateField(markdown, fieldName, value) {
  const line = `- ${fieldName}: ${String(value ?? "").trim()}`;
  const pattern = fieldLinePattern(fieldName);
  if (pattern.test(markdown)) return markdown.replace(pattern, line);
  return markdown.replace(/(#\s+GraphState[^\S\r\n]*\r?\n)/i, `$1${line}\n`);
}

function getNextNodeNextIdea(markdown, nodeId) {
  if (!nodeId) return "";
  return String(extractNodeFieldValue(markdown, nodeId, "NextIdea") || "").trim();
}

function advanceAgentChain(markdown, { force = false } = {}) {
  const state = parseGraphStateFields(markdown);
  const chain = parseChainNodeIds(state.chain);
  const notes = [];

  if (state.chainForceNext) {
    const forced = state.chainForceNext;
    let updated = setGraphStateField(markdown, "Current", state.next || state.current || forced);
    updated = setGraphStateField(updated, "Next", forced);
    updated = setGraphStateField(updated, "ChainForceNext", "");
    return {
      ok: true,
      advanced: true,
      forced: true,
      done: false,
      state: parseGraphStateFields(updated),
      markdown: updated,
      message: `已应用 ChainForceNext → ${forced}`,
      agentPrompt: buildChainAgentPrompt(parseGraphStateFields(updated), chain, { redactFuture: true, markdown: updated })
    };
  }

  if (!chain.length) {
    return { ok: false, advanced: false, message: "GraphState.Chain 为空", state };
  }

  if (!state.next) {
    return { ok: false, advanced: false, message: "GraphState.Next 为空", state };
  }

  const idx = chain.indexOf(state.next);
  if (idx < 0) {
    return { ok: false, advanced: false, message: `GraphState.Next=${state.next} 不在 Chain 中`, state, chain };
  }

  if (!force && !state.chainAutoAdvance) {
    return { ok: false, advanced: false, message: "ChainAutoAdvance 未开启；可手动推进或 force=true", state, chain };
  }

  const completion = isNodeChainComplete(markdown, state.next);
  if (!force && !completion.complete) {
    return { ok: false, advanced: false, message: `节点 ${state.next} 尚未完成：${completion.reason}`, state, chain, completion };
  }

  const newCurrent = state.next;
  const newNext = chain[idx + 1] || "";
  const done = !newNext;
  let updated = setGraphStateField(markdown, "Current", newCurrent);
  updated = setGraphStateField(updated, "Next", newNext);
  updated = setGraphStateField(updated, "ChainRunStatus", done ? "done" : "running");

  return {
    ok: true,
    advanced: true,
    forced: false,
    done,
    state: parseGraphStateFields(updated),
    markdown: updated,
    message: done ? `链已走完；Current=${newCurrent}` : `链已推进：Current=${newCurrent}，Next=${newNext}`,
    agentPrompt: buildChainAgentPrompt(parseGraphStateFields(updated), chain, { redactFuture: true, markdown: updated })
  };
}

function buildChainAgentPrompt(state, chain, { redactFuture = false, markdown = "" } = {}) {
  const idx = state.next ? chain.indexOf(state.next) : -1;
  const nextIdea = getNextNodeNextIdea(markdown, state.next);
  const chainLine = redactFuture && chain.length
    ? `ChainPosition: ${idx >= 0 ? idx + 1 : "?"}/${chain.length}（后续节点 ID 不可见）`
    : `Chain: ${chain.length ? chain.join(" → ") : "(未设置 Chain)"}`;
  const stopInstruction = process.platform === "win32"
    ? "运行 llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly（默认不关闭 IDE）"
    : "在当前 Agent 中停止 /loop（Linux/macOS 不需要关闭 IDE 进程）";
  return [
    "【Agent 链式单步】",
    chainLine,
    `Current: ${state.current || "(空)"}`,
    `Next: ${state.next || "(空)"}`,
    `NextIdea: ${nextIdea || "(空)"}`,
    state.chainRunStatus ? `ChainRunStatus: ${state.chainRunStatus}` : "",
    state.chainForceNext ? `ChainForceNext: ${state.chainForceNext}（链式模式：本轮通过 chain-advance 推进，不要手改 markdown 里的 Next）` : "",
    state.chainAutoAdvance ? "ChainAutoAdvance: 是（Next 完成后调用 POST /api/graph-state/chain-advance 推进）" : "ChainAutoAdvance: 否",
    "",
    "优先读 GET /api/graph-state/chain-step 的 stepMarkdown 确定本步焦点；若 NextIdea 需要全局上下文，可读完整 task-tree.md。",
    "本轮唯一任务：严格按 Next 节点的 NextIdea（页面「下一步思路」）执行；不要读 GraphState.NextPlan（「下一步」）；不要一轮做完 Chain 里多个节点。",
    "非链式循环时不要修改 GraphState.Current/Next/NextPlan；链式推进 Next 只能用 chain-advance API。",
    `shouldStopLoop=true 时：${stopInstruction}。`,
    `本轮结束时：更新 Next 节点 CurrentResult；若已完成且 ChainAutoAdvance=是，调用 chain-advance；若返回 done=true，${stopInstruction}。`
  ].filter(Boolean).join("\n");
}

function getChainVisibleNodeIds(chain, nextId) {
  if (!chain.length) return ["ROOT"];
  const idx = nextId ? chain.indexOf(nextId) : -1;
  const through = idx >= 0 ? chain.slice(0, idx + 1) : chain.slice(0, 1);
  return [...new Set(["ROOT", ...through])];
}

function buildRedactedGraphStateBlock(state, chain, markdown) {
  const idx = state.next ? chain.indexOf(state.next) : -1;
  const step = idx >= 0 ? idx + 1 : 0;
  const nextIdea = getNextNodeNextIdea(markdown, state.next);
  const lines = [
    "# GraphState",
    "",
    `- Current: ${state.current || ""}`,
    `- Next: ${state.next || ""}`,
    `- NextIdea: ${nextIdea || ""}`,
    chain.length ? `- ChainPosition: ${step}/${chain.length}` : "",
    state.chainAutoAdvance ? "- ChainAutoAdvance: true" : "",
    state.chainRunStatus ? `- ChainRunStatus: ${state.chainRunStatus}` : "",
    state.chainForceNext ? `- ChainForceNext: ${state.chainForceNext}` : "",
    "",
    "> loop 执行依据是 Next 节点的 NextIdea（下一步思路），不是 GraphState.NextPlan（下一步）。",
    "> 完整 Chain 列表与后续节点内容未包含在此文件中。"
  ].filter(Boolean);
  return lines.join("\n");
}

function evaluateChainLoopStop(state, chain, markdown) {
  if (state.chainRunStatus === "done") {
    return { shouldStopLoop: true, stopReason: "ChainRunStatus=done" };
  }
  if (!chain.length) {
    return { shouldStopLoop: true, stopReason: "Chain 为空" };
  }
  if (!state.next) {
    return { shouldStopLoop: true, stopReason: "GraphState.Next 为空（链已跑完）" };
  }
  const completion = extractNodeFieldValue(markdown, state.next, "Completion");
  if (completion === "需重做") {
    return { shouldStopLoop: true, stopReason: `Next=${state.next} 为需重做，请人工修复后重启 loop` };
  }
  return { shouldStopLoop: false, stopReason: "" };
}

function buildChainStepContext(markdown) {
  const state = parseGraphStateFields(markdown);
  const chain = parseChainNodeIds(state.chain);
  const stop = evaluateChainLoopStop(state, chain, markdown);
  const visibleIds = state.next ? getChainVisibleNodeIds(chain, state.next) : ["ROOT"];
  const parts = [
    "# LLM Task Graph",
    "",
    "> 链式单步上下文：ROOT + 当前及之前链上节点 + GraphState（含 Next 的 NextIdea）。需要时可读完整 task-tree.md。",
    ""
  ];
  for (const id of visibleIds) {
    const block = extractNodeMarkdown(markdown, id);
    if (block) parts.push(block, "");
  }
  parts.push(buildRedactedGraphStateBlock(state, chain, markdown));
  const stepMarkdown = parts.join("\n").trim();
  const idx = state.next ? chain.indexOf(state.next) : -1;
  const redactedState = {
    ...state,
    nextIdea: getNextNodeNextIdea(markdown, state.next),
    chain: idx >= 0 && chain.length ? `${idx + 1}/${chain.length}` : ""
  };
  delete redactedState.chainForceNext;
  return {
    state: redactedState,
    chainPosition: chain.length && idx >= 0 ? { step: idx + 1, total: chain.length } : null,
    visibleNodeIds: visibleIds,
    stepMarkdown,
    stepContextFile: ".chain-run/step-context.md",
    agentPrompt: buildChainAgentPrompt(state, chain, { redactFuture: true, markdown }),
    shouldStopLoop: stop.shouldStopLoop,
    stopReason: stop.stopReason,
    nextComplete: state.next ? isNodeChainComplete(markdown, state.next) : null
  };
}

/**
 * The live facts the Codex presets are built from. Read fresh on every menu open and every send,
 * because a prompt naming the wrong Next node is worse than no prompt at all.
 */
async function readCodexPromptState() {
  const scope = await readScopeMarkdown("");
  const markdown = scope?.markdown || "";
  const state = parseGraphStateFields(markdown);
  const treeNodes = parseTreeNodeFields(markdown);
  const rootNode = treeNodes.find((node) => node.id === "ROOT") || null;
  const nextNode = treeNodes.find((node) => node.id === state.next) || null;
  const chain = buildChainStepContext(markdown);
  const heading = state.next
    ? extractNodeMarkdown(markdown, state.next).split(/\r?\n/, 1)[0] || ""
    : "";

  return {
    focus: {
      nodeId: state.next,
      title: heading.replace(/^##\s+\S+\s+-\s+/, "").trim(),
      nextIdea: getNextNodeNextIdea(markdown, state.next),
      rootPurpose: rootNode?.fields?.Problem || rootNode?.title || "",
      rootDirection: rootNode?.fields?.Approach || "",
      rootSuccess: rootNode?.fields?.Metrics || "",
      nextProblem: nextNode?.fields?.Problem || "",
      stageSuccess: nextNode?.fields?.Metrics || ""
    },
    chain: {
      agentPrompt: chain.agentPrompt,
      shouldStopLoop: chain.shouldStopLoop,
      stopReason: chain.stopReason,
      position: chain.chainPosition ? `第 ${chain.chainPosition.step}/${chain.chainPosition.total} 步` : ""
    }
  };
}

async function writeChainStepContextFile(markdown, meta = {}) {
  const context = buildChainStepContext(markdown);
  const chainRunDir = path.resolve(projectRoot, ".chain-run");
  await mkdir(chainRunDir, { recursive: true });
  const suffix = meta.subtreePath ? path.basename(String(meta.subtreePath)) : "step-context";
  const fileName = meta.scope === "subtree" ? `step-context-${suffix}` : "step-context.md";
  await writeFile(path.join(chainRunDir, fileName), `${context.stepMarkdown}\n`, "utf8");
  return {
    ...context,
    scope: meta.scope || "main",
    subtreePath: meta.subtreePath || "",
    loopStopCommand: buildLoopStopCommand(context.stopReason, { soft: true }),
    loopStopCommandHard: buildLoopStopCommand(context.stopReason, { soft: false })
  };
}

function buildChainTreeMarkdown(fullMarkdown, nodeIds) {
  const ids = [...new Set((nodeIds || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!ids.length) return fullMarkdown;
  const parts = [
    "# LLM Task Graph",
    "",
    "> 链式执行模式：仅包含当前链路上的节点，不是完整 task-tree.md。",
    ""
  ];
  for (const id of ids) {
    const block = extractNodeMarkdown(fullMarkdown, id);
    if (block) parts.push(block, "");
  }
  const graphState = extractGraphStateMarkdown(fullMarkdown);
  if (graphState) parts.push(graphState);
  return parts.join("\n").trim();
}

function resolveSubtreeFilePath(relativePath) {
  const raw = String(relativePath || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("..")) return null;
  const normalized = raw.replace(/^\/+/, "");
  if (!normalized.startsWith("subtrees/") || !normalized.endsWith(".md")) return null;
  const resolved = path.resolve(projectRoot, normalized);
  const base = path.resolve(subtreesDir);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function parseSubtreeFoldRoot(subtreeMarkdown) {
  const match = String(subtreeMarkdown || "").match(/^>\s*Fold root:\s*(\S+)/m);
  return match ? sanitizeGraphId(match[1]) : "";
}

function findMainTreeStubForSubtree(mainMarkdown, subtreeRelativePath) {
  const normalized = String(subtreeRelativePath || "").trim().replace(/\\/g, "/");
  const lines = String(mainMarkdown || "").split(/\r?\n/);
  let currentId = "";
  for (const line of lines) {
    const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+/);
    if (heading) currentId = heading[1];
    if (currentId && new RegExp(`^-\\s+SubtreeFile:\\s*${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(line.trim())) {
      return currentId;
    }
  }
  return parseSubtreeFoldRoot(mainMarkdown) || "";
}

function compactStubNode(mainMarkdown, nodeId) {
  const block = extractNodeMarkdown(mainMarkdown, nodeId);
  if (!block) return "";
  const title = block.split(/\r?\n/)[0];
  const pick = ["Completion", "AssignedTo", "SubtreeFile", "SubtreeCount", "CurrentResult", "Notes", "Problem"];
  const out = [title];
  for (const field of pick) {
    const value = extractNodeFieldValue(mainMarkdown, nodeId, field);
    if (!value) continue;
    out.push(`- ${field}: ${value.length > 160 ? `${value.slice(0, 160)}…` : value}`);
  }
  return out.join("\n");
}

function buildSubtreeAgentContext(mainMarkdown, subtreeMarkdown, subtreeRelativePath) {
  const foldRoot = parseSubtreeFoldRoot(subtreeMarkdown) || findMainTreeStubForSubtree(mainMarkdown, subtreeRelativePath);
  const workState = parseGraphStateFields(subtreeMarkdown);
  const mapParts = [
    "# Task Map (read-only)",
    "",
    "> 主树摘要：只含 ROOT 与本包 stub，不含其它子树详情。",
    ""
  ];
  const rootBlock = extractNodeMarkdown(mainMarkdown, "ROOT");
  if (rootBlock) mapParts.push(rootBlock, "");
  if (foldRoot) mapParts.push(compactStubNode(mainMarkdown, foldRoot), "");
  const siblingStubs = [];
  for (const line of String(mainMarkdown || "").split(/\r?\n/)) {
    const m = line.match(/^-\s+SubtreeFile:\s*(subtrees\/[^\s]+\.md)/);
    if (m && m[1] !== subtreeRelativePath.replace(/\\/g, "/")) {
      const sid = findMainTreeStubForSubtree(mainMarkdown, m[1]);
      if (sid) siblingStubs.push(compactStubNode(mainMarkdown, sid));
    }
  }
  if (siblingStubs.length) {
    mapParts.push("## 其它并行子树 stub（仅摘要）", "", siblingStubs.join("\n\n"), "");
  }
  const mapMarkdown = mapParts.join("\n").trim();
  const workParts = [
    "# Subtree Work Site",
    "",
    "> 本 Agent 的唯一权威任务文件内容。只改此子树 md 及对应代码。",
    "",
    subtreeMarkdown.trim()
  ];
  const workMarkdown = workParts.join("\n");
  const nextIdea = workState.next ? getNextNodeNextIdea(subtreeMarkdown, workState.next) : "";
  const agentPrompt = [
    "【子树 Worker v2】",
    `FoldRoot: ${foldRoot || "(未知)"}`,
    `SubtreeFile: ${subtreeRelativePath}`,
    `Next: ${workState.next || "(空)"}`,
    `NextIdea: ${nextIdea || "(空)"}`,
    "",
    "读：允许 Read 完整 task-tree.md（折叠后 stub 索引，约 3k token）；禁止 Read 其它 subtrees/*.md。",
    "写：只改本 SubtreeFile + 对应代码；禁止写 task-tree.md 详文；合并仅人操作 UI ⊞ 展开。",
    "可选：POST /api/subtree-file/sync-stub 同步 stub 摘要四字段。",
    "本轮只执行 Next 节点的 NextIdea（下一步思路），不要读 GraphState.NextPlan。"
  ].join("\n");
  return {
    foldRoot,
    subtreeFile: subtreeRelativePath.replace(/\\/g, "/"),
    mapMarkdown,
    workMarkdown,
    agentPrompt,
    graphState: workState,
    siblingStubCount: siblingStubs.length
  };
}

function syncStubFromSubtree(mainMarkdown, subtreeMarkdown, foldRootId) {
  const rootId = foldRootId || parseSubtreeFoldRoot(subtreeMarkdown);
  if (!rootId) return { ok: false, error: "fold root not found" };
  const fields = ["Completion", "CurrentResult", "AssignedTo", "Notes"];
  let updated = mainMarkdown;
  for (const field of fields) {
    const value = extractNodeFieldValue(subtreeMarkdown, rootId, field);
    if (!value) continue;
    const block = extractNodeMarkdown(updated, rootId);
    if (!block) continue;
    const line = `- ${field}: ${value}`;
    const pattern = new RegExp(`(^## ${rootId} - [\\s\\S]*?^-\\s+${field}:\\s*).*$`, "m");
    if (pattern.test(block)) {
      const newBlock = block.replace(fieldLinePattern(field), line);
      updated = updated.replace(block, newBlock);
    }
  }
  return { ok: true, markdown: updated, rootId };
}

function compactModelHistory(history, modelId, nodeId) {
  const turns = Array.isArray(history[modelId]) ? history[modelId] : [];
  return turns
    .filter((item) => !nodeId || item.nodeId === nodeId)
    .slice(-6)
    .map((item) => [
      `Time: ${item.createdAt || ""}`,
      `Node: ${item.nodeId || ""}`,
      `Question: ${item.question || ""}`,
      `Answer: ${String(item.answer || "").slice(0, 4000)}`
    ].join("\n"))
    .join("\n\n---\n\n");
}

function buildModelAgentMessages({ agentPrompt, treeMarkdown, nodeMarkdown, question, historyText, sharedHistoryText, knowledgeContext }) {
  const system = [
    agentPrompt,
    "",
    "独立性规则：你不会看到其它模型本轮的回答，必须独立判断。",
    "页面临时记忆规则：你可以看到本页面里其它模型和用户此前围绕该节点的临时对话，用它理解已经讨论过什么；但这些内容没有写入任务树，不能覆盖当前选中任务树。",
    "共享上下文规则：系统提供的当前选中任务树是权威任务状态。",
    "折叠子树规则：带 Folded/SubtreeFile 的节点表示其子树已移到 subtrees/*.md；默认不要读取那些文件，只把折叠索引当作占位。",
    "输出规则：用中文回答；可以使用简洁 Markdown，但不要输出大段代码块式报告。表格必须用 GitHub 风格 Markdown（表头行 + |---|---| 分隔行 + 数据行），不要用 HTML 表格。",
    "检索工具规则：如果你需要查本地知识库或联网搜索，不要猜。请只输出一个 JSON 对象，不要输出其它文字：",
    "{\"tool\":\"search\",\"query\":\"主题名词 + 技术关键词组成的检索短语\",\"includeWeb\":true,\"topK\":20}",
    "如何写合格的 search.query：",
    "1) 从「当前节点 Problem/Approach」和「用户问题」里提取主题，写成 3-20 词的检索短语；",
    "2) 好例子：「LLM task graph shared markdown memory」「RAG tool retrieval ToolRet benchmark」「multi-agent task orchestration context」；",
    "3) 坏例子：「现在」「当前怎么样」「怎么办」——系统会用用户问题替你改写，但会损失检索质量；",
    "4) 联网 query 应像学术/Google 搜索框里的关键词，不要查时间、词语释义、百科泛词；",
    "5) 若 TOOL_RESULT 出现 query 改写提示，下一轮请直接用改写后的主题短语，不要重复弱 query。",
    "收到 TOOL_RESULT 后，再决定是否继续检索或给最终回答。最多请求 3 次检索。"
  ].join("\n");
  const user = [
    "当前完整任务树：",
    "```markdown",
    treeMarkdown,
    "```",
    "",
    "当前节点：",
    "```markdown",
    nodeMarkdown || "(node not found)",
    "```",
    knowledgeContext ? ["", "系统在你回答前已自动检索并注入以下本地知识库/联网上下文（优先依据它作答；若仍不足可再输出 search JSON 补充检索）：", "```text", knowledgeContext, "```"].join("\n") : "",
    sharedHistoryText ? ["", "页面内其它模型/用户的临时共享上下文：", "```text", sharedHistoryText, "```"].join("\n") : "",
    historyText ? ["", "你在该节点的历史记录：", historyText].join("\n") : "",
    "",
    "用户这次给当前节点的问题：",
    question
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

function normalizeModelConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-10)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 4000)
    }));
}

function parseAgentToolRequest(text) {
  const raw = String(text || "").trim();
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && parsed.tool === "search" && typeof parsed.query === "string" && parsed.query.trim()) {
        return {
          query: parsed.query.trim(),
          includeWeb: parsed.includeWeb !== false,
          topK: Math.max(1, Math.min(RETRIEVAL_MAX_TOP_K, Number(parsed.topK) || RETRIEVAL_DEFAULT_TOP_K))
        };
      }
    } catch {
      // Continue trying less strict candidates.
    }
  }
  return null;
}

function normalizeKnowledgeAskHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-8)
    .map((turn) => ({
      question: String(turn?.question || "").trim().slice(0, 2000),
      answer: String(turn?.answer || "").trim().slice(0, 4000)
    }))
    .filter((turn) => turn.question);
}

function normalizeSharedModelContext(value) {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => item && typeof item.content === "string")
    .slice(-24)
    .map((item) => {
      const model = item.modelName || item.modelId || "unknown";
      const role = item.role === "assistant" ? "模型" : "用户";
      return `[${model}] ${role}: ${item.content.slice(0, 1200)}`;
    })
    .join("\n\n");
}

function modelAgentEndpoint(agent) {
  const wire = String(agent.wireApi || "chat").toLowerCase();
  const isResponses = wire === "responses" || wire === "response";
  return joinUrl(agent.baseUrl, isResponses ? "/responses" : "/chat/completions");
}

function formatModelApiError(error, agent) {
  const endpoint = modelAgentEndpoint(agent);
  const cause = error?.cause;
  const causeBits = [
    cause?.code,
    cause?.message && cause.message !== error?.message ? cause.message : "",
    typeof cause === "string" ? cause : ""
  ].filter(Boolean);
  const causeText = causeBits.length ? causeBits.join(" · ") : "";
  const message = String(error?.message || error || "unknown error");
  if (message === "fetch failed" || /fetch failed/i.test(message)) {
    return [
      `无法连接模型 API：${endpoint}`,
      causeText ? `(${causeText})` : "",
      "请检查 .env 中 MODEL_AGENT_*_BASE_URL、API 服务是否在线、本机网络能否访问该地址。"
    ].filter(Boolean).join(" ");
  }
  if (error?.name === "AbortError" || /timeout/i.test(message)) {
    return `${message}（${endpoint}）`;
  }
  return message;
}

async function probeModelAgent(agent, { timeoutMs = 8000 } = {}) {
  if (!agent.baseUrl) return { ok: false, error: "missing base_url" };
  const endpoint = modelAgentEndpoint(agent);
  const modelsUrl = joinUrl(agent.baseUrl, "/models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = agent.apiKey ? { authorization: `Bearer ${agent.apiKey}` } : {};
  try {
    const modelsResponse = await fetch(modelsUrl, { method: "GET", headers, signal: controller.signal });
    if (modelsResponse.ok) {
      return { ok: true, endpoint, modelsUrl, status: modelsResponse.status };
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, endpoint, modelsUrl, error: `连接超时（>${Math.round(timeoutMs / 1000)}s）` };
    }
    return { ok: false, endpoint, modelsUrl, error: formatModelApiError(error, agent) };
  } finally {
    clearTimeout(timer);
  }

  const chatController = new AbortController();
  const chatTimer = setTimeout(() => chatController.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: agent.model || "probe",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: chatController.signal
    });
    if (response.ok) return { ok: true, endpoint, status: response.status };
    const text = await response.text();
    let detail = text.slice(0, 240);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch {
    }
    return { ok: false, endpoint, status: response.status, error: detail || `HTTP ${response.status}` };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, endpoint, error: `连接超时（>${Math.round(timeoutMs / 1000)}s）` };
    }
    return { ok: false, endpoint, error: formatModelApiError(error, agent) };
  } finally {
    clearTimeout(chatTimer);
  }
}

async function runModelAgentWithTools({ agent, agentPrompt, treeMarkdown, nodeMarkdown, question, history, sharedHistory, enableTools, includeWeb, providedKnowledgeContext }) {
  const toolEvents = [];
  const messages = buildModelAgentMessages({
    agentPrompt,
    treeMarkdown,
    nodeMarkdown,
    question,
    historyText: "",
    sharedHistoryText: normalizeSharedModelContext(sharedHistory),
    knowledgeContext: providedKnowledgeContext
  });
  const priorTurns = normalizeModelConversation(history);
  if (priorTurns.length) {
    messages.push({
      role: "user",
      content: [
        "以下是你和用户在该节点的临时会话历史，仅用于本轮连续对话；它没有写入任务树：",
        "```text",
        priorTurns.map((turn) => `${turn.role === "user" ? "用户" : "你"}：${turn.content}`).join("\n\n"),
        "```"
      ].join("\n")
    });
  }
  messages.push({ role: "user", content: question });

  let answer = "";
  for (let step = 0; step < 4; step += 1) {
    answer = await callOpenAICompatible(agent, messages);
    const request = enableTools && step < 3 ? parseAgentToolRequest(answer) : null;
    if (!request) break;
    let search;
    try {
      search = await searchRetrieval(request.query, {
        topK: request.topK,
        includeKnowledge: true,
        includeWeb: includeWeb && request.includeWeb,
        contextHint: [question, nodeMarkdown].filter(Boolean).join("\n\n"),
        nodeMarkdown,
        useLlmQuery: true
      });
    } catch (error) {
      search = { results: [], errors: [error.message] };
    }
    toolEvents.push({
      query: request.query,
      refinedQuery: search.webQuery || search.refinedQuery,
      rewriteSource: search.rewriteSource,
      llmQueries: search.llmQueries,
      queryWasWeak: search.queryWasWeak,
      includeWeb: includeWeb && request.includeWeb,
      resultCount: search.results.length,
      errors: search.errors || []
    });
    messages.push({ role: "assistant", content: answer });
    messages.push({
      role: "user",
      content: [
        "TOOL_RESULT search",
        `query_requested: ${request.query}`,
        search.webQuery && search.webQuery !== request.query ? `query_executed: ${search.webQuery}` : `query_executed: ${search.refinedQuery || request.query}`,
        search.rewriteSource === "llm" ? "search_hint: 系统已用大模型从用户问题提取检索关键词作为 query_executed。" : "",
        search.queryWasWeak ? "search_hint: 你上轮的 query 过短或只有时间/指代词，系统已用「用户问题 + 当前节点 Problem/Approach」改写成 query_executed。下轮请直接在 search JSON 里写 query_executed 这类主题短语。" : "",
        search.errors?.length ? `errors: ${search.errors.join("; ")}` : "",
        "```text",
        buildKnowledgeContext(search.results || []),
        "```",
        "请基于这些结果继续。如果还需要检索，可以再次只输出 search JSON；否则给出最终中文回答。"
      ].filter(Boolean).join("\n")
    });
  }
  return { answer, toolEvents };
}

async function callOpenAICompatible(agent, messages) {
  if (!agent.apiKey) throw new Error("missing api_key");
  if (!agent.model) throw new Error("missing model");
  if (!agent.baseUrl) throw new Error("missing base_url");
  const controller = new AbortController();
  const timeoutMs = Math.max(30000, Number(process.env.MODEL_AGENT_TIMEOUT_MS) || 180000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = modelAgentEndpoint(agent);
    const wire = String(agent.wireApi || "chat").toLowerCase();
    const isResponses = wire === "responses" || wire === "response";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${agent.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(isResponses ? {
        model: agent.model,
        input: messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
        max_output_tokens: 1800
      } : {
        model: agent.model,
        messages,
        temperature: 0.7,
        max_tokens: 1800
      }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`non-json response: ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(data.error?.message || text.slice(0, 1000));
    }
    let answer = "";
    if (isResponses) {
      if (typeof data.output_text === "string") answer = data.output_text.trim();
      else {
        const chunks = [];
        for (const item of data.output || []) {
          for (const content of item.content || []) {
            if (typeof content.text === "string") chunks.push(content.text);
          }
        }
        answer = chunks.join("\n").trim();
      }
    } else {
      answer = String(data.choices?.[0]?.message?.content || "").trim();
    }
    if (!answer) throw new Error("model returned empty content");
    return answer;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`model API timeout after ${Math.round(timeoutMs / 1000)}s（${modelAgentEndpoint(agent)}）`);
    }
    throw new Error(formatModelApiError(error, agent));
  } finally {
    clearTimeout(timeout);
  }
}

function safeReason(reason) {
  return String(reason || "将自动保存图谱修改")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 80) || "将自动保存图谱修改";
}

function registeredTreeVersionsDir(tree = activeTreeEntry) {
  return tree?.path === "task-tree.md" ? versionsDir : path.join(versionsDir, "trees", tree?.id || "method");
}

async function backupTree(reason, tree = activeTreeEntry, filePath = resolveTreeFile(projectRoot, tree)) {
  const dir = registeredTreeVersionsDir(tree);
  await mkdir(dir, { recursive: true });
  if (!existsSync(filePath)) return null;
  const name = `${timestamp()}_${safeReason(reason)}.md`;
  await copyFile(filePath, path.join(dir, name));
  return name;
}

function subtreeVersionKey(relPath) {
  return String(relPath || "").trim().replace(/\\/g, "/").replace(/^subtrees\//, "").replace(/\.md$/, "") || "subtree";
}

function subtreeVersionsDir(relPath) {
  return path.join(versionsDir, "subtrees", subtreeVersionKey(relPath));
}

async function backupSubtreeFile(relPath, reason) {
  const filePath = resolveSubtreeFilePath(relPath);
  if (!filePath || !existsSync(filePath)) return null;
  const dir = subtreeVersionsDir(relPath);
  await mkdir(dir, { recursive: true });
  const name = `${timestamp()}_${safeReason(reason)}.md`;
  await copyFile(filePath, path.join(dir, name));
  return name;
}

async function listSubtreeVersions(relPath) {
  const dir = subtreeVersionsDir(relPath);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  const items = await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(dir, name));
    const match = name.match(/^(\d{8}-\d{6})_(.*)\.md$/);
    return {
      name,
      reason: match ? match[2] : name.replace(/\.md$/, ""),
      createdAt: match ? match[1] : "",
      mtimeMs: info.mtimeMs,
      isCurrent: false
    };
  }));
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

async function readScopeMarkdown(subtreeRel) {
  const rel = String(subtreeRel || "").trim().replace(/\\/g, "/");
  if (rel) {
    const filePath = resolveSubtreeFilePath(rel);
    if (!filePath || !existsSync(filePath)) return null;
    return {
      markdown: await readFile(filePath, "utf8"),
      filePath,
      scope: "subtree",
      rel: path.relative(projectRoot, filePath).replace(/\\/g, "/")
    };
  }
  return {
    markdown: existsSync(treeFile) ? await readFile(treeFile, "utf8") : "",
    filePath: treeFile,
    scope: "main",
    rel: path.basename(treeFile)
  };
}

function buildLoopStopCommand(reason, { soft = true } = {}) {
  if (process.platform !== "win32") return "在当前 Agent 中停止 /loop（Linux/macOS 不需要关闭 IDE 进程）";
  const kitScript = "llm-task-tree-kit/scripts/chain-loop-stop.ps1";
  const escaped = String(reason || "链式执行结束").replace(/"/g, '`"');
  if (soft) {
    return `powershell -File ${kitScript} -SoftOnly -Reason "${escaped}"`;
  }
  return `powershell -File ${kitScript} -Hard -Reason "${escaped}"`;
}

function currentVersionFilePath(tree = activeTreeEntry) {
  return path.join(registeredTreeVersionsDir(tree), CURRENT_VERSION_NAME);
}

async function writeCurrentVersion(markdown, tree = activeTreeEntry) {
  if (typeof markdown !== "string") return;
  await mkdir(registeredTreeVersionsDir(tree), { recursive: true });
  await writeFile(currentVersionFilePath(tree), markdown, "utf8");
}

async function readCurrentVersionEntry(tree = activeTreeEntry) {
  const filePath = currentVersionFilePath(tree);
  if (!existsSync(filePath)) return null;
  const info = await stat(filePath);
  return {
    name: CURRENT_VERSION_NAME,
    reason: "当前版本",
    createdAt: "",
    mtimeMs: info.mtimeMs,
    isCurrent: true
  };
}

async function listVersions(tree = activeTreeEntry) {
  const dir = registeredTreeVersionsDir(tree);
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md") && name !== CURRENT_VERSION_NAME);
  const items = await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(dir, name));
    const match = name.match(/^(\d{8}-\d{6})_(.*)\.md$/);
    return {
      name,
      reason: match ? match[2] : name.replace(/\.md$/, ""),
      createdAt: match ? match[1] : "",
      mtimeMs: info.mtimeMs,
      isCurrent: false
    };
  }));
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const current = await readCurrentVersionEntry(tree);
  if (current) items.unshift(current);
  return items;
}

async function walkFiles(root, fileName) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath, fileName));
    else if (entry.isFile() && entry.name === fileName) files.push(fullPath);
  }
  return files;
}

function extractSkillDescription(text) {
  const match = text.match(/^description:\s*([\s\S]+?)(\r?\n[a-zA-Z_-]+:|\r?\n---|\r?\n# )/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ") : "";
}

function extractSkillName(text, filePath) {
  const match = text.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : path.basename(path.dirname(filePath));
}

const EXACT_SKILL_CN = {
  diagnose: "诊断复杂 bug/性能问题：复现、缩小范围、假设验证、修复与回归。",
  "diagnosing-bugs": "诊断复杂 bug/性能问题：复现、缩小范围、假设验证、修复与回归。",
  tdd: "测试驱动开发：先写失败测试，再最小实现，最后重构。",
  "grill-me": "动手前追问澄清：目标、边界、约束与风险。",
  "grill-with-docs": "追问澄清计划，并沉淀术语与决策文档。",
  handoff: "把当前上下文压成交接文档，供下轮会话继续。",
  "to-prd": "把讨论整理成 PRD/规格文档，便于拆分执行。",
  "to-issues": "把计划拆成可执行 issue，或分诊排序问题。",
  prototype: "快速做可丢弃原型，验证交互与实现路径。",
  "find-skills": "按任务目标搜索、推荐或安装 agent skills。",
  "write-a-skill": "把可复用工作流写成新 skill。",
  "skill-creator": "创建、修改并评测 agent skill，优化内容与触发准确率。",
  "skill-installer": "从官方清单或指定 GitHub 仓库安装 Codex skill。",
  autoskill: "分析本机 screenpipe 工作轨迹，发现重复科研流程并起草新 skill。",
  "ask-matt": "在现有工程 skills 中选择合适入口，并给出从想法到交付的调用顺序。",
  "task-tree-grill": "访谈式建树/修树：生成 task-tree 节点、边与 GraphState。",
  "task-tree-chain-run": "按执行链单步跑 Codex/Cursor loop（chain-step + NextIdea）。",
  vllm: "vLLM 生产推理：PagedAttention、连续批处理、OpenAI API、量化与张量并行。",
  "serving-llms-vllm": "vLLM 生产推理：PagedAttention、连续批处理、OpenAI API、量化与张量并行。",
  sglang: "SGLang 推理：RadixAttention 前缀缓存、结构化/JSON 解码、agent 前缀共享。",
  "tensorrt-llm": "TensorRT-LLM：NVIDIA 栈上的低延迟推理与编译优化。",
  "llama-cpp": "llama.cpp 本地 CPU/GPU 推理与 GGUF 模型加载。",
  peft: "PEFT 参数高效微调：LoRA/适配器，少显存微调大模型。",
  "trl-fine-tuning": "TRL 微调：SFT/DPO/PPO 等 HuggingFace 训练循环。",
  unsloth: "Unsloth 加速微调：更快 LoRA/SFT，省显存。",
  verl: "verl 分布式 RLHF/GRPO 训练框架（Ray + vLLM）。",
  "grpo-rl-training": "GRPO 强化学习训练：组相对策略优化。",
  openrlhf: "OpenRLHF：开源 RLHF/PPO/DPO 训练管线。",
  axolotl: "Axolotl 统一 YAML 配置微调多种开源模型。",
  "llama-factory": "LLaMA-Factory 一站式微调、评测与导出。",
  litgpt: "LitGPT 轻量训练/微调 GPT 类模型。",
  deepspeed: "DeepSpeed 分布式训练与 ZeRO 显存优化。",
  accelerate: "HuggingFace Accelerate 简化多卡/混合精度训练。",
  "pytorch-fsdp2": "PyTorch FSDP2 全分片数据并行大模型训练。",
  "pytorch-lightning": "PyTorch Lightning 结构化训练循环与日志。",
  "megatron-core": "Megatron-Core 大规模 Transformer 并行训练。",
  "moe-training": "MoE 混合专家模型训练与路由策略。",
  "flash-attention": "FlashAttention 加速注意力，降显存提吞吐。",
  bitsandbytes: "bitsandbytes 8bit/4bit 量化训练与推理。",
  awq: "AWQ 激活感知权重量化，加速推理。",
  gptq: "GPTQ 权重量化压缩，适合边缘部署。",
  gguf: "GGUF 格式转换与 llama.cpp 生态量化。",
  hqq: "HQQ 半二次量化，低比特推理。",
  "model-merging": "合并多个微调权重（SLERP/TIES 等）。",
  "model-pruning": "结构化/非结构化剪枝减参数。",
  "knowledge-distillation": "知识蒸馏：小模型学大模型。",
  chroma: "Chroma 嵌入式向量库与本地 RAG。",
  faiss: "FAISS 高效向量相似度检索。",
  qdrant: "Qdrant 向量数据库与过滤检索。",
  pinecone: "Pinecone 托管向量索引与语义检索。",
  langchain: "LangChain 链式调用、工具与 RAG 编排。",
  llamaindex: "LlamaIndex 数据索引与 RAG 管线。",
  crewai: "CrewAI 多角色 agent 协作编排。",
  autogpt: "AutoGPT 自主 agent 任务循环。",
  dspy: "DSPy 声明式 prompt/模块优化与评测。",
  outlines: "Outlines 结构化生成：JSON/regex/grammar 约束解码。",
  guidance: "Guidance 模板化约束生成与 token 级控制。",
  instructor: "Instructor 结构化输出（Pydantic）与 LLM 解析。",
  "mcp-builder": "构建 MCP 服务器，把工具暴露给 agent。",
  "literature-review": "多视角对话式文献综述与证据综合。",
  "literature-search-arxiv": "arXiv/学术文献检索与元数据整理。",
  "citation-management": "引用管理、BibTeX 与文献库整理。",
  "ml-paper-writing": "机器学习论文结构与段落写作。",
  "systems-paper-writing": "系统类论文写作与实验叙事。",
  "academic-plotting": "学术论文配图：matplotlib/seaborn 规范图。",
  "brainstorming-research-ideas": "研究选题 brainstorm 与方向发散。",
  "creative-thinking-for-research": "研究创意与问题重构方法。",
  "experiment-design": "实验设计、对照与变量控制。",
  triage: "问题分诊：归类、优先级与下一步行动。",
  "improve-codebase-architecture": "改进模块边界、领域模型与代码结构。",
  "ai-research-reproduction": "复现论文/开源实现的步骤与验证。",
  "ai-research-explore": "探索新研究方向与基线对比。",
  docx: "读写编辑 Word docx 文档。",
  pptx: "制作与修改 PPT/幻灯片。",
  xlsx: "Excel 表格读写、公式与多 sheet。",
  pdf: "PDF 解析、提取与批注。",
  "frontend-design": "高质感前端界面与交互设计实现。",
  "web-artifacts-builder": "构建可交付的 Web 小组件/artifact。",
  modal: "Modal 云函数/GPU 无服务器部署。",
  skypilot: "SkyPilot 多云 GPU 任务调度。",
  mlflow: "MLflow 实验跟踪、模型注册与对比。",
  tensorboard: "TensorBoard 训练曲线与可视化。",
  "weights-and-biases": "W&B 实验日志、超参与 artifact。",
  swanlab: "SwanLab 训练监控与实验管理。",
  nanogpt: "nanoGPT 极简 GPT 训练教学代码。",
  torchtitan: "TorchTitan Meta 官方大模型训练栈。",
  "lm-evaluation-harness": "Eleuther 评测 harness：多 benchmark 测模型。",
  "bigcode-evaluation-harness": "代码模型评测（HumanEval 等）。",
  "nemo-evaluator": "NVIDIA NeMo 模型评测套件。",
  llamaguard: "LlamaGuard 内容安全分类与护栏。",
  "prompt-guard": "Prompt 注入/越狱检测与防护。",
  "nemo-guardrails": "NeMo Guardrails 对话流程与安全轨。",
  whisper: "Whisper 语音转文字与多语言 ASR。",
  "stable-diffusion": "Stable Diffusion 文生图/图生图。",
  llava: "LLaVA 多模态图文理解与对话。",
  "segment-anything": "SAM 图像分割与 mask 生成。",
  clip: "CLIP 图文嵌入与零样本分类。",
  "sentence-transformers": "句子 embedding 与语义相似度。",
  saelens: "SAE 稀疏自编码器可解释性分析。",
  pyvene: "pyvene 模型干预与因果分析。",
  "transformer-lens": "TransformerLens 激活/注意力探查。",
  nnsight: "nnsight 神经网络内部追踪与编辑。",
  "long-context": "长上下文扩展：位置插值/窗口技巧。",
  rwkv: "RWKV 线性注意力 RNN 式 LLM。",
  mamba: "Mamba 状态空间模型训练与推理。",
  ray: "Ray Data 分布式数据预处理。",
  "ray-train": "Ray Train 分布式训练编排。",
  slime: "Slime RL 训练框架（若已安装）。",
  miles: "Miles 相关 agent/训练工具（按 SKILL 专项）。",
  openpi: "OpenPI 策略/机器人相关（按 SKILL 专项）。",
  "openvla-oft": "OpenVLA 视觉-语言-动作模型微调。",
  cosmos: "Cosmos 相关（按 SKILL 专项）。",
  "cosmos-policy": "Cosmos 策略模型训练/推理专项。",
  "0-autoresearch-skill": "自动研究循环：假设→实验→记录。",
  "a-evolve": "进化式搜索改进方案或代码。",
  "doc-coauthoring": "与人协作共写文档（分段审稿式）。",
  "internal-comms": "内部沟通稿：周报、通报、FAQ。",
  "presenting-conference-talks": "学术报告结构与演讲稿。",
  "latex-thesis-zh": "中文 LaTeX 学位论文排版。",
  caveman: "极简/debug 式问题排查风格 skill。",
  grill: "追问式澄清（grill 系列）。"
};

const EXACT_SKILL_HIGHLIGHT_CN = {
  "find-skills": "亮点：先搜索可用能力，再决定安装；适合本机还没有目标 skill。",
  "write-a-skill": "亮点：把已有工作流直接整理成可复用 skill，侧重编写规范。",
  "skill-creator": "亮点：包含有/无 skill 对照评测、迭代改写和触发描述优化。",
  "skill-installer": "亮点：支持官方精选、实验目录和指定 GitHub 路径（含私有仓库）。",
  autoskill: "亮点：依据真实操作历史发现重复流程；需本机已运行 screenpipe，并由用户显式触发。",
  "ask-matt": "亮点：它是工程工作流路由器，不负责安装或编写 skill。",
  "task-tree-grill": "亮点：直接生成可落盘的节点、边和 Current/Next 状态，不只是给文字建议。",
  "task-tree-chain-run": "亮点：一次只推进执行链的一步，适合受控连续运行。"
};

const NAME_PATTERN_CN = [
  { test: (n) => /vllm|pagedattention/i.test(n), text: "vLLM 在线推理：连续批处理、KV 缓存优化、OpenAI 兼容端点。" },
  { test: (n) => /^sglang$/i.test(n), text: "SGLang：RadixAttention 前缀缓存与结构化解码 serving。" },
  { test: (n) => /tensorrt/i.test(n), text: "TensorRT 系列：NVIDIA 推理编译与低延迟部署。" },
  { test: (n) => /llama\.?cpp|gguf/i.test(n), text: "本地 GGUF/llama.cpp 推理与量化加载。" },
  { test: (n) => /fine.?tun|lora|peft|sft|dpo|ppo|rlhf|grpo/i.test(n), text: "大模型微调或强化学习对齐训练。" },
  { test: (n) => /quant|gguf|gptq|awq|fp8|int8|int4/i.test(n), text: "模型量化压缩与低比特推理部署。" },
  { test: (n) => /rag|retriev|embed|vector|faiss|chroma|qdrant|pinecone/i.test(n), text: "RAG/向量检索与知识库构建。" },
  { test: (n) => /agent|crew|langchain|llamaindex|autogpt/i.test(n), text: "Agent 编排、工具调用或多 agent 协作。" },
  { test: (n) => /literature|citation|arxiv|paper|scholar/i.test(n), text: "文献检索、引用或论文写作辅助。" },
  { test: (n) => /stat|regression|survival|power analysis/i.test(n), text: "统计分析、假设检验或样本量计算。" },
  { test: (n) => /plot|matplotlib|seaborn|visual/i.test(n), text: "科研绘图与可视化出图。" },
  { test: (n) => /train|deepspeed|fsdp|megatron|moe/i.test(n), text: "大规模或分布式模型训练工程。" },
  { test: (n) => /eval|benchmark|harness/i.test(n), text: "模型评测 benchmark 与指标对比。" },
  { test: (n) => /guard|safety|jailbreak/i.test(n), text: "模型安全、护栏或内容审核。" },
  { test: (n) => /docx|pptx|xlsx|pdf|word|slides/i.test(n), text: "办公文档（Word/PPT/Excel/PDF）处理。" },
  { test: (n) => /task-tree/i.test(n), text: "任务图 task-tree 协作与节点推进。" },
  { test: (n) => /skill/i.test(n), text: "Skill 编写、路由或发现。" },
  { test: (n) => /bio|genomic|protein|chem|drug|rdkit/i.test(n), text: "生物信息/化学信息学专项流程。" },
  { test: (n) => /speech|whisper|audio|tts/i.test(n), text: "语音/音频处理与转写。" },
  { test: (n) => /diffusion|image|vision|vlm|llava/i.test(n), text: "图像/多模态生成或理解。" }
];

function inferChineseSkillSummary(name, description) {
  const text = String(description || "").toLowerCase();
  const bits = [];
  const lexicon = [
    { re: /pagedattention|continuous batching/, cn: "连续批处理" },
    { re: /prefix caching|radixattention/, cn: "前缀缓存" },
    { re: /structured (generation|output|decoding)|constrained decoding/, cn: "结构化解码" },
    { re: /openai[- ]compatible|openai api/, cn: "OpenAI 兼容 API" },
    { re: /fine-tun|lora|adapter/, cn: "微调/LoRA" },
    { re: /quantiz|gguf|gptq|awq|fp8|int8/, cn: "量化部署" },
    { re: /tensor parallel/, cn: "张量并行" },
    { re: /multi-agent|agentic/, cn: "Agent 工作流" },
    { re: /function calling|tool call/, cn: "工具调用" },
    { re: /retrieval augmented|rag/, cn: "RAG" },
    { re: /vector (database|store)|embedding search/, cn: "向量检索" },
    { re: /literature review|survey paper/, cn: "文献综述" },
    { re: /hypothesis test|regression|statistical/, cn: "统计分析" },
    { re: /distributed training|multi-gpu/, cn: "分布式训练" },
    { re: /low latency|throughput/, cn: "低延迟/高吞吐" },
    { re: /json schema|regex output/, cn: "JSON/正则约束输出" }
  ];
  for (const { re, cn } of lexicon) {
    if (re.test(text) && !bits.includes(cn)) bits.push(cn);
    if (bits.length >= 4) break;
  }
  const label = String(name || "skill").replace(/^serving-llms-/, "");
  if (bits.length) return `「${label}」：${bits.join("、")}。`;
  const topic = label
    .replace(/literature|paper|citation/gi, "文献")
    .replace(/research/gi, "研究")
    .replace(/review/gi, "审查")
    .replace(/search|lookup|find/gi, "检索")
    .replace(/writing|writer/gi, "写作")
    .replace(/install|installer/gi, "安装")
    .replace(/skill/gi, "能力")
    .replace(/agent/gi, "智能体")
    .replace(/[-_]+/g, " ")
    .trim();
  return `用于${topic || label}任务，提供针对性的执行步骤与检查项。`;
}

function toChineseSkillSummary(name, description, folder = "") {
  const keys = [name, folder].filter(Boolean);
  for (const key of keys) {
    if (EXACT_SKILL_CN[key]) return EXACT_SKILL_CN[key];
    const lower = key.toLowerCase();
    if (EXACT_SKILL_CN[lower]) return EXACT_SKILL_CN[lower];
  }
  for (const rule of NAME_PATTERN_CN) {
    for (const key of keys) {
      if (rule.test(key)) return rule.text;
    }
  }
  return inferChineseSkillSummary(name || folder, description);
}

function toChineseSkillHighlight(name, description, functionText) {
  const key = String(name || "").toLowerCase();
  if (EXACT_SKILL_HIGHLIGHT_CN[key]) return EXACT_SKILL_HIGHLIGHT_CN[key];
  const text = String(description || "").toLowerCase();
  if (/screenpipe/.test(text)) return "亮点：从本机操作轨迹提炼真实重复流程；需要 screenpipe。";
  if (/github repo|curated list/.test(text) && /install/.test(text)) return "亮点：可从清单或 GitHub 路径直接安装，适合补齐缺失能力。";
  if (/benchmark|eval|test prompt/.test(text)) return "亮点：带测试与效果对比，适合需要验证质量的任务。";
  if (/multi-agent|agentic/.test(text)) return "亮点：侧重多智能体分工、交接或协同执行。";
  if (/local|offline|privacy/.test(text)) return "亮点：强调本地执行或隐私边界。";
  const topic = String(functionText || "").replace(/[。；].*$/, "").slice(0, 48);
  return `亮点：聚焦${topic || name}，只在当前任务明确相关时启用。`;
}

function publicSkillPayload(skill) {
  return {
    id: skill.id,
    name: skill.name,
    functionText: skill.functionText,
    highlightText: skill.highlightText,
    matchText: skill.matchText || "",
    source: skill.repo || "",
    score: skill.score || 0
  };
}

async function loadSkillIndex() {
  if (skillIndexCache) return skillIndexCache;
  const roots = [
    { repo: "project", root: path.join(projectRoot, "skills") },
    { repo: "kit", root: path.join(kitDir, "skills") },
    { repo: "codex", root: path.join(homeDir, ".codex", "skills") },
    { repo: "agents", root: path.join(homeDir, ".agents", "skills") },
    { repo: "orchestra", root: path.join(homeDir, ".orchestra", "skills") }
  ].filter((item) => item.root && existsSync(item.root));
  const skills = [];
  for (const item of roots) {
    const files = await walkFiles(item.root, "SKILL.md");
    for (const filePath of files) {
      const text = await readFile(filePath, "utf8");
      const name = extractSkillName(text, filePath);
      const description = extractSkillDescription(text);
      if (!description) continue;
      const folder = path.basename(path.dirname(filePath));
      skills.push({
        id: `${item.repo}:${name}`,
        repo: item.repo,
        name,
        path: filePath,
        description,
        functionText: toChineseSkillSummary(name, description, folder),
        highlightText: toChineseSkillHighlight(name, description, toChineseSkillSummary(name, description, folder))
      });
    }
  }
  skillIndexCache = skills.sort((a, b) => a.name.localeCompare(b.name));
  return skillIndexCache;
}

function tokenize(value) {
  const stopWords = new Set([
    "skill", "skills", "agent", "agents",
    "能力", "技能", "当前", "任务", "节点", "选择", "筛选", "推荐"
  ]);
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !stopWords.has(word));
}

function scoreSkill(skill, queryTokens, queryText) {
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 3 : 1;
  }
  if (queryText.includes(skill.name.toLowerCase())) score += 20;
  if (skill.name === "ask-matt" || skill.name === "autoskill") score += 2;
  score += intentBoost(skill.name, queryText);
  return score;
}

function preferredSkillCopy(current, candidate) {
  if (!current) return candidate;
  const repoRank = { project: 0, kit: 1, codex: 2, agents: 3, orchestra: 4 };
  const currentSystem = /[\\/]\.system[\\/]/i.test(current.path || "") ? 1 : 0;
  const candidateSystem = /[\\/]\.system[\\/]/i.test(candidate.path || "") ? 1 : 0;
  if (currentSystem !== candidateSystem) return candidateSystem < currentSystem ? candidate : current;
  const currentRank = repoRank[current.repo] ?? 99;
  const candidateRank = repoRank[candidate.repo] ?? 99;
  if (candidateRank !== currentRank) return candidateRank < currentRank ? candidate : current;
  return String(candidate.path || "").length < String(current.path || "").length ? candidate : current;
}

function dedupeSkillsByIdentity(skills) {
  const byName = new Map();
  for (const skill of skills) {
    const key = String(skill.name || "").trim().toLowerCase();
    byName.set(key, preferredSkillCopy(byName.get(key), skill));
  }
  return [...byName.values()];
}

function dedupeSkillsByDescription(skills) {
  const seen = new Set();
  return skills.filter((skill) => {
    const key = String(skill.functionText || "").replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skillMatchText(skill, queryTokens, queryText) {
  const name = String(skill.name || "").toLowerCase();
  if (name === "ask-matt" && /选择|筛选|推荐|路由|哪个|which|route/.test(queryText)) {
    return "匹配当前任务：先判断应该调用哪个 skill";
  }
  if (name === "find-skills" && /搜索|查找|发现|安装|search|find|install/.test(queryText)) {
    return "匹配当前任务：搜索或补齐可用 skill";
  }
  if (["skill-creator", "write-a-skill"].includes(name) && /编写|创建|修改|描述|亮点|评测|write|create|edit|description|eval/.test(queryText)) {
    return "匹配当前任务：改进 skill 内容、说明或触发";
  }
  if (name === "skill-installer" && /安装|install|github|仓库/.test(queryText)) {
    return "匹配当前任务：从清单或仓库安装 skill";
  }
  if (name === "autoskill" && /screenpipe|工作轨迹|操作历史|重复流程|recent work/.test(queryText)) {
    return "匹配当前任务：从真实操作历史发现新 skill";
  }
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  const matched = [...new Set(queryTokens.filter((token) =>
    token.length <= 18 && haystack.includes(token)
  ))].slice(0, 3);
  if (matched.length) return `匹配节点关键词：${matched.join("、")}`;
  if (/skill|skills|技能|能力|路由|筛选/.test(queryText)) return "匹配当前任务：skill 筛选、路由或维护";
  if (/任务树|任务图|task-tree/.test(queryText)) return "匹配当前任务：任务图维护与推进";
  if (/bug|debug|报错|失败|修复/.test(queryText)) return "匹配当前任务：诊断与修复";
  if (/论文|文献|paper|research/.test(queryText)) return "匹配当前任务：科研与文献处理";
  return "与当前节点目标最接近";
}

function intentBoost(name, queryText) {
  const rules = [
    { names: ["diagnose", "diagnosing-bugs"], patterns: [/bug|debug|fail|error|broken|slow|regression|调试|报错|失败|定位|修复|没反应|性能/], boost: 25 },
    { names: ["tdd"], patterns: [/test|spec|coverage|测试|验证|回归/], boost: 18 },
    { names: ["grill-with-docs", "grilling", "grill-me"], patterns: [/需求|澄清|计划|设计|不确定|追问|讨论|对齐|grill/], boost: 16 },
    { names: ["to-prd"], patterns: [/prd|需求文档|产品文档|规格|specification/], boost: 18 },
    { names: ["to-issues"], patterns: [/issue|ticket|拆分|任务拆解|工单/], boost: 18 },
    { names: ["implement"], patterns: [/实现|编码|开发|落地|execute|implement/], boost: 15 },
    { names: ["review"], patterns: [/review|审查|代码审查|检查变更/], boost: 18 },
    { names: ["prototype"], patterns: [/原型|prototype|试做|探索界面|交互方案/], boost: 18 },
    { names: ["domain-modeling", "codebase-design"], patterns: [/领域|术语|架构|模块|接口|边界|重构|domain|architecture/], boost: 16 },
    { names: ["ask-matt"], patterns: [/选择.*skill|筛选.*skill|推荐.*skill|哪个.*skill|技能.*路由|能力.*路由|自动调用|route.*skill/], boost: 32 },
    { names: ["find-skills"], patterns: [/搜索.*skill|查找.*skill|发现.*skill|安装.*skill|search.*skill|find.*skill/], boost: 22 },
    { names: ["skill-creator", "write-a-skill"], patterns: [/编写.*skill|创建.*skill|修改.*skill|skill.*描述|skill.*亮点|skill.*评测|write.*skill|create.*skill|skill.*description|skill.*eval/], boost: 26 },
    { names: ["skill-installer"], patterns: [/安装.*skill|install.*skill|github.*skill|skill.*仓库/], boost: 30 },
    { names: ["autoskill"], patterns: [/screenpipe|工作轨迹|操作历史|重复.*流程|recent work|workflow history/], boost: 34 },
    { names: ["task-tree-grill"], patterns: [/task-tree|任务树|任务图|建树|初始树|建立.*树|一开始.*树|current|nextplan/], boost: 35 },
    { names: ["literature-review", "research-lookup", "paper-lookup"], patterns: [/论文|文献|research|paper|sota|综述/], boost: 20 },
    { names: ["scientific-writing"], patterns: [/论文写作|scientific writing|manuscript|imrad/], boost: 20 },
    { names: ["statistical-analysis", "statistical-power"], patterns: [/统计|显著性|样本量|power|p值|回归分析/], boost: 20 }
  ];
  return rules.reduce((sum, rule) => {
    if (!rule.names.includes(name)) return sum;
    return sum + (rule.patterns.some((pattern) => pattern.test(queryText)) ? rule.boost : 0);
  }, 0);
}

async function recommendSkills(body) {
  const allSkills = await loadSkillIndex();
  const skillsById = new Map(allSkills.map((skill) => [skill.id, skill]));
  const skills = dedupeSkillsByIdentity(allSkills);
  const queryText = [
    body?.nextPlan,
    body?.nextIdea,
    body?.node?.title,
    body?.node?.problem,
    body?.node?.approach,
    body?.node?.metrics,
    body?.node?.notes
  ].filter(Boolean).join("\n").toLowerCase();
  const queryTokens = tokenize(queryText);
  let scored = skills
    .map((skill) => ({
      ...skill,
      score: scoreSkill(skill, queryTokens, queryText),
      matchText: skillMatchText(skill, queryTokens, queryText)
    }))
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const topScore = scored[0]?.score || 0;
  if (topScore >= 10) scored = scored.filter((skill) => skill.score >= Math.max(5, Math.floor(topScore * 0.3)));
  scored = dedupeSkillsByDescription(scored).slice(0, 8);

  if (!scored.length) {
    scored = skills
      .filter((skill) => ["ask-matt", "grill-with-docs", "grilling", "autoskill", "scientific-critical-thinking"].includes(skill.name))
      .map((skill) => ({ ...skill, score: 0, matchText: "通用候选：节点信息不足时用于进一步澄清或路由" }));
    scored = dedupeSkillsByDescription(scored).slice(0, 6);
  }

  const selectedIds = String(body?.selectedSkills || "")
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const result = [];
  const seen = new Set();
  const seenNames = new Set();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    const skill = skillsById.get(id);
    const name = skill?.name || (id.includes(":") ? id.split(":").slice(1).join(":") : id);
    const nameKey = String(name).toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seen.add(id);
    seenNames.add(nameKey);
    result.push(skill ? publicSkillPayload({ ...skill, score: skill.score || 0, matchText: "当前节点已选择" }) : publicSkillPayload({
      id,
      name,
      functionText: toChineseSkillSummary(name, ""),
      highlightText: toChineseSkillHighlight(name, "", ""),
      matchText: "当前节点已选择",
      score: 0
    }));
  }
  for (const skill of scored) {
    const nameKey = String(skill.name || "").toLowerCase();
    if (seen.has(skill.id) || seenNames.has(nameKey)) continue;
    seen.add(skill.id);
    seenNames.add(nameKey);
    result.push(publicSkillPayload(skill));
  }
  return result.slice(0, 16);
}

function safeVersionPath(name, tree = activeTreeEntry) {
  const base = path.basename(String(name || ""));
  if (!base.endsWith(".md")) return null;
  const dir = registeredTreeVersionsDir(tree);
  const filePath = path.resolve(dir, base);
  const root = path.resolve(dir);
  if (!filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

function safeWorkspaceFilePath(value) {
  const raw = decodeURIComponent(String(value || "").trim());
  if (!raw) return null;
  const normalized = raw.replace(/\//g, path.sep);
  const filePath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

async function readTextFilePreview(filePath, maxChars = 6000) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    const error = new Error("Path is not a file");
    error.statusCode = 400;
    throw error;
  }
  const limit = Math.max(400, Math.min(50000, Number(maxChars) || 6000));
  const maxBytes = Math.min(info.size, limit * 4);
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      size: info.size,
      truncated: info.size > bytesRead,
      content: content.length > limit ? content.slice(0, limit) : content
    };
  } finally {
    await file.close();
  }
}

function collectEditorCandidates(env = {}) {
  const editors = [];
  const seen = new Set();
  const push = (name, command, shell = false) => {
    const cmd = String(command || "").trim();
    if (!cmd) return;
    const key = `${name}:${cmd}`;
    if (seen.has(key)) return;
    seen.add(key);
    editors.push({ name, command: cmd, shell });
  };

  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";

  push("Cursor", env.CURSOR_CLI_PATH || process.env.CURSOR_CLI_PATH);
  push("Cursor", env.CURSOR_PATH || process.env.CURSOR_PATH);
  for (const candidate of [
    path.join(localAppData, "Programs", "cursor", "Cursor.exe"),
    path.join(localAppData, "Programs", "Cursor", "Cursor.exe"),
    path.join(programFiles, "Cursor", "Cursor.exe"),
    path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
    "D:\\cursor\\Cursor.exe",
    "D:\\cursor\\resources\\app\\bin\\cursor.cmd"
  ]) {
    if (existsSync(candidate)) push("Cursor", candidate, candidate.endsWith(".cmd"));
  }

  push("VS Code", env.CODE_CLI_PATH || process.env.CODE_CLI_PATH);
  push("VS Code", env.VSCODE_PATH || process.env.VSCODE_PATH);
  for (const candidate of [
    path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    path.join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
    path.join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd"),
    "D:\\Microsoft VS Code\\bin\\code.cmd"
  ]) {
    if (existsSync(candidate)) push("VS Code", candidate, true);
  }

  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    for (const [name, bin, shell] of [
      ["Cursor", "cursor.cmd", true],
      ["Cursor", "cursor.exe", false],
      ["Cursor", "cursor", true],
      ["VS Code", "code.cmd", true],
      ["VS Code", "code", true]
    ]) {
      const candidate = path.join(trimmed, bin);
      if (existsSync(candidate)) push(name, candidate, shell);
    }
  }

  push("Cursor", "cursor", process.platform === "win32");
  push("VS Code", "code", process.platform === "win32");

  return editors;
}

async function openInEditor(filePath, lineValue = 1) {
  const env = await loadLocalEnv();
  const line = Math.max(1, Number.parseInt(String(lineValue), 10) || 1);
  const target = `${filePath}:${line}`;
  const errors = [];
  for (const editor of collectEditorCandidates(env)) {
    try {
      const options = {
        cwd: projectRoot,
        timeout: 8000,
        windowsHide: true
      };
      if (editor.shell) options.shell = true;
      await execFileAsync(editor.command, ["-g", target], options);
      return { editor: editor.name, path: filePath, line };
    } catch (error) {
      errors.push(`${editor.name} (${editor.command}): ${error.message}`);
    }
  }
  const hint = "请安装 Cursor 或 VS Code，并在项目 .env 中设置 CURSOR_CLI_PATH=Cursor.exe 完整路径。";
  throw new Error(errors.length ? `${hint} 尝试记录: ${errors.join(" | ")}` : hint);
}

function collectNodeField(markdown, fieldName) {
  const values = new Map();
  let currentId = "";
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+.+$/);
    if (heading) {
      currentId = heading[1].trim();
      continue;
    }
    if (!currentId) continue;
    const field = line.match(new RegExp(`^-\\s+${fieldName}:\\s*(.*)$`));
    if (field) values.set(currentId, field[1].trim());
  }
  return values;
}

function mergePreservedNodeFields(incoming, current) {
  const completionByNode = collectNodeField(current, "Completion");
  if (!completionByNode.size) return incoming;

  const lines = String(incoming || "").split(/\r?\n/);
  const output = [];
  let currentId = "";
  let seenCompletion = false;

  function maybeInsertCompletion() {
    if (!currentId || seenCompletion || !completionByNode.has(currentId)) return;
    output.push(`- Completion: ${completionByNode.get(currentId)}`);
    seenCompletion = true;
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+.+$/);
    if (heading) {
      maybeInsertCompletion();
      currentId = heading[1].trim();
      seenCompletion = false;
      output.push(line);
      continue;
    }

    if (currentId && /^-\s+Completion:\s*/.test(line)) seenCompletion = true;
    if (currentId && /^-\s+Problem:\s*/.test(line)) maybeInsertCompletion();
    output.push(line);
  }

  maybeInsertCompletion();
  return output.join("\n");
}

function mergePreservedGraphStateFocus(incoming, current, { allowChange = false } = {}) {
  if (allowChange || !current) return incoming;
  const prev = parseGraphStateFields(current);
  const nextState = parseGraphStateFields(incoming);
  if (isChainRunActive(nextState) || isChainRunActive(prev)) return incoming;
  let markdown = incoming;
  markdown = setGraphStateField(markdown, "Current", prev.current || "");
  markdown = setGraphStateField(markdown, "Next", prev.next || "");
  markdown = setGraphStateField(markdown, "NextPlan", prev.nextPlan || "");
  markdown = setGraphStateField(markdown, "ChainForceNext", "");
  return markdown;
}

function isChainRunActive(state = {}) {
  return String(state.chainRunStatus || "").trim() === "running";
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    send(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  send(res, 200, body, mimeTypes[ext] || "application/octet-stream");
}

const handleRequest = async (req, res) => {
  try {
    if (applyEmbedAccess(req, res)) return;
    const reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (reqPath === "/api/trees" && req.method === "GET") {
      const registry = await refreshTreeRegistry();
      const trees = await Promise.all(registry.trees.map(async (tree) => {
        const filePath = resolveTreeFile(projectRoot, tree);
        const info = existsSync(filePath) ? await stat(filePath) : null;
        return { ...tree, active: tree.id === registry.activeMethod, exists: Boolean(info), size: info?.size || 0, mtimeMs: info?.mtimeMs || 0 };
      }));
      jsonResponse(res, 200, { ...registry, trees });
      return;
    }

    if (reqPath === "/api/trees" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      try {
        const current = await refreshTreeRegistry();
        const added = await addTree({ projectRoot, registryFile: treeRegistryFile, registry: current, input: body });
        treeRegistry = added.registry;
        const filePath = resolveTreeFile(projectRoot, added.tree);
        if (!existsSync(filePath)) {
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, starterTreeMarkdown(added.tree), "utf8");
        }
        jsonResponse(res, 201, { ok: true, tree: added.tree, registry: added.registry });
      } catch (error) {
        jsonResponse(res, 400, { error: error.message || "create tree failed" });
      }
      return;
    }

    if (reqPath === "/api/trees/active" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      try {
        const current = await refreshTreeRegistry();
        treeRegistry = await setActiveMethod({ registryFile: treeRegistryFile, registry: current, treeId: body.treeId || body.id });
        activeTreeEntry = findTree(treeRegistry, treeRegistry.activeMethod);
        treeFile = resolveTreeFile(projectRoot, activeTreeEntry);
        jsonResponse(res, 200, { ok: true, ...treeRegistry });
      } catch (error) {
        jsonResponse(res, 400, { error: error.message || "set active tree failed" });
      }
      return;
    }

    if (reqPath === "/api/maintenance/status" && req.method === "GET") {
      const registry = await refreshTreeRegistry();
      const status = await auditTurnMaintenance({ projectRoot, changedFiles: [], activeTreeId: registry.activeMethod });
      jsonResponse(res, 200, status);
      return;
    }

    if (reqPath === "/api/maintenance/postflight" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const registry = await refreshTreeRegistry();
      const status = await auditTurnMaintenance({
        projectRoot,
        startedAtMs: Number(body.startedAtMs || 0),
        changedFiles: Array.isArray(body.changedFiles) ? body.changedFiles : [],
        activeTreeId: body.activeTreeId || registry.activeMethod
      });
      jsonResponse(res, status.ok ? 200 : 409, status);
      return;
    }

    if (reqPath === "/api/execution-catalog" && req.method === "GET") {
      const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir });
      jsonResponse(res, 200, catalog);
      return;
    }

    if (reqPath === "/api/flow-script" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mode = url.searchParams.get("mode") || "project";
      const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir });
      const data = await getFlowScript({ scriptsDir, mode, catalog });
      jsonResponse(res, 200, data);
      return;
    }

    if (reqPath === "/api/flow-script" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const mode = body.mode || "project";
      if (typeof body.script !== "object" || !Array.isArray(body.script.blocks)) {
        jsonResponse(res, 400, { error: "script.blocks required" });
        return;
      }
      const data = await putFlowScript({
        scriptsDir,
        mode,
        script: body.script,
        reason: body.reason || "保存脚本",
        backup: body.backup !== false
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (reqPath === "/api/flow-script/restore" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const mode = body.mode || "project";
      const versionId = String(body.versionId || "");
      if (!versionId) {
        jsonResponse(res, 400, { error: "versionId required" });
        return;
      }
      try {
        const data = await restoreFlowScript({ scriptsDir, mode, versionId });
        jsonResponse(res, 200, data);
      } catch (error) {
        jsonResponse(res, 404, { error: error.message || "restore failed" });
      }
      return;
    }

    if (reqPath === "/api/flow-script/drift" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mode = url.searchParams.get("mode") || "project";
      const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir });
      const { script } = await getFlowScript({ scriptsDir, mode, catalog });
      const drift = computeFlowDrift(catalog, script?.blocks || []);
      const nodeIds = (script?.blocks || [])
        .filter((b) => b.type === "task" || b.type === "ref")
        .map((b) => b.nodeId)
        .filter(Boolean);
      const stepPacks = await listStepPackIndex({ scriptsDir, nodeIds });
      jsonResponse(res, 200, { mode, drift, stepPacks });
      return;
    }

    if (reqPath === "/api/flow-script/sync-status" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const mode = body.mode || "project";
      const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir });
      const current = await getFlowScript({ scriptsDir, mode, catalog });
      const { blocks, changed } = syncFlowBlockStatuses(catalog, current.script?.blocks || []);
      const data = await putFlowScript({
        scriptsDir,
        mode,
        script: { blocks, focusId: current.script?.focusId || "ROOT" },
        reason: body.reason || `同步 ${changed} 个块状态`,
        backup: body.backup !== false
      });
      jsonResponse(res, 200, { ...data, statusSynced: changed });
      return;
    }

    if (reqPath === "/api/flow-script/rebuild" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const mode = body.mode || "project";
      const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir });
      const current = await getFlowScript({ scriptsDir, mode, catalog });
      const built = autoBuildFlowScript(catalog, mode);
      const focusId = resolveRebuiltFlowFocus({
        previousFocusId: current.script?.focusId,
        blocks: built.blocks,
        graphState: catalog.graphState
      });
      const data = await putFlowScript({
        scriptsDir,
        mode,
        script: { blocks: built.blocks, focusId },
        reason: body.reason || "从任务图重排流程",
        backup: body.backup !== false
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (reqPath === "/api/flow-step" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const nodeId = url.searchParams.get("nodeId") || "";
      if (!nodeId) {
        jsonResponse(res, 400, { error: "nodeId required" });
        return;
      }
      const data = await getFlowStep({ scriptsDir, nodeId });
      jsonResponse(res, 200, data);
      return;
    }

    if (reqPath === "/api/flow-step" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const nodeId = String(body.nodeId || "");
      if (!nodeId) {
        jsonResponse(res, 400, { error: "nodeId required" });
        return;
      }
      const data = await putFlowStep({
        scriptsDir,
        nodeId,
        step: body.step || {},
        reason: body.reason || "更新步骤审计包"
      });
      jsonResponse(res, 200, data);
      return;
    }

    if (reqPath === "/api/tree" && req.method === "GET") {
      const scope = await resolveRequestedTree(req.url);
      if (!scope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      const markdown = existsSync(scope.filePath) ? await readFile(scope.filePath, "utf8") : starterTreeMarkdown(scope.tree);
      jsonResponse(res, 200, { markdown, tree: { ...scope.tree, active: scope.active }, activeMethod: scope.registry.activeMethod });
      return;
    }

    if (reqPath === "/api/execution-scopes" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        jsonResponse(res, 201, { scope: await executionScopes.create(body) });
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }

    const executionScopeMatch = reqPath.match(/^\/api\/execution-scopes\/([A-Za-z0-9._-]+)(?:\/(close))?$/);
    if (executionScopeMatch && req.method === "GET") {
      const scope = await executionScopes.get(executionScopeMatch[1]);
      if (!scope) jsonResponse(res, 404, { error: "execution scope not found" });
      else jsonResponse(res, 200, { scope });
      return;
    }
    if (executionScopeMatch?.[2] === "close" && req.method === "POST") {
      const scope = await executionScopes.close(executionScopeMatch[1]);
      if (!scope) jsonResponse(res, 404, { error: "execution scope not found" });
      else jsonResponse(res, 200, { scope });
      return;
    }

    if (reqPath === "/api/tree/node-patch" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const nodeId = String(body.nodeId || "").trim();
        const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
        if (!nodeId || !fields || !Object.keys(fields).length) throw new Error("nodeId and fields are required");
        if (!String(body.reason || "").trim()) throw new Error("reason is required");
        for (const key of Object.keys(fields)) {
          if (/^(Current|Next|NextPlan|Chain|ChainForceNext)$/.test(key)) throw new Error(`${key} 属于 GraphState，不能通过节点字段写入`);
        }
        const scope = await resolveRequestedTree(req.url, body);
        if (!scope) throw new Error("tree not found");
        if (scope.tree.editable === false) {
          jsonResponse(res, 403, { error: "tree is read-only" });
          return;
        }
        const scopeId = String(body.scopeId || "").trim();
        let executionScope = null;
        if (scopeId) executionScope = await executionScopes.assertWritable(scopeId, nodeId, { treeId: scope.tree.id });
        const result = await queueTreeWrite(scope.filePath, async () => {
          const current = existsSync(scope.filePath) ? await readFile(scope.filePath, "utf8") : starterTreeMarkdown(scope.tree);
          const patched = patchNodeFields(current, nodeId, fields);
          const gate = inspectTreeMarkdown(patched.markdown, {
            file: path.relative(projectRoot, scope.filePath).replace(/\\/g, "/"),
            maxBytes: scope.active ? ACTIVE_METHOD_TREE_MAX_BYTES : 0
          });
          if (gate.violations.length || gate.longLines.length) {
            const error = new Error("精炼门禁不通过，已拒绝写入");
            error.status = 422;
            error.details = { violations: gate.violations, longLines: gate.longLines };
            throw error;
          }
          const persisted = await persistTreeMarkdown(scope, patched.markdown, body);
          return { ...persisted, applied: patched.applied };
        });
        jsonResponse(res, 200, {
          ok: true,
          tree: { ...scope.tree, active: scope.active },
          executionScope,
          applied: result.applied,
          flowSync: result.flowSync,
          changes: result.changes,
          changedNodeIds: changedNodeIds(result.changes)
        });
      } catch (error) {
        jsonResponse(res, error.status || (/范围|可写|关闭/.test(error.message) ? 403 : 400), { error: error.message, ...(error.details || {}) });
      }
      return;
    }

    if (reqPath === "/api/graph-state" && req.method === "GET") {
      const markdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      const state = parseGraphStateFields(markdown);
      const chain = parseChainNodeIds(state.chain);
      jsonResponse(res, 200, {
        state: { ...state, chain: state.chain ? "(redacted; use chain-step)" : "" },
        agentPrompt: buildChainAgentPrompt(state, chain, { redactFuture: true, markdown }),
        nextComplete: state.next ? isNodeChainComplete(markdown, state.next) : null,
        shouldStopLoop: evaluateChainLoopStop(state, chain, markdown).shouldStopLoop
      });
      return;
    }

    if (reqPath === "/api/graph-state/chain-step" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const subtree = url.searchParams.get("subtree") || "";
      const scope = await readScopeMarkdown(subtree);
      if (!scope) {
        jsonResponse(res, 404, { error: "subtree not found" });
        return;
      }
      const context = await writeChainStepContextFile(scope.markdown, {
        scope: scope.scope,
        subtreePath: scope.scope === "subtree" ? scope.rel : ""
      });
      jsonResponse(res, 200, context);
      return;
    }

    if (reqPath === "/api/graph-state/chain-advance" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const subtree = String(body.subtree || "").trim();
      const scope = await readScopeMarkdown(subtree);
      if (!scope) {
        jsonResponse(res, 404, { error: "subtree not found" });
        return;
      }
      const markdown = scope.markdown;
      const result = advanceAgentChain(markdown, { force: body.force === true });
      if (result.advanced && result.markdown && result.markdown !== markdown) {
        if (scope.scope === "subtree") {
          await backupSubtreeFile(scope.rel, body.reason || "将链式推进子树GraphState");
          await writeFile(scope.filePath, result.markdown, "utf8");
        } else {
          await backupTree(body.reason || "将链式推进GraphState");
          await writeFile(treeFile, result.markdown, "utf8");
          await writeCurrentVersion(result.markdown);
        }
        await writeChainStepContextFile(result.markdown, {
          scope: scope.scope,
          subtreePath: scope.scope === "subtree" ? scope.rel : ""
        }).catch(() => {});
      }
      jsonResponse(res, 200, {
        ...result,
        scope: scope.scope,
        subtreePath: scope.scope === "subtree" ? scope.rel : "",
        shouldStopLoop: Boolean(result.done),
        loopStopCommand: buildLoopStopCommand(result.done ? "链已走完" : "", { soft: true })
      });
      return;
    }

    if (reqPath === "/api/graph-state/chain-force-next" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const nextId = sanitizeGraphId(String(body.nextId || body.next || ""));
      if (!nextId) {
        jsonResponse(res, 400, { error: "nextId is required" });
        return;
      }
      const markdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      let updated = setGraphStateField(markdown, "ChainForceNext", nextId);
      await backupTree(body.reason || `将强制下一步设为${nextId}`);
      await writeFile(treeFile, updated, "utf8");
      const state = parseGraphStateFields(updated);
      jsonResponse(res, 200, {
        ok: true,
        state,
        chain: parseChainNodeIds(state.chain),
        message: `ChainForceNext 已设为 ${nextId}；下轮 Agent 必须先切换 Next`
      });
      return;
    }

    if (reqPath === "/api/project" && req.method === "GET") {
      send(res, 200, JSON.stringify({
        root: projectRoot,
        kitDir,
        name: path.basename(projectRoot),
        treeFile: path.relative(projectRoot, treeFile),
        // The widget needs to know whether a framable https address exists before it tries one.
        httpsUrl: tlsListener ? `https://${host}:${tlsListener.address()?.port}` : null
      }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/projects" && req.method === "GET") {
      jsonResponse(res, 200, { current: projectRoot, projects: describeProjects({ currentRoot: projectRoot }) });
      return;
    }

    if (reqPath === "/api/projects/open" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      const root = typeof body.root === "string" ? body.root.trim() : "";
      if (!root) {
        jsonResponse(res, 400, { error: "root is required" });
        return;
      }
      try {
        jsonResponse(res, 200, await ensureProjectServer(root, { fallbackKitDir: kitDir }));
      } catch (error) {
        jsonResponse(res, 502, { error: error.message });
      }
      return;
    }

    if (reqPath === "/api/codex/threads" && req.method === "GET") {
      // Threads and presets travel together because the menu shows both at once, and a second
      // round-trip would let the two halves disagree about which node is Next.
      try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const { threads, cache } = await readCodexThreadsFast({ refresh: requestUrl.searchParams.get("refresh") === "1" });
        jsonResponse(res, 200, {
          threads,
          cache,
          pinned: readPinnedThread(projectRoot),
          presets: describePresets(await readCodexPromptState())
        });
      } catch (error) {
        jsonResponse(res, 502, { error: error.message, presets: describePresets(await readCodexPromptState()) });
      }
      return;
    }

    if (reqPath === "/api/codex/pin" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      writePinnedThread(projectRoot, threadId);
      jsonResponse(res, 200, { pinned: readPinnedThread(projectRoot) });
      return;
    }

    if (reqPath === "/api/codex/run" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      // `fresh` forces a new conversation; otherwise an explicit id wins over the pinned one, and
      // the pinned one is only a default so the usual click keeps landing where the user works.
      const wanted = body.fresh === true
        ? ""
        : (typeof body.threadId === "string" && body.threadId.trim()) || readPinnedThread(projectRoot);

      let prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        const { prompt: built, blocked } = buildPresetPrompt(body.preset || "open", await readCodexPromptState());
        // A preset with nothing to say must not spend a turn; the reason is more useful than a run.
        if (blocked) {
          jsonResponse(res, 409, { error: blocked });
          return;
        }
        prompt = built;
      }

      // Lets the prompt be inspected (and tested) without spending a turn on the model.
      if (body.dryRun === true) {
        jsonResponse(res, 200, { dryRun: true, preset: body.preset || "open", prompt, threadId: wanted || null });
        return;
      }

      try {
        const { threadId, turnId, resumed } = await startCodexTurn({ prompt, cwd: projectRoot, threadId: wanted });
        writePinnedThread(projectRoot, threadId);
        if (body.open !== false) openInCodex(threadId);
        jsonResponse(res, 200, { threadId, turnId, resumed, prompt, deepLink: threadDeepLink(threadId) });
      } catch (error) {
        jsonResponse(res, 502, { error: error.message, threadId: error.threadId || null });
      }
      return;
    }

    if (reqPath === "/api/codex/parallel" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const run = await parallelCodex.start(body.jobs);
        jsonResponse(res, 202, { run });
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }

    const parallelMatch = reqPath.match(/^\/api\/codex\/parallel\/([A-Za-z0-9-]+)(?:\/(open))?$/);
    if (parallelMatch && req.method === "GET") {
      const run = await parallelCodex.get(parallelMatch[1]);
      if (!run) {
        jsonResponse(res, 404, { error: "找不到这次并行运行" });
        return;
      }
      jsonResponse(res, 200, { run });
      return;
    }
    if (parallelMatch?.[2] === "open" && req.method === "POST") {
      const run = await parallelCodex.get(parallelMatch[1]);
      if (!run?.coordinator?.threadId) {
        jsonResponse(res, 409, { error: "coordinator 还没有完成" });
        return;
      }
      openInCodex(run.coordinator.threadId);
      jsonResponse(res, 200, { deepLink: run.deepLink });
      return;
    }

    if (reqPath === "/api/shutdown" && req.method === "POST") {
      jsonResponse(res, 200, { ok: true, message: "shutting down task tree server and local background services" });
      setTimeout(async () => {
        // Armed before awaiting: a background service that never resolves used to leave the
        // process alive holding the kit directory, while the caller was told it stopped.
        const hardExit = setTimeout(() => process.exit(0), 3000);
        await shutdownBackgroundServices().catch(() => {});
        clearTimeout(hardExit);
        tlsListener?.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500);
      }, 50);
      return;
    }

    if (reqPath === "/api/tree" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      if (typeof body.markdown !== "string") {
        send(res, 400, JSON.stringify({ error: "markdown must be a string" }), "application/json; charset=utf-8");
        return;
      }
      const scope = await resolveRequestedTree(req.url, body);
      if (!scope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      if (scope.tree.editable === false) {
        jsonResponse(res, 403, { error: "tree is read-only" });
        return;
      }
      if (body.scopeId) {
        jsonResponse(res, 403, { error: "带执行范围的 Agent 禁止整棵树覆盖；请使用 /api/tree/node-patch" });
        return;
      }
      const saved = await queueTreeWrite(scope.filePath, () => persistTreeMarkdown(scope, body.markdown, body));
      jsonResponse(res, 200, {
        ok: true,
        tree: { ...scope.tree, active: scope.active },
        flowSync: saved.flowSync,
        changes: saved.changes,
        changedNodeIds: changedNodeIds(saved.changes)
      });
      return;
    }

    if (reqPath === "/api/current-version" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      if (typeof body.markdown !== "string") {
        send(res, 400, JSON.stringify({ error: "markdown must be a string" }), "application/json; charset=utf-8");
        return;
      }
      const scope = await resolveRequestedTree(req.url, body);
      if (!scope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      await writeCurrentVersion(body.markdown, scope.tree);
      jsonResponse(res, 200, { ok: true, versions: await listVersions(scope.tree) });
      return;
    }

    if (reqPath === "/api/subtree-file/agent-context" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const rel = url.searchParams.get("path") || url.searchParams.get("subtree");
      const filePath = resolveSubtreeFilePath(rel);
      if (!filePath || !existsSync(filePath)) {
        jsonResponse(res, 404, { error: "subtree file not found" });
        return;
      }
      const mainMarkdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      const subtreeMarkdown = await readFile(filePath, "utf8");
      const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
      const context = buildSubtreeAgentContext(mainMarkdown, subtreeMarkdown, relPath);
      const outDir = path.resolve(projectRoot, ".subtree-run");
      await mkdir(outDir, { recursive: true });
      const safeName = relPath.replace(/[^a-zA-Z0-9_-]+/g, "-");
      await writeFile(path.join(outDir, `${safeName}-context.md`), `${context.mapMarkdown}\n\n---\n\n${context.workMarkdown}\n`, "utf8");
      jsonResponse(res, 200, context);
      return;
    }

    if (reqPath === "/api/subtree-file/versions" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const rel = url.searchParams.get("path") || url.searchParams.get("subtree");
      if (!resolveSubtreeFilePath(rel)) {
        jsonResponse(res, 404, { error: "subtree file not found" });
        return;
      }
      jsonResponse(res, 200, { path: rel, versions: await listSubtreeVersions(rel) });
      return;
    }

    if (reqPath === "/api/subtree-file/restore" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const rel = body.path || body.subtree;
      const filePath = resolveSubtreeFilePath(rel);
      if (!filePath) {
        jsonResponse(res, 400, { error: "invalid subtree path" });
        return;
      }
      const versionName = path.basename(String(body.name || ""));
      const versionPath = path.join(subtreeVersionsDir(rel), versionName);
      if (!versionPath.startsWith(subtreeVersionsDir(rel)) || !existsSync(versionPath)) {
        jsonResponse(res, 404, { error: "version not found" });
        return;
      }
      const current = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
      if (typeof body.currentMarkdown === "string" && existsSync(filePath)) {
        await backupSubtreeFile(rel, "回退前快照");
      }
      const markdown = await readFile(versionPath, "utf8");
      await writeFile(filePath, markdown, "utf8");
      const changes = diffTreeMarkdown(current, markdown);
      jsonResponse(res, 200, { ok: true, markdown, changes, changedNodeIds: changedNodeIds(changes), versions: await listSubtreeVersions(rel) });
      return;
    }

    if (reqPath === "/api/subtree-file" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.searchParams.get("agentContext") === "1") {
        const rel = url.searchParams.get("path") || url.searchParams.get("subtree");
        const filePath = resolveSubtreeFilePath(rel);
        if (!filePath || !existsSync(filePath)) {
          jsonResponse(res, 404, { error: "subtree file not found" });
          return;
        }
        const mainMarkdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
        const subtreeMarkdown = await readFile(filePath, "utf8");
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        const context = buildSubtreeAgentContext(mainMarkdown, subtreeMarkdown, relPath);
        jsonResponse(res, 200, context);
        return;
      }
      const filePath = resolveSubtreeFilePath(url.searchParams.get("path"));
      if (!filePath || !existsSync(filePath)) {
        jsonResponse(res, 404, { error: "subtree file not found" });
        return;
      }
      jsonResponse(res, 200, { path: path.relative(projectRoot, filePath).replace(/\\/g, "/"), markdown: await readFile(filePath, "utf8") });
      return;
    }

    if (reqPath === "/api/subtree-file/sync-stub" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const rel = body.path || body.subtree;
      const filePath = resolveSubtreeFilePath(rel);
      if (!filePath || !existsSync(filePath)) {
        jsonResponse(res, 404, { error: "subtree file not found" });
        return;
      }
      const mainMarkdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      const subtreeMarkdown = typeof body.markdown === "string" ? body.markdown : await readFile(filePath, "utf8");
      const foldRoot = body.foldRoot || parseSubtreeFoldRoot(subtreeMarkdown);
      const result = syncStubFromSubtree(mainMarkdown, subtreeMarkdown, foldRoot);
      if (!result.ok) {
        jsonResponse(res, 400, result);
        return;
      }
      if (result.markdown !== mainMarkdown) {
        await backupTree(body.reason || `将同步子树${foldRoot}摘要到主树stub`);
        await writeFile(treeFile, result.markdown, "utf8");
      }
      if (typeof body.markdown === "string") {
        await writeFile(filePath, body.markdown, "utf8");
      }
      const changes = diffTreeMarkdown(mainMarkdown, result.markdown);
      jsonResponse(res, 200, { ok: true, foldRoot, changes, changedNodeIds: changedNodeIds(changes), message: `已同步 stub ${foldRoot} 摘要到 task-tree.md` });
      return;
    }

    if (reqPath === "/api/subtree-file" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const filePath = resolveSubtreeFilePath(body.path);
      if (!filePath || typeof body.markdown !== "string") {
        jsonResponse(res, 400, { error: "invalid subtree path or markdown" });
        return;
      }
      const current = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
      await mkdir(subtreesDir, { recursive: true });
      if (body.backup !== false && existsSync(filePath)) {
        await backupSubtreeFile(body.path, body.reason || `将保存子树${path.basename(filePath)}`);
      }
      await writeFile(filePath, body.markdown, "utf8");
      const changes = diffTreeMarkdown(current, body.markdown);
      jsonResponse(res, 200, { ok: true, path: path.relative(projectRoot, filePath).replace(/\\/g, "/"), changes, changedNodeIds: changedNodeIds(changes) });
      return;
    }

    if (reqPath === "/api/subtree-file" && req.method === "DELETE") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const filePath = resolveSubtreeFilePath(url.searchParams.get("path"));
      if (!filePath || !existsSync(filePath)) {
        jsonResponse(res, 404, { error: "subtree file not found" });
        return;
      }
      const current = await readFile(filePath, "utf8");
      await backupTree(url.searchParams.get("reason") || `将展开子树并删除${path.basename(filePath)}`);
      const { unlink } = await import("node:fs/promises");
      await unlink(filePath);
      const changes = diffTreeMarkdown(current, "");
      jsonResponse(res, 200, { ok: true, changes, changedNodeIds: changedNodeIds(changes) });
      return;
    }

    if (reqPath === "/api/versions" && req.method === "GET") {
      const scope = await resolveRequestedTree(req.url);
      if (!scope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      jsonResponse(res, 200, { versions: await listVersions(scope.tree), tree: scope.tree });
      return;
    }

    if (reqPath === "/api/skills/recommend" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const recommendations = await recommendSkills(body);
      send(res, 200, JSON.stringify({ recommendations }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/model-agents" && req.method === "GET") {
      jsonResponse(res, 200, await loadModelAgentDetails());
      return;
    }

    if (reqPath === "/api/model-agents/health" && req.method === "GET") {
      const config = await loadModelAgents({ includeKeys: true });
      const enabled = config.models.filter((item) => item.enabled !== false);
      const results = await Promise.all(enabled.map(async (agent) => {
        const probe = await probeModelAgent(agent);
        return {
          id: agent.id,
          name: agent.name,
          model: agent.model,
          baseUrl: agent.baseUrl,
          endpoint: probe.endpoint || modelAgentEndpoint(agent),
          ok: probe.ok,
          error: probe.error || "",
          status: probe.status || 0
        };
      }));
      jsonResponse(res, 200, { checkedAt: new Date().toISOString(), results });
      return;
    }

    if (reqPath === "/api/model-agents" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, await saveModelAgents(body.models));
      return;
    }

    if (reqPath === "/api/model-agent-history" && req.method === "GET") {
      jsonResponse(res, 200, await readJsonFile(modelHistoryFile, {}));
      return;
    }

    if (reqPath === "/api/model-agent-history" && req.method === "DELETE") {
      await writeJsonFile(modelHistoryFile, {});
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (reqPath === "/api/model-conversations" && req.method === "GET") {
      const nodes = await loadModelNodeConversations();
      jsonResponse(res, 200, {
        nodes,
        file: path.basename(modelNodeConversationsFile),
        updatedAt: (await readJsonFile(modelNodeConversationsFile, {})).updatedAt || ""
      });
      return;
    }

    if (reqPath === "/api/model-conversations" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const nodes = await saveModelNodeConversations(body.nodes || {});
      jsonResponse(res, 200, { ok: true, nodes });
      return;
    }

    if (reqPath === "/api/model-conversations" && req.method === "DELETE") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      if (body.nodeId) {
        const nodeId = sanitizeGraphId(String(body.nodeId));
        const nodes = await loadModelNodeConversations();
        delete nodes[nodeId];
        await saveModelNodeConversations(nodes);
        jsonResponse(res, 200, { ok: true, nodes });
        return;
      }
      await writeJsonFile(modelNodeConversationsFile, { updatedAt: isoNow(), nodes: {} });
      jsonResponse(res, 200, { ok: true, nodes: {} });
      return;
    }

    if (reqPath === "/api/knowledge/history" && req.method === "GET") {
      const history = await loadKnowledgeHistory();
      jsonResponse(res, 200, {
        history,
        file: path.basename(knowledgeHistoryFile),
        updatedAt: (await readJsonFile(knowledgeHistoryFile, {})).updatedAt || ""
      });
      return;
    }

    if (reqPath === "/api/knowledge/history" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const history = await saveKnowledgeHistory(body.history);
      jsonResponse(res, 200, { ok: true, history });
      return;
    }

    if (reqPath === "/api/knowledge/history" && req.method === "DELETE") {
      await writeJsonFile(knowledgeHistoryFile, { updatedAt: isoNow(), history: [] });
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (reqPath === "/api/knowledge/config" && req.method === "GET") {
      const config = await loadKnowledgeConfig();
      const webSearch = await loadWebSearchConfig();
      const libraries = config.libraries || [];
      const totalChunks = libraries.reduce((sum, item) => sum + (Number(item.totalChunks) || 0), 0);
      jsonResponse(res, 200, {
        config,
        index: {
          exists: libraries.some((item) => item.indexExists) || existsSync(knowledgeIndexFile),
          libraryRoot: config.libraryRoot || config.docsDir || "knowledge",
          libraries,
          createdAt: libraries.map((item) => item.createdAt).filter(Boolean).sort().slice(-1)[0] || "",
          docsDir: config.libraryRoot || config.docsDir || "knowledge",
          embeddingModel: libraries.map((item) => item.embeddingModel).filter(Boolean)[0] || "",
          totalChunks
        },
        reindex: knowledgeReindexStatus(),
        webSearch,
        openWebSearch: await getOpenWebSearchStatus(),
        copilot: {
          detected: existsSync(path.join(projectRoot, "copilot", ".obsidian")) || existsSync(path.join(kitDir, "copilot", ".obsidian")),
          note: "Copilot indexes are model-specific and large; this panel builds its own compatible index from markdown files."
        }
      });
      return;
    }

    if (reqPath === "/api/web-search/config" && req.method === "GET") {
      jsonResponse(res, 200, { config: await loadWebSearchConfig(), openWebSearch: await getOpenWebSearchStatus() });
      return;
    }

    if (reqPath === "/api/web-search/config" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, { config: await saveWebSearchConfig(body) });
      return;
    }

    if (reqPath === "/api/web-search/search" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, await searchWeb(body.query, { topK: body.topK }));
      return;
    }

    if (reqPath === "/api/knowledge/config" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, { config: await saveKnowledgeConfig(body) });
      return;
    }

    if (reqPath === "/api/knowledge/reindex" && req.method === "POST") {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch {
        body = {};
      }
      jsonResponse(res, 202, {
        ok: true,
        job: await startKnowledgeReindex({
          libraryId: body.libraryId,
          all: body.all === true
        })
      });
      return;
    }

    if (reqPath === "/api/knowledge/reindex-status" && req.method === "GET") {
      jsonResponse(res, 200, { job: knowledgeReindexStatus() });
      return;
    }

    if (reqPath === "/api/knowledge/search" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const config = await loadKnowledgeConfig();
      const retrievalScope = parseKnowledgeRetrievalBody(body, config);
      jsonResponse(res, 200, await searchRetrieval(body.query, {
        topK: body.topK,
        webTopK: body.webTopK,
        includeKnowledge: body.includeKnowledge !== false,
        includeWeb: body.includeWeb === true,
        contextHint: body.contextHint || body.query,
        nodeMarkdown: String(body.nodeMarkdown || ""),
        useLlmQuery: body.useLlmQuery !== false,
        ...retrievalScope
      }));
      return;
    }

    if (reqPath === "/api/knowledge/ask" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const question = String(body.question || "").trim();
      if (!question) {
        jsonResponse(res, 400, { error: "question is required" });
        return;
      }
      const priorTurns = normalizeKnowledgeAskHistory(body.history);
      const historyHint = priorTurns
        .map((turn) => `问：${turn.question}\n答：${(turn.answer || "").slice(0, 500)}`)
        .join("\n\n");
      const retrievalHint = [
        historyHint,
        String(body.contextHint || "").trim(),
        question
      ].filter(Boolean).join("\n\n");
      const config = await loadKnowledgeConfig();
      const retrievalScope = parseKnowledgeRetrievalBody(body, config);
      const search = await searchRetrieval(question, {
        topK: body.topK || RETRIEVAL_DEFAULT_TOP_K,
        webTopK: body.webTopK || RETRIEVAL_WEB_DEFAULT_TOP_K,
        includeKnowledge: body.includeKnowledge !== false,
        includeWeb: body.includeWeb === true,
        contextHint: retrievalHint,
        nodeMarkdown: String(body.nodeMarkdown || ""),
        useLlmQuery: body.useLlmQuery !== false,
        ...retrievalScope
      });
      const modelId = safeModelId(body.modelId || config.chat.modelId);
      if (!modelId) {
        jsonResponse(res, 400, { error: "select a chat model first" });
        return;
      }
      const agentConfig = await loadModelAgents({ includeKeys: true });
      const agent = agentConfig.models.find((item) => item.id === modelId);
      if (!agent) {
        jsonResponse(res, 404, { error: "chat model not found" });
        return;
      }
      const priorRetrievalContext = String(body.priorRetrievalContext || "").slice(0, RETRIEVAL_CONTEXT_MAX_CHARS);
      const newContext = buildKnowledgeContext(search.results);
      const fullContext = priorRetrievalContext
        ? `${priorRetrievalContext}\n\n---\n\n## 本轮新检索\n\n${newContext}`.slice(0, RETRIEVAL_CONTEXT_MAX_CHARS)
        : newContext;
      const messages = [
        {
          role: "system",
          content: [
            "Answer the user's question using the retrieved markdown knowledge base context.",
            "If the context is insufficient, say what is missing. Cite source paths in the answer.",
            "Reply in Chinese with concise Markdown (headings, bullet lists).",
            "For tables, use GitHub-flavored Markdown only: header row, then |---|---| separator row, then data rows. Do not use HTML <table>.",
            "Prior turns are conversation history only; retrieved context is the evidence."
          ].join(" ")
        },
        ...priorTurns.flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.answer || "(暂无回答)" }
        ]),
        {
          role: "user",
          content: [
            "Question:",
            question,
            "",
            "Retrieved context:",
            "```text",
            fullContext,
            "```"
          ].join("\n")
        }
      ];
      const answer = await callOpenAICompatible(agent, messages);
      jsonResponse(res, 200, {
        question,
        answer,
        results: search.results,
        errors: search.errors,
        modelId: agent.id,
        model: agent.model,
        refinedQuery: search.refinedQuery,
        webQuery: search.webQuery,
        executedQuery: search.executedQuery,
        rewriteSource: search.rewriteSource,
        llmQueries: search.llmQueries
      });
      return;
    }

    if (reqPath === "/api/model-agents/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map(safeModelId).filter(Boolean) : [];
      const question = String(body.question || "").trim();
      const nodeId = sanitizeGraphId(String(body.nodeId || ""));
      if (!modelIds.length || !question) {
        jsonResponse(res, 400, { error: "modelIds and question are required" });
        return;
      }
      const treeScope = await resolveRequestedTree(req.url, body);
      if (!treeScope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      const runTreeFile = treeScope.filePath;
      const treeMarkdownRaw = existsSync(runTreeFile) ? await readFile(runTreeFile, "utf8") : "";
      const contextNodeIds = Array.isArray(body.contextNodeIds)
        ? body.contextNodeIds.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const selectedTreeMarkdown = contextNodeIds.length
        ? buildChainTreeMarkdown(treeMarkdownRaw, contextNodeIds)
        : treeMarkdownRaw;
      const treeMarkdown = maskAdvisoryNextPlan(selectedTreeMarkdown);
      const treeSnapshotHash = sha256Short(treeMarkdownRaw);
      const nodeMarkdown = extractNodeMarkdown(treeMarkdown, nodeId);
      const sidebarKnowledgeContext = String(body.knowledgeContext || "").trim();
      const useKnowledgeSearch = body.useKnowledgeSearch === true;
      const includeWeb = body.includeWeb === true;
      const histories = body.histories && typeof body.histories === "object" ? body.histories : {};
      const sharedHistories = body.sharedHistories && typeof body.sharedHistories === "object" ? body.sharedHistories : {};
      let autoRetrieval = null;
      let providedKnowledgeContext = sidebarKnowledgeContext.slice(0, RETRIEVAL_CONTEXT_MAX_CHARS);
      if (useKnowledgeSearch) {
        try {
          autoRetrieval = await searchRetrieval(question, {
            topK: body.topK || RETRIEVAL_DEFAULT_TOP_K,
            webTopK: body.webTopK || RETRIEVAL_WEB_DEFAULT_TOP_K,
            includeKnowledge: true,
            includeWeb,
            contextHint: buildModelRunRetrievalHint({ question, nodeMarkdown, histories }),
            nodeMarkdown,
            useLlmQuery: true,
            ...parseKnowledgeRetrievalBody(body, await loadKnowledgeConfig())
          });
          const autoContext = buildKnowledgeContext(autoRetrieval.results || []);
          providedKnowledgeContext = sidebarKnowledgeContext
            ? `${sidebarKnowledgeContext}\n\n---\n\n## 本轮自动检索\n\n${autoContext}`.slice(0, RETRIEVAL_CONTEXT_MAX_CHARS)
            : autoContext.slice(0, RETRIEVAL_CONTEXT_MAX_CHARS);
        } catch (error) {
          autoRetrieval = { error: error.message, results: [], errors: [error.message] };
        }
      }
      const enableTools = useKnowledgeSearch;
      const config = await loadModelAgents({ includeKeys: true });
      const agents = config.models.filter((item) => modelIds.includes(item.id));
      if (!agents.length) {
        jsonResponse(res, 400, { error: "No enabled model agents matched modelIds" });
        return;
      }
      const probes = await Promise.all(agents.map((agent) => probeModelAgent(agent)));
      if (probes.every((item) => !item.ok)) {
        jsonResponse(res, 200, {
          nodeId,
          question,
          treeSnapshotHash,
          treeChangedDuringRun: false,
          treeChangedNote: "模型 API 不可达，未发起检索与推理。",
          elapsedMs: 0,
          results: agents.map((agent, index) => ({
            id: agent.id,
            name: agent.name,
            model: agent.model,
            ok: false,
            error: probes[index]?.error || "model API unreachable",
            elapsedMs: 0
          })),
          useKnowledgeSearch,
          includeWeb,
          autoRetrieval: null,
          knowledgeResults: [],
          knowledgeErrors: [],
          apiUnreachable: true
        });
        return;
      }
      const started = Date.now();
      const results = await Promise.all(agents.map(async (agent) => {
        const itemStarted = Date.now();
        try {
          const agentPrompt = await readModelAgentPrompt(agent);
          const run = await runModelAgentWithTools({
            agent,
            agentPrompt,
            question,
            treeMarkdown,
            nodeMarkdown,
            history: histories[agent.id],
            sharedHistory: sharedHistories[agent.id],
            enableTools,
            includeWeb,
            providedKnowledgeContext
          });
          return {
            id: agent.id,
            name: agent.name,
            model: agent.model,
            ok: true,
            answer: run.answer,
            toolEvents: run.toolEvents,
            elapsedMs: Date.now() - itemStarted
          };
        } catch (error) {
          return {
            id: agent.id,
            name: agent.name,
            model: agent.model,
            ok: false,
            error: error.message,
            elapsedMs: Date.now() - itemStarted
          };
        }
      }));
      jsonResponse(res, 200, {
        nodeId,
        question,
        treePath: treeScope.tree.path,
        treeSnapshotHash,
        treeChangedDuringRun: sha256Short(existsSync(runTreeFile) ? await readFile(runTreeFile, "utf8") : "") !== treeSnapshotHash,
        treeChangedNote: `运行期间 ${treeScope.tree.path} 若有外部改动，不影响本轮模型回答；上下文用的是开始时的树快照。`,
        elapsedMs: Date.now() - started,
        results,
        useKnowledgeSearch,
        includeWeb,
        autoRetrieval: autoRetrieval ? {
          executedQuery: autoRetrieval.executedQuery || autoRetrieval.webQuery || autoRetrieval.refinedQuery || question,
          rewriteSource: autoRetrieval.rewriteSource || "",
          resultCount: Array.isArray(autoRetrieval.results) ? autoRetrieval.results.length : 0,
          includeWeb,
          errors: autoRetrieval.errors || (autoRetrieval.error ? [autoRetrieval.error] : [])
        } : null,
        knowledgeResults: autoRetrieval?.results || [],
        knowledgeErrors: autoRetrieval?.errors || (autoRetrieval?.error ? [autoRetrieval.error] : [])
      });
      return;
    }

    if (reqPath === "/api/restore" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const scope = await resolveRequestedTree(req.url, body);
      if (!scope) {
        jsonResponse(res, 404, { error: "tree not found" });
        return;
      }
      const versionPath = safeVersionPath(body.name, scope.tree);
      if (!versionPath || !existsSync(versionPath)) {
        send(res, 404, JSON.stringify({ error: "version not found" }), "application/json; charset=utf-8");
        return;
      }
      const restoringCurrent = path.basename(versionPath) === CURRENT_VERSION_NAME;
      if (!restoringCurrent) {
        if (typeof body.currentMarkdown === "string") {
          await writeCurrentVersion(body.currentMarkdown, scope.tree);
        } else if (existsSync(scope.filePath)) {
          await writeCurrentVersion(await readFile(scope.filePath, "utf8"), scope.tree);
        }
      }
      const markdown = await readFile(versionPath, "utf8");
      await writeFile(scope.filePath, markdown, "utf8");
      jsonResponse(res, 200, { ok: true, markdown, versions: await listVersions(scope.tree), tree: scope.tree });
      return;
    }

    if (reqPath === "/api/server-info" && req.method === "GET") {
      jsonResponse(res, 200, {
        kitDir,
        projectRoot,
        stubDir,
        features: {
          openInEditor: true,
          modelAgentHealth: true,
          flowScript: true,
          serverInfo: true
        }
      });
      return;
    }

    if (reqPath === "/api/open-in-editor" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const filePath = safeWorkspaceFilePath(body.path);
      if (!filePath) {
        send(res, 403, JSON.stringify({ error: "Path is outside project root" }), "application/json; charset=utf-8");
        return;
      }
      if (!existsSync(filePath)) {
        send(res, 404, JSON.stringify({ error: `File not found: ${body.path || ""}` }), "application/json; charset=utf-8");
        return;
      }
      const info = await stat(filePath);
      if (!info.isFile()) {
        send(res, 400, JSON.stringify({ error: "Path is not a file" }), "application/json; charset=utf-8");
        return;
      }
      const result = await openInEditor(filePath, body.line);
      send(res, 200, JSON.stringify({ ok: true, ...result }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/file" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const filePath = safeWorkspaceFilePath(url.searchParams.get("path"));
      if (!filePath) {
        send(res, 403, "Path is outside project root");
        return;
      }
      if (!existsSync(filePath)) {
        send(res, 404, `File not found: ${url.searchParams.get("path") || ""}`);
        return;
      }
      if (url.searchParams.get("preview") === "1") {
        try {
          const preview = await readTextFilePreview(filePath, url.searchParams.get("maxChars"));
          send(res, 200, JSON.stringify({
            path: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
            ...preview
          }), "application/json; charset=utf-8");
        } catch (error) {
          send(res, error.statusCode || 500, error.message || "File preview failed");
        }
        return;
      }
      const info = await stat(filePath);
      if (!info.isFile()) {
        send(res, 400, "Path is not a file");
        return;
      }
      const body = await readFile(filePath, "utf8");
      send(res, 200, body, "text/plain; charset=utf-8");
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
  }
};

let tlsListener = null;

/** Appended, not overwritten: the interesting part is usually the sequence, not the last line. */
function noteTlsEvent(line) {
  const file = path.join(stubDir || projectRoot, "https-log.txt");
  appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8").catch(() => {});
}

const server = http.createServer(handleRequest);

/**
 * The same app over TLS, for hosts that refuse to frame a plain http page. It is an addition, not
 * a replacement: every launcher, probe and bookmark keeps using the http address.
 */
function startTlsListener(httpPort) {
  const credentials = loadLocalTls();
  if (!credentials) return;
  const httpsPort = httpsPortFor(httpPort);
  const secure = https.createServer({ pfx: credentials.pfx, passphrase: credentials.passphrase }, handleRequest);
  secure.on("error", (error) => console.warn(`https listener unavailable: ${error.message}`));
  // A rejected certificate and a request that never left the sandbox look identical from the
  // browser side, so the one place that can tell them apart writes it down.
  secure.on("tlsClientError", (error) => noteTlsEvent(`tlsClientError ${error?.code || ""} ${error?.message || error}`));
  secure.on("request", (req) => {
    const origin = req.headers.origin || "";
    if (EMBED_ORIGIN.test(origin)) noteTlsEvent(`${req.method} ${req.url} origin=${origin}`);
  });
  secure.listen(httpsPort, host, () => {
    console.log(`Task tree app also running at https://${host}:${httpsPort}`);
  });
  tlsListener = secure;
}

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Task tree app running at http://${host}:${actualPort}`);
  startTlsListener(actualPort);
  if (!codexThreadCache.threads.length) refreshCodexThreadCache().catch(() => {});
  cleanupLegacyOpenWebSearchLauncherLogs().catch(() => {});
});
