import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");
const port = process.env.PORT || "5177";
const baseUrl = `http://127.0.0.1:${port}`;
const browserExecutable = process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".knowledgeBody");

  const body = page.locator(".knowledgeBody");
  const before = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY
  }));
  assert(before.scrollHeight > before.clientHeight, `fixture does not overflow: ${JSON.stringify(before)}`);

  const box = await body.boundingBox();
  assert(box, "knowledge sidebar body is not visible");
  const wheelPoint = { x: box.x + box.width - 12, y: box.y + box.height / 2 };
  const wheelTarget = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className || ""}` : "none";
  }, wheelPoint);
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel(0, 1600);
  await page.waitForTimeout(150);

  const after = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY
  }));
  assert(after.scrollTop > 0, `knowledge sidebar did not scroll over ${wheelTarget}: ${JSON.stringify({ before, after })}`);

  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const bottomGap = await body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  assert(bottomGap <= 1, `knowledge sidebar cannot reach its bottom: gap=${bottomGap}`);

  const actionState = await page.locator("#kbClearHistoryBtn").evaluate((element) => {
    const control = element.getBoundingClientRect();
    const viewport = document.querySelector(".knowledgeBody").getBoundingClientRect();
    const chat = document.querySelector(".knowledgeSection--chat");
    return {
      visible: control.bottom > viewport.top && control.top < viewport.bottom,
      control: { top: control.top, bottom: control.bottom },
      viewport: { top: viewport.top, bottom: viewport.bottom },
      chat: {
        clientHeight: chat.clientHeight,
        scrollHeight: chat.scrollHeight,
        overflowY: getComputedStyle(chat).overflowY
      }
    };
  });
  assert(actionState.visible, `knowledge search actions are still clipped: ${JSON.stringify(actionState)}`);
  console.log(`PASS knowledge sidebar scrolls to the bottom: ${JSON.stringify(after)}`);
} finally {
  await browser.close();
}
