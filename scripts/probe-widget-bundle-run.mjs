/**
 * Runs the widget document the way the chat host runs it.
 *
 * Reproduces the two constraints that matter: the page sits on an origin that is not the API's, and
 * its only way out is `window.openai.callTool`. What it deliberately does not reproduce is the
 * sandbox's ban on loopback requests - that ban is what forced this design, and the point here is
 * to check the design itself.
 *
 * Fails loudly on a page error, so a broken inline script cannot pass as an empty screen.
 *
 *   node scripts/probe-widget-bundle-run.mjs [uiPort] [--keep]
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { widgetBundle } from "../server/widget-bundle.js";
import { findChromium } from "../server/graph-render.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiPort = Number(process.argv[2]) || 5410;
const keep = process.argv.includes("--keep");

const bundle = await widgetBundle({ publicDir: path.join(root, "public") });

/** The host bridge, reduced to the one call the page makes, plus a log the probe can read back. */
const stub = `
  <!doctype html><meta charset="utf-8">
  <script>
    window.__calls = [];
    window.__errors = [];
    addEventListener("error", (e) => window.__errors.push(String(e.message || e.error)));
    addEventListener("unhandledrejection", (e) => window.__errors.push("rejected: " + String(e.reason)));
    window.openai = {
      callTool: async (name, args) => {
        window.__calls.push(name + " " + (args.method || "") + " " + (args.path || ""));
        const res = await fetch("/__tool", { method: "POST", body: JSON.stringify({ name, args }) });
        return { content: [{ text: await res.text() }] };
      }
    };
    // Reported rather than screenshotted: a blank picture cannot say whether the page threw, and
    // the node count is what proves the tree actually came across the bridge.
    setTimeout(() => {
      navigator.sendBeacon("/__report", JSON.stringify({
        errors: window.__errors,
        calls: window.__calls,
        nodes: document.querySelectorAll(".nodeTitle").length,
        edges: document.querySelectorAll("svg path").length,
        status: (document.querySelector("#saveState") || {}).textContent || "",
        // A widget that needs scrolling to see the graph is the thing being fixed, so it is measured.
        overflow: document.documentElement.scrollHeight - window.innerHeight,
        sticksOut: [...document.body.children]
          .map((el) => {
            const box = el.getBoundingClientRect();
            return { el, bottom: Math.round(box.bottom), h: Math.round(box.height) };
          })
          .filter((item) => item.bottom > window.innerHeight + 1)
          .map((item) => (item.el.id || item.el.className || item.el.tagName) + " bottom=" + item.bottom + " h=" + item.h),
        graphBox: (() => {
          const box = document.querySelector(".graphPane")?.getBoundingClientRect();
          return box ? Math.round(box.width) + "x" + Math.round(box.height) : "missing";
        })(),
        title: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 160)
      }));
    }, 12000);
  </script>
`;

let reported = null;
const reportArrived = new Promise((resolve) => { reported = resolve; });

const probe = createServer(async (req, res) => {
  if (req.url === "/__report") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    reported(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.end("");
    return;
  }
  if (req.url === "/__tool") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    try {
      const upstream = await fetch(`http://127.0.0.1:${uiPort}${args.path}`, {
        method: args.method || "GET",
        headers: args.body === undefined ? undefined : { "content-type": "application/json" },
        body: args.body
      });
      const body = await upstream.text();
      console.log(`  bridge ${args.method || "GET"} ${args.path} -> ${upstream.status}, ${body.length} bytes`);
      res.end(JSON.stringify({
        status: upstream.status,
        contentType: upstream.headers.get("content-type") || "application/json",
        body
      }));
    } catch (error) {
      res.end(JSON.stringify({ status: 502, contentType: "application/json", body: JSON.stringify({ error: String(error) }) }));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(stub + bundle);
});

await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const probeUrl = `http://127.0.0.1:${probe.address().port}/`;
console.log(`serving the widget document at ${probeUrl} (api goes to ${uiPort})`);

if (keep) {
  console.log("left running; open it in a browser and press ctrl+c when done");
} else {
  const profile = await mkdtemp(path.join(tmpdir(), "tt-widget-"));
  const shot = path.join(profile, "shot.png");
  const report = path.join(profile, "report.json");
  const chromium = findChromium();
  if (!chromium) {
    console.error("no chromium found; rerun with --keep and look at it yourself");
    process.exit(2);
  }
  // The report is written by the page itself, because what matters is state after startup settles.
  const child = spawn(chromium, [
    // Roughly the box a chat gives a widget: narrow, and much shorter than a window.
    "--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`,
    "--window-size=720,520", "--virtual-time-budget=25000",
    `--screenshot=${shot}`, probeUrl
  ], { stdio: "ignore" });

  const result = await Promise.race([
    reportArrived,
    new Promise((resolve) => setTimeout(() => resolve(null), 40000))
  ]);
  child.kill();

  const png = await readFile(shot).catch(() => null);
  if (!result) {
    console.error("the page never reported back - it probably died before startup finished");
  } else {
    console.log(`errors: ${result.errors.length ? result.errors.join(" | ") : "none"}`);
    console.log(`nodes drawn: ${result.nodes}, edges: ${result.edges}`);
    console.log(`graph pane: ${result.graphBox}, page overflow: ${result.overflow}px`);
    if (result.sticksOut?.length) console.log(`sticking out: ${result.sticksOut.join(", ")}`);
    console.log(`status line: ${result.status.trim() || "(empty)"}`);
    console.log(`page text: ${result.title.trim()}`);
    console.log(`api calls over the bridge: ${result.calls.length}`);
    for (const call of result.calls.slice(0, 12)) console.log(`  ${call}`);
  }
  console.log(`screenshot: ${png ? `${Math.round(png.length / 1024)} KB at ${shot}` : "not taken"}`);
  await rm(report, { force: true });
  probe.close();
  process.exit(result && result.nodes > 0 && !result.errors.length ? 0 : 1);
}
