import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autoBuildFlowScript, parseFlowMarkdown, resolveRebuiltFlowFocus } from "../server/flow-script.js";

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

await runCase("multiline Completion is parsed", async () => {
  const parsed = parseFlowMarkdown(`# LLM Task Graph\n\n## N1 - Test\n- Completion:\n  - 进行中\n\n# GraphState\n- Current: N1\n- Next: N1\n\n# Edges\n`);
  assert.equal(parsed.nodes[0]?.completion, "进行中");
});

await runCase("flow rebuild preserves a valid focus and otherwise prefers GraphState.Next", async () => {
  const parsed = parseFlowMarkdown(`# LLM Task Graph\n\n## N1 - Done\n- Completion: 已完成\n\n## N2 - Next\n- Completion: 进行中\n\n# GraphState\n- Current: N1\n- Next: N2\n\n# Edges\n`);
  const built = autoBuildFlowScript(parsed, "project");
  assert.equal(built.focusId, "N2", "a new flow should focus the executable Next node");
  assert.equal(resolveRebuiltFlowFocus({
    previousFocusId: "N1",
    blocks: built.blocks,
    graphState: parsed.graphState
  }), "N1", "a still-valid user flow focus survives rebuild");
  assert.equal(resolveRebuiltFlowFocus({
    previousFocusId: "ST-OLD",
    blocks: built.blocks,
    graphState: parsed.graphState
  }), "N2", "a removed focus falls back to GraphState.Next instead of Current");
});

await runCase("NextPlan is masked as non-executable user memo", async () => {
  const { maskAdvisoryNextPlan } = await import("../server/maintenance.js");
  const masked = maskAdvisoryNextPlan("# GraphState\n- Current: N1\n- Next: N1\n- NextPlan: 重新做旧实验\n  继续执行旧参数\n- ChainRunStatus: running\n");
  assert.doesNotMatch(masked, /重新做旧实验/);
  assert.doesNotMatch(masked, /旧参数/);
  assert.match(masked, /用户备忘.*禁止执行/);
  assert.match(masked, /ChainRunStatus: running/);
});

await runCase("tree registry endpoints expose method and background trees", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-registry-"));
  const port = 5400 + Math.floor(Math.random() * 500);
  await mkdir(path.join(fixture, "trees"), { recursive: true });
  await mkdir(path.join(fixture, "scripts"), { recursive: true });
  await writeFile(path.join(fixture, "task-tree.md"), "# LLM Task Graph\n\n## ROOT - Method\n- Completion: 进行中\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n", "utf8");
  await writeFile(path.join(fixture, "scripts", "project.json"), JSON.stringify({
    schema: "flow-script/v1",
    mode: "project",
    focusId: "ROOT",
    blocks: [{ id: "root", type: "task", nodeId: "ROOT", title: "Method", status: "active" }]
  }, null, 2), "utf8");
  await writeFile(path.join(fixture, "trees", "background.md"), "# LLM Task Graph\n\n## BG - Background marker\n- Completion: 已完成\n\n# GraphState\n- Current: BG\n- Next: BG\n\n# Edges\n", "utf8");
  await writeFile(path.join(fixture, "task-trees.json"), JSON.stringify({
    schema: "task-tree-registry/v1",
    activeMethod: "method",
    trees: [
      { id: "method", title: "方法迭代", role: "method", path: "task-tree.md", flowEnabled: true },
      { id: "background", title: "背景支撑", role: "background", path: "trees/background.md", flowEnabled: false }
    ]
  }, null, 2), "utf8");
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TASK_TREE_PROJECT_ROOT: fixture },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    let ready = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tree`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "fixture server did not start");
    const registryResponse = await fetch(`http://127.0.0.1:${port}/api/trees`);
    assert.equal(registryResponse.status, 200);
    const registry = await registryResponse.json();
    assert.equal(registry.activeMethod, "method");
    assert.equal(registry.trees.length, 2);
    const backgroundResponse = await fetch(`http://127.0.0.1:${port}/api/tree?tree=background`);
    assert.equal(backgroundResponse.status, 200);
    const background = await backgroundResponse.json();
    assert.match(background.markdown, /Background marker/);
    assert.equal(registry.trees.find((tree) => tree.id === "background")?.flowEnabled, false);
    const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/execution-catalog`);
    const catalog = await catalogResponse.json();
    assert.ok(!catalog.nodes?.some((node) => node.id === "BG"), "background nodes leaked into execution catalog");
    const createScope = await fetch(`http://127.0.0.1:${port}/api/execution-scopes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetNodeIds: ["ROOT"], writableNodeIds: ["ROOT"], instruction: "更新 ROOT" })
    });
    assert.equal(createScope.status, 201);
    const scope = (await createScope.json()).scope;
    const scopedPatch = await fetch(`http://127.0.0.1:${port}/api/tree/node-patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeId: scope.scopeId, nodeId: "ROOT", fields: { CurrentResult: "范围内写入成功" }, reason: "测试执行范围写入" })
    });
    assert.equal(scopedPatch.status, 200);
    const deniedPatch = await fetch(`http://127.0.0.1:${port}/api/tree/node-patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeId: scope.scopeId, nodeId: "BG", fields: { CurrentResult: "不应写入" }, reason: "测试越权拒绝" })
    });
    assert.equal(deniedPatch.status, 403);
    assert.match((await deniedPatch.json()).error, /可写范围/);
    const completedMarkdown = "# LLM Task Graph\n\n## ROOT - Method\n- Completion: 已完成\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n- NextPlan: stale memo\n\n# Edges\n";
    const saveResponse = await fetch(`http://127.0.0.1:${port}/api/tree?tree=method`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: completedMarkdown, source: "ui", backup: false })
    });
    const saved = await saveResponse.json();
    assert.equal(saved.flowSync.changed, 1);
    const syncedFlow = JSON.parse(await readFile(path.join(fixture, "scripts", "project.json"), "utf8"));
    assert.equal(syncedFlow.blocks[0].status, "done");
  } finally {
    child.kill();
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("maintenance audit detects missing tree writeback and step evidence", async () => {
  const { auditTurnMaintenance } = await import("../server/maintenance.js");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-maintenance-"));
  try {
    await mkdir(path.join(fixture, "scripts"), { recursive: true });
    await writeFile(path.join(fixture, "task-tree.md"), "# LLM Task Graph\n\n## N1 - Work\n- Completion: 进行中\n- CurrentResult:\n\n# GraphState\n- Current: N1\n- Next: N1\n\n# Edges\n", "utf8");
    const result = await auditTurnMaintenance({
      projectRoot: fixture,
      startedAtMs: Date.now() - 1000,
      changedFiles: ["src/example.js"],
      activeTreeId: "method"
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "TREE_NOT_UPDATED"));
    assert.ok(result.issues.some((issue) => issue.code === "STEP_EVIDENCE_MISSING"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("maintenance audit reads focus CurrentResult after tree writeback", async () => {
  const { auditTurnMaintenance } = await import("../server/maintenance.js");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-result-"));
  try {
    await mkdir(path.join(fixture, "scripts", "steps", "N1", "latest"), { recursive: true });
    await writeFile(path.join(fixture, "task-tree.md"), "# LLM Task Graph\n\n## N1 - Work\n- Completion: 进行中\n- CurrentResult: 已记录可测结果\n\n# GraphState\n- Current: N1\n- Next: N1\n\n# Edges\n", "utf8");
    await writeFile(path.join(fixture, "scripts", "steps", "N1", "latest", "step.json"), "{}\n", "utf8");
    const result = await auditTurnMaintenance({
      projectRoot: fixture,
      changedFiles: ["task-tree.md", "scripts/steps/N1/latest/step.json"],
      activeTreeId: "method"
    });
    assert.ok(!result.warnings.some((warning) => warning.code === "FOCUS_RESULT_EMPTY"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("maintenance audit blocks over-budget fields after tree write", async () => {
  const { auditTurnMaintenance } = await import("../server/maintenance.js");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-compact-gate-"));
  try {
    await mkdir(path.join(fixture, "scripts", "steps", "N1", "latest"), { recursive: true });
    const longProblem = "长".repeat(141);
    await writeFile(
      path.join(fixture, "task-tree.md"),
      `# LLM Task Graph\n\n## N1 - Work\n- Completion: 进行中\n- Problem: ${longProblem}\n- CurrentResult: 已记录\n\n# GraphState\n- Current: N1\n- Next: N1\n\n# Edges\n`,
      "utf8"
    );
    await writeFile(path.join(fixture, "scripts", "steps", "N1", "latest", "step.json"), "{}\n", "utf8");
    const result = await auditTurnMaintenance({
      projectRoot: fixture,
      changedFiles: ["task-tree.md", "scripts/steps/N1/latest/step.json"],
      activeTreeId: "method"
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "TREE_FIELDS_OVER_BUDGET"));
    assert.equal(result.tree.overBudgetFields, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("active method tree has a whole-tree byte budget", async () => {
  const { ACTIVE_METHOD_TREE_MAX_BYTES, inspectTreeMarkdown } = await import("../server/tree-quality.js");
  const report = inspectTreeMarkdown(`序${"短\n".repeat(ACTIVE_METHOD_TREE_MAX_BYTES)}`, {
    file: "task-tree.md",
    maxBytes: ACTIVE_METHOD_TREE_MAX_BYTES
  });
  const violation = report.violations.find((item) => item.field === "TotalBytes");
  assert.ok(violation, "expected a whole-tree size violation");
  assert.equal(violation.unit, "bytes");
  assert.equal(violation.budget, ACTIVE_METHOD_TREE_MAX_BYTES);
});

await runCase("method tree save can synchronize deterministic flow statuses", async () => {
  const { syncMethodFlowStatus } = await import("../server/maintenance.js");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-flow-sync-"));
  try {
    await mkdir(path.join(fixture, "scripts"), { recursive: true });
    await writeFile(path.join(fixture, "task-tree.md"), "# LLM Task Graph\n\n## N1 - Work\n- Completion: 已完成\n\n# GraphState\n- Current: N1\n- Next: N1\n\n# Edges\n", "utf8");
    await writeFile(path.join(fixture, "scripts", "project.json"), JSON.stringify({
      schema: "flow-script/v1",
      mode: "project",
      focusId: "N1",
      blocks: [{ id: "b1", type: "task", nodeId: "N1", title: "Work", status: "pending" }]
    }, null, 2), "utf8");
    const result = await syncMethodFlowStatus({ projectRoot: fixture, treeFile: path.join(fixture, "task-tree.md") });
    assert.equal(result.changed, 1);
    const flow = JSON.parse(await readFile(path.join(fixture, "scripts", "project.json"), "utf8"));
    assert.equal(flow.blocks[0].status, "done");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("postflight can create minimal step evidence", async () => {
  const { ensureMinimalStepEvidence } = await import("../server/maintenance.js");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-auto-step-"));
  try {
    await mkdir(path.join(fixture, "scripts"), { recursive: true });
    const before = "# LLM Task Graph\n\n## N1 - Work\n- Completion: 进行中\n- CurrentResult:\n\n# GraphState\n- Current: N2\n- Next: N2\n\n# Edges\n";
    const after = "# LLM Task Graph\n\n## N1 - Work\n- Completion: 进行中\n- CurrentResult: 已修改实现\n\n# GraphState\n- Current: N2\n- Next: N2\n\n# Edges\n";
    await writeFile(path.join(fixture, "task-tree.md"), after, "utf8");
    const result = await ensureMinimalStepEvidence({ projectRoot: fixture, changedFiles: ["src/changed.js", "task-tree.md"], previousTreeMarkdown: before });
    assert.equal(result.created, true);
    const step = JSON.parse(await readFile(path.join(fixture, "scripts", "steps", "N1", "latest", "step.json"), "utf8"));
    assert.equal(step.nodeId, "N1");
    assert.ok(step.substeps.some((item) => item.autoGenerated === true));
    assert.match(await readFile(path.join(fixture, "scripts", "steps", "N1", "latest", "report.zh.md"), "utf8"), /自动生成/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("Codex hook installer preserves existing hooks", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-hooks-"));
  const template = path.join(fixture, "template");
  const project = path.join(fixture, "project");
  try {
    await mkdir(path.join(template, "hooks"), { recursive: true });
    await mkdir(path.join(project, ".codex"), { recursive: true });
    await copyFile(path.join(root, ".codex", "hooks.json"), path.join(template, "hooks.json"));
    await copyFile(path.join(root, ".codex", "hooks", "turn-start.mjs"), path.join(template, "hooks", "turn-start.mjs"));
    await copyFile(path.join(root, ".codex", "hooks", "stop-postflight.mjs"), path.join(template, "hooks", "stop-postflight.mjs"));
    await writeFile(path.join(project, ".codex", "hooks.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo existing" }] }] }
    }), "utf8");
    const child = spawn(process.execPath, [path.join(root, "scripts", "install-codex-hooks.mjs"), project, template], { stdio: "inherit" });
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0);
    const installed = JSON.parse(await readFile(path.join(project, ".codex", "hooks.json"), "utf8"));
    assert.equal(installed.hooks.PreToolUse.length, 1);
    assert.equal(installed.hooks.UserPromptSubmit.length, 1);
    assert.equal(installed.hooks.Stop.length, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

await runCase("UserPromptSubmit injects live focus before work starts", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "task-tree-turn-context-"));
  try {
    await writeFile(path.join(fixture, "task-tree.md"), [
      "# LLM Task Graph",
      "",
      "## ROOT - 共享任务上下文",
      "- Problem: 让人快速判断项目状态并纠正模型方向",
      "- Approach: 按信息寿命分层，活树只保留决策状态",
      "- Metrics: 30 秒内能决定下一方向",
      "- CurrentResult: 已把核心状态与执行证据分开",
      "",
      "## N1 - 已完成工作",
      "- Completion: 已完成",
      "- CurrentResult: 已测得结果",
      "- NextIdea:",
      "",
      "## N2 - 当前方法",
      "- Completion: 进行中",
      "- CurrentResult:",
      "- Metrics: 能明确说明当前能力、剩余差距和是否达到阶段目标",
      "- NextIdea: 核对现有产物后实现一个可验证步骤。",
      "",
      "# GraphState",
      "- Current: N1",
      "- Next: N2",
      "- NextPlan: 重新执行旧计划",
      "",
      "# Edges",
      ""
    ].join("\n"), "utf8");
    await writeFile(path.join(fixture, "task-trees.json"), `${JSON.stringify({
      schema: "task-tree-registry/v1",
      activeMethod: "method",
      trees: [{ id: "method", title: "方法迭代", role: "method", path: "task-tree.md" }]
    }, null, 2)}\n`, "utf8");

    const hook = path.join(root, ".codex", "hooks", "turn-start.mjs");
    const child = spawn(process.execPath, [hook], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: fixture,
      session_id: "session-test",
      turn_id: "turn-test",
      prompt: "继续"
    }));
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));

    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
    const context = output.hookSpecificOutput?.additionalContext || "";
    assert.match(context, /GraphState\.Current: N1/);
    assert.match(context, /GraphState\.Next: N2 - 当前方法/);
    assert.match(context, /Root purpose \(highest priority\): 让人快速判断项目状态并纠正模型方向/);
    assert.match(context, /Project direction: 按信息寿命分层，活树只保留决策状态/);
    assert.match(context, /Success test: 30 秒内能决定下一方向/);
    assert.match(context, /核对现有产物后实现一个可验证步骤/);
    assert.match(context, /Active stage goal.*当前方法/);
    assert.match(context, /Active stage success test.*当前能力、剩余差距和是否达到阶段目标/);
    assert.match(context, /CurrentResult must directly answer the user's Root or active-stage goal/);
    assert.match(context, /verified capability or evidence exists now.*what remains missing.*whether the goal can currently be claimed reached/);
    assert.match(context, /Numbers are optional/);
    assert.doesNotMatch(context, /must begin with one direction-level conclusion/);
    assert.match(context, /Prevent hallucination/);
    assert.match(context, /stale or already satisfied.*do not repeat/i);
    assert.match(context, /After each coherent work unit.*immediately use task_tree_write/i);
    assert.match(context, /semantic node fields in concise Chinese/i);
    assert.match(context, /code, JSON, commands, formulas, raw data, and logs/i);
    assert.doesNotMatch(context, /重新执行旧计划/, "NextPlan contents must never enter executable context");

    const marker = JSON.parse(await readFile(path.join(
      fixture,
      ".task-tree-maintenance",
      "turns",
      "session-test-turn-test.json"
    ), "utf8"));
    assert.equal(marker.activeTreePath, "task-tree.md");
    assert.match(marker.activeTreeMarkdown, /## N2 - 当前方法/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(JSON.stringify({ passed: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ passed: true }, null, 2));
}
