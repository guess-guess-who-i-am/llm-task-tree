import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kitDir = __dirname;

function loadTaskTreeConfig(baseDir) {
  const configFile = path.join(baseDir, "task-tree.config.json");
  const defaults = { projectRoot: ".", kitDir: "." };
  if (!existsSync(configFile)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(configFile, "utf8")) };
  } catch {
    return defaults;
  }
}

function resolveProjectRoot(baseDir, config) {
  const raw = String(config.projectRoot || ".").trim() || ".";
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
}

const taskTreeConfig = loadTaskTreeConfig(kitDir);
const projectRoot = resolveProjectRoot(kitDir, taskTreeConfig);
const publicDir = path.join(kitDir, "public");
const treeFile = path.join(projectRoot, "task-tree.md");
const versionsDir = path.join(projectRoot, "versions");
const modelAgentsFile = path.join(projectRoot, "model-agents.json");
const modelHistoryFile = path.join(projectRoot, "model-agent-history.json");
const modelAgentsDir = path.join(projectRoot, "model-agents");
const knowledgeConfigFile = path.join(projectRoot, "knowledge-config.json");
const knowledgeIndexFile = path.join(projectRoot, "knowledge-index.json");
const webSearchConfigFile = path.join(projectRoot, "web-search-config.json");
const envFile = path.join(projectRoot, ".env");
const openWebSearchDir = path.join(kitDir, "open-webSearch");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const execFileAsync = promisify(execFile);
let skillIndexCache = null;
const homeDir = process.env.USERPROFILE || process.env.HOME || "";
let knowledgeReindexJob = {
  running: false,
  stage: "idle",
  message: "",
  error: "",
  startedAt: "",
  finishedAt: "",
  totalFiles: 0,
  processedFiles: 0,
  totalChunks: 0,
  embeddedChunks: 0,
  percent: 0
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function jsonResponse(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function isoNow() {
  return new Date().toISOString();
}

function safeModelId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 48);
}

function sanitizeGraphId(value) {
  return String(value || "").trim().replace(/\s+/g, "_").replace(/[^\w-]/g, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl, suffix) {
  return `${normalizeBaseUrl(baseUrl)}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadLocalEnv() {
  if (!existsSync(envFile)) return {};
  return parseEnvText(await readFile(envFile, "utf8"));
}

function envKeySegment(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function envBool(value, fallback = true) {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function defaultKnowledgeConfig() {
  return {
    docsDir: "knowledge",
    embedding: {
      baseUrl: "",
      apiKey: "",
      model: "",
      wireApi: "openai"
    },
    chat: {
      modelId: ""
    },
    chunk: {
      maxChars: 1600,
      overlapChars: 200
    }
  };
}

function defaultWebSearchConfig() {
  return {
    provider: "",
    apiKey: "",
    baseUrl: "",
    enabled: false,
    maxResults: 5
  };
}

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function resolveWorkspacePath(value, fallbackRelative) {
  const raw = String(value || fallbackRelative || "").trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
  const root = path.resolve(projectRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function loadKnowledgeConfig({ includeKey = false } = {}) {
  const defaults = defaultKnowledgeConfig();
  const env = await loadLocalEnv();
  const saved = await readJsonFile(knowledgeConfigFile, defaults);
  const embedding = { ...defaults.embedding, ...(saved.embedding || {}) };
  const config = {
    ...defaults,
    ...saved,
    embedding,
    chat: { ...defaults.chat, ...(saved.chat || {}) },
    chunk: { ...defaults.chunk, ...(saved.chunk || {}) }
  };
  config.docsDir = String(env.KNOWLEDGE_DOCS_DIR || config.docsDir || defaults.docsDir);
  config.embedding.baseUrl = normalizeBaseUrl(env.KNOWLEDGE_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL || config.embedding.baseUrl || config.embedding.base_url);
  const envEmbeddingKey = env.KNOWLEDGE_EMBEDDING_API_KEY || env.EMBEDDING_API_KEY;
  const savedEmbeddingKey = saved.embedding?.apiKey || saved.embedding?.api_key;
  config.embedding.apiKey = includeKey ? String(envEmbeddingKey || savedEmbeddingKey || "") : "";
  config.embedding.hasApiKey = Boolean(envEmbeddingKey || savedEmbeddingKey);
  config.embedding.model = String(env.KNOWLEDGE_EMBEDDING_MODEL || env.EMBEDDING_MODEL || config.embedding.model || "");
  config.chat.modelId = String(env.KNOWLEDGE_CHAT_MODEL_ID || config.chat.modelId || "");
  config.chunk.maxChars = Math.max(400, Math.min(6000, Number(config.chunk.maxChars) || defaults.chunk.maxChars));
  config.chunk.overlapChars = Math.max(0, Math.min(1000, Number(config.chunk.overlapChars) || defaults.chunk.overlapChars));
  return config;
}

async function saveKnowledgeConfig(input) {
  const existing = await loadKnowledgeConfig({ includeKey: true });
  const incomingEmbedding = input?.embedding || {};
  const config = {
    ...defaultKnowledgeConfig(),
    docsDir: String(input?.docsDir || existing.docsDir || "knowledge").trim() || "knowledge",
    embedding: {
      baseUrl: normalizeBaseUrl(incomingEmbedding.baseUrl || incomingEmbedding.base_url || existing.embedding.baseUrl),
      apiKey: String(incomingEmbedding.apiKey || incomingEmbedding.api_key || existing.embedding.apiKey || ""),
      model: String(incomingEmbedding.model || existing.embedding.model || ""),
      wireApi: String(incomingEmbedding.wireApi || incomingEmbedding.wire_api || "openai")
    },
    chat: {
      modelId: String(input?.chat?.modelId || existing.chat.modelId || "")
    },
    chunk: {
      maxChars: Math.max(400, Math.min(6000, Number(input?.chunk?.maxChars) || existing.chunk.maxChars || 1600)),
      overlapChars: Math.max(0, Math.min(1000, Number(input?.chunk?.overlapChars) || existing.chunk.overlapChars || 200))
    }
  };
  const docsPath = resolveWorkspacePath(config.docsDir, "knowledge");
  if (!docsPath) throw new Error("docsDir must stay inside this workspace");
  await mkdir(docsPath, { recursive: true });
  await writeJsonFile(knowledgeConfigFile, config);
  return loadKnowledgeConfig();
}

async function walkMarkdownFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".obsidian")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
  }
  return files;
}

function chunkMarkdown(content, { maxChars, overlapChars }) {
  const blocks = String(content || "")
    .replace(/\r\n/g, "\n")
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = overlapChars > 0 ? current.slice(-overlapChars) : "";
    }
    current = current ? `${current}\n\n${block}` : block;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars).trim());
      current = overlapChars > 0 ? current.slice(maxChars - overlapChars) : current.slice(maxChars);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function stableChunkId(relativePath, index, content) {
  return crypto
    .createHash("sha1")
    .update(`${relativePath}\n${index}\n${content}`)
    .digest("hex")
    .slice(0, 16);
}

function sha256Short(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

async function embedTexts(config, texts) {
  const embedding = config.embedding || {};
  if (!embedding.apiKey) throw new Error("missing embedding api_key");
  if (!embedding.model) throw new Error("missing embedding model");
  if (!embedding.baseUrl) throw new Error("missing embedding base_url");
  const response = await fetch(joinUrl(embedding.baseUrl, "/embeddings"), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${embedding.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: embedding.model, input: texts })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`embedding non-json response: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(data.error?.message || text.slice(0, 1000));
  const vectors = (data.data || []).map((item) => item.embedding || item.vec).filter(Array.isArray);
  if (vectors.length !== texts.length) throw new Error("embedding response length mismatch");
  return vectors;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -Infinity;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return -Infinity;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function updateKnowledgeReindexJob(patch) {
  knowledgeReindexJob = {
    ...knowledgeReindexJob,
    ...patch
  };
}

function knowledgeReindexStatus() {
  const totalWork = knowledgeReindexJob.totalFiles + knowledgeReindexJob.totalChunks;
  const doneWork = knowledgeReindexJob.processedFiles + knowledgeReindexJob.embeddedChunks;
  const percent = knowledgeReindexJob.running && totalWork
    ? Math.max(1, Math.min(99, Math.round((doneWork / totalWork) * 100)))
    : knowledgeReindexJob.percent;
  return { ...knowledgeReindexJob, percent };
}

async function buildKnowledgeIndex({ onProgress } = {}) {
  const config = await loadKnowledgeConfig({ includeKey: true });
  const previousIndex = await loadKnowledgeIndex();
  const reusableEmbeddings = new Map();
  if (previousIndex.embeddingModel === config.embedding.model && Array.isArray(previousIndex.chunks)) {
    for (const chunk of previousIndex.chunks) {
      if (chunk?.id && Array.isArray(chunk.embedding)) reusableEmbeddings.set(chunk.id, chunk.embedding);
    }
  }
  const docsPath = resolveWorkspacePath(config.docsDir, "knowledge");
  if (!docsPath) throw new Error("docsDir must stay inside this workspace");
  await mkdir(docsPath, { recursive: true });
  const files = await walkMarkdownFiles(docsPath);
  onProgress?.({ stage: "scan", totalFiles: files.length, processedFiles: 0, message: `扫描到 ${files.length} 个 Markdown 文件` });
  const chunks = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const filePath = files[fileIndex];
    const info = await stat(filePath);
    const relativePath = path.relative(docsPath, filePath).replace(/\\/g, "/");
    const title = path.basename(filePath, path.extname(filePath));
    const parts = chunkMarkdown(await readFile(filePath, "utf8"), config.chunk);
    parts.forEach((content, index) => {
      chunks.push({
        id: stableChunkId(relativePath, index, content),
        path: relativePath,
        title,
        content,
        mtimeMs: info.mtimeMs,
        nchars: content.length
      });
    });
    onProgress?.({ stage: "chunk", processedFiles: fileIndex + 1, totalChunks: chunks.length, message: `正在分块：${relativePath}` });
  }
  let reusedChunks = 0;
  const missingChunks = [];
  for (const chunk of chunks) {
    const existing = reusableEmbeddings.get(chunk.id);
    if (existing) {
      chunk.embedding = existing;
      reusedChunks += 1;
    } else {
      missingChunks.push(chunk);
    }
  }
  onProgress?.({
    stage: "embed",
    totalChunks: chunks.length,
    embeddedChunks: reusedChunks,
    message: missingChunks.length
      ? `复用 ${reusedChunks} 个片段，开始 embedding ${missingChunks.length} 个新/变更片段`
      : `已复用全部 ${reusedChunks} 个片段，无需重新 embedding`
  });
  for (let index = 0; index < missingChunks.length; index += 64) {
    const batch = missingChunks.slice(index, index + 64);
    const embeddings = await embedTexts(config, batch.map((chunk) => chunk.content));
    embeddings.forEach((embedding, offset) => {
      batch[offset].embedding = embedding;
    });
    onProgress?.({
      stage: "embed",
      embeddedChunks: Math.min(reusedChunks + index + batch.length, chunks.length),
      totalChunks: chunks.length,
      message: `已处理 ${Math.min(reusedChunks + index + batch.length, chunks.length)} / ${chunks.length}`
    });
  }
  const index = {
    createdAt: isoNow(),
    docsDir: config.docsDir,
    embeddingModel: config.embedding.model,
    chunk: config.chunk,
    chunks
  };
  await writeJsonFile(knowledgeIndexFile, index);
  return index;
}

async function startKnowledgeReindex() {
  if (knowledgeReindexJob.running) return knowledgeReindexStatus();
  updateKnowledgeReindexJob({
    running: true,
    stage: "start",
    message: "准备重建索引",
    error: "",
    startedAt: isoNow(),
    finishedAt: "",
    totalFiles: 0,
    processedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    percent: 0
  });
  buildKnowledgeIndex({
    onProgress: (patch) => updateKnowledgeReindexJob(patch)
  }).then((index) => {
    updateKnowledgeReindexJob({
      running: false,
      stage: "done",
      message: `索引已建立：${index.chunks.length} 个片段`,
      error: "",
      finishedAt: isoNow(),
      totalChunks: index.chunks.length,
      embeddedChunks: index.chunks.length,
      percent: 100
    });
  }).catch((error) => {
    updateKnowledgeReindexJob({
      running: false,
      stage: "error",
      message: "索引建立失败",
      error: error.message,
      finishedAt: isoNow(),
      percent: 0
    });
  });
  return knowledgeReindexStatus();
}

async function loadKnowledgeIndex() {
  return readJsonFile(knowledgeIndexFile, { createdAt: "", docsDir: "", embeddingModel: "", chunks: [] });
}

async function searchKnowledge(query, { topK = 6 } = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("query is required");
  const config = await loadKnowledgeConfig({ includeKey: true });
  const index = await loadKnowledgeIndex();
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  if (!chunks.length) throw new Error("knowledge index is empty; rebuild it first");
  if (index.embeddingModel && index.embeddingModel !== config.embedding.model) {
    throw new Error(`embedding model mismatch: index=${index.embeddingModel}, config=${config.embedding.model}`);
  }
  const [queryEmbedding] = await embedTexts(config, [text]);
  const queryTokens = tokenize(text);
  const results = chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const textScore = lexicalKnowledgeScore(chunk, queryTokens, text);
      const score = Number.isFinite(vectorScore)
        ? (vectorScore * 0.82) + (textScore * 0.18)
        : textScore;
      return {
      id: chunk.id,
      path: chunk.path,
      title: chunk.title,
      content: chunk.content,
      score,
      vectorScore,
      textScore,
      nchars: chunk.nchars
    };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, Number(topK) || 6)));
  return { query: text, results, index: { createdAt: index.createdAt, docsDir: index.docsDir, embeddingModel: index.embeddingModel, totalChunks: chunks.length } };
}

function lexicalKnowledgeScore(chunk, queryTokens, queryText) {
  const pathText = String(chunk.path || "").toLowerCase();
  const titleText = String(chunk.title || "").toLowerCase();
  const contentText = String(chunk.content || "").toLowerCase();
  const compactQuery = String(queryText || "").toLowerCase().trim();
  let score = 0;
  if (compactQuery && (pathText.includes(compactQuery) || titleText.includes(compactQuery))) score += 1;
  for (const token of queryTokens) {
    if (pathText.includes(token)) score += 0.6;
    if (titleText.includes(token)) score += 0.5;
    if (contentText.includes(token)) score += 0.18;
  }
  return Math.min(1, score);
}

function buildKnowledgeContext(results) {
  return (results || []).map((item, index) => [
    `[${index + 1}] ${item.title || item.path} (${item.source || "knowledge"}: ${item.url || item.path}, score=${Number(item.score || 0).toFixed(3)})`,
    String(item.content || "").slice(0, 1800)
  ].join("\n")).join("\n\n---\n\n");
}

async function loadWebSearchConfig({ includeKey = false } = {}) {
  const env = await loadLocalEnv();
  const saved = await readJsonFile(webSearchConfigFile, defaultWebSearchConfig());
  const provider = normalizeWebSearchProvider(env.WEB_SEARCH_PROVIDER || saved.provider || "");
  const envKey = env.WEB_SEARCH_API_KEY || env.TAVILY_API_KEY || env.BRAVE_SEARCH_API_KEY || env.EXA_API_KEY;
  const savedKey = saved.apiKey || saved.api_key;
  return {
    provider,
    apiKey: includeKey ? String(envKey || savedKey || "") : "",
    hasApiKey: Boolean(envKey || savedKey),
    requiresApiKey: !["searxng", "openwebsearch"].includes(provider),
    baseUrl: normalizeBaseUrl(env.WEB_SEARCH_BASE_URL || saved.baseUrl || saved.base_url || ""),
    enabled: envBool(env.WEB_SEARCH_ENABLED, saved.enabled === true || Boolean(provider)),
    maxResults: Math.max(1, Math.min(10, Number(env.WEB_SEARCH_MAX_RESULTS || saved.maxResults) || 5))
  };
}

async function saveWebSearchConfig(input) {
  const existing = await loadWebSearchConfig({ includeKey: true });
  const config = {
    provider: normalizeWebSearchProvider(input?.provider || existing.provider || ""),
    apiKey: String(input?.apiKey || input?.api_key || existing.apiKey || ""),
    baseUrl: normalizeBaseUrl(input?.baseUrl || input?.base_url || existing.baseUrl || ""),
    enabled: input?.enabled !== false,
    maxResults: Math.max(1, Math.min(10, Number(input?.maxResults) || existing.maxResults || 5))
  };
  await writeJsonFile(webSearchConfigFile, config);
  return loadWebSearchConfig();
}

function normalizeWebSearchProvider(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (compact === "openwebsearch") return "openwebsearch";
  if (compact === "searxng") return "searxng";
  if (compact === "tavily") return "tavily";
  if (compact === "brave") return "brave";
  if (compact === "exa") return "exa";
  return String(value || "").trim().toLowerCase();
}

async function searchWeb(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("query is required");
  const config = await loadWebSearchConfig({ includeKey: true });
  if (!config.enabled) return { query: text, results: [], config: await loadWebSearchConfig() };
  if (!config.provider) throw new Error("missing web search provider");
  if (!["searxng", "openwebsearch"].includes(config.provider) && !config.apiKey) throw new Error("missing web search api_key");
  const maxResults = Math.max(1, Math.min(10, Number(options.topK || config.maxResults) || 5));
  if (config.provider === "tavily") return searchTavily(text, config, maxResults);
  if (config.provider === "brave") return searchBrave(text, config, maxResults);
  if (config.provider === "exa") return searchExa(text, config, maxResults);
  if (config.provider === "searxng") return searchSearxng(text, config, maxResults);
  if (config.provider === "openwebsearch") return searchOpenWebSearch(text, config, maxResults);
  throw new Error(`unsupported web search provider: ${config.provider}`);
}

async function searchTavily(query, config, maxResults) {
  const response = await fetch(config.baseUrl || "https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: config.apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false
    })
  });
  const data = await parseProviderResponse(response);
  const results = (data.results || []).map((item) => ({
    source: "web",
    provider: "tavily",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.content || item.snippet || "",
    score: Number(item.score) || 0
  }));
  return { query, results };
}

async function searchBrave(query, config, maxResults) {
  const baseUrl = config.baseUrl || "https://api.search.brave.com/res/v1/web/search";
  const url = new URL(baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "x-subscription-token": config.apiKey
    }
  });
  const data = await parseProviderResponse(response);
  const results = (data.web?.results || []).map((item, index) => ({
    source: "web",
    provider: "brave",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.description || item.extra_snippets?.join("\n") || "",
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results };
}

async function searchExa(query, config, maxResults) {
  const response = await fetch(config.baseUrl || "https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      contents: { text: true }
    })
  });
  const data = await parseProviderResponse(response);
  const results = (data.results || []).map((item) => ({
    source: "web",
    provider: "exa",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.text || item.summary || "",
    score: Number(item.score) || 0
  }));
  return { query, results };
}

async function searchSearxng(query, config, maxResults) {
  if (!config.baseUrl) throw new Error("missing searxng base_url");
  const url = new URL(joinUrl(config.baseUrl, "/search"));
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url);
  const data = await parseProviderResponse(response);
  const results = (data.results || []).slice(0, maxResults).map((item, index) => ({
    source: "web",
    provider: "searxng",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: item.content || item.snippet || "",
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results };
}

async function searchOpenWebSearch(query, config, maxResults) {
  if (!config.baseUrl) throw new Error("missing openwebsearch base_url");
  const env = await loadLocalEnv();
  const engines = String(env.OPEN_WEBSEARCH_ENGINES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const searchMode = String(env.OPEN_WEBSEARCH_SEARCH_MODE || "").trim();
  const body = { query, limit: maxResults };
  if (engines.length) body.engines = engines;
  if (searchMode) body.searchMode = searchMode;
  let response;
  try {
    response = await fetch(joinUrl(config.baseUrl, "/search"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`openwebsearch daemon not reachable at ${config.baseUrl}: ${error.message}`);
  }
  const envelope = await parseProviderResponse(response);
  if (envelope.status === "error") {
    throw new Error(envelope.error?.message || envelope.hint || "openwebsearch error");
  }
  const data = envelope.data || envelope;
  const failures = Array.isArray(data.partialFailures) && data.partialFailures.length
    ? `\n\nPartial failures: ${data.partialFailures.map((item) => `${item.engine}: ${item.message}`).join("; ")}`
    : "";
  const results = (data.results || []).slice(0, maxResults).map((item, index) => ({
    source: "web",
    provider: "openwebsearch",
    title: item.title || item.url || "web result",
    url: item.url || "",
    path: item.url || "",
    content: `${item.description || ""}${failures}`,
    score: 1 - index / Math.max(maxResults, 1)
  }));
  return { query, results, failures: data.partialFailures || [] };
}

async function stopLocalPort(portValue) {
  const portNumber = Number(portValue);
  if (!Number.isInteger(portNumber) || portNumber <= 0) return;
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$port=${portNumber}`,
    `$self=${process.pid}`,
    "$pids = Get-NetTCPConnection -LocalPort $port | Where-Object { $_.OwningProcess -and $_.OwningProcess -ne $self } | Select-Object -ExpandProperty OwningProcess -Unique",
    "foreach ($pidToStop in $pids) { Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue; & taskkill /PID $pidToStop /F 2>$null | Out-Null }"
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 8000 }).catch(() => {});
}

async function shutdownBackgroundServices() {
  const webConfig = await loadWebSearchConfig();
  if (webConfig.provider === "openwebsearch") {
    const baseUrl = webConfig.baseUrl || "http://127.0.0.1:3210";
    try {
      const url = new URL(baseUrl);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        await stopLocalPort(url.port || 3210);
      }
    } catch {
      // Ignore malformed optional web-search base URL during shutdown.
    }
  }
}

async function parseProviderResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`web search non-json response: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(data.error?.message || data.message || text.slice(0, 1000));
  return data;
}

async function searchRetrieval(query, { topK = 6, includeKnowledge = true, includeWeb = false } = {}) {
  const results = [];
  const errors = [];
  let index = null;
  if (includeKnowledge) {
    try {
      const local = await searchKnowledge(query, { topK });
      index = local.index;
      results.push(...local.results.map((item) => ({ ...item, source: "knowledge" })));
    } catch (error) {
      errors.push(`knowledge: ${error.message}`);
    }
  }
  if (includeWeb) {
    try {
      const web = await searchWeb(query, { topK });
      results.push(...web.results);
    } catch (error) {
      errors.push(`web: ${error.message}`);
    }
  }
  if (!results.length && errors.length) throw new Error(errors.join("; "));
  return { query, results, index, errors };
}

function defaultModelAgentPrompt(name) {
  return [
    `# ${name || "Model Agent"}`,
    "",
    "你是多个独立模型协作者之一，帮助用户分析共享任务图中的当前节点。",
    "",
    "规则：",
    "- 必须用中文回答，除非用户明确要求其它语言。",
    "- 先读完整 task-tree.md，再聚焦当前节点和用户这一次的问题。",
    "- 你会看到系统自动检索出的本地 Markdown 知识库片段，也可能看到联网搜索结果；这些是可用证据，不足时要明确说还缺什么。",
    "- 不要假设其它模型会同意你；独立给出判断、风险、反例和下一步建议。",
    "- 如果 task-tree.md 与历史或其它信息冲突，以 task-tree.md 为准。",
    "- 回答要适合用户横向比较多个模型：结构清楚、不要长篇铺陈、优先给结论和依据。"
  ].join("\n");
}

async function readModelAgentPrompt(agent) {
  await mkdir(modelAgentsDir, { recursive: true });
  const configured = agent.agentFile ? resolveWorkspacePath(agent.agentFile, "") : null;
  const agentPath = configured || path.join(modelAgentsDir, `${agent.id}.md`);
  if (!existsSync(agentPath)) {
    await writeFile(agentPath, defaultModelAgentPrompt(agent.name), "utf8");
  }
  return await readFile(agentPath, "utf8");
}

async function loadModelAgents({ includeKeys = false } = {}) {
  const env = await loadLocalEnv();
  const data = await readJsonFile(modelAgentsFile, { models: [] });
  const models = Array.isArray(data.models) ? [...data.models] : [];
  const envIds = String(env.MODEL_AGENT_IDS || "").split(",").map((item) => safeModelId(item)).filter(Boolean);
  for (const id of envIds) {
    const segment = envKeySegment(id);
    const envAgent = {
      id,
      name: env[`MODEL_AGENT_${segment}_NAME`] || id,
      baseUrl: env[`MODEL_AGENT_${segment}_BASE_URL`] || "",
      model: env[`MODEL_AGENT_${segment}_MODEL`] || "",
      apiKey: env[`MODEL_AGENT_${segment}_API_KEY`] || "",
      enabled: envBool(env[`MODEL_AGENT_${segment}_ENABLED`], true),
      wireApi: env[`MODEL_AGENT_${segment}_WIRE_API`] || "chat",
      agentFile: env[`MODEL_AGENT_${segment}_AGENT_FILE`] || path.join("model-agents", `${id}.md`),
      source: "env"
    };
    const existingIndex = models.findIndex((item) => safeModelId(item.id || item.name || item.model) === id);
    if (existingIndex >= 0) models[existingIndex] = { ...models[existingIndex], ...envAgent };
    else models.push(envAgent);
  }
  return {
    models: models.map((item) => {
      const id = safeModelId(item.id || item.name || item.model) || `model-${Math.random().toString(36).slice(2, 8)}`;
      const key = String(item.apiKey || item.api_key || "");
      return {
        id,
        name: String(item.name || id),
        baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url),
        model: String(item.model || ""),
        apiKey: includeKeys ? key : "",
        hasApiKey: Boolean(key),
        enabled: item.enabled !== false,
        wireApi: String(item.wireApi || item.wire_api || "chat"),
        agentFile: String(item.agentFile || item.agent_file || path.join("model-agents", `${id}.md`)),
        source: item.source || "json"
      };
    })
  };
}

async function saveModelAgents(models) {
  const existing = await readJsonFile(modelAgentsFile, { models: [] });
  const keyById = new Map((Array.isArray(existing.models) ? existing.models : []).map((item) => [
    safeModelId(item.id || item.name || item.model),
    String(item.apiKey || item.api_key || "")
  ]));
  const normalized = (Array.isArray(models) ? models : []).map((item, index) => {
    const id = safeModelId(item.id || item.name || item.model) || `model-${index + 1}`;
    const incomingKey = String(item.apiKey || item.api_key || "");
    return {
      id,
      name: String(item.name || id),
      baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url),
      model: String(item.model || ""),
      apiKey: incomingKey || keyById.get(id) || "",
      enabled: item.enabled !== false,
      wireApi: String(item.wireApi || item.wire_api || "chat"),
      agentFile: String(item.agentFile || item.agent_file || path.join("model-agents", `${id}.md`))
    };
  });
  await writeJsonFile(modelAgentsFile, { models: normalized });
  await mkdir(modelAgentsDir, { recursive: true });
  for (const item of normalized) {
    const configured = resolveWorkspacePath(item.agentFile, "");
    const agentPath = configured || path.join(modelAgentsDir, `${item.id}.md`);
    if (typeof item.agentPrompt === "string" && item.agentPrompt.trim()) {
      await writeFile(agentPath, item.agentPrompt, "utf8");
    } else if (!existsSync(agentPath)) {
      await writeFile(agentPath, defaultModelAgentPrompt(item.name), "utf8");
    }
  }
  return loadModelAgents();
}

async function loadModelAgentDetails() {
  const config = await loadModelAgents({ includeKeys: false });
  const models = [];
  for (const item of config.models) {
    models.push({ ...item, agentPrompt: await readModelAgentPrompt(item) });
  }
  return { models };
}

function extractNodeMarkdown(markdown, nodeId) {
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## ${nodeId} - `));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+[A-Za-z0-9_-]+\s+-\s+/.test(lines[index]) || /^#\s+GraphState\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function compactModelHistory(history, modelId, nodeId) {
  const turns = Array.isArray(history[modelId]) ? history[modelId] : [];
  return turns
    .filter((item) => !nodeId || item.nodeId === nodeId)
    .slice(-6)
    .map((item) => [
      `Time: ${item.createdAt || ""}`,
      `Node: ${item.nodeId || ""}`,
      `Question: ${item.question || ""}`,
      `Answer: ${String(item.answer || "").slice(0, 4000)}`
    ].join("\n"))
    .join("\n\n---\n\n");
}

function buildModelAgentMessages({ agentPrompt, treeMarkdown, nodeMarkdown, question, historyText, sharedHistoryText, knowledgeContext }) {
  const system = [
    agentPrompt,
    "",
    "独立性规则：你不会看到其它模型本轮的回答，必须独立判断。",
    "页面临时记忆规则：你可以看到本页面里其它模型和用户此前围绕该节点的临时对话，用它理解已经讨论过什么；但这些内容没有写入任务树，不能覆盖 task-tree.md。",
    "共享上下文规则：完整 task-tree.md 是权威任务状态。",
    "输出规则：用中文回答；可以使用简洁 Markdown，但不要输出大段代码块式报告。",
    "检索工具规则：如果你需要查本地知识库或联网搜索，不要猜。请只输出一个 JSON 对象，不要输出其它文字：",
    "{\"tool\":\"search\",\"query\":\"你要检索的问题或关键词\",\"includeWeb\":true,\"topK\":6}",
    "收到 TOOL_RESULT 后，再决定是否继续检索或给最终回答。最多请求 3 次检索。"
  ].join("\n");
  const user = [
    "当前完整任务树：",
    "```markdown",
    treeMarkdown,
    "```",
    "",
    "当前节点：",
    "```markdown",
    nodeMarkdown || "(node not found)",
    "```",
    knowledgeContext ? ["", "系统已检索到的本地知识库/联网搜索上下文：", "```text", knowledgeContext, "```"].join("\n") : "",
    sharedHistoryText ? ["", "页面内其它模型/用户的临时共享上下文：", "```text", sharedHistoryText, "```"].join("\n") : "",
    historyText ? ["", "你在该节点的历史记录：", historyText].join("\n") : "",
    "",
    "用户这次给当前节点的问题：",
    question
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

function normalizeModelConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-10)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 4000)
    }));
}

function parseAgentToolRequest(text) {
  const raw = String(text || "").trim();
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && parsed.tool === "search" && typeof parsed.query === "string" && parsed.query.trim()) {
        return {
          query: parsed.query.trim(),
          includeWeb: parsed.includeWeb !== false,
          topK: Math.max(1, Math.min(10, Number(parsed.topK) || 6))
        };
      }
    } catch {
      // Continue trying less strict candidates.
    }
  }
  return null;
}

function normalizeSharedModelContext(value) {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => item && typeof item.content === "string")
    .slice(-24)
    .map((item) => {
      const model = item.modelName || item.modelId || "unknown";
      const role = item.role === "assistant" ? "模型" : "用户";
      return `[${model}] ${role}: ${item.content.slice(0, 1200)}`;
    })
    .join("\n\n");
}

async function runModelAgentWithTools({ agent, agentPrompt, treeMarkdown, nodeMarkdown, question, history, sharedHistory, enableTools, includeWeb, providedKnowledgeContext }) {
  const toolEvents = [];
  const messages = buildModelAgentMessages({
    agentPrompt,
    treeMarkdown,
    nodeMarkdown,
    question,
    historyText: "",
    sharedHistoryText: normalizeSharedModelContext(sharedHistory),
    knowledgeContext: providedKnowledgeContext
  });
  const priorTurns = normalizeModelConversation(history);
  if (priorTurns.length) {
    messages.push({
      role: "user",
      content: [
        "以下是你和用户在该节点的临时会话历史，仅用于本轮连续对话；它没有写入任务树：",
        "```text",
        priorTurns.map((turn) => `${turn.role === "user" ? "用户" : "你"}：${turn.content}`).join("\n\n"),
        "```"
      ].join("\n")
    });
  }
  messages.push({ role: "user", content: question });

  let answer = "";
  for (let step = 0; step < 4; step += 1) {
    answer = await callOpenAICompatible(agent, messages);
    const request = enableTools && step < 3 ? parseAgentToolRequest(answer) : null;
    if (!request) break;
    let search;
    try {
      search = await searchRetrieval(request.query, {
        topK: request.topK,
        includeKnowledge: true,
        includeWeb: includeWeb && request.includeWeb
      });
    } catch (error) {
      search = { results: [], errors: [error.message] };
    }
    toolEvents.push({
      query: request.query,
      includeWeb: includeWeb && request.includeWeb,
      resultCount: search.results.length,
      errors: search.errors || []
    });
    messages.push({ role: "assistant", content: answer });
    messages.push({
      role: "user",
      content: [
        "TOOL_RESULT search",
        `query: ${request.query}`,
        search.errors?.length ? `errors: ${search.errors.join("; ")}` : "",
        "```text",
        buildKnowledgeContext(search.results || []),
        "```",
        "请基于这些结果继续。如果还需要检索，可以再次只输出 search JSON；否则给出最终中文回答。"
      ].filter(Boolean).join("\n")
    });
  }
  return { answer, toolEvents };
}

async function callOpenAICompatible(agent, messages) {
  if (!agent.apiKey) throw new Error("missing api_key");
  if (!agent.model) throw new Error("missing model");
  if (!agent.baseUrl) throw new Error("missing base_url");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const wire = String(agent.wireApi || "chat").toLowerCase();
    const isResponses = wire === "responses" || wire === "response";
    const response = await fetch(joinUrl(agent.baseUrl, isResponses ? "/responses" : "/chat/completions"), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${agent.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(isResponses ? {
        model: agent.model,
        input: messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
        max_output_tokens: 1800
      } : {
        model: agent.model,
        messages,
        temperature: 0.7,
        max_tokens: 1800
      }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`non-json response: ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(data.error?.message || text.slice(0, 1000));
    }
    if (isResponses) {
      if (typeof data.output_text === "string") return data.output_text.trim();
      const chunks = [];
      for (const item of data.output || []) {
        for (const content of item.content || []) {
          if (typeof content.text === "string") chunks.push(content.text);
        }
      }
      return chunks.join("\n").trim();
    }
    return String(data.choices?.[0]?.message?.content || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

function safeReason(reason) {
  return String(reason || "将自动保存图谱修改")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 80) || "将自动保存图谱修改";
}

async function backupTree(reason) {
  await mkdir(versionsDir, { recursive: true });
  if (!existsSync(treeFile)) return null;
  const name = `${timestamp()}_${safeReason(reason)}.md`;
  await copyFile(treeFile, path.join(versionsDir, name));
  return name;
}

async function listVersions() {
  await mkdir(versionsDir, { recursive: true });
  const names = (await readdir(versionsDir)).filter((name) => name.endsWith(".md"));
  const items = await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(versionsDir, name));
    const match = name.match(/^(\d{8}-\d{6})_(.*)\.md$/);
    return {
      name,
      reason: match ? match[2] : name.replace(/\.md$/, ""),
      createdAt: match ? match[1] : "",
      mtimeMs: info.mtimeMs
    };
  }));
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function walkFiles(root, fileName) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath, fileName));
    else if (entry.isFile() && entry.name === fileName) files.push(fullPath);
  }
  return files;
}

function extractSkillDescription(text) {
  const match = text.match(/^description:\s*([\s\S]+?)(\r?\n[a-zA-Z_-]+:|\r?\n---|\r?\n# )/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ") : "";
}

function extractSkillName(text, filePath) {
  const match = text.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : path.basename(path.dirname(filePath));
}

async function loadSkillIndex() {
  if (skillIndexCache) return skillIndexCache;
  const roots = [
    { repo: "project", root: path.join(projectRoot, "skills") },
    { repo: "kit", root: path.join(kitDir, "skills") },
    { repo: "codex", root: path.join(homeDir, ".codex", "skills") },
    { repo: "agents", root: path.join(homeDir, ".agents", "skills") },
    { repo: "orchestra", root: path.join(homeDir, ".orchestra", "skills") }
  ].filter((item) => item.root && existsSync(item.root));
  const skills = [];
  for (const item of roots) {
    const files = await walkFiles(item.root, "SKILL.md");
    for (const filePath of files) {
      const text = await readFile(filePath, "utf8");
      const name = extractSkillName(text, filePath);
      const description = extractSkillDescription(text);
      if (!description) continue;
      skills.push({
        id: `${item.repo}:${name}`,
        repo: item.repo,
        name,
        path: filePath,
        description,
        functionText: toChineseSkillFunction(name, description)
      });
    }
  }
  skillIndexCache = skills.sort((a, b) => a.name.localeCompare(b.name));
  return skillIndexCache;
}

function toChineseSkillFunction(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  const exact = {
    diagnose: "用于诊断复杂 bug 或性能退化：复现问题、缩小范围、提出假设、插桩验证、修复并补回归测试。",
    "diagnosing-bugs": "用于诊断复杂 bug 或性能退化：复现问题、缩小范围、提出假设、插桩验证、修复并补回归测试。",
    tdd: "用于测试驱动开发：先写失败测试，再实现最小修复，最后重构并保持测试通过。",
    "grill-me": "用于在动手前追问和澄清计划，把目标、边界、约束和风险问清楚。",
    "grill-with-docs": "用于深度澄清计划，同时沉淀领域术语、决策记录和项目文档。",
    handoff: "用于把当前上下文压缩成交接文档，让下一个会话或 agent 能继续。",
    "to-prd": "用于把已有讨论整理成 PRD 或规格文档，方便后续拆分和执行。",
    "to-issues": "用于把计划拆成可执行 issue，或对已有问题进行分诊、验证和排序。",
    prototype: "用于快速做可丢弃原型，验证交互、状态逻辑或实现路径。",
    "find-skills": "用于根据当前目标寻找、推荐或安装合适的 agent skills。",
    "write-a-skill": "用于把可复用工作流写成新的 agent skill。",
    "skill-creator": "用于创建或修改符合规范的 agent skill。",
    "task-tree-grill": "用于新项目初始建树或修订任务树：通过一次一个问题的追问，生成 task-tree.md 的节点、边、Current、Next 和 NextPlan。"
  };
  if (exact[name]) return exact[name];
  const rules = [
    { pattern: /diagnos|debug|bug|failing|broken|slow/, text: "用于诊断复杂 bug 或性能退化：复现问题、缩小范围、提出假设、插桩验证、修复并补回归测试。" },
    { pattern: /tdd|red-green|test-driven/, text: "用于测试驱动开发：先写失败测试，再实现最小修复，最后重构并保持测试通过。" },
    { pattern: /grill|interview|clarify|plan|design/, text: "用于在动手前追问和澄清计划，把目标、边界、约束和风险问清楚。" },
    { pattern: /prd|product requirement|spec/, text: "用于把已有讨论整理成 PRD 或规格文档，方便后续拆分和执行。" },
    { pattern: /issue|ticket|triage/, text: "用于把计划拆成可执行 issue，或对已有问题进行分诊、验证和排序。" },
    { pattern: /architecture|codebase-design|module|interface|domain model|ddd/, text: "用于改进代码结构、模块边界、领域术语和接口设计，让项目更容易维护。" },
    { pattern: /handoff/, text: "用于把当前上下文压缩成交接文档，让下一个会话或 agent 能继续。" },
    { pattern: /skill|autoskill|router/, text: "用于判断当前任务应该使用哪些能力，或从工作模式中发现可复用的新能力。" },
    { pattern: /literature|paper|citation|pubmed|scholar|research lookup|web search/, text: "用于检索论文、网页或研究资料，整理证据、引用和来源。" },
    { pattern: /scientific writing|manuscript|paper writing|imrad/, text: "用于科学写作，把研究内容组织成论文、报告或正式段落。" },
    { pattern: /visualization|plot|matplotlib|seaborn|figure/, text: "用于制作数据图、论文图或可视化结果，并处理配色、布局和导出。" },
    { pattern: /statistics|statistical|power|regression|survival|statsmodels/, text: "用于统计分析、样本量/效能计算、回归建模、假设检验或结果报告。" },
    { pattern: /machine learning|scikit|transformers|pytorch|fine-tun|train|model/, text: "用于机器学习或深度学习建模、训练、评估、微调和推理工作流。" },
    { pattern: /rag|vector|embedding|retrieval|faiss|qdrant|pinecone|chroma/, text: "用于检索增强生成、向量数据库、embedding 检索和知识库构建。" },
    { pattern: /agent|langchain|crewai|autogpt|llamaindex/, text: "用于构建 agent、工具调用、RAG 应用或多 agent 协作系统。" },
    { pattern: /quantization|gguf|gptq|awq|bitsandbytes|pruning|distillation/, text: "用于模型压缩、量化、剪枝或知识蒸馏，降低部署成本。" },
    { pattern: /distributed|deepspeed|fsdp|ray|megatron|accelerate/, text: "用于分布式训练、并行计算、显存优化和大模型训练工程。" },
    { pattern: /bio|gene|genomic|rnaseq|single-cell|protein|molecule|chem|drug|rdkit/, text: "用于生物信息、基因组、单细胞、蛋白、化学或药物发现相关工作流。" },
    { pattern: /clinical|medical|treatment|health|diagnos/, text: "用于医学、临床报告、治疗方案、医疗数据或临床决策支持。" },
    { pattern: /excel|xlsx|spreadsheet/, text: "用于创建、编辑、分析或转换 Excel 表格和多工作表文件。" },
    { pattern: /docx|word document/, text: "用于创建、读取、编辑或格式化 Word 文档。" },
    { pattern: /pptx|slides|presentation|beamer/, text: "用于制作幻灯片、学术报告、演示文稿或 Beamer/PPTX 文件。" }
  ];
  const found = rules.find((rule) => rule.pattern.test(text));
  if (found) return found.text;
  const clipped = description.length > 180 ? `${description.slice(0, 180)}...` : description;
  return `用于处理与“${name}”相关的任务。原始说明：${clipped}`;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

function scoreSkill(skill, queryTokens, queryText) {
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 3 : 1;
  }
  if (queryText.includes(skill.name.toLowerCase())) score += 20;
  if (skill.name === "ask-matt" || skill.name === "autoskill") score += 2;
  score += intentBoost(skill.name, queryText);
  return score;
}

function intentBoost(name, queryText) {
  const rules = [
    { names: ["diagnose", "diagnosing-bugs"], patterns: [/bug|debug|fail|error|broken|slow|regression|调试|报错|失败|定位|修复|没反应|性能/], boost: 25 },
    { names: ["tdd"], patterns: [/test|spec|coverage|测试|验证|回归/], boost: 18 },
    { names: ["grill-with-docs", "grilling", "grill-me"], patterns: [/需求|澄清|计划|设计|不确定|追问|讨论|对齐|grill/], boost: 16 },
    { names: ["to-prd"], patterns: [/prd|需求文档|产品文档|规格|specification/], boost: 18 },
    { names: ["to-issues"], patterns: [/issue|ticket|拆分|任务拆解|工单/], boost: 18 },
    { names: ["implement"], patterns: [/实现|编码|开发|落地|execute|implement/], boost: 15 },
    { names: ["review"], patterns: [/review|审查|代码审查|检查变更/], boost: 18 },
    { names: ["prototype"], patterns: [/原型|prototype|试做|探索界面|交互方案/], boost: 18 },
    { names: ["domain-modeling", "codebase-design"], patterns: [/领域|术语|架构|模块|接口|边界|重构|domain|architecture/], boost: 16 },
    { names: ["ask-matt", "autoskill"], patterns: [/skill|skills|技能|能力|选择哪些|自动调用|路由/], boost: 20 },
    { names: ["task-tree-grill"], patterns: [/task-tree|任务树|任务图|建树|初始树|建立.*树|一开始.*树|current|nextplan/], boost: 35 },
    { names: ["literature-review", "research-lookup", "paper-lookup"], patterns: [/论文|文献|research|paper|sota|综述/], boost: 20 },
    { names: ["scientific-writing"], patterns: [/论文写作|scientific writing|manuscript|imrad/], boost: 20 },
    { names: ["statistical-analysis", "statistical-power"], patterns: [/统计|显著性|样本量|power|p值|回归分析/], boost: 20 }
  ];
  return rules.reduce((sum, rule) => {
    if (!rule.names.includes(name)) return sum;
    return sum + (rule.patterns.some((pattern) => pattern.test(queryText)) ? rule.boost : 0);
  }, 0);
}

async function recommendSkills(body) {
  const skills = await loadSkillIndex();
  const queryText = [
    body?.nextPlan,
    body?.nextIdea,
    body?.node?.title,
    body?.node?.problem,
    body?.node?.approach,
    body?.node?.metrics,
    body?.node?.notes
  ].filter(Boolean).join("\n").toLowerCase();
  const queryTokens = tokenize(queryText);
  let scored = skills
    .map((skill) => ({ ...skill, score: scoreSkill(skill, queryTokens, queryText) }))
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const topScore = scored[0]?.score || 0;
  if (topScore >= 10) scored = scored.filter((skill) => skill.score >= 5);
  scored = scored.slice(0, 12);

  if (scored.length) return scored;
  return skills
    .filter((skill) => ["ask-matt", "grill-with-docs", "grilling", "autoskill", "scientific-critical-thinking"].includes(skill.name))
    .slice(0, 8)
    .map((skill) => ({ ...skill, score: 0 }));
}

function safeVersionPath(name) {
  const base = path.basename(String(name || ""));
  if (!base.endsWith(".md")) return null;
  const filePath = path.resolve(versionsDir, base);
  const root = path.resolve(versionsDir);
  if (!filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

function safeWorkspaceFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const filePath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
  const root = path.resolve(projectRoot);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

function collectNodeField(markdown, fieldName) {
  const values = new Map();
  let currentId = "";
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+.+$/);
    if (heading) {
      currentId = heading[1].trim();
      continue;
    }
    if (!currentId) continue;
    const field = line.match(new RegExp(`^-\\s+${fieldName}:\\s*(.*)$`));
    if (field) values.set(currentId, field[1].trim());
  }
  return values;
}

function mergePreservedNodeFields(incoming, current) {
  const completionByNode = collectNodeField(current, "Completion");
  if (!completionByNode.size) return incoming;

  const lines = String(incoming || "").split(/\r?\n/);
  const output = [];
  let currentId = "";
  let seenCompletion = false;

  function maybeInsertCompletion() {
    if (!currentId || seenCompletion || !completionByNode.has(currentId)) return;
    output.push(`- Completion: ${completionByNode.get(currentId)}`);
    seenCompletion = true;
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+.+$/);
    if (heading) {
      maybeInsertCompletion();
      currentId = heading[1].trim();
      seenCompletion = false;
      output.push(line);
      continue;
    }

    if (currentId && /^-\s+Completion:\s*/.test(line)) seenCompletion = true;
    if (currentId && /^-\s+Problem:\s*/.test(line)) maybeInsertCompletion();
    output.push(line);
  }

  maybeInsertCompletion();
  return output.join("\n");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    send(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  send(res, 200, body, mimeTypes[ext] || "application/octet-stream");
}

const server = http.createServer(async (req, res) => {
  try {
    const reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (reqPath === "/api/tree" && req.method === "GET") {
      const markdown = await readFile(treeFile, "utf8");
      send(res, 200, JSON.stringify({ markdown }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/project" && req.method === "GET") {
      send(res, 200, JSON.stringify({
        root: projectRoot,
        kitDir,
        name: path.basename(projectRoot),
        treeFile: path.relative(projectRoot, treeFile)
      }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/shutdown" && req.method === "POST") {
      jsonResponse(res, 200, { ok: true, message: "shutting down task tree server and local background services" });
      setTimeout(async () => {
        await shutdownBackgroundServices().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500);
      }, 50);
      return;
    }

    if (reqPath === "/api/tree" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      if (typeof body.markdown !== "string") {
        send(res, 400, JSON.stringify({ error: "markdown must be a string" }), "application/json; charset=utf-8");
        return;
      }
      const current = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      const markdown = mergePreservedNodeFields(body.markdown, current);
      if (current !== markdown && body.backup !== false) {
        await backupTree(body.reason || "将自动保存图谱修改");
      }
      await writeFile(treeFile, markdown, "utf8");
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/versions" && req.method === "GET") {
      send(res, 200, JSON.stringify({ versions: await listVersions() }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/skills/recommend" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const recommendations = await recommendSkills(body);
      send(res, 200, JSON.stringify({ recommendations }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/model-agents" && req.method === "GET") {
      jsonResponse(res, 200, await loadModelAgentDetails());
      return;
    }

    if (reqPath === "/api/model-agents" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, await saveModelAgents(body.models));
      return;
    }

    if (reqPath === "/api/model-agent-history" && req.method === "GET") {
      jsonResponse(res, 200, await readJsonFile(modelHistoryFile, {}));
      return;
    }

    if (reqPath === "/api/model-agent-history" && req.method === "DELETE") {
      await writeJsonFile(modelHistoryFile, {});
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (reqPath === "/api/knowledge/config" && req.method === "GET") {
      const config = await loadKnowledgeConfig();
      const webSearch = await loadWebSearchConfig();
      const index = await loadKnowledgeIndex();
      jsonResponse(res, 200, {
        config,
        index: {
          exists: existsSync(knowledgeIndexFile),
          createdAt: index.createdAt || "",
          docsDir: index.docsDir || "",
          embeddingModel: index.embeddingModel || "",
          totalChunks: Array.isArray(index.chunks) ? index.chunks.length : 0
        },
        reindex: knowledgeReindexStatus(),
        webSearch,
        copilot: {
          detected: existsSync(path.join(projectRoot, "copilot", ".obsidian")) || existsSync(path.join(kitDir, "copilot", ".obsidian")),
          note: "Copilot indexes are model-specific and large; this panel builds its own compatible index from markdown files."
        }
      });
      return;
    }

    if (reqPath === "/api/web-search/config" && req.method === "GET") {
      jsonResponse(res, 200, { config: await loadWebSearchConfig() });
      return;
    }

    if (reqPath === "/api/web-search/config" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, { config: await saveWebSearchConfig(body) });
      return;
    }

    if (reqPath === "/api/web-search/search" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, await searchWeb(body.query, { topK: body.topK }));
      return;
    }

    if (reqPath === "/api/knowledge/config" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, { config: await saveKnowledgeConfig(body) });
      return;
    }

    if (reqPath === "/api/knowledge/reindex" && req.method === "POST") {
      jsonResponse(res, 202, { ok: true, job: await startKnowledgeReindex() });
      return;
    }

    if (reqPath === "/api/knowledge/reindex-status" && req.method === "GET") {
      jsonResponse(res, 200, { job: knowledgeReindexStatus() });
      return;
    }

    if (reqPath === "/api/knowledge/search" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      jsonResponse(res, 200, await searchRetrieval(body.query, {
        topK: body.topK,
        includeKnowledge: body.includeKnowledge !== false,
        includeWeb: body.includeWeb === true
      }));
      return;
    }

    if (reqPath === "/api/knowledge/ask" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const question = String(body.question || "").trim();
      if (!question) {
        jsonResponse(res, 400, { error: "question is required" });
        return;
      }
      const search = await searchRetrieval(question, {
        topK: body.topK || 6,
        includeKnowledge: body.includeKnowledge !== false,
        includeWeb: body.includeWeb === true
      });
      const config = await loadKnowledgeConfig();
      const modelId = safeModelId(body.modelId || config.chat.modelId);
      if (!modelId) {
        jsonResponse(res, 400, { error: "select a chat model first" });
        return;
      }
      const agentConfig = await loadModelAgents({ includeKeys: true });
      const agent = agentConfig.models.find((item) => item.id === modelId);
      if (!agent) {
        jsonResponse(res, 404, { error: "chat model not found" });
        return;
      }
      const messages = [
        {
          role: "system",
          content: "Answer the user's question using the retrieved markdown knowledge base context. If the context is insufficient, say what is missing. Cite source paths in the answer."
        },
        {
          role: "user",
          content: [
            "Question:",
            question,
            "",
            "Retrieved context:",
            "```text",
            buildKnowledgeContext(search.results),
            "```"
          ].join("\n")
        }
      ];
      const answer = await callOpenAICompatible(agent, messages);
      jsonResponse(res, 200, { question, answer, results: search.results, errors: search.errors, modelId: agent.id, model: agent.model });
      return;
    }

    if (reqPath === "/api/model-agents/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map(safeModelId).filter(Boolean) : [];
      const question = String(body.question || "").trim();
      const nodeId = sanitizeGraphId(String(body.nodeId || ""));
      if (!modelIds.length || !question) {
        jsonResponse(res, 400, { error: "modelIds and question are required" });
        return;
      }
      const treeMarkdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
      const treeSnapshotHash = sha256Short(treeMarkdown);
      const nodeMarkdown = extractNodeMarkdown(treeMarkdown, nodeId);
      const providedKnowledgeContext = String(body.knowledgeContext || "").slice(0, 12000);
      const enableTools = body.useKnowledgeSearch === true;
      const includeWeb = body.includeWeb === true;
      const histories = body.histories && typeof body.histories === "object" ? body.histories : {};
      const sharedHistories = body.sharedHistories && typeof body.sharedHistories === "object" ? body.sharedHistories : {};
      const config = await loadModelAgents({ includeKeys: true });
      const agents = config.models.filter((item) => modelIds.includes(item.id));
      const started = Date.now();
      const results = await Promise.all(agents.map(async (agent) => {
        const itemStarted = Date.now();
        try {
          const agentPrompt = await readModelAgentPrompt(agent);
          const run = await runModelAgentWithTools({
            agent,
            agentPrompt,
            question,
            treeMarkdown,
            nodeMarkdown,
            history: histories[agent.id],
            sharedHistory: sharedHistories[agent.id],
            enableTools,
            includeWeb,
            providedKnowledgeContext
          });
          return {
            id: agent.id,
            name: agent.name,
            model: agent.model,
            ok: true,
            answer: run.answer,
            toolEvents: run.toolEvents,
            elapsedMs: Date.now() - itemStarted
          };
        } catch (error) {
          return {
            id: agent.id,
            name: agent.name,
            model: agent.model,
            ok: false,
            error: error.message,
            elapsedMs: Date.now() - itemStarted
          };
        }
      }));
      jsonResponse(res, 200, {
        nodeId,
        question,
        treeSnapshotHash,
        treeChangedDuringRun: sha256Short(existsSync(treeFile) ? await readFile(treeFile, "utf8") : "") !== treeSnapshotHash,
        elapsedMs: Date.now() - started,
        results,
        knowledgeResults: [],
        knowledgeErrors: []
      });
      return;
    }

    if (reqPath === "/api/restore" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const versionPath = safeVersionPath(body.name);
      if (!versionPath || !existsSync(versionPath)) {
        send(res, 404, JSON.stringify({ error: "version not found" }), "application/json; charset=utf-8");
        return;
      }
      const markdown = await readFile(versionPath, "utf8");
      await writeFile(treeFile, markdown, "utf8");
      send(res, 200, JSON.stringify({ ok: true, markdown, versions: await listVersions() }), "application/json; charset=utf-8");
      return;
    }

    if (reqPath === "/api/file" && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const filePath = safeWorkspaceFilePath(url.searchParams.get("path"));
      if (!filePath || !existsSync(filePath)) {
        send(res, 404, "File not found");
        return;
      }
      const info = await stat(filePath);
      if (!info.isFile()) {
        send(res, 400, "Path is not a file");
        return;
      }
      const body = await readFile(filePath, "utf8");
      send(res, 200, body, "text/plain; charset=utf-8");
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Task tree app running at http://${host}:${actualPort}`);
});
