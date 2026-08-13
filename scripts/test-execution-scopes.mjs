import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-scopes-"));
const port = 6000 + Math.floor(Math.random() * 500);
await mkdir(path.join(fixture, "scripts"), { recursive: true });
await writeFile(path.join(fixture, "task-tree.md"), `# LLM Task Graph

## N1 - Agent one
- Completion: 进行中
- CurrentResult: old-one
- NextIdea: do-one

## N2 - Agent two
- Completion: 进行中
- CurrentResult: old-two
- NextIdea: do-two

# GraphState
- Current: N1
- Next: N1
- NextPlan:

# Edges
`, "utf8");

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TASK_TREE_PROJECT_ROOT: fixture },
  stdio: ["ignore", "pipe", "pipe"]
});

async function request(method, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

try {
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/tree`)).ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "server did not start");

  const one = (await request("POST", "/api/execution-scopes", { targetNodeIds: ["N1"], writableNodeIds: ["N1"], instruction: "one" })).payload.scope;
  const two = (await request("POST", "/api/execution-scopes", { targetNodeIds: ["N2"], writableNodeIds: ["N2"], instruction: "two" })).payload.scope;
  assert.notEqual(one.scopeId, two.scopeId);

  const denied = await request("POST", "/api/tree/node-patch", { scopeId: one.scopeId, nodeId: "N2", fields: { CurrentResult: "wrong" }, reason: "wrong node" });
  assert.equal(denied.response.status, 403);

  const [left, right] = await Promise.all([
    request("POST", "/api/tree/node-patch", { scopeId: one.scopeId, nodeId: "N1", fields: { CurrentResult: "new-one" }, reason: "write one" }),
    request("POST", "/api/tree/node-patch", { scopeId: two.scopeId, nodeId: "N2", fields: { CurrentResult: "new-two" }, reason: "write two" })
  ]);
  assert.equal(left.response.status, 200);
  assert.equal(right.response.status, 200);
  const markdown = await readFile(path.join(fixture, "task-tree.md"), "utf8");
  assert.match(markdown, /CurrentResult: new-one/);
  assert.match(markdown, /CurrentResult: new-two/);
  console.log("PASS execution scopes isolate targets, reject cross-node writes, and preserve concurrent patches");
} finally {
  child.kill();
  await rm(fixture, { recursive: true, force: true });
}
