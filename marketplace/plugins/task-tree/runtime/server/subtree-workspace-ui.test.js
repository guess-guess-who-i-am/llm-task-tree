import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { findChromium } from './graph-render.js';

const source = path.resolve(import.meta.dirname, '..');
const { chromium } = createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
const main = '# LLM Task Graph\n## ROOT - 项目总目标\n- Problem: 保留主树并独立操作子树\n## N1 - 身体底盘\n- Folded: true\n- SubtreeFile: subtrees/N1.md\n- SubtreeCount: 3\n## N2 - 兄弟分支\n- Problem: 不应被修改\n# GraphState\n- Current: ROOT\n- Next: N2\n# Edges\n## E1 - 底盘\n- Endpoints: ROOT, N1\n## E2 - 兄弟\n- Endpoints: ROOT, N2\n';
const sub = '# LLM Task Graph Subtree\n> Fold root: N1\n## N1 - 身体底盘\n- Problem: 保持健康\n## N1_A - 睡眠\n- Problem: 建立作息\n- NextIdea: 保存睡眠记录\n## N1_B - 时间\n- Problem: 安排时间\n# GraphState\n- Current: N1\n- Next: N1_A\n# Edges\n## EA - 睡眠\n- Endpoints: N1, N1_A\n## EB - 时间\n- Endpoints: N1, N1_B\n';
let root, child, browser, base, gateway;
const attachmentModelRequests = [];
test('node next-step editors directly accept pasted images, dropped documents and local clipboard paths', async t => {
  const page = await pageFor(t); await enter(page); page.setDefaultTimeout(15000);
  const query = '?treeId=method&nodeId=N1_A';
  t.after(async () => {
    await fetch(base + '/api/codex/conversation' + query, { method: 'DELETE' });
    const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
    for (const ref of materials) await fetch(base + '/api/node/materials' + query, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ref.id }) });
  });
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('[data-focus-lens-node="N1_A"]').first().click();
  const input = page.locator('[data-focus-lens-next-idea="N1_A"]');
  const original = await input.inputValue(), beforeCount = attachmentModelRequests.length;
  const prevented = await input.evaluate(el => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    data.items.add(new File([bytes], '直接粘贴.png', { type: 'image/png' }));
    data.setData('text/plain', '/clipboard/image.png');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(prevented, true, 'the next-step editor must consume image paste instead of inserting its path');
  await page.waitForSelector('.focusLensNextWork .nodeEditorMaterial img');
  await input.evaluate(el => {
    for (const name of ['拖入的文档.txt', '连续拖入.txt']) {
      const data = new DataTransfer(); data.items.add(new File(['DIRECT_EDITOR_DOCUMENT_' + name], name, { type: 'text/plain' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.focusLensNextWork .nodeEditorMaterial').length === 3);
  const require = createRequire(import.meta.url);
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const jpeg = createCanvas(20, 20).toBuffer('image/jpeg');
  const imagePath = path.join(root, "Tiger'e 有空格.jpg"), documentPath = path.join(root, '粘贴的原文.md');
  await writeFile(imagePath, jpeg); await writeFile(documentPath, 'LOCAL_DOCUMENT_FULL_TEXT_END');
  for (const value of [imagePath, 'file://' + encodeURI(documentPath)]) {
    assert.equal(await input.evaluate((el, value) => {
      const data = new DataTransfer(); data.setData('text/plain', value);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(event); return event.defaultPrevented;
    }, value), true);
  }
  await page.waitForFunction(() => document.querySelectorAll('.focusLensNextWork .nodeEditorMaterial').length === 5);
  assert.equal(await input.inputValue(), original);
  assert.equal(await page.locator('#nodeMaterialsDialog').evaluate(el => el.open), false, 'no attachment button or popup is needed');
  assert.equal(attachmentModelRequests.length, beforeCount, 'adding materials does not execute the model');
  const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
  assert.equal(materials.length, 5); assert.ok(materials.every(m => m.enabled));
  const image = materials.find(m => m.name === path.basename(imagePath));
  assert.deepEqual(Buffer.from(await (await fetch(base + image.url)).arrayBuffer()), jpeg);
  await rm(imagePath); await rm(documentPath);
  assert.deepEqual(Buffer.from(await (await fetch(base + image.url)).arrayBuffer()), jpeg, 'import takes a durable snapshot');
  // Ordinary prose, copied document text and remote URLs remain normal text input.
  for (const value of ['文档正文直接放在说明中', 'https://example.com/image.png', '请看 /tmp/photo.png 然后分析']) {
    assert.equal(await input.evaluate((el, value) => {
      const data = new DataTransfer(); data.setData('text/plain', value);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(event); return event.defaultPrevented;
    }, value), false);
  }
  await page.screenshot({ path: path.join(source, 'artifacts/node-editor-materials.png') });
  await page.reload(); await page.waitForSelector('[data-node-id="N1_A"]');
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('[data-focus-lens-node="N1_A"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.focusLensNextWork .nodeEditorMaterial').length === 5);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/codex/run' && r.request().method() === 'POST');
  await page.locator('[data-focus-lens-action="run-agent"]').click(); await response;
  await page.waitForFunction(() => document.querySelector('#directRunDialogStatus').textContent.includes('执行完成'));
  const request = attachmentModelRequests.at(-1);
  assert.match(JSON.stringify(request), /DIRECT_EDITOR_DOCUMENT_|LOCAL_DOCUMENT_FULL_TEXT_END/);
  assert.ok(request.messages.some(m => Array.isArray(m.content) && m.content.filter(c => c.type === 'image_url').length === 2));
});

test('local attachment import validates explicit paths and node scope without running a model', async t => {
  const file = path.join(root, '导入协议.txt'); await writeFile(file, 'IMPORT_CONTRACT_END');
  const send = (nodeId, body, type = 'application/json') => fetch(base + '/api/chat/attachments/import?treeId=method&nodeId=' + nodeId,
    { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  assert.equal((await send('N1_A', { path: 'relative.txt' })).status, 400);
  assert.equal((await send('N1_A', { path: path.join(root, '不存在.txt') })).status, 404);
  assert.equal((await send('N1_A', { path: root })).status, 400);
  assert.equal((await send('ABSENT', { path: file })).status, 404);
  assert.equal((await send('N1_A', { path: file }, 'text/plain')).status, 415);
  const result = await send('N1_A', { path: file }); assert.equal(result.status, 201, await result.clone().text());
  const { attachment } = await result.json();
  assert.equal(await (await fetch(base + attachment.url)).text(), 'IMPORT_CONTRACT_END');
  const foreign = new URL(base + attachment.url); foreign.searchParams.set('nodeId', 'N2');
  assert.equal((await fetch(foreign)).status, 403);
});
test('node-card drops keep their original node while navigating, and failed path imports can be retried', async t => {
  const page = await pageFor(t), query = '?treeId=method&nodeId=N2';
  t.after(async () => {
    const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
    for (const ref of materials) await fetch(base + '/api/node/materials' + query, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ref.id }) });
  });
  const input = page.locator('[data-node-id="N2"] .nextIdeaInput');
  assert.equal(await input.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', '/tmp/no-such-node-material-image-123456.png');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  }), true);
  await page.waitForFunction(() => document.querySelector('[data-node-id="N2"] .nodeEditorMaterialStatus').textContent.includes('不存在'));
  await page.route('**/api/chat/attachments?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  const count = attachmentModelRequests.length;
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/node/materials' && r.request().method() === 'GET' && r.url().includes('nodeId=N2'));
  await page.locator('[data-node-id="N2"]').evaluate(el => {
    const data = new DataTransfer(); data.items.add(new File(['ORIGINAL_NODE_N2_DOCUMENT'], '切换时拖入.txt', { type: 'text/plain' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await enter(page);
  await saved;
  const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
  assert.equal(materials.length, 1); assert.equal(materials[0].name, '切换时拖入.txt');
  assert.equal((await (await fetch(base + '/api/node/materials?treeId=method&nodeId=N1_A')).json()).materials.length, 0);
  assert.equal(attachmentModelRequests.length, count);
});
test('node materials survive reload, select execution payloads and join a draft conversation without calling the model', async t => {
  const page = await pageFor(t); await enter(page);
  const query = '?treeId=method&nodeId=N1_A';
  t.after(async () => {
    await fetch(base + '/api/codex/conversation' + query, { method: 'DELETE' });
    const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
    for (const ref of materials) await fetch(base + '/api/node/materials' + query, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ref.id }) });
  });
  const beforeCount = attachmentModelRequests.length;
  await page.locator('[data-node-id="N1_A"] [data-action="materials"]').dispatchEvent('click');
  await page.locator('#nodeMaterialsFileInput').setInputFiles({ name: '节点资料.md', mimeType: 'text/markdown', buffer: Buffer.from('NODE_LIBRARY_DOCUMENT_123\n完整正文，不只是文件名') });
  await page.waitForFunction(() => document.querySelector('#nodeMaterialsStatus').textContent.includes('资料已保存'));
  assert.equal(attachmentModelRequests.length, beforeCount, 'saving must not call the model');
  assert.equal(await page.locator('[data-material-select]').isChecked(), true);
  await page.reload(); await page.waitForSelector('[data-node-id="N1_A"]');
  await page.locator('[data-node-id="N1_A"] [data-action="materials"]').dispatchEvent('click');
  await page.waitForSelector('.nodeMaterial');
  assert.match(await page.locator('.nodeMaterial').innerText(), /节点资料.md/);
  await page.locator('[data-material-select]').uncheck();
  await page.waitForFunction(() => document.querySelector('#nodeMaterialsStatus').textContent.includes('选择已保存'));
  await page.locator('[data-material-chat]').click();
  assert.equal(attachmentModelRequests.length, beforeCount);
  assert.match(await page.locator('#directRunDialogStatus').innerText(), /尚未调用模型/);
  await page.locator('#directRunMessageInput').fill('单次分析资料');
  await page.locator('#directRunUseMaterials').uncheck();
  await page.locator('#directRunSendBtn').click();
  await page.waitForFunction(() => document.querySelector('#directRunDialogStatus').textContent.includes('执行完成'));
  assert.ok(JSON.stringify(attachmentModelRequests.at(-1)).includes('NODE_LIBRARY_DOCUMENT_123'), 'explicit draft attachment reaches provider');
  await page.locator('#directRunMessageInput').fill('本轮不使用节点资料');
  await page.locator('#directRunSendBtn').click();
  await page.waitForFunction(() => !document.querySelector('#directRunSendBtn').disabled);
  assert.doesNotMatch(JSON.stringify(attachmentModelRequests.at(-1)), /NODE_LIBRARY_DOCUMENT_123/);
  await page.locator('#directRunMaterialsBtn').click();
  await page.locator('[data-material-select]').check();
  await page.waitForFunction(() => document.querySelector('#nodeMaterialsStatus').textContent.includes('选择已保存'));
  await page.locator('#nodeMaterialsClose').click();
  await page.locator('#directRunDialogClose').click();
  const directResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/codex/run' && r.request().method() === 'POST');
  await page.locator('[data-node-id="N1_A"] [data-action="run-direct"]').dispatchEvent('click');
  await directResponse;
  await page.waitForFunction(() => document.querySelector('#directRunDialogStatus').textContent.includes('执行完成'));
  assert.ok(JSON.stringify(attachmentModelRequests.at(-1)).includes('NODE_LIBRARY_DOCUMENT_123'), 'direct execution automatically includes enabled library');
  await page.locator('#directRunDeleteBtn').click();
  await page.waitForFunction(() => document.querySelector('#directRunConversationMeta').textContent.includes('暂无节点对话'));
  assert.equal((await (await fetch(base + '/api/node/materials' + query)).json()).materials.length, 1, 'deleting chat does not delete library');
  await page.locator('#directRunDialogClose').click();
  await page.locator('[data-node-id="N1_A"] [data-action="materials"]').dispatchEvent('click');
  await page.waitForSelector('.nodeMaterial');
  // Paste and drop both use node storage, not a running conversation.
  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], '节点图片.png', { type: 'image/png' }));
    document.querySelector('#nodeMaterialsDialog').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.nodeMaterial img');
  await page.waitForFunction(() => !document.querySelector('#nodeMaterialsAdd').disabled);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['DROP_NODE_MATERIAL'], '拖入资料.txt', { type: 'text/plain' }));
    document.querySelector('#nodeMaterialsDialog').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.nodeMaterial').length === 3 && !document.querySelector('#nodeMaterialsAdd').disabled);
  await page.screenshot({ path: path.join(source, 'artifacts/node-materials.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok((await page.locator('#nodeMaterialsDialog').boundingBox()).width <= 390);
  assert.equal(await page.locator('[data-material-select]').first().isVisible(), true);
  await page.screenshot({ path: path.join(source, 'artifacts/node-materials-mobile.png') });
  await page.locator('#nodeMaterialsClose').click();
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('[data-focus-lens-node="N1_A"]').first().click();
  await page.locator('[data-focus-lens-action="materials"]').click();
  await page.waitForSelector('.nodeMaterial');
  assert.match(await page.locator('#nodeMaterialsTitle').innerText(), /睡眠/);
  const { materials } = await (await fetch(base + '/api/node/materials' + query)).json();
  const crossNode = await fetch(base + '/api/node/materials?treeId=method&nodeId=N2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: materials[0].id }) });
  assert.equal(crossNode.status, 403);
  const crossTree = await fetch(base + '/api/node/materials?treeId=reference&nodeId=N1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: materials[0].id }) });
  assert.equal(crossTree.status, 403);
  assert.equal((await (await fetch(base + '/api/node/materials?treeId=method&nodeId=N2')).json()).materials.length, 0);
});
test('explicit local JPEG paths are sent in the first request and persist as scoped attachments without conversion', async t => {
  t.after(() => fetch(base + '/api/codex/conversation?treeId=method&nodeId=N2', { method: 'DELETE' }));
  const require = createRequire(import.meta.url);
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const bytes = createCanvas(20, 20).toBuffer('image/jpeg');
  const file = path.join(root, "Tiger'e photo.jpg");
  await writeFile(file, bytes);
  const previousCount = attachmentModelRequests.length;
  const response = await fetch(base + '/api/codex/run', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ treeId: 'method', nodeId: 'N2', progress: true, prompt: `${file}里面是什么？只回答，不改树。` }) });
  assert.equal(response.status, 202, await response.clone().text());
  const accepted = await response.json();
  let completed;
  for (let i = 0; i < 200; i++) {
    completed = (await (await fetch(base + `/api/codex/run/${accepted.id}`)).json()).run;
    if (['completed', 'failed'].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(completed.status, 'completed', completed.error);
  const request = attachmentModelRequests[previousCount];
  const user = request.messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.equal(user?.content.find(c => c.type === 'image_url')?.image_url.url, `data:image/jpeg;base64,${bytes.toString('base64')}`);
  const durable = JSON.parse(await readFile(path.join(root, '.task-tree-direct-state.json'), 'utf8'));
  assert.ok(durable.conversations.find(c => c.nodeId === 'N2').messages.find(m => m.role === 'user').attachments?.length, 'durable dialogue must retain the original image reference');
  assert.ok(!completed.events.some(e => e.toolName === 'exec_command'), 'no sips or format conversion');
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), main);
});
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'subtree-workspace-ui-'));
  await mkdir(path.join(root, 'subtrees')); await writeFile(path.join(root, 'task-tree.md'), main);
  await writeFile(path.join(root, 'subtrees/N1.md'), sub);
  await mkdir(path.join(root, 'trees'));
  await writeFile(path.join(root, 'trees/reference.md'), main);
  await writeFile(path.join(root, 'task-trees.json'), JSON.stringify({ schema: 'task-tree-registry/v1', activeMethod: 'method', trees: [
    { id: 'method', title: '方法树', role: 'method', path: 'task-tree.md' },
    { id: 'reference', title: '另一棵树', role: 'reference', path: 'trees/reference.md' }
  ] }));
  gateway = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    attachmentModelRequests.push(JSON.parse(input));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '附件内容已收到，可以继续对话。' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, [path.join(source, 'server.js')], { cwd: source,
    env: { ...process.env, CODEX_HOME: path.join(root, '.codex'), PORT: '0', TASK_TREE_PROJECT_ROOT: root, TASK_TREE_NO_OPEN: '1',
      MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let log = '', errors = '';
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + errors)), 10000);
    child.stderr.on('data', c => errors += c);
    child.stdout.on('data', c => { log += c; const m = log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once('error', reject);
  });
  const executablePath = findChromium();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
  await new Promise(resolve => gateway?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 2 });
});

test('real upload UI sends document contents, supports attachment-only messages and restores file links', async t => {
  const response = await fetch(base + '/api/codex/run', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ treeId: 'method', nodeId: 'N2', progress: true, prompt: '建立测试对话，不调用工具。' }) });
  assert.equal(response.status, 202);
  const page = await pageFor(t);
  page.setDefaultTimeout(15000);
  await page.locator('#directRunReopenBtn').click();
  await page.waitForFunction(() => !document.querySelector('#directRunSendBtn')?.disabled);
  await page.locator('#directRunFileInput').setInputFiles({ name: '测试说明.md', mimeType: 'text/markdown', buffer: Buffer.from('ATTACHMENT_UI_SENTINEL_987\n文档正文，不是文件名') });
  await page.waitForFunction(() => document.querySelector('#directRunAttachments')?.textContent.includes('已就绪'));
  await page.locator('#directRunMessageInput').fill('');
  await page.locator('#directRunSendBtn').click();
  await page.waitForFunction(() => document.querySelector('#directRunTranscript')?.querySelector('.directRunSavedAttachment'));
  await page.waitForFunction(() => !document.querySelector('#directRunSendBtn')?.disabled);
  assert.ok(attachmentModelRequests.some(r => JSON.stringify(r.messages).includes('ATTACHMENT_UI_SENTINEL_987')));
  assert.equal(await page.locator('.directRunSavedAttachment').innerText(), '▤ 测试说明.md');
  const url = await page.locator('.directRunSavedAttachment').getAttribute('href');
  assert.match(await (await fetch(base + url)).text(), /ATTACHMENT_UI_SENTINEL_987/);
  const foreign = new URL(base + url); foreign.searchParams.set('nodeId', 'ROOT');
  assert.equal((await fetch(foreign)).status, 403);
  await page.reload();
  if (await page.locator('#projectOverviewDialog').evaluate(el => el.open)) await page.locator('#projectOverviewClose').click();
  await page.locator('#directRunReopenBtn').click();
  await page.waitForSelector('.directRunSavedAttachment');
  assert.equal(await page.locator('.directRunSavedAttachment').getAttribute('href'), url);
  await page.locator('#directRunFileInput').setInputFiles({ name: '不能上传.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await page.waitForFunction(() => document.querySelector('#directRunAttachments')?.textContent.includes('不支持'));
  assert.equal(await page.locator('#directRunSendBtn').isDisabled(), true);
  await page.locator('[data-remove-attachment]').click();
  assert.equal(await page.locator('#directRunSendBtn').isDisabled(), false);
  const invalid = await fetch(base + '/api/codex/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ treeId: 'method', nodeId: 'ROOT', progress: true, prompt: '附件测试', attachments: ['bad-id'] }) });
  assert.equal(invalid.status, 400);
  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    for (const type of ['paste', 'drop']) {
      const data = new DataTransfer(); data.items.add(new File([bytes], type + '.png', { type: 'image/png' }));
      const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }) : new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
      document.querySelector('#directRunComposer').dispatchEvent(event);
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.directRunAttachmentDraft img').length === 2 && !document.querySelector('#directRunSendBtn').disabled);
  await page.route('**/api/codex/run', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'fixture submission failed' }) }));
  await page.locator('#directRunSendBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent.includes('fixture submission failed'));
  assert.equal(await page.locator('.directRunAttachmentDraft').count(), 2, 'failed submission must preserve attachments');
  await page.unroute('**/api/codex/run');
  await page.locator('#directRunSendBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.directRunSavedAttachment img').length === 2 && !document.querySelector('#directRunSendBtn').disabled);
  assert.ok(attachmentModelRequests.some(r => r.messages.some(m => Array.isArray(m.content) && m.content.filter(c => c.type === 'image_url').length === 2)));
  await page.screenshot({ path: path.join(source, 'artifacts/chat-attachments.png') });
  await page.locator('#directRunFileInput').setInputFiles({ name: '未发送.txt', mimeType: 'text/plain', buffer: Buffer.from('unsent draft') });
  await page.waitForFunction(() => document.querySelector('#directRunAttachments')?.textContent.includes('已就绪'));
  await page.locator('#directRunDeleteBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.directRunAttachmentDraft').length === 0);
  const misplaced = await fetch(base + '/api/codex/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '附件', attachments: [] }) });
  assert.equal(misplaced.status, 400, 'non-node execution must not silently ignore attachments');
});
async function pageFor(t, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 960 } });
  // These local UI tests do not exercise remote KaTeX delivery. An unavailable
  // CDN otherwise blocks DOMContentLoaded before any product behavior runs.
  await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => console.error('Fixture browser error:', error.message));
  page.setDefaultTimeout(5000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.graphNode[data-node-id="N1"]');
  if (await page.locator('#projectOverviewDialog').evaluate(el => el.open)) await page.locator('#projectOverviewClose').click();
  return page;
}
async function enter(page) {
  await page.locator('[data-node-id="N1"] [data-action="edit-subtree"]').dispatchEvent('click');
  try { await page.waitForSelector('[data-node-id="N1_A"]'); }
  catch(error) { throw new Error(error.message + '\nUI state: ' + await page.locator('#saveState').innerText()); }
  await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
}

test('subtree owns focus cache; editing its current node never changes parent focus', async t => {
  const page = await pageFor(t);
  const previous = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.includes('userGraphState'))));
  await enter(page);
  const parentBeforeEdit = await readFile(path.join(root, 'task-tree.md'), 'utf8');
  await page.locator('[data-node-id="N1_B"] [data-action="set-current"]').dispatchEvent('click');
  const current = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.includes('userGraphState'))));
  assert.ok(Object.keys(previous).length, 'fixture must capture real parent focus');
  for (const [key, value] of Object.entries(previous)) assert.equal(current[key], value, 'parent cache must stay unchanged');
  assert.ok(Object.keys(current).some(key => key.includes('subtree') && key.includes('N1.md')));
  await page.locator('#workspaceBannerExitBtn').click();
  await page.waitForSelector('[data-node-id="ROOT"]');
  assert.equal(await page.locator('[data-node-id="N1_A"]').count(), 0);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parentBeforeEdit);
});

test('folded-root lens can enter the independent subtree and navigate its children', async t => {
  const page = await pageFor(t);
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('[data-focus-lens-node="N1"]').first().click();
  await page.locator('[data-focus-lens-action="open-subtree"]').click();
  await page.waitForSelector('[data-node-id="N1_A"]');
  assert.equal(await page.locator('#focusLens').isVisible(), true);
  assert.equal(await page.locator('.focusLensNodeId').innerText(), 'N1');
  await page.locator('[data-focus-lens-node="N1_A"]').first().click();
  assert.equal(await page.locator('.focusLensNodeId').innerText(), 'N1_A');
});

test('clear one-click subtree navigation works on desktop and mobile', async t => {
  for (const width of [1440, 390]) {
    const page = await pageFor(t, width);
    const enterButton = page.locator('[data-node-id="N1"] [data-action="edit-subtree"]');
    assert.match(await enterButton.innerText(), /去到子树/);
    assert.equal(await enterButton.isVisible(), true);
    const primary = page.locator('#workspaceBannerEnterBtn');
    assert.equal(await primary.isVisible(), true);
    assert.match(await primary.innerText(), /去到子树/);
    const entryBounds = await primary.boundingBox();
    assert.ok(entryBounds.height >= 40 && entryBounds.width >= 100, 'navigation must not be another tiny icon');
    await primary.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-node-id="N1_A"]');
    const back = page.locator('#workspaceBannerExitBtn');
    await page.waitForFunction(() => document.querySelector('#workspaceBannerExitBtn')?.disabled === false);
    assert.equal(await back.isVisible(), true);
    assert.match(await back.innerText(), /返回主树/);
    const bounds = await back.boundingBox();
    assert.ok(bounds.height >= 40 && bounds.width >= 100);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'back button must remain on-screen');
    assert.equal(await back.evaluate(el => el === document.activeElement), true);
    await mkdir(path.join(source, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(source, `artifacts/subtree-navigation-${width}.png`) });
    await back.click();
    await page.waitForSelector('[data-node-id="ROOT"]');
    await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('[data-node-id="N1_A"]').count(), 0);
    await page.close();
  }
});

test('workspace transition uses short native motion, and reduced motion skips it', async t => {
  for (const reduce of [false, true]) {
    const page = await pageFor(t);
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
    const available = await page.evaluate(() => {
      window.workspaceMotionEvidence = [];
      if (!document.startViewTransition) return false;
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = callback => {
        const transition = start(callback);
        const evidence = { duration: '' };
        window.workspaceMotionEvidence.push(evidence);
        transition.ready.then(() => {
          evidence.duration = getComputedStyle(document.documentElement, '::view-transition-new(task-tree-workspace)').animationDuration;
        }).catch(() => {});
        return transition;
      };
      return true;
    });
    await enter(page);
    await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
    await page.locator('#workspaceBannerExitBtn').click();
    await page.waitForSelector('[data-node-id="ROOT"]');
    await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
    const evidence = await page.evaluate(() => window.workspaceMotionEvidence);
    if (reduce) assert.equal(evidence.length, 0, 'reduced motion must skip animations');
    else if (available) {
      assert.equal(evidence.length, 2, 'both navigation directions need an actual transition');
      for (const item of evidence) assert.ok(parseFloat(item.duration) > 0 && parseFloat(item.duration) <= 0.25);
    }
    await page.close();
  }
});

test('navigation remains usable without native view transitions', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    document.startViewTransition = undefined;
    window.workspaceFallbackDurations = [];
    const pane = document.querySelector('.graphPane');
    const animate = pane.animate.bind(pane);
    pane.animate = (frames, options) => {
      window.workspaceFallbackDurations.push(options.duration);
      return animate(frames, options);
    };
  });
  await enter(page);
  await page.locator('#workspaceBannerExitBtn').click();
  await page.waitForSelector('[data-node-id="ROOT"]');
  await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await page.evaluate(() => window.workspaceFallbackDurations), [200, 200]);
});

test('failed subtree navigation stays on parent, unlocks controls and can be retried', async t => {
  const page = await pageFor(t);
  let requests = 0;
  await page.route('**/api/subtree-file?path=*', async route => {
    requests++;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试读取失败' }) });
  });
  await page.locator('#workspaceBannerEnterBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent.includes('测试读取失败'));
  assert.equal(requests, 1);
  assert.equal(await page.locator('[data-node-id="ROOT"]').count(), 1);
  assert.equal(await page.locator('#workspaceBannerEnterBtn').isEnabled(), true);
  assert.equal(await page.locator('.graphPane').evaluate(el => el.inert), false);
  await page.unroute('**/api/subtree-file?path=*');
  await page.locator('#workspaceBannerEnterBtn').click();
  await page.waitForSelector('[data-node-id="N1_A"]');
  await page.waitForFunction(() => document.querySelector('#workspaceBanner')?.getAttribute('aria-busy') === 'false');
});

test('subtree lens edits, saves, and executes its own node; mobile uses the same editor', async t => {
  const page = await pageFor(t, 390);
  await enter(page);
  const parentBeforeEdit = await readFile(path.join(root, 'task-tree.md'), 'utf8');
  await page.locator('[data-node-id="N1_A"] [data-action="set-next"]').dispatchEvent('click');
  await page.locator('#focusLensOpenBtn').click();
  assert.equal(await page.locator('.focusLensNodeId').innerText(), 'N1_A');
  await page.locator('.focusLensNextIdeaInput').fill('子树独立执行验收');
  let request;
  await page.route('**/api/codex/run', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.locator('[data-focus-lens-action="run-agent"]').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent !== '保存中…');
  for (let i = 0; !request && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(request, 'execution request must reach HTTP consumer');
  assert.equal(request.nodeId, 'N1_A'); assert.equal(request.treeId, 'method'); assert.equal(request.progress, true);
  assert.equal(request.preset, undefined, 'must not dispatch the parent Next preset');
  assert.match(await readFile(path.join(root, 'subtrees/N1.md'), 'utf8'), /子树独立执行验收/);
  assert.match(await readFile(path.join(root, 'subtrees/N1.md'), 'utf8'), /^> Fold root: N1$/m);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parentBeforeEdit);
  assert.equal(await page.locator('.focusLensBody').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await mkdir(path.join(source, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(source, 'artifacts/subtree-independent-mobile.png') });
});

test('reload remains in the subtree, with layout, full editing and independent-window URL', async t => {
  const page = await pageFor(t);
  await enter(page);
  const parent = await readFile(path.join(root, 'task-tree.md'), 'utf8');
  assert.match(await page.locator('#workspaceBannerOpenBtn').getAttribute('href'), /subtree=subtrees%2FN1.md/);
  await page.locator('#reloadBtn').click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !document.querySelector('#saveState')?.textContent.includes('加载中'));
  assert.equal(await page.locator('[data-node-id="ROOT"]').count(), 0, 'reload must not insert parent nodes into child workspace');
  assert.equal(await page.locator('[data-node-id="N1_A"]').count(), 1);
  await page.locator('#layoutTreeBtn').click();
  await page.locator('#fitViewBtn').click();
  await page.locator('[data-node-id="N1_A"] [data-action="set-next"]').dispatchEvent('click');
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('.focusLensActionsMenu > summary').click();
  await page.locator('[data-focus-lens-action="edit-node"]').click();
  await page.locator('[data-node-id="N1_A"] [data-field="title"]').fill('睡眠细致分析');
  await page.locator('#saveBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === '已保存');
  assert.match(await readFile(path.join(root, 'subtrees/N1.md'), 'utf8'), /睡眠细致分析/);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parent);
  const versions = await (await fetch(base + '/api/subtree-file/versions?path=subtrees/N1.md')).json();
  assert.ok(versions.versions.length > 0);
  await page.screenshot({ path: path.join(source, 'artifacts/subtree-independent-desktop.png') });
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#workspaceBannerOpenBtn').click();
  const popup = await popupPromise;
  await popup.waitForSelector('[data-node-id="N1_A"]');
  assert.equal(await popup.locator('[data-node-id="ROOT"]').count(), 0);
  assert.equal(await popup.locator('#workspaceBanner').isVisible(), true);
  await popup.close();
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parent);
});

test('subtree can add and delete nodes without modifying parent nodes', async t => {
  const page = await pageFor(t);
  await enter(page);
  const parent = await readFile(path.join(root, 'task-tree.md'), 'utf8');
  const oldIds = await page.locator('.graphNode').evaluateAll(items => items.map(el => el.dataset.nodeId));
  await page.locator('[data-node-id="N1_A"] [data-action="add-node"]').dispatchEvent('click');
  const ids = await page.locator('.graphNode').evaluateAll(items => items.map(el => el.dataset.nodeId));
  const added = ids.find(id => !oldIds.includes(id));
  assert.match(added, /^N1_N\d+$/);
  await page.locator('#saveBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === '已保存');
  assert.ok((await readFile(path.join(root, 'subtrees/N1.md'), 'utf8')).includes(`## ${added} -`));
  await page.locator(`[data-node-id="${added}"] [data-action="delete"]`).dispatchEvent('click');
  await page.locator('#saveBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === '已保存');
  assert.equal(await page.locator(`[data-node-id="${added}"]`).count(), 0);
  assert.ok(!(await readFile(path.join(root, 'subtrees/N1.md'), 'utf8')).includes(`## ${added} -`));
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parent);
});

test('parent lens still saves and executes its currently viewed node', async t => {
  const page = await pageFor(t);
  await page.locator('[data-node-id="N2"] [data-action="set-next"]').dispatchEvent('click');
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('.focusLensNextIdeaInput').fill('主树透镜执行验收');
  let request;
  await page.route('**/api/codex/run', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/codex/run' && response.request().method() === 'POST');
  await page.locator('[data-focus-lens-action="run-agent"]').click();
  await received;
  assert.equal(request.nodeId, 'N2');
  assert.equal(request.preset, undefined);
  assert.match(await readFile(path.join(root, 'task-tree.md'), 'utf8'), /主树透镜执行验收/);
});

test('lens has a compact top-right direct-single-node icon on main, subtree and another tree', async t => {
  for (const mode of ['main', 'subtree', 'reference']) {
    const page = await pageFor(t, mode === 'main' ? 1440 : 390);
    let nodeId = 'ROOT', treeId = 'method';
    if (mode === 'subtree') { await enter(page); nodeId = 'N1'; }
    if (mode === 'reference') {
      treeId = 'reference';
      await page.locator('#treeSelect').selectOption(treeId);
      await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === '已加载');
    }
    await page.locator('#focusLensOpenBtn').click();
    const button = page.locator('[data-focus-lens-action="run-agent"]');
    assert.equal(await button.count(), 1);
    assert.equal(await button.isVisible(), true);
    assert.equal(await button.innerText(), '▶');
    assert.equal(await button.getAttribute('aria-label'), '直接执行此节点');
    assert.equal(await button.evaluate(el => el.closest('details') === null), true, 'must not be hidden in a menu');
    const bounds = await button.boundingBox();
    assert.ok(bounds.height <= 28 && bounds.width <= 28 && bounds.height >= 23);
    const header = await page.locator('.focusLensCenterHeader').boundingBox();
    assert.ok(Math.abs(header.x + header.width - bounds.x - bounds.width - 16) <= 2, 'icon must be at top right');
    await page.locator('.focusLensNextIdeaInput').fill(`单节点执行-${mode}`);
    let request, parallelCalls = 0;
    await page.route('**/api/codex/parallel**', async route => {
      if (route.request().method() === 'POST') parallelCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const run = { id: `single-${mode}`, treeId, nodeId, status: 'running', prompt: `单节点执行-${mode}`, output: '', events: [], progress: { label: '正在执行当前节点' } };
    await page.route('**/api/codex/run', async route => {
      request = route.request().postDataJSON();
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(run) });
    });
    await page.route(`**/api/codex/run/${run.id}`, async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: { ...run, status: 'completed', output: '本节点单独执行完毕' } }) });
    });
    await button.click();
    await page.waitForFunction(() => document.querySelector('#directRunDialog')?.open === true);
    await page.waitForFunction(() => document.querySelector('#directRunTranscript')?.textContent.includes('本节点单独执行完毕'));
    assert.equal(request.nodeId, nodeId);
    assert.equal(request.treeId, treeId);
    assert.equal(request.progress, true);
    assert.equal(request.fresh, false, 'continue the existing node conversation');
    assert.equal(request.preset, undefined);
    assert.equal(parallelCalls, 0, 'single-node action must never invoke parallel planning');
    const file = mode === 'subtree' ? 'subtrees/N1.md' : mode === 'reference' ? 'trees/reference.md' : 'task-tree.md';
    const saved = await readFile(path.join(root, file), 'utf8');
    assert.ok(saved.includes(`单节点执行-${mode}`), 'save the edited instruction before executing');
    if (mode === 'main') assert.match(saved, /^- Next: N2$/m, 'direct execution must not move global Next');
    await page.locator('#directRunDialogClose').click();
    await mkdir(path.join(source, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(source, `artifacts/focus-lens-direct-${mode}.png`) });
    await page.close();
  }
});

test('lens direct action with an empty instruction focuses editor without sending a model request', async t => {
  const page = await pageFor(t);
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('.focusLensNextIdeaInput').fill('');
  let requests = 0;
  await page.route('**/api/codex/run', async route => { requests++; await route.fulfill({ status: 200, body: '{}' }); });
  await page.locator('[data-focus-lens-action="run-agent"]').click();
  assert.equal(requests, 0);
  assert.equal(await page.locator('.focusLensNextIdeaInput').evaluate(el => el === document.activeElement), true);
  assert.match(await page.locator('#saveState').innerText(), /先写清楚/);
});

test('returning to parent waits for an in-flight autosave and saves newer child edits', async t => {
  const page = await pageFor(t);
  await enter(page);
  const parent = await readFile(path.join(root, 'task-tree.md'), 'utf8');
  await page.locator('[data-node-id="N1_A"] [data-action="set-next"]').dispatchEvent('click');
  await page.locator('#focusLensOpenBtn').click();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let first = true;
  await page.route('**/api/subtree-file', async route => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      await blocked;
    }
    await route.continue();
  });
  const saving = page.waitForRequest(req => new URL(req.url()).pathname === '/api/subtree-file' && req.method() === 'POST');
  await page.locator('.focusLensNextIdeaInput').fill('自动保存中的内容');
  await saving;
  await page.locator('.focusLensNextIdeaInput').fill('自动保存期间的最后修改');
  await page.locator('#workspaceBannerExitBtn').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await page.locator('[data-node-id="N1_A"]').count(), 1, 'switch must wait until the pending child save completes');
  release();
  await page.waitForSelector('[data-node-id="ROOT"]');
  assert.match(await readFile(path.join(root, 'subtrees/N1.md'), 'utf8'), /自动保存期间的最后修改/);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), parent);
});

test('closing a dirty subtree sends its keepalive save to the subtree, never the main tree', async t => {
  const page = await pageFor(t);
  await enter(page);
  await page.locator('[data-node-id="N1_A"] [data-action="set-next"]').dispatchEvent('click');
  await page.locator('#focusLensOpenBtn').click();
  await page.locator('.focusLensNextIdeaInput').fill('关闭前的子树修改');
  const saved = page.waitForRequest(req => ['POST', 'PUT'].includes(req.method()) && /\/api\/(tree|subtree-file)/.test(req.url()));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  const request = await saved;
  assert.equal(new URL(request.url()).pathname, '/api/subtree-file');
  assert.equal(request.method(), 'POST');
  assert.equal(request.postDataJSON().path, 'subtrees/N1.md');
  assert.match(request.postDataJSON().markdown, /^> Fold root: N1$/m);
});
