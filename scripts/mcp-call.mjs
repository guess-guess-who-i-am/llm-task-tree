#!/usr/bin/env node
/**
 * Calls one task-tree MCP tool over stdio and prints the result.
 *
 * Exists for the case where the editor has not loaded the MCP server but the tree still has to be
 * written through the tool path — hand-editing `task-tree.md` would skip the backup, the compact
 * gate and the flow sync that `task_tree_write` performs.
 *
 * usage: node scripts/mcp-call.mjs <tool> '<json arguments>'
 *        node scripts/mcp-call.mjs <tool> @arguments.json
 *
 * The `@file` form avoids handing multi-line JSON to a shell that will reinterpret its quotes.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.argv.slice(2);
const rootIndex = cli.indexOf("--project-root");
const projectRoot = rootIndex >= 0 ? path.resolve(cli[rootIndex + 1] || "") : ownRoot;
if (rootIndex >= 0) cli.splice(rootIndex, 2);
const [tool, rawArgs = "{}"] = cli;

if (!tool) {
  console.error("usage: node scripts/mcp-call.mjs [--project-root <path>] <tool> '<json arguments>' | @arguments.json");
  process.exit(2);
}

const entry = [
  path.join(projectRoot, "scripts", "mcp-server.mjs"),
  path.join(projectRoot, "llm-task-tree", "mcp-server.mjs")
].find(existsSync);
if (!entry) {
  console.error(`task-tree MCP entry not found under ${projectRoot}`);
  process.exit(2);
}

const argumentsJson = rawArgs.startsWith("@")
  ? readFileSync(path.resolve(rawArgs.slice(1)), "utf8").replace(/^\uFEFF/, "")
  : rawArgs;

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-call", version: "1" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(argumentsJson) } }
];

const child = spawn(process.execPath, [entry], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = "";
let stderr = "";
const responses = [];

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) responses.push(JSON.parse(line));
    if (responses.length === requests.length) finish();
    index = buffer.indexOf("\n");
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  child.kill();

  const call = responses.find((item) => item.id === 2);
  if (!call) {
    console.error(stderr || `no response (exit ${code})`);
    process.exit(1);
  }
  if (call.error) {
    console.error(JSON.stringify(call.error, null, 2));
    process.exit(1);
  }
  for (const item of call.result?.content || []) console.log(item.text ?? JSON.stringify(item));
  process.exit(call.result?.isError ? 1 : 0);
}

child.on("exit", finish);
setTimeout(() => finish("timeout"), 120000).unref();

for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
