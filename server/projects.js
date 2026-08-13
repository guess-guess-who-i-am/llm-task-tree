import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 20000;

/**
 * Where the installer records every project it has touched, so one graph window can reach the
 * others instead of making people hunt for each project's launcher.
 */
export function registryFile(env = process.env) {
  const base = env.LOCALAPPDATA || env.APPDATA || env.HOME || "";
  return path.join(base, "LLMTaskTree", "projects.json");
}

/**
 * Same derivation as `stablePort()` in scripts/mcp-server.mjs and the PowerShell launcher: a
 * project always answers on the same URL, so switching to it never needs a port lookup.
 */
export function stablePortFor(projectRoot) {
  let hash = 0;
  for (const char of path.resolve(projectRoot).toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return 5178 + (hash % 800);
}

/** The registry is written by PowerShell, so it can carry a BOM and either shape. */
export function readRegistry(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const list = Array.isArray(parsed) ? parsed : parsed?.projects;
    return Array.isArray(list) ? list.map((entry) => String(entry?.root || entry || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** A registry entry is only useful if the folder still exists and still holds a tree. */
export function projectTreeFile(root) {
  for (const candidate of ["task-tree.md", "task-trees.json"]) {
    const full = path.join(root, candidate);
    if (existsSync(full)) return full;
  }
  return "";
}

function touchedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The switcher's list: live projects only, most recently worked on first.
 *
 * Dropping entries whose folder is gone is what quietly clears the mojibake ghosts an older
 * PowerShell console left in the registry — they point at paths that never existed.
 */
export function describeProjects({ file = registryFile(), currentRoot = "" } = {}) {
  const seen = new Set();
  const projects = [];
  const roots = [...readRegistry(file)];
  if (currentRoot) roots.unshift(currentRoot);

  for (const raw of roots) {
    let root;
    try {
      root = path.resolve(raw);
    } catch {
      continue;
    }
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(root)) continue;
    const treeFile = projectTreeFile(root);
    if (!treeFile) continue;
    projects.push({
      root,
      name: path.basename(root),
      port: stablePortFor(root),
      current: currentRoot ? key === path.resolve(currentRoot).toLowerCase() : false,
      touchedAt: touchedAt(treeFile)
    });
  }

  return projects.sort((a, b) => Number(b.current) - Number(a.current) || b.touchedAt - a.touchedAt);
}

/**
 * Which copy of the runtime serves a given project: its own checkout when it has one, otherwise
 * the shared kit its stub points at, otherwise the kit running this process.
 */
export function resolveRuntime(root, fallbackKitDir = "") {
  const stubDir = path.join(root, "llm-task-tree");
  const configFile = path.join(stubDir, "task-tree.config.json");
  if (existsSync(configFile)) {
    try {
      const shared = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, "")).sharedKitDir;
      if (shared && existsSync(path.join(shared, "server.js"))) {
        return { kitDir: path.resolve(shared), stubDir };
      }
    } catch {
      // fall through to the other candidates
    }
  }
  if (existsSync(path.join(root, "server.js"))) return { kitDir: root, stubDir: existsSync(stubDir) ? stubDir : root };
  if (fallbackKitDir && existsSync(path.join(fallbackKitDir, "server.js"))) {
    return { kitDir: path.resolve(fallbackKitDir), stubDir: existsSync(stubDir) ? stubDir : "" };
  }
  return null;
}

/** True only when something on that port is serving *this* project, not a stale neighbour. */
export async function probeProject(root, port, { fetchImpl = fetch, timeoutMs = 1200 } = {}) {
  try {
    const response = await fetchImpl(`http://${HOST}:${port}/api/project`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return false;
    const project = await response.json();
    return path.resolve(project.root || "").toLowerCase() === path.resolve(root).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Hands back a URL that is already serving `root`, starting a detached server when nobody answers.
 *
 * The child is detached on purpose: switching projects must not tie the new window's lifetime to
 * the window the user is about to navigate away from.
 */
export async function ensureProjectServer(root, {
  fallbackKitDir = "",
  spawnImpl = spawn,
  fetchImpl = fetch,
  timeoutMs = START_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) throw new Error(`项目目录不在了：${resolved}`);
  if (!projectTreeFile(resolved)) throw new Error(`这个目录里没有任务树：${resolved}`);

  const port = stablePortFor(resolved);
  const url = `http://${HOST}:${port}`;
  if (await probeProject(resolved, port, { fetchImpl })) return { url, port, started: false };

  const runtime = resolveRuntime(resolved, fallbackKitDir);
  if (!runtime) throw new Error(`找不到能跑这个项目的 server.js：${resolved}`);

  const child = spawnImpl(process.execPath, ["server.js"], {
    cwd: runtime.kitDir,
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      TASK_TREE_STUB_DIR: runtime.stubDir,
      TASK_TREE_PROJECT_ROOT: resolved
    },
    detached: true,
    stdio: "ignore"
  });
  child.unref?.();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeProject(resolved, port, { fetchImpl, timeoutMs: 800 })) {
      return { url, port, started: true, kitDir: runtime.kitDir };
    }
    await sleep(400);
  }
  throw new Error(`${resolved} 的任务图服务没在 ${Math.round(timeoutMs / 1000)}s 内起来（端口 ${port}）`);
}
