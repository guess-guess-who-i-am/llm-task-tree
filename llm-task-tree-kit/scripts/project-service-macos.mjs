import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localNetworkEnvironment } from '../server/network-environment.js';

const run = promisify(execFile);
const [mode, stubDir, projectRoot, port, host, envFile] = process.argv.slice(2);
const kitRoot = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'darwin') throw new Error('macOS project service requires launchd');

if (mode === 'serve') {
  const child = spawn(process.execPath, [path.join(kitRoot, 'server.js')], {
    cwd: projectRoot,
    env: await localNetworkEnvironment({ ...process.env, HOST: host, PORT: port,
      TASK_TREE_STUB_DIR: stubDir, TASK_TREE_PROJECT_ROOT: projectRoot,
      TASK_TREE_GLOBAL_ENV_FILE: envFile }),
    stdio: 'inherit'
  });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  if (child.pid) await writeFile(path.join(projectRoot, '.task-tree-server.pid'), `${child.pid}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  // Successful shutdown stays stopped; a crash is restarted by launchd.
  child.once('exit', code => process.exit(code ?? 1));
} else if (mode === 'start') {
  const label = 'local.task-tree.project-' + createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  const domain = `gui/${process.getuid()}`;
  const file = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [process.execPath, path.join(kitRoot, 'scripts/project-service-macos.mjs'), 'serve', stubDir, projectRoot, port, host, envFile];
  const log = path.join(projectRoot, '.task-tree-server.log');
  // Only paths and normal executable search paths are persisted, never inherited API keys.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>2</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
  const previous = await readFile(file, 'utf8').catch(() => '');
  const registered = await run('launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false);
  if (registered && previous !== plist) await run('launchctl', ['bootout', `${domain}/${label}`]);
  if (previous !== plist) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, plist, { mode: 0o600 });
  }
  if (!registered || previous !== plist) await run('launchctl', ['bootstrap', domain, file]);
  else await run('launchctl', ['kickstart', `${domain}/${label}`]);
} else throw new Error('Expected start or serve');
