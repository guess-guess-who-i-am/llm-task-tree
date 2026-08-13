#!/usr/bin/env node
/**
 * MCP stdio front door for the task graph.
 *
 * Three front doors share one runtime: the web UI (server.js), the Codex/Cursor hooks,
 * and this MCP server. Read-only tools work straight off the files; every action that
 * already exists as an HTTP endpoint is proxied to the local server instead of being
 * reimplemented, so backups, focus protection, flow sync and version history keep
 * behaving exactly like they do in the UI.
 *
 * The local server is started on demand (headless, no browser) using the same env
 * contract as llm-task-tree-kit/open-task-tree.ps1.
 *
 * Zero dependencies so every installed project can run it without npm install.
 */
import "../public/tree-layout.js";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { locateProjectRoot } from "../server/turn-tracker.js";
import { findTree, loadTreeRegistry, resolveTreeFile } from "../server/tree-registry.js";
import { ACTIVE_METHOD_TREE_MAX_BYTES, inspectTreeFile, inspectTreeMarkdown, isTreeMarkdownPath, parseTreeNodeFields } from "../server/tree-quality.js";
import { buildExecutionCatalog, computeFlowDrift, getFlowScript } from "../server/flow-script.js";
import { renderGraphPng } from "../server/graph-render.js";
import { WIDGET_META, WIDGET_MIME, WIDGET_URI, widgetMeta } from "../server/graph-widget.js";
import { httpsPortFor, loadLocalTls } from "../server/local-tls.js";
import { widgetBundle } from "../server/widget-bundle.js";

const SERVER_NAME = "llm-task-tree";
const SERVER_VERSION = "0.2.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const NEXT_PLAN_WARNING = "GraphState.NextPlan 是用户备忘，可能过期，禁止执行；唯一执行依据是 Next 节点的 NextIdea。";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 40000;
const DEFAULT_EXECUTION_SCOPE = String(process.env.TASK_TREE_EXECUTION_SCOPE || "").trim();

function resolveProjectRoot() {
  const index = process.argv.indexOf("--project-root");
  const explicit = index >= 0 ? process.argv[index + 1] : "";
  return locateProjectRoot({
    cwd: explicit || process.cwd(),
    fallbackDir: explicit || process.cwd()
  });
}

const projectRoot = resolveProjectRoot();
const stubDir = path.join(projectRoot, "llm-task-tree");
const portFile = path.join(projectRoot, ".task-tree-port");
const knownPortsFile = path.join(projectRoot, ".task-tree-ports");

// ---------------------------------------------------------------- tree reading

async function activeTree() {
  const registryFile = path.join(projectRoot, "task-trees.json");
  const registry = await loadTreeRegistry({ projectRoot, registryFile, create: false });
  const tree = findTree(registry, registry.activeMethod);
  const file = tree ? resolveTreeFile(projectRoot, tree) : path.join(projectRoot, "task-tree.md");
  return {
    id: tree?.id || "",
    title: tree?.title || "",
    file,
    relative: path.relative(projectRoot, file).replace(/\\/g, "/")
  };
}

function graphStateFrom(markdown) {
  const text = String(markdown || "");
  const start = text.search(/^# GraphState\b/m);
  const tail = start >= 0 ? text.slice(start) : "";
  const edgesAt = tail.search(/^# Edges\b/m);
  const block = edgesAt > 0 ? tail.slice(0, edgesAt) : tail;
  // [^\S\r\n] instead of \s: on an empty field the latter crosses the newline
  // and reads the following line's text as this field's value.
  const read = (key) => block.match(new RegExp(`^-[^\\S\\r\\n]+${key}:[^\\S\\r\\n]*([^\\r\\n]*)$`, "m"))?.[1]?.trim() || "";
  return {
    current: read("Current"),
    next: read("Next"),
    chain: read("Chain"),
    chainRunStatus: read("ChainRunStatus"),
    chainForceNext: read("ChainForceNext")
  };
}

function fieldsOf(nodes, nodeId) {
  return nodes.find((node) => node.id === nodeId) || null;
}

async function treeMarkdownFiles() {
  const files = [];
  const active = await activeTree();
  files.push(active.relative);
  for (const dir of ["subtrees", "trees"]) {
    const full = path.join(projectRoot, dir);
    if (!existsSync(full)) continue;
    for (const name of await readdir(full)) {
      const rel = `${dir}/${name}`;
      if (isTreeMarkdownPath(rel) && !files.includes(rel)) files.push(rel);
    }
  }
  return files;
}

// ------------------------------------------------------- local server plumbing

function readPortList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

async function candidatePorts() {
  const ports = [];
  for (const file of [portFile, knownPortsFile]) {
    if (!existsSync(file)) continue;
    ports.push(...readPortList(await readFile(file, "utf8")));
  }
  ports.push(stablePort(), 5177);
  return [...new Set(ports)];
}

async function probePort(port, { timeoutMs = 1200 } = {}) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/project`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const project = await response.json();
    if (path.resolve(project.root || "") !== path.resolve(projectRoot)) return null;
    return { port, project };
  } catch {
    return null;
  }
}

async function findLivePort() {
  for (const port of await candidatePorts()) {
    const live = await probePort(port);
    if (live) {
      await rememberPort(port);
      return live;
    }
  }
  return null;
}

function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(preferred, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The same project should come back on the same URL every time.
 *
 * People bookmark this address in the desktop app's browser pane, and a bookmark that dies on
 * every restart is worse than no bookmark. The port is derived from the project root so two
 * projects on one machine land on different numbers without coordinating, inside the private
 * range above the 5177 the standalone launcher uses.
 */
function stablePort() {
  let hash = 0;
  for (const char of path.resolve(projectRoot).toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return 5178 + (hash % 800);
}

/** Prefers this project's stable port, but never fails over it being taken. */
async function claimPort() {
  try {
    return await freePort(stablePort());
  } catch {
    return freePort();
  }
}

/**
 * Locates the runtime that serves the UI: `server.js` plus the `public/` the widget is built from.
 *
 * This file's own package comes first, and in every layout that has ever worked that is also where
 * the other candidates point - the project stub imports the shared kit's copy of this script, so
 * "mine" and "the shared kit" are the same directory. What it adds is the plugin: there the runtime
 * travels inside the package, next to no project at all, and choosing it keeps the tools and the
 * page they render from the same build rather than pairing a new entry with whatever kit an old
 * install left behind.
 */
const ownKit = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function kitDir() {
  if (existsSync(path.join(ownKit, "server.js")) && existsSync(path.join(ownKit, "public"))) return ownKit;
  const configFile = path.join(stubDir, "task-tree.config.json");
  if (existsSync(configFile)) {
    try {
      // The stub config is written by PowerShell, so it can carry a UTF-8 BOM.
      const shared = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, "")).sharedKitDir;
      if (shared && existsSync(path.join(shared, "server.js"))) return shared;
    } catch {
      // fall through to the in-repo runtime
    }
  }
  if (existsSync(path.join(projectRoot, "server.js"))) return projectRoot;
  return "";
}

async function rememberPort(port) {
  const current = existsSync(portFile) ? readPortList(await readFile(portFile, "utf8")) : [];
  if (current.length !== 1 || current[0] !== port) await writeFile(portFile, `${port}\n`, "utf8");
  const known = existsSync(knownPortsFile) ? readPortList(await readFile(knownPortsFile, "utf8")) : [];
  if (!known.includes(port)) await appendFile(knownPortsFile, `${port}\n`, "utf8");
}

async function startServer() {
  const kit = await kitDir();
  if (!kit) throw new Error(`找不到任务图运行时（server.js）：检查 ${path.join(stubDir, "task-tree.config.json")}`);
  const port = await claimPort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: kit,
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      TASK_TREE_STUB_DIR: existsSync(stubDir) ? stubDir : "",
      TASK_TREE_PROJECT_ROOT: projectRoot
    },
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await probePort(port, { timeoutMs: 800 });
    if (live) {
      await rememberPort(port);
      return { ...live, started: true, kitDir: kit, pid: child.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`任务图服务在 ${START_TIMEOUT_MS / 1000}s 内没有起来（端口 ${port}，运行时 ${kit}）`);
}

/** The https listener only exists once a local certificate has been installed and trusted. */
function httpsPortOf(live) {
  const url = live?.project?.httpsUrl;
  if (!url) return 0;
  const port = Number(new URL(url).port);
  return Number.isInteger(port) && port > 0 ? port : 0;
}

let ensurePromise = null;

/**
 * Returns a live local server, starting a headless one when needed.
 *
 * The whole probe-then-start sequence is single-flight, not just the start: probing takes
 * hundreds of milliseconds, so a caller whose probe began before the first server was up
 * would otherwise see no server, find the start guard already cleared, and spawn a second one.
 */
async function ensureServer() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const live = await findLivePort();
      if (live) return { ...live, started: false };
      return startServer();
    })().finally(() => { ensurePromise = null; });
  }
  return ensurePromise;
}

/** One retry: a just-started server can drop the first request while it warms up. */
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      return await fetch(url, init);
    } catch {
      throw error;
    }
  }
}

async function api(method, endpoint, body) {
  const { port, started } = await ensureServer();
  const response = await fetchWithRetry(`http://${HOST}:${port}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // keep the raw text for non-JSON error pages
  }
  if (!response.ok) {
    const detail = typeof payload === "object" ? payload?.error || JSON.stringify(payload) : String(payload).slice(0, 300);
    throw new Error(`${method} ${endpoint} 失败（HTTP ${response.status}）：${detail}`);
  }
  return { payload, port, startedServer: started };
}

function requestedScopeId(args) {
  return String(args?.scopeId || DEFAULT_EXECUTION_SCOPE || "").trim();
}

async function readExecutionScope(scopeId) {
  if (!scopeId) return null;
  try {
    return (await api("GET", `/api/execution-scopes/${encodeURIComponent(scopeId)}`)).payload.scope || null;
  } catch (error) {
    return { scopeId, status: "invalid", error: error.message, targetNodeIds: [], writableNodeIds: [] };
  }
}

/**
 * The embedded UI's only way to reach its own backend.
 *
 * The chat sandbox is barred from making any network request to a loopback address, so the page
 * cannot call its API directly. This carries the request over the tool bridge instead and hands
 * back enough to rebuild a Response, which keeps the page's HTTP semantics - including the focus
 * protection that keys on `source: "ui"` - exactly as they are in a browser.
 */
/**
 * Whether the embedded page came alive is invisible from outside the host; this is the one trace it
 * leaves behind. A live page polls, so the log is capped rather than left to grow.
 */
async function noteBridgeCall(method, endpoint) {
  const file = path.join(stubDir, "api-bridge-log.txt");
  try {
    const size = existsSync(file) ? (await stat(file)).size : 0;
    const line = `${new Date().toISOString()} ${method} ${endpoint}\n`;
    if (size > 262144) await writeFile(file, line, "utf8");
    else await appendFile(file, line, "utf8");
  } catch {
    // A diagnostic must never be the reason a request fails.
  }
}

async function toolApi(args) {
  const method = String(args?.method || "GET").toUpperCase();
  const endpoint = String(args?.path || "");
  if (!endpoint.startsWith("/api/")) {
    return { status: 400, contentType: "application/json", body: JSON.stringify({ error: "只允许 /api/ 开头的路径" }) };
  }
  const { port } = await ensureServer();
  await noteBridgeCall(method, endpoint);
  const body = args?.body === undefined || args?.body === null ? undefined : String(args.body);
  const response = await fetchWithRetry(`http://${HOST}:${port}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(300000)
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "application/json",
    body: await response.text()
  };
}

// -------------------------------------------------------------- node patching

const FIELD_LINE = /^-\s+([A-Za-z]+):/;

function nodeSectionRange(lines, nodeId) {
  const escaped = String(nodeId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escaped}\\s+-`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s+\S+\s+-/.test(lines[end]) && !/^#\s+(GraphState|Edges)\b/.test(lines[end])) end += 1;
  return { start, end };
}

function renderFieldValue(field, value) {
  const text = String(value ?? "").replace(/\r/g, "");
  if (!text.includes("\n")) return [`- ${field}: ${text}`.trimEnd()];
  const parts = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return [`- ${field}:`, ...parts.map((line) => (line.startsWith("- ") ? `  ${line}` : `  - ${line}`))];
}

/** Replaces whole fields of one node, keeping every other line untouched. */
function patchNodeFields(markdown, nodeId, fields) {
  const lines = String(markdown).replace(/\r/g, "").split("\n");
  const range = nodeSectionRange(lines, nodeId);
  if (!range) throw new Error(`任务树里没有节点 ${nodeId}`);
  const section = lines.slice(range.start, range.end);
  const applied = [];

  for (const [field, value] of Object.entries(fields)) {
    const at = section.findIndex((line) => new RegExp(`^-\\s+${field}:`).test(line));
    const rendered = renderFieldValue(field, value);
    if (at >= 0) {
      let stop = at + 1;
      while (stop < section.length && !FIELD_LINE.test(section[stop]) && section[stop].trim()) stop += 1;
      section.splice(at, stop - at, ...rendered);
    } else {
      let insertAt = section.findIndex((line) => /^-\s+SelectedSkills:/.test(line));
      if (insertAt < 0) {
        insertAt = section.length;
        while (insertAt > 0 && !section[insertAt - 1].trim()) insertAt -= 1;
      }
      section.splice(insertAt, 0, ...rendered);
    }
    applied.push(field);
  }

  lines.splice(range.start, range.end - range.start, ...section);
  return { markdown: lines.join("\n"), applied };
}

// -------------------------------------------------------------------- tools

async function toolFocus(args) {
  const tree = await activeTree();
  if (!existsSync(tree.file)) {
    return { error: `没有找到任务树：${tree.relative}。当前工作区可能不是任务图项目。`, projectRoot };
  }
  const markdown = await readFile(tree.file, "utf8");
  const state = graphStateFrom(markdown);
  const nodes = parseTreeNodeFields(markdown);
  const executionScope = await readExecutionScope(requestedScopeId(args));
  const describe = (nodeId) => {
    const node = fieldsOf(nodes, nodeId);
    if (!node) return null;
    return {
      id: node.id,
      title: node.title,
      completion: (node.fields.Completion || "").trim(),
      problem: (node.fields.Problem || "").trim(),
      nextIdea: (node.fields.NextIdea || "").trim(),
      selectedSkills: (node.fields.SelectedSkills || "").trim(),
      subtreeFile: (node.fields.SubtreeFile || "").trim()
    };
  };
  const assignedNodes = (executionScope?.targetNodeIds || []).map(describe).filter(Boolean);
  return {
    projectRoot,
    activeTree: { id: tree.id, title: tree.title, file: tree.relative },
    graphState: { current: state.current, next: state.next, chain: state.chain, chainRunStatus: state.chainRunStatus, chainForceNext: state.chainForceNext },
    currentNode: describe(state.current),
    nextNode: describe(state.next),
    executionScope,
    assignedNodes,
    executionTarget: assignedNodes[0] || describe(state.next),
    executionRule: executionScope?.status === "active"
      ? "用户最新要求 > 本 Agent 执行范围 > 全局 GraphState.Next。只执行 assignedNodes，不把全局 Next 当作本 Agent 目标。"
      : NEXT_PLAN_WARNING,
    nodeCount: nodes.length
  };
}

async function toolNode(args) {
  const nodeId = String(args?.nodeId || "").trim();
  if (!nodeId) return { error: "缺少 nodeId。" };
  for (const rel of await treeMarkdownFiles()) {
    const full = path.join(projectRoot, rel);
    if (!existsSync(full)) continue;
    const node = fieldsOf(parseTreeNodeFields(await readFile(full, "utf8")), nodeId);
    if (!node) continue;
    const fields = {};
    for (const [key, value] of Object.entries(node.fields)) {
      if (key === "Position" || key === "Size" || key === "ReadFingerprint") continue;
      const text = String(value || "").trim();
      if (text) fields[key] = text;
    }
    return { projectRoot, file: rel, id: node.id, title: node.title, fields };
  }
  return { error: `任务树里没有节点 ${nodeId}。`, searched: await treeMarkdownFiles() };
}

async function toolCheckCompact(args) {
  const requested = Array.isArray(args?.files) ? args.files : [];
  const files = requested
    .map((item) => String(item || "").replace(/\\/g, "/"))
    .map((item) => path.isAbsolute(item) ? path.relative(projectRoot, item).replace(/\\/g, "/") : item)
    .filter(isTreeMarkdownPath);
  const active = await activeTree();
  const targets = files.length ? [...new Set(files)] : [active.relative];
  const reports = [];
  for (const file of targets) {
    const report = await inspectTreeFile(projectRoot, file, {
      maxBytes: file === active.relative ? ACTIVE_METHOD_TREE_MAX_BYTES : 0
    });
    if (report) reports.push(report);
  }
  if (!reports.length) return { error: `没有可检查的任务树：${targets.join(", ")}` };
  const violations = reports.flatMap((report) => report.violations);
  const longLines = reports.flatMap((report) => report.longLines.map((item) => ({ ...item, file: report.file })));
  return {
    ok: violations.length === 0 && longLines.length === 0,
    projectRoot,
    checked: reports.map((report) => ({
      file: report.file,
      bytes: report.bytes,
      lines: report.lines,
      nodes: report.nodes,
      overBudgetFields: report.budgetViolations,
      styleViolations: report.styleViolations,
      longLines: report.longLines.length
    })),
    violations,
    longLines,
    rule: "节点必须精炼并默认使用简明中文；代码、命令、公式、原始数据和复杂英文术语移到证据文件；禁止机械截断。"
  };
}

async function toolFlowStatus() {
  const tree = await activeTree();
  const scriptsDir = path.join(projectRoot, "scripts");
  if (!existsSync(path.join(scriptsDir, "project.json"))) {
    return { error: "没有 scripts/project.json，本项目还没有执行流程脚本。", projectRoot };
  }
  const catalog = await buildExecutionCatalog({
    projectRoot,
    treeFile: tree.file,
    subtreesDir: path.join(projectRoot, "subtrees")
  });
  // No catalog for getFlowScript on purpose: it auto-writes project.json when given one.
  const { script } = await getFlowScript({ scriptsDir, mode: "project" });
  const drift = computeFlowDrift(catalog, script.blocks || []);
  const markdown = existsSync(tree.file) ? await readFile(tree.file, "utf8") : "";
  return {
    projectRoot,
    activeTree: tree.relative,
    focusId: script.focusId || "",
    graphState: graphStateFrom(markdown),
    blocks: (script.blocks || []).map((block) => ({
      type: block.type,
      nodeId: block.nodeId || "",
      title: block.title || "",
      status: block.status || ""
    })),
    drift,
    rule: "执行顺序以 scripts/project.json 为准，不要用节点 ID 排序或画布位置推断。"
  };
}

async function toolServer(args) {
  const action = String(args?.action || "status");
  if (action === "status") {
    const live = await findLivePort();
    return live
      ? { running: true, port: live.port, url: `http://${HOST}:${live.port}`, httpsUrl: live.project?.httpsUrl || null, project: live.project }
      : { running: false, hint: "用 action=start 拉起，或 action=open 直接打开界面。" };
  }
  if (action === "start") {
    const live = await ensureServer();
    return {
      running: true,
      port: live.port,
      url: `http://${HOST}:${live.port}`,
      httpsUrl: live.project?.httpsUrl || null,
      startedNow: Boolean(live.started)
    };
  }
  if (action === "open") {
    const live = await ensureServer();
    const launcher = path.join(stubDir, process.platform === "win32" ? "open-task-tree.ps1" : "open-task-tree.sh");
    let opened = "browser";
    if (process.platform === "win32" && existsSync(launcher)) {
      spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-StubDir", stubDir], {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(command, [`http://${HOST}:${live.port}`], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      opened = "fallback";
    }
    return { running: true, port: live.port, url: `http://${HOST}:${live.port}`, opened, note: "界面在用户桌面上打开，模型看不到画面；数据请用其他工具读。" };
  }
  // The widget runs inside the host's sandbox, where a failure is invisible from here. This is its
  // only way to tell the project what stopped it.
  if (action === "report") {
    const file = path.join(stubDir, "widget-report.json");
    // Host policies run to several kilobytes each, and truncating them is what hid the directive
    // that mattered the first time round.
    const entry = { at: new Date().toISOString(), report: String(args?.report || "").slice(0, 40000) };
    await mkdir(stubDir, { recursive: true });
    await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return { recorded: true, file: path.relative(projectRoot, file).replace(/\\/g, "/") };
  }
  if (action === "stop") {
    const live = await findLivePort();
    if (!live)     return { running: false, stopped: false };
    await api("POST", "/api/shutdown", {});
    return { running: false, stopped: true, port: live.port };
  }
  return { error: `未知 action：${action}（可用 status/start/open/stop/report）` };
}

async function openDesktopUrl(url) {
  // Tests capture the exact URL instead of opening a real browser. Production never sets this.
  const capture = String(process.env.TASK_TREE_OPEN_CAPTURE || "").trim();
  if (capture) {
    await writeFile(capture, `${url}\n`, "utf8");
    return "capture";
  }

  const [command, args] = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {});
  child.unref();
  return "browser";
}

async function toolOpen(args) {
  const { port } = await ensureServer();
  const tree = String(args?.tree || "").trim();
  const focus = await toolFocus().catch(() => null);
  const url = `http://${HOST}:${port}${tree ? `/?tree=${encodeURIComponent(tree)}` : "/"}`;
  await openDesktopUrl(url);

  return {
    // Keep the widget link for hosts that preserve MCP Apps metadata. The browser launch is the
    // reliable path for Codex builds whose deferred tool bridge rebuilds results as text/images.
    mcpContent: [{
      type: "text",
      text: [
        `任务图已在桌面浏览器打开：${url}`,
        `如果下方同时出现嵌入界面，也可以直接在对话里拖节点、改字段、切执行流程视图。`,
        focus && !focus.error
          ? `当前 Current ${focus.currentNode?.id || "-"}，Next ${focus.nextNode?.id || "-"}，共 ${focus.nodeCount} 个节点。`
          : ""
      ].filter(Boolean).join("\n")
    }],
    mcpMeta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI }
  };
}

async function toolRender(args) {
  const { port } = await ensureServer();
  const width = clampNumber(args?.width, 900, 2400, 1680);
  const height = clampNumber(args?.height, 700, 2000, 1050);
  const scale = clampNumber(args?.scale, 1, 2, 1.5);
  const tree = String(args?.tree || "").trim();

  const shot = await renderGraphPng({ url: `http://${HOST}:${port}`, width, height, scale, tree });
  const focus = await toolFocus().catch(() => null);
  const label = (node) => (node ? `${node.id} ${node.title}` : "-");
  const caption = focus && !focus.error
    ? [
      `任务图：${focus.activeTree?.title || focus.activeTree?.id || "活动方法树"}（${focus.nodeCount} 个节点）`,
      `Current ${label(focus.currentNode)}`,
      `Next ${label(focus.nextNode)}`
    ].join("\n")
    : "任务图";

  return {
    // Image first: older Codex builds only picked up the image when no text preceded it.
    // No structuredContent either — Codex drops content[] when it is present (openai/codex#10334).
    mcpContent: [
      { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `${caption}\n${shot.width}x${shot.height}px，与界面同一份渲染。要交互（拖拽/编辑/知识库）用 task_tree_server action=open。` }
    ]
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function toolWrite(args) {
  const reason = String(args?.reason || "").trim();
  if (!reason) return { error: "缺少 reason：写树必须说明原因，会写进 versions/ 备份名。" };
  const tree = await activeTree();
  const scopeId = requestedScopeId(args);
  if (scopeId && typeof args?.markdown === "string" && args.markdown.trim()) {
    return { error: "带执行范围的 Agent 禁止整棵树覆盖；请用 {nodeId, fields} 写入获授权节点。" };
  }
  const current = existsSync(tree.file) ? await readFile(tree.file, "utf8") : "";
  let next = "";
  let applied = [];

  if (typeof args?.markdown === "string" && args.markdown.trim()) {
    next = args.markdown;
    applied = ["<whole markdown>"];
  } else {
    const nodeId = String(args?.nodeId || "").trim();
    const fields = args?.fields && typeof args.fields === "object" ? args.fields : null;
    if (!nodeId || !fields || !Object.keys(fields).length) {
      return { error: "需要 {nodeId, fields} 或 {markdown} 之一。" };
    }
    for (const key of Object.keys(fields)) {
      if (/^(Current|Next|NextPlan|Chain|ChainForceNext)$/.test(key)) {
        return { error: `${key} 属于 GraphState，不能通过节点字段写入；焦点由用户在 UI 指定。` };
      }
    }
    try {
      const patched = patchNodeFields(current, nodeId, fields);
      next = patched.markdown;
      applied = patched.applied;
    } catch (error) {
      return { error: error.message };
    }
  }

  const gate = inspectTreeMarkdown(next, { file: tree.relative, maxBytes: ACTIVE_METHOD_TREE_MAX_BYTES });
  if (gate.violations.length || gate.longLines.length) {
    return {
      error: "精炼门禁不通过，已拒绝写入。请把字段改写成更短的当前状态后重试。",
      violations: gate.violations,
      longLines: gate.longLines,
      rule: "禁止机械截断：保留结论/数字/风险；节点改用简明中文，代码和复杂英文术语移到证据文件。"
    };
  }

  const writeBody = typeof args?.markdown === "string" && args.markdown.trim()
    ? { markdown: next, reason }
    : { nodeId: String(args.nodeId).trim(), fields: args.fields, reason, ...(scopeId ? { scopeId } : {}) };
  const endpoint = writeBody.markdown ? "/api/tree" : "/api/tree/node-patch";
  const { payload, startedServer } = await api(writeBody.markdown ? "PUT" : "POST", endpoint, writeBody);
  const persisted = existsSync(tree.file) ? await readFile(tree.file, "utf8") : next;
  const after = inspectTreeMarkdown(persisted, { file: tree.relative, maxBytes: ACTIVE_METHOD_TREE_MAX_BYTES });
  return {
    ok: true,
    file: tree.relative,
    applied,
    changes: Array.isArray(payload.changes) ? payload.changes : [],
    changedNodeIds: Array.isArray(payload.changedNodeIds) ? payload.changedNodeIds : [],
    executionScope: payload.executionScope || null,
    reason,
    flowSync: payload.flowSync,
    compact: { nodes: after.nodes, bytes: after.bytes, overBudgetFields: after.budgetViolations, styleViolations: after.styleViolations, longLines: 0 },
    startedServer,
    note: "changes 是服务端按实际落盘前后状态生成的真实差异；用户回执必须据此列出节点、字段、旧值 → 新值。节点补丁在服务端串行并基于最新树应用，执行范围会拒绝越权节点。"
  };
}

async function toolScope(args) {
  const action = String(args?.action || "get");
  const scopeId = requestedScopeId(args);
  if (action === "get") {
    if (!scopeId) return { error: "缺少 scopeId，且当前环境没有 TASK_TREE_EXECUTION_SCOPE。" };
    return (await api("GET", `/api/execution-scopes/${encodeURIComponent(scopeId)}`)).payload;
  }
  if (action === "close") {
    if (!scopeId) return { error: "close 需要 scopeId。" };
    return (await api("POST", `/api/execution-scopes/${encodeURIComponent(scopeId)}/close`, {})).payload;
  }
  if (action === "create") {
    const targetNodeIds = Array.isArray(args?.targetNodeIds) ? args.targetNodeIds : [];
    if (!targetNodeIds.length) return { error: "create 至少需要一个 targetNodeId。" };
    return (await api("POST", "/api/execution-scopes", {
      targetNodeIds,
      writableNodeIds: Array.isArray(args?.writableNodeIds) ? args.writableNodeIds : targetNodeIds,
      writeSet: Array.isArray(args?.writeSet) ? args.writeSet : [],
      role: args?.role || "agent",
      instruction: args?.instruction || "",
      treeId: args?.treeId || ""
    })).payload;
  }
  return { error: `未知 action：${action}` };
}

async function toolChain(args) {
  const action = String(args?.action || "step");
  const subtree = String(args?.subtree || "").trim();
  if (action === "step") {
    const query = subtree ? `?subtree=${encodeURIComponent(subtree)}` : "";
    const { payload } = await api("GET", `/api/graph-state/chain-step${query}`);
    return payload;
  }
  if (action === "advance") {
    const { payload } = await api("POST", "/api/graph-state/chain-advance", {
      subtree: subtree || undefined,
      force: args?.force === true,
      reason: args?.reason || "将链式推进GraphState"
    });
    return payload;
  }
  if (action === "force_next") {
    const nextId = String(args?.nextId || "").trim();
    if (!nextId) return { error: "force_next 需要 nextId。" };
    const { payload } = await api("POST", "/api/graph-state/chain-force-next", {
      nextId,
      reason: args?.reason || `将强制下一步设为${nextId}`
    });
    return payload;
  }
  return { error: `未知 action：${action}（可用 step/advance/force_next）` };
}

async function toolSubtree(args) {
  const action = String(args?.action || "read");
  const target = String(args?.path || "").trim();
  if (action === "read") {
    if (!target) return { error: "read 需要 path，例如 subtrees/N6-subtree.md。" };
    const { payload } = await api("GET", `/api/subtree-file?path=${encodeURIComponent(target)}`);
    return payload;
  }
  if (action === "context") {
    if (!target) return { error: "context 需要 path。" };
    const { payload } = await api("GET", `/api/subtree-file/agent-context?path=${encodeURIComponent(target)}`);
    return payload;
  }
  if (action === "write") {
    if (!target || typeof args?.markdown !== "string") return { error: "write 需要 path 与 markdown。" };
    const gate = inspectTreeMarkdown(args.markdown, { file: target });
    if (gate.violations.length || gate.longLines.length) {
      return { error: "子树未过精炼门禁，已拒绝写入。", violations: gate.violations, longLines: gate.longLines };
    }
    const { payload } = await api("POST", "/api/subtree-file", {
      path: target,
      markdown: args.markdown,
      reason: args?.reason || `将保存子树${target}`
    });
    return payload;
  }
  if (action === "sync_stub") {
    if (!target) return { error: "sync_stub 需要 path。" };
    const { payload } = await api("POST", "/api/subtree-file/sync-stub", {
      path: target,
      foldRoot: args?.foldRoot || undefined,
      reason: args?.reason || `将同步子树${target}摘要到主树stub`
    });
    return payload;
  }
  if (action === "unfold") {
    if (!target) return { error: "unfold 需要 path。" };
    const reason = args?.reason || `将展开子树${target}`;
    const { payload } = await api("DELETE", `/api/subtree-file?path=${encodeURIComponent(target)}&reason=${encodeURIComponent(reason)}`);
    return { ...payload, note: "只删除子树文件；主树 stub 需要你先用 write 把展开后的节点写回。" };
  }
  return { error: `未知 action：${action}（可用 read/context/write/sync_stub/unfold）` };
}

async function toolVersions(args) {
  const action = String(args?.action || "list");
  if (action === "list") {
    const { payload } = await api("GET", "/api/versions");
    return { versions: (payload.versions || []).slice(0, Number(args?.limit) || 20), total: (payload.versions || []).length };
  }
  if (action === "restore") {
    const name = String(args?.name || "").trim();
    if (!name) return { error: "restore 需要 name（版本文件名，用 action=list 查）。" };
    const { payload } = await api("POST", "/api/restore", { name });
    return { ok: payload.ok !== false, restored: name, versions: (payload.versions || []).slice(0, 5) };
  }
  return { error: `未知 action：${action}（可用 list/restore）` };
}

async function toolKnowledge(args) {
  const action = String(args?.action || "search");
  const query = String(args?.query || args?.question || "").trim();
  if (action === "status") {
    const { payload } = await api("GET", "/api/knowledge/config");
    return { index: payload.index, webSearch: payload.webSearch, openWebSearch: payload.openWebSearch };
  }
  if (!query) return { error: "需要 query（或 question）。" };
  if (action === "search") {
    const { payload } = await api("POST", "/api/knowledge/search", {
      query,
      topK: args?.topK,
      includeWeb: args?.includeWeb === true,
      libraryIds: Array.isArray(args?.libraryIds) ? args.libraryIds : undefined
    });
    return payload;
  }
  if (action === "ask") {
    const { payload } = await api("POST", "/api/knowledge/ask", {
      question: query,
      topK: args?.topK,
      includeWeb: args?.includeWeb === true,
      modelId: args?.modelId || undefined,
      libraryIds: Array.isArray(args?.libraryIds) ? args.libraryIds : undefined
    });
    return payload;
  }
  if (action === "web") {
    const { payload } = await api("POST", "/api/web-search/search", { query, topK: args?.topK });
    return payload;
  }
  if (action === "reindex") {
    const { payload } = await api("POST", "/api/knowledge/reindex", { all: args?.all === true, libraryId: args?.libraryId });
    return payload;
  }
  return { error: `未知 action：${action}（可用 search/ask/web/status/reindex）` };
}

async function toolModels(args) {
  const action = String(args?.action || "list");
  if (action === "list") {
    const { payload } = await api("GET", "/api/model-agents");
    const models = (payload.models || []).map((item) => ({
      id: item.id,
      name: item.name || item.label || item.id,
      model: item.model,
      enabled: item.enabled !== false
    }));
    return { models, count: models.length };
  }
  if (action === "health") {
    const { payload } = await api("GET", "/api/model-agents/health");
    return payload;
  }
  if (action === "run") {
    const modelIds = Array.isArray(args?.modelIds) ? args.modelIds.filter(Boolean) : [];
    const question = String(args?.question || "").trim();
    if (!modelIds.length || !question) return { error: "run 需要 modelIds[] 与 question。" };
    const { payload } = await api("POST", "/api/model-agents/run", {
      modelIds,
      question,
      nodeId: args?.nodeId || "",
      contextNodeIds: Array.isArray(args?.contextNodeIds) ? args.contextNodeIds : undefined,
      useKnowledgeSearch: args?.useKnowledgeSearch === true,
      includeWeb: args?.includeWeb === true
    });
    return payload;
  }
  return { error: `未知 action：${action}（可用 list/health/run）` };
}

async function toolSkills(args) {
  const nodeId = String(args?.nodeId || "").trim();
  const query = String(args?.query || "").trim();
  // recommendSkills reads {node:{...}, nextIdea, nextPlan} — same shape the UI sends.
  const body = { nextPlan: query, node: {} };
  if (nodeId) {
    const node = await toolNode({ nodeId });
    if (!node.error) {
      body.node = {
        title: node.title || "",
        problem: node.fields?.Problem || "",
        approach: node.fields?.Approach || "",
        metrics: node.fields?.Metrics || "",
        notes: node.fields?.Notes || ""
      };
      body.nextIdea = node.fields?.NextIdea || "";
    }
  }
  const { payload } = await api("POST", "/api/skills/recommend", body);
  const limit = Number(args?.limit) > 0 ? Number(args.limit) : 8;
  return {
    recommendations: (payload.recommendations || []).slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      functionText: item.functionText,
      highlightText: item.highlightText,
      matchText: item.matchText
    })),
    note: "SelectedSkills 由用户在 UI 勾选；这里只给候选，不写回树。"
  };
}

/** Parses `# Edges` sections: the node parser skips them on purpose. */
function parseTreeEdges(markdown) {
  const edges = [];
  let inEdges = false;
  let edge = null;
  for (const line of String(markdown || "").replace(/\r/g, "").split("\n")) {
    if (/^#\s+Edges\b/.test(line)) { inEdges = true; continue; }
    if (/^#\s+(GraphState|LLM Task Graph)\b/.test(line)) { inEdges = false; continue; }
    if (!inEdges) continue;
    const heading = line.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (heading) {
      edge = { id: heading[1], endpoints: [] };
      edges.push(edge);
      continue;
    }
    const endpoints = edge && line.match(/^-\s+Endpoints:\s*(.*)$/);
    if (endpoints) {
      edge.endpoints = endpoints[1].split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return edges.filter((item) => item.endpoints.length >= 2);
}

function parseSizePair(value, fallback) {
  const parts = String(value || "").split(/[,，]/).map((item) => Number.parseFloat(item.trim()));
  return {
    width: Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : fallback.width,
    height: Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : fallback.height
  };
}

async function toolLayout(args) {
  const { TaskTreeLayout } = globalThis;
  if (!TaskTreeLayout) return { error: "布局模块未加载（public/tree-layout.js）。" };
  const tree = await activeTree();
  if (!existsSync(tree.file)) return { error: `没有找到任务树：${tree.relative}` };
  const markdown = await readFile(tree.file, "utf8");
  const nodes = parseTreeNodeFields(markdown);
  if (!nodes.length) return { error: "任务树里没有节点。" };

  const fallback = { width: 520, height: 720 };
  const sizes = new Map(nodes.map((node) => [node.id, parseSizePair(node.fields.Size, fallback)]));
  const rootId = nodes.some((node) => node.id === "ROOT") ? "ROOT" : nodes[0].id;
  const adjacency = TaskTreeLayout.buildSpanningTreeAdjacency({
    nodeIds: nodes.map((node) => node.id),
    edges: parseTreeEdges(markdown),
    rootId
  });
  const placements = TaskTreeLayout.layoutContourTree({
    rootId,
    adjacency,
    widthOf: (id) => sizes.get(id)?.width || fallback.width,
    heightOf: (id) => sizes.get(id)?.height || fallback.height,
    left: Number(args?.left) || 70,
    top: Number(args?.top) || 70,
    defaults: fallback
  });

  const positions = {};
  let patched = markdown;
  for (const [id, point] of placements) {
    const value = `${Math.round(point.x)},${Math.round(point.y)}`;
    positions[id] = value;
    if (args?.dryRun !== true) patched = patchNodeFields(patched, id, { Position: value }).markdown;
  }

  const note = "纵向间距按节点保存的 Size 计算；UI 里点「自动整理」用的是当前紧凑显示高度，行距可能略有差异。";
  if (args?.dryRun === true) {
    return { dryRun: true, rootId, nodeCount: placements.size, positions, note };
  }
  const { payload } = await api("PUT", "/api/tree", {
    markdown: patched,
    reason: args?.reason || "将按轮廓算法自动整理节点位置"
  });
  return {
    ok: true,
    rootId,
    moved: placements.size,
    file: tree.relative,
    positions,
    flowSync: payload.flowSync,
    note: `${note} 已打开的界面需要刷新（Ctrl+F5）才会看到新位置。`
  };
}

async function toolFlowWrite(args) {
  const action = String(args?.action || "sync_status");
  if (action === "sync_status") {
    const { payload } = await api("POST", "/api/flow-script/sync-status", { mode: "project" });
    return payload;
  }
  if (action === "rebuild") {
    const { payload } = await api("POST", "/api/flow-script/rebuild", { mode: "project", reason: args?.reason || "将按任务图重排执行流程" });
    return payload;
  }
  if (action === "write_step") {
    const nodeId = String(args?.nodeId || "").trim();
    if (!nodeId || !args?.step) return { error: "write_step 需要 nodeId 与 step 对象。" };
    const { payload } = await api("PUT", "/api/flow-step", {
      nodeId,
      step: args.step,
      reason: args?.reason || `更新${nodeId}步骤审计包`
    });
    return payload;
  }
  if (action === "drift") {
    const { payload } = await api("GET", "/api/flow-script/drift?mode=project");
    return payload;
  }
  return { error: `未知 action：${action}（可用 sync_status/rebuild/write_step/drift）` };
}

const TOOLS = [
  {
    name: "task_tree_scope",
    description: "多 Agent 执行范围：create 为一个会话分配目标节点和可写节点，get 查看，close 关闭。把返回的 scopeId 传给 task_tree_focus/task_tree_write；内置 coordinator 会自动注入。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "get", "close"] },
        scopeId: { type: "string" },
        treeId: { type: "string" },
        role: { type: "string" },
        targetNodeIds: { type: "array", items: { type: "string" } },
        writableNodeIds: { type: "array", items: { type: "string" } },
        writeSet: { type: "array", items: { type: "string" } },
        instruction: { type: "string" }
      },
      additionalProperties: false
    },
    handler: toolScope
  },
  {
    name: "task_tree_focus",
    description: "读取当前任务图焦点；若提供 scopeId 或环境中有 TASK_TREE_EXECUTION_SCOPE，则优先返回本 Agent 的 assignedNodes，全球 GraphState.Next 只作项目背景。",
    inputSchema: { type: "object", properties: { scopeId: { type: "string", description: "当前 Agent 的执行范围 ID；内置并行运行会自动注入" } }, additionalProperties: false },
    handler: toolFocus
  },
  {
    name: "task_tree_node",
    description: "按节点 ID 读取任务图节点的全部字段（Problem/Approach/Input/Output/Metrics/CurrentResult/RootCauseAnalysis/NextIdea 等）。会自动在主树、subtrees/ 和 trees/ 中查找。只读。",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", description: "节点 ID，例如 ROOT、N2、N11、ST-P1" } },
      required: ["nodeId"],
      additionalProperties: false
    },
    handler: toolNode
  },
  {
    name: "task_tree_check_compact",
    description: "跑任务树精炼门禁：活动方法树须 <=12 KiB，并检查字段预算、长行、节点代码和英文长段。ok=false 表示本轮不能结束，要继续精炼、中文化或移动证据。只读。",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "要检查的树文件相对路径；留空则检查活动方法树"
        }
      },
      additionalProperties: false
    },
    handler: toolCheckCompact
  },
  {
    name: "task_tree_flow_status",
    description: "读取执行流程状态：scripts/project.json 的块顺序与状态，加上相对任务树的漂移（缺块、多块、状态过期、顺序不一致）。只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: toolFlowStatus
  },
  {
    name: "task_tree_write",
    description: "写任务树。传 {nodeId, fields:{CurrentResult, RootCauseAnalysis, ...}} 改指定节点字段，或传 {markdown} 覆盖整棵树。写前自动跑精炼门禁（不过就拒绝），写入走服务端 PUT /api/tree，因此自动备份到 versions/ 并同步 flow 状态；响应的 changes 是实际落盘差异，必须据此向用户报告节点、字段、旧值 → 新值；GraphState 的 Current/Next/NextPlan 受服务端保护，不会被改。reason 必填。",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "要改的节点 ID" },
        fields: { type: "object", description: "字段名到新值的映射，值可用 \\n 分行写多个 bullet" },
        markdown: { type: "string", description: "整棵树的新 markdown（与 nodeId/fields 二选一）" },
        scopeId: { type: "string", description: "当前 Agent 的执行范围 ID；存在时只能写获授权节点且禁止整树覆盖" },
        reason: { type: "string", description: "备份原因，例如 将更新N12的CurrentResult" }
      },
      required: ["reason"],
      additionalProperties: false
    },
    handler: toolWrite
  },
  {
    name: "task_tree_chain",
    description: "链式循环：action=step 取当前该做的一步（Next 节点 + NextIdea + 是否该停），action=advance 沿 Chain 推进一步（服务端会备份并写回 GraphState），action=force_next 强制指定下一节点。每轮只做一步。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["step", "advance", "force_next"] },
        subtree: { type: "string", description: "子树相对路径，只在子树链里用" },
        nextId: { type: "string", description: "force_next 的目标节点 ID" },
        force: { type: "boolean", description: "advance 时忽略未完成检查" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    handler: toolChain
  },
  {
    name: "task_tree_subtree",
    description: "子树读写与折叠：read 读子树、context 取子树 Agent 上下文、write 写子树（同样过门禁）、sync_stub 把子树摘要同步回主树 stub（这是折叠的收尾）、unfold 删除子树文件。写入响应的 changes 是实际差异，必须据此向用户报告节点、字段、旧值 → 新值。折叠一个节点 = 先 write 子树文件，再 sync_stub。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "context", "write", "sync_stub", "unfold"] },
        path: { type: "string", description: "子树相对路径，例如 subtrees/N6-subtree.md" },
        markdown: { type: "string" },
        foldRoot: { type: "string", description: "折叠根节点 ID，留空则从子树内容推断" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    handler: toolSubtree
  },
  {
    name: "task_tree_versions",
    description: "版本历史：list 列出 versions/ 里的备份，restore 回退到指定备份（回退前服务端会先存当前状态）。回退后当前树即权威状态，文件系统里没被树记录的产物按漂移处理。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "restore"] },
        name: { type: "string", description: "版本文件名" },
        limit: { type: "number" }
      },
      additionalProperties: false
    },
    handler: toolVersions
  },
  {
    name: "task_tree_knowledge",
    description: "本地 Markdown 知识库与联网检索：search 向量+词法检索、ask 带引用问答（用配置的 chat 模型）、web 只联网搜、status 看索引状态、reindex 重建索引。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "ask", "web", "status", "reindex"] },
        query: { type: "string" },
        question: { type: "string" },
        topK: { type: "number" },
        includeWeb: { type: "boolean" },
        modelId: { type: "string" },
        libraryIds: { type: "array", items: { type: "string" } },
        libraryId: { type: "string" },
        all: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: toolKnowledge
  },
  {
    name: "task_tree_models",
    description: "节点内多模型协作：list 看已配置的 OpenAI 兼容模型、health 探活、run 让多个模型基于指定节点上下文并行回答（可选自动检索知识库/联网）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "health", "run"] },
        modelIds: { type: "array", items: { type: "string" } },
        question: { type: "string" },
        nodeId: { type: "string" },
        contextNodeIds: { type: "array", items: { type: "string" } },
        useKnowledgeSearch: { type: "boolean" },
        includeWeb: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: toolModels
  },
  {
    name: "task_tree_skills",
    description: "按节点意图推荐本地 skill：跨项目/kit/全局目录召回后去重，返回用途、亮点和命中原因。只给候选，不写回 SelectedSkills。",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" }
      },
      additionalProperties: false
    },
    handler: toolSkills
  },
  {
    name: "task_tree_flow_write",
    description: "执行流程写入：sync_status 把块状态对齐节点 Completion、rebuild 按任务图重排块、write_step 写 scripts/steps/<nodeId>/latest/step.json、drift 取漂移详情。改了 Problem/Approach/结构/顺序后用。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sync_status", "rebuild", "write_step", "drift"] },
        nodeId: { type: "string" },
        step: { type: "object" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    handler: toolFlowWrite
  },
  {
    name: "task_tree_layout",
    description: "自动整理画布：用界面同一份轮廓算法（public/tree-layout.js）算出每个节点的位置并写回 Position，横向按相邻卡片宽度收紧、纵向按每层最高卡片对齐。dryRun=true 只返回坐标不写文件。写入后已打开的界面要刷新才能看到。",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "只算不写" },
        left: { type: "number", description: "根节点左边距，默认 70" },
        top: { type: "number", description: "根节点上边距，默认 70" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    handler: toolLayout
  },
  {
    name: "task_tree_render",
    description: "把整张任务图截成图片直接返回，用户在对话里就能看到完整的树（节点卡片、连线、Current/Next 高亮），不用打开浏览器。用户说“看一眼任务图 / 画出来 / 现在长什么样”时用它。截的是界面本身，所以和网页完全一致。只读，不改树。",
    inputSchema: {
      type: "object",
      properties: {
        tree: { type: "string", description: "要截的方法树 ID，留空用当前活动树" },
        width: { type: "number", description: "画布宽度像素，默认 1680" },
        height: { type: "number", description: "画布高度像素，默认 1050" },
        scale: { type: "number", description: "渲染倍率 1~2，默认 1.5；树很大、字太小时调到 2" }
      },
      additionalProperties: false
    },
    handler: toolRender
  },
  {
    name: "task_tree_server",
    description: "本地任务图服务与界面：status 查是否在跑、start 无界面拉起、open 在用户桌面打开任务图界面（关系图/执行流程/知识库面板都在里面）、stop 关掉。其他工具需要服务时会自动 start，一般不用手动调；report 只给嵌入界面回报失败原因用。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "start", "open", "stop", "report"] },
        report: { type: "string", description: "仅 action=report：嵌入界面自报的失败诊断" }
      },
      additionalProperties: false
    },
    handler: toolServer
  },
  {
    name: "task_tree_api",
    description: "嵌入界面内部用的 HTTP 直通：把 /api/... 请求转给本地任务图服务并原样回传状态码与响应体。人类对话里不要用它，读写任务图请用上面那些具名工具。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP 方法，默认 GET" },
        path: { type: "string", description: "以 /api/ 开头的路径，可带查询串" },
        body: { type: "string", description: "请求体原文（JSON 字符串）" }
      },
      required: ["path"],
      additionalProperties: false
    },
    handler: toolApi
  },
  {
    name: "task_tree_open",
    description: "打开可交互任务图：可靠地在用户桌面浏览器打开，同时为支持 MCP Apps 的宿主附带对话内嵌界面。能拖节点、改字段、看执行流程和知识库。用户说“打开任务图 / 我要自己操作 / 在这里编辑”时用它；只想看一眼不动手就用 task_tree_render。",
    inputSchema: {
      type: "object",
      properties: { tree: { type: "string", description: "要打开的方法树 ID，留空用当前活动树" } },
      additionalProperties: false
    },
    // The host turns a tool into a widget by following this link to the ui:// resource.
    // Both spellings are sent: the MCP Apps key, and the Apps SDK one older hosts still read.
    meta: {
      ui: { resourceUri: WIDGET_URI },
      "openai/outputTemplate": WIDGET_URI
    },
    handler: toolOpen
  }
];

// ---------------------------------------------------------------- MCP plumbing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    const requested = String(params?.protocolVersion || "");
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
      // Resources exist for one reason: the widget bundle behind task_tree_open.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: `任务图工具。先 task_tree_focus 取焦点；改树用 task_tree_write（自带备份和精炼门禁）；链式推进用 task_tree_chain。${NEXT_PLAN_WARNING}`
    });
    return;
  }
  if (!isRequest) return;
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, {
      tools: TOOLS.map(({ name, description, inputSchema, meta }) => (
        meta ? { name, description, inputSchema, _meta: meta } : { name, description, inputSchema }
      ))
    });
    return;
  }
  if (method === "resources/list") {
    respond(id, {
      resources: [{
        uri: WIDGET_URI,
        name: "任务图界面",
        description: "嵌在对话里的可交互任务图：拖节点、改字段、看执行流程与知识库。",
        mimeType: WIDGET_MIME,
        // Listing must not start a server, but the ports this project prefers are pure arithmetic,
        // so the concrete origins can be declared here too.
        _meta: widgetMeta(stablePort(), loadLocalTls() ? httpsPortFor(stablePort()) : 0)
      }]
    });
    return;
  }
  if (method === "resources/read") {
    const uri = String(params?.uri || "");
    if (uri !== WIDGET_URI) {
      respondError(id, -32602, `未知资源：${uri}`);
      return;
    }
    try {
      // The server is started even though the document no longer loads anything from it: the page
      // is about to ask it for the tree over the bridge.
      const live = await ensureServer();
      const meta = widgetMeta(live.port, httpsPortOf(live));
      const kit = await kitDir();
      if (!kit) throw new Error(`找不到界面文件（public/）：检查 ${path.join(stubDir, "task-tree.config.json")}`);
      // The sandbox cannot reach a loopback address at all, so the page travels with the resource
      // instead of being linked from it.
      const text = await widgetBundle({ publicDir: path.join(kit, "public") });
      respond(id, {
        contents: [{ uri, mimeType: WIDGET_MIME, text, _meta: meta }],
        _meta: meta
      });
    } catch (error) {
      respondError(id, -32603, `无法准备任务图界面：${error?.message || error}`);
    }
    return;
  }
  if (method === "prompts/list") {
    respond(id, { prompts: [] });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((item) => item.name === params?.name);
    if (!tool) {
      respondError(id, -32602, `未知工具：${params?.name}`);
      return;
    }
    try {
      const payload = await tool.handler(params?.arguments || {});
      // A handler that has something other than JSON to say (an image, say) builds its own blocks.
      // structuredContent is deliberately never sent: Codex drops content[] when it is present.
      const result = {
        content: Array.isArray(payload?.mcpContent)
          ? payload.mcpContent
          : [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: Boolean(payload?.error)
      };
      if (payload?.mcpMeta) result._meta = payload.mcpMeta;
      respond(id, result);
    } catch (error) {
      respond(id, {
        content: [{ type: "text", text: `工具 ${tool.name} 失败：${error?.message || error}` }],
        isError: true
      });
    }
    return;
  }
  respondError(id, -32601, `不支持的方法：${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      respondError(null, -32700, "JSON 解析失败");
      continue;
    }
    handleMessage(message).catch((error) => {
      if (message?.id !== undefined && message?.id !== null) {
        respondError(message.id, -32603, String(error?.message || error));
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));
