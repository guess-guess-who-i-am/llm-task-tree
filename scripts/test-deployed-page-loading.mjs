import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findChromium } from '../server/graph-render.js';

const root = path.resolve(import.meta.dirname, '..');
const url = process.env.TEST_IDE_URL || 'http://127.0.0.1:5518';
const project = await (await fetch(url + '/api/project')).json();
assert.equal(project.root, root);
const paths = ['task-tree.md', 'subtrees/N3-subtree.md', '.task-tree-direct-state.json'];
const before = await Promise.all(paths.map(file => readFile(path.join(root, file))));
const { chromium, webkit } = createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await Promise.all([['chromium', chromium], ['webkit', webkit]].map(async ([name, engine]) => {
  const browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { executablePath: findChromium() } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failed.push(request.url()));
    await page.route('**/api/**', route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 409, body: '{"error":"readonly deployment probe"}' });
      return route.continue();
    });
    for (const [scope, suffix] of [['main', ''], ['subtree', '&subtree=subtrees%2FN3-subtree.md']]) {
      const start = performance.now();
      await page.goto(url + '?snapshot=1' + suffix, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.taskTreeBoot?.state === 'ready' && window.__taskTreeSnapshotReady, null, { timeout: 10000 });
      assert.ok(await page.locator('.graphNode').count() > 0);
      assert.equal(await page.locator('#pageBootStatus').isVisible(), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(failed, []);
      console.log(JSON.stringify({ browser: name, scope, nodes: await page.locator('.graphNode').count(), renderMs: Math.round(performance.now() - start) }));
      await page.screenshot({ path: path.join(root, 'artifacts', `page-loading-${name}-${scope}.png`) });
    }
  } finally { await browser.close(); }
}));
for (let index = 0; index < paths.length; index++) assert.deepEqual(await readFile(path.join(root, paths[index])), before[index], paths[index] + ' unchanged');
console.log('PASS deployed main/subtree: both browser engines; original tree and dialogue files unchanged');
