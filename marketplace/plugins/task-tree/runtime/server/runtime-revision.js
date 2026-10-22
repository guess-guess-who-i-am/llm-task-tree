import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// Hash executable sources only: never project state, credentials, logs or tests.
// A path-stable installation update must still invalidate a warm old process.
export async function runtimeRevision(kitDir) {
  const files = ['server.js'];
  for (const dir of ['server', 'scripts']) {
    const entries = await readdir(path.join(kitDir, dir), { withFileTypes: true });
    for (const entry of entries) if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)
      && !/\.test\.|^test-/.test(entry.name)) files.push(`${dir}/${entry.name}`);
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(path.join(kitDir, file))).update('\0');
  return hash.digest('hex');
}

// Hash the broker's executable dependency closure, including its spawned MCP
// entry. UI-only files and local experiment scripts must not create a new global
// worker, and identical installed copies must share a generation.
export async function workerRuntimeRevision(kitDir) {
  const root=path.resolve(kitDir), sources=new Map();
  const visit=async file=>{
    if(sources.has(file))return;
    const content=await readFile(path.join(root,file),'utf8');
    sources.set(file,content);
    // These authored ESM runtime sources use explicit relative module paths.
    // Follow static imports, re-exports and literal dynamic imports; cycles are
    // deduplicated before traversal. Never load modules or read user data.
    for(const match of content.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/g)){
      const target=path.resolve(root,path.dirname(file),match[2]);
      const relative=path.relative(root,target);
      if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!/[.](?:[cm]?js|json)$/.test(relative))continue;
      await visit(relative.split(path.sep).join('/'));
    }
  };
  await visit('server/shared-agent-worker.js');
  await visit('scripts/mcp-server.mjs');
  const hash=createHash('sha256');
  for(const [file,content] of [...sources].sort(([a],[b])=>a.localeCompare(b)))hash.update(file).update('\0').update(content).update('\0');
  return hash.digest('hex');
}

const active = status => !['completed', 'failed', 'stopped', 'accepted', 'blocked', 'planned'].includes(status);

// Older servers have no runtime stamp. Before replacing their process, establish
// project identity and inactivity; an unavailable/unknown status is not idle.
export async function projectServiceIdle(url, projectRoot, { fetchImpl = fetch } = {}) {
  try {
    const project = await fetchImpl(`${url}/api/project`, { signal: AbortSignal.timeout(1500) });
    if (!project.ok || await realpath((await project.json()).root) !== await realpath(projectRoot)) return false;
    const response = await fetchImpl(`${url}/api/codex/runs`, { signal: AbortSignal.timeout(1500) });
    const runs = response.ok ? (await response.json()).runs : undefined;
    if (!Array.isArray(runs) || runs.some(run => active(run.status))) return false;
    // Legacy standalone planners are not included in the direct-node endpoint.
    const dir = path.join(projectRoot, '.task-tree-runs');
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'context-index.json') {
      const file = path.join(dir, entry.name);
      const run = await readFile(file, 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (run && active(run.status)) return false;
    }
    return true;
  } catch { return false; }
}
