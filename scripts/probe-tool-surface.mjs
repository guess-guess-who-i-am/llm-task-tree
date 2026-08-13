/**
 * Boots an MCP entry the way a host does and reports what it actually serves.
 *
 * The plugin package only names an entry point; which tools appear depends on the runtime that
 * entry resolves to. A package can therefore pass every manifest check and still serve a tool set
 * its own SKILL.md tells the model to call. Only a real handshake settles it.
 *
 *   node scripts/probe-tool-surface.mjs <entry.mjs> [projectRoot]
 */
import { spawn } from "node:child_process";
import path from "node:path";

const [entry, projectRoot = process.cwd()] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/probe-tool-surface.mjs <entry.mjs> [projectRoot]");
  process.exit(2);
}

const child = spawn(process.execPath, [path.resolve(entry)], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"]
});

const responses = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id) responses.set(message.id, message);
    } catch {
      // Anything unparseable on stdout is itself a defect worth seeing.
      console.error(`non-protocol stdout: ${line.slice(0, 200)}`);
    }
  }
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const waitFor = (id, ms = 60000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = setInterval(() => {
    if (responses.has(id)) {
      clearInterval(tick);
      resolve(responses.get(id));
    } else if (Date.now() - started > ms) {
      clearInterval(tick);
      reject(new Error(`timed out waiting for response ${id}`));
    }
  }, 50);
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "resources/list" });

try {
  const init = await waitFor(1);
  const tools = (await waitFor(2)).result?.tools || [];
  const resources = (await waitFor(3)).result?.resources || [];

  console.log(`entry: ${path.resolve(entry)}`);
  console.log(`project: ${projectRoot}`);
  console.log(`server: ${init.result?.serverInfo?.name || "?"}`);
  console.log(`tools (${tools.length}): ${tools.map((tool) => tool.name).sort().join(", ")}`);
  console.log(`resources (${resources.length}): ${resources.map((item) => item.uri).join(", ") || "none"}`);

  // The widget only renders when the tool links a template, so that link is part of the surface.
  const open = tools.find((tool) => tool.name === "task_tree_open");
  console.log(`task_tree_open template: ${open ? open._meta?.ui?.resourceUri || "MISSING" : "tool absent"}`);
  if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 400)}`);
} catch (error) {
  console.error(`failed: ${error.message}`);
  if (stderr.trim()) console.error(`stderr: ${stderr.trim().slice(0, 800)}`);
  child.kill();
  process.exit(1);
}

child.kill();
process.exit(0);
