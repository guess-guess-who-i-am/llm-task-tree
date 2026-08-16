#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "marketplace", "plugins", "task-tree");
const referenceRoot = path.join(pluginRoot, "runtime");
const runtimeSources = ["package.json", "server.js", "scripts/mcp-server.mjs", "server", "public"];
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const remoteArg = valueAfter("--remote");
const checks = [];
const warnings = [];

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function record(label, ok, detail = "") {
  checks.push({ label, ok, detail });
}

async function collect(root, relative, found = []) {
  const full = path.join(root, relative);
  if (!existsSync(full)) return found;
  if ((await stat(full)).isDirectory()) {
    for (const entry of (await readdir(full)).sort()) {
      await collect(root, path.posix.join(relative.replaceAll("\\", "/"), entry), found);
    }
    return found;
  }
  found.push(relative.replaceAll("\\", "/"));
  return found;
}

async function runtimeManifest(root) {
  const files = [];
  for (const source of runtimeSources) await collect(root, source, files);
  const manifest = new Map();
  for (const relative of files.sort()) {
    try {
      manifest.set(relative, digest(await readFile(path.join(root, relative))));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      manifest.set(relative, "MISSING_DURING_SCAN");
    }
  }
  return manifest;
}

async function compareRuntime(label, targetRoot, reference) {
  if (!existsSync(targetRoot)) {
    record(label, false, `不存在：${targetRoot}`);
    return;
  }
  const target = await runtimeManifest(targetRoot);
  const stale = [];
  for (const [relative, hash] of reference) {
    if (!target.has(relative)) stale.push(`${relative}（缺失）`);
    else if (target.get(relative) !== hash) stale.push(`${relative}（内容不同）`);
  }
  for (const relative of target.keys()) {
    if (!reference.has(relative)) stale.push(`${relative}（仅目标存在）`);
  }
  record(label, stale.length === 0, stale.length ? stale.slice(0, 8).join("；") : `${reference.size} 个运行时文件一致`);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function pluginVersion(root) {
  return String((await readJson(path.join(root, ".codex-plugin", "plugin.json"))).version || "");
}

async function checkManifestVersions(expectedVersion) {
  const files = [
    ["Cursor 插件清单", path.join(pluginRoot, ".cursor-plugin", "plugin.json")],
    ["Claude 插件清单", path.join(pluginRoot, ".claude-plugin", "plugin.json")],
    ["Claude 仓库市场", path.join(repoRoot, ".claude-plugin", "marketplace.json")]
  ];
  for (const [label, file] of files) {
    if (!existsSync(file)) {
      record(label, false, `不存在：${file}`);
      continue;
    }
    const body = await readJson(file);
    const version = label === "Claude 仓库市场" ? body.plugins?.[0]?.version : body.version;
    record(label, version === expectedVersion, `version=${version || "MISSING"}`);
  }
  const trae = path.join(repoRoot, "integrations", "trae", "mcp.json");
  if (!existsSync(trae)) {
    record("Trae MCP 分发", false, `不存在：${trae}`);
  } else {
    const body = await readJson(trae);
    record("Trae MCP 分发", Boolean(body.mcpServers?.task_tree), "integrations/trae/mcp.json");
  }
}

async function latestPluginCache(cacheRoot) {
  const versionsRoot = path.join(cacheRoot, "llm-task-tree", "task-tree");
  if (!existsSync(versionsRoot)) return null;
  const candidates = [];
  for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(versionsRoot, entry.name);
    const manifest = path.join(root, ".codex-plugin", "plugin.json");
    if (existsSync(manifest)) candidates.push({ root, modified: (await stat(manifest)).mtimeMs });
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.root || null;
}

async function checkCodexCaches(expectedVersion, reference) {
  const homes = new Set([
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "plugins", "cache") : "",
    path.join(os.homedir(), ".codex", "plugins", "cache"),
    "D:\\Codex\\desktop\\plugins\\cache"
  ].filter(Boolean).map((item) => path.resolve(item)));
  let found = 0;
  for (const cache of homes) {
    const installed = await latestPluginCache(cache);
    if (!installed) continue;
    found += 1;
    try {
      const version = await pluginVersion(installed);
      record(`Codex 缓存版本 ${cache}`, version === expectedVersion, `version=${version}`);
      await compareRuntime(`Codex 缓存运行时 ${cache}`, path.join(installed, "runtime"), reference);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      record(`Codex 缓存 ${cache}`, false, "宿主扫描期间重建了缓存，请重新运行审计");
    }
  }
  if (!found) warnings.push("没有找到已安装的 Codex task-tree 插件缓存");
}

async function checkProjects(reference) {
  const registry = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "LLMTaskTree", "projects.json")
    : "";
  if (!registry || !existsSync(registry)) {
    warnings.push("没有找到本机项目登记表");
    return;
  }
  const roots = Array.from(new Set((await readJson(registry)).projects || []));
  const sharedKits = new Set();
  let configured = 0;
  let missing = 0;
  const bad = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      missing += 1;
      continue;
    }
    const stub = path.join(root, "llm-task-tree");
    const configFile = path.join(stub, "task-tree.config.json");
    const cursorFile = path.join(root, ".cursor", "mcp.json");
    if (!existsSync(configFile)) {
      bad.push(`${root}：缺 task-tree.config.json`);
      continue;
    }
    const config = await readJson(configFile);
    if (!config.sharedKitDir) bad.push(`${root}：不是共享 kit 入口`);
    else sharedKits.add(path.resolve(stub, String(config.sharedKitDir)));
    if (!existsSync(cursorFile) || !(await readJson(cursorFile)).mcpServers?.task_tree) {
      bad.push(`${root}：缺 Cursor task_tree MCP`);
    } else {
      configured += 1;
    }
  }
  record("本机项目共享入口", bad.length === 0, `${roots.length - missing} 个有效项目；${missing} 条失效登记${bad.length ? `；${bad.slice(0, 5).join("；")}` : ""}`);
  record("Cursor 项目入口", configured === roots.length - missing, `${configured}/${roots.length - missing} 个有效项目已配置`);
  for (const kit of sharedKits) await compareRuntime(`项目共享 kit ${kit}`, kit, reference);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function remoteSpec(value) {
  const split = value.indexOf(":");
  if (split <= 0) throw new Error("--remote 必须使用 host:/absolute/kit/path 格式");
  return { host: value.slice(0, split), root: value.slice(split + 1) };
}

function runRemoteManifest(host, remoteRoot, reference, prefix = "") {
  const input = Array.from(reference, ([relative, hash]) => `${hash}  ${prefix}${relative}`).join("\n") + "\n";
  const command = `cd -- ${shellQuote(remoteRoot)} && sha256sum --quiet -c -`;
  return spawnSync("ssh", [host, command], { input, encoding: "utf8", timeout: 30_000 });
}

async function checkRemote(expectedVersion, reference) {
  if (!remoteArg) return;
  const { host, root } = remoteSpec(remoteArg);
  const kit = runRemoteManifest(host, root, reference);
  record(`远程 kit ${host}:${root}`, kit.status === 0, (kit.stderr || kit.stdout || `${reference.size} 个运行时文件一致`).trim());
  const plugin = runRemoteManifest(host, root, reference, "marketplace/plugins/task-tree/runtime/");
  record(`远程插件运行时 ${host}:${root}`, plugin.status === 0, (plugin.stderr || plugin.stdout || `${reference.size} 个运行时文件一致`).trim());
  const versionScript = 'const fs=require("fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(body.version||""));';
  for (const [platform, relative] of [
    ["Codex", ".codex-plugin/plugin.json"],
    ["Cursor", ".cursor-plugin/plugin.json"],
    ["Claude", ".claude-plugin/plugin.json"]
  ]) {
    const manifest = `${root}/marketplace/plugins/task-tree/${relative}`;
    const versionRun = spawnSync("ssh", [host, `node -e ${shellQuote(versionScript)} ${shellQuote(manifest)}`], { encoding: "utf8", timeout: 30_000 });
    const version = versionRun.stdout.trim();
    record(`远程 ${platform} 插件版本 ${host}:${root}`, versionRun.status === 0 && version === expectedVersion, `version=${version || "MISSING"}`);
  }
}

const reference = await runtimeManifest(referenceRoot);
if (!reference.size) throw new Error(`打包运行时为空：${referenceRoot}`);
const expectedVersion = await pluginVersion(pluginRoot);
record("发布基准", Boolean(expectedVersion), `version=${expectedVersion}；${reference.size} 个运行时文件`);

await checkManifestVersions(expectedVersion);
await compareRuntime("仓库共享 kit", path.join(repoRoot, "llm-task-tree-kit"), reference);
await compareRuntime("仓库 kit 插件运行时", path.join(repoRoot, "llm-task-tree-kit", "marketplace", "plugins", "task-tree", "runtime"), reference);
await checkCodexCaches(expectedVersion, reference);
await checkProjects(reference);

const legacy = path.join(os.homedir(), ".llm-task-tree", "template");
if (existsSync(legacy)) await compareRuntime("本机旧模板兼容副本", legacy, reference);
await checkRemote(expectedVersion, reference);

const failed = checks.filter((check) => !check.ok);
if (jsonMode) {
  console.log(JSON.stringify({ ok: failed.length === 0, expectedVersion, checks, warnings }, null, 2));
} else {
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.label}: ${check.detail}`);
  for (const warning of warnings) console.log(`WARN ${warning}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
}
if (failed.length) process.exitCode = 1;
