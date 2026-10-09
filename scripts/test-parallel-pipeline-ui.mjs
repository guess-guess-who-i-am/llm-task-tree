import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findChromium } from '../server/graph-render.js';

// Real browser -> HTTP -> planner -> shared tools -> Git isolation -> auto-apply.
// Only inference is deterministic; this proves wiring/concurrency, not model quality.
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'parallel-pipeline-ui-'));
const project = path.join(fixture, 'project'), codexHome = path.join(fixture, 'codex'), providerRoot = path.join(fixture, 'provider');
for (const dir of [project, codexHome, providerRoot]) await mkdir(dir);
const main = '# LLM Task Graph\n## ROOT - 保留原工程树\n- Problem: 不覆盖源树\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
await writeFile(path.join(project, 'task-tree.md'), main);
await writeFile(path.join(project, '.gitignore'), '.env\n.task-tree-runs/\n.task-tree-maintenance/\n');
await mkdir(path.join(project, 'trees'));
await writeFile(path.join(project, 'trees/selected.md'), main.replace('保留原工程树', '选中的工程树'));
await writeFile(path.join(project, 'task-trees.json'), JSON.stringify({ activeMethod: 'method', trees: [
  { id: 'method', title: '源工程', role: 'method', path: 'task-tree.md' },
  { id: 'selected', title: '选中的工程树', role: 'reference', path: 'trees/selected.md' }
] }));
const jobs = Array.from({ length: 8 }, (_, i) => ({ taskId: `job${i}`, nodeId: 'ROOT', title: `独立结果${i}`,
  instruction: `保存第${i}项结果`, writeSet: [`job${i}.txt`], dependsOn: [] }));
jobs.push({ taskId: 'gather', nodeId: 'ROOT', title: '整合结果', instruction: '读取八项结果并保存整合结论', writeSet: ['gather.txt'], dependsOn: jobs.map(j => j.taskId) });
let release; const barrier = new Promise(resolve => { release = resolve; });
let initialRequests = 0, activeRequests = 0, maximumRequests = 0, workerPid;
const rounds = new Map(), errors = [], timing = {}, startedAt = performance.now();
const provider = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = body.messages.findLast(m => m.role === 'user' && typeof m.content === 'string')?.content || '';
    let message;
    if (prompt.includes('Automatic Parallel Planner')) {
      assert.match(prompt, /选中的工程树/);
      timing.plannerReachedMs = performance.now() - startedAt;
      message = { content: JSON.stringify({ summary: '八项就绪并行，再整合', coverage: [], jobs }) };
    } else if (prompt.includes('Single Parallel Branch Planner')) {
      message = { content: JSON.stringify({ job: { taskId: 'extra', nodeId: 'ROOT', title: '追加结果', instruction: '保存追加结果', writeSet: ['extra.txt'], dependsOn: [] } }) };
    } else {
      const id = prompt.match(/^Task id: (.+)$/m)?.[1]; assert.ok(id, 'unexpected model prompt');
      const count = (rounds.get(id) || 0) + 1; rounds.set(id, count);
      if (count === 1) {
        const branch = prompt.match(/^Execution node: (.+)$/m)?.[1]; assert.ok(branch);
        const seed = body.messages.filter(m => m.role === 'tool' && m.name === 'task_tree_node').at(-1);
        assert.equal(JSON.parse(seed.content).id, branch, 'real tool pre-read must use the isolated branch');
        if (id.startsWith('job')) {
          activeRequests++; maximumRequests = Math.max(maximumRequests, activeRequests);
          if (++initialRequests === 8) release();
          await barrier; activeRequests--;
        }
        const script = id === 'gather'
          ? `const fs=require('fs'); for(let i=0;i<8;i++)if(fs.readFileSync('job'+i+'.txt','utf8')!=='result job'+i)throw Error('dependency missing'); fs.writeFileSync('gather.txt','all eight integrated');`
          : `require('fs').writeFileSync('${id}.txt','result ${id}');`;
        message = { content: '正在保存独立分支结果。', tool_calls: [
          { id: `${id}-write`, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ command: `node -e ${JSON.stringify(script)}` }) } },
          { id: `${id}-tree`, type: 'function', function: { name: 'task_tree_write', arguments: JSON.stringify({ nodeId: branch, fields: { Completion: '已完成', CurrentResult: `已实际保存 ${id} 结果。` }, reason: '并行端到端工具写树' }) } }
        ] };
      } else {
        for (const tool of body.messages.filter(m => m.role === 'tool' && m.tool_call_id.startsWith(id + '-'))) {
          const result = JSON.parse(tool.content);
          assert.equal(result.ok, true, `real tool failed: ${tool.name}: ${JSON.stringify(result)}`);
        }
        message = { content: JSON.stringify({ event: 'completed', evidence: `已保存 ${id}`, peerRequests: [] }) };
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { errors.push(error.message); res.writeHead(500); res.end('fixture failed'); }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(providerRoot, '.env'), `MODEL_AGENT_MAIN_BASE_URL=http://127.0.0.1:${provider.address().port}\nMODEL_AGENT_MAIN_API_KEY=fixture-not-a-secret\nMODEL_AGENT_MAIN_MODEL=fixture\n`);
let child, browser, url;
const children = [];
async function waitFor(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value;
    if (errors.length) throw new Error(errors.join('\n'));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`timeout: ${label}`);
}
try {
  const environment = { ...process.env, CODEX_HOME: codexHome, PORT: '0', TASK_TREE_PROJECT_ROOT: project,
    TASK_TREE_GLOBAL_ENV_FILE: path.join(providerRoot, '.env'), TASK_TREE_NO_OPEN: '1', PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` };
  for (const key of Object.keys(environment)) if (/^(MODEL_AGENT_|TASK_TREE_PLANNER_)/.test(key)) delete environment[key];
  child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  url = await new Promise((resolve, reject) => {
    let out = '', error = ''; const timer = setTimeout(() => reject(new Error('server start: ' + error)), 10000);
    child.stderr.on('data', chunk => { error += chunk; });
    child.stdout.on('data', chunk => { out += chunk; const m = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once('error', reject);
  });
  const { chromium } = createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
  const executablePath = findChromium();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url + '?tree=selected', { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => typeof viewTreeId !== 'undefined' && viewTreeId === 'selected'), 'tree selection');
  await page.evaluate(() => { document.querySelector('#projectOverviewDialog')?.close(); });
  await page.locator('#codexParallelBtn').click();
  const run = await waitFor(async () => {
    const value = await page.evaluate(() => codexParallelRun);
    if (value?.status === 'failed') throw new Error(value.error);
    return value?.status === 'accepted' ? value : null;
  }, 'parallel auto-apply');
  assert.equal(run.jobs.length, 9); assert.equal(maximumRequests, 8);
  assert.equal(run.sourceTree.path, 'trees/selected.md');
  assert.equal(await readFile(path.join(project, 'gather.txt'), 'utf8'), 'all eight integrated');
  assert.equal(await readFile(path.join(project, 'task-tree.md'), 'utf8'), main);
  assert.equal(new Set(run.jobs.map(j => j.executionNodeId)).size, 9);
  const record = JSON.parse(await readFile(path.join(project, '.task-tree-runs', run.id + '.json'), 'utf8'));
  for (const job of run.jobs) {
    assert.match(await readFile(path.join(project, job.subtreeFile), 'utf8'), new RegExp(`已实际保存 ${job.taskId}`));
    assert.equal(rounds.get(job.taskId), 2);
    const stats = record.events.find(e => e.type === 'worker_turn_timing' && e.taskId === job.taskId)?.timing;
    workerPid ||= stats?.workerPid;
    assert.equal(stats?.workerPid, workerPid, 'all branches reuse the same shared worker process');
  }
  await page.locator('#parallelOpenTree').click();
  await waitFor(() => page.evaluate(id => viewTreeId === id && nodes.length === 10, run.branchTree.id), 'editable execution tree');
  await page.locator('.graphNode.folded [data-action="edit-subtree"]').first().click();
  await waitFor(() => page.evaluate(() => workspaceMode === 'subtree'), 'enter branch subtree');
  await waitFor(() => page.evaluate(() => !workspaceSwitchInFlight), 'enter animation completed');
  assert.equal(await page.evaluate(() => workspaceMode), 'subtree');
  await page.locator('.graphNode').first().waitFor();
  await page.screenshot({ path: path.join(root, 'artifacts/parallel-pipeline-ui.png') });
  await page.locator('#workspaceBannerExitBtn').click();
  await waitFor(() => page.evaluate(() => workspaceMode === 'main' && !workspaceSwitchInFlight), 'return from branch subtree');
  assert.equal(await page.evaluate(() => workspaceMode), 'main');
  timing.totalMs = performance.now() - startedAt;
  const report = { ok: true, fixture, url, maximumConcurrentRequests: maximumRequests, jobs: run.jobs.length,
    sharedWorkerPid: workerPid, modelRoundsPerBranch: 2, sourceTreePreserved: true, realToolWrites: 18,
    timing, workspaceTimings: record.workspaceTimings, gitCommandTimings: record.gitCommandTimings,
    limitation: '本机模型替身验证接线、并行、工具、合并与界面；不代表真实 DeepSeek 的拆分质量或网关速度。' };
  await writeFile(path.join(root, 'docs/parallel-pipeline-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  release(); await browser?.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  // The isolated shared broker owns any auto-started worktree IDE servers.
  if (workerPid) {
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    const found = await promisify(execFile)('pgrep', ['-P', String(workerPid)]).catch(() => ({ stdout: '' }));
    for (const pid of found.stdout.split(/\s+/).filter(Boolean).map(Number)) try { process.kill(pid, 'SIGTERM'); } catch {}
    try { process.kill(workerPid, 'SIGTERM'); } catch {}
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
