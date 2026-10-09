import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { saveAttachment, loadAttachment, materializeAttachments, MAX_ATTACHMENT_BYTES, imagePathsFromPrompt, attachPromptImages } from './chat-attachments.js';
import { serializeDialogueState, restoreDialogueState } from './dialogue-state.js';
import { startDeepSeekTurn } from './deepseek-run.js';
import http from 'node:http';

const require = createRequire(import.meta.url);
export async function docxFixture(text) {
  const JSZip = createRequire(require.resolve('mammoth'))('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
export function pdfFixture() {
  const stream = 'BT /F1 12 Tf 72 720 Td (PDF_MARKER_123) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
export function imageFixture() {
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const canvas = createCanvas(800, 180), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 180);
  context.fillStyle = '#111'; context.font = '48px sans-serif'; context.fillText('IMAGE MARKER 789', 30, 95);
  return canvas.toBuffer('image/png');
}
async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-attachments-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, treeId: 'method', nodeId: 'N1' };
}
test('literal image paths handle apostrophes, spaces, Chinese suffixes, quotes and multiple files without interpreting URLs or shell syntax', async t => {
  const scope = await fixture(t);
  const first = path.join(scope.projectRoot, "Tiger'e 图片 $(touch never).jpg");
  const second = path.join(scope.projectRoot, '另一张.png');
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const jpeg = createCanvas(10, 10).toBuffer('image/jpeg'), png = imageFixture();
  await writeFile(first, jpeg); await writeFile(second, png);
  const prompt = `请看 "${first}" 和\n${second}里面的数字。 https://example.com/not.jpg\n${second}`;
  assert.deepEqual(imagePathsFromPrompt(prompt), [first, second]);
  assert.deepEqual(imagePathsFromPrompt(`https://example.com/a.png /relative.md ./a.jpg`), []);
  assert.deepEqual(imagePathsFromPrompt(`'${first}'`), [first]);
  const refs = await attachPromptImages(prompt, scope);
  assert.equal(refs.length, 2);
  const [model] = await materializeAttachments([{ role: 'user', content: prompt, attachments: refs }], scope);
  assert.equal(model.content.filter(c => c.type === 'image_url').length, 2);
  assert.ok(model.content.some(c => c.image_url?.url === 'data:image/jpeg;base64,' + jpeg.toString('base64')));
  await rm(first); await rm(second);
  assert.equal((await materializeAttachments([{ role: 'user', content: prompt, attachments: refs }], scope))[0].content.filter(c => c.type === 'image_url').length, 2, 'stored snapshots survive removal of source files');
  assert.deepEqual(await attachPromptImages('/this-file-does-not-exist.jpg', scope), []);
});
test('text, PDF and Word reach model context in full, survive restart, retain originals privately', async t => {
  const scope = await fixture(t), full = '不截断内容\n'.repeat(20000) + 'END_MARKER_456';
  const inputs = [{ name: '../../完整.md', bytes: Buffer.from(full) }, { name: '资料.pdf', bytes: pdfFixture() }, { name: '资料.docx', bytes: await docxFixture('DOCX_MARKER_ABC') }];
  const attachments = await Promise.all(inputs.map(input => saveAttachment({ ...scope, ...input })));
  assert.equal(attachments[0].name, '完整.md');
  const durable = [{ role: 'user', content: '分析这些附件', attachments }];
  const restored = restoreDialogueState(serializeDialogueState({ conversations: [{ id: 'c', messages: durable }] }));
  assert.deepEqual(restored.conversations[0].messages, durable);
  const model = await materializeAttachments(restored.conversations[0].messages, scope);
  assert.equal(model[0].content[1].text.split('【附件：完整.md】\n')[1], full);
  assert.match(model[0].content[2].text, /PDF_MARKER_123/);
  assert.match(model[0].content[3].text, /DOCX_MARKER_ABC/);
  assert.deepEqual(await readFile((await loadAttachment({ ...scope, id: attachments[0].id })).file), inputs[0].bytes);
});
test('reject empty, unsupported, binary text, corrupt PDF, forged images, oversize and cross-node references', async t => {
  const scope = await fixture(t);
  for (const [name, bytes] of [['a.txt', Buffer.alloc(0)], ['a.exe', Buffer.from('x')], ['a.txt', Buffer.from([0,1])], ['a.pdf', Buffer.from('not PDF')], ['a.png', Buffer.from('not PNG')], ['a.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]]) {
    await assert.rejects(saveAttachment({ ...scope, name, bytes }));
  }
  const ref = await saveAttachment({ ...scope, name: 'a.txt', bytes: Buffer.from('private') });
  await assert.rejects(loadAttachment({ ...scope, nodeId: 'N2', id: ref.id }), /不属于/);
  await assert.rejects(loadAttachment({ ...scope, id: '../secret' }), /非法/);
  await assert.rejects(loadAttachment({ ...scope, treeId: 'other', id: ref.id }), /不属于/);
});
test('image payload carries original bytes and real macOS OCR, not just its name', async t => {
  const scope = await fixture(t), bytes = imageFixture();
  const ref = await saveAttachment({ ...scope, name: '标记.png', bytes });
  const { meta } = await loadAttachment({ ...scope, id: ref.id });
  if (process.platform === 'darwin') assert.match(meta.text, /IMAGE MARKER 789/);
  const [message] = await materializeAttachments([{ role: 'user', content: '看图片', attachments: [ref] }], scope);
  assert.equal(message.content.at(-1).image_url.url, 'data:image/png;base64,' + bytes.toString('base64'));
});
test('provider preserves native image input; explicit capability rejection falls back once to OCR and persists refs only', async t => {
  const scope = await fixture(t), requests = [], events = [];
  const ref = await saveAttachment({ ...scope, name: 'read.png', bytes: imageFixture() });
  const durable = [{ role: 'user', content: '看图片', attachments: [ref] }];
  const gateway = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length === 1) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'image input is not supported by this model' } })); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '已读到 IMAGE MARKER 789' }, finish_reason: 'stop' }] })); }
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  let saved;
  const result = await startDeepSeekTurn({ cwd: scope.projectRoot, messages: await materializeAttachments(durable, scope), dialogueContext: durable, waitForCompletion: true,
    environment: { MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture' },
    onNotification: event => events.push(event),
    runtimeFactory: async () => ({ systemPrompt: '', tools: [], hookSources: [], hooks: async () => ({}), saveDialogue: async (_, messages) => { saved = messages; } }) });
  assert.equal(result.status, 'completed', result.error?.message);
  assert.ok(requests[0].messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')));
  assert.ok(!JSON.stringify(requests[1]).includes('image_url'));
  assert.match(JSON.stringify(requests[1]), /IMAGE MARKER 789/);
  assert.equal(events.filter(e => e.method === 'attachment/fallback').length, 1);
  assert.deepEqual(saved[0], durable[0]);
  assert.deepEqual(result.messages[0], durable[0]);
  assert.ok(!JSON.stringify(saved).includes('data:image'));
});
