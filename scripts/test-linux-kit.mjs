import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const kitDir = path.join(repoRoot, "llm-task-tree-kit");
const installer = path.join(repoRoot, "scripts", "install-linux-project.mjs");
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "llm-task-tree-linux-"));
const projectDir = path.join(tmpRoot, "project");
const stubDir = path.join(projectDir, "llm-task-tree");
const startScript = path.join(kitDir, "start-task-tree.sh");
let originalStartMode = null;

function runNode(args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function mcpSession(entry, requests, cwd) {
  const expected = requests.filter((request) => request.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`stub MCP timed out after ${responses.length}/${expected}; ${stderr.slice(0, 400)}`));
    }, 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try { responses.push(JSON.parse(line)); }
        catch (error) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`stub MCP emitted non-JSON stdout: ${line.slice(0, 200)} (${error.message})`));
          return;
        }
        if (responses.length === expected) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ responses, stderr });
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const call = (id, name, argumentsValue = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: argumentsValue }
});

try {
  if (process.platform !== "win32") {
    originalStartMode = (await stat(startScript)).mode & 0o777;
    await chmod(startScript, 0o644);
  }
  await mkdir(path.join(projectDir, ".cursor"), { recursive: true });
  await writeFile(path.join(projectDir, "AGENTS.md"), "# Local Rules\n\nKeep this line.\n", "utf8");
  await writeFile(path.join(projectDir, ".cursor", "mcp.json"), `${JSON.stringify({
    mcpServers: { existing: { command: "node", args: ["existing-server.mjs"] } }
  }, null, 2)}\n`, "utf8");

  const first = await runNode([installer, projectDir, kitDir, stubDir]);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.ok(JSON.parse(first.stdout).ok, first.stdout);
  if (process.platform !== "win32") {
    assert.equal((await stat(startScript)).mode & 0o111, 0o111, "installer did not restore shared launcher execute bits");
  }

  for (const relative of [
    "task-tree.md",
    "task-trees.json",
    "trees/background.md",
    "trees/architecture.md",
    "scripts/README.md",
    "scripts/steps/README.md",
    "AGENTS.md",
    "llm-task-tree/task-tree.config.json",
    "llm-task-tree/mcp-server.mjs",
    "llm-task-tree/AGENTS.task-tree.md",
    "llm-task-tree/AGENTS.node-writing.md",
    "llm-task-tree/open-task-tree.sh",
    "llm-task-tree/check-tree-compact.sh",
    ".cursor/mcp.json"
  ]) assert.ok(existsSync(path.join(projectDir, relative)), `missing install output: ${relative}`);

  const agents = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
  assert.match(agents, /Keep this line/);
  assert.equal((agents.match(/<!-- llm-task-tree:begin -->/g) || []).length, 1);
  assert.equal((agents.match(/<!-- llm-task-tree:end -->/g) || []).length, 1);
  assert.equal((agents.match(/<!-- llm-task-tree:tool-calling:begin -->/g) || []).length, 1);

  const cursor = JSON.parse(await readFile(path.join(projectDir, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers.existing, "existing Cursor MCP server was lost");
  assert.equal(cursor.mcpServers.task_tree.command, "node");
  assert.equal(cursor.mcpServers.task_tree.args[0], "${workspaceFolder}/llm-task-tree/mcp-server.mjs");

  const config = JSON.parse(await readFile(path.join(stubDir, "task-tree.config.json"), "utf8"));
  assert.equal(path.resolve(stubDir, config.projectRoot), projectDir);
  assert.equal(path.resolve(stubDir, config.sharedKitDir), kitDir);
  assert.match(await readFile(path.join(stubDir, "mcp-server.mjs"), "utf8"), /shared kit MCP server missing/);
  const registry = JSON.parse(await readFile(path.join(projectDir, "task-trees.json"), "utf8"));
  assert.ok(registry.trees.some((tree) => tree.id === "architecture"), "architecture tree was not registered");

  const second = await runNode([installer, projectDir, kitDir, stubDir]);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  const agentsAgain = await readFile(path.join(projectDir, "AGENTS.md"), "utf8");
  assert.equal((agentsAgain.match(/<!-- llm-task-tree:begin -->/g) || []).length, 1, "AGENTS merge is not idempotent");
  const cursorAgain = JSON.parse(await readFile(path.join(projectDir, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursorAgain.mcpServers.existing, "repeat install lost existing Cursor MCP server");

  const hooks = await runNode([
    path.join(kitDir, "scripts", "install-codex-hooks.mjs"),
    projectDir,
    path.join(kitDir, "templates", "codex")
  ]);
  assert.equal(hooks.code, 0, hooks.stderr || hooks.stdout);
  const hooksJson = JSON.parse(await readFile(path.join(projectDir, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooksJson.hooks.UserPromptSubmit && hooksJson.hooks.Stop);
  assert.ok(existsSync(path.join(projectDir, ".codex", "hooks", "turn-start.mjs")));

  const entry = path.join(stubDir, "mcp-server.mjs");
  const session = await mcpSession(entry, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linux-kit-test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "task_tree_focus"),
    call(4, "task_tree_check_compact", { files: ["task-tree.md"] })
  ], projectDir);
  assert.equal(session.stderr.trim(), "", `stub wrote to stderr: ${session.stderr.slice(0, 300)}`);
  assert.equal(session.responses.find((item) => item.id === 1).result.serverInfo.name, "llm-task-tree");
  assert.equal(session.responses.find((item) => item.id === 2).result.tools.length, 18);
  const focus = JSON.parse(session.responses.find((item) => item.id === 3).result.content[0].text);
  assert.equal(path.resolve(focus.projectRoot), projectDir);
  assert.equal(focus.graphState.current, "ROOT");
  const compact = JSON.parse(session.responses.find((item) => item.id === 4).result.content[0].text);
  assert.equal(compact.ok, true, JSON.stringify(compact));

  for (const relative of ["install-linux.sh", "start-task-tree.sh", "scripts/chain-loop-gate.sh"]) {
    const bytes = readFileSync(path.join(kitDir, relative));
    assert.equal(bytes.includes(13), false, `${relative} still contains CR bytes`);
  }
  const start = await readFile(path.join(kitDir, "start-task-tree.sh"), "utf8");
  assert.match(start, /STUB_INPUT=/);
  assert.match(start, /project-port\.mjs/);

  const shellInstaller = await readFile(path.join(kitDir, "install-linux.sh"), "utf8");
  assert.match(shellInstaller, /--entry "\$KIT_DIR\/scripts\/mcp-server\.mjs"/);
  assert.match(shellInstaller, /--marketplace "\$KIT_DIR\/marketplace"/);
  assert.match(shellInstaller, /codex plugin add task-tree@llm-task-tree/);

  console.log("linux kit e2e: all cases passed");
} finally {
  if (originalStartMode !== null) await chmod(startScript, originalStartMode);
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
