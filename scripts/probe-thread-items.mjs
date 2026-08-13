/**
 * Reads back what a thread actually produced.
 *
 * Whether a widget rendered is only visible in the app, but whether the host was handed one is
 * visible here: a tool call item carries the ui resource uri when the result linked a template.
 *
 *   node scripts/probe-thread-items.mjs <threadId> [projectRoot]
 */
import { spawnAppServer, withSession } from "../server/codex-run.js";

const [threadId, projectRoot = process.cwd()] = process.argv.slice(2);
if (!threadId) {
  console.error("usage: node scripts/probe-thread-items.mjs <threadId> [projectRoot]");
  process.exit(2);
}

const result = await withSession(
  () => spawnAppServer({ cwd: projectRoot }),
  async (session) => session.request("thread/read", { threadId, includeTurns: true })
);

const items = result?.thread?.turns?.flatMap((turn) => turn.items || []) || result?.items || [];
for (const item of items) {
  const kind = item.type || item.itemType || "?";
  const detail = [
    item.toolName || item.name || "",
    item.mcpAppResourceUri || item._meta?.ui?.resourceUri || "",
    item.status || "",
    (item.text || "").slice(0, 120).replace(/\s+/g, " ")
  ].filter(Boolean).join(" | ");
  console.log(`${kind}: ${detail}`);
}
process.exit(0);
