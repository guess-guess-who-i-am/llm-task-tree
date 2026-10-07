import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");

const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
child.stdout.on("data", (chunk) => { serverLog += chunk; });
child.stderr.on("data", (chunk) => { serverLog += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/project`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${serverLog}`);
}

const jobs = Array.from({ length: 7 }, (_, index) => ({
  taskId: `worker-${index + 1}`,
  nodeId: "N3",
  title: `完整显示的并行任务分支${index + 1}`,
  summary: `这是第${index + 1}个分支的完整当前进度说明，不应该被截断。`.repeat(5),
  instruction: `完成第${index + 1}个分支`,
  writeSet: ["task-tree.md"],
  dependsOn: [],
  status: "running",
  threadId: `thread-${index + 1}`,
  contextResumed: index === 0
}));
const run = (status, list = jobs) => ({
  id: "run-12345678",
  status,
  objective: "自动完成全部并行任务，完整展示本轮目标和分支说明，禁止省略任何尾部内容。".repeat(5),
  goal: { immediate: "自动完成全部并行任务，完整展示本轮目标和分支说明，禁止省略任何尾部内容。".repeat(5), stageNodeId: "N3" },
  summary: "所有目标都有对应 Worker。",
  jobs: list.map((job) => ({ ...job, status: status === "accepted" ? "completed" : job.status })),
  result: status === "accepted" ? { cleanup: { status: "completed" }, appliedFiles: ["task-tree.md"] } : null,
  error: ""
});

await waitForServer();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/codex/parallel")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  let pollCount = 0;
  let current = run("running");
  await page.route("**/api/codex/parallel/plan", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({ run: run("planning", []) })
  }));
  await page.route("**/api/codex/parallel/run-12345678/branch", (route) => {
    current = run("running", [...jobs, {
      taskId: "worker-8", nodeId: "N3", title: "新增分支", summary: "新增分支已直接进入执行队列",
      instruction: "直接执行新增任务", writeSet: ["task-tree.md"], dependsOn: [], status: "queued"
    }]);
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: current }) });
  });
  await page.route("**/api/codex/parallel/run-12345678/thread/*/open", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deepLink: "codex://threads/test" }) }));
  await page.route("**/api/codex/parallel/run-12345678", (route) => {
    pollCount += 1;
    if (pollCount >= 2) current = run("accepted", current.jobs || jobs);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: current }) });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await page.locator("#projectOverviewDialog[open]").count()) await page.click("#projectOverviewClose");
  await page.click("#codexParallelBtn");
  await page.waitForSelector("#codexParallelDialog[open]");
  await page.waitForFunction(() => document.querySelectorAll("#codexParallelRows tr").length === 7);

  assert.deepEqual(await page.locator("#codexParallelStageRail .codexParallelStage").allTextContents(), ["规划", "执行", "完成"]);
  assert.equal(await page.locator("#codexParallelRows tr").count(), 7);
  assert.equal(await page.locator("#codexParallelRows tr").first().innerText().then((value) => value.includes("已复用历史对话")), true);
  assert.equal(await page.locator("#codexParallelRows tr").last().innerText().then((value) => value.includes("不应该被截断")), true);
  for (const selector of ["#codexParallelGoalText", ".codexParallelTaskText"]) {
    const clipped = await page.locator(selector).evaluateAll((elements) => elements.some((element) => element.scrollHeight > element.clientHeight + 1));
    assert.equal(clipped, false, `complete text is visually clipped: ${selector}`);
  }
  for (const forbidden of ["确认开始并行", "接受并应用", "丢弃结果", "重新核验目标", "查看代码差异", "验收命令", "持续总控"]) {
    assert.equal(await page.getByText(forbidden, { exact: true }).count(), 0, `obsolete control remains: ${forbidden}`);
  }

  await page.click("#codexParallelAddBranch");
  await page.waitForFunction(() => document.querySelectorAll("#codexParallelRows tr").length === 8);
  assert.ok(requests.some((item) => item.endsWith("/branch")));
  assert.ok(!requests.some((item) => /\/(approve|accept|reject|audit|append|supervisor)(?:$|\/)/.test(item)), requests.join("\n"));

  await page.waitForFunction(() => document.querySelector(".codexParallelStage[data-stage='completed']")?.classList.contains("is-active"));
  assert.equal(await page.locator("#codexParallelRows tr").count(), 8, "completed progress keeps every worker visible");
  assert.match(await page.locator("#codexParallelState").innerText(), /自动应用/);
  assert.equal(await page.locator("#codexParallelTableWrap").isVisible(), true);

  await page.setViewportSize({ width: 390, height: 844 });
  const dialogBox = await page.locator("#codexParallelDialog").boundingBox();
  const viewport = page.viewportSize();
  assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0);
  assert.ok(dialogBox.x + dialogBox.width <= viewport.width + 1);
  assert.ok(dialogBox.y + dialogBox.height <= viewport.height + 1);
  console.log("parallel UI: three-stage automatic progress, full worker text, direct branch append and mobile bounds passed");
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
