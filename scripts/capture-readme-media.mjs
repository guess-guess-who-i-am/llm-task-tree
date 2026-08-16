import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../prototype/swimlane-view/node_modules/playwright");

const port = process.env.PORT || "5410";
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("artifacts");
const videoDir = path.join(outputDir, ".readme-video");
const browserExecutable = process.env.BROWSER_EXECUTABLE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

await mkdir(outputDir, { recursive: true });
await rm(videoDir, { recursive: true, force: true });
await mkdir(videoDir, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } }
});
const page = await context.newPage();
const video = page.video();
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("404 (Not Found)")) errors.push(message.text());
});

const pause = (ms) => page.waitForTimeout(ms);

async function closeOverview() {
  const dialog = page.locator("#projectOverviewDialog");
  if (await dialog.evaluate((element) => element.open)) await page.locator("#projectOverviewClose").click();
}

try {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // The app can keep maintenance requests open. Prefer network-idle, then fall back to the
  // product's deterministic readiness signal so one long poll cannot block media generation.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelectorAll(".graphNode").length > 0);
  await closeOverview();
  await page.locator("#fitViewBtn").click();
  await pause(900);
  await page.screenshot({ path: path.join(outputDir, "readme-tree-wide.png") });

  await page.locator("#projectOverviewBtn").click();
  await page.waitForFunction(() => document.querySelector("#projectOverviewDialog")?.open);
  await pause(2200);
  await page.screenshot({ path: path.join(outputDir, "readme-overview-wide.png") });
  await page.locator("#projectOverviewClose").click();
  await pause(900);

  const viewport = await page.locator("#graphViewport").boundingBox();
  assert(viewport, "graph viewport is missing");
  await page.mouse.move(viewport.x + viewport.width * 0.53, viewport.y + viewport.height * 0.48, { steps: 18 });
  for (let index = 0; index < 5; index += 1) {
    await page.mouse.wheel(0, -120);
    await pause(180);
  }
  await pause(1500);

  await page.locator("#focusLensOpenBtn").click();
  await page.locator("#focusLens").waitFor({ state: "visible" });
  await pause(2300);
  await page.screenshot({ path: path.join(outputDir, "readme-focus-wide.png") });
  const details = page.locator(".focusLensDetails");
  if (await details.count()) {
    await details.locator("summary").click();
    await pause(1300);
  }

  await page.locator(".graphViewBtn[data-graph-view='flow']").click();
  await page.locator("#flowViewHost").waitFor({ state: "visible" });
  await pause(2300);
  await page.screenshot({ path: path.join(outputDir, "readme-flow-wide.png") });

  await page.locator(".graphViewBtn[data-graph-view='tree']").click();
  await pause(900);
  if (await page.locator("#focusLens").isVisible()) await page.locator("#focusLensClose").click();
  await page.locator("#fitViewBtn").click();
  await pause(1800);

  assert.deepEqual(errors, []);
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

const recordedPath = await video.path();
const finalVideo = path.join(outputDir, "readme-demo.webm");
await rm(finalVideo, { force: true });
await rename(recordedPath, finalVideo);
await rm(videoDir, { recursive: true, force: true });

const localAppData = process.env.LOCALAPPDATA || "";
const ffmpegCandidates = [
  process.env.FFMPEG_EXECUTABLE,
  localAppData && path.join(
    localAppData,
    "Programs",
    "Python",
    "Python311",
    "Lib",
    "site-packages",
    "imageio_ffmpeg",
    "binaries",
    "ffmpeg-win-x86_64-v7.1.exe"
  ),
  "ffmpeg"
].filter(Boolean);
const ffmpegExecutable = ffmpegCandidates.find((candidate) => candidate === "ffmpeg" || existsSync(candidate));
assert(ffmpegExecutable, "ffmpeg is required to build the browser-playable MP4; set FFMPEG_EXECUTABLE");
const mp4Path = path.join(outputDir, "readme-demo.mp4");
const transcode = spawnSync(ffmpegExecutable, [
  "-y",
  "-i", finalVideo,
  "-an",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "25",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  mp4Path
], { stdio: "inherit" });
assert.equal(transcode.status, 0, `ffmpeg failed with status ${transcode.status}`);

console.log(`Captured README media from ${baseUrl}`);
