/**
 * Automated drag test: move M3 (last in N2 repeat body) between M0 and M1.
 * Run: node test-drag.mjs  (server must be on :5200)
 */
import { chromium } from "playwright";

const URL = "http://127.0.0.1:5200/?v=20&testdrag=1";

async function readScriptState(page) {
  return page.evaluate(() => {
    const repeat = window.__state?.blocks?.find((b) => b.type === "repeat" && b.label?.includes("子步骤"));
    return {
      repeatIdx: window.__state?.blocks?.findIndex((b) => b.type === "repeat" && b.label?.includes("子步骤")),
      body: repeat?.body?.map((b) => b.nodeId || b.title) || null,
      bodyLen: repeat?.body?.length ?? -1,
      rootLen: window.__state?.blocks?.length ?? -1
    };
  });
}

async function dragBlock(page, sourceSelector, targetSelector) {
  const source = page.locator(sourceSelector).first();
  const target = page.locator(targetSelector).first();
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  await source.dragTo(target);
  await page.waitForTimeout(300);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.click('button[data-view="blocks"]');
  await page.waitForTimeout(500);

  const before = await readScriptState(page);
  console.log("BEFORE", JSON.stringify(before));

  // N2 repeat body insert lines: parent-path ends with repeat index + .body
  const repeatIdx = before.repeatIdx;
  if (repeatIdx < 0) throw new Error("repeat block not found");

  const bodyKey = `${repeatIdx}.body`;
  const insertLines = page.locator(`.insertLine[data-parent-path="${bodyKey}"]`);
  const count = await insertLines.count();
  console.log("insert lines in repeat body:", count);

  // M0=0, insert after M0=line index 1, M1=1, M2=2, M3=3, line after M3=4
  const m3Wrap = page.locator(`.blockWrap.is-draggable[data-path="${repeatIdx}.body.3"]`);
  const lineAfterM0 = page.locator(`.insertLine[data-parent-path="${bodyKey}"][data-insert-at="1"]`);

  const m3Count = await m3Wrap.count();
  const lineCount = await lineAfterM0.count();
  console.log("m3 wrap count", m3Count, "line after M0 count", lineCount);

  if (!m3Count || !lineCount) {
    // dump paths
    const paths = await page.evaluate(() =>
      [...document.querySelectorAll(".blockWrap.is-draggable")].map((el) => el.dataset.path)
    );
    console.log("draggable paths sample:", paths.filter((p) => p.includes("body")).slice(0, 10));
    throw new Error("selectors failed");
  }

  // Test 1: drop on insert line after M0
  await dragBlock(page, `.blockWrap.is-draggable[data-path="${repeatIdx}.body.3"]`, `.insertLine[data-parent-path="${bodyKey}"][data-insert-at="1"]`);
  let after = await readScriptState(page);
  console.log("AFTER insert-line drop", JSON.stringify(after));
  const expected = ["N2a", "N2d", "N2b", "N2c"];
  if (JSON.stringify(after.body) !== JSON.stringify(expected)) {
    throw new Error(`insert-line drop wrong order: got ${after.body?.join(",")}, want ${expected.join(",")}`);
  }
  if (after.bodyLen !== 4 || after.repeatIdx < 0) {
    throw new Error(`repeat missing or empty: ${JSON.stringify(after)}`);
  }

  // Test 2: regenerate and try blockWrap drop on M1 lower half
  await page.click("#autoLayoutBtn");
  await page.waitForTimeout(400);
  before.body = (await readScriptState(page)).body;
  console.log("RESET body", before.body);

  const m1Wrap = page.locator(`.blockWrap.is-draggable[data-path="${repeatIdx}.body.1"]`);
  const m1Box = await m1Wrap.boundingBox();
  const m3 = page.locator(`.blockWrap.is-draggable[data-path="${repeatIdx}.body.3"]`);
  const m3Box = await m3.boundingBox();
  if (m1Box && m3Box) {
    await page.mouse.move(m3Box.x + m3Box.width / 2, m3Box.y + m3Box.height / 2);
    await page.mouse.down();
    // drop on upper half of M1 -> should insert before M1 (index 1)
    await page.mouse.move(m1Box.x + m1Box.width / 2, m1Box.y + m1Box.height * 0.2, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    after = await readScriptState(page);
    console.log("AFTER blockWrap upper-half drop", JSON.stringify(after));
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
