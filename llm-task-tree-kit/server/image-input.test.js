import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { imageResult, imageMimeType, decodeText, MAX_IMAGE_BYTES } from './image-input.js';
const require = createRequire(import.meta.url);
const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');

test('PNG, JPEG and WebP use their real bytes regardless of filename and are never transformed', () => {
  const canvas = createCanvas(10, 10);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const bytes = canvas.toBuffer(mime);
    const result = imageResult('no-extension', bytes);
    assert.equal(result.image.mimeType, mime);
    assert.deepEqual(Buffer.from(result.image.data, 'base64'), bytes);
  }
  assert.equal(imageMimeType(Buffer.from('not a JPEG')), null);
  assert.equal(imageResult('faked.jpg', Buffer.from('text')), null);
});

test('oversize images fail explicitly and text decoding is lossless or fails, never replacement garbage', () => {
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  huge[0] = 255; huge[1] = 216; huge[2] = 255;
  assert.throws(() => imageResult('big.jpg', huge), /20 MiB/);
  const text = '完整中文 UTF-8\n\t末尾';
  assert.equal(decodeText(Buffer.from(text)), text);
  for (const bytes of [Buffer.from([0]), Buffer.from([255, 254]), Buffer.from([1, 2])]) assert.throws(() => decodeText(bytes), /UTF-8|二进制/);
});
