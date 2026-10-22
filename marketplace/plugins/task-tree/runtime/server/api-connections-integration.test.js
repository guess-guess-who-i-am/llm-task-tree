import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

test('real HTTP routes, model consumers, node execution, embeddings and browser settings use the three connections', { timeout: 120000 }, async t => {
  const source = path.resolve(import.meta.dirname, '..');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'api-settings-e2e-'));
  const file = path.join(cwd, 'api-connections.json');
  await mkdir(path.join(cwd, 'knowledge'));
  await mkdir(path.join(cwd, 'codex'));
  await writeFile(path.join(cwd, 'knowledge', 'guide.md'), '# 设置指南\n\n配置三个独立的 API，节点执行、一起想及知识库模型分别使用对应配置。');
  await writeFile(path.join(cwd, 'task-tree.md'), '# LLM Task Graph\n## ROOT - API 配置测试\n- Problem: 验证 API\n- NextIdea: 回答配置已生效\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: ['chat-a', 'chat-b', 'vectors'].map(id => ({ id })) }));
    if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
    if (body.tool_choice === 'required' && body.tools?.some(t => t.function.name === 'task_tree_continue_single')) {
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'mode', type: 'function', function: { name: 'task_tree_continue_single', arguments: JSON.stringify({ reason: '只读配置回归，无独立交付分支', nextCheckpoint: '返回配置结果' }) } }] } }] }));
    }
    if (body.tools?.some(t => t.function.name === 'completion_review_submit')) {
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'review', type: 'function', function: { name: 'completion_review_submit', arguments: JSON.stringify({ verdict: 'pass', reason: '已核对只读配置结果', evidence: ['配置路由请求已记录'] }) } }] } }] }));
    }
    const content = JSON.stringify(body.messages);
    const text = content.includes('【功能验收】') ? '{"verdict":"pass","reason":"已核对"}' : '配置已生效。';
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.js')], { cwd: source,
    env: { ...process.env, PORT: '0', TASK_TREE_PROJECT_ROOT: cwd, TASK_TREE_GLOBAL_ENV_FILE: path.join(cwd, '.env'),
      TASK_TREE_API_CONNECTIONS_FILE: file, TASK_TREE_NO_OPEN: '1', CODEX_HOME: path.join(cwd, 'codex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => provider.close(resolve)); });
  const baseUrl = await new Promise((resolve, reject) => {
    let log = '', errors = '';
    const timer = setTimeout(() => reject(new Error('startup timeout ' + errors)), 10000);
    child.stderr.on('data', c => errors += c);
    child.stdout.on('data', c => { log += c; const match = log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', reject);
  });
  async function api(route, body, method = 'POST') {
    const response = await fetch(baseUrl + route, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  }
  const config = Object.fromEntries(['execution', 'collaboration', 'knowledge'].map(kind => [kind, {
    baseUrl: `${endpoint}/${kind}/v1`, apiKey: `${kind}-secret`, reuseExecution: false,
    model: kind === 'execution' ? 'chat-a' : 'chat-b', ...(kind === 'knowledge' ? { embeddingModel: 'vectors' } : {})
  }]));
  await api('/api/api-connections', { connections: { execution: config.execution } }, 'PUT');
  const sharedAgents = (await api('/api/model-agents')).models;
  assert.equal(sharedAgents[0].model, 'chat-a');
  assert.equal(sharedAgents[0].baseUrl, config.execution.baseUrl);
  assert.equal((await api('/api/knowledge/config')).config.chat.model, 'chat-a');
  await api('/api/api-connections', { connections: config }, 'PUT');
  const lists = await Promise.all(['execution', 'collaboration', 'knowledge'].map(kind => api('/api/api-connections/models', { kind })));
  assert(lists.every(result => result.ok && result.models.length === 3));
  assert.doesNotMatch(JSON.stringify(await api('/api/api-connections')), /secret/);
  const agents = (await api('/api/model-agents')).models;
  assert.equal(agents[0].model, 'chat-b');
  assert.equal(agents[0].baseUrl, config.collaboration.baseUrl);
  const together = await api('/api/model-agents/run', { nodeId: 'ROOT', treeId: 'method', question: '简短回答', modelIds: [agents[0].id], useKnowledgeSearch: false, includeWeb: false });
  assert.equal(together.results[0].ok, true, JSON.stringify(together));
  const knowledge = await api('/api/knowledge/config');
  assert.equal(knowledge.config.embedding.model, 'vectors');
  assert.equal(knowledge.config.embedding.baseUrl, config.knowledge.baseUrl);
  assert.equal(knowledge.config.chat.model, 'chat-b');
  await api('/api/knowledge/ask', { question: '设置指南是什么', includeKnowledge: false, includeWeb: false, useLlmQuery: false });
  await api('/api/knowledge/reindex', {});
  let status;
  for (let i = 0; i < 200; i++) {
    status = await api('/api/knowledge/reindex-status');
    if (!status.job?.running && !status.running) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(calls.some(c => c.url.endsWith('/knowledge/v1/embeddings') && c.body.model === 'vectors'), JSON.stringify(status));
  const accepted = await api('/api/codex/run', { progress: true, nodeId: 'ROOT', treeId: 'method', prompt: '只回复：配置已生效。不要修改文件' });
  let run;
  for (let i = 0; i < 1000; i++) {
    run = (await api('/api/codex/run/' + accepted.id)).run;
    if (!['starting', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.status, 'completed', run.error);
  for (const kind of ['execution', 'collaboration', 'knowledge']) {
    const matching = calls.filter(c => c.url.endsWith(`/${kind}/v1/chat/completions`));
    assert(matching.length, kind + ' did not make a real model call');
    assert(matching.every(c => c.authorization === `${'Bearer '}${kind}-secret` && c.body.model === config[kind].model), kind + ' routed incorrectly');
  }
  const require = createRequire(import.meta.url);
  let repositoryRoot = source;
  while (!existsSync(path.join(repositoryRoot, 'prototype/swimlane-view/node_modules/playwright')) && path.dirname(repositoryRoot) !== repositoryRoot) repositoryRoot = path.dirname(repositoryRoot);
  const { chromium } = require(path.join(repositoryRoot, 'prototype/swimlane-view/node_modules/playwright'));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('#topbarMoreBtn').click();
  await page.locator('#apiConnectionsBtn').click();
  await page.locator('[data-api-kind="execution"] [data-api-save]').waitFor();
  assert.equal(await page.locator('dialog fieldset').count(), 3);
  assert.equal(await page.locator('[data-api-kind="execution"] [data-field="apiKey"]').inputValue(), '');
  assert.equal(await page.locator('[data-api-kind="execution"] [data-field="model"] option').count(), 4);
  await page.locator('[data-api-kind="execution"] [data-api-save]').click();
  await page.getByText('配置已保存，模型列表已更新。请选择需要的模型；选择后自动保存。', { exact: true }).waitFor();
  await page.locator('[data-api-kind="execution"] [data-field="model"]').selectOption('chat-b');
  await page.getByText('模型选择已保存，将用于下一次请求。', { exact: true }).waitFor();
  assert.equal((await api('/api/api-connections')).connections.execution.model, 'chat-b');
  await page.locator('[data-api-kind="collaboration"] [data-field="reuseExecution"]').check();
  await page.locator('[data-api-kind="collaboration"] [data-api-save]').click();
  await page.getByText('配置已保存，模型列表已更新。请选择需要的模型；选择后自动保存。', { exact: true }).waitFor();
  assert.equal((await api('/api/api-connections')).connections.collaboration.effective.baseUrl, config.execution.baseUrl);
  await page.locator('.apiConnectionsDialog').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: path.join(repositoryRoot, 'artifacts/api-connections-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('.apiConnectionsDialog').evaluate(el => el.getBoundingClientRect().width <= window.innerWidth));
  await page.screenshot({ path: path.join(repositoryRoot, 'artifacts/api-connections-mobile.png') });
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).execution.model, 'chat-b');
});
