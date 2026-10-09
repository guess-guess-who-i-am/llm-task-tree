import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocols = ['2025-06-18', '2025-03-26', '2024-11-05'];

export async function createTaskTreeAgentTools({ cwd, environment = {}, signal, timeoutMs = 90_000 } = {}) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'mcp-server.mjs'), '--project-root', path.resolve(cwd || process.cwd())], {
    cwd: root, env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let id = 0;
  let buffer = '', stderr = '', closed = false;
  const pending = new Map();
  function rejectAll(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
  const close = async () => { closed = true; signal?.removeEventListener('abort', abort); rejectAll(new Error('任务树 MCP 已关闭')); try { child.stdin.end(); child.kill('SIGTERM'); } catch {} };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const i = buffer.indexOf('\n'); if (i < 0) break;
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
  });
  child.once('error', error => { closed = true; rejectAll(error); });
  child.once('close', code => { closed = true; signal?.removeEventListener('abort', abort); rejectAll(new Error(`任务树 MCP 退出（${code}）：${stderr.slice(-500)}`)); });
  child.stdin.on('error', error => rejectAll(error));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) return reject(new Error('任务树 MCP 已关闭'));
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`任务树 MCP ${method} 超时（${timeoutMs}ms）`)); void close(); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  try {
    const initialize = await request('initialize', { protocolVersion: protocols[0], capabilities: {}, clientInfo: { name: 'deepseek-agent', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`);
    const listed = await request('tools/list');
    const tools = (listed.tools || []).map(item => ({ type: 'function', function: { name: item.name, description: item.description || '', parameters: item.inputSchema || { type: 'object', properties: {} } } }));
    return {
      tools,
      instructions: initialize.instructions || '',
      serverInfo: initialize.serverInfo || {},
      call: async (name, args = {}) => {
        const result = await request('tools/call', { name, arguments: args });
        const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (result?.isError) throw new Error(text || `任务树工具失败：${name}`);
        try { return text ? JSON.parse(text) : result; } catch { return result; }
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
