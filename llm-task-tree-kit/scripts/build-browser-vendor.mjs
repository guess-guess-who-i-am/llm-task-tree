import { cp, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'node_modules/katex');
const target = path.join(root, 'public/vendor/katex');
const files = ['katex.min.js', 'katex.min.css', ...(await readdir(path.join(source, 'dist/fonts'))).map(name => 'fonts/' + name)];
for (const name of files) {
  if (process.argv.includes('--check')) assert.deepEqual(await readFile(path.join(target, name)), await readFile(path.join(source, 'dist', name)), name);
  else { await mkdir(path.dirname(path.join(target, name)), { recursive: true }); await copyFile(path.join(source, 'dist', name), path.join(target, name)); }
}
if (!process.argv.includes('--check')) await cp(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
console.log(`KaTeX: ${files.length} 本地资源与依赖版本一致`);
