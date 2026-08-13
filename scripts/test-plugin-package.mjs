/**
 * Boots the plugin package the way the desktop app does, and holds it to what its own docs promise.
 *
 * The package used to pass every check and still serve no tools at all: the manifest never declared
 * `mcpServers`, and the config file was named `mcp.json` where the host looks for `.mcp.json`. Both
 * are silent failures - nothing logs, the plugin just contributes nothing - and the only symptom was
 * a model being told to call tools that were not there. Static checks cannot catch that class of bug,
 * so this test starts the entry the manifest names and asks it what it serves.
 *
 * usage: node scripts/test-plugin-package.mjs [pluginRoot]
 *
 * Defaults to this repo's package. Pass the kit's copy to check a packaged one.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPluginRuntime } from "./build-plugin-runtime.mjs";

const repoRoot = process.cwd();
const arg = process.argv.slice(2).find((item) => !item.startsWith("-"));
const pluginRoot = path.resolve(arg || path.join(repoRoot, "marketplace", "plugins", "task-tree"));
const failures = [];

/**
 * The name the host's capability scan looks for. `mcp.json` without the dot is the Cursor spelling;
 * Codex silently ignores it, which is exactly how this shipped broken.
 */
const MCP_FILE = ".mcp.json";

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

/** Runs one stdio MCP session and returns the responses, keyed by request id. */
function mcpSession(entry, requests, { cwd, timeoutMs = 90000 } = {}) {
  const expected = requests.filter((item) => item.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const byId = new Map();
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${byId.size}/${expected} responses; stderr=${stderr.slice(0, 600)}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) byId.set(message.id, message);
        } catch {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        if (byId.size === expected) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ byId, stderr });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/** Manifest paths are relative to the plugin root and may not climb out of it. */
function insidePlugin(value, field) {
  assert.ok(typeof value === "string" && value.startsWith("./"), `${field} must start with "./" (got ${value})`);
  const resolved = path.resolve(pluginRoot, value);
  const relative = path.relative(pluginRoot, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${field} escapes the plugin root`);
  assert.ok(existsSync(resolved), `${field} points at a missing path: ${resolved}`);
  return resolved;
}

/** @returns {string} the absolute path of the entry the plugin tells the host to run. */
function declaredEntry() {
  const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  assert.ok(manifest.mcpServers, "the manifest declares no mcpServers, so the host contributes no tools at all");

  const configFile = insidePlugin(manifest.mcpServers, "mcpServers");
  assert.equal(
    path.basename(configFile),
    MCP_FILE,
    `the host's capability scan reads ${MCP_FILE}; any other name is ignored without a word`
  );

  const servers = readJson(configFile).mcpServers;
  const names = Object.keys(servers || {});
  assert.deepEqual(names, ["task_tree"], `expected one server named task_tree, got ${names.join(", ") || "none"}`);

  const server = servers.task_tree;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node", "the entry must run under the node the host resolves from PATH");
  assert.equal(server.args?.length, 1, "expected exactly one argument: the entry script");
  return insidePlugin(server.args[0], "mcpServers.task_tree.args[0]");
}

/** Every `task_tree_*` the shipped docs tell the model to call. */
function toolsThePackagePromises() {
  const docs = [path.join(pluginRoot, "README.md")];
  const skillsDir = path.join(pluginRoot, "skills");
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    docs.push(path.join(skillsDir, name, "SKILL.md"));
  }
  const promised = new Set();
  for (const file of docs) {
    if (!existsSync(file)) continue;
    for (const [name] of readFileSync(file, "utf8").matchAll(/task_tree_[a-z_]+/g)) promised.add(name);
  }
  return [...promised].sort();
}

let entry = "";
await runCase("the manifest names a runnable MCP entry", async () => {
  entry = declaredEntry();
});

await runCase("the packaged runtime matches the sources it was built from", async () => {
  const { stale, files } = await buildPluginRuntime({ sourceRoot: repoRoot, pluginRoot, write: false });
  assert.ok(files.length > 10, `expected a real runtime, found ${files.length} files`);
  assert.deepEqual(stale, [], `packaged runtime drifted from the sources (${stale.length} files)`);
});

/**
 * A temp project, so the run proves the package works next to a task graph it has never seen rather
 * than quietly leaning on this repo.
 */
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-plugin-"));
await writeFile(path.join(tmpRoot, "task-tree.md"), [
  "# LLM Task Graph",
  "",
  "## ROOT - 验收插件包",
  "- Position: 0,0",
  "- Size: 400,420",
  "- Completion: 进行中",
  "- Problem: 插件包要能在没见过的项目里提供完整工具面。",
  "- NextIdea: 启动包里的入口，核对工具集。",
  "",
  "# GraphState",
  "- Current: ROOT",
  "- Next: ROOT",
  "",
  "# Edges",
  ""
].join("\n"), "utf8");

if (entry) {
  const { byId, stderr } = await mcpSession(entry, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-package-test", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "task_tree_focus" } }
  ], { cwd: tmpRoot });

  const tools = byId.get(2)?.result?.tools || [];
  const served = new Set(tools.map((tool) => tool.name));

  await runCase("the packaged entry starts clean and identifies itself", async () => {
    assert.equal(stderr.trim(), "", `the entry must keep stderr quiet: ${stderr.slice(0, 400)}`);
    const init = byId.get(1)?.result;
    assert.equal(init?.serverInfo?.name, "llm-task-tree");
    assert.ok(init?.capabilities?.resources, "the widget is delivered as a resource, so resources must be advertised");
  });

  await runCase("the package serves every tool its own docs tell the model to call", async () => {
    const promised = toolsThePackagePromises();
    assert.ok(promised.length >= 5, `the docs name only ${promised.length} tools, which cannot be right`);
    const missing = promised.filter((name) => !served.has(name));
    assert.deepEqual(missing, [], `docs promise tools the package does not serve: ${missing.join(", ")}`);
  });

  await runCase("the in-conversation interface ships with the tools that drive it", async () => {
    // The three that were missing in the field: opening the widget, drawing a still of it, and the
    // proxy every embedded API call goes through. Without any one of them the panel cannot appear.
    for (const name of ["task_tree_open", "task_tree_render", "task_tree_api"]) {
      assert.ok(served.has(name), `${name} is missing, so the embedded interface cannot work`);
    }
    const resources = byId.get(3)?.result?.resources || [];
    const widget = resources.find((item) => item.uri === "ui://task-tree/graph.html");
    assert.ok(widget, `the widget resource is missing; got ${resources.map((item) => item.uri).join(", ") || "none"}`);
    assert.equal(
      tools.find((tool) => tool.name === "task_tree_open")?._meta?.ui?.resourceUri,
      widget.uri,
      "task_tree_open must point at the widget resource, or the host renders plain text"
    );
  });

  await runCase("the packaged runtime reads the project it was started in", async () => {
    const response = byId.get(4);
    assert.ok(!response?.result?.isError, `task_tree_focus failed: ${response?.result?.content?.[0]?.text?.slice(0, 300)}`);
    const focus = JSON.parse(response.result.content[0].text);
    assert.equal(path.resolve(focus.projectRoot), path.resolve(tmpRoot), "focus must resolve the caller's project, not the package");
    assert.equal(focus.graphState.current, "ROOT");
  });
}

await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

console.log(`\n${failures.length ? `${failures.length} failing` : "all checks passed"}`);
if (failures.length) process.exit(1);
