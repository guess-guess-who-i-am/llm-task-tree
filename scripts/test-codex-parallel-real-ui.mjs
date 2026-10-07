// Live browser -> production HTTP -> real Codex -> Git -> automatic application.
// Requires the user's existing Codex login. No model or API responses are mocked.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const exec = promisify(execFile);
const root = process.cwd();
const fixture = await mkdtemp(path.join(os.tmpdir(), "parallel-live-browser-"));
const artifacts = path.join(root, "artifacts", "parallel-automatic");
await mkdir(artifacts, { recursive: true });
const objective = "在此临时项目完成两个明确独立任务，必须同时派出两个 Worker，不要增设契约、测试或审核任务：alpha 分支把 shared.txt 的 base 行改成 alpha 并新建 alpha.txt；beta 分支把 shared.txt 的 base 行改成 beta 并新建 beta.txt。两者从相同基线独立工作，不等待对方；发生真实 Git 冲突时，双方协商，最终 shared.txt 保留 alpha 和 beta 各一行。仅修改当前临时工作树，禁止修改外部文件。不运行测试，不修改其他文件，不委派。完成后直接自动应用。";
await writeFile(path.join(fixture, "task-tree.md"), `# LLM Task Graph\n## ROOT - 两个分支自动合并\n- Problem: ${objective}\n- Completion: 进行中\n## N1 - alpha 分支\n- Problem: shared.txt 的 base 改为 alpha，新增 alpha.txt，文件内容为 alpha\n- Completion: 进行中\n## N2 - beta 分支\n- Problem: shared.txt 的 base 改为 beta，新增 beta.txt，文件内容为 beta\n- Completion: 进行中\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n`);
await writeFile(path.join(fixture, "shared.txt"), "base\n");
await writeFile(path.join(fixture, "AGENTS.md"), "This is an isolated live integration fixture. Follow the assigned task only. Do not run tests, use MCP, delegate, or modify files outside the current Git worktree. Do not edit AGENTS.md. When resolving a Git conflict, preserve alpha and beta, stage the resolution, and let the host continue the cherry-pick.\n");
for (const args of [["init"], ["config", "user.name", "Parallel Live Test"], ["config", "user.email", "parallel-live@test.local"], ["add", "."], ["commit", "-m", "live fixture"]]) {
  await exec("git", args, { cwd: fixture });
}
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, TASK_TREE_PROJECT_ROOT: fixture, PORT: String(port), HOST: "127.0.0.1", PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });
let browser;
let run;
const startedAt = Date.now();
try {
  for (;;) {
    try { if ((await fetch(`${baseUrl}/api/project`)).ok) break; } catch { /* startup */ }
    if (Date.now() - startedAt > 15000) throw new Error(`server startup failed: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/codex/parallel")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await page.locator("#projectOverviewDialog[open]").count()) await page.click("#projectOverviewClose");
  const planningResponse = page.waitForResponse((response) => response.url().endsWith("/api/codex/parallel/plan") && response.request().method() === "POST");
  await page.click("#codexParallelBtn");
  const initial = await (await planningResponse).json();
  assert.ok(initial.run?.id, JSON.stringify(initial));
  const runId = initial.run.id;
  console.log(`Live run ${runId}: browser submitted the real plan`);
  let lastState = "";
  for (;;) {
    run = (await (await fetch(`${baseUrl}/api/codex/parallel/${runId}`)).json()).run;
    const state = `${run.status}: ${run.jobs.map((job) => `${job.taskId}=${job.status}`).join(", ")}`;
    if (state !== lastState) { console.log(state); lastState = state; }
    if (["accepted", "failed"].includes(run.status)) break;
    if (Date.now() - startedAt > 12 * 60 * 1000) throw new Error(`Live run timed out: ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await writeFile(path.join(artifacts, "live-run.json"), `${JSON.stringify(run, null, 2)}\n`);
  assert.equal(run.status, "accepted", run.error);
  assert.equal(run.jobs.length, 2, "the real planner must honor the two explicitly independent tasks");
  assert.equal(run.jobs.every((job) => job.status === "completed" && job.threadId), true);
  assert.equal((await readFile(path.join(fixture, "alpha.txt"), "utf8")).trim(), "alpha");
  assert.equal((await readFile(path.join(fixture, "beta.txt"), "utf8")).trim(), "beta");
  const lines = (await readFile(path.join(fixture, "shared.txt"), "utf8")).trim().split(/\r?\n/).sort();
  assert.deepEqual(lines, ["alpha", "beta"]);
  // The resolver receives one complete participant packet; one resolver message is intentional.
  assert.ok(run.mergeConflicts.some((conflict) => conflict.status === "resolved" && conflict.messages.length >= 1));
  const starts = run.events.filter((event) => event.type === "worker_started");
  const ends = run.events.filter((event) => event.type === "completed");
  assert.ok(Math.max(...starts.map((event) => Date.parse(event.at))) < Math.min(...ends.map((event) => Date.parse(event.at))), "workers must overlap in time");
  await page.waitForFunction(() => document.querySelector(".codexParallelStage[data-stage='completed']")?.classList.contains("is-active"), null, { timeout: 15000 });
  assert.equal(await page.locator("#codexParallelRows tr").count(), 2);
  assert.ok(!requests.some((request) => /\/(approve|accept|reject|audit|supervisor)(?:$|\/)/.test(request)));
  await page.locator("#codexParallelDialog").screenshot({ path: path.join(artifacts, "live-completed.png") });
  await writeFile(path.join(artifacts, "live-result.json"), `${JSON.stringify({ elapsedMs: Date.now() - startedAt, requests, sharedLines: lines, runId, model: "real Codex app-server, existing user configuration", fixture }, null, 2)}\n`);
  console.log(`PASS live browser, real planner + two simultaneous workers + conflict conversation + automatic apply (${Date.now() - startedAt}ms)`);
} finally {
  if (run) await writeFile(path.join(artifacts, "live-run.json"), `${JSON.stringify(run, null, 2)}\n`);
  await browser?.close();
  await fetch(`${baseUrl}/api/shutdown`, { method: "POST" }).catch(() => {});
  child.kill();
  await writeFile(path.join(artifacts, "live-server.log"), log);
  if (run?.status === "accepted") await rm(fixture, { recursive: true, force: true });
}
