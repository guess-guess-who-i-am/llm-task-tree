/**
 * Asks the desktop app what it understands, instead of guessing from documentation.
 *
 * A widget API only exists if the host ships code for it, and that has already been the difference
 * between a working feature and a week of theories.
 *
 *   node scripts/probe-host-strings.mjs <file> <needle> [needle...] [--context=N] [--max=N]
 *
 * A minified bundle puts a whole function on one line, so `--context` is often the difference
 * between knowing a word appears and knowing what it does; `--max` shows more than the first hit.
 */
import { open } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((item) => item.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const context = flag("context", 60);
const maxSamples = flag("max", 1);
const [file, ...needles] = args.filter((item) => !item.startsWith("--"));
if (!file || !needles.length) {
  console.error("usage: node scripts/probe-host-strings.mjs <file> <needle> [needle...] [--context=N] [--max=N]");
  process.exit(2);
}

const handle = await open(file, "r");
const counts = new Map(needles.map((needle) => [needle, 0]));
const samples = new Map(needles.map((needle) => [needle, []]));
const CHUNK = 8 * 1024 * 1024;
const overlap = Math.max(...needles.map((needle) => needle.length));
let carry = "";
let position = 0;

for (;;) {
  const buffer = Buffer.alloc(CHUNK);
  const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
  if (!bytesRead) break;
  position += bytesRead;
  // Latin1 keeps one byte per character, so a needle is never split by a decoding boundary.
  const text = carry + buffer.subarray(0, bytesRead).toString("latin1");
  for (const needle of needles) {
    let at = text.indexOf(needle);
    while (at >= 0) {
      counts.set(needle, counts.get(needle) + 1);
      if (samples.get(needle).length < maxSamples) {
        samples.get(needle).push(
          text.slice(Math.max(0, at - context), at + needle.length + context).replace(/[^\x20-\x7e]/g, ".")
        );
      }
      at = text.indexOf(needle, at + needle.length);
    }
  }
  carry = text.slice(-overlap);
}
await handle.close();

for (const needle of needles) {
  console.log(`${needle}: ${counts.get(needle)}`);
  for (const sample of samples.get(needle)) console.log(`    ${sample}`);
}
