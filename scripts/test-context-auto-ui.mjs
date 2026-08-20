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
let rotated = false;

try {
  await page.route("**/api/codex/context/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        context: rotated ? {
          threadId: "thread-successor",
          generation: 2,
          status: "active",
          lastRotation: {
            sourceThreadId: "thread-old",
            threadId: "thread-successor",
            generation: 2,
            reason: "context_threshold",
            rotatedAt: "2026-08-20T08:00:00.000Z"
          }
        } : {
          threadId: "thread-old",
          generation: 1,
          status: "active",
          lastRotation: null
        }
      })
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await page.locator("#projectOverviewDialog").evaluate((dialog) => dialog.open)) {
    await page.locator("#projectOverviewClose").click();
  }
  await page.evaluate(() => localStorage.removeItem("taskTree.contextRotationSeen"));
  rotated = true;
  await page.evaluate(() => pollMainContextLifecycle());
  const message = page.locator("#saveState");
  await message.filter({ hasText: "已自动换到短上下文" }).waitFor({ timeout: 5000 });
  assert.match(await message.textContent(), /目标和当前进度已保留/);
  assert.equal(await page.locator("#codexThreadMenu").evaluate((element) => element.classList.contains("hidden")), true);
  console.log("PASS automatic context rotation is reported without opening or clicking the conversation menu");
} finally {
  await browser.close();
}
