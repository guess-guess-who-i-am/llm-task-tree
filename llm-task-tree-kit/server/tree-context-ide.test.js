import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const source = path.resolve(import.meta.dirname, '..');
const main = '# LLM Task Graph\n## ROOT - 真实目标\n- Problem: 使用摘要而不遗漏目标\n- Approach: ROOT_METHOD_ANCHOR\n- Metrics: ROOT_ACCEPTANCE_ANCHOR\n## N1 - 折叠分支\n- SubtreeFile: subtrees/N1.md\n- Notes: ONLY_FULL_MAIN\n## N2 - 独立分支\n- Problem: 可并发\n# GraphState\n- Current: ROOT\n- Next: N2\n# Edges\n## E1 - 分支\n- Endpoints: ROOT, N1\n';
const sub = '# LLM Task Graph Subtree\n> Fold root: N1\n## N1 - 当前子树根\n- Problem: 核心工作\n- CurrentResult: 开始之前\n## N1_A - 子树细节\n- Notes: ONLY_FULL_SUBTREE\n# GraphState\n- Current: N1\n- Next: N1_A\n# Edges\n## E_A - 子任务\n- Endpoints: N1, N1_A\n';

test('real node IDE starts with a map, supports optional full reads, and persists post-write summary', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tree-context-ide-'));
  const codexHome = path.join(cwd, 'codex'); await mkdir(codexHome);
  await mkdir(path.join(cwd, 'subtrees')); await writeFile(path.join(cwd, 'task-tree.md'), main);
  await writeFile(path.join(cwd, 'subtrees/N1.md'), sub);
  const captured = [];
  let workerStep = 0;
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captured.push(body);
    if (body.tool_choice === 'required' && body.tools?.some(t => t.function.name === 'task_tree_continue_single')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'mode', type: 'function', function: { name: 'task_tree_continue_single', arguments: JSON.stringify({ reason: '定点树回写回归，无独立分支', nextCheckpoint: '读取并保存指定节点' }) } }] } }] })); return;
    }
    const content = body.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
    if (content.includes('【功能验收】')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: '隔离候选已核对', tool_calls: [{ id: 'review-submit', type: 'function', function: { name: 'completion_review_submit', arguments: JSON.stringify({ verdict: 'pass', reason: '隔离候选已核对', evidence: ['候选树实际写入'] }) } }] } }] }));
      return;
    }
    const calls = [
      ['task_tree_read', {}],
      ['task_tree_subtree', { action: 'read', path: 'subtrees/N1.md' }],
      ['task_tree_write', { nodeId: 'N1', fields: { CurrentResult: '本轮实际保存的新结果' }, reason: '上下文端到端测试' }]
    ];
    const call = calls[workerStep++];
    const message = call ? { content: '', tool_calls: [{ id: `c${captured.length}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { content: '本轮已完成，已保存新结果。' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(source, 'server.js')], { cwd: source,
    env: { ...process.env, CODEX_HOME: codexHome, PORT: '0', TASK_TREE_PROJECT_ROOT: cwd, TASK_TREE_NO_OPEN: '1',
      TASK_TREE_GLOBAL_ENV_FILE: path.join(cwd,'.env'), TASK_TREE_API_CONNECTIONS_FILE: path.join(cwd,'api-connections.json'),
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
  for (let i = 0; i < 500 && !captured.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(captured.length, 'first request must arrive');
  const seeds = captured[0].messages.filter(m => m.role === 'tool');
  const firstText = captured[0].messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  console.log('node-first-request-bytes', Buffer.byteLength(JSON.stringify(captured[0])), 'context-text-bytes', Buffer.byteLength(firstText));
  assert.deepEqual(seeds.map(m => m.name), ['task_tree_node']);
  assert.equal(firstText.split('task-tree-summary/v1').length - 1, 1, 'tree summary must be carried exactly once');
  assert.doesNotMatch(firstText, /PROJECT_TASK_TREE_CHECKPOINT_V1|use GraphState.Next as the default target|No Agent execution scope is active, so GraphState.Next/);
  assert.match(firstText, /ROOT_METHOD_ANCHOR/); assert.match(firstText, /ROOT_ACCEPTANCE_ANCHOR/);
  assert.match(firstText, /执行节点：N1/);
  assert.match(firstText, /task_tree_plan_execute/);
  const summary = captured[0].messages.find(m => m.role === 'system' && m.content.includes('【当前任务树状态】'));
  assert.doesNotMatch(summary.content, /ONLY_FULL_MAIN|ONLY_FULL_SUBTREE/);
  assert.match(seeds.find(m => m.name === 'task_tree_node').content, /ONLY_FULL_MAIN/);
  let run;
  for (let i = 0; i < 1500; i++) {
    run = (await (await fetch(url + '/api/codex/run/' + accepted.id)).json()).run;
    if (!['starting', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.projectRoot, cwd);
  assert.equal(run.treePath, 'subtrees/N1.md');
  assert.deepEqual(run.treeChanges.map(t => [t.treePath,t.changes.map(c => [c.nodeId,c.field,c.before,c.after])]),
    [['subtrees/N1.md',[['N1','CurrentResult','开始之前','本轮实际保存的新结果']]]]);
  assert.match(run.messages.at(-1).content,/主项目：[\s\S]*subtrees\/N1.md[\s\S]*N1 · CurrentResult：开始之前 → 本轮实际保存的新结果/);
  const fullRead = captured.find(body => body.messages.at(-1)?.name === 'task_tree_read');
  assert.ok(fullRead, 'the optional full-tree read must reach the model');
  assert.equal(JSON.parse(fullRead.messages.at(-1).content).markdown, main);
  assert.match(captured.find(body => body.messages.at(-1)?.name === 'task_tree_subtree').messages.at(-1).content, /ONLY_FULL_SUBTREE/);
  const directory = path.join(cwd, '.task-tree-maintenance/tree-summaries');
  const saved = JSON.parse(await readFile(path.join(directory, (await readdir(directory))[0]), 'utf8'));
  assert.equal(saved.nodes.find(n => n.id === 'N1').fields.CurrentResult, '本轮实际保存的新结果');
  assert.doesNotMatch(JSON.stringify(saved), /ONLY_FULL_SUBTREE/);
  assert.equal(await readFile(path.join(cwd, 'task-tree.md'), 'utf8'), main);
  const note = run.events.find(e => e.type === 'tool/completed' && e.toolName === 'task_tree_write');
  assert.equal(note.result.ok, true);
  assert.equal(note.result.receiptVerification.readBack, true);
});
