/**
 * Dumps the conversations Codex knows about, with the working directory each one is filed under.
 *
 * The picker filters on that directory, so when a project's conversations go missing this is the
 * only place that says whether they are absent, filed elsewhere, or simply past the page limit.
 *
 *   node scripts/probe-thread-list.mjs [limit] [--cwd <path>]
 */
import path from "node:path";
import { spawnAppServer, withSession } from "../server/codex-run.js";

const args = process.argv.slice(2);
const cwdAt = args.indexOf("--cwd");
const wanted = cwdAt >= 0 ? path.resolve(args[cwdAt + 1]).toLowerCase() : "";
const limit = Number(args[0]) > 0 ? Number(args[0]) : 60;

const listed = await withSession(
  () => spawnAppServer({ cwd: process.cwd() }),
  (session) => session.request("thread/list", { limit })
);

const threads = listed?.data || [];
console.log(`returned ${threads.length} threads (asked for ${limit})\n`);

const byCwd = new Map();
for (const thread of threads) {
  const key = thread.cwd ? path.resolve(thread.cwd) : "(no cwd)";
  byCwd.set(key, (byCwd.get(key) || 0) + 1);
}
console.log("filed under:");
for (const [dir, count] of [...byCwd].sort((a, b) => b[1] - a[1])) console.log(`  ${count.toString().padStart(3)}  ${dir}`);

if (wanted) {
  const mine = threads.filter((thread) => thread.cwd && path.resolve(thread.cwd).toLowerCase() === wanted);
  console.log(`\nmatching ${wanted}: ${mine.length}`);
  for (const thread of mine.slice(0, 10)) {
    console.log(`  ${thread.id.slice(0, 8)} ${thread.ephemeral ? "[ephemeral] " : ""}${thread.name || String(thread.preview || "").replace(/\s+/g, " ").slice(0, 60)}`);
  }
}
process.exit(0);
