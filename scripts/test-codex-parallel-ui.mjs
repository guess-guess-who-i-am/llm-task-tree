import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const browserExecutable = process.env.BROWSER_EXECUTABLE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(existsSync);
const artifactsDir = path.resolve("artifacts");
await mkdir(artifactsDir, { recursive: true });

const jobs = [
  { taskId: "ui", nodeId: "N2", title: "状态同步提示契约", summary: "让接受后的任务树准确反映目标进度", instruction: "实现两次审核界面，并完整保留任务树状态同步约束。", dependencyPrompt: "先确认状态接口可用。", acceptancePrompt: "真实点击通过并说明剩余缺口。", writeSet: ["public/**"], dependsOn: [], tests: ["node scripts/test-ui.mjs"], status: "planned", testResults: [] },
  { taskId: "server", nodeId: "N3", title: "业务场景代理夹具", summary: "建立可重复的本地业务测试场景", instruction: "实现隔离运行状态机，并提供本地业务项目代理测试场景。", dependencyPrompt: "无前置分支。", acceptancePrompt: "接口测试通过并核对目标。", writeSet: ["server/**"], dependsOn: [], tests: ["node scripts/test-server.mjs"], status: "planned", testResults: [] }
];

function fixture(status, { objective = "" } = {}) {
  const contextOptions = [
    { contextKey: "n2-ui-context", threadId: "worker-ui-history", nodeId: "N2", title: "状态同步规则", writeSet: ["public/**"] },
    { contextKey: "n3-server-context", threadId: "worker-server-history", nodeId: "N3", title: "业务测试场景", writeSet: ["server/**"] }
  ];
  const run = {
    id: "run-12345678",
    status,
    objective,
    summary: "前后端独立执行，合并后统一回归。",
    goal: { root: "长期保持正确目标", stage: "可靠完成自动并行", immediate: objective || "可靠完成自动并行", success: "真实用户流程通过", history: [] },
    jobs: jobs.map((job, index) => ({
      ...job,
      contextPolicy: "reuse",
      contextKey: contextOptions[index].contextKey,
      contextThreadId: contextOptions[index].threadId,
      contextSource: "parallel",
      contextLabel: contextOptions[index].title,
      contextMatch: "exact"
    })),
    contextOptions,
    planner: { status: "completed", threadId: "planner-system", contextResumed: true },
    integrationTests: ["node scripts/test-all.mjs"],
    integrationTestResults: [],
    coordinator: null,
    review: null,
    events: [],
    error: ""
  };
  if (status === "approved") run.jobs = run.jobs.map((job) => ({ ...job, status: "queued" }));
  if (status === "running") {
    run.jobs = run.jobs.map((job, index) => ({
      ...job,
      status: index === 0 ? "completed" : "running",
      threadId: `worker-${index + 1}`,
      turnId: `turn-${index + 1}`
    }));
  }
  if (["review", "accepted"].includes(status)) {
    run.jobs = run.jobs.map((job) => ({ ...job, status: "completed", testResults: [{ command: job.tests[0], ok: true, exitCode: 0 }] }));
    run.integrationTestResults = [{ command: "node scripts/test-all.mjs", ok: true, exitCode: 0 }];
    run.coordinator = { status: "completed", threadId: "coordinator-thread" };
    run.review = {
      readyToAccept: true,
      summary: "自动并行流程已通过验收。",
      changedFiles: ["public/app.js", "server/codex-coordinator.js"],
      stat: "2 files changed",
      patchPreview: "diff --git a/public/app.js b/public/app.js",
      goalAssessment: { alignment: "aligned", progress: "progress", continuity: "baseline", achieved: "并行审核链路可运行", remaining: "仍需长期业务观察" },
      warnings: []
    };
  }
  if (status === "accepted") run.review.appliedFiles = [...run.review.changedFiles];
  if (!["planning", "draft"].includes(status)) {
    run.supervisor = {
      status: status === "running" ? "running" : "completed",
      threadId: "supervisor-thread",
      deepLink: "codex://threads/supervisor-thread",
      rounds: status === "running" ? 1 : 2,
      paused: false,
      lastDecision: status === "running" ? "先完成当前两个分支，再判断是否需要新增任务。" : "已有证据足以进入结束审核。",
      messages: []
    };
    run.executionTree = {
      root: { id: "RUN", title: run.goal.immediate, status },
      nodes: run.jobs.map((job) => ({ id: job.taskId, taskId: job.taskId, parentId: "RUN", title: job.title, nodeId: job.nodeId, status: job.status })),
      supervisor: run.supervisor
    };
  }
  return run;
}

async function installRoutes(page, { planStatus = "draft", readStatus = "review" } = {}) {
  const appendedJobs = [];
  let supervisorPaused = false;
  const supervisorMessages = [];
  const runFixture = (status, options = {}) => {
    const run = fixture(status, options);
    run.jobs.push(...appendedJobs.map((job) => ({ ...job, status: status === "review" ? "completed" : "queued", testResults: [] })));
    if (run.supervisor) {
      run.supervisor.paused = supervisorPaused;
      run.supervisor.status = supervisorPaused ? "paused" : run.supervisor.status;
      run.supervisor.messages = [...supervisorMessages];
      run.executionTree.nodes = run.jobs.map((job) => ({ id: job.taskId, taskId: job.taskId, parentId: "RUN", title: job.title, nodeId: job.nodeId, status: job.status }));
      run.executionTree.supervisor = run.supervisor;
    }
    return run;
  };
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/codex/threads", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    threads: [
      { id: "project-thread-a", name: "界面讨论", preview: "讨论界面交互", updatedAt: 1786990000 },
      { id: "project-thread-b", name: "服务讨论", preview: "讨论服务状态机", updatedAt: 1786980000 },
      { id: "project-thread-c", name: "测试讨论", preview: "讨论真实验收", updatedAt: 1786970000 }
    ],
    systemThreads: [
      { id: "planner-system", name: "任务图 · 自动规划（系统）", preview: "【Task Tree · Automatic Parallel Planner】", updatedAt: 1786991000 }
    ],
    pinned: "",
    presets: []
  }) }));
  await page.route("**/api/codex/parallel/plan", (route) => {
    const objective = route.request().postDataJSON()?.objective || "";
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: runFixture(planStatus, { objective }) }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/approve", (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: runFixture("approved") }) }));
  await page.route("**/api/codex/parallel/run-12345678/branch-plan", (route) => {
    const body = route.request().postDataJSON() || {};
    const index = (body.existingJobs || []).length + 1;
    const nodeId = body.nodeId || "N3";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      proposal: {
        summary: `已按 ${nodeId} 生成分支草案`,
        planner: { status: "completed" },
        job: {
          taskId: `branch-${index}`,
          nodeId,
          title: `节点${nodeId}补充`,
          summary: `补足 ${nodeId} 的未决问题`,
          instruction: `完成 ${nodeId} 的一个独立可验证结果。`,
          dependencyPrompt: "开始前确认已有接口和依赖任务。",
          acceptancePrompt: "说明解决了什么、证据在哪里、还缺什么。",
          writeSet: [`parallel/branch-${index}.txt`],
          dependsOn: [],
          tests: [],
          contextPolicy: "reuse",
          contextKey: "",
          contextThreadId: "",
          contextSource: "parallel"
        }
      }
    }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/append", (route) => {
    appendedJobs.push(...(route.request().postDataJSON()?.jobs || []));
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: runFixture(readStatus) }) });
  });
  await page.route(/\/api\/codex\/parallel\/run-12345678\/thread\/[A-Za-z0-9._-]+\/open$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deepLink: "codex://threads/worker-1" }) }));
  await page.route("**/api/codex/parallel/run-12345678/supervisor/message", (route) => {
    supervisorMessages.push({ id: `message-${supervisorMessages.length + 1}`, text: route.request().postDataJSON()?.message || "", status: "queued" });
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: runFixture(readStatus) }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/supervisor/pause", (route) => {
    supervisorPaused = true;
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: runFixture("paused") }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/supervisor/resume", (route) => {
    supervisorPaused = false;
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: runFixture(readStatus) }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/supervisor/open", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deepLink: "codex://threads/supervisor-thread" }) }));
  await page.route("**/api/codex/parallel/run-12345678/accept", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: runFixture("accepted") }) }));
  await page.route(/\/api\/codex\/parallel\/run-12345678$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: runFixture(readStatus) }) }));
}

async function openParallel(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await page.locator("#projectOverviewClose").click({ force: true }).catch(() => {});
  await page.evaluate(() => {
    const overview = document.querySelector("#projectOverviewDialog");
    if (overview?.open) overview.close();
  });
  await page.waitForFunction(() => !document.querySelector("#projectOverviewDialog")?.open);
  await page.locator("#codexParallelBtn").click();
  await page.locator("#codexParallelRows tr").nth(1).waitFor();
}

assert.ok(browserExecutable, "no system Chrome or Edge executable found");
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installRoutes(desktop);
  const consoleErrors = [];
  const failedResponses = [];
  desktop.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  desktop.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await desktop.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await desktop.evaluate(() => {
    const overview = document.querySelector("#projectOverviewDialog");
    if (overview?.open) overview.close();
  });
  await desktop.locator("#codexThreadsBtn").click();
  await desktop.locator(".codexThreadSystemDetails").waitFor();
  assert.equal(await desktop.locator(".codexThreadItem .codexThreadTitle").filter({ hasText: "界面讨论" }).count(), 1);
  assert.match(await desktop.locator(".codexThreadSystemDetails summary").innerText(), /已收纳 1 条/);
  assert.equal(await desktop.locator(".codexThreadItem .codexThreadTitle").filter({ hasText: "自动规划" }).count(), 0);
  assert.equal(await desktop.locator(".codexThreadSystemDetails a[href='codex://threads/planner-system']").count(), 1);
  await desktop.screenshot({ path: path.join(artifactsDir, "codex-conversation-visibility.png") });
  await openParallel(desktop);
  const dialog = desktop.locator("#codexParallelDialog");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.locator("tbody tr").count(), 2);
  assert.match(await dialog.locator("#codexParallelState").innerText(), /2 个分支待确认/);
  assert.equal(await dialog.locator("#codexParallelGoalLabel").innerText(), "根本目标");
  assert.equal(await dialog.locator("#codexParallelGoalText").innerText(), "长期保持正确目标");
  assert.equal(await dialog.locator("#codexParallelGoalStatus").innerText(), "阶段目标");
  assert.deepEqual(await dialog.locator(".codexParallelStage").allTextContents(), ["规划", "执行", "汇总", "审核", "应用"]);
  assert.equal(await dialog.locator(".codexParallelStage.is-active").innerText(), "规划");
  assert.equal(await desktop.locator("#codexThreadMenu").evaluate((element) => element.classList.contains("hidden")), true);
  assert.equal(await dialog.locator(".codexParallelInstruction").first().isEditable(), true);
  assert.equal(await dialog.locator("thead th").allTextContents().then((items) => items.join("|")), "状态|分支|推进");
  assert.deepEqual(await dialog.locator(".codexParallelBranchNumber").allTextContents(), ["01", "02"]);
  assert.deepEqual(await dialog.locator(".codexParallelBranchTitle").allTextContents(), ["状态同步规则", "业务测试场景"]);
  assert.equal(await dialog.locator(".codexParallelTaskText").first().innerText(), "让接受后的任务树准确反映目标进度");
  assert.equal(await dialog.locator("#codexParallelSummary").evaluate((element) => element.open), false);
  assert.equal(await dialog.locator(".codexParallelJobSettings").first().evaluate((element) => element.open), false);
  assert.equal(await dialog.locator(".codexParallelFullTask").first().isVisible(), false);
  assert.equal(await dialog.locator(".codexParallelWriteSet").first().isVisible(), false);
  await dialog.locator(".codexParallelJobSettings summary").first().click();
  assert.equal(await dialog.locator(".codexParallelFullTask").first().isVisible(), true);
  assert.equal(await dialog.locator(".codexParallelWriteSet").first().isVisible(), true);
  await dialog.locator("#codexParallelObjective").fill("本轮只验证目标传入规划器");
  const replanRequest = desktop.waitForRequest("**/api/codex/parallel/plan");
  const replanResponse = desktop.waitForResponse("**/api/codex/parallel/plan");
  await dialog.locator("#codexParallelRegenerate").click();
  assert.equal((await replanRequest).postDataJSON().objective, "本轮只验证目标传入规划器");
  await (await replanResponse).finished();
  await dialog.locator("#codexParallelStart").waitFor({ state: "visible" });
  assert.equal(await dialog.locator("#codexParallelAddBranch").isVisible(), true);
  assert.equal(await dialog.locator(".codexParallelContextSelect").count(), 2);
  assert.equal(await dialog.locator(".codexParallelContextSelect").first().inputValue(), "reuse");
  assert.match(await dialog.locator(".codexParallelContextSelect option[value='reuse']").first().textContent(), /沿用此分支已有对话/);
  assert.equal(await dialog.locator(".codexParallelContextSelect option[value*='planner-system']").count(), 0);
  assert.equal(await dialog.locator("#codexParallelContexts").isVisible(), true);
  assert.match(await dialog.locator("#codexParallelContextSummary").innerText(), /2 个复用/);
  assert.deepEqual(await dialog.locator(".codexParallelContextBadge").allTextContents(), ["复用 · 状态同步规则", "复用 · 业务测试场景"]);
  await dialog.locator("#codexParallelContexts summary").click();
  assert.equal(await dialog.locator("#codexParallelContextAssignments a[href='codex://threads/planner-system']").count(), 1);
  assert.ok(await dialog.locator("#codexParallelContextPool a").count() >= 3);
  await dialog.locator(".codexParallelJobSettings summary").first().click();
  await dialog.locator(".codexParallelJobSettings summary").nth(1).click();
  await dialog.screenshot({ path: path.join(artifactsDir, "parallel-context-reuse.png") });
  await dialog.locator('.codexParallelContextSelect option[value="selected:codex-project-thread-a"]').first().waitFor({ state: "attached" });
  await dialog.locator(".codexParallelContextSelect").first().selectOption("selected:codex-project-thread-a");
  await dialog.locator(".codexParallelContextSelect").nth(1).selectOption("selected:codex-project-thread-a");
  await dialog.locator("#codexParallelStart").click();
  assert.match(await dialog.locator("#codexParallelState").innerText(), /不能选择同一个 Codex 对话/);
  await dialog.locator(".codexParallelContextSelect").nth(1).selectOption("selected:codex-project-thread-b");
  for (let index = 3; index <= 6; index += 1) {
    const branchPlanRequest = desktop.waitForRequest("**/api/codex/parallel/run-12345678/branch-plan");
    await dialog.locator("#codexParallelAddBranch").click();
    const requestBody = (await branchPlanRequest).postDataJSON();
    assert.ok(requestBody.nodeId, "the selected parent node must be sent to the branch planner");
    await dialog.locator(`tr[data-task-id="branch-${index}"]`).waitFor();
  }
  assert.equal(await dialog.locator("tbody tr").count(), 6);
  const addedDetails = dialog.locator('tr[data-task-id="branch-6"] .codexParallelJobSettings');
  assert.equal(await addedDetails.evaluate((element) => element.open), true, "new branch should open for editing immediately");
  assert.equal(await addedDetails.locator(".codexParallelTitleInput").isEditable(), true);
  assert.equal(await addedDetails.locator(".codexParallelNodeId").isEditable(), true);
  for (let index = 3; index <= 6; index += 1) {
    const row = dialog.locator(`tr[data-task-id="branch-${index}"]`);
    if (!(await row.locator(".codexParallelJobSettings").evaluate((element) => element.open))) {
      await row.locator(".codexParallelJobSettings summary").click();
    }
    await row.locator(".codexParallelTitleInput").fill(`验证分支 ${index}`);
    await row.locator(".codexParallelNodeId").fill(`N${index}`);
    await row.locator(".codexParallelInstruction").fill(`完成第 ${index} 个独立验证任务`);
    await row.locator(".codexParallelDependencyPrompt").fill(`分支 ${index} 开始前确认接口`);
    await row.locator(".codexParallelAcceptancePrompt").fill(`分支 ${index} 通过真实入口验收并说明缺口`);
    await row.locator(".codexParallelWriteSet").fill(`parallel/branch-${index}.txt`);
  }
  assert.equal(await dialog.getByText("分支负责修改的文件范围", { exact: true }).count(), 6);
  assert.equal(await dialog.getByText("独占写集", { exact: true }).count(), 0);
  await dialog.screenshot({ path: path.join(artifactsDir, "parallel-auto-start-review.png") });

  const approveRequest = desktop.waitForRequest("**/api/codex/parallel/run-12345678/approve");
  await dialog.locator("#codexParallelStart").click();
  const approveBody = (await approveRequest).postDataJSON();
  assert.equal(approveBody.jobs.length, 6);
  assert.equal(approveBody.jobs[5].title, "验证分支 6");
  assert.equal(approveBody.jobs[5].nodeId, "N6");
  assert.equal(approveBody.jobs[5].writeSet[0], "parallel/branch-6.txt");
  assert.equal(approveBody.jobs[0].contextPolicy, "selected");
  assert.equal(approveBody.jobs[0].contextThreadId, "project-thread-a");
  assert.equal(approveBody.jobs[0].contextSource, "codex");
  assert.equal(approveBody.jobs[1].contextPolicy, "selected");
  assert.equal(approveBody.jobs[1].contextThreadId, "project-thread-b");
  assert.equal(new Set(approveBody.jobs.slice(0, 2).map((job) => job.contextThreadId)).size, 2);
  assert.equal(approveBody.jobs[5].dependencyPrompt, "分支 6 开始前确认接口");
  assert.equal(approveBody.jobs[5].acceptancePrompt, "分支 6 通过真实入口验收并说明缺口");
  assert.equal(approveBody.objective, "本轮只验证目标传入规划器");
  await dialog.locator("#codexParallelAccept").waitFor({ state: "visible" });
  assert.equal(await dialog.locator("#codexParallelFiles").innerText(), "2 个文件");
  assert.equal(await dialog.locator("#codexParallelTests").innerText(), "3/3 通过");
  assert.match(await dialog.locator("#codexParallelGoalStatus").innerText(), /首次基线/);
  assert.match(await dialog.locator("#codexParallelPatch").textContent(), /diff --git/);
  await dialog.screenshot({ path: path.join(artifactsDir, "parallel-auto-end-review.png") });
  await dialog.locator("#codexParallelAccept").click();
  await dialog.locator("#codexParallelState").getByText("已应用", { exact: false }).waitFor();
  assert.equal(await dialog.locator(".codexParallelStage.is-active").innerText(), "应用");
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), []);

  const runningPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installRoutes(runningPage, { readStatus: "running" });
  await runningPage.addInitScript(() => {
    localStorage.setItem(`task-tree:codex-parallel:${location.origin}${location.pathname}`, "run-12345678");
  });
  await openParallel(runningPage);
  const runningDialog = runningPage.locator("#codexParallelDialog");
  assert.equal(await runningDialog.locator(".codexParallelStage.is-active").innerText(), "执行");
  assert.equal(await runningDialog.locator("#codexParallelSupervisor").isVisible(), true);
  assert.match(await runningDialog.locator("#codexParallelSupervisorDecision").innerText(), /完成当前两个分支/);
  assert.equal(await runningDialog.locator("#codexParallelExecutionTree [role='treeitem']").count(), 3);
  await runningDialog.locator("#codexParallelSupervisorInput").fill("新增任务前先验证目标缺口");
  const supervisorMessageRequest = runningPage.waitForRequest("**/supervisor/message");
  await runningDialog.locator("#codexParallelSupervisorSend").click();
  assert.equal((await supervisorMessageRequest).postDataJSON().message, "新增任务前先验证目标缺口");
  assert.equal(await runningDialog.locator("#codexParallelSupervisorInput").inputValue(), "");
  const supervisorPauseRequest = runningPage.waitForRequest("**/supervisor/pause");
  await runningDialog.locator("#codexParallelSupervisorToggle").click();
  await supervisorPauseRequest;
  await runningDialog.locator("#codexParallelSupervisorToggle").filter({ hasText: "继续" }).waitFor();
  const supervisorResumeRequest = runningPage.waitForRequest("**/supervisor/resume");
  await runningDialog.locator("#codexParallelSupervisorToggle").click();
  await supervisorResumeRequest;
  await runningDialog.locator("#codexParallelSupervisorToggle").filter({ hasText: "暂停" }).waitFor();
  await runningDialog.locator("#codexParallelMore summary").click();
  const supervisorOpenRequest = runningPage.waitForRequest("**/supervisor/open");
  await runningDialog.locator("#codexParallelSupervisorOpen").click();
  await supervisorOpenRequest;
  assert.equal(await runningDialog.locator("#codexParallelObjectiveBar").isHidden(), true);
  assert.equal(await runningDialog.locator(".codexParallelThreadLink").count(), 2);
  assert.deepEqual(await runningDialog.locator(".codexParallelThreadLink").allTextContents(), ["进入对话", "进入对话"]);
  const openThreadRequest = runningPage.waitForRequest(/\/thread\/ui\/open$/);
  await runningDialog.locator(".codexParallelThreadLink").first().click();
  await openThreadRequest;
  const nodeOptions = await runningDialog.locator("#codexParallelAppendNode option").evaluateAll((options) => options.map((option) => option.value));
  const appendNodeId = nodeOptions.find((id) => id && id !== "N2") || nodeOptions[0];
  await runningDialog.locator("#codexParallelAppendNode").selectOption(appendNodeId);
  const branchPlanRequest = runningPage.waitForRequest("**/api/codex/parallel/run-12345678/branch-plan");
  await runningDialog.locator("#codexParallelAddBranch").click();
  const branchPlanBody = (await branchPlanRequest).postDataJSON();
  assert.equal(branchPlanBody.nodeId, appendNodeId);
  await runningDialog.locator('tr[data-task-id="branch-3"]').waitFor();
  assert.equal(await runningDialog.locator("#codexParallelAppendConfirm").isVisible(), true);
  const pendingDetails = runningDialog.locator('tr[data-task-id="branch-3"] .codexParallelJobSettings');
  assert.equal(await pendingDetails.evaluate((element) => element.open), true);
  await pendingDetails.locator(".codexParallelAcceptancePrompt").fill("真实运行后确认该节点问题已解决");
  const appendRequest = runningPage.waitForRequest("**/api/codex/parallel/run-12345678/append");
  const appendResponse = runningPage.waitForResponse("**/api/codex/parallel/run-12345678/append");
  await runningDialog.locator("#codexParallelAppendConfirm").click();
  const appendBody = (await appendRequest).postDataJSON();
  await (await appendResponse).finished();
  assert.equal(appendBody.jobs.length, 1);
  assert.equal(appendBody.jobs[0].nodeId, appendNodeId);
  assert.equal(appendBody.jobs[0].acceptancePrompt, "真实运行后确认该节点问题已解决");
  await runningDialog.locator('tr[data-task-id="branch-3"]').waitFor();
  assert.match(await runningDialog.locator("#codexParallelState").innerText(), /1\/3 已完成 · 1 执行中 · 1 等待/);
  assert.equal(await runningDialog.locator(".codexParallelFullTask").first().isVisible(), false);
  const runningDetails = runningDialog.locator(".codexParallelJobSettings").first();
  await runningDetails.locator("summary").click();
  await runningPage.waitForTimeout(2700);
  assert.equal(await runningDetails.evaluate((element) => element.open), true, "running polls must preserve expanded details");
  assert.match(await runningDetails.locator(".codexParallelContextState").innerText(), /对话/);
  await runningDialog.screenshot({ path: path.join(artifactsDir, "parallel-current-running.png") });
  await runningPage.close();

  const resumedDraftPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installRoutes(resumedDraftPage, { readStatus: "draft" });
  await resumedDraftPage.addInitScript(() => {
    localStorage.setItem(`task-tree:codex-parallel:${location.origin}${location.pathname}`, "run-12345678");
  });
  await openParallel(resumedDraftPage);
  const resumedDialog = resumedDraftPage.locator("#codexParallelDialog");
  await resumedDialog.locator(".codexParallelJobSettings summary").first().click();
  await resumedDialog.locator("#codexParallelAddBranch").click();
  await resumedDialog.locator('tr[data-task-id="branch-3"] .codexParallelInstruction').fill("超过轮询周期仍保留的本地任务");
  await resumedDraftPage.waitForTimeout(1500);
  assert.equal(await resumedDialog.locator("tbody tr").count(), 3, "draft polling must not erase a locally added branch");
  assert.equal(await resumedDialog.locator('tr[data-task-id="branch-3"] .codexParallelJobSettings').evaluate((element) => element.open), true);
  assert.equal(await resumedDialog.locator('tr[data-task-id="branch-3"] .codexParallelInstruction').inputValue(), "超过轮询周期仍保留的本地任务");
  await resumedDraftPage.close();

  const response = await desktop.request.post(`${baseUrl}/api/codex/parallel`, {
    data: { jobs: [
      { nodeId: "N2", instruction: "x", writeSet: ["public/**"] },
      { nodeId: "N3", instruction: "y", writeSet: ["task-tree.md"] }
    ] }
  });
  assert.equal(response.status(), 400);
  assert.match((await response.json()).error, /共享状态/);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await installRoutes(mobile, { readStatus: "running" });
  await mobile.addInitScript(() => {
    localStorage.setItem(`task-tree:codex-parallel:${location.origin}${location.pathname}`, "run-12345678");
  });
  await openParallel(mobile);
  const mobileDialog = mobile.locator("#codexParallelDialog");
  const box = await mobileDialog.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  assert.equal(await mobileDialog.locator(".codexParallelTableWrap").evaluate((element) => element.scrollWidth > element.clientWidth), true);
  await mobileDialog.locator(".codexParallelJobSettings summary").first().click();
  assert.equal(await mobileDialog.locator(".codexParallelJobSettings").first().evaluate((element) => element.open), true);
  assert.equal(await mobileDialog.locator(".codexParallelFullTask").first().isVisible(), true);
  assert.equal(await mobileDialog.locator("#codexParallelSupervisor").isVisible(), true);
  const supervisorBox = await mobileDialog.locator("#codexParallelSupervisor").boundingBox();
  assert.ok(supervisorBox && supervisorBox.x >= 0 && supervisorBox.x + supervisorBox.width <= 390);
  assert.equal(await mobileDialog.locator(".codexParallelSupervisorMessage").isVisible(), true);
  assert.equal(await mobileDialog.locator("#codexParallelSupervisor").evaluate((element) => element.scrollWidth <= element.clientWidth), true);

  console.log("PASS automatic parallel dialog supports repeated branch addition and reliable editing on desktop and mobile");
} finally {
  await browser.close();
}
