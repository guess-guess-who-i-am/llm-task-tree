import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createParallelCodexCoordinator } from "../server/codex-coordinator.js";
import { createGitWorkspaceManager } from "../server/parallel-worktree.js";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const exec = promisify(execFile);
const appPort = process.env.PORT || "5412";
const appUrl = `http://127.0.0.1:${appPort}`;
const browserExecutable = process.env.BROWSER_EXECUTABLE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(existsSync);
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-parallel-ui-project-"));
const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-parallel-ui-worktrees-"));
const git = (args) => exec("git", args, { cwd: fixtureRoot, windowsHide: true });
const fileText = async (relative) => (await readFile(path.join(fixtureRoot, relative), "utf8")).replace(/\r\n/g, "\n");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let planGeneration = 0;
let failApiNext = false;
const workerRuns = { ui: 0, api: 0 };

async function prepareFixture() {
  await mkdir(path.join(fixtureRoot, "public"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "server"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "public", "parallel-ui.txt"), "base ui\n");
  await writeFile(path.join(fixtureRoot, "server", "parallel-api.txt"), "base api\n");
  await writeFile(path.join(fixtureRoot, "scripts", "parallel-pass.mjs"), "console.log('fixture pass');\n");
  await writeFile(path.join(fixtureRoot, "task-tree.md"), [
    "# Task Tree",
    "## ROOT - Fixture",
    "- Problem: 验证自动并行",
    "- Completion: 进行中",
    "## N2 - 界面",
    "- Problem: 更新界面文件",
    "- NextIdea: 完成界面分支",
    "- Completion: 进行中",
    "## N3 - 服务",
    "- Problem: 更新服务文件",
    "- NextIdea: 完成服务分支",
    "- Completion: 进行中",
    ""
  ].join("\n"));
  await git(["init"]);
  await git(["config", "user.name", "Parallel UI Test"]);
  await git(["config", "user.email", "parallel-ui@test.local"]);
  await git(["add", "."]);
  await git(["commit", "-m", "fixture base"]);
}

async function fakeCodexTurn({ prompt, cwd }) {
  if (prompt.includes("Automatic Parallel Planner")) {
    planGeneration += 1;
    return {
      threadId: `planner-${planGeneration}`,
      turnId: `planner-turn-${planGeneration}`,
      output: JSON.stringify({
        summary: `第 ${planGeneration} 轮：界面与服务并行，合并后统一验收。`,
        jobs: [
          {
            taskId: "ui",
            nodeId: "N2",
            title: "界面",
            instruction: "更新界面结果文件并通过测试",
            writeSet: ["public/**"],
            dependsOn: [],
            tests: ["node scripts/parallel-pass.mjs"]
          },
          {
            taskId: "api",
            nodeId: "N3",
            title: "服务",
            instruction: "更新服务结果文件并通过测试",
            writeSet: ["server/**"],
            dependsOn: [],
            tests: ["node scripts/parallel-pass.mjs"]
          }
        ],
        integrationTests: ["node scripts/parallel-pass.mjs"]
      })
    };
  }
  const taskId = prompt.match(/^Task id: (.+)$/m)?.[1];
  if (taskId === "ui") {
    workerRuns.ui += 1;
    await pause(250);
    await writeFile(path.join(cwd, "public", "parallel-ui.txt"), `ui run ${planGeneration}\n`);
    return { threadId: `worker-ui-${planGeneration}`, turnId: "worker-ui-turn", output: '{"event":"completed","changedFiles":["public/parallel-ui.txt"],"affectedNodes":["N2"],"evidence":"fixture"}' };
  }
  if (taskId === "api") {
    workerRuns.api += 1;
    await pause(250);
    if (failApiNext) {
      failApiNext = false;
      throw new Error("fixture api worker failed once");
    }
    await writeFile(path.join(cwd, "server", "parallel-api.txt"), `api run ${planGeneration}\n`);
    return { threadId: `worker-api-${planGeneration}`, turnId: "worker-api-turn", output: '{"event":"completed","changedFiles":["server/parallel-api.txt"],"affectedNodes":["N3"],"evidence":"fixture"}' };
  }
  if (prompt.includes("Integration Coordinator")) {
    await pause(200);
    const continuity = prompt.includes("no previous accepted or reviewed run") ? "baseline" : "stable";
    return {
      threadId: `coordinator-${planGeneration}`,
      turnId: `coordinator-turn-${planGeneration}`,
      output: JSON.stringify({
        event: "completed",
        summary: "两个隔离分支均已集成并通过测试",
        affectedNodes: ["N2", "N3"],
        evidence: "3/3 tests passed",
        goalAssessment: { alignment: "aligned", progress: "progress", continuity, achieved: "并行分支形成可验证结果", remaining: "仍需长期业务观察" }
      })
    };
  }
  throw new Error("unexpected fake Codex prompt");
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function createParallelApiServer(coordinator) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (pathname === "/api/codex/parallel/plan" && req.method === "POST") {
        const body = await readJson(req);
        return json(res, 201, { run: await coordinator.plan({ objective: body.objective || "" }) });
      }
      const action = pathname.match(/^\/api\/codex\/parallel\/([A-Za-z0-9-]+)\/(approve|retry|accept|reject)$/);
      if (action && req.method === "POST") {
        const body = await readJson(req);
        const run = action[2] === "approve"
          ? await coordinator.approve(action[1], body)
          : action[2] === "retry"
            ? await coordinator.retry(action[1], body)
          : action[2] === "accept"
            ? await coordinator.accept(action[1])
            : await coordinator.reject(action[1]);
        return json(res, ["approve", "retry"].includes(action[2]) ? 202 : 200, { run });
      }
      const read = pathname.match(/^\/api\/codex\/parallel\/([A-Za-z0-9-]+)$/);
      if (read && req.method === "GET") {
        const run = await coordinator.get(read[1]);
        return run ? json(res, 200, { run }) : json(res, 404, { error: "not found" });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, error.code === "MAIN_WORKSPACE_CHANGED" ? 409 : 400, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

assert.ok(browserExecutable, "no system Chrome or Edge executable found");
await prepareFixture();
const coordinator = createParallelCodexCoordinator({
  projectRoot: fixtureRoot,
  workspace: createGitWorkspaceManager({ projectRoot: fixtureRoot, tempRoot: worktreeRoot }),
  startTurn: fakeCodexTurn,
  onAccepted: async () => ({ status: "completed" })
});
const api = await createParallelApiServer(coordinator);
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/codex/parallel/**", async (route) => {
    const request = route.request();
    const target = `${api.url}${new URL(request.url()).pathname}`;
    const response = await fetch(target, {
      method: request.method(),
      headers: { "content-type": "application/json" },
      body: request.method() === "GET" ? undefined : request.postData() || "{}"
    });
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    localStorage.removeItem(`task-tree:codex-parallel:${location.origin}${location.pathname}`);
    const overview = document.querySelector("#projectOverviewDialog");
    if (overview?.open) overview.close();
  });

  let clicks = 0;
  const click = async (selector) => {
    clicks += 1;
    await page.locator(selector).click();
  };

  assert.equal(await page.locator("#codexParallelBtn").isVisible(), true);
  await page.locator(".topbar").screenshot({ path: "artifacts/parallel-direct-entry.png" });
  await click("#codexParallelBtn");
  await page.waitForFunction(() => {
    const button = document.querySelector("#codexParallelStart");
    return button && !button.disabled && document.querySelector("#codexParallelState")?.textContent.includes("待确认");
  }, null, { timeout: 30000 });
  assert.match(await page.locator("#codexParallelState").innerText(), /待确认/);
  await click("#codexParallelStart");
  await page.locator("#codexParallelStart").waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await page.locator("#codexParallelAccept").isVisible(), false, "end review stays hidden until automation completes");
  assert.equal(await page.locator("#codexParallelReject").isVisible(), false, "running phase must not ask for worker decisions");
  await page.locator("#codexParallelAccept").waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await fileText("public/parallel-ui.txt"), "base ui\n", "review must not alter the main project");
  assert.equal(await fileText("server/parallel-api.txt"), "base api\n", "review must stay isolated");
  assert.equal(await page.locator("#projectOverviewDialog").evaluate((dialog) => dialog.open), false, "daily overview must not cover parallel review");
  await page.locator("#codexParallelDialog").screenshot({ path: "artifacts/parallel-real-end-review.png" });
  const acceptStartedAt = Date.now();
  await click("#codexParallelAccept");
  await page.waitForFunction(() => document.querySelector("#codexParallelState")?.textContent.startsWith("已应用"), null, { timeout: 30000 });
  const acceptResponseMs = Date.now() - acceptStartedAt;
  await page.waitForFunction(() => document.querySelector("#codexParallelState")?.textContent.trim() === "已应用", null, { timeout: 30000 });
  assert.equal(clicks, 3, "accept flow should need entry, start review, and end review only");
  assert.equal(await fileText("public/parallel-ui.txt"), "ui run 1\n");
  assert.equal(await fileText("server/parallel-api.txt"), "api run 1\n");

  await click("#codexParallelClose");
  await page.locator("#codexParallelDialog").waitFor({ state: "hidden" });
  clicks = 0;
  await click("#codexParallelBtn");
  await page.waitForFunction(() => {
    const button = document.querySelector("#codexParallelStart");
    return button && !button.disabled && document.querySelector("#codexParallelState")?.textContent.includes("待确认");
  }, null, { timeout: 30000 });
  await click("#codexParallelStart");
  await page.locator("#codexParallelReject").waitFor({ state: "visible", timeout: 30000 });
  await click("#codexParallelReject");
  await page.locator("#codexParallelState").getByText("已丢弃", { exact: false }).waitFor();
  assert.equal(clicks, 3, "reject flow should need entry, start review, and end review only");
  assert.equal(await fileText("public/parallel-ui.txt"), "ui run 1\n", "rejected UI result must not be applied");
  assert.equal(await fileText("server/parallel-api.txt"), "api run 1\n", "rejected API result must not be applied");

  await click("#codexParallelClose");
  await page.locator("#codexParallelDialog").waitFor({ state: "hidden" });
  failApiNext = true;
  await click("#codexParallelBtn");
  await page.waitForFunction(() => {
    const button = document.querySelector("#codexParallelStart");
    return button && !button.disabled && document.querySelector("#codexParallelState")?.textContent.includes("待确认");
  }, null, { timeout: 30000 });
  await click("#codexParallelStart");
  await page.locator("#codexParallelRetry").waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await page.locator("#codexParallelAccept").isDisabled(), true, "a failed worker must lock acceptance even when integration tests pass");
  assert.match(await page.locator("#codexParallelState").innerText(), /1 个分支待修复/);
  assert.equal(await page.locator('tr[data-task-id="api"] .codexParallelInstruction').isEditable(), true);
  assert.equal(await page.locator('tr[data-task-id="ui"] .codexParallelTaskText').isVisible(), true);
  await page.locator("#codexParallelDialog").screenshot({ path: "artifacts/parallel-failed-review.png" });
  await page.locator('tr[data-task-id="api"] .codexParallelJobSettings summary').click();
  await page.locator('tr[data-task-id="api"] .codexParallelInstruction').fill("修复 API 分支并重新验证");
  const uiRunsBeforeRetry = workerRuns.ui;
  await click("#codexParallelRetry");
  await page.waitForFunction(() => {
    const button = document.querySelector("#codexParallelAccept");
    return button && !button.hidden && !button.disabled;
  }, null, { timeout: 30000 });
  assert.equal(workerRuns.ui, uiRunsBeforeRetry, "completed UI worker must not rerun");
  assert.equal(await fileText("public/parallel-ui.txt"), "ui run 1\n", "retry review must remain isolated from main project");
  assert.equal(await fileText("server/parallel-api.txt"), "api run 1\n", "retry review must remain isolated from main project");
  await page.locator("#codexParallelDialog").screenshot({ path: "artifacts/parallel-retry-success-review.png" });
  await click("#codexParallelAccept");
  await page.waitForFunction(() => document.querySelector("#codexParallelState")?.textContent.trim() === "已应用", null, { timeout: 30000 });
  assert.equal(await fileText("public/parallel-ui.txt"), "ui run 3\n");
  assert.equal(await fileText("server/parallel-api.txt"), "api run 3\n");

  console.log(`PASS real browser covers three-click success, rejection, strict failure gate, and failed-only retry; accept response ${acceptResponseMs}ms`);
} finally {
  await browser.close();
  await new Promise((resolve) => api.server.close(resolve));
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
