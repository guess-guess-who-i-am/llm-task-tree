import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const baseUrl = `http://127.0.0.1:${process.env.PORT || "5410"}`;
const browserExecutable = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((candidate) => require("node:fs").existsSync(candidate));

const trees = {
  method: "# LLM Task Graph\n\n## ROOT - 方法标记\n- Position: 40,40\n- Completion: 进行中\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n",
  background: "# LLM Task Graph\n\n## BG - 支撑标记\n- Position: 40,40\n- Completion: 已完成\n\n# GraphState\n- Current: BG\n- Next: BG\n\n# Edges\n",
  architecture: "# LLM Task Graph\n\n## ARCH - 架构标记\n- Position: 40,40\n- Completion: 已完成\n\n# GraphState\n- Current: ARCH\n- Next: ARCH\n\n# Edges\n"
};

assert.ok(browserExecutable, "no Chrome or Edge executable found");
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const counts = { tree: 0, versions: 0, models: 0, knowledge: 0 };
  await page.route("**/api/trees*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schema: "task-tree-registry/v1",
      activeMethod: "method",
      trees: [
        { id: "method", title: "方法迭代", role: "method", path: "task-tree.md", description: "当前方法", flowEnabled: true },
        { id: "background", title: "项目背景支撑", role: "background", path: "trees/background.md", description: "背景和约束", flowEnabled: false },
        { id: "architecture", title: "任务图系统架构", role: "architecture", path: "trees/architecture.md", description: "稳定实现", flowEnabled: false }
      ]
    })
  }));
  await page.route(/\/api\/tree\?/, async (route) => {
    counts.tree += 1;
    const treeId = new URL(route.request().url()).searchParams.get("tree") || "method";
    await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markdown: trees[treeId] }) });
  });
  await page.route("**/api/versions*", async (route) => {
    counts.versions += 1;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
  });
  await page.route("**/api/model-agents*", async (route) => {
    counts.models += 1;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) });
  });
  await page.route("**/api/knowledge/config*", async (route) => {
    counts.knowledge += 1;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: {}, index: {} }) });
  });
  await page.route("**/api/server-info*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ features: { openInEditor: true } }) }));
  await page.route("**/api/maintenance/status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ issues: [], warnings: [], flow: { drift: {} } }) }));
  await page.route("**/api/current-version*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const waitForTree = (label) => page.waitForFunction((expected) => document.querySelector("#nodesLayer")?.textContent?.includes(expected), label);
  await waitForTree("方法标记");

  const firstSwitch = performance.now();
  await page.locator("#treeSelect").selectOption("background");
  await waitForTree("支撑标记");
  const firstMs = performance.now() - firstSwitch;

  await page.locator("#treeSelect").selectOption("architecture");
  await waitForTree("架构标记");
  await page.locator("#treeSelect").selectOption("background");
  await waitForTree("支撑标记");

  const cachedSwitch = performance.now();
  await page.locator("#treeSelect").selectOption("architecture");
  await waitForTree("架构标记");
  const cachedMs = performance.now() - cachedSwitch;

  assert.ok(firstMs < 500, `first switch waited ${firstMs.toFixed(0)}ms for secondary panels`);
  assert.ok(cachedMs < 250, `cached switch took ${cachedMs.toFixed(0)}ms`);
  assert.equal(counts.models, 1, "model configuration should be shared across tree switches");
  assert.equal(counts.knowledge, 1, "knowledge configuration should be shared across tree switches");
  assert.match(await page.locator("#activeMethodBadge").innerText(), /架构支撑/);
  assert.match(await page.locator("#activeMethodBadge").getAttribute("title"), /稳定/);
  console.log(JSON.stringify({ passed: true, firstMs: Math.round(firstMs), cachedMs: Math.round(cachedMs), counts }));
} finally {
  await browser.close();
}
