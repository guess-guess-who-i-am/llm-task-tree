import fs from "node:fs";
import path from "node:path";
import { chromium } from "../prototype/swimlane-view/node_modules/playwright/index.mjs";

const baseUrl = process.env.TASK_TREE_URL || "http://127.0.0.1:5410";
const artifactDir = path.resolve("artifacts/task-tree-prototype-v2");
fs.mkdirSync(artifactDir, { recursive: true });

function findChromium() {
  const browserRoot = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (!fs.existsSync(browserRoot)) return undefined;
  const candidates = fs.readdirSync(browserRoot)
    .filter((name) => /^chromium(?:_headless_shell)?-\d+$/.test(name))
    .sort((a, b) => Number(b.match(/\d+$/)?.[0]) - Number(a.match(/\d+$/)?.[0]));
  const endings = [
    ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
  ];
  for (const candidate of candidates) {
    for (const ending of endings) {
      const executable = path.join(browserRoot, candidate, ...ending);
      if (fs.existsSync(executable)) return executable;
    }
  }
  return undefined;
}

async function visibleOverlaps(page) {
  return page.evaluate(() => {
    const selectors = [
      ".lab-header",
      ".variant-tabs",
      ".view-toolbar",
      ".node-inspector",
      ".focus-center",
      ".focus-relations",
      ".tree-card",
    ];
    function clippedRect(element) {
      const rect = element.getBoundingClientRect();
      let visible = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      let parent = element.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if ([style.overflow, style.overflowX, style.overflowY].some((value) => ["auto", "scroll", "hidden", "clip"].includes(value))) {
          const parentRect = parent.getBoundingClientRect();
          visible = {
            left: Math.max(visible.left, parentRect.left),
            right: Math.min(visible.right, parentRect.right),
            top: Math.max(visible.top, parentRect.top),
            bottom: Math.min(visible.bottom, parentRect.bottom),
          };
        }
        parent = parent.parentElement;
      }
      visible.left = Math.max(0, visible.left);
      visible.top = Math.max(0, visible.top);
      visible.right = Math.min(innerWidth, visible.right);
      visible.bottom = Math.min(innerHeight, visible.bottom);
      return visible;
    }
    const elements = [...document.querySelectorAll(selectors.join(","))]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = clippedRect(element);
        return style.visibility !== "hidden" && style.display !== "none"
          && rect.right - rect.left > 4 && rect.bottom - rect.top > 4;
      });
    const allowed = (a, b) => a.contains(b) || b.contains(a)
      || (a.classList.contains("tree-card") && b.classList.contains("tree-card"));
    const overlaps = [];
    for (let index = 0; index < elements.length; index += 1) {
      for (let other = index + 1; other < elements.length; other += 1) {
        const a = elements[index];
        const b = elements[other];
        if (allowed(a, b)) continue;
        const ar = clippedRect(a);
        const br = clippedRect(b);
        const overlapWidth = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
        const overlapHeight = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        if (overlapWidth > 8 && overlapHeight > 8) {
          overlaps.push(`${a.className || a.tagName} <> ${b.className || b.tagName}`);
        }
      }
    }
    return [...new Set(overlaps)].slice(0, 12);
  });
}

async function inspectVariant(page, variant, viewportName) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  };
  const onPageError = (error) => errors.push(`page: ${error.message}`);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  await page.goto(`${baseUrl}/task-tree-prototype-v2/index.html?variant=${variant}`, { waitUntil: "networkidle" });
  await page.locator(".view-shell").waitFor();
  const cardCount = await page.locator(".tree-card").count();
  if (cardCount < 1) throw new Error(`${viewportName}/${variant}: no cards rendered`);

  if (variant === "a") {
    await page.locator('[data-action="root"]').click();
    await page.locator('.direction-card[data-node-id="ROOT"].is-selected').waitFor();
    await page.locator('[data-action="next"]').click();
    await page.locator(`.direction-card[data-node-id].is-selected`).waitFor();
  } else if (variant === "b") {
    await page.locator(".swimlane-card").first().click();
    await page.locator(".swimlane-card.is-selected").waitFor();
    await page.locator('[data-action="next"]').click();
  } else if (variant === "c") {
    await page.locator('[data-action="root"]').click();
    await page.locator('.focus-view[data-focus-id="ROOT"]').waitFor();
    const child = page.locator(".focus-relations.is-after .tree-card").first();
    if (await child.count()) await child.click();
    await page.locator('[data-action="all"]').click();
    await page.locator(".focus-index.is-open").waitFor();
    await page.locator('[data-action="close-index"]').click();
  } else if (variant === "d") {
    const initialZoom = await page.locator(".zoom-label").textContent();
    await page.locator('[data-action="zoom-in"]').click();
    const zoomed = await page.locator(".zoom-label").textContent();
    if (initialZoom === zoomed) throw new Error(`${viewportName}/${variant}: zoom did not change`);
    await page.locator('[data-action="next"]').click();
    await page.locator(".map-card.is-selected").waitFor();
    await page.locator('[data-action="fit"]').click();
  }

  await page.waitForTimeout(250);
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    viewVariant: document.querySelector("#viewRoot")?.dataset.variant,
    title: document.querySelector("#variantTitle")?.textContent,
  }));
  const overlaps = await visibleOverlaps(page);
  await page.screenshot({
    path: path.join(artifactDir, `${variant}-${viewportName}.png`),
    fullPage: true,
  });
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return {
    variant,
    viewport: viewportName,
    cardCount,
    errors,
    overlaps,
    bodyOverflow: dimensions.bodyWidth > dimensions.viewportWidth + 2,
    ...dimensions,
  };
}

const executablePath = findChromium();
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 960 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    for (const variant of ["a", "b", "c", "d"]) {
      results.push(await inspectVariant(page, variant, viewport.name));
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => result.errors.length || result.bodyOverflow || result.overlaps.length);
console.log(JSON.stringify({ executablePath, results, failed }, null, 2));
if (failed.length) process.exitCode = 1;
