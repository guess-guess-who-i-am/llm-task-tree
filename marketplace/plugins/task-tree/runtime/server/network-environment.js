import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as net from 'node:net';
const run = promisify(execFile);

// On the SSH host the default 250 ms address race aborts healthy IPv4
// connections before they finish. Keep the OS/DNS-selected address rather
// than imposing a shorter connection deadline than the API's own deadline.
// This restores the previous Node 18 behavior only for remote IDE processes.
export function configureNetworkRuntime({ environment = process.env, network = net } = {}) {
  const value = environment.TASK_TREE_NETWORK_AUTOSELECT_FAMILY;
  if (value === 'true' || value === 'false') network.setDefaultAutoSelectFamily?.(value === 'true');
  else if (environment.TASK_TREE_REMOTE_HOST) network.setDefaultAutoSelectFamily?.(false);
}

// Node's maintained proxy implementation is enabled at process startup. Respect explicit
// environment configuration, and use the actual macOS system proxy for Finder launches.
export async function localNetworkEnvironment(environment = process.env, { platform = process.platform, readProxy = async () => (await run('/usr/sbin/scutil', ['--proxy'], {timeout:2000})).stdout } = {}) {
  const env = { ...environment };
  if (platform === 'darwin' && !env.HTTPS_PROXY && !env.https_proxy && !env.HTTP_PROXY && !env.http_proxy) {
    const config = await readProxy().catch(() => '');
    const value = key => config.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim();
    for (const [kind, name] of [['HTTPS', 'HTTPS_PROXY'], ['HTTP', 'HTTP_PROXY']]) {
      const host = value(`${kind}Proxy`), port = value(`${kind}Port`);
      if (value(`${kind}Enable`) === '1' && host && /^\d+$/.test(port || '')) env[name] = `http://${host}:${port}`;
    }
  }
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    env.NODE_USE_ENV_PROXY = '1';
    // Task-tree HTTP/MCP transport is loopback and must remain local.
    env.NO_PROXY = [...new Set([...(env.NO_PROXY || env.no_proxy || '').split(',').filter(Boolean), 'localhost', '127.0.0.1', '::1'])].join(',');
  }
  return env;
}
