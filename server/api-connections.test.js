import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { connectionDefaults, createApiConnectionsStore, normalizeApiBaseUrl, discoverModels, resolveGlobalEnvFile } from './api-connections.js';
import { loadDeepSeekConfig } from './deepseek-run.js';

test('three independent APIs, shared credentials, per-consumer models and masked keys survive reload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-connections-'));
  const file = path.join(dir, 'api-connections.json');
  const defaults = () => connectionDefaults({ MODEL_AGENT_MAIN_API_KEY: 'env-secret', MODEL_AGENT_MAIN_BASE_URL: 'http://localhost:1/v1', MODEL_AGENT_MAIN_MODEL: 'env-model' });
  const store = createApiConnectionsStore({ file, getDefaults: defaults, fetchImpl: async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer execution-secret');
    assert.equal(url, 'http://localhost:2/v1/models');
    return Response.json({ data: [{ id: 'chat-b' }, { id: 'chat-a' }, { id: 'chat-a' }] });
  } });
  await store.save({ execution: { baseUrl: 'http://localhost:2', apiKey: 'execution-secret', model: 'chat-a' },
    collaboration: { reuseExecution: true, model: 'chat-b', selectedModels: ['chat-a', 'chat-b'] },
    knowledge: { reuseExecution: false, baseUrl: 'http://localhost:3/v1', apiKey: 'knowledge-secret', model: 'knowledge-chat', embeddingModel: 'vectors' } });
  const result = await store.models('collaboration');
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['chat-a', 'chat-b']);
  assert.doesNotMatch(JSON.stringify(result), /execution-secret|knowledge-secret|env-secret/);
  assert.equal((await store.resolve('collaboration')).apiKey, 'execution-secret');
  assert.equal((await store.resolve('collaboration')).model, 'chat-b');
  assert.equal((await store.resolve('knowledge')).apiKey, 'knowledge-secret');
  assert.equal((await store.resolve('knowledge')).embeddingModel, 'vectors');
  await store.save({ execution: { apiKey: '', model: 'chat-b' } });
  assert.equal((await store.resolve('execution')).apiKey, 'execution-secret');
  const reload = createApiConnectionsStore({ file, getDefaults: defaults });
  await Promise.all([store.save({ collaboration: { model: 'concurrent-chat' } }), reload.save({ knowledge: { embeddingModel: 'concurrent-vectors' } })]);
  assert.equal((await reload.resolve('collaboration')).model, 'concurrent-chat');
  assert.equal((await reload.resolve('knowledge')).embeddingModel, 'concurrent-vectors');
  await store.save({ knowledge: { embeddingModel: 'vectors' } });
  assert.equal((await reload.resolve('execution')).model, 'chat-b');
  const runtime = loadDeepSeekConfig(dir, { environment: { TASK_TREE_API_CONNECTIONS_FILE: file } });
  assert.equal(runtime.baseUrl, 'http://localhost:2/v1');
  assert.equal(runtime.apiKey, 'execution-secret');
  assert.equal(runtime.model, 'chat-b');
  assert.deepEqual(runtime.baseUrls, ['http://localhost:2/v1']);
  assert.deepEqual(runtime.fallbackModels, []);
  assert.equal(loadDeepSeekConfig(dir, { role: 'planner', environment: { TASK_TREE_API_CONNECTIONS_FILE: file } }).model, 'chat-b');
  const separate = loadDeepSeekConfig(dir, { model: 'knowledge-chat', environment: { TASK_TREE_API_CONNECTIONS_FILE: file,
    MODEL_AGENT_MAIN_BASE_URL: 'http://localhost:3/v1', MODEL_AGENT_MAIN_API_KEY: 'knowledge-secret' } });
  assert.equal(separate.baseUrl, 'http://localhost:3/v1');
  await store.save({ knowledge: { reuseExecution: true } });
  assert.equal((await store.resolve('knowledge')).apiKey, 'execution-secret');
  assert.equal((await store.resolve('knowledge')).embeddingModel, 'vectors');
  await store.save({ execution: { clearKey: true } });
  assert.equal((await store.get()).execution.effective.hasApiKey, false);
});

test('saving a new key is immediately used by the next model-list request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-key-immediate-models-'));
  const file = path.join(dir, 'api-connections.json');
  const calls = [];
  const store = createApiConnectionsStore({ file, fetchImpl: async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    return Response.json({ data: [{ id: 'glm-5.3' }] });
  } });
  const saved = await store.save({ execution: { baseUrl: 'https://gateway.example/v1', apiKey: 'new-ui-key', model: 'glm-5.3' } });
  assert.equal(saved.execution.hasApiKey, true);
  const result = await store.models('execution');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: 'https://gateway.example/v1/models', authorization: 'Bearer new-ui-key' }]);
  assert.equal((await store.get()).execution.effective.hasApiKey, true);
});

test('list failures are visible without secrets; bad types and stale lists are rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-connection-errors-'));
  const file = path.join(dir, 'settings.json');
  const store = createApiConnectionsStore({ file, fetchImpl: async () => new Response('SECRET', { status: 502 }) });
  await store.save({ execution: { baseUrl: 'https://example.com', apiKey: 'SECRET' } });
  const failure = await store.models('execution');
  assert.equal(failure.ok, false);
  assert.match(failure.error, /HTTP 502/);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
  await assert.rejects(store.save({ execution: { selectedModels: 'not-array' } }), /数组/);
  await assert.rejects(store.save({ execution: { reuseExecution: 'true' } }), /布尔/);
  await assert.rejects(store.save({ execution: { baseUrl: 'https://user:password@example.com' } }));
  await assert.rejects(store.models('invalid'), /未知/);
  await store.save({ execution: { clearKey: true } });
  assert.match((await store.models('execution')).error, /API Key/);
  await assert.rejects(discoverModels({ baseUrl: 'https://example.com/v1', apiKey: 'x' }, { fetchImpl: async () => Response.json({ html: 'bad' }) }), /data/);
  assert.equal(normalizeApiBaseUrl('https://example.com/'), 'https://example.com/v1');
  assert.equal(normalizeApiBaseUrl('https://example.com/custom/'), 'https://example.com/custom');
  let release;
  const slow = createApiConnectionsStore({ file, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  await slow.save({ execution: { apiKey: 'new-key' } });
  const fetching = slow.models('execution');
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await slow.save({ execution: { baseUrl: 'https://different.example/v1' } });
  release(Response.json({ data: [{ id: 'old-result' }] }));
  await assert.rejects(fetching, /配置已改变/);
  assert.deepEqual((await slow.get()).execution.effective.models, []);
  // Corrupt persistence must not silently restore the old credentials.
  await writeFile(file, '{bad');
  await assert.rejects(slow.get());
  assert.equal(await readFile(file, 'utf8'), '{bad');
});

test('shared configuration fallback chooses the owning project env instead of a nested checkout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-global-owner-'));
  const kit = path.join(dir, 'project', 'runtime');
  await mkdir(kit, { recursive: true });
  await writeFile(path.join(kit, 'api-connections.json'), '{}');
  await writeFile(path.join(dir, 'project', '.env'), 'MODEL_AGENT_MAIN_MODEL=glm-5.3\n');
  assert.equal(resolveGlobalEnvFile(kit), path.join(dir, 'project', '.env'));
  assert.equal(resolveGlobalEnvFile(kit, { TASK_TREE_GLOBAL_ENV_FILE: path.join(dir, 'explicit.env') }), path.join(dir, 'explicit.env'));
});
