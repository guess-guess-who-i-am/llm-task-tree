import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseEnv(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, index).trim()] = value;
  }
  return values;
}

function loadConfig(cwd, { environment = {}, model = "" } = {}) {
  let file = {};
  // Workers run in temporary Git worktrees, which intentionally do not copy the ignored
  // project `.env`. Resolve configuration from the owning project root as a second source.
  const globalEnvFile = process.env.TASK_TREE_GLOBAL_ENV_FILE || path.join(moduleRoot, ".env");
  const roots = [path.resolve(cwd || process.cwd()), process.env.TASK_TREE_PROJECT_ROOT, path.dirname(path.resolve(globalEnvFile))].filter(Boolean).map((root) => path.resolve(root));
  for (const root of [...new Set(roots)]) {
    try {
      const envFile = path.join(root, ".env");
      if (existsSync(envFile)) {
        for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) {
          if (String(value).trim() !== "") file[key] = value;
        }
      }
    } catch {}
  }
  const env = { ...file, ...process.env, ...environment };
  const baseUrl = String(env.MODEL_AGENT_MAIN_BASE_URL || env.TASK_TREE_PLANNER_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.MODEL_AGENT_MAIN_API_KEY || env.TASK_TREE_PLANNER_API_KEY || "").trim();
  const selectedModel = String(model || env.MODEL_AGENT_MAIN_MODEL || env.TASK_TREE_PLANNER_MODEL || "deepseek-v4.1-flash").trim();
  if (!baseUrl || !apiKey || !selectedModel) throw new Error("缺少 DeepSeek 配置：需要 MODEL_AGENT_MAIN_BASE_URL、MODEL_AGENT_MAIN_API_KEY、MODEL_AGENT_MAIN_MODEL");
  return { baseUrl, apiKey, model: selectedModel };
}

function contentFromChoice(choice) {
  const message = choice?.message || {};
  return {
    text: String(message.content || ""),
    reasoning: String(message.reasoning_content || message.reasoning || "")
  };
}

function usageOf(raw) {
  if (!raw) return null;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens ?? raw.totalTokens ?? input + output) || input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total, updatedAt: new Date().toISOString() };
}

async function readResponse(response, notify) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.body || !type.includes("text/event-stream")) {
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`DeepSeek 返回非 JSON：${raw.slice(0, 400)}`); }
    if (!response.ok) throw new Error(data?.error?.message || `DeepSeek HTTP ${response.status}`);
    const item = contentFromChoice(data?.choices?.[0]);
    return { ...item, usage: usageOf(data?.usage) };
  }

  let buffer = "";
  let text = "";
  let reasoning = "";
  let usage = null;
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      const delta = data?.choices?.[0]?.delta || {};
      const nextText = String(delta.content || "");
      const nextReasoning = String(delta.reasoning_content || delta.reasoning || "");
      if (nextText) { text += nextText; notify?.({ method: "item/updated", params: { item: { type: "agentMessage", delta: nextText } } }); }
      if (nextReasoning) { reasoning += nextReasoning; notify?.({ method: "item/updated", params: { item: { type: "reasoning", delta: nextReasoning } } }); }
      usage ||= usageOf(data?.usage);
    }
  }
  return { text, reasoning, usage };
}

export async function startDeepSeekTurn({
  prompt,
  cwd,
  model = "",
  environment = null,
  waitForCompletion = false,
  completionTimeoutMs = 10 * 60 * 1000,
  onUsage = null,
  onNotification = null,
  onAccepted = null,
  onCompleted = null
} = {}) {
  const config = loadConfig(cwd, { environment: environment || {}, model });
  const threadId = `deepseek-${randomUUID()}`;
  const turnId = `turn-${randomUUID()}`;
  const startedAt = Date.now();
  const timing = { startedAt: new Date(startedAt).toISOString(), requestMs: null, totalMs: null, provider: "deepseek" };
  let resolveRun;
  const run = new Promise((resolve) => { resolveRun = resolve; });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(completionTimeoutMs) || 600000));
  const notify = (message) => { try { onNotification?.({ ...message, params: { ...(message.params || {}), threadId, turnId } }); } catch {} };
  const execute = async () => {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: String(prompt || "") }], temperature: 0.2, max_tokens: 4000, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal
      });
      timing.requestMs = Date.now() - startedAt;
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      const result = await readResponse(response, notify);
      if (result.usage) onUsage?.(result.usage, { threadId, turnId });
      notify({ method: "item/completed", params: { item: { type: "agentMessage", text: result.text } } });
      const completed = { threadId, turnId, status: "completed", output: result.text, reasoning: result.reasoning, tokenUsage: result.usage, timing: { ...timing, totalMs: Date.now() - startedAt } };
      await onCompleted?.(completed);
      resolveRun(completed);
      return completed;
    } catch (error) {
      const completed = { threadId, turnId, status: "failed", error: { message: error?.name === "AbortError" ? "DeepSeek 请求超时" : String(error.message || error) }, timing: { ...timing, totalMs: Date.now() - startedAt } };
      await onCompleted?.(completed);
      resolveRun(completed);
      return completed;
    } finally {
      clearTimeout(timer);
    }
  };
  await onAccepted?.({ threadId, turnId });
  const running = execute();
  if (!waitForCompletion) return { threadId, turnId, resumed: false, status: "running", timing };
  return running;
}

export function deepSeekThreadLink(threadId) { return threadId ? `deepseek://runs/${threadId}` : ""; }
