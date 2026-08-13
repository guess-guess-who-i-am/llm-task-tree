/**
 * Minimal PNG encode/decode.
 *
 * Both are needed without pulling in an image library: the plugin artwork is rasterized here, and
 * headless screenshots have to be cropped (a headless window's viewport is smaller than the window
 * itself, so the capture carries transparent margins).
 *
 * Scope is deliberately narrow: 8-bit non-interlaced truecolour, with or without alpha. Anything
 * else throws rather than silently producing garbage.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Buffer} rgba straight (non-premultiplied) RGBA, width*height*4 bytes. */
export function encodePng(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** @returns {{width:number,height:number,data:Buffer}} data is RGBA regardless of the source. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!header) throw new Error("PNG has no IHDR");
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`unsupported PNG colour type ${header.colorType}`);
  }

  const { width, height } = header;
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG data is shorter than its header claims");

  const lines = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = lines.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = source[x];

      switch (filter) {
        case 0: line[x] = value; break;
        case 1: line[x] = (value + left) & 0xff; break;
        case 2: line[x] = (value + up) & 0xff; break;
        case 3: line[x] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: line[x] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
    }
    previous = line;
  }

  if (channels === 4) return { width, height, data: lines };

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = lines[index * 3];
    rgba[index * 4 + 1] = lines[index * 3 + 1];
    rgba[index * 4 + 2] = lines[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

/**
 * Drops fully transparent rows and columns around the edges.
 *
 * A headless capture is window-sized while the page only paints the (smaller) viewport, so the
 * unpainted band is transparent. Cropping it self-calibrates instead of hard-coding a window frame
 * size that differs per platform and display scaling.
 */
export function cropTransparentMargins({ width, height, data }) {
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  const rowIsBlank = (y) => {
    for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] !== 0) return false;
    return true;
  };
  const columnIsBlank = (x) => {
    for (let y = top; y <= bottom; y += 1) if (data[(y * width + x) * 4 + 3] !== 0) return false;
    return true;
  };

  while (top <= bottom && rowIsBlank(top)) top += 1;
  while (bottom >= top && rowIsBlank(bottom)) bottom -= 1;
  if (top > bottom) return { width, height, data };

  while (left <= right && columnIsBlank(left)) left += 1;
  while (right >= left && columnIsBlank(right)) right -= 1;
  if (left > right) return { width, height, data };

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  if (cropWidth === width && cropHeight === height) return { width, height, data };

  const cropped = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    const start = ((top + y) * width + left) * 4;
    data.copy(cropped, y * cropWidth * 4, start, start + cropWidth * 4);
  }
  return { width: cropWidth, height: cropHeight, data: cropped };
}

/**
 * Composites a transparent image onto an opaque background, with a margin.
 *
 * A cropped screenshot is tight against the drawing and keeps the page's transparency; chat
 * clients render it on whatever colour their theme uses, which turns anti-aliased dark text into
 * mush on a dark theme. Baking the background in keeps the picture readable everywhere.
 */
export function flattenOnto({ width, height, data }, { background = [255, 255, 255], padding = 0 } = {}) {
  const outWidth = width + padding * 2;
  const outHeight = height + padding * 2;
  const out = Buffer.alloc(outWidth * outHeight * 4);

  for (let index = 0; index < outWidth * outHeight; index += 1) {
    out[index * 4] = background[0];
    out[index * 4 + 1] = background[1];
    out[index * 4 + 2] = background[2];
    out[index * 4 + 3] = 255;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const alpha = data[source + 3];
      if (alpha === 0) continue;
      const target = ((y + padding) * outWidth + x + padding) * 4;
      if (alpha === 255) {
        data.copy(out, target, source, source + 3);
        continue;
      }
      const weight = alpha / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        out[target + channel] = Math.round(data[source + channel] * weight + background[channel] * (1 - weight));
      }
    }
  }

  return { width: outWidth, height: outHeight, data: out };
}
