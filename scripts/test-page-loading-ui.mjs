import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChromium } from '../server/graph-render.js';
import { widgetBundle } from '../server/widget-bundle.js';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'page-loading-'));
const tree = '# LLM Task Graph\n\n## ROOT - 加载回归\n- Position: 100,100\n- Size: 400,420\n- Problem: 离线及服务恢复后也能打开树。\n- NextIdea: 查看节点。\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n';
await writeFile(path.join(fixture, 'task-tree.md'), tree);
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TASK_TREE_PROJECT_ROOT: fixture },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error('startup: ' + errors)), 15000);
    child.stderr.on('data', value => { errors += value; });
    child.stdout.on('data', value => {
      output += value;
      const match = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', reject);
  });
  const { chromium, webkit } = createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
  browser = process.env.TEST_BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ headless: true, executablePath: findChromium() });
  const cases = process.argv.slice(2);
  async function check(name, run) {
    if (cases.length && !cases.includes(name)) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try { await run(page, errors); console.log('PASS ' + name); }
    finally { await page.close(); }
  }
  async function ready(page) {
    await page.waitForFunction(() => document.querySelectorAll('.graphNode').length > 0, null, { timeout: 7000 });
    await page.locator('#pageBootStatus').waitFor({ state: 'hidden', timeout: 7000 });
    assert.equal(await page.locator('.layout').evaluate(element => getComputedStyle(element).display), 'grid');
    assert.equal(await page.locator('#pageBootStatus').isVisible(), false);
  }
  await check('offline', async page => {
    let remote = 0;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== url) { remote++; return route.abort(); }
      return route.continue();
    });
    const start = performance.now();
    await page.goto(url + '?snapshot=1', { waitUntil: 'domcontentloaded' });
    await ready(page);
    assert.equal(remote, 0, 'IDE startup must not depend on a CDN');
    assert.equal(await page.evaluate(() => typeof katex.renderToString), 'function');
    for (const formula of ['x^2', '\\frac{1}{2}', '\\sum_{i=1}^{3} i']) {
      assert.match(await page.evaluate(formula => katex.renderToString(formula, { throwOnError: true, trust: false }), formula), /katex/);
    }
    await page.evaluate(async () => {
      const math = document.createElement('div');
      math.innerHTML = katex.renderToString('\\frac{1}{2} + x^2');
      document.body.append(math);
      await document.fonts.load('16px KaTeX_Main');
      await document.fonts.ready;
      if (!document.fonts.check('16px KaTeX_Main')) throw new Error('Local math font did not load');
    });
    console.log('offline render ms: ' + Math.round(performance.now() - start));
  });
  await check('transient-assets', async page => {
    const counts = new Map();
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (['/styles.css', '/tree-layout.js', '/app.js'].includes(pathname)) {
        const count = (counts.get(pathname) || 0) + 1;
        counts.set(pathname, count);
        if (count === 1) return route.abort();
      }
      return route.continue();
    });
    await page.goto(url + '?snapshot=1', { waitUntil: 'domcontentloaded' });
    await ready(page);
    for (const pathname of ['/styles.css', '/tree-layout.js', '/app.js']) assert.equal(counts.get(pathname), 2, pathname);
    assert.equal(await page.locator('.graphNode').count(), 1, 'retry must not double-initialize app');
  });
  await check('permanent-css', async page => {
    await page.route('**/styles.css*', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pageBootStatus')?.dataset.state === 'failed', null, { timeout: 7000 });
    assert.match(await page.locator('#pageBootStatus').textContent(), /styles\.css/);
    assert.equal(await page.locator('.graphNode').count(), 0, 'do not show an unstyled half-initialized UI');
    await page.unroute('**/styles.css*');
    await page.locator('#pageBootRetry').click();
    await ready(page);
  });
  await check('slow-script', async (page, errors) => {
    let requests = 0;
    await page.route('**/app.js*', async route => {
      requests++;
      if (requests === 1) await new Promise(resolve => setTimeout(resolve, 5400));
      await route.continue().catch(() => {});
    });
    await page.goto(url + '?snapshot=1', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(600);
    assert.equal(requests, 2);
    assert.deepEqual(errors, [], 'timed-out script must never execute a second time');
    assert.equal(await page.locator('.graphNode').count(), 1);
  });
  await check('tree-api-recovery', async page => {
    let fail = true;
    await page.route('**/api/trees?*', route => fail ? route.fulfill({ status: 503, body: '{"error":"fixture restart"}', contentType: 'application/json' }) : route.continue());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pageBootStatus')?.dataset.state === 'failed', null, { timeout: 7000 });
    fail = false;
    await page.locator('#pageBootRetry').click();
    await ready(page);
  });
  await check('script-error', async page => {
    await page.route('**/app.js*', route => route.fulfill({ status: 200, body: 'throw new Error("fixture startup exception")', contentType: 'application/javascript' }));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pageBootStatus')?.dataset.state === 'failed', null, { timeout: 7000 });
    assert.match(await page.locator('#pageBootStatus').textContent(), /fixture startup exception/);
  });
  await check('cache-policy', async () => {
    for (const pathname of ['/', '/styles.css', '/app.js']) {
      const response = await fetch(url + pathname);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
    }
  });
  await check('embedded-widget', async (page, errors) => {
    let remote = 0;
    const attempted = [];
    await page.route('**/*', route => {
      if (/^(blob|data):/.test(route.request().url())) return route.continue();
      if (new URL(route.request().url()).pathname === '/fixture-widget') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>widget fixture</title>' });
      if (new URL(route.request().url()).pathname === '/favicon.ico') return route.abort();
      remote++; attempted.push(route.request().url()); return route.abort();
    });
    await page.exposeFunction('fixtureBridge', async (_name, args) => {
      const response = await fetch(url + args.path, { method: args.method, ...(args.body ? { body: args.body } : {}) });
      return { content: [{ type: 'text', text: JSON.stringify({ status: response.status, body: await response.text(), contentType: response.headers.get('content-type') }) }] };
    });
    await page.goto(url + '/fixture-widget');
    await page.evaluate(() => { window.openai = { callTool: window.fixtureBridge }; });
    await page.setContent(await widgetBundle({ publicDir: path.join(root, 'public') }), { waitUntil: 'domcontentloaded' });
    try { await ready(page); } catch (error) {
      console.error('widget errors:', errors, 'status:', await page.locator('#pageBootStatus').textContent());
      throw error;
    }
    assert.equal(remote, 0, 'embedded widget must also work without external assets: ' + attempted.join(', '));
    assert.equal(await page.evaluate(() => typeof katex.renderToString), 'function');
    assert.deepEqual(errors, []);
  });
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await once(child, 'exit');
  await rm(fixture, { recursive: true, force: true });
}
