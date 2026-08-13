/**
 * Builds the widget document and reports what came out.
 *
 * Serves as a quick eye on size and on the pieces that are easy to break silently: the API shim,
 * the lazily imported sources, and script blocks that were cut short by an unescaped closing tag.
 *
 *   node scripts/probe-widget-bundle.mjs [--write out.html]
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { widgetBundle } from "../server/widget-bundle.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = await widgetBundle({ publicDir: path.join(root, "public") });

const checks = {
  "kilobytes": Math.round(html.length / 1024),
  "app.js inlined": html.includes("const embedMode"),
  "flow-view lazily carried": html.includes("__taskTreeLazyModules"),
  "api shim before the page": html.indexOf("task_tree_api") < html.indexOf("const embedMode"),
  "body markup": html.includes('id="app"'),
  "script blocks": (html.match(/<script/g) || []).length,
  "closing script tags": (html.match(/<\/script>/g) || []).length
};
for (const [label, value] of Object.entries(checks)) console.log(`${label}: ${value}`);

const writeAt = process.argv.indexOf("--write");
if (writeAt >= 0 && process.argv[writeAt + 1]) {
  await writeFile(process.argv[writeAt + 1], html, "utf8");
  console.log(`written: ${process.argv[writeAt + 1]}`);
}
