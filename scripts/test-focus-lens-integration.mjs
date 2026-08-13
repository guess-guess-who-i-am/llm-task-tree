import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("artifacts");
await mkdir(outputDir, { recursive: true });
const browserExecutable = process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function closeOverview(page) {
  const dialog = page.locator("#projectOverviewDialog");
  if (await dialog.evaluate((element) => element.open)) await page.locator("#projectOverviewClose").click();
}

async function zoomWithoutOpeningLens(page, nodeId) {
  const node = page.locator(`.graphNode[data-node-id='${nodeId}']`);
  await node.scrollIntoViewIfNeeded();
  const viewport = await page.locator("#graphViewport").boundingBox();
  const initial = await node.boundingBox();
  assert(viewport && initial, `missing ${nodeId} or viewport bounds`);
  const x = Math.min(viewport.x + viewport.width - 12, Math.max(viewport.x + 12, initial.x + initial.width / 2));
  const y = Math.min(viewport.y + viewport.height - 12, Math.max(viewport.y + 12, initial.y + Math.min(24, initial.height / 2)));
  await page.mouse.move(x, y);
  for (let attempt = 0; attempt < 28; attempt += 1) {
    await page.mouse.wheel(0, -100);
  }
  assert.equal(await page.locator("#focusLens").isVisible(), false, "wheel zoom must not hijack the canvas with the focus lens");
  const scale = await page.locator("#graphCanvas").evaluate((element) => {
    const match = element.style.transform.match(/scale\(([^)]+)\)/);
    return Number(match?.[1] || 0);
  });
  assert(scale > 1.4, `canvas did not continue zooming: ${scale}`);
}

async function verifyViewport(page, screenshotName, nodeId, { automaticZoom = true } = {}) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await closeOverview(page);
  if (automaticZoom) await zoomWithoutOpeningLens(page, nodeId);
  const openButton = page.locator(`.graphNode[data-node-id='${nodeId}'] [data-action='open-focus-lens']`);
  assert.equal(await openButton.count(), 1, `missing explicit lens button for ${nodeId}`);
  await openButton.dispatchEvent("click");

  const lens = page.locator("#focusLens");
  assert.equal(await lens.isVisible(), true);
  assert.equal(await page.locator(".focusLensNodeId").innerText(), nodeId);
  const text = await page.locator(".focusLensCenter").innerText();
  assert.match(text, /解决什么问题/);
  assert.match(text, /思路怎么做/);
  assert.match(text, /结果如何/);
  const details = page.locator(".focusLensDetails");
  assert.equal(await details.isVisible(), true);
  await details.locator("summary").click();
  assert.equal(await details.getAttribute("open"), "");
  assert.match(await details.innerText(), /评价标准|备注|根因|代码与证据/);

  const relation = page.locator(".focusLensRelation").first();
  if (await relation.count()) {
    const relationId = await relation.locator(".focusLensRelationId").innerText();
    await relation.click({ force: true });
    assert.equal(await page.locator(".focusLensNodeId").innerText(), relationId);
  }
  const finalId = await page.locator(".focusLensNodeId").innerText();
  await page.screenshot({ path: path.join(outputDir, screenshotName) });
  await page.locator("#focusLensClose").click();
  assert.equal(await lens.isVisible(), false);
  assert.equal(await page.locator(`.graphNode.selected[data-node-id='${finalId}']`).count(), 1);

  const centered = await page.evaluate((id) => {
    const viewport = document.querySelector("#graphViewport").getBoundingClientRect();
    const node = document.querySelector(`.graphNode[data-node-id='${id}']`).getBoundingClientRect();
    const viewportCenter = { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height * 0.45 };
    const nodeCenter = { x: node.left + node.width / 2, y: node.top + node.height / 2 };
    return { dx: Math.abs(viewportCenter.x - nodeCenter.x), dy: Math.abs(viewportCenter.y - nodeCenter.y) };
  }, finalId);
  assert(centered.dx < 3 && centered.dy < 3, JSON.stringify(centered));
  assert.equal(await page.locator(".graphViewport").evaluate((element) => element.scrollWidth >= element.clientWidth), true);
}

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await desktop.addInitScript(() => localStorage.clear());
  const desktopErrors = [];
  desktop.on("console", (message) => {
    if (message.type() === "error") desktopErrors.push(message.text());
  });
  await verifyViewport(desktop, "focus-lens-desktop.png", "N11");
  assert.deepEqual(desktopErrors.filter((message) => !message.includes("404 (Not Found)")), []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => localStorage.clear());
  await verifyViewport(mobile, "focus-lens-mobile.png", "N11", { automaticZoom: false });
  assert.equal(await mobile.locator(".focusLensBody").evaluate((element) => element.scrollWidth <= element.clientWidth), true);

  console.log("PASS wheel keeps zooming, explicit lens entry exposes full details, and close returns to the centered node");
} finally {
  await browser.close();
}
