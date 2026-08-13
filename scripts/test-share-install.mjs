/**
 * End-to-end test for the shareable install: pretends to be somebody else's machine.
 *
 * Everything happens in a temp dir with a temp CODEX_HOME, so the developer's own
 * ~/.codex/config.toml and the machine-wide project registry are never touched
 * (the registry is snapshotted and restored because install.ps1 registers the project).
 *
 * usage: node scripts/test-share-install.mjs [kitDir]
 *
 * Pass a kit directory to test a packaged copy (for example dist/task-tree-public/kit)
 * exactly as an outside user would receive it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const kitArg = process.argv.slice(2).find((item) => !item.startsWith("-"));
const kitDir = kitArg ? path.resolve(kitArg) : path.join(repoRoot, "llm-task-tree-kit");
const failures = [];

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

/** Relative paths of every file under `rel`, which may name a file or a directory. */
async function filesUnder(root, rel, found = []) {
  const full = path.join(root, rel);
  if (!existsSync(full)) return found;
  if ((await stat(full)).isDirectory()) {
    for (const entry of (await readdir(full)).sort()) await filesUnder(root, path.posix.join(rel, entry), found);
    return found;
  }
  found.push(rel);
  return found;
}

async function sameBytes(fromRoot, toRoot, rel) {
  const to = path.join(toRoot, rel);
  if (!existsSync(to)) return `${rel}（kit 里没有）`;
  const one = createHash("sha256").update(await readFile(path.join(fromRoot, rel))).digest("hex");
  const other = createHash("sha256").update(await readFile(to)).digest("hex");
  return one === other ? "" : `${rel}（内容不一致）`;
}

function powershell(script) {
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`powershell failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 1200)}`);
  }
  return result.stdout || "";
}

function node(args, { cwd = repoRoot, env = {} } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** Drives an MCP server entry over stdio; notifications (no id) expect no response. */
function mcpSession(entry, requests, { cwd, expect = 0, timeoutMs = 90000 } = {}) {
  const expected = expect || requests.filter((item) => item.id !== undefined && item.id !== null).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${responses.length}/${expected} responses; stderr=${stderr.slice(0, 600)}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        if (responses.length === expected) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ responses, stderr });
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

const call = (id, name, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: args ? { name, arguments: args } : { name }
});
const payloadOf = (response) => {
  assert.ok(response, "missing response");
  assert.ok(!response.result?.isError, `tool reported an error: ${response.result?.content?.[0]?.text?.slice(0, 400)}`);
  return JSON.parse(response.result.content[0].text);
};

assert.ok(existsSync(path.join(kitDir, "install.ps1")), `shared kit not found at ${kitDir}`);

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-share-"));
const projectDir = path.join(tmpRoot, "other-person-project");
const stubDir = path.join(projectDir, "llm-task-tree");
const codexHome = path.join(tmpRoot, "codex-home");
const registryFile = path.join(process.env.LOCALAPPDATA || os.homedir(), "LLMTaskTree", "projects.json");
const registryBefore = existsSync(registryFile) ? readFileSync(registryFile) : null;

await mkdir(projectDir, { recursive: true });
await mkdir(codexHome, { recursive: true });

try {
  await runCase("install.ps1 sets up a foreign project from the shared kit alone", async () => {
    powershell([
      `. '${path.join(kitDir, "kit-runtime.ps1")}'`,
      `Write-SharedKitStub -StubDir '${stubDir}' -SharedKitDir '${kitDir}' -ProjectRoot '${projectDir}'`,
      `& powershell -NoProfile -ExecutionPolicy Bypass -File '${path.join(kitDir, "install.ps1")}' -StubDir '${stubDir}' -PromptsOnly`
    ].join("; "));

    for (const relative of [
      "task-tree.md",
      "AGENTS.md",
      "scripts/README.md",
      "llm-task-tree/task-tree.config.json",
      "llm-task-tree/mcp-server.mjs",
      "llm-task-tree/AGENTS.task-tree.md",
      "llm-task-tree/AGENTS.node-writing.md",
      ".cursor/mcp.json",
      ".cursor/rules/llm-task-tree-edit.mdc"
    ]) {
      assert.ok(existsSync(path.join(projectDir, relative)), `missing after install: ${relative}`);
    }

    const config = readFileSync(path.join(stubDir, "task-tree.config.json"), "utf8");
    assert.ok(!config.startsWith("\uFEFF"), "task-tree.config.json must not carry a UTF-8 BOM");
    assert.equal(readJson(path.join(stubDir, "task-tree.config.json")).sharedKitDir, kitDir);

    const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.ok(agents.includes("<!-- llm-task-tree:begin -->"), "AGENTS.md missing the task-graph block");
    assert.ok(agents.includes("task_tree_focus"), "AGENTS.md must tell agents the MCP tools exist");
    assert.ok(agents.includes("check-tree-compact"), "AGENTS.md missing the compact gate rule");
  });

  await runCase(".cursor/mcp.json is committable and machine-independent", async () => {
    const file = path.join(projectDir, ".cursor", "mcp.json");
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.startsWith("\uFEFF"), ".cursor/mcp.json must not carry a UTF-8 BOM");
    const doc = JSON.parse(raw);
    const server = doc.mcpServers.task_tree;
    assert.equal(server.type, "stdio");
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["${workspaceFolder}/llm-task-tree/mcp-server.mjs"]);
    assert.ok(!raw.includes(tmpRoot), "no absolute path may leak into the committed config");
    assert.ok(!raw.includes(kitDir), "the shared kit path must not leak into the committed config");
  });

  await runCase(".cursor/mcp.json merge keeps unrelated servers and keys", async () => {
    const file = path.join(projectDir, ".cursor", "mcp.json");
    await writeFile(file, `${JSON.stringify({
      note: "keep me",
      mcpServers: { other: { type: "stdio", command: "node", args: ["other.mjs"] } }
    }, null, 2)}\n`, "utf8");

    powershell([
      `. '${path.join(kitDir, "kit-runtime.ps1")}'`,
      `Ensure-ProjectCursorMcp -ProjectRoot '${projectDir}'`
    ].join("; "));

    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.note, "keep me");
    assert.deepEqual(doc.mcpServers.other.args, ["other.mjs"]);
    assert.deepEqual(doc.mcpServers.task_tree.args, ["${workspaceFolder}/llm-task-tree/mcp-server.mjs"]);

    const before = readFileSync(file);
    powershell([
      `. '${path.join(kitDir, "kit-runtime.ps1")}'`,
      `Ensure-ProjectCursorMcp -ProjectRoot '${projectDir}'`
    ].join("; "));
    assert.ok(before.equals(readFileSync(file)), "a second ensure must not rewrite the file");
  });

  await runCase("Codex registration works on a machine with no config.toml", async () => {
    const configFile = path.join(codexHome, "config.toml");
    assert.ok(!existsSync(configFile), "temp CODEX_HOME should start empty");

    const first = node([path.join(kitDir, "scripts", "install-codex-mcp.mjs"), "--with-plugin", "--codex-home", codexHome], { cwd: projectDir });
    assert.equal(first.status, 0, first.stderr.slice(0, 800));
    const result = JSON.parse(first.stdout);
    assert.equal(result.action, "appended");
    assert.deepEqual(result.headers, [
      "[mcp_servers.task_tree]",
      "[marketplaces.llm-task-tree]",
      '[plugins."task-tree@llm-task-tree"]'
    ]);
    assert.equal(result.entryScript, path.join(kitDir, "scripts", "mcp-server.mjs"), "must register the shared kit entry, not a per-repo path");

    const toml = readFileSync(configFile, "utf8");
    assert.ok(toml.includes(`source = '${path.join(kitDir, "marketplace")}'`), `marketplace source missing:\n${toml}`);
    assert.ok(toml.includes("enabled = true"), "plugin enable flag missing");
    // Without this the host runs task_tree_open but never renders its widget.
    assert.match(toml, /\[features\]\nenable_mcp_apps = true/, `MCP Apps must be switched on:\n${toml}`);

    const again = node([path.join(kitDir, "scripts", "install-codex-mcp.mjs"), "--with-plugin", "--codex-home", codexHome], { cwd: projectDir });
    assert.equal(JSON.parse(again.stdout).action, "none", "re-registration must be a no-op");

    // A registration left pointing at a runtime that has moved is the failure mode this repairs:
    // the tools keep loading from the old place, so new ones simply never appear.
    writeFileSync(configFile, readFileSync(configFile, "utf8").replace(
      `args = ['${path.join(kitDir, "scripts", "mcp-server.mjs")}']`,
      `args = ['${path.join(tmpRoot, "gone", "mcp-server.mjs")}']`
    ), "utf8");
    const repaired = node([path.join(kitDir, "scripts", "install-codex-mcp.mjs"), "--with-plugin", "--codex-home", codexHome], { cwd: projectDir });
    const repair = JSON.parse(repaired.stdout);
    assert.equal(repair.action, "refreshed", `a stale entry must be rewritten, got ${repair.action}`);
    assert.deepEqual(repair.refreshed, ["[mcp_servers.task_tree]"]);

    const healed = readFileSync(configFile, "utf8");
    assert.ok(healed.includes(`args = ['${path.join(kitDir, "scripts", "mcp-server.mjs")}']`), `entry not repaired:\n${healed}`);
    assert.ok(!healed.includes(path.join(tmpRoot, "gone")), "the stale path must be gone, not merely shadowed");
    assert.equal(healed.match(/\[mcp_servers\.task_tree\]/g).length, 1, "repair must not duplicate the block");
    assert.ok(healed.includes("[marketplaces.llm-task-tree]"), "repairing one block must leave the others alone");

    const removed = node([path.join(kitDir, "scripts", "install-codex-mcp.mjs"), "--with-plugin", "--remove", "--codex-home", codexHome], { cwd: projectDir });
    assert.equal(JSON.parse(removed.stdout).action, "removed");
    const after = readFileSync(configFile, "utf8");
    for (const header of ["[mcp_servers.task_tree]", "[marketplaces.llm-task-tree]", '[plugins."task-tree@llm-task-tree"]']) {
      assert.ok(!after.includes(header), `${header} survived removal`);
    }
    assert.ok(!after.includes("enable_mcp_apps"), "the feature flag we added must come back out");
  });

  await runCase("install registers Codex for the desktop app, and skips machines without Codex", async () => {
    const absent = path.join(tmpRoot, "codex-home-absent");
    const skipped = powershell([
      `$env:CODEX_HOME='${absent}'`,
      `. '${path.join(kitDir, "kit-runtime.ps1")}'`,
      `Ensure-CodexRegistration -KitDir '${kitDir}'`
    ].join("; ")).trim();
    assert.equal(skipped, "", "a machine without Codex must not get a config written");
    assert.ok(!existsSync(absent), "the registrar must not create a Codex home out of nothing");

    const home = path.join(tmpRoot, "codex-home-install");
    await mkdir(home, { recursive: true });
    const run = (label) => powershell([
      `$env:CODEX_HOME='${home}'`,
      `. '${path.join(kitDir, "kit-runtime.ps1")}'`,
      `Ensure-CodexRegistration -KitDir '${kitDir}'`
    ].join("; ")).trim();

    assert.equal(run(), "appended", "first install must register the desktop-visible blocks");
    const toml = readFileSync(path.join(home, "config.toml"), "utf8");
    for (const header of ["[mcp_servers.task_tree]", "[marketplaces.llm-task-tree]", '[plugins."task-tree@llm-task-tree"]']) {
      assert.ok(toml.includes(header), `${header} missing after install:\n${toml}`);
    }
    assert.equal(run(), "none", "re-running the installer must not rewrite the user's Codex config");
  });

  await runCase("marketplace manifests resolve to a real plugin (local and git shape)", async () => {
    for (const root of [kitDir, repoRoot]) {
      const manifestFile = path.join(root, ".agents", "plugins", "marketplace.json");
      const marketplaceRoot = existsSync(manifestFile) ? root : path.join(root, "marketplace");
      const file = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
      assert.ok(existsSync(file), `marketplace manifest missing under ${root}`);

      const manifest = readJson(file);
      assert.equal(manifest.name, "llm-task-tree");
      const entry = manifest.plugins.find((item) => item.name === "task-tree");
      assert.ok(entry, `task-tree entry missing in ${file}`);
      const relative = typeof entry.source === "string" ? entry.source : entry.source.path;
      assert.ok(relative.startsWith("./") && !relative.includes(".."), `source path must be relative and contained: ${relative}`);

      const pluginDir = path.resolve(marketplaceRoot, relative);
      const pluginManifest = path.join(pluginDir, ".codex-plugin", "plugin.json");
      assert.ok(existsSync(pluginManifest), `plugin manifest missing: ${pluginManifest}`);
      const plugin = readJson(pluginManifest);
      assert.equal(plugin.name, "task-tree");
      assert.ok(plugin.version, "plugin needs a version");
      assert.ok(existsSync(path.join(pluginDir, "skills", "task-tree", "SKILL.md")), "plugin must ship the task-tree skill");
    }
  });

  // A packaged kit that lost its artwork or interface metadata still installs; it just shows up
  // nameless and iconless in the Plugins Directory. Audit the packaged copy, not only the repo.
  await runCase("packaged plugin passes the install-surface audit", async () => {
    const roots = [kitDir, path.join(kitDir, "marketplace")]
      .filter((root) => existsSync(path.join(root, ".agents", "plugins", "marketplace.json")));
    assert.ok(roots.length, "kit ships no marketplace root");

    const result = node([path.join(repoRoot, "scripts", "test-plugin-manifest.mjs"), ...roots]);
    assert.equal(result.status, 0, `install-surface audit failed:\n${result.stdout}${result.stderr}`);
  });

  // The manifest audit reads fields; this one starts the package. A plugin can look perfect and
  // still contribute no tools, which is how the shipped copy once told models to call three tools
  // it never served.
  await runCase("packaged plugin actually serves the tools it documents", async () => {
    const pluginDir = path.join(kitDir, "marketplace", "plugins", "task-tree");
    assert.ok(existsSync(pluginDir), `kit ships no plugin package at ${pluginDir}`);

    const result = node([path.join(repoRoot, "scripts", "test-plugin-package.mjs"), pluginDir]);
    assert.equal(result.status, 0, `packaged plugin failed to serve its tools:\n${result.stdout}${result.stderr}`);
  });

  await runCase("shared kit carries everything the MCP entry needs", async () => {
    for (const relative of [
      "scripts/mcp-server.mjs",
      "scripts/install-codex-mcp.mjs",
      "public/tree-layout.js",
      "server/turn-tracker.js",
      "server/graph-render.js",
      "server/graph-widget.js",
      "server/codex-run.js",
      "server/codex-prompts.js",
      "server/projects.js",
      "server/png.js",
      "server.js",
      "AGENTS.node-writing.md",
      "templates/AGENTS.merge.md",
      "marketplace/.agents/plugins/marketplace.json"
    ]) {
      assert.ok(existsSync(path.join(kitDir, relative)), `shared kit missing: ${relative}`);
    }
    const merge = await readFile(path.join(kitDir, "templates", "AGENTS.merge.md"), "utf8");
    assert.ok(merge.includes("task_tree_write"), "AGENTS merge block must document the write tool");
    assert.ok(merge.includes("Do not paste code, JSON, commands"), "AGENTS merge block must enforce code-free nodes");
  });

  // Being present is not being current. The kit is a copy, and a copy that lags is how a machine
  // ends up serving an old tool set while the shipped docs describe a newer one - which reads as
  // "the package is missing tools" and is really "nobody re-ran the build".
  await runCase("shared kit is a current copy of the sources", async () => {
    const copied = [
      "server.js",
      "package.json",
      "server",
      "public",
      "marketplace",
      "scripts/mcp-server.mjs",
      "scripts/install-codex-mcp.mjs",
      "scripts/install-codex-hooks.mjs",
      "scripts/check-tree-compact.mjs",
      "scripts/enable-local-https.ps1"
    ];

    const stale = [];
    for (const source of copied) {
      for (const rel of await filesUnder(repoRoot, source)) {
        const problem = await sameBytes(repoRoot, kitDir, rel);
        if (problem) stale.push(problem);
      }
    }
    assert.deepEqual(stale, [], `kit 落后于源码（${stale.length} 处），跑 scripts/build-kit.ps1 重新同步`);
  });

  await runCase("project stub serves all 18 tools for the foreign project", async () => {
    const entry = path.join(stubDir, "mcp-server.mjs");
    const { responses, stderr } = await mcpSession(entry, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "share-test", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "task_tree_focus"),
      call(4, "task_tree_check_compact", { paths: ["task-tree.md"] })
    ], { cwd: projectDir });

    assert.equal(stderr.trim(), "", `stub must keep stderr quiet: ${stderr.slice(0, 400)}`);
    const init = responses.find((item) => item.id === 1).result;
    assert.equal(init.serverInfo.name, "llm-task-tree");
    assert.ok(init.capabilities.resources, "the widget template is served as a resource");
    assert.equal(responses.find((item) => item.id === 2).result.tools.length, 18);

    const focus = payloadOf(responses.find((item) => item.id === 3));
    assert.equal(path.resolve(focus.projectRoot), projectDir, "focus must resolve the foreign project, not the kit or this repo");
    assert.equal(focus.graphState.current, "ROOT");

    const compact = payloadOf(responses.find((item) => item.id === 4));
    assert.equal(compact.ok, true, `starter tree must pass the compact gate: ${JSON.stringify(compact).slice(0, 400)}`);
  });

  await runCase("write path autostarts a server for the foreign project and stops cleanly", async () => {
    const entry = path.join(stubDir, "mcp-server.mjs");
    const marker = "shared install e2e";
    const { responses } = await mcpSession(entry, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "share-test", version: "0" } } },
      call(2, "task_tree_write", { nodeId: "ROOT", fields: { Notes: marker }, reason: "share-install-e2e" }),
      call(3, "task_tree_focus"),
      call(4, "task_tree_server", { action: "stop" })
    ], { cwd: projectDir, timeoutMs: 180000 });

    const write = payloadOf(responses.find((item) => item.id === 2));
    assert.equal(write.ok, true, `write failed: ${JSON.stringify(write).slice(0, 400)}`);
    assert.deepEqual(write.changedNodeIds, ["ROOT"], "the write receipt must name the actually changed node");
    assert.equal(write.changes.length, 1, "one field write must produce one persisted difference");
    assert.deepEqual({
      kind: write.changes[0].kind,
      nodeId: write.changes[0].nodeId,
      field: write.changes[0].field,
      before: write.changes[0].before,
      after: write.changes[0].after
    }, {
      kind: "node-field",
      nodeId: "ROOT",
      field: "Notes",
      before: "第一次使用时，请让 Agent 拆成 3-7 个节点；节点不写代码、原始数据或复杂英文术语。",
      after: marker
    }, "the write receipt must contain the persisted old and new field values");
    const tree = await readFile(path.join(projectDir, "task-tree.md"), "utf8");
    assert.ok(tree.includes(marker), "written field missing from the foreign project's tree");
    assert.ok(existsSync(path.join(projectDir, "versions")), "write must leave a backup directory behind");

    const focus = payloadOf(responses.find((item) => item.id === 3));
    assert.equal(focus.graphState.current, "ROOT", "a node write must not move the user's focus");

    const stopped = payloadOf(responses.find((item) => item.id === 4));
    assert.ok(stopped.stopped || stopped.running === false, `server should be stopped: ${JSON.stringify(stopped).slice(0, 300)}`);

    // The endpoint answers before it exits; wait for the port to actually go away, otherwise
    // cleanup races a live process that still holds the temp project and the kit directory.
    if (stopped.port) {
      const deadline = Date.now() + 20000;
      let live = true;
      while (live && Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${stopped.port}/api/project`, { signal: AbortSignal.timeout(1000) });
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch {
          live = false;
        }
      }
      assert.equal(live, false, `server on port ${stopped.port} is still listening after stop`);
    }
  });
} finally {
  // A server started by this run holds both the temp project and the kit directory, so a
  // leftover breaks the next packaging build. The MCP entry records every port it starts.
  const ports = new Set();
  for (const name of [".task-tree-port", ".task-tree-ports"]) {
    const file = path.join(projectDir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const port = Number(line.trim());
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  const alive = async (port) => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/project`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      return false;
    }
  };
  const leftovers = [];
  for (const port of ports) {
    if (!(await alive(port))) continue;
    try {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // the server may exit before answering
    }
    const deadline = Date.now() + 15000;
    while (await alive(port)) {
      if (Date.now() > deadline) {
        leftovers.push(port);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (leftovers.length) {
    failures.push({ name: "cleanup leaves no running server", message: `still listening: ${leftovers.join(", ")}` });
    console.error(`FAIL cleanup leaves no running server: still listening: ${leftovers.join(", ")}`);
  }

  // Restore the machine-wide registry: install.ps1 registered the temp project.
  if (registryBefore) writeFileSync(registryFile, registryBefore);
  else if (existsSync(registryFile)) await rm(registryFile, { force: true });

  node([path.join(kitDir, "scripts", "install-codex-mcp.mjs"), "--with-plugin", "--remove", "--codex-home", codexHome], { cwd: repoRoot });
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
}

if (failures.length) {
  console.error(`\nFAILED ${failures.length} case(s)`);
  process.exit(1);
}
console.log("\nshare-install e2e: all cases passed");
