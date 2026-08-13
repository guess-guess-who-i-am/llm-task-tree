import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SKIP_DIR_NAMES = new Set([".git", ".task-tree-maintenance", ".task-tree-runs", "node_modules", "versions", ".next", "dist", "build"]);

function looksLikeProjectRoot(dir) {
  return existsSync(path.join(dir, "task-trees.json"))
    || existsSync(path.join(dir, "task-tree.md"))
    || (existsSync(path.join(dir, "AGENTS.md")) && existsSync(path.join(dir, "server.js")));
}

export function locateProjectRoot({ cwd = process.cwd(), fallbackDir = "" } = {}) {
  const starts = [process.env.TASK_TREE_PROJECT_ROOT, cwd, process.cwd(), fallbackDir].filter(Boolean);
  for (const start of starts) {
    let current = path.resolve(start);
    while (true) {
      if (looksLikeProjectRoot(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.resolve(cwd || fallbackDir || process.cwd());
}

function skipDirectory(relative, name) {
  if (SKIP_DIR_NAMES.has(name)) return true;
  const rel = relative.replace(/\\/g, "/");
  return rel === "scripts/versions" || rel.startsWith("scripts/versions/") || rel.endsWith("/node_modules");
}

export async function snapshotWorkspace(root, { maxFiles = 50000 } = {}) {
  const files = {};
  let count = 0;

  async function walk(dir, relativeDir = "") {
    if (count >= maxFiles) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirectory(relative, entry.name)) await walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(path.join(dir, entry.name));
        files[relative.replace(/\\/g, "/")] = { mtimeMs: Math.round(info.mtimeMs), size: info.size };
        count += 1;
      } catch {
        // File disappeared while scanning.
      }
    }
  }

  await walk(root);
  return { files, truncated: count >= maxFiles, count };
}

export function diffWorkspaceSnapshots(before = {}, after = {}) {
  const changed = new Set();
  const beforeFiles = before.files || before;
  const afterFiles = after.files || after;
  for (const [file, current] of Object.entries(afterFiles)) {
    const previous = beforeFiles[file];
    if (!previous || previous.mtimeMs !== current.mtimeMs || previous.size !== current.size) changed.add(file);
  }
  for (const file of Object.keys(beforeFiles)) {
    if (!afterFiles[file]) changed.add(file);
  }
  return [...changed].sort();
}
