import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const browserExecutable = process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function sizeMap(items) {
  return new Map(items.map((item) => [item.id, item.width * item.height]));
}

function uniqueSizes(items) {
  return new Set(items.map((item) => `${item.width}x${item.height}`));
}

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const httpErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
  });
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/tree", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, versions: [] }) });
      return;
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/?content_sized_nodes=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator(".graphNode").first().waitFor({ state: "visible", timeout: 30_000 });
  const overview = page.locator("#projectOverviewDialog");
  if (await overview.evaluate((element) => element.open)) await page.locator("#projectOverviewClose").click();

  await page.locator("#layoutTreeBtn").click();
  await page.waitForTimeout(250);
  await page.locator("#fitViewBtn").click();
  await page.waitForTimeout(500);

  const macroSizes = await page.locator(".graphNode").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset.nodeId,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      contentLength: [...element.querySelectorAll(".coreSummaryText")]
        .reduce((sum, item) => sum + (item.textContent || "").trim().length, 0)
    };
  }));
  const macroAreas = sizeMap(macroSizes);
  const macroByContent = [...macroSizes].sort((a, b) => a.contentLength - b.contentLength);
  const macroSparseArea = macroByContent.slice(0, 3).reduce((sum, item) => sum + macroAreas.get(item.id), 0) / 3;
  const macroRichArea = macroByContent.slice(-3).reduce((sum, item) => sum + macroAreas.get(item.id), 0) / 3;
  const clippedTitles = await page.locator(".graphNode").evaluateAll((elements) => elements.filter((element) => {
    const title = element.querySelector(".nodeMacroTitle");
    if (!title) return false;
    const cardRect = element.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return titleRect.left < cardRect.left - 1
      || titleRect.right > cardRect.right + 1
      || titleRect.top < cardRect.top - 1
      || titleRect.bottom > cardRect.bottom + 1;
  }).map((element) => element.dataset.nodeId));

  assert(uniqueSizes(macroSizes).size >= 4, JSON.stringify(macroSizes));
  assert(macroRichArea > macroSparseArea * 1.08, JSON.stringify({ macroSparseArea, macroRichArea, macroSizes }));
  assert.deepEqual(clippedTitles, []);
  await page.screenshot({ path: "artifacts/content-sized-nodes-macro.png" });

  const rootRect = await page.locator('.graphNode[data-node-id="ROOT"]').boundingBox();
  assert(rootRect);
  for (let index = 0; index < 14; index += 1) {
    await page.locator("#graphViewport").dispatchEvent("wheel", {
      deltaY: -700,
      clientX: rootRect.x + rootRect.width / 2,
      clientY: rootRect.y + rootRect.height / 2
    });
    if (await page.locator(".graphPane").getAttribute("data-zoom-level") === "细节") break;
  }
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".graphPane").getAttribute("data-zoom-level"), "细节");

  const detailSizes = await page.locator(".graphNode").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset.nodeId,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      contentLength: [...element.querySelectorAll(".coreSummaryText")]
        .reduce((sum, item) => sum + (item.textContent || "").trim().length, 0)
    };
  }));
  const detailAreas = sizeMap(detailSizes);
  const detailByContent = [...detailSizes].sort((a, b) => a.contentLength - b.contentLength);
  const detailSparseArea = detailByContent.slice(0, 3).reduce((sum, item) => sum + detailAreas.get(item.id), 0) / 3;
  const detailRichArea = detailByContent.slice(-3).reduce((sum, item) => sum + detailAreas.get(item.id), 0) / 3;
  assert(uniqueSizes(detailSizes).size >= 4, JSON.stringify(detailSizes));
  assert(detailRichArea > detailSparseArea * 1.08, JSON.stringify({ detailSparseArea, detailRichArea, detailSizes }));
  const detailOverlaps = await page.locator(".graphNode").evaluateAll((elements) => {
    const items = elements.map((element) => ({ id: element.dataset.nodeId, rect: element.getBoundingClientRect() }));
    const overlaps = [];
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        const a = items[left];
        const b = items[right];
        const overlapWidth = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const overlapHeight = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlapWidth > 2 && overlapHeight > 2) overlaps.push(`${a.id}/${b.id}`);
      }
    }
    return overlaps;
  });
  assert.deepEqual(detailOverlaps, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(httpErrors.filter((item) => !item.url.endsWith("/favicon.ico")), []);
  await page.screenshot({ path: "artifacts/content-sized-nodes-detail.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?content_sized_nodes_mobile=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.locator(".graphNode").first().waitFor({ state: "visible", timeout: 30_000 });
  if (await overview.evaluate((element) => element.open)) await page.locator("#projectOverviewClose").click();
  await page.locator("#layoutTreeBtn").click();
  await page.waitForTimeout(250);
  await page.locator("#fitViewBtn").click();
  await page.waitForTimeout(500);

  const mobileSizes = await page.locator(".graphNode").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
  const mobileClippedTitles = await page.locator(".graphNode").evaluateAll((elements) => elements.filter((element) => {
    const title = element.querySelector(".nodeMacroTitle");
    if (!title) return false;
    const cardRect = element.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return titleRect.left < cardRect.left - 1
      || titleRect.right > cardRect.right + 1
      || titleRect.top < cardRect.top - 1
      || titleRect.bottom > cardRect.bottom + 1;
  }).map((element) => element.dataset.nodeId));
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(uniqueSizes(mobileSizes).size >= 4, JSON.stringify(mobileSizes));
  assert.deepEqual(mobileClippedTitles, []);
  assert(pageOverflow <= 1, `mobile page overflow: ${pageOverflow}px`);
  await page.screenshot({ path: "artifacts/content-sized-nodes-mobile.png" });

  console.log(`PASS content-sized nodes: macro=${uniqueSizes(macroSizes).size}, detail=${uniqueSizes(detailSizes).size}, mobile=${uniqueSizes(mobileSizes).size}, clippedTitles=0`);
} finally {
  await browser.close();
}
