import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const source = path.resolve(import.meta.dirname, '..');
const main = '# LLM Task Graph\n## ROOT - 真实目标\n- Problem: 使用摘要而不遗漏目标\n## N1 - 折叠分支\n- SubtreeFile: subtrees/N1.md\n- Notes: ONLY_FULL_MAIN\n## N2 - 独立分支\n- Problem: 可并发\n# GraphState\n- Current: ROOT\n- Next: N1\n# Edges\n## E1 - 分支\n- Endpoints: ROOT, N1\n';
const sub = '# LLM Task Graph Subtree\n> Fold root: N1\n## N1 - 当前子树根\n- Problem: 核心工作\n- CurrentResult: 开始之前\n## N1_A - 子树细节\n- Notes: ONLY_FULL_SUBTREE\n# GraphState\n- Current: N1\n- Next: N1_A\n# Edges\n## E_A - 子任务\n- Endpoints: N1, N1_A\n';

test('real node IDE starts with a map, supports optional full reads, and persists post-write summary', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tree-context-ide-'));
  const codexHome = path.join(cwd, 'codex'); await mkdir(codexHome);
  await mkdir(path.join(cwd, 'subtrees')); await writeFile(path.join(cwd, 'task-tree.md'), main);
  await writeFile(path.join(cwd, 'subtrees/N1.md'), sub);
  const captured = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captured.push(body);
    const calls = [
      ['task_tree_read', {}],
      ['task_tree_subtree', { action: 'read', path: 'subtrees/N1.md' }],
      ['task_tree_write', { nodeId: 'N1', fields: { CurrentResult: '本轮实际保存的新结果' }, reason: '上下文端到端测试' }]
    ];
    const call = calls[captured.length - 1];
    const message = call ? { content: '', tool_calls: [{ id: `c${captured.length}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { content: '本轮已完成，已保存新结果。' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(source, 'server.js')], { cwd: source,
    env: { ...process.env, CODEX_HOME: codexHome, PORT: '0', TASK_TREE_PROJECT_ROOT: cwd, TASK_TREE_NO_OPEN: '1',
      MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${provider.address().port}`, MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => provider.close(resolve)); });
  const url = await new Promise((resolve, reject) => {
    let log = '', stderr = '';
    child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', c => { log += c; const match = log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', reject);
  });
  const accepted = await (await fetch(url + '/api/codex/run', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ progress: true, nodeId: 'N1', treeId: 'method', prompt: '保存新结果' }) })).json();
  let run;
  for (let i = 0; i < 300; i++) {
    run = (await (await fetch(url + '/api/codex/run/' + accepted.id)).json()).run;
    if (!['starting', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.status, 'completed', run.error);
  const seeds = captured[0].messages.filter(m => m.role === 'tool');
  assert.deepEqual(seeds.map(m => m.name), ['task_tree_focus', 'task_tree_summary']);
  assert.doesNotMatch(JSON.stringify(seeds), /ONLY_FULL_MAIN|ONLY_FULL_SUBTREE/);
  assert.equal(captured[1].messages.at(-1).name, 'task_tree_read');
  assert.equal(JSON.parse(captured[1].messages.at(-1).content).markdown, main);
  assert.match(captured[2].messages.at(-1).content, /ONLY_FULL_SUBTREE/);
  const directory = path.join(cwd, '.task-tree-maintenance/tree-summaries');
  const saved = JSON.parse(await readFile(path.join(directory, (await readdir(directory))[0]), 'utf8'));
  assert.equal(saved.nodes.find(n => n.id === 'N1').fields.CurrentResult, '本轮实际保存的新结果');
  assert.doesNotMatch(JSON.stringify(saved), /ONLY_FULL_SUBTREE/);
  assert.equal(await readFile(path.join(cwd, 'task-tree.md'), 'utf8'), main);
  const note = run.events.find(e => e.type === 'tool/completed' && e.toolName === 'task_tree_write');
  assert.equal(note.result.ok, true);
  assert.equal(note.result.receiptVerification.readBack, true);
});
