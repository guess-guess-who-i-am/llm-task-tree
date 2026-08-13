/**
 * Fires the same turn the UI's Codex button fires, and reports where it landed.
 *
 * The point is the resource uri on the tool call item: that is the host being handed a widget.
 * Whether it then paints is only visible in the app, but a missing uri means it never could.
 *
 *   node scripts/probe-open-graph.mjs [projectRoot]
 */
import { startCodexTurn } from "../server/codex-run.js";

const cwd = process.argv[2] || process.cwd();
const result = await startCodexTurn({ cwd });

console.log(`thread: ${result.threadId}`);
console.log(`deeplink: ${result.deeplink || "(none)"}`);
if (result.error) console.log(`error: ${result.error}`);
console.log(`\nnow: node scripts/probe-thread-items.mjs ${result.threadId} ${cwd}`);
process.exit(result.error ? 1 : 0);
