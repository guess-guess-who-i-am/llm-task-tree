import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

if (process.platform !== 'darwin') throw new Error('Run this operational test on macOS');
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'project-service-'));
const stub = path.join(fixture, 'llm-task-tree');
const label = 'local.task-tree.project-' + createHash('sha256').update(fixture).digest('hex').slice(0, 16);
const target = `gui/${process.getuid()}/${label}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
await mkdir(stub);
await writeFile(path.join(stub, 'task-tree.config.json'), JSON.stringify({ projectRoot: '..' }));
await writeFile(path.join(fixture, 'task-tree.md'), '# LLM Task Graph\n\n## ROOT - 恢复测试\n- Problem: 服务崩溃后恢复。\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n');
let url, killedPid;
const env = { ...process.env, NODE_BIN: process.execPath, TASK_TREE_NO_OPEN: '1' };
const start = async () => {
  const { stdout } = await run('bash', [path.join(root, 'llm-task-tree-kit/open-task-tree-macos.sh'), stub], { env });
  url = stdout.match(/Task tree: (http:\/\/[^\s]+)/)?.[1];
  assert.ok(url, stdout);
  assert.equal((await (await fetch(url + '/api/project')).json()).root, fixture);
};
async function available() {
  try { return (await fetch(url + '/api/project', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
}
try {
  await start();
  killedPid = Number((await readFile(path.join(fixture, '.task-tree-server.pid'), 'utf8')).trim());
  assert.ok(Number.isSafeInteger(killedPid) && killedPid > 1);
  const startTime = performance.now();
  process.kill(killedPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  const deadline = Date.now() + 12000;
  while (!(await available()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await available(), true, 'server must recover after a crash without another desktop click');
  const nextPid = Number((await readFile(path.join(fixture, '.task-tree-server.pid'), 'utf8')).trim());
  assert.notEqual(nextPid, killedPid);
  const installed = await readFile(plist, 'utf8');
  assert.match(installed, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(installed, /<key>SuccessfulExit<\/key><false\/>/);
  assert.ok(!/API_KEY|<string>sk-/.test(installed), 'do not persist inherited credentials');
  console.log('PASS crash recovery ms: ' + Math.round(performance.now() - startTime));
  await fetch(url + '/api/shutdown', { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await available(), false, 'explicit shutdown must stay stopped');
  await start();
  assert.equal(await available(), true, 'desktop entry restarts an explicitly stopped service');
  console.log('PASS login configuration, explicit stop, desktop restart, secret-free service file');
} finally {
  await run('launchctl', ['bootout', target]).catch(() => {});
  if (url) await fetch(url + '/api/shutdown', { method: 'POST' }).catch(() => {});
  await rm(plist, { force: true });
  await rm(fixture, { recursive: true, force: true });
}
