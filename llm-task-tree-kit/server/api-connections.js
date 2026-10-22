import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename, rmdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const API_CONNECTION_KINDS = ['execution', 'collaboration', 'knowledge'];

// A standalone kit is commonly nested inside the project that owns the shared
// .env and api-connections.json. Keep the fallback deterministic, but prefer
// the nearest existing owner so a source checkout's stale local file cannot
// shadow the public configuration used by every project.
export function resolveGlobalEnvFile(moduleRoot, environment = process.env) {
  const explicit = String(environment.TASK_TREE_GLOBAL_ENV_FILE || '').trim();
  if (explicit) return path.resolve(explicit);
  const root = path.resolve(moduleRoot || process.cwd());
  const directories = [root, path.join(root, '..'), path.join(root, '..', '..')].map(file => path.resolve(file));
  // Prefer a real .env owner. A checkout may contain a stale local
  // api-connections.json while the shared .env and its API file live one level
  // above; choosing the stale file was the source of the post-save "missing
  // API Key" report.
  const envDirectory = directories.find(directory => existsSync(path.join(directory, '.env')));
  if (envDirectory) return path.join(envDirectory, '.env');
  const apiDirectory = directories.find(directory => existsSync(path.join(directory, 'api-connections.json')));
  return path.join(apiDirectory || directories[0], '.env');
}

export function apiConnectionsFile(globalEnvFile, environment = process.env) {
  return environment.TASK_TREE_API_CONNECTIONS_FILE || path.join(path.dirname(path.resolve(globalEnvFile)), 'api-connections.json');
}

export function normalizeApiBaseUrl(value) {
  if (!String(value || '').trim()) return '';
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 必须是 HTTP/HTTPS API 地址，不能包含密钥、查询参数或片段');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/+$/, '');
}

export function connectionDefaults(env = {}) {
  const execution = {
    baseUrl: env.MODEL_AGENT_MAIN_BASE_URL || '', apiKey: env.MODEL_AGENT_MAIN_API_KEY || '',
    model: env.MODEL_AGENT_MAIN_MODEL || 'glm-5.3', reuseExecution: false,
    models: [], checkedAt: '', error: ''
  };
  return {
    execution,
    collaboration: { ...execution, reuseExecution: true },
    knowledge: { ...execution, reuseExecution: !(env.KNOWLEDGE_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL),
      baseUrl: env.KNOWLEDGE_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL || execution.baseUrl,
      apiKey: env.KNOWLEDGE_EMBEDDING_API_KEY || env.EMBEDDING_API_KEY || execution.apiKey,
      embeddingModel: env.KNOWLEDGE_EMBEDDING_MODEL || env.EMBEDDING_MODEL || '' }
  };
}

export function readApiConnections(file, defaults = connectionDefaults()) {
  let saved = {};
  if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8'));
  const config = Object.fromEntries(API_CONNECTION_KINDS.map(kind => [kind, { ...defaults[kind], ...saved[kind] }]));
  for (const kind of ['collaboration', 'knowledge']) {
    if (!saved[kind] && config[kind].reuseExecution) config[kind].model = config.execution.model;
  }
  return config;
}

// Credentials may be shared, but model choices belong to each consumer.
export function resolveApiConnection(config, kind) {
  if (!API_CONNECTION_KINDS.includes(kind)) throw new Error('未知 API 配置类型');
  const own = config[kind];
  const credentials = kind !== 'execution' && own.reuseExecution ? config.execution : own;
  return { ...own, baseUrl: credentials.baseUrl, apiKey: credentials.apiKey,
    model: own.model || credentials.model, models: credentials.models || [],
    checkedAt: credentials.checkedAt || '', error: credentials.error || '' };
}

export function publicApiConnections(config) {
  return Object.fromEntries(API_CONNECTION_KINDS.map(kind => {
    const { apiKey, ...own } = config[kind];
    const effective = resolveApiConnection(config, kind);
    return [kind, { ...own, hasApiKey: Boolean(apiKey), effective: {
      baseUrl: effective.baseUrl, hasApiKey: Boolean(effective.apiKey), model: effective.model,
      embeddingModel: effective.embeddingModel || '', models: effective.models,
      checkedAt: effective.checkedAt, error: effective.error
    } }];
  }));
}

export function configuredConnection(file, kind, defaults = connectionDefaults()) {
  if (!existsSync(file)) return null;
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  // A default shared consumer must follow the saved execution connection, exactly as
  // displayed in the settings UI. A separately configured consumer remains independent.
  if (!saved[kind] && !(kind !== 'execution' && saved.execution && defaults[kind]?.reuseExecution)) return null;
  return resolveApiConnection(readApiConnections(file, defaults), kind);
}

export async function discoverModels(connection, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!connection.baseUrl) throw new Error('请先填写 Base URL');
  if (!connection.apiKey) throw new Error('请先填写 API Key');
  const baseUrl = normalizeApiBaseUrl(connection.baseUrl);
  const response = await fetchImpl(baseUrl + '/models', {
    headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
  });
  if (!response.ok) throw new Error(`模型列表请求失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error('网关没有返回 OpenAI 兼容的模型列表（data 数组）');
  return [...new Set(data.data.map(item => typeof item === 'string' ? item : item?.id)
    .filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))].sort();
}

export function createApiConnectionsStore({ file, getDefaults = () => connectionDefaults(), fetchImpl = fetch }) {
  let pending = Promise.resolve();
  const locked = action => {
    const result = pending.then(async () => {
      // Multiple IDE servers share this file; a per-process queue alone loses updates.
      await mkdir(path.dirname(file), { recursive: true });
      const lock = file + '.lock';
      const deadline = Date.now() + 10000;
      while (true) {
        try { await mkdir(lock); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const info = await stat(lock).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 30000) await rmdir(lock).catch(() => {});
          if (Date.now() >= deadline) throw new Error('公共 API 配置正在被其它 IDE 保存，请重试');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      try { return await action(); }
      finally { await rmdir(lock); }
    });
    pending = result.catch(() => {});
    return result;
  };
  const load = async () => readApiConnections(file, await getDefaults());
  const persist = async (config, touched) => {
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const kinds = new Set([...Object.keys(previous), ...touched]);
    const explicit = Object.fromEntries(API_CONNECTION_KINDS.filter(kind => kinds.has(kind)).map(kind => [kind, config[kind]]));
    await mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(explicit, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
  };
  const fingerprint = item => JSON.stringify([item.baseUrl, item.apiKey]);
  return {
    file,
    async get() { return publicApiConnections(await load()); },
    async resolve(kind) { return resolveApiConnection(await load(), kind); },
    save(input) {
      return locked(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
        const config = await load();
        for (const kind of API_CONNECTION_KINDS) {
          if (input[kind] === undefined) continue;
          const patch = input[kind];
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('API 配置必须是对象');
          const before = fingerprint(config[kind]);
          for (const field of ['baseUrl', 'apiKey', 'model', 'embeddingModel']) {
            if (patch[field] === undefined) continue;
            if (typeof patch[field] !== 'string') throw new Error(`${field} 必须是字符串`);
            // A blank masked input means keep the saved key; explicit clearKey removes it.
            if (field === 'apiKey' && !patch[field].trim()) continue;
            config[kind][field] = field === 'baseUrl' ? normalizeApiBaseUrl(patch[field]) : patch[field].trim();
          }
          if (patch.clearKey === true) config[kind].apiKey = '';
          if (patch.reuseExecution !== undefined) {
            if (typeof patch.reuseExecution !== 'boolean') throw new Error('reuseExecution 必须是布尔值');
            config[kind].reuseExecution = kind !== 'execution' && patch.reuseExecution;
          }
          if (patch.selectedModels !== undefined) {
            if (!Array.isArray(patch.selectedModels) || patch.selectedModels.some(m => typeof m !== 'string')) throw new Error('selectedModels 必须是字符串数组');
            config[kind].selectedModels = [...new Set(patch.selectedModels.map(m => m.trim()).filter(Boolean))];
          }
          if (before !== fingerprint(config[kind])) Object.assign(config[kind], { models: [], error: '', checkedAt: '' });
        }
        await persist(config, Object.keys(input));
        return publicApiConnections(config);
      });
    },
    async models(kind) {
      const config = await load();
      const connection = resolveApiConnection(config, kind);
      let models = [], error = '';
      try { models = await discoverModels(connection, { fetchImpl }); }
      catch (failure) {
        // Never forward arbitrary gateway bodies/URLs, which may echo a credential.
        error = /^(请先|模型列表|网关没有)/.test(failure.message) ? failure.message : '模型列表连接失败或超时，请检查 API 地址及网络';
      }
      return locked(async () => {
        const latest = await load();
        const current = resolveApiConnection(latest, kind);
        if (fingerprint(current) !== fingerprint(connection)) throw new Error('配置已改变，请重新加载模型列表');
        const owner = kind !== 'execution' && latest[kind].reuseExecution ? 'execution' : kind;
        Object.assign(latest[owner], { models, error, checkedAt: new Date().toISOString() });
        await persist(latest, [owner]);
        return { ok: !error, models, error, connections: publicApiConnections(latest) };
      });
    }
  };
}
