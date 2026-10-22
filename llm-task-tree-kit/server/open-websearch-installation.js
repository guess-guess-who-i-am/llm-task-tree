import { existsSync } from 'node:fs';
import path from 'node:path';

// The published package already contains build/, unlike a source checkout.
export function resolveSearchInstallation(kitDir, projectRoot) {
  const packaged = path.join(kitDir, 'node_modules/open-websearch');
  const candidates = [packaged, path.join(kitDir,'open-webSearch'), path.join(projectRoot,'open-webSearch'),
    path.resolve(kitDir,'../open-webSearch'), path.resolve(projectRoot,'../open-webSearch')];
  const dir = candidates.find(dir=>existsSync(path.join(dir,'package.json'))) || path.join(kitDir,'open-webSearch');
  return {dir, entry:path.join(dir,'build/index.js'), packaged:dir===packaged};
}

export function searchDaemonEnvironment(environment) {
  const env = {...environment};
  // Upstream deliberately ignores HTTP(S)_PROXY; map the host's proxy explicitly.
  const proxy = env.PROXY_URL || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if(proxy) {env.USE_PROXY ??= 'true';env.PROXY_URL ||= proxy;}
  return env;
}
