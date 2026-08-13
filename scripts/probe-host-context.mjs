/**
 * Prints the readable strings surrounding a needle in a binary.
 *
 * A count tells you a feature might exist; the neighbouring strings tell you what it is called and
 * what it sits next to, which is what decides how to write a config the host will accept.
 *
 *   node scripts/probe-host-context.mjs <file> <needle> [window] [maxHits]
 */
import { open } from "node:fs/promises";

const [file, needle, windowArg, maxArg] = process.argv.slice(2);
if (!file || !needle) {
  console.error("usage: node scripts/probe-host-context.mjs <file> <needle> [window] [maxHits]");
  process.exit(2);
}
const window = Number(windowArg) || 220;
const maxHits = Number(maxArg) || 12;

const handle = await open(file, "r");
const CHUNK = 8 * 1024 * 1024;
let carry = "";
let position = 0;
let hits = 0;

outer:
for (;;) {
  const buffer = Buffer.alloc(CHUNK);
  const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
  if (!bytesRead) break;
  position += bytesRead;
  const text = carry + buffer.subarray(0, bytesRead).toString("latin1");

  let at = text.indexOf(needle);
  while (at >= 0) {
    const slice = text.slice(Math.max(0, at - window), at + needle.length + window);
    // Binary padding turns into noise; splitting on it leaves the actual strings.
    const readable = slice.split(/[^\x20-\x7e]+/).filter((part) => part.length >= 4);
    console.log(`--- hit ${hits + 1}`);
    console.log(readable.join(" | "));
    hits += 1;
    if (hits >= maxHits) break outer;
    at = text.indexOf(needle, at + needle.length);
  }
  carry = text.slice(-window);
}
await handle.close();
if (!hits) console.log("no hits");
