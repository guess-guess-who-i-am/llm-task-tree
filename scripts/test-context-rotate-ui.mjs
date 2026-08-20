import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const browserExecutable = process.env.BROWSER_EXECUTABLE || [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(existsSync);

const baseUrl = process.env.TASK_TREE_TEST_URL || "http://127.0.0.1:5410";
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let rotateBody = null;

try {
  await page.route("**/api/codex/context/rotate", async (route) => {
    rotateBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        threadId: "successor-test",
        recentTurns: 2,
        archived: true,
        checkpointMode: "compiled",
        checkpointWarning: "",
        archiveWarning: ""
      })
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await page.locator("#projectOverviewDialog").evaluate((dialog) => dialog.open)) {
    await page.locator("#projectOverviewClose").click();
  }
  await page.locator("#codexThreadsBtn").click();
  const rotate = page.getByRole("button", { name: /总结并换到短上下文/ });
  await rotate.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await rotate.textContent(), /保留目标、产品方向、最新纠错、决策、证据和下一步/);

  await rotate.click();
  await page.locator("#saveState").filter({ hasText: "已换到短上下文" }).waitFor({ timeout: 5000 });
  assert.ok(rotateBody?.threadId, "rotate click must send the selected thread id");
  assert.equal(rotateBody.archiveOld, true);
  assert.equal(rotateBody.open, true);
  console.log(`PASS context rotate menu is visible and sends selected thread ${rotateBody.threadId}`);
} finally {
  await browser.close();
}
