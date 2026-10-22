import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const digest = value => createHash('sha256').update(value).digest('hex');
export function normalizeSshProfile(input = {}) {
  const host = String(input.host || '').trim();
  if (!host || !/^[\w.:-]+$/.test(host) || host.startsWith('-')) throw new Error('请填写 SSH 别名或服务器地址');
  const projectRoot = String(input.projectRoot || '').trim();
  if (!projectRoot.startsWith('/') || projectRoot === '/' || /[\r\n\0]/.test(projectRoot)) throw new Error('远程项目须为绝对目录，且不能是根目录');
  const user = String(input.user || '').trim();
  if (user && !/^[\w.-]+$/.test(user)) throw new Error('SSH 用户名无效');
  const port = input.port ? Number(input.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('SSH 端口无效');
  const result = { host, projectRoot, ...(user && { user }), ...(port && { port }) };
  for (const field of ['identityFile', 'nodePath', 'globalEnvFile']) {
    const value = String(input[field] || '').trim();
    if (/[\r\n\0]/.test(value)) throw new Error(`${field} 不能包含换行`);
    if (value) result[field] = value;
  }
  result.id = digest(JSON.stringify(result)).slice(0, 20);
  result.name = String(input.name || `${host}: ${projectRoot}`).trim();
  return result;
}

export function sshArguments(profile, controlPath) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', `ControlPath=${controlPath}`];
  if (profile.port) args.push('-p', String(profile.port));
  if (profile.user) args.push('-l', profile.user);
  if (profile.identityFile) args.push('-i', profile.identityFile.replace(/^~(?=\/)/, os.homedir()));
  return args;
}

export function runProcess(command, args, { inputFile, timeout = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', input;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} 连接或部署超时`)); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); input?.destroy();
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} 失败 (${code})：${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.on('error', () => {});
    if (inputFile) { input = createReadStream(inputFile); input.on('error', error => { child.kill(); reject(error); }); input.pipe(child.stdin); }
    else child.stdin.end();
  });
}

// Explicit runtime roots: no project files, API configuration, SSH keys or experiment workspaces.
export async function buildRemoteBundle(kitDir) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'task-tree-runtime-'));
  const stage = path.join(temporary, 'runtime');
  await mkdir(stage);
  const filter = source => !path.basename(source).startsWith('.') &&
    !['node_modules', 'versions', 'steps', 'worker', 'isolated'].includes(path.basename(source)) && !/\.test\.js$/.test(source);
  try {
    for (const name of ['server', 'public', 'scripts', 'skills', 'server.js', 'package.json', 'package-lock.json',
      'AGENTS.task-tree.md', 'AGENTS.node-writing.md', 'start-task-tree.sh']) {
      await cp(path.join(kitDir, name), path.join(stage, name), { recursive: true, filter }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    for (const name of ['AGENTS.task-tree.md', 'AGENTS.node-writing.md', 'start-task-tree.sh']) {
      try { await readFile(path.join(stage, name)); }
      catch { await cp(path.join(kitDir, 'llm-task-tree-kit', name), path.join(stage, name)); }
    }
    let templates = path.join(kitDir, 'templates');
    try { await readdir(templates); } catch { templates = path.join(kitDir, 'llm-task-tree-kit', 'templates'); }
    await cp(templates, path.join(stage, 'templates'), { recursive: true, filter });
    const hash = createHash('sha256');
    async function visit(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else { hash.update(path.relative(stage, file)); hash.update(await readFile(file)); }
      }
    }
    await visit(stage);
    const archive = path.join(temporary, 'runtime.tgz');
    await runProcess('tar', ['-czf', archive, '-C', stage, '.']);
    return { temporary, archive, revision: hash.digest('hex').slice(0, 24) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function probeRemoteProject(url) {
  const response = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`远程后台返回 HTTP ${response.status}`);
  return response.json();
}

export function createRemoteSshManager({ kitDir, homeDir = os.homedir(), run = runProcess, bundleBuilder = buildRemoteBundle,
  probe = probeRemoteProject } = {}) {
  const file = path.join(homeDir, 'LLMTaskTree', 'remote-ssh.json');
  // macOS TMPDIR is too long for OpenSSH's Unix socket plus its temporary suffix.
  const socketDir = path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `task-tree-ssh-${process.getuid?.() || 'user'}`);
  const jobs = new Map(), pending = new Map(), connections = new Map();
  let writeQueue = Promise.resolve();
  async function profiles() { try { return JSON.parse(await readFile(file, 'utf8')).profiles || []; } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  async function save(input) {
    const profile = normalizeSshProfile(input);
    const action = writeQueue.then(async () => {
      const list = await profiles();
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ profiles: [...list.filter(item => item.id !== profile.id), profile] }, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, file);
      return profile;
    });
    writeQueue = action.catch(() => {});
    return action;
  }
  async function list() {
    let config = '';
    try { config = await readFile(path.join(homeDir, '.ssh', 'config'), 'utf8'); } catch {}
    const aliases = [...new Set([...config.matchAll(/^\s*Host\s+(.+)$/gmi)].flatMap(match => match[1].split(/\s+/))
      .filter(value => /^[\w.:-]+$/.test(value) && !value.startsWith('-')))];
    const list = await profiles();
    return { profiles: await Promise.all(list.map(async profile => {
      const connection = connections.get(profile.id);
      const connected = connection ? await probe(connection.url).then(info => info.root === connection.root, () => false) : false;
      return { ...profile, connected, ...(connected && { url: connection.url }) };
    })), aliases };
  }
  const socket = profile => path.join(socketDir, profile.id);
  async function disconnect(id) {
    const profile = (await profiles()).find(item => item.id === id);
    if (!profile) throw new Error('未找到 SSH 连接');
    if (pending.has(id)) throw new Error('连接正在建立，请等待完成后再断开');
    await run('ssh', [...sshArguments(profile, socket(profile)), '-O', 'exit', profile.host]).catch(error => {
      if (!/No such file|not running|Connection refused/.test(error.message)) throw error;
    });
    connections.delete(id);
    return { id, message: '本地隧道已断开，远程任务继续运行' };
  }
  async function connect(input) {
    if (input.id && !input.host) {
      const saved = (await profiles()).find(profile => profile.id === input.id);
      if (!saved) throw new Error('未找到 SSH 连接');
      input = { ...saved, ...input };
    }
    const profile = await save(input);
    if (pending.has(profile.id)) return jobs.get(pending.get(profile.id));
    const job = { id: randomUUID(), profileId: profile.id, status: 'running', stage: 'ssh', message: '正在连接 SSH…', startedAt: new Date().toISOString() };
    jobs.set(job.id, job); pending.set(profile.id, job.id);
    const update = (stage, message) => Object.assign(job, { stage, message });
    void (async () => {
      let bundle, forwarding;
      try {
        await mkdir(socketDir, { recursive: true, mode: 0o700 });
        const args = sshArguments(profile, socket(profile));
        if (!await run('ssh', [...args, '-O', 'check', profile.host]).then(() => true, () => false))
          await run('ssh', [...args, '-M', '-o', 'ControlPersist=yes', '-fN', profile.host]);
        update('environment', '正在检查服务器 Node、Git 和项目目录…');
        const nodeCommand = profile.nodePath ? `node_bin=${shellQuote(profile.nodePath)}` : 'node_bin="$HOME/.local/bin/node"; if [ ! -x "$node_bin" ]; then node_bin=$(command -v node); fi';
        const environment = JSON.parse(await run('ssh', [...args, profile.host,
          `set -e; ${nodeCommand}; "$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("需要 Node 22 或更新版本");console.log(JSON.stringify({node:process.execPath,home:require("os").homedir()}))'; command -v git >/dev/null; command -v tar >/dev/null; test -d ${shellQuote(profile.projectRoot)}`]));
        update('bundle', '正在准备独立运行时（不复制本地项目）…');
        bundle = await bundleBuilder(kitDir);
        const runtime = `${environment.home}/.local/share/task-tree-remote/runtimes/${bundle.revision}`;
        const q = shellQuote;
        const ready = await run('ssh', [...args, profile.host, `test -f ${q(runtime + '/.ready')} && printf ready`]).then(() => true, () => false);
        if (!ready) {
          update('upload', '正在上传 IDE 运行时…');
          await run('ssh', [...args, profile.host, `set -e; mkdir -p ${q(runtime)}; tar -xzf - -C ${q(runtime)}`], { inputFile: bundle.archive });
          update('dependencies', '首次安装远程运行依赖…');
          const install = registry => run('ssh', [...args, profile.host, `set -e; cd ${q(runtime)}; export PATH=${q(path.posix.dirname(environment.node))}:"$PATH"; npm ci --omit=dev --no-audit --no-fund --prefer-offline --fetch-timeout=30000 --fetch-retries=1${registry ? ` --registry=${q(registry)}` : ''} >&2; touch .ready`], { timeout: 300000 });
          try { await install(); }
          catch (error) {
            if (!/ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|network|部署超时/i.test(error.message)) throw error;
            update('dependencies', 'npm 官方源网络异常，正在尝试备用源…');
            await install('https://registry.npmmirror.com');
          }
        }
        update('backend', '正在启动或复用远程项目后台…');
        const receipt = JSON.parse(await run('ssh', [...args, profile.host,
          `${q(environment.node)} ${q(runtime + '/scripts/remote-workspace-bootstrap.mjs')} ${q(JSON.stringify({ projectRoot: profile.projectRoot, runtime, revision: bundle.revision, globalEnvFile: profile.globalEnvFile }))}`]));
        update('tunnel', '正在建立本地 SSH 隧道…');
        let localPort;
        for (let attempt = 0; attempt < 3; attempt++) {
          localPort = await availablePort();
          try { await run('ssh', [...args, '-O', 'forward', '-L', `127.0.0.1:${localPort}:127.0.0.1:${receipt.port}`, profile.host]); break; }
          catch (error) { if (attempt === 2 || !/Address already in use|cannot listen/.test(error.message)) throw error; }
        }
        const url = `http://127.0.0.1:${localPort}`;
        forwarding = { args, profile, localPort, remotePort: receipt.port };
        const info = await probe(url);
        if (info.root !== receipt.root || info.executionHost?.mode !== 'ssh' || info.executionHost?.hostname !== receipt.hostname)
          throw new Error('远程后台身份与目标项目不一致，未打开该页面');
        const previous = connections.get(profile.id);
        connections.set(profile.id, { url, root: receipt.root, localPort, remotePort: receipt.port });
        forwarding = null;
        if (previous) await run('ssh', [...args, '-O', 'cancel', '-L', `127.0.0.1:${previous.localPort}:127.0.0.1:${previous.remotePort}`, profile.host]).catch(() => {});
        Object.assign(job, { status: 'completed', stage: 'ready', message: '远程工作区已连接', url, root: receipt.root, hostname: receipt.hostname, reused: receipt.reused, runtimeRevision: receipt.revision });
      } catch (error) { Object.assign(job, { status: 'failed', error: error.message, message: `连接失败：${error.message}` }); }
      finally {
        if (forwarding) await run('ssh', [...forwarding.args, '-O', 'cancel', '-L', `127.0.0.1:${forwarding.localPort}:127.0.0.1:${forwarding.remotePort}`, forwarding.profile.host]).catch(() => {});
        if (bundle) await rm(bundle.temporary, { recursive: true, force: true }).catch(() => {});
        pending.delete(profile.id); job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }
  return { list, save, connect, disconnect, job: id => jobs.get(id) };
}
