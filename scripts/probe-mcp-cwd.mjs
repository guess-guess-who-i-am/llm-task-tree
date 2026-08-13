/**
 * Which project does a Codex-hosted MCP tool call land in?
 *
 * The desktop app registers one global `mcp_servers.task_tree` with no project argument, so the
 * answer decides whether "open the graph" can mean "this conversation's project": if the tool
 * resolves against the app's working directory instead of the thread's, one registration can only
 * ever serve one project.
 *
 * One app-server, started from a neutral directory, is asked to run the same tool in two threads
 * with different `cwd`s. `mcpServer/tool/call` is host-driven, so this costs no model turn.
 *
 * usage: node scripts/probe-mcp-cwd.mjs <cwd> [<cwd> ...]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { findCodexBinary } from "../server/codex-run.js";

const argv = process.argv.slice(2);
const toolAt = argv.indexOf("--tool");
const tool = toolAt >= 0 ? argv[toolAt + 1] : "task_tree_focus";
const dirs = toolAt >= 0 ? argv.filter((value, index) => index !== toolAt && index !== toolAt + 1) : argv;
if (!dirs.length) {
  console.error("usage: node scripts/probe-mcp-cwd.mjs [--tool <name>] <cwd> [<cwd> ...]");
  process.exit(2);
}

// Neutral on purpose: neither project, so any correct answer has to come from the thread.
const neutral = path.parse(process.cwd()).root;
const child = spawn(findCodexBinary(), ["app-server"], { cwd: neutral, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let buffer = "";
let stderr = "";
let nextId = 1;

child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: {} } })}\n`);
      continue;
    }
    if (message.method) continue;
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

function request(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out; stderr=${stderr.slice(-300)}`)), timeoutMs);
  });
}

const report = { appServerCwd: neutral, threads: [] };
try {
  await request("initialize", { clientInfo: { name: "probe", title: "probe", version: "1.0.0" } });

  for (const dir of dirs) {
    const cwd = path.resolve(dir);
    const row = { cwd };
    try {
      const started = await request("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" });
      row.threadId = started?.thread?.id || started?.threadId || "";
      const result = await request("mcpServer/tool/call", {
        threadId: row.threadId,
        server: "task_tree",
        tool,
        arguments: {}
      });
      const text = result?.content?.[0]?.text ?? result?.result?.content?.[0]?.text ?? JSON.stringify(result);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep the raw text below */ }
      row.resolvedProject = parsed?.projectRoot || "";
      row.activeTree = parsed?.activeTree?.file || "";
      row.current = parsed?.graphState?.current || "";
      row.next = parsed?.graphState?.next || "";
      row.url = parsed?.url || "";
      row.resourceUri = result?._meta?.["ui.resourceUri"] || result?._meta?.ui?.resourceUri || "";
      if (!parsed) row.raw = String(text).slice(0, 400);
    } catch (error) {
      row.error = error.message.slice(0, 400);
    }
    report.threads.push(row);
  }
} catch (error) {
  report.fatal = error.message.slice(0, 400);
} finally {
  child.kill();
}

console.log(JSON.stringify(report, null, 2));

// `task_tree_open` leaves each project's graph server running on purpose — that is the point of
// the tool — and those detached children keep this process alive after the report is printed.
process.exit(report.fatal || report.threads.some((row) => row.error) ? 1 : 0);
