import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { saveAttachment, loadAttachment, materializeAttachments } from './chat-attachments.js';
import { listNodeMaterials, updateNodeMaterial, filterMaterialHistory, nodeMaterialContext, branchMaterialNodeIds } from './node-materials.js';
import { startDeepSeekTurn } from './deepseek-run.js';

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'node-materials-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, treeId: 'method', nodeId: 'N1' };
}
test('node library saves concurrent additions, selections, scoped references and unlink without losing originals', async t => {
  const scope = await fixture(t);
  assert.deepEqual(await listNodeMaterials(scope), []);
  const refs = await Promise.all(Array.from({ length: 8 }, (_, i) => saveAttachment({ ...scope, name: `${i}.txt`, bytes: Buffer.from(`资料${i}`) })));
  await Promise.all(refs.map(ref => updateNodeMaterial(scope, { action: 'add', id: ref.id })));
  assert.equal((await listNodeMaterials(scope)).length, 8);
  await updateNodeMaterial(scope, { action: 'add', id: refs[0].id });
  assert.equal((await listNodeMaterials(scope)).length, 8, 'idempotent add');
  await updateNodeMaterial(scope, { action: 'select', id: refs[0].id, enabled: false });
  assert.equal((await listNodeMaterials(scope)).find(r => r.id === refs[0].id).enabled, false, 'fresh manifest read retains selection');
  for (const other of [{ nodeId: 'N2' }, { treeId: 'reference' }]) {
    await assert.rejects(updateNodeMaterial({ ...scope, ...other }, { action: 'add', id: refs[0].id }), /不属于/);
    assert.deepEqual(await listNodeMaterials({ ...scope, ...other }), []);
  }
  await assert.rejects(updateNodeMaterial(scope, { action: 'select', id: refs[1].id, enabled: 'false' }), /布尔/);
  await assert.rejects(updateNodeMaterial(scope, { action: 'select', id: refs[1].id }), /布尔/);
  await updateNodeMaterial(scope, { action: 'remove', id: refs[0].id });
  assert.equal((await listNodeMaterials(scope)).length, 7);
  assert.equal(await readFile((await loadAttachment({ ...scope, id: refs[0].id })).file, 'utf8'), '资料0');
});
test('selected full documents and original images are isolated by node and support an explicit single-turn override', async t => {
  const scope = await fixture(t), full = '不截断正文\n'.repeat(20000) + 'END_DOCUMENT';
  const a = await saveAttachment({ ...scope, name: '文档.md', bytes: Buffer.from(full) });
  const b = await saveAttachment({ ...scope, name: '禁用.txt', bytes: Buffer.from('DISABLED_MARKER') });
  const c = await saveAttachment({ ...scope, nodeId: 'N2', name: '兄弟.txt', bytes: Buffer.from('SIBLING_ONLY') });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const image = await saveAttachment({ ...scope, name: '原图.png', bytes });
  await Promise.all([a, image].map(ref => updateNodeMaterial(scope, { action: 'add', id: ref.id })));
  await updateNodeMaterial(scope, { action: 'add', id: b.id, enabled: false });
  await updateNodeMaterial({ ...scope, nodeId: 'N2' }, { action: 'add', id: c.id });
  const context = await nodeMaterialContext({ ...scope, nodeIds: ['N1', 'N1'] });
  assert.equal(context.length, 1);
  assert.ok(context[0].content.some(c => c.text?.endsWith(full)));
  assert.equal(context[0].content.find(c => c.type === 'image_url').image_url.url, 'data:image/png;base64,' + bytes.toString('base64'));
  assert.doesNotMatch(JSON.stringify(context), /DISABLED_MARKER|SIBLING_ONLY/);
  const history = [{ role: 'user', content: '之前的对话', attachments: [a, b] }, { role: 'assistant', content: '旧文字不抹除' }];
  const materials = await listNodeMaterials(scope);
  const filtered = filterMaterialHistory(history, materials, []);
  assert.equal(filtered[0].attachments.length, 0); assert.equal(history[0].attachments.length, 2);
  const repeated = filterMaterialHistory([...history, { role: 'user', content: '再次使用', attachments: [a] }], materials, [a.id]);
  assert.equal(repeated[0].attachments.length, 0);
  assert.equal(repeated.at(-1).attachments.length, 1, 'selected original reaches model once, not once per historical turn');
  const explicit = await materializeAttachments(filterMaterialHistory(history, materials, [b.id]), scope);
  assert.match(JSON.stringify(explicit), /DISABLED_MARKER/); assert.doesNotMatch(JSON.stringify(explicit), /END_DOCUMENT/);
});
test('planner indexes selected branch including folded children, never unrelated folded siblings', async t => {
  const scope = await fixture(t);
  await mkdir(path.join(scope.projectRoot, 'subtrees'));
  await writeFile(path.join(scope.projectRoot, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 根\n## N1 - 分支\n- SubtreeFile: subtrees/N1.md\n## N2 - 无关\n- SubtreeFile: subtrees/DO_NOT_READ.md\n# Edges\n## E1 - 分支\n- Endpoints: ROOT, N1\n## E2 - 分支\n- Endpoints: ROOT, N2\n');
  await writeFile(path.join(scope.projectRoot, 'subtrees/N1.md'), '# LLM Task Graph\n## N1 - 根\n## N1_A - 子节点\n# Edges\n## E1 - 子\n- Endpoints: N1, N1_A\n');
  assert.deepEqual(await branchMaterialNodeIds({ ...scope, nodeId: 'N1' }), ['N1', 'N1_A']);
});
test('ephemeral parallel materials preserve resumed dialogue, reach the provider and never persist full payloads', async t => {
  const scope = await fixture(t), requests = [], saves = [];
  const ref = await saveAttachment({ ...scope, name: '资料.txt', bytes: Buffer.from('EPHEMERAL_MATERIAL') });
  await updateNodeMaterial(scope, { action: 'add', id: ref.id });
  const contextMessages = await nodeMaterialContext({ ...scope, nodeIds: ['N1'] });
  const gateway = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '新回复' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const result = await startDeepSeekTurn({ cwd: scope.projectRoot, prompt: '续接请求', threadId: 'deepseek-existing', contextMessages, waitForCompletion: true,
    environment: { MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture' },
    runtimeFactory: async () => ({ systemPrompt: '', tools: [], hookSources: [], hooks: async () => ({}), loadDialogue: async () => [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回复' }], saveDialogue: async (_, history) => saves.push(history) }) });
  assert.equal(result.status, 'completed', result.error?.message);
  assert.deepEqual(requests[0].messages.filter(m => typeof m.content === 'string' && m.role !== 'system').slice(0, 3).map(m => m.content), ['旧问题', '旧回复', '续接请求']);
  assert.match(JSON.stringify(requests[0]), /EPHEMERAL_MATERIAL/);
  assert.doesNotMatch(JSON.stringify(saves), /EPHEMERAL_MATERIAL/);
});
