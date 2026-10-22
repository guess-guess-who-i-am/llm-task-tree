import { existsSync, readFileSync, realpathSync, statSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import os from 'node:os';
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { localNetworkEnvironment } from './network-environment.js';

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 20000;
const exec = promisify(execFile);

async function refreshManagedProject(root, runtime, port) {
  if (process.platform !== 'darwin' || !existsSync(path.join(runtime.kitDir, 'scripts/project-service-macos.mjs'))) return;
  const label = 'local.task-tree.project-' + createHash('sha256').update(root).digest('hex').slice(0, 16);
  // Never install a competing managed process over an unmanaged listener.
  if (!await exec('launchctl', ['print', `gui/${process.getuid()}/${label}`]).then(()=>true,()=>false)) return;
  await exec(process.execPath, [path.join(runtime.kitDir, 'scripts/project-service-macos.mjs'), 'start',
    runtime.stubDir, root, String(port), HOST,
    process.env.TASK_TREE_GLOBAL_ENV_FILE || path.resolve(runtime.kitDir, '..', '..', '.env')]);
}

// macOS exposes /var as a symlink to /private/var. Keep the path spelling that the
// caller supplied for UI/config output, but use the physical path for identity and
// stable-port calculations so the same project cannot receive two URLs.
function canonicalPath(value) {
  const resolved = path.resolve(value || "");
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function canonicalKey(value) {
  return canonicalPath(value).replace(/\\/g, "/").toLowerCase();
}

/**
 * Where the installer records every project it has touched, so one graph window can reach the
 * others instead of making people hunt for each project's launcher.
 */
export function registryFile(env = process.env) {
  const base = env.LOCALAPPDATA || env.APPDATA || env.HOME || os.homedir();
  return path.join(base, "LLMTaskTree", "projects.json");
}

/**
 * Same derivation as `stablePort()` in scripts/mcp-server.mjs and the PowerShell launcher: a
 * project always answers on the same URL, so switching to it never needs a port lookup.
 */
export function stablePortFor(projectRoot) {
  let hash = 0;
  for (const char of canonicalKey(projectRoot)) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return 5178 + (hash % 800);
}

/** The registry is written by PowerShell, so it can carry a BOM and either shape. */
export function readRegistry(file) {
  if (!file) return [];
  const roots = [];
  if (existsSync(file)) try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const list = Array.isArray(parsed) ? parsed : parsed?.projects;
    if (Array.isArray(list)) roots.push(...list.map(entry=>String(entry?.root || entry || '')).filter(Boolean));
  } catch { /* Read per-project records even when the legacy manifest is bad. */ }
  const records = path.join(path.dirname(file),'projects');
  for (const entry of directoryEntries(records)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record=JSON.parse(readFileSync(path.join(records,entry.name),'utf8'));
      if(typeof record.root === 'string' && record.root)roots.push(record.root);
    } catch { /* A stale/unreadable record does not hide other projects. */ }
  }
  return roots;
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
function directoryEntries(dir) {
  try { return readdirSync(dir,{withFileTypes:true}); } catch { return []; }
}

function temporaryProject(root) {
  const full = canonicalKey(root), temporary = canonicalKey(os.tmpdir());
  return full === temporary || full.startsWith(temporary + '/');
}

// Durable benchmark fixtures are not necessarily under os.tmpdir(). Their
// explicit marker (on the project or its container) survives restarts and works
// across shared runtime copies. Do not guess from user project/folder names.
function internalProject(root) {
  for (const start of new Set([path.resolve(root),canonicalPath(root)])) {
    let dir = start;
    for (;;) {
      if (existsSync(path.join(dir,'.task-tree-internal-project'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

export function registerProject(root, {file = registryFile()} = {}) {
  if (!projectTreeFile(root) || temporaryProject(root) || internalProject(root)) return;
  // Each project owns one record, so simultaneous server starts never replace
  // one another's manifest. Keep reading the old Windows installer manifest.
  const records=path.join(path.dirname(file),'projects');
  const target=path.join(records,createHash('sha256').update(canonicalKey(root)).digest('hex')+'.json');
  if(existsSync(target))return;
  mkdirSync(records,{recursive:true});
  const pending = `${target}.${process.pid}.tmp`;
  writeFileSync(pending,JSON.stringify({root:path.resolve(root)})+'\n','utf8');
  renameSync(pending,target);
}

/** Installed macOS services predate the cross-platform recent-project registry.
 * Inspect only our own service records and bounded common workspace folders;
 * never crawl project contents, Git worktrees or the whole disk. */
function discoveredProjects({homeDir,searchRoots}) {
  const roots = [];
  const services = path.join(homeDir,'Library/LaunchAgents');
  const decode = text => text.replace(/&(amp|lt|gt|quot|apos);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key]);
  for (const entry of directoryEntries(services)) {
    if (!entry.isFile() || !/^local\.task-tree\.project-.*\.plist$/.test(entry.name)) continue;
    try {
      const xml = readFileSync(path.join(services,entry.name),'utf8');
      const root = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (root) roots.push(decode(root));
    } catch { /* Removed service record: try the remaining records. */ }
  }
  for (const folder of searchRoots) {
    if (!folder) continue;
    if (projectTreeFile(folder)) roots.push(folder);
    for (const entry of directoryEntries(folder)) {
      if (entry.name.startsWith('.') || ['node_modules','versions','llm-task-tree-kit','marketplace'].includes(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const root = path.join(folder,entry.name);
      if (projectTreeFile(root)) roots.push(root);
    }
  }
  return roots.filter(root => !temporaryProject(root) || canonicalKey(root).startsWith(canonicalKey(homeDir) + '/'));
}

export function describeProjects({ file = registryFile(), currentRoot = "", homeDir = os.homedir(),
  searchRoots = [path.join(homeDir,'Desktop'),path.join(homeDir,'Documents'),...(currentRoot ? [path.dirname(currentRoot)] : [])] } = {}) {
  const seen = new Set();
  const projects = [];
  const currentKey = currentRoot ? canonicalKey(currentRoot) : '';
  const roots = [...readRegistry(file),...discoveredProjects({homeDir,searchRoots})];
  if (currentRoot) roots.unshift(currentRoot);

  for (const raw of roots) {
    let root;
    try {
      root = path.resolve(raw);
    } catch {
      continue;
    }
    const key = canonicalKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(root)) continue;
    const treeFile = projectTreeFile(root);
    if (!treeFile) continue;
    // Apply to every source, including legacy registry records and launchd
    // discovery. An explicitly opened internal project remains usable locally.
    if (key !== currentKey && internalProject(root)) continue;
    projects.push({
      root,
      name: path.basename(root),
      port: stablePortFor(root),
      current: key === currentKey,
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
    return canonicalKey(project.root || "") === canonicalKey(root);
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
  refreshImpl = refreshManagedProject,
  timeoutMs = START_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) throw new Error(`项目目录不在了：${resolved}`);
  if (!projectTreeFile(resolved)) throw new Error(`这个目录里没有任务树：${resolved}`);

  const preferredPort = stablePortFor(resolved);
  let port = preferredPort;
  try {
    const marker = Number(readFileSync(path.join(resolved, '.task-tree-port'), 'utf8').trim());
    if (Number.isInteger(marker) && marker > 0 && marker <= 65535
      && await probeProject(resolved, marker, {fetchImpl})) port = marker;
  } catch { /* An absent/stale marker cannot select another project's listener. */ }
  const url = `http://${HOST}:${port}`;
  const runtime = resolveRuntime(resolved, fallbackKitDir);
  if (await probeProject(resolved, port, { fetchImpl })) {
    if (runtime) await refreshImpl(resolved, runtime, port);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probeProject(resolved, port, {fetchImpl})) return {url, port, started:false};
      await sleep(100);
    }
    throw new Error(`项目服务更新后没有恢复：${resolved}`);
  }

  if (!runtime) throw new Error(`找不到能跑这个项目的 server.js：${resolved}`);

  const child = spawnImpl(process.execPath, ["server.js"], {
    cwd: runtime.kitDir,
    env: {
      ...await localNetworkEnvironment(),
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
