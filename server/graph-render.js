/**
 * Screenshots the task graph so an agent can hand the user a picture instead of a URL.
 *
 * Codex renders images returned in an MCP tool result, which is the only way to show the graph
 * inside the chat: the desktop app gives third-party plugins no UI surface, and opening the web UI
 * means leaving the conversation. The capture is of the real page (`?snapshot=1`), so what lands in
 * the chat is what the UI draws, not a second renderer that would drift from it.
 *
 * Rasterizing uses whatever Chromium the machine already has (Edge ships with Windows). No
 * dependency is added, and a machine without one gets a clear error rather than a broken image.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cropTransparentMargins, decodePng, encodePng, flattenOnto } from "./png.js";

/** The UI's canvas colour, so the picture looks like the page rather than a cut-out. */
const CANVAS_BACKGROUND = [0xfb, 0xfb, 0xf8];

const DEFAULT_WIDTH = 1680;
const DEFAULT_HEIGHT = 1050;
/** Chromium fast-forwards timers up to this budget, then captures; covers fetch + layout + fit. */
const VIRTUAL_TIME_BUDGET_MS = 9000;

export function findChromium() {
  const explicit = process.env.TASK_TREE_CHROME;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = process.platform === "win32"
    ? [
      `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ]
    : process.platform === "darwin"
      ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ]
      : [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge"
      ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function runHeadless(browser, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`headless browser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * @param {object} options
 * @param {string} options.url  Base UI url, e.g. http://127.0.0.1:5177
 * @returns {Promise<{png: Buffer, width: number, height: number, browser: string}>}
 */
export async function renderGraphPng({
  url,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  scale = 1,
  timeoutMs = 90000,
  tree = ""
} = {}) {
  const browser = findChromium();
  if (!browser) {
    throw new Error("找不到可用的 Chromium（Edge/Chrome）；设置 TASK_TREE_CHROME 指向浏览器可执行文件");
  }

  const profile = await mkdtemp(path.join(os.tmpdir(), "task-tree-shot-"));
  const output = path.join(profile, "graph.png");
  const target = new URL(url);
  target.searchParams.set("snapshot", "1");
  if (tree) target.searchParams.set("tree", tree);

  const capture = async (budget) => {
    await rm(output, { force: true });
    const result = await runHeadless(browser, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      // Unpainted area stays transparent, which is what makes the crop below able to find the
      // viewport edge without knowing this platform's window frame size.
      "--default-background-color=00000000",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${budget}`,
      `--screenshot=${output}`,
      target.toString()
    ], timeoutMs);

    if (!existsSync(output)) {
      throw new Error(`截图失败（exit ${result.code}）：${(result.stderr || "").slice(0, 400)}`);
    }

    // Snapshot mode paints only the graph, so the crop lands on the drawing's own bounds instead
    // of the window's, and a wide, short tree stops wasting half the picture on empty canvas.
    return cropTransparentMargins(decodePng(await readFile(output)));
  };

  const isBlank = ({ data }) => {
    for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return false;
    return true;
  };

  try {
    let cropped = await capture(VIRTUAL_TIME_BUDGET_MS);
    // A blank frame means the camera opened before the page finished drawing; the second, slower
    // pass is cheaper than handing the user an empty picture.
    if (isBlank(cropped)) cropped = await capture(VIRTUAL_TIME_BUDGET_MS * 2);
    if (isBlank(cropped)) {
      throw new Error("页面没有渲染出任何节点：确认任务图服务正常、当前方法树里有节点");
    }

    const flattened = flattenOnto(cropped, { background: CANVAS_BACKGROUND, padding: Math.round(24 * scale) });
    return {
      png: encodePng(flattened.data, flattened.width, flattened.height),
      width: flattened.width,
      height: flattened.height,
      browser
    };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
