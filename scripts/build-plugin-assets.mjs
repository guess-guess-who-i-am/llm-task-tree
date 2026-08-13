#!/usr/bin/env node
/**
 * Renders the Codex plugin's install-surface artwork.
 *
 * The ChatGPT desktop app shows `composerIcon` at 360x360 and `logo` at 512x512 (the sizes the
 * built-in OpenAI plugins ship), so the artwork is generated rather than hand-drawn: one geometry
 * description, both sizes. Rasterizing is done here instead of through a headless browser so the
 * result is byte-identical on any machine and the kit keeps its zero-dependency install — a
 * recipient without Chrome/Edge can still rebuild the assets.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng } from "../server/png.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(projectRoot, "marketplace", "plugins", "task-tree", "assets");

const BRAND = [0x6e, 0x56, 0xcf];
const BRAND_DARK = [0x4b, 0x36, 0xa8];
const WHITE = [0xff, 0xff, 0xff];

/** Samples per axis inside one pixel. 4 means 16 samples, which is enough to hide the stair steps. */
const SUPERSAMPLE = 4;

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundedRect(x, y, width, height, radius) {
  const dx = Math.abs(x - width / 2) - (width / 2 - radius);
  const dy = Math.abs(y - height / 2) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

/** Signed distance to a capsule: a line segment with round caps, which is how the edges are drawn. */
function sdSegment(x, y, ax, ay, bx, by, halfWidth) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01((px * dx + py * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - dx * t, py - dy * t) - halfWidth;
}

/**
 * The mark is the product itself: a parent node, two children, and the focused child ringed. It has
 * to survive being scaled down to a composer chip, so it is three shapes and nothing finer.
 */
function shapes(size) {
  const u = (value) => value * size;
  const rootR = u(0.083);
  const childR = u(0.072);
  const rootY = u(0.245);
  const busY = u(0.5);
  const childY = u(0.755);
  const leftX = u(0.285);
  const rightX = u(0.715);
  const midX = u(0.5);
  const edge = u(0.0235);

  return [
    {
      color: null, // gradient tile
      sd: (x, y) => sdRoundedRect(x, y, size, size, u(0.22))
    },
    {
      color: WHITE,
      alpha: 0.95,
      sd: (x, y) => Math.min(
        sdSegment(x, y, midX, rootY + rootR * 0.4, midX, busY, edge),
        sdSegment(x, y, leftX, busY, rightX, busY, edge),
        sdSegment(x, y, leftX, busY, leftX, childY - childR * 0.4, edge),
        sdSegment(x, y, rightX, busY, rightX, childY - childR * 0.4, edge)
      )
    },
    {
      color: WHITE,
      alpha: 0.62,
      // Focus ring around the current node.
      sd: (x, y) => Math.max(sdCircle(x, y, rightX, childY, u(0.128)), -sdCircle(x, y, rightX, childY, u(0.104)))
    },
    { color: WHITE, alpha: 1, sd: (x, y) => sdCircle(x, y, midX, rootY, rootR) },
    { color: WHITE, alpha: 0.55, sd: (x, y) => sdCircle(x, y, leftX, childY, childR) },
    { color: WHITE, alpha: 1, sd: (x, y) => sdCircle(x, y, rightX, childY, childR) }
  ];
}

function tileColor(x, y, size) {
  const t = clamp01((x + y) / (2 * size));
  return [
    Math.round(BRAND[0] + (BRAND_DARK[0] - BRAND[0]) * t),
    Math.round(BRAND[1] + (BRAND_DARK[1] - BRAND[1]) * t),
    Math.round(BRAND[2] + (BRAND_DARK[2] - BRAND[2]) * t)
  ];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const geometry = shapes(size);
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      // Straight (non-premultiplied) accumulation of the composited colour and alpha.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;

          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;

          for (const shape of geometry) {
            if (shape.sd(x, y) > 0) continue;
            const [cr, cg, cb] = shape.color || tileColor(x, y, size);
            const alpha = shape.alpha ?? 1;
            sr = cr * alpha + sr * (1 - alpha);
            sg = cg * alpha + sg * (1 - alpha);
            sb = cb * alpha + sb * (1 - alpha);
            sa = alpha + sa * (1 - alpha);
          }

          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }

      const offset = (py * size + px) * 4;
      const coverage = a / samples;
      // Undo the coverage weighting so edge pixels keep their colour and only lose alpha.
      const scale = coverage > 0 ? 1 / a : 0;
      pixels[offset] = Math.round(r * scale);
      pixels[offset + 1] = Math.round(g * scale);
      pixels[offset + 2] = Math.round(b * scale);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

async function main() {
  await mkdir(assetsDir, { recursive: true });
  const rendered = [];

  for (const [name, size] of [["icon.png", 360], ["logo.png", 512]]) {
    const png = encodePng(render(size), size, size);
    await writeFile(path.join(assetsDir, name), png);
    rendered.push({ asset: name, size, bytes: png.length });
  }

  console.log(JSON.stringify({ ok: true, assetsDir, rendered }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
