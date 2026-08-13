/**
 * Packs the real UI into a single document.
 *
 * The chat sandbox cannot make any network request to a loopback address - not a frame, not a
 * script tag, not a fetch - so nothing can be linked; everything the page needs has to arrive with
 * the page. The sources are the same files the browser serves, so there is still one UI and it
 * cannot drift.
 *
 * Two things must survive the move:
 *   - Lazily imported modules. `import("/flow-view.js")` would resolve against the sandbox origin,
 *     so those sources ride along and are handed to the page as blob urls, which the host's
 *     `script-src` allows.
 *   - The API. The page keeps calling `/api/...`; a shim installed before it runs turns each call
 *     into a tool call. See `embedApiShim`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Loaded up front by index.html, in this order. */
const STYLES = ["styles.css", "flow-view.css", "scratch-blocks.css"];
const SCRIPTS = ["tree-layout.js", "app.js"];
/** Pulled in later by `import()`, keyed by the path the page asks for. */
const LAZY_MODULES = ["flow-view.js", "graph-export.js"];

/** `</script>` inside a script body ends the block, whatever the language rules say. */
function inlineSafe(source) {
  return source.replace(/<\/script/gi, "<\\/script");
}

async function readPublic(publicDir, name) {
  return readFile(path.join(publicDir, name), "utf8");
}

/**
 * The page's own body markup, taken from index.html so the two never diverge.
 * Everything outside `<body>` is dropped: the widget lives inside a document it does not own.
 */
function bodyOf(indexHtml) {
  const match = indexHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  // Script tags are dropped here and re-added below: left in place they would resolve against the
  // sandbox origin, where the files do not exist.
  return (match ? match[1] : indexHtml).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/** Only the stylesheet links that point somewhere the sandbox is allowed to reach. */
function remoteStylesheets(indexHtml) {
  return [...indexHtml.matchAll(/<link\s+rel="stylesheet"\s+href="(https:\/\/[^"]+)"[^>]*>/gi)]
    .map((match) => match[0]);
}

function remoteScripts(indexHtml) {
  return [...indexHtml.matchAll(/<script\s+src="(https:\/\/[^"]+)"[^>]*><\/script>/gi)]
    .map((match) => match[0]);
}

/**
 * Replaces `fetch` for same-origin API paths, before any page code runs.
 *
 * Anything else - a CDN font, a data url - is left to the real fetch.
 */
export function embedApiShim() {
  return `
    const realFetch = window.fetch.bind(window);
    const bridge = window.openai;

    const apiPath = (input) => {
      const url = typeof input === "string" ? input : (input?.url || "");
      if (url.startsWith("/api/")) return url;
      try {
        const parsed = new URL(url, location.href);
        return parsed.origin === location.origin && parsed.pathname.startsWith("/api/")
          ? parsed.pathname + parsed.search
          : "";
      } catch { return ""; }
    };

    window.fetch = async (input, init = {}) => {
      const target = apiPath(input);
      if (!target || !bridge?.callTool) return realFetch(input, init);
      const result = await bridge.callTool("task_tree_api", {
        method: (init.method || (typeof input === "object" ? input.method : "") || "GET").toUpperCase(),
        path: target,
        ...(init.body === undefined || init.body === null ? {} : { body: String(init.body) })
      });
      const text = (result?.content || []).map((block) => block?.text || "").join("");
      const payload = JSON.parse(text);
      return new Response(payload.body ?? "", {
        status: payload.status ?? 200,
        headers: { "content-type": payload.contentType || "application/json" }
      });
    };
  `;
}

/**
 * @returns {Promise<string>} a document that needs nothing from the network to run.
 */
export async function widgetBundle({ publicDir, lazyModules = LAZY_MODULES } = {}) {
  const indexHtml = await readPublic(publicDir, "index.html");
  const styles = await Promise.all(STYLES.map((name) => readPublic(publicDir, name)));
  const scripts = await Promise.all(SCRIPTS.map((name) => readPublic(publicDir, name)));
  const lazy = await Promise.all(lazyModules.map(async (name) => [`/${name}`, await readPublic(publicDir, name)]));

  return [
    remoteStylesheets(indexHtml).join("\n"),
    `<style>\n${styles.join("\n")}\n</style>`,
    bodyOf(indexHtml),
    remoteScripts(indexHtml).join("\n"),
    // Registered before the page loads, because the page reads its first tree during startup.
    `<script>window.__taskTreeEmbed = true;\nwindow.__taskTreeLazyModules = ${JSON.stringify(Object.fromEntries(lazy))};\n${embedApiShim()}</script>`,
    ...scripts.map((source) => `<script>${inlineSafe(source)}</script>`)
  ].join("\n");
}
