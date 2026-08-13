/**
 * Builds the public distribution repo under dist/task-tree-public.
 *
 * Written in Node rather than PowerShell on purpose: the previous PowerShell build wrote a
 * mis-encoded README that shipped as mojibake on GitHub. Everything here is UTF-8 without BOM.
 *
 * Layout produced (what `codex plugin marketplace add <owner>/<repo>` and a plain clone both need):
 *   .agents/plugins/marketplace.json   marketplace manifest at the repo root
 *   marketplace/plugins/task-tree/     plugin package (Codex + Cursor manifests, shared SKILL.md)
 *   kit/                               runtime: server.js, server/, public/, scripts/, templates
 *   docs/                              distribution guide
 *
 * usage: node scripts/build-public-repo.mjs [--out <dir>]
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const outDir = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(repoRoot, "dist", "task-tree-public"));
const kitDir = path.join(repoRoot, "llm-task-tree-kit");

/** Never ship: machine-local state, secrets, build output, nested clones. */
const KIT_EXCLUDE = new Set([
  ".git",
  ".github",
  "node_modules",
  "open-webSearch",
  "versions",
  ".env",
  "task-tree.config.json",
  "setup-task-tree.kitpath",
  "update-projects.txt",
  "update-search-roots.txt",
  "install.manifest.json",
  ".task-tree-port",
  ".task-tree-ports",
  // Parked, never validated: an editor status-bar button written before the plugin surface turned
  // out to live in the ChatGPT desktop app. Keep it local until it is actually tested.
  "editor-extension",
  "install-editor-button.ps1"
]);

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".js", ".mjs", ".ps1", ".cmd", ".sh", ".css", ".html", ".yaml", ".mdc"]);

const homeDir = path.join(path.parse(process.cwd()).root, "Users", path.basename(process.env.USERPROFILE || ""));

/** Absolute paths of this machine must never reach the public repo. */
const SANITIZE = [
  { find: kitDir, replacement: "<你的路径>\\llm-task-tree-kit" },
  { find: repoRoot, replacement: "<你的项目路径>" },
  { find: process.env.USERPROFILE || homeDir, replacement: "C:\\Users\\you" },
  { find: "F:\\empty-window", replacement: "D:\\your-project" }
];

/**
 * A stale `::KITPATH=<path>` would send a fresh clone looking for someone else's disk, so the
 * value is blanked and the kit gets discovered through the env var or the project folder.
 */
const KITPATH_FILES = ["kit/setup-task-tree.cmd"];

function replaceAll(text, find, replacement) {
  return find ? text.split(find).join(replacement) : text;
}

async function copyKit(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (KIT_EXCLUDE.has(entry.name) || entry.name.endsWith(".log")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyKit(from, to);
    else await cp(from, to);
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Rewrites machine paths in place, then reports every literal that survived. */
async function sanitizeTree(root) {
  const leaks = [];
  for await (const file of walk(root)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const original = await readFile(file, "utf8");
    let text = original;
    for (const rule of SANITIZE) text = replaceAll(text, rule.find, rule.replacement);
    if (text !== original) await writeFile(file, text, "utf8");

    const relative = path.relative(root, file).replace(/\\/g, "/");
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      for (const rule of SANITIZE) {
        if (rule.find && line.includes(rule.find)) leaks.push(`${relative}:${index + 1}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  return leaks;
}

async function blankKitPath(root) {
  for (const relative of KITPATH_FILES) {
    const file = path.join(root, ...relative.split("/"));
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^(\s*::KITPATH=).*$/gm, "$1"), "utf8");
  }
}

if (!existsSync(kitDir)) throw new Error(`shared kit not found: ${kitDir}`);

// Keep the existing git history: only the working tree is rebuilt.
for (const entry of ["kit", "marketplace", "docs", ".agents"]) {
  await rm(path.join(outDir, entry), { recursive: true, force: true });
}
await mkdir(outDir, { recursive: true });

await copyKit(kitDir, path.join(outDir, "kit"));
await cp(path.join(repoRoot, "marketplace"), path.join(outDir, "marketplace"), { recursive: true });
await mkdir(path.join(outDir, ".agents", "plugins"), { recursive: true });
await cp(
  path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
  path.join(outDir, ".agents", "plugins", "marketplace.json")
);
await mkdir(path.join(outDir, "docs"), { recursive: true });
await cp(
  path.join(repoRoot, "docs", "share-with-others.zh.md"),
  path.join(outDir, "docs", "share-with-others.zh.md")
);
await cp(path.join(kitDir, "LICENSE"), path.join(outDir, "LICENSE"));

await writeFile(path.join(outDir, ".gitignore"), [
  "node_modules/",
  ".env",
  ".task-tree-port",
  ".task-tree-ports",
  "install.manifest.json",
  "update-projects.txt",
  "update-search-roots.txt",
  "open-webSearch/",
  ""
].join("\n"), "utf8");

await blankKitPath(outDir);
const leaks = await sanitizeTree(outDir);
const secrets = [];
for await (const file of walk(outDir)) {
  const name = path.basename(file);
  if (name === ".env" || name === "knowledge-index.json" || name === "model-agents.json") secrets.push(path.relative(outDir, file));
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
  const text = await readFile(file, "utf8");
  if (/(api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i.test(text)) {
    secrets.push(`${path.relative(outDir, file)} (looks like a credential)`);
  }
}

let files = 0;
let bytes = 0;
for await (const file of walk(outDir)) {
  files += 1;
  bytes += (await stat(file)).size;
}

console.log(JSON.stringify({
  ok: !secrets.length && !leaks.length,
  outDir,
  files,
  megabytes: Number((bytes / 1024 / 1024).toFixed(2)),
  machinePathLeaks: leaks,
  secrets
}, null, 2));

// A leak here would be public on the next push, so fail the build instead of warning.
if (secrets.length || leaks.length) process.exit(1);
