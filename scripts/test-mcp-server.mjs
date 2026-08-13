import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findChromium } from "../server/graph-render.js";
import { cropTransparentMargins, decodePng, encodePng, flattenOnto } from "../server/png.js";
import { WIDGET_URI } from "../server/graph-widget.js";
import { widgetBundle } from "../server/widget-bundle.js";
import { httpsPortFor, loadLocalTls } from "../server/local-tls.js";
import { listProjectThreads, readPinnedThread, startCodexTurn, threadDeepLink, writePinnedThread } from "../server/codex-run.js";
import { OPEN_GRAPH_PROMPT, buildPresetPrompt, describePresets } from "../server/codex-prompts.js";
import { describeProjects, ensureProjectServer, stablePortFor } from "../server/projects.js";
import { diffTreeMarkdown } from "../server/tree-diff.js";

const root = process.cwd();
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

/**
 * `startCodexTurn` deliberately outlives the request that started it, because killing the
 * app-server would abort a real turn. The fake never ends its turn, so the suite reaps the
 * children itself; otherwise their pipes keep the event loop — and this process — alive after
 * the last case has already printed PASS.
 */
const fakeAppServers = [];
function spawnFakeAppServer(env = {}) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "fake-app-server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  fakeAppServers.push(child);
  return child;
}

/** Drives scripts/mcp-server.mjs over stdio; notifications (no id) expect no response. */
function mcpSession(requests, { cwd = root, expect = 0, timeoutMs = 60000, env = {} } = {}) {
  const expected = expect || requests.filter((item) => item.id !== undefined && item.id !== null).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "mcp-server.mjs")], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    const responses = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server timed out after ${responses.length}/${expected} responses; stderr=${stderr.slice(0, 400)}`));
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
        } catch (error) {
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

await runCase("initialize negotiates protocol and advertises tools", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const init = responses.find((item) => item.id === 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "llm-task-tree");
  assert.ok(init.result.capabilities.tools, "tools capability missing");

  const names = responses.find((item) => item.id === 2).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "task_tree_api",
    "task_tree_chain",
    "task_tree_check_compact",
    "task_tree_flow_status",
    "task_tree_flow_write",
    "task_tree_focus",
    "task_tree_knowledge",
    "task_tree_layout",
    "task_tree_models",
    "task_tree_node",
    "task_tree_open",
    "task_tree_render",
    "task_tree_scope",
    "task_tree_server",
    "task_tree_skills",
    "task_tree_subtree",
    "task_tree_versions",
    "task_tree_write"
  ]);

  const tools = responses.find((item) => item.id === 2).result.tools;
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema must be an object`);
  }
});

await runCase("unknown protocol version falls back to a supported one", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }
  ]);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
});

await runCase("tree diffs report exact persisted node field changes", async () => {
  const before = `# LLM Task Graph\n\n## N1 - 原标题\n- Completion: 进行中\n- CurrentResult: 旧结论\n- NextIdea: 旧动作\n\n# GraphState\n\n- Current: N1\n- Next: N1\n- NextPlan: 用户备忘\n\n# Edges\n`;
  const after = before
    .replace("## N1 - 原标题", "## N1 - 新标题")
    .replace("- CurrentResult: 旧结论", "- CurrentResult: 新结论")
    .replace("- NextIdea: 旧动作", "- NextIdea: 新动作");
  assert.deepEqual(diffTreeMarkdown(before, after), [
    { kind: "node-title", nodeId: "N1", title: "新标题", field: "Title", before: "原标题", after: "新标题" },
    { kind: "node-field", nodeId: "N1", title: "新标题", field: "CurrentResult", before: "旧结论", after: "新结论" },
    { kind: "node-field", nodeId: "N1", title: "新标题", field: "NextIdea", before: "旧动作", after: "新动作" }
  ]);
  assert.deepEqual(diffTreeMarkdown(after, after), [], "an unchanged save must not invent a receipt");
});

await runCase("task_tree_focus reports active tree, focus and NextIdea rule", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_focus")
  ]);
  const result = responses.find((item) => item.id === 2).result;
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.activeTree.file, "task-tree.md");
  assert.ok(payload.graphState.current, "GraphState.Current is empty");
  assert.ok(payload.nextNode?.id, "next node not resolved");
  assert.match(payload.executionRule, /NextPlan.*禁止执行/);
  assert.ok(payload.nodeCount >= 10, `unexpected node count ${payload.nodeCount}`);
});

await runCase("task_tree_node returns full fields and rejects unknown ids", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_node", { nodeId: "N2" }),
    call(3, "task_tree_node", { nodeId: "N-does-not-exist" })
  ]);
  const found = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(found.id, "N2");
  assert.ok(found.fields.Problem, "Problem field missing");
  assert.ok(found.fields.CurrentResult, "CurrentResult field missing");
  assert.equal(found.fields.Position, undefined, "layout fields should be dropped");

  const missing = responses.find((item) => item.id === 3).result;
  assert.equal(missing.isError, true);
  const payload = JSON.parse(missing.content[0].text);
  assert.match(payload.error, /没有节点/);
  assert.ok(payload.searched.some((file) => file.startsWith("subtrees/")), "subtree files are not in the search path");
});

await runCase("task_tree_node exposes the subtree pointer of a folded node", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_node", { nodeId: "N6" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(payload.id, "N6");
  assert.equal(payload.fields.SubtreeFile, "subtrees/N6-subtree.md");
});

await runCase("task_tree_check_compact mirrors the compact gate", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_check_compact"),
    call(3, "task_tree_check_compact", { files: ["task-tree.md", "subtrees/N6-subtree.md"] })
  ]);
  const active = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(active.checked[0].file, "task-tree.md");
  assert.equal(typeof active.ok, "boolean");
  assert.ok(Array.isArray(active.violations));

  const both = JSON.parse(responses.find((item) => item.id === 3).result.content[0].text);
  assert.equal(both.checked.length, 2);
});

await runCase("task_tree_flow_status exposes blocks and drift", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_flow_status")
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok(payload.blocks.length >= 5, `unexpected block count ${payload.blocks.length}`);
  assert.ok(payload.blocks.some((block) => block.type === "hat"));
  assert.ok(payload.drift, "drift missing");
  assert.deepEqual(payload.drift.missingInFlow, [], "every execution node needs a flow block");
  assert.deepEqual(payload.drift.staleInFlow, [], "flow references a node that left the tree");
  assert.deepEqual(
    payload.drift.statusMismatch.filter((item) => item.nodeId === "N12"),
    [],
    "N12 block status disagrees with its Completion"
  );
});

await runCase("project root is discovered from a subdirectory cwd", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_focus")
  ], { cwd: path.join(root, "scripts", "steps") });
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(path.resolve(payload.projectRoot), path.resolve(root));
  assert.equal(payload.activeTree.file, "task-tree.md");
});

await runCase("unknown tool and unknown method return JSON-RPC errors", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_write_everything"),
    { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "x" } }
  ]);
  assert.equal(responses.find((item) => item.id === 2).error.code, -32602);
  assert.equal(responses.find((item) => item.id === 3).error.code, -32601);
});

await runCase("notifications get no response and stdout stays protocol-only", async () => {
  const { responses, stderr } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" }
  ]);
  assert.equal(responses.length, 2);
  assert.equal(responses[1].id, 2, "the notification must not produce a response");
  assert.deepEqual(responses[1].result, {});
  assert.equal(stderr.trim(), "");
});

// ---- tools that talk to the local HTTP server (started on demand) ----------

await runCase("task_tree_server starts the local server headlessly", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_server", { action: "start" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(payload.running, true, `server did not start: ${JSON.stringify(payload)}`);
  assert.ok(payload.port > 0);
  const saved = Number((await readFile(path.join(root, ".task-tree-port"), "utf8")).trim());
  assert.equal(saved, payload.port, "port marker file was not updated");
});

await runCase("task_tree_server repairs a stale primary port marker", async () => {
  const marker = path.join(root, ".task-tree-port");
  const original = await readFile(marker, "utf8");
  try {
    await writeFile(marker, "1\n", "utf8");
    const { responses } = await mcpSession([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      call(2, "task_tree_server", { action: "status" })
    ]);
    const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
    assert.equal(payload.running, true, `live server was not rediscovered: ${JSON.stringify(payload)}`);
    assert.notEqual(payload.port, 1);
    assert.equal((await readFile(marker, "utf8")).trim(), String(payload.port));
  } finally {
    await writeFile(marker, original, "utf8");
  }
});

await runCase("task_tree_write refuses a write that breaks the compact gate", async () => {
  const before = await readFile(path.join(root, "task-tree.md"), "utf8");
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_write", { nodeId: "N12", fields: { NextIdea: "超长".repeat(200) }, reason: "测试门禁拒绝" })
  ]);
  const result = responses.find((item) => item.id === 2).result;
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.error, /门禁/);
  assert.ok(payload.violations.some((item) => item.nodeId === "N12" && item.field === "NextIdea"));
  assert.equal(await readFile(path.join(root, "task-tree.md"), "utf8"), before, "the tree must stay untouched");
});

await runCase("task_tree_write protects GraphState focus and requires a reason", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_write", { nodeId: "N12", fields: { Next: "N1" }, reason: "测试焦点保护" }),
    call(3, "task_tree_write", { nodeId: "N12", fields: { Notes: "x" } })
  ]);
  assert.match(JSON.parse(responses.find((item) => item.id === 2).result.content[0].text).error, /GraphState/);
  assert.match(JSON.parse(responses.find((item) => item.id === 3).result.content[0].text).error, /reason/);
});

await runCase("task_tree_write round-trips an existing node field idempotently", async () => {
  const treePath = path.join(root, "task-tree.md");
  const nodeSection = async () => {
    const text = await readFile(treePath, "utf8");
    return text.slice(text.indexOf("## N12 - "), text.indexOf("# GraphState"));
  };
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_node", { nodeId: "N12" })
  ]);
  const nodeFields = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text).fields;
  const field = ["Notes", "CurrentResult", "Approach", "Problem"].find((name) => nodeFields[name]);
  assert.ok(field, "N12 has no suitable field to round-trip");
  const value = nodeFields[field];
  const sectionBefore = await nodeSection();

  // First write may normalize GraphState (the server fills in ChainForceNext), so the
  // byte-identical guarantee is asserted on the second, already-normalized write.
  const write = async () => {
    const session = await mcpSession([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      call(2, "task_tree_write", { nodeId: "N12", fields: { [field]: value }, reason: `回归：${field} 原值回写` })
    ]);
    return JSON.parse(session.responses.find((item) => item.id === 2).result.content[0].text);
  };

  const first = await write();
  assert.equal(first.ok, true, `write failed: ${JSON.stringify(first)}`);
  assert.deepEqual(first.applied, [field]);
  assert.deepEqual(first.changes, [], "writing the same value must not report a semantic change");
  assert.equal(await nodeSection(), sectionBefore, "writing the same value must not reformat the node");

  const whole = await readFile(treePath, "utf8");
  const second = await write();
  assert.equal(second.ok, true);
  assert.deepEqual(second.changes, [], "a repeated write must keep an empty change receipt");
  assert.equal(await readFile(treePath, "utf8"), whole, "a repeated identical write must change nothing");

  // Regression: an empty GraphState field used to swallow the next line on write.
  const state = whole.slice(whole.indexOf("# GraphState"), whole.indexOf("# Edges"));
  assert.match(state, /^- Current: \S+$/m, "GraphState.Current lost its value");
  assert.match(state, /^- Next: \S+$/m, "GraphState.Next line disappeared");
  assert.match(state, /^- NextPlan: \S+/m, "GraphState.NextPlan line disappeared");
});

await runCase("task_tree_chain returns the current step", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_chain", { action: "step" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok("shouldStopLoop" in payload, `unexpected chain-step payload: ${Object.keys(payload).join(",")}`);
});

await runCase("task_tree_versions lists backups", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_versions", { action: "list", limit: 5 })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok(payload.total > 0, "no versions found");
  assert.ok(payload.versions.length <= 5);
});

await runCase("task_tree_flow_write reports drift without writing", async () => {
  const flowPath = path.join(root, "scripts", "project.json");
  const before = await readFile(flowPath, "utf8");
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_flow_write", { action: "drift" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.deepEqual(payload.drift.missingInFlow, []);
  assert.deepEqual(payload.drift.staleInFlow, []);
  assert.deepEqual(payload.drift.statusMismatch, []);
  // ST-P* pilots stay in the flow but are not part of the ordered execution spine,
  // so orderDiffers is expected; the spine itself must match.
  assert.deepEqual(
    payload.drift.currentOrder.filter((id) => !id.startsWith("ST-P")),
    payload.drift.suggestedOrder
  );
  assert.equal(await readFile(flowPath, "utf8"), before);
});

await runCase("task_tree_skills recommends deduped skills for a node", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_skills", { nodeId: "N12", limit: 6 })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok(Array.isArray(payload.recommendations));
  assert.ok(payload.recommendations.length <= 6);
  const names = payload.recommendations.map((item) => item.name);
  assert.equal(names.length, new Set(names).size, "recommendations must be deduped by name");
});

await runCase("task_tree_knowledge reports index status", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_knowledge", { action: "status" })
  ]);
  const result = responses.find((item) => item.id === 2).result;
  const text = result.content[0].text;
  assert.equal(result.isError, false, `knowledge status failed: ${text.slice(0, 400)}`);
  assert.ok(JSON.parse(text).index, "missing index status");
});

await runCase("task_tree_models lists configured models", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_models", { action: "list" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok(Array.isArray(payload.models));
});

await runCase("task_tree_layout places every node without overlap", async () => {
  const treePath = path.join(root, "task-tree.md");
  const before = await readFile(treePath, "utf8");
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_layout", { dryRun: true })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(payload.dryRun, true);
  assert.equal(await readFile(treePath, "utf8"), before, "dryRun must not write");
  assert.equal(payload.rootId, "ROOT");

  const nodeIds = [...before.matchAll(/^##\s+(\S+)\s+-\s+/gm)]
    .map((match) => match[1])
    .filter((id) => !/^E/.test(id));
  for (const id of nodeIds) {
    assert.ok(payload.positions[id], `node ${id} got no position`);
  }

  // Same-row cards must not overlap horizontally: that is the packing invariant.
  const rows = new Map();
  const sizes = new Map();
  for (const block of before.split(/^##\s+/m)) {
    const id = block.match(/^(\S+)\s+-\s+/)?.[1];
    const size = block.match(/^-\s+Size:\s*([\d.]+)\s*,/m)?.[1];
    if (id) sizes.set(id, Number(size) || 520);
  }
  for (const [id, value] of Object.entries(payload.positions)) {
    const [x, y] = value.split(",").map(Number);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ id, x, right: x + (sizes.get(id) || 520) });
  }
  for (const [y, row] of rows) {
    row.sort((a, b) => a.x - b.x);
    for (let index = 1; index < row.length; index += 1) {
      assert.ok(
        row[index].x >= row[index - 1].right,
        `row ${y}: ${row[index - 1].id} overlaps ${row[index].id}`
      );
    }
  }
});

await runCase("task_tree_subtree reads a subtree file", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_subtree", { action: "read", path: "subtrees/N6-subtree.md" })
  ]);
  const payload = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.match(payload.markdown, /##\s+N6\s+-/);
});

await runCase("png codec round-trips, crops and flattens", async () => {
  // 4x3 with one opaque red pixel and one half-transparent blue pixel, everything else empty.
  const width = 4;
  const height = 3;
  const pixels = Buffer.alloc(width * height * 4);
  const put = (x, y, rgba) => rgba.forEach((value, channel) => { pixels[(y * width + x) * 4 + channel] = value; });
  put(1, 1, [255, 0, 0, 255]);
  put(2, 1, [0, 0, 255, 128]);

  const decoded = decodePng(encodePng(pixels, width, height));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual([...decoded.data], [...pixels], "round-trip must be lossless");

  const cropped = cropTransparentMargins(decoded);
  assert.deepEqual([cropped.width, cropped.height], [2, 1], "crop must hug the painted pixels");

  const flat = flattenOnto(cropped, { background: [255, 255, 255], padding: 1 });
  assert.deepEqual([flat.width, flat.height], [4, 3], "padding must be added on every side");
  const at = (x, y) => [...flat.data.subarray((y * flat.width + x) * 4, (y * flat.width + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [255, 255, 255, 255], "padding is background");
  assert.deepEqual(at(1, 1), [255, 0, 0, 255], "opaque pixels survive untouched");
  assert.deepEqual(at(2, 1), [127, 127, 255, 255], "half-transparent blue blends onto white");
});

await runCase("task_tree_render returns a PNG of the graph", async () => {
  if (!findChromium()) {
    console.log("  (skipped: no Chromium/Edge on this machine)");
    return;
  }
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_render", { scale: 1, width: 1200, height: 800 })
  ], { timeoutMs: 180000 });

  const result = responses.find((item) => item.id === 2).result;
  assert.ok(!result.isError, `render failed: ${result.content?.[0]?.text}`);
  assert.equal(result.structuredContent, undefined, "Codex drops content[] when structuredContent is set");

  const [image, caption] = result.content;
  assert.equal(image.type, "image", "the image block must come first for older Codex builds");
  assert.equal(image.mimeType, "image/png");

  const decoded = decodePng(Buffer.from(image.data, "base64"));
  assert.ok(decoded.width > 200 && decoded.height > 150, `picture is too small: ${decoded.width}x${decoded.height}`);
  assert.ok(
    decoded.data.every((value, index) => index % 4 !== 3 || value === 255),
    "the picture must be opaque so dark chat themes stay readable"
  );
  assert.match(caption.text, /Current|任务图/);
});

await runCase("task_tree_open links a widget the host can render", async () => {
  const captureDir = await mkdtemp(path.join(os.tmpdir(), "task-tree-open-"));
  const captureFile = path.join(captureDir, "opened-url.txt");
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
    { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: WIDGET_URI } },
    call(5, "task_tree_open")
  ], {
    timeoutMs: 120000,
    env: { TASK_TREE_OPEN_CAPTURE: captureFile }
  });

  const init = responses.find((item) => item.id === 1).result;
  assert.ok(init.capabilities.resources, "a widget server must advertise resources");

  const open = responses.find((item) => item.id === 2).result.tools.find((tool) => tool.name === "task_tree_open");
  assert.equal(open._meta.ui.resourceUri, WIDGET_URI, "the tool must link its template");
  assert.equal(open._meta["openai/outputTemplate"], WIDGET_URI, "older hosts read the Apps SDK key");

  const listed = responses.find((item) => item.id === 3).result.resources;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mimeType, "text/html;profile=mcp-app", "the bridge only turns on for this mime type");

  const contents = responses.find((item) => item.id === 4).result.contents[0];
  assert.equal(contents.mimeType, "text/html;profile=mcp-app");
  // Nothing may be linked: the sandbox origin is barred from reaching a loopback address, so a
  // referenced stylesheet or script would simply never load.
  assert.equal(contents.text.match(/(src|href)="\/[^"]*"/g), null, "the page has to arrive whole");
  assert.ok(contents.text.includes("const embedMode"), "the real app.js is what ships");
  assert.ok(contents.text.length > 200000, "a stub instead of the UI would be much smaller");

  const result = responses.find((item) => item.id === 5).result;
  assert.equal(result._meta.ui.resourceUri, WIDGET_URI, "the result must link the template too");
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /已在桌面浏览器打开/);
  assert.match(await readFile(captureFile, "utf8"), /^http:\/\/127\.0\.0\.1:\d+\//);
  await rm(captureDir, { recursive: true, force: true });
});

await runCase("the packed page carries everything it cannot fetch", async () => {
  const html = await widgetBundle({ publicDir: path.join(root, "public") });

  assert.ok(html.includes('id="app"'), "the markup comes from the same index.html the browser gets");
  assert.ok(html.includes("--panel-bg") || html.includes(".topbar"), "styles are inlined, not linked");
  assert.ok(html.includes("window.__taskTreeEmbed = true"), "the page has to know it is in a sandbox");

  // The shim has to exist before the page's own code, which fetches during startup.
  assert.ok(html.indexOf("task_tree_api") < html.indexOf("const embedMode"), "the API shim goes first");

  // `import("/flow-view.js")` resolves against the sandbox origin, where that file does not exist,
  // so those sources ride along and are handed to `import()` as blob urls.
  assert.ok(html.includes('window.__taskTreeLazyModules = {"/flow-view.js":"'), "flow view must ride along");
  assert.ok(html.includes('"/graph-export.js":"'), "so must the export module");

  // An unescaped closing tag ends the script block early and silently truncates the app.
  assert.equal((html.match(/<script/g) || []).length, (html.match(/<\/script>/g) || []).length);

  assert.equal(httpsPortFor(5410), 6410, "one project, one pair of fixed addresses");
  assert.equal(loadLocalTls(path.join(root, "scripts", "no-such-tls-dir")), null, "a missing certificate is not an error");
});

await runCase("the widget can tell the project why it stayed blank", async () => {
  const report = JSON.stringify({ text: "没加载出来", blocks: ["frame-src 拦下 http://127.0.0.1:5410"] });
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_server", { action: "report", report })
  ], { timeoutMs: 60000 });

  const result = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(result.recorded, true);
  const written = JSON.parse(await readFile(path.join(root, result.file), "utf8"));
  assert.equal(written.report, report, "the sandbox has no other way to hand back a diagnosis");
});

await runCase("the project keeps one URL across restarts", async () => {
  const status = async () => {
    const { responses } = await mcpSession([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      call(2, "task_tree_server", { action: "start" })
    ], { timeoutMs: 120000 });
    return JSON.parse(responses.find((item) => item.id === 2).result.content[0].text).url;
  };

  const url = await status();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // Stop and restart: a bookmarked address must survive this.
  await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_server", { action: "stop" })
  ]);
  assert.equal(await status(), url, "restarting must not move the UI to a new port");
});

await runCase("the desktop launcher and the MCP tools agree on one address", async () => {
  if (process.platform !== "win32") return;

  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    call(2, "task_tree_server", { action: "start" })
  ], { timeoutMs: 120000 });
  const served = new URL(JSON.parse(responses.find((item) => item.id === 2).result.content[0].text).url).port;

  // Runs the launcher's own function rather than a copy of its arithmetic, so drifting apart on
  // either side fails here instead of quietly giving the project two addresses.
  const launcher = await readFile(path.join(root, "llm-task-tree-kit", "open-task-tree.ps1"), "utf8");
  const fn = launcher.match(/function Get-StableProjectPort \{[\s\S]*?\n\}/);
  assert.ok(fn, "the launcher must still derive a stable port");

  const script = path.join(os.tmpdir(), `task-tree-port-${process.pid}.ps1`);
  // Windows PowerShell reads a BOM-less script as ANSI, which mangles a non-ASCII project path
  // into a different hash. The launcher never hits this because it resolves its own root at runtime.
  await writeFile(script, `\uFEFF$ProjectRoot = '${root.replace(/'/g, "''")}'\n${fn[0]}\nGet-StableProjectPort\n`, "utf8");
  try {
    const launched = await new Promise((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", () => resolve(out.trim()));
    });
    assert.equal(launched, served, "double-clicking the launcher must reuse the URL the tools report");
    assert.equal(String(stablePortFor(root)), served, "the project switcher must reach a project at the same URL");
  } finally {
    await rm(script, { force: true });
  }
});

await runCase("the switcher lists this machine's other task-tree projects", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "task-tree-projects-"));
  try {
    const kept = path.join(home, "kept");
    const other = path.join(home, "other");
    const gone = path.join(home, "gone");
    const empty = path.join(home, "empty");
    for (const dir of [kept, other, empty]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(kept, "task-tree.md"), "# GraphState\n", "utf8");
    await writeFile(path.join(other, "task-trees.json"), "{}", "utf8");

    const registry = path.join(home, "projects.json");
    // A duplicate spelling, a folder that no longer exists (this is what a mojibake registry entry
    // looks like from here) and a folder with no tree all have to fall out of the menu.
    await writeFile(registry, `\uFEFF${JSON.stringify({
      projects: [other, gone, empty, kept, kept.toUpperCase()]
    })}`, "utf8");

    const listed = describeProjects({ file: registry, currentRoot: kept });
    assert.deepEqual(listed.map((item) => item.root), [kept, other], "only live projects that hold a tree stay");
    assert.equal(listed[0].current, true, "the project you are looking at sorts first and is marked");
    assert.equal(listed[0].port, stablePortFor(kept), "each row carries that project's own fixed port");
    assert.notEqual(listed[0].port, listed[1].port, "two projects must not fight over one port");

    assert.deepEqual(describeProjects({ file: path.join(home, "missing.json"), currentRoot: kept })
      .map((item) => item.root), [kept], "with no registry you can still see where you are");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await runCase("switching to a sleeping project starts it instead of showing a dead link", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "task-tree-switch-"));
  try {
    const target = path.join(home, "target");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "task-tree.md"), "# GraphState\n", "utf8");

    let awake = false;
    const spawned = [];
    const fetchImpl = async () => {
      if (!awake) throw new Error("connection refused");
      return { ok: true, json: async () => ({ root: target }) };
    };

    const started = await ensureProjectServer(target, {
      fallbackKitDir: root,
      fetchImpl,
      spawnImpl: (bin, args, options) => {
        spawned.push(options);
        awake = true;
        return { unref() {} };
      },
      sleep: async () => {}
    });
    assert.equal(started.url, `http://127.0.0.1:${stablePortFor(target)}`, "the new window lands on that project's fixed URL");
    assert.equal(started.started, true, "a sleeping project gets woken up");
    assert.equal(spawned[0].env.TASK_TREE_PROJECT_ROOT, target, "the spawned server serves the target project, not this one");
    assert.equal(spawned[0].env.PORT, String(stablePortFor(target)), "and it takes that project's port");
    assert.equal(spawned[0].cwd, root, "a project without its own checkout borrows the running kit");

    const again = await ensureProjectServer(target, { fallbackKitDir: root, fetchImpl, spawnImpl: () => { throw new Error("must not spawn twice"); } });
    assert.equal(again.started, false, "an awake project is reused, not started a second time");

    await assert.rejects(
      ensureProjectServer(path.join(home, "nope"), { fallbackKitDir: root, fetchImpl }),
      /不在了/,
      "a stale row says so instead of opening an empty page"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await runCase("one click starts a Codex turn and hands back its deeplink", async () => {
  const { threadId } = await startCodexTurn({
    cwd: root,
    spawnCodex: () => spawnFakeAppServer()
  });
  assert.equal(threadDeepLink(threadId), `codex://threads/${threadId}`, "the UI jumps to the thread it just started");
});

await runCase("a completed Codex turn returns its final agent message", async () => {
  const result = await startCodexTurn({
    cwd: root,
    waitForCompletion: true,
    threadName: "并行 worker",
    developerInstructions: "read only",
    spawnCodex: () => spawnFakeAppServer({ FAKE_APP_SERVER_MODE: "complete" })
  });
  assert.equal(result.status, "completed");
  assert.equal(result.output, "worker final report");
});

await runCase("interactive launch does not wait for a later provider refusal", async () => {
  const interactive = await startCodexTurn({
    cwd: root,
    spawnCodex: () => spawnFakeAppServer({ FAKE_APP_SERVER_MODE: "fail" })
  });
  assert.ok(interactive.threadId, "the accepted thread opens immediately and shows its own failure");

  await assert.rejects(
    startCodexTurn({
      cwd: root,
      waitForCompletion: true,
      spawnCodex: () => spawnFakeAppServer({ FAKE_APP_SERVER_MODE: "fail" })
    }),
    (error) => {
      assert.match(error.message, /429/, "the user needs the provider's own words");
      assert.ok(error.threadId, "the empty thread is still worth linking for a look");
      return true;
    }
  );
});

await runCase("the click keeps landing in the conversation the user works in", async () => {
  const fake = (mode) => () => spawnFakeAppServer({
    FAKE_APP_SERVER_CWD: root,
    ...(mode ? { FAKE_APP_SERVER_MODE: mode } : {})
  });
  const pinned = "0000fake-0000-0000-0000-00000000thrd";

  const resumedRun = await startCodexTurn({ cwd: root, threadId: pinned, spawnCodex: fake() });
  assert.equal(resumedRun.threadId, pinned, "an existing thread is continued, not replaced");
  assert.equal(resumedRun.resumed, true, "the caller can tell the user it went to the old thread");

  // A thread archived or deleted in the desktop app must not turn the button into an error.
  const recovered = await startCodexTurn({ cwd: root, threadId: pinned, spawnCodex: fake("gone") });
  assert.equal(recovered.resumed, false, "an unresumable thread falls back to a fresh one");
  assert.ok(recovered.threadId, "the fallback still produces a thread to jump to");

  // A pin left over from another project resumes perfectly well; sending there would file this
  // project's work under another project's history.
  const foreign = await startCodexTurn({ cwd: root, threadId: pinned, spawnCodex: fake("foreign") });
  assert.equal(foreign.resumed, false, "a conversation belonging elsewhere is not continued here");
});

await runCase("the picker offers this project's conversations only", async () => {
  const threads = await listProjectThreads({
    cwd: root,
    spawnCodex: () => spawnFakeAppServer({ FAKE_APP_SERVER_CWD: root })
  });
  assert.deepEqual(
    threads.map((thread) => thread.id),
    ["0000fake-0000-0000-0000-00000000thrd"],
    "another project's threads and throwaway ones stay out of the picker"
  );

  // The list is machine-wide and recency-ordered, so stopping at the first page would tell a quiet
  // project it has no conversations at all - which is exactly what the fake's paging reproduces.
  const firstPageOnly = await listProjectThreads({
    cwd: root,
    maxPages: 1,
    spawnCodex: () => spawnFakeAppServer({ FAKE_APP_SERVER_CWD: root })
  });
  assert.deepEqual(firstPageOnly, [], "the fake keeps this project off page one, so paging is what found it");
});

await runCase("the pinned conversation survives a restart of the server", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "task-tree-pin-"));
  try {
    assert.equal(readPinnedThread(project), "", "nothing is pinned before the first launch");
    writePinnedThread(project, "0000fake-0000-0000-0000-00000000thrd");
    assert.equal(readPinnedThread(project), "0000fake-0000-0000-0000-00000000thrd");

    await writeFile(path.join(project, ".task-tree-thread"), "oops this file got clobbered\n", "utf8");
    assert.equal(readPinnedThread(project), "", "a damaged pin is ignored rather than sent to Codex");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

await runCase("what the button sends is built from the live tree", async () => {
  const focus = {
    nodeId: "N11",
    title: "重构多树上下文",
    nextIdea: "建立 architecture tree",
    rootPurpose: "让人快速判断项目状态并纠正模型方向",
    rootDirection: "按信息寿命分层，活树只保留决策状态",
    rootSuccess: "30 秒内能决定下一方向",
    nextProblem: "让用户无需追问就知道阶段目标达成到什么状态",
    stageSuccess: "能看出已有能力、剩余差距和是否达成"
  };

  const open = buildPresetPrompt("open", { focus });
  assert.equal(open.prompt, OPEN_GRAPH_PROMPT, "the default stays the one-line widget request");

  const next = buildPresetPrompt("next", { focus });
  assert.match(next.prompt, /N11/, "the turn has to name the node it is about");
  assert.match(next.prompt, /Root purpose.*让人快速判断项目状态/, "the root purpose anchors the turn");
  assert.match(next.prompt, /Project direction.*按信息寿命分层/, "the project direction travels with the turn");
  assert.match(next.prompt, /Active stage goal.*无需追问/, "the stage goal travels with the turn");
  assert.match(next.prompt, /Active stage success test.*已有能力、剩余差距和是否达成/, "the stage success test travels with the turn");
  assert.match(next.prompt, /现已具备的能力或证据、仍缺的部分.*能否宣称达到目标/, "the result is written relative to the user's goal");
  assert.match(next.prompt, /数字可选/, "progress does not require an arbitrary percentage");
  assert.doesNotMatch(next.prompt, /CurrentResult 首句写相对 Root purpose 的方向性进展/);
  assert.match(next.prompt, /计划、文件名、截图或预期设计.*不能单独证明完成/, "the prompt blocks hallucinated completion");
  assert.match(next.prompt, /建立 architecture tree/, "the executable instruction is the NextIdea itself");
  assert.match(next.prompt, /已完成或过期.*不要重做/, "a stale NextIdea is reconciled instead of repeated");
  assert.match(next.prompt, /每得到一个可独立验证.*立即.*task_tree_write/, "tree maintenance happens at work-unit checkpoints");
  assert.match(next.prompt, /changes.*旧值 → 新值/, "tree writes must produce an exact user-visible change receipt");
  assert.match(next.prompt, /不要.{0,4}读 GraphState\.NextPlan/, "the memo-is-not-a-plan rule travels with the prompt");
  assert.match(next.prompt, /不要改 GraphState/, "focus stays the user's to move");

  // A node with no NextIdea has nothing executable, and the tree's own rule forbids guessing from
  // NextPlan, so the click must report that instead of inventing work.
  const blocked = buildPresetPrompt("next", { focus: { nodeId: "N11", title: "x", nextIdea: "  " } });
  assert.equal(blocked.prompt, "");
  assert.match(blocked.blocked, /NextIdea/);
});

await runCase("the loop refuses to spin when the chain says stop", async () => {
  const running = buildPresetPrompt("chain", { chain: { agentPrompt: "【Agent 链式单步】\nNext: N3", shouldStopLoop: false } });
  assert.match(running.prompt, /链式循环/);
  assert.match(running.prompt, /Next: N3/, "the loop's own step context is what gets sent");

  const stopped = buildPresetPrompt("chain", { chain: { agentPrompt: "anything", shouldStopLoop: true, stopReason: "Chain 为空" } });
  assert.equal(stopped.prompt, "", "no turn is spent on a loop that should stop");
  assert.match(stopped.blocked, /Chain 为空/, "the user gets the stop reason, not a silent no-op");
});

await runCase("the menu says why a disabled entry is disabled", async () => {
  const entries = describePresets({
    focus: { nodeId: "N11", title: "重构多树上下文", nextIdea: "建立 architecture tree" },
    chain: { shouldStopLoop: true, stopReason: "Chain 为空" }
  });
  assert.deepEqual(entries.map((entry) => entry.id), ["open", "next", "chain"]);
  assert.equal(entries[1].blocked, "", "an executable step is offered");
  assert.match(entries[2].blocked, /Chain 为空/, "a blocked step explains itself in the menu");
});

await runCase("resources/read rejects an unknown uri", async () => {
  const { responses } = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://task-tree/nope.html" } }
  ]);
  assert.equal(responses.find((item) => item.id === 2).error.code, -32602);
});

for (const child of fakeAppServers) child.kill();

console.log(JSON.stringify({ passed: failures.length === 0, failures }, null, 2));
if (failures.length) process.exitCode = 1;
