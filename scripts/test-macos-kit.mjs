import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const kit = path.join(root, "llm-task-tree-kit");
const node = process.execPath;
const temp = await mkdtemp(path.join(os.tmpdir(), "llm-task-tree-macos-"));
const project = path.join(temp, "project");
const stub = path.join(project, "llm-task-tree");
const finderProject = path.join(temp, "finder-project");
const installer = path.join(kit, "install-macos.sh");
const launcher = path.join(kit, "open-task-tree-macos.sh");
const physical = (value) => { try { return realpathSync.native(value); } catch { return path.resolve(value); } };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function mcpFocus(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [entry], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP timed out: ${stderr.slice(0, 300)}`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      try { resolve(lines.map((line) => JSON.parse(line))); } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "task_tree_focus" } })}\n`);
  });
}

let port = 0;
try {
  const install = await run(installer, [project], { cwd: root, env: { ...process.env, NODE_BIN: node } });
  assert.equal(install.code, 0, install.stderr || install.stdout);
  for (const relative of ["task-tree.md", "task-trees.json", "AGENTS.md", "llm-task-tree/task-tree.config.json", "llm-task-tree/mcp-server.mjs", "llm-task-tree/open-task-tree.sh", "llm-task-tree/open-task-tree.command", ".cursor/mcp.json", ".codex/hooks.json"]) {
    assert.ok(existsSync(path.join(project, relative)), `missing install output: ${relative}`);
  }
  assert.equal((await stat(path.join(stub, "open-task-tree.command"))).mode & 0o111, 0o111);
  const config = JSON.parse(await readFile(path.join(stub, "task-tree.config.json"), "utf8"));
  assert.equal(physical(path.resolve(stub, config.projectRoot)), physical(project));
  assert.equal(physical(path.resolve(stub, config.sharedKitDir)), physical(kit));

  const serviceRoot = path.join(os.homedir(), "Library", "Services");
  const serviceRunner = path.join(os.homedir(), "Library", "Application Support", "LLMTaskTree", "finder-task-tree.sh");
  const workflowInodes = new Map();
  for (const name of ["创建并打开 LLM 任务树", "打开 LLM 任务树"]) {
    const bundle = path.join(serviceRoot, `${name}.workflow`);
    assert.ok(existsSync(path.join(bundle, "Contents", "Info.plist")), `missing Finder service: ${name}`);
    assert.ok(existsSync(path.join(bundle, "Contents", "document.wflow")), `missing Finder workflow: ${name}`);
    const plist = await run("plutil", ["-lint", path.join(bundle, "Contents", "Info.plist")]);
    assert.equal(plist.code, 0, plist.stderr || plist.stdout);
    workflowInodes.set(name, (await stat(path.join(bundle, "Contents", "document.wflow"))).ino);
  }
  assert.ok(existsSync(serviceRunner), "missing installed Finder service runner");
  const finderPidBefore = (await run("pgrep", ["-x", "Finder"])).stdout.trim();
  await mkdir(finderProject, { recursive: true });
  const finderRun = await run(serviceRunner, ["create-open", finderProject], {
    cwd: root,
    env: {
      HOME: os.homedir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TASK_TREE_NO_OPEN: "1"
    }
  });
  assert.equal(finderRun.code, 0, finderRun.stderr || finderRun.stdout);
  assert.ok(existsSync(path.join(finderProject, "task-tree.md")), "Finder create action must create task-tree.md from a clean Finder environment");
  assert.ok(existsSync(path.join(finderProject, "task-trees.json")), "Finder create action must create task-trees.json from a clean Finder environment");
  assert.ok(existsSync(path.join(finderProject, "llm-task-tree", "task-tree.config.json")), "Finder create action must install the project stub from a clean Finder environment");
  for (const [name, inode] of workflowInodes) {
    const document = path.join(serviceRoot, `${name}.workflow`, "Contents", "document.wflow");
    assert.equal((await stat(document)).ino, inode, `reinstall must preserve the enabled Finder workflow identity: ${name}`);
  }
  const finderPidAfter = (await run("pgrep", ["-x", "Finder"])).stdout.trim();
  if (finderPidBefore && finderPidAfter) {
    assert.equal(finderPidAfter, finderPidBefore, "reinstall with current workflows must not restart Finder or reset enabled Quick Actions");
  }

  const fakeOpen = path.join(temp, "fake-open.sh");
  await (await import("node:fs/promises")).writeFile(fakeOpen, "#!/bin/sh\nprintf '%s\\n' \"$1\" >\"$TASK_TREE_OPEN_CAPTURE\"\n", "utf8");
  await (await import("node:fs/promises")).chmod(fakeOpen, 0o755);
  const openCapture = path.join(temp, "opened-url");
  const started = await run(launcher, [stub], {
    cwd: root,
    env: { ...process.env, NODE_BIN: node, TASK_TREE_OPEN_CMD: fakeOpen, TASK_TREE_OPEN_CAPTURE: openCapture }
  });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const opened = (await readFile(openCapture, "utf8")).trim();
  assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+$/);
  port = Number(new URL(opened).port);
  const serverPid = (await readFile(path.join(project, ".task-tree-server.pid"), "utf8")).trim();
  const processGroup = await run("ps", ["-o", "pgid=", "-p", serverPid]);
  assert.equal(processGroup.stdout.trim(), serverPid, "the IDE must have its own process group so closing the launcher cannot terminate it");

  const generatedLauncher = path.join(stub, "open-task-tree.command");
  const reopened = await run(generatedLauncher, [], {
    cwd: root,
    env: { ...process.env, NODE_BIN: node, TASK_TREE_OPEN_CMD: fakeOpen, TASK_TREE_OPEN_CAPTURE: openCapture }
  });
  assert.equal(reopened.code, 0, reopened.stderr || reopened.stdout);
  assert.equal((await readFile(openCapture, "utf8")).trim(), opened, "the generated project launcher must reuse the same URL");

  const api = await fetch(`${opened}/api/project`);
  assert.equal(api.ok, true);
  const projectInfo = await api.json();
  assert.equal(physical(projectInfo.root), physical(project));

  const responses = await mcpFocus(path.join(stub, "mcp-server.mjs"));
  const focus = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(physical(focus.projectRoot), physical(project));
  assert.equal(focus.graphState.current, "ROOT");
  console.log("macOS kit e2e: install, launcher, browser handoff, project API, MCP and cleanup passed");
} finally {
  if (port) await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
