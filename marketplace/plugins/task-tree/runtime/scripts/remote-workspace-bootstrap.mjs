import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, rm, stat, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localNetworkEnvironment } from '../server/network-environment.js';

export async function bootstrapRemoteWorkspace({ projectRoot, runtime, revision, globalEnvFile,
  stateBase = path.join(os.homedir(), '.local/share/task-tree-remote/projects') }) {
  const root = await realpath(projectRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('远程项目不是目录');
  const directory = path.join(stateBase, createHash('sha256').update(root).digest('hex').slice(0, 24));
  await mkdir(directory, { recursive: true });
  const marker = path.join(directory, 'service.json'), lock = path.join(directory, 'start.lock');
  const recordPort = async port => {
    await writeFile(path.join(root, '.task-tree-port'), `${port}\n`);
    await writeFile(path.join(root, '.task-tree-ports'), `${port}\n`);
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  let handle;
  const deadline = Date.now() + 60000;
  while (!handle) {
    try { handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lock, 'utf8').catch(() => ''));
      let alive = true;
      if (pid > 0) { try { process.kill(pid, 0); } catch (probeError) { alive = probeError.code !== 'ESRCH'; } }
      else {
        const lockInfo = await stat(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!lockInfo) continue;
        alive = Date.now() - lockInfo.mtimeMs < 60000;
      }
      if (!alive) { await rm(lock, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('另一个客户端正在启动此项目，请稍后重连');
      await pause();
    }
  }
  let child;
  try {
    let existing;
    try { existing = JSON.parse(await readFile(marker, 'utf8')); } catch {}
    if (existing?.port) {
      const info = await fetch(`http://127.0.0.1:${existing.port}/api/project`, { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);
      if (info?.root === root && info.executionHost?.mode === 'ssh') {
        await recordPort(existing.port);
        return { ...existing, root, hostname: os.hostname(), reused: true };
      }
      // A live process whose HTTP endpoint stopped responding may still own active tasks.
      if (existing.pid) {
        let alive = false;
        try { process.kill(existing.pid, 0); alive = true; } catch {}
        if (alive) throw new Error('旧后台仍在运行但暂未响应；保留其任务，请查看远程 server.log 后重连');
      }
    }
    // Preserve original project instructions/configuration in a recoverable installation backup.
    const backups = path.join(directory, 'install-backups', randomUUID());
    for (const name of ['AGENTS.md', 'llm-task-tree/task-tree.config.json', 'llm-task-tree/mcp-server.mjs']) {
      try { const bytes = await readFile(path.join(root, name)); await mkdir(path.dirname(path.join(backups, name)), { recursive: true }); await writeFile(path.join(backups, name), bytes); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await new Promise((resolve, reject) => {
      const install = spawn(process.execPath, [path.join(runtime, 'scripts/install-linux-project.mjs'), root, runtime,
        path.join(root, 'llm-task-tree'), '--preserve-existing-trees'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
      let errorText = ''; install.stderr.on('data', chunk => { errorText += chunk; });
      install.once('error', reject); install.once('exit', code => code === 0 ? resolve() : reject(new Error(`远程安装失败：${errorText}`)));
    });
    const readyFile = path.join(directory, `ready-${randomUUID()}.json`);
    // Read only network settings, without loading provider credentials into tools.
    // Node's environment proxy support must be enabled before spawning the process.
    const environmentFile = globalEnvFile || path.join(os.homedir(), '.config/task-tree/.env');
    const networkFile = path.join(path.dirname(environmentFile), 'network.json');
    let network = {};
    try { network = JSON.parse(await readFile(networkFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`远程网络配置无效：${networkFile}：${error.message}`); }
    const networkEnv = {};
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
      if (typeof network[key] === 'string') networkEnv[key] = network[key];
    }
    const environment = await localNetworkEnvironment({ ...process.env, ...networkEnv }, { platform: process.platform });
    const log = await open(path.join(directory, 'server.log'), 'a');
    let spawnError;
    child = spawn(process.execPath, [path.join(runtime, 'server.js')], { cwd: root, detached: true,
      stdio: ['ignore', log.fd, log.fd], env: { ...environment, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
        HOST: '127.0.0.1', PORT: '0', TASK_TREE_PROJECT_ROOT: root, TASK_TREE_STUB_DIR: path.join(root, 'llm-task-tree'),
        TASK_TREE_REMOTE_HOST: os.hostname(), TASK_TREE_REMOTE_READY_FILE: readyFile,
        TASK_TREE_GLOBAL_ENV_FILE: environmentFile } });
    child.on('error', error => { spawnError = error; }); child.unref(); await log.close();
    const startDeadline = Date.now() + 60000;
    while (Date.now() < startDeadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`远程后台退出 (${child.exitCode})，日志：${directory}/server.log`);
      let ready;
      try { ready = JSON.parse(await readFile(readyFile, 'utf8')); } catch {}
      if (ready?.port) {
        const info = await fetch(`http://127.0.0.1:${ready.port}/api/project`, { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);
        if (info?.root === root && info.executionHost?.mode === 'ssh') {
          const result = { root, hostname: os.hostname(), port: ready.port, pid: child.pid, revision, reused: false };
          // Tree MCP calls must find this exact backend instead of starting a second one.
          await recordPort(ready.port);
          const temp = `${marker}.${process.pid}.tmp`;
          await writeFile(temp, JSON.stringify(result)); await rename(temp, marker); await rm(readyFile, { force: true });
          child = null; return result;
        }
      }
      await pause();
    }
    throw new Error(`远程后台未就绪，日志：${directory}/server.log`);
  } finally {
    if (child?.pid) child.kill('SIGTERM');
    await handle.close(); await rm(lock, { force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await bootstrapRemoteWorkspace(JSON.parse(process.argv[2])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
