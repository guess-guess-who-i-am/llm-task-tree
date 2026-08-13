const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

let browser;

(async () => {
  const executablePath = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(executablePath, "no system Chrome or Edge executable found");
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 760, height: 700 } });
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("http://127.0.0.1:5410/?embed=1", { waitUntil: "networkidle" });
  const startedAt = Date.now();
  await page.click("#codexThreadsBtn");
  await page.waitForSelector("#codexThreadMenu .codexThreadItem", { timeout: 5000 });
  const firstChoiceMs = Date.now() - startedAt;

  const layout = await page.locator("#codexThreadMenu .codexThreadItem").evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    const title = item.querySelector(".codexThreadTitle")?.getBoundingClientRect();
    const meta = item.querySelector(".codexThreadMeta")?.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      top: box.top,
      bottom: box.bottom,
      titleTop: title?.top ?? null,
      titleBottom: title?.bottom ?? null,
      metaTop: meta?.top ?? null,
      metaBottom: meta?.bottom ?? null
    };
  }));

  assert.ok(firstChoiceMs < 5000, `first selectable conversation took ${firstChoiceMs}ms`);
  assert.ok(layout.length > 1, "picker should contain more than one selectable choice");
  assert.ok(layout.every((item) => item.width > 250), `conversation rows were squeezed: ${JSON.stringify(layout)}`);
  for (let index = 1; index < layout.length; index += 1) {
    assert.ok(layout[index].top >= layout[index - 1].bottom - 0.5, `rows overlap at ${index}`);
  }
  for (const item of layout) {
    if (item.titleBottom !== null && item.metaTop !== null) {
      assert.ok(item.metaTop >= item.titleBottom - 0.5, "title and metadata overlap");
    }
  }
  assert.deepEqual(failedResponses, [], `failed responses: ${failedResponses.join(" | ")}`);

  const screenshot = path.resolve("artifacts/codex-picker-embed.png");
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ firstChoiceMs, choices: layout.length, minWidth: Math.min(...layout.map((item) => item.width)), screenshot }));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
});
