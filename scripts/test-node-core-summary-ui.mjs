import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5199";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await page.waitForTimeout(300);

  const nodeCount = await page.locator(".graphNode").count();
  const coreCards = page.locator(".graphNode:not(.editing) .coreNodeSummary");
  assert.equal(await coreCards.count(), nodeCount);
  assert.ok((await page.locator(".coreSummaryRow").count()) >= nodeCount * 3);
  assert.deepEqual(
    await page.locator(".graphNode:not(.editing) .coreSummaryLabel").evaluateAll(
      (items) => [...new Set(items.map((item) => item.textContent.trim()))].sort()
    ),
    ["问题", "思路", "结果"].sort()
  );
  assert.equal(await page.locator(".nodeCardDetails[open]").count(), 0);
  assert.equal(await page.locator(".graphNode.compactCard").count(), nodeCount);
  assert.deepEqual(
    await page.locator(".compactCard .coreSummaryText").evaluateAll(
      (items) => [...new Set(items.map((item) => getComputedStyle(item).webkitLineClamp))]
    ),
    ["2"]
  );

  await page.locator("#layoutTreeBtn").click();
  await page.locator("#fitViewBtn").click();
  await page.waitForTimeout(350);
  assert.ok(["宏观", "结构"].includes(await page.locator(".graphPane").getAttribute("data-zoom-level")));
  assert.equal(await page.locator(".nodeMacroSummary:visible").count(), nodeCount);
  assert.equal(await page.locator(".coreNodeSummary:visible").count(), 0);

  for (let index = 0; index < 40; index += 1) {
    await page.locator("#graphViewport").dispatchEvent("wheel", { deltaY: -700, clientX: 80, clientY: 80 });
  }
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".graphPane").getAttribute("data-zoom-level"), "细节");
  assert.equal(await page.locator(".coreNodeSummary:visible").count(), nodeCount);
  const detailStats = await page.locator(".graphNode:not(.editing)").evaluateAll((cards) => cards.map((card) => {
    const box = card.getBoundingClientRect();
    const visibleChildren = [...card.children]
      .map((child) => ({ rect: child.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0.5);
    const contentBottom = Math.max(...visibleChildren.map(({ rect }) => rect.bottom), box.top);
    return {
      rows: card.querySelectorAll(".coreSummaryRow").length,
      actionHeight: card.querySelector(".nodeActions")?.getBoundingClientRect().height || 0,
      overflow: contentBottom - box.bottom
    };
  }));
  assert.ok(detailStats.every((item) => item.rows === 3), detailStats);
  assert.ok(detailStats.every((item) => item.actionHeight <= 100), detailStats);
  assert.ok(detailStats.every((item) => item.overflow <= 3), detailStats.filter((item) => item.overflow > 3));
  assert.deepEqual(errors, []);
  console.log(`PASS node core summary is visible at detail zoom (${nodeCount} nodes)`);
} finally {
  await browser.close();
}
