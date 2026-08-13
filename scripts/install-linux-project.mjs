/**
 * Completes the project-side installation for Linux and other POSIX hosts.
 * The shell entry point stays small; filesystem and JSON work live here so paths and encoding
 * behave the same on Linux, macOS, WSL, and Windows Node.
 */
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const [projectArg, kitArg, stubArg] = process.argv.slice(2);
if (!projectArg || !kitArg) throw new Error("usage: node install-linux-project.mjs <project-root> <kit-dir> [stub-dir]");

const projectRoot = path.resolve(projectArg);
const kitDir = path.resolve(kitArg);
const stubDir = path.resolve(stubArg || path.join(projectRoot, "llm-task-tree"));
const configFile = path.join(stubDir, "task-tree.config.json");

// Archives and cross-platform copy tools can discard POSIX mode bits. Restore the shared entry
// points before generating project stubs that execute them.
for (const relative of ["install-linux.sh", "start-task-tree.sh", "scripts/chain-loop-gate.sh"]) {
  const file = path.join(kitDir, relative);
  if (existsSync(file)) await chmod(file, 0o755);
}

const copyIfMissing = async (source, target) => {
  if (!existsSync(source) || existsSync(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
};

function mergeMarkedBlock(content, block, begin, end) {
  const cleanBlock = block.trim();
  const start = content.indexOf(begin);
  if (start >= 0) {
    const finish = content.indexOf(end, start);
    if (finish >= 0) return `${content.slice(0, start)}${cleanBlock}${content.slice(finish + end.length)}`;
  }
  return `${content.trimEnd()}\n\n${cleanBlock}\n`;
}

function removeMarkedBlock(content, begin, end) {
  const start = content.indexOf(begin);
  if (start < 0) return content;
  const finish = content.indexOf(end, start);
  if (finish < 0) return content;
  return `${content.slice(0, start).trimEnd()}\n${content.slice(finish + end.length).trimStart()}`;
}

await mkdir(stubDir, { recursive: true });
await mkdir(path.join(projectRoot, "versions"), { recursive: true });
await mkdir(path.join(projectRoot, "knowledge"), { recursive: true });
await mkdir(path.join(projectRoot, "scripts", "steps"), { recursive: true });
await mkdir(path.join(projectRoot, "subtrees"), { recursive: true });
await copyIfMissing(path.join(kitDir, "templates", "task-tree.starter.md"), path.join(projectRoot, "task-tree.md"));
const registryFile = path.join(projectRoot, "task-trees.json");
const registryTemplate = path.join(kitDir, "templates", "task-trees.json");
if (!existsSync(registryFile)) {
  await copyIfMissing(registryTemplate, registryFile);
} else if (existsSync(registryTemplate)) {
  const registry = JSON.parse((await readFile(registryFile, "utf8")).replace(/^\uFEFF/, ""));
  const expected = JSON.parse((await readFile(registryTemplate, "utf8")).replace(/^\uFEFF/, ""));
  const trees = Array.isArray(registry.trees) ? registry.trees : [];
  const ids = new Set(trees.map((tree) => String(tree.id || "")));
  const added = (expected.trees || []).filter((tree) => !ids.has(String(tree.id || "")));
  if (added.length) {
    registry.trees = [...trees, ...added];
    await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
}
await copyIfMissing(path.join(kitDir, "templates", "background-tree.md"), path.join(projectRoot, "trees", "background.md"));
await copyIfMissing(path.join(kitDir, "templates", "architecture-tree.md"), path.join(projectRoot, "trees", "architecture.md"));
await copyIfMissing(path.join(kitDir, "templates", "scripts", "README.md"), path.join(projectRoot, "scripts", "README.md"));
await copyIfMissing(path.join(kitDir, "templates", "scripts", "steps", "README.md"), path.join(projectRoot, "scripts", "steps", "README.md"));

const agentsFile = path.join(projectRoot, "AGENTS.md");
const mergeFile = path.join(kitDir, "templates", "AGENTS.merge.md");
const toolFile = path.join(kitDir, "templates", "AGENTS.tool-calling-rules.md");
const mergeBegin = "<!-- llm-task-tree:begin -->";
const mergeEnd = "<!-- llm-task-tree:end -->";
const toolBegin = "<!-- llm-task-tree:tool-calling:begin -->";
const toolEnd = "<!-- llm-task-tree:tool-calling:end -->";
let agents = existsSync(agentsFile)
  ? await readFile(agentsFile, "utf8")
  : "# Agent Instructions\n\nSee the task graph protocol, llm-task-tree/AGENTS.task-tree.md, and llm-task-tree/AGENTS.node-writing.md.\n";
const shortRouter = /^# Agent Entry Rules\s*$/m.test(agents)
  && agents.includes("Mandatory routing table")
  && agents.includes("llm-task-tree/AGENTS.task-tree.md");
if (shortRouter) {
  agents = removeMarkedBlock(removeMarkedBlock(agents, mergeBegin, mergeEnd), toolBegin, toolEnd);
} else {
  if (existsSync(mergeFile)) agents = mergeMarkedBlock(agents, await readFile(mergeFile, "utf8"), mergeBegin, mergeEnd);
  if (existsSync(toolFile)) agents = mergeMarkedBlock(agents, await readFile(toolFile, "utf8"), toolBegin, toolEnd);
}
await writeFile(agentsFile, `${agents.trimEnd()}\n`, "utf8");

await writeFile(configFile, `${JSON.stringify({ projectRoot: "..", sharedKitDir: kitDir }, null, 2)}\n`, "utf8");

const mcpStub = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubDir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse((await readFile(path.join(stubDir, "task-tree.config.json"), "utf8")).replace(/^\\uFEFF/, ""));
const kit = path.resolve(stubDir, String(config.sharedKitDir || ".."));
const entry = path.join(kit, "scripts", "mcp-server.mjs");
if (!existsSync(entry)) throw new Error("shared kit MCP server missing: " + entry);
const projectRoot = path.resolve(stubDir, String(config.projectRoot || ".."));
if (!process.argv.includes("--project-root")) process.argv.splice(2, 0, "--project-root", projectRoot);
await import(pathToFileURL(entry).href);
`;
await writeFile(path.join(stubDir, "mcp-server.mjs"), mcpStub, "utf8");

const openStub = `#!/usr/bin/env bash
set -euo pipefail
STUB_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.sharedKitDir||"");' "$STUB_DIR/task-tree.config.json")"
exec "$KIT_DIR/start-task-tree.sh" "$STUB_DIR"
`;
await writeFile(path.join(stubDir, "open-task-tree.sh"), openStub, "utf8");
await chmod(path.join(stubDir, "open-task-tree.sh"), 0o755);

const checkStub = `#!/usr/bin/env bash
set -euo pipefail
STUB_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(node -e 'const c=require(process.argv[1]); const p=c.projectRoot||".."; process.stdout.write(require("path").resolve(process.argv[2],p));' "$STUB_DIR/task-tree.config.json" "$STUB_DIR")"
KIT_DIR="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.sharedKitDir||"");' "$STUB_DIR/task-tree.config.json")"
exec node "$KIT_DIR/scripts/check-tree-compact.mjs" --project-root "$PROJECT_ROOT" "$@"
`;
await writeFile(path.join(stubDir, "check-tree-compact.sh"), checkStub, "utf8");
await chmod(path.join(stubDir, "check-tree-compact.sh"), 0o755);

const cursorDir = path.join(projectRoot, ".cursor");
const cursorMcp = path.join(cursorDir, "mcp.json");
await mkdir(cursorDir, { recursive: true });
let cursor = {};
if (existsSync(cursorMcp)) {
  try { cursor = JSON.parse((await readFile(cursorMcp, "utf8")).replace(/^\uFEFF/, "")); } catch { cursor = {}; }
}
cursor.mcpServers = { ...(cursor.mcpServers || {}), task_tree: {
  type: "stdio",
  command: "node",
  args: ["\${workspaceFolder}/llm-task-tree/mcp-server.mjs"]
} };
await writeFile(cursorMcp, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
const cursorRulesSource = path.join(kitDir, "templates", "cursor-rules");
if (existsSync(cursorRulesSource)) await cp(cursorRulesSource, path.join(cursorDir, "rules"), { recursive: true, force: true });

const ignoreFile = path.join(projectRoot, ".gitignore");
const ignoreTemplate = path.join(kitDir, "templates", "gitignore.append");
const currentIgnore = existsSync(ignoreFile) ? await readFile(ignoreFile, "utf8") : "";
const additions = existsSync(ignoreTemplate) ? (await readFile(ignoreTemplate, "utf8"))
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
const missing = additions.filter((line) => !currentIgnore.split(/\r?\n/).includes(line));
if (missing.length) await writeFile(ignoreFile, `${currentIgnore.replace(/\s*$/, "\n")}${missing.join("\n")}\n`, "utf8");

if (existsSync(path.join(kitDir, "AGENTS.task-tree.md"))) await cp(path.join(kitDir, "AGENTS.task-tree.md"), path.join(stubDir, "AGENTS.task-tree.md"), { force: true });
if (existsSync(path.join(kitDir, "AGENTS.node-writing.md"))) await cp(path.join(kitDir, "AGENTS.node-writing.md"), path.join(stubDir, "AGENTS.node-writing.md"), { force: true });
if (existsSync(path.join(kitDir, "skills"))) await cp(path.join(kitDir, "skills"), path.join(stubDir, "skills"), { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, projectRoot, kitDir, stubDir, cursorMcp, createdTree: existsSync(path.join(projectRoot, "task-tree.md")) }, null, 2));
