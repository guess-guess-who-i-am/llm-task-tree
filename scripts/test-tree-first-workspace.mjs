import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("artifacts");
const browserExecutable = process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const versionsFixture = [
  { name: "_current.md", isCurrent: true, mtimeMs: Date.now() },
  { name: "20260817-120000_test.md", reason: "测试版本", createdAt: "20260817-120000" }
];

await mkdir(outputDir, { recursive: true });

async function closeOverview(page) {
  const dialog = page.locator("#projectOverviewDialog");
  if (await dialog.evaluate((element) => element.open)) await page.locator("#projectOverviewClose").click();
}

async function waitForWorkspace(page) {
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await closeOverview(page);
}

async function assertCompactWorkspace(page) {
  const layout = page.locator(".layout");
  assert.equal(await layout.evaluate((element) => element.classList.contains("is-left-pane-collapsed")), true);
  assert.equal(await layout.evaluate((element) => element.classList.contains("is-right-pane-collapsed")), true);
  assert.equal(await page.locator(".knowledgePane").isVisible(), false);
  assert.equal(await page.locator(".versionPane").isVisible(), false);
  assert.equal(await page.locator(".workspaceSummaryBar").isVisible(), true);
  assert.match(await page.locator("#knowledgePaneSummary").innerText(), /^(?:\d+ 块|索引为空|未配置|处理中|出错)$/);
  assert.equal(await page.locator("#versionPaneSummary").innerText(), "2 条");
  const summaryText = (await page.locator(".workspaceSummaryBar").innerText()).replace(/\s+/g, " ").trim();
  assert(summaryText.length <= 28, `workspace summary is too verbose: ${summaryText}`);
  assert.equal(await page.locator(".chainDock").evaluate((element) => element.classList.contains("is-collapsed")), true);
  assert.equal(await page.locator("#chainSlot").isVisible(), false);
  assert.equal(await page.locator("#chainLoopHelpBtn").isVisible(), false);
  assert.match(await page.locator("#chainDockSummary").innerText(), /^\d+ 个节点/);
  const dockText = (await page.locator(".chainDock").innerText()).replace(/\s+/g, " ").trim();
  assert(dockText.length <= 24, `collapsed chain is too verbose: ${dockText}`);

  const bounds = await page.evaluate(() => {
    const layoutRect = document.querySelector(".layout").getBoundingClientRect();
    const graphRect = document.querySelector(".graphPane").getBoundingClientRect();
    return { layoutWidth: layoutRect.width, graphWidth: graphRect.width };
  });
  assert(bounds.graphWidth >= bounds.layoutWidth - 26, JSON.stringify(bounds));
}

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await desktop.addInitScript(() => {
    if (sessionStorage.getItem("treeFirstWorkspaceTestReady")) return;
    localStorage.clear();
    sessionStorage.setItem("treeFirstWorkspaceTestReady", "1");
  });
  await desktop.route("**/api/versions**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: versionsFixture }) });
  });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForWorkspace(desktop);
  await assertCompactWorkspace(desktop);
  await desktop.screenshot({ path: path.join(outputDir, "tree-first-workspace-desktop.png") });

  await desktop.locator("#toggleLeftPaneBtn").click();
  await desktop.locator("#toggleRightPaneBtn").click();
  await desktop.locator("#toggleChainDockBtn").click();
  assert.equal(await desktop.locator(".knowledgePane").isVisible(), true);
  assert.equal(await desktop.locator(".versionPane").isVisible(), true);
  assert.equal(await desktop.locator("#toggleLeftPaneBtn").evaluate((element) => element.classList.contains("is-open")), true);
  assert.equal(await desktop.locator("#toggleRightPaneBtn").evaluate((element) => element.classList.contains("is-open")), true);
  assert.equal(await desktop.locator(".workspaceSummaryBar").isVisible(), true);
  assert.equal(await desktop.locator("#chainSlot").isVisible(), true);
  assert.equal(await desktop.locator("#chainLoopHelpBtn").isVisible(), true);

  await desktop.reload({ waitUntil: "domcontentloaded" });
  await waitForWorkspace(desktop);
  assert.equal(await desktop.locator(".knowledgePane").isVisible(), true, "left pane choice must survive refresh");
  assert.equal(await desktop.locator(".versionPane").isVisible(), true, "right pane choice must survive refresh");
  assert.equal(await desktop.locator("#chainSlot").isVisible(), true, "chain dock choice must survive refresh");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => localStorage.clear());
  await mobile.route("**/api/versions**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: versionsFixture }) });
  });
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForWorkspace(mobile);
  await assertCompactWorkspace(mobile);
  assert.equal(await mobile.locator(".layout").evaluate((element) => getComputedStyle(element).gridTemplateRows.split(" ").length), 1);
  await mobile.screenshot({ path: path.join(outputDir, "tree-first-workspace-mobile.png") });

  console.log("PASS workspace keeps concise auxiliary status visible, expands full tools, and remembers the user's layout");
} finally {
  await browser.close();
}
