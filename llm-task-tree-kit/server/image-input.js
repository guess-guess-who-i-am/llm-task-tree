import { readFile, stat } from 'node:fs/promises';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// The bytes, not a filename or a UTF-8 guess, own the media type.
export function imageMimeType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function imageResult(file, bytes) {
  const mimeType = imageMimeType(bytes);
  if (!mimeType) return null;
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MiB；不会截断或转换原图。');
  return { path: file, image: { mimeType, data: bytes.toString('base64') } };
}

export async function readImage(file) {
  if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MiB；不会截断或转换原图。');
  const result = imageResult(file, await readFile(file));
  if (!result) throw new Error('不是支持的图片；请提供 PNG、JPEG 或 WebP 原图。');
  return result;
}

export function decodeText(bytes) {
  if (bytes.some(byte => byte < 32 && ![9, 10, 13].includes(byte))) throw new Error('这是二进制文件，不是 UTF-8 文本；图片请使用 view_image。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文件不是有效的 UTF-8 文本；不会将二进制解码成乱码。'); }
}
