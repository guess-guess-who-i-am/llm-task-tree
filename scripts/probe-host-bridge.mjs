/**
 * Dumps the widget bridge the desktop app actually installs.
 *
 * What a widget may do is decided by this one object, and guessing at it from documentation has
 * already cost more than reading it does.
 *
 *   node scripts/probe-host-bridge.mjs <app.asar>
 */
import { open } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/probe-host-bridge.mjs <app.asar>");
  process.exit(2);
}

const ANCHOR = "requestDisplayMode";
const WINDOW = 1400;

const handle = await open(file, "r");
const CHUNK = 8 * 1024 * 1024;
let carry = "";
let position = 0;
let found = 0;

for (;;) {
  const buffer = Buffer.alloc(CHUNK);
  const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
  if (!bytesRead) break;
  position += bytesRead;
  const text = carry + buffer.subarray(0, bytesRead).toString("latin1");
  let at = text.indexOf(ANCHOR);
  while (at >= 0 && found < 4) {
    const slice = text.slice(Math.max(0, at - WINDOW), at + WINDOW).replace(/[^\x20-\x7e]/g, ".");
    console.log(`--- hit ${++found} ---\n${slice}\n`);
    at = text.indexOf(ANCHOR, at + ANCHOR.length);
  }
  if (found >= 4) break;
  carry = text.slice(-WINDOW * 2);
}
await handle.close();
