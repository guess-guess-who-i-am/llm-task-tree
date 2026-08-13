import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5199";
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("artifacts");
await mkdir(outputDir, { recursive: true });
const browserExecutable = process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable
});
try {
  const desktop = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await desktop.addInitScript(() => localStorage.clear());
  const errors = [];
  const httpErrors = [];
  desktop.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  desktop.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
  });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await desktop.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await desktop.locator("#projectOverviewBtn").click();
  await desktop.waitForFunction(() => document.querySelector("#projectOverviewDialog")?.open);
  assert.match(await desktop.locator("#projectOverviewMeta").innerText(), /三件事/);
  const overviewText = await desktop.locator("#projectOverviewBody").innerText();
  assert.match(overviewText, /根本目标/);
  assert.match(overviewText, /现在进行到了哪里/);
  assert.match(overviewText, /现在的问题是什么/);
  assert.doesNotMatch(overviewText, /整体方向|目标达成状态|下一次推进|节点索引|可选推进方向|全部节点/);
  assert.doesNotMatch(overviewText, /(^|\n)(Approach|Input|Output|Metrics|CurrentResult|RootCauseAnalysis)(\n|$)/);
  assert.equal(await desktop.locator(".overviewThreePart").count(), 3);
  assert.equal(await desktop.locator(".overviewDetails, .overviewCandidate, .overviewNodeRow").count(), 0);
  assert.equal(await desktop.locator(".projectOverviewTabs").count(), 0);
  const mainFontSizes = await desktop.locator(".overviewThreePart p").evaluateAll((items) => items.map((item) => Number.parseFloat(getComputedStyle(item).fontSize)));
  assert(mainFontSizes.every((size) => size >= 15), JSON.stringify(mainFontSizes));
  await desktop.screenshot({ path: path.join(outputDir, "project-overview-desktop.png"), fullPage: true });
  await desktop.locator("#projectOverviewClose").click();
  assert.equal(await desktop.locator("#projectOverviewDialog").evaluate((element) => element.open), false);
  assert.deepEqual(httpErrors.filter((item) => !item.url.endsWith("/favicon.ico")), []);
  assert.deepEqual(errors.filter((message) => !message.includes("404 (Not Found)")), []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.addInitScript(() => localStorage.clear());
  await mobile.goto(`${baseUrl}?mobile-overview=1`, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await mobile.locator("#projectOverviewBtn").click();
  await mobile.waitForFunction(() => document.querySelector("#projectOverviewDialog")?.open);
  const bounds = await mobile.locator("#projectOverviewDialog").boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  assert.equal(await mobile.locator("#projectOverviewDialog").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await mobile.screenshot({ path: path.join(outputDir, "project-overview-mobile.png") });

  console.log("PASS project overview contains only goal, progress, and current problem");
} finally {
  await browser.close();
}
