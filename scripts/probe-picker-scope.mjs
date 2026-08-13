/**
 * Checks that each project's picker offers that project's conversations and no others.
 *
 * The page can only be trusted here if its list is compared against where Codex actually files each
 * conversation, so every id it offers is looked up in the raw list.
 *
 *   node scripts/probe-picker-scope.mjs <port>=<projectRoot> [<port>=<projectRoot> ...]
 */
import path from "node:path";
import { spawnAppServer, withSession } from "../server/codex-run.js";

const targets = process.argv.slice(2).map((pair) => {
  const at = pair.indexOf("=");
  return { port: Number(pair.slice(0, at)), root: pair.slice(at + 1) };
});
if (!targets.length) {
  console.error("usage: node scripts/probe-picker-scope.mjs <port>=<projectRoot> ...");
  process.exit(2);
}

// Where Codex says each conversation lives, read once and deeply enough to cover quiet projects.
const home = new Map();
await withSession(() => spawnAppServer({ cwd: process.cwd() }), async (session) => {
  let cursor = null;
  for (let page = 0; page < 8; page += 1) {
    const listed = await session.request("thread/list", cursor ? { limit: 60, cursor } : { limit: 60 });
    for (const thread of listed?.data || []) {
      if (thread?.id) home.set(thread.id, thread.cwd || "(none)");
    }
    cursor = listed?.nextCursor || null;
    if (!cursor) break;
  }
});
console.log(`known conversations: ${home.size}\n`);

let bad = 0;
for (const { port, root } of targets) {
  const want = path.resolve(root).toLowerCase();
  let payload;
  try {
    payload = await (await fetch(`http://127.0.0.1:${port}/api/codex/threads`)).json();
  } catch (error) {
    console.log(`${port} (${root}): unreachable - ${error.message}`);
    bad += 1;
    continue;
  }

  const offered = payload.threads || [];
  const strays = offered.filter((thread) => path.resolve(home.get(thread.id) || "").toLowerCase() !== want);
  console.log(`${port} (${root}): offers ${offered.length}, from another project: ${strays.length}`);
  for (const stray of strays) console.log(`    ${stray.id.slice(0, 8)} actually lives in ${home.get(stray.id)}`);
  if (strays.length || !offered.length) bad += 1;
}

process.exit(bad ? 1 : 0);
