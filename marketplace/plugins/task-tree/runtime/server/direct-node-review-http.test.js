import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDirectNodeWorkspace } from './direct-node-workspace.js';
import { startDeepSeekTurn } from './deepseek-run.js';
import { createAgentRuntime } from './agent-runtime.js';

test('HTTP final reviewer receives global Hook, reads full Skill, repairs, verifies and applies in one session', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), codexHome = path.join(root, 'codex');
  await mkdir(projectRoot); await mkdir(path.join(codexHome, 'skills', 'review-demo'), { recursive: true });
  await writeFile(path.join(projectRoot, 'task-tree.md'), '# LLM Task Graph\n## ROOT - HTTP 验收\n- Problem: 返回42\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  await writeFile(path.join(codexHome, 'AGENTS.md'), 'GLOBAL_REVIEW_RULE');
  const skill = '---\nname: review-demo\ndescription: reviewer fixture\n---\nFULL_SKILL_BODY\n';
  await writeFile(path.join(codexHome, 'skills/review-demo/SKILL.md'), skill);
  const hook = path.join(root, 'hook.mjs'), hookLog = path.join(root, 'hooks.jsonl');
  await writeFile(hook, `import {appendFile} from 'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;let i=JSON.parse(s);await appendFile(${JSON.stringify(hookLog)},JSON.stringify({event:i.hook_event_name,session:i.session_id})+'\\n');console.log(JSON.stringify({additionalContext:'GLOBAL_REVIEW_HOOK_'+i.hook_event_name}));`);
  await writeFile(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }]])) }));
  const bodies = [];
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); bodies.push(body);
      assert.match(body.messages[0].content, /GLOBAL_REVIEW_RULE/);
      assert.match(body.messages[0].content, /GLOBAL_REVIEW_HOOK_UserPromptSubmit/);
      assert.ok(body.messages.some(m=>typeof m.content==='string'&&m.content.includes('WIRE_CONTRACT_RETURN_42')),'reviewer must receive the same planner contract as worker');
      assert.equal(body.response_format, undefined);
      assert.ok(body.tools.some(tool => tool.function.name === 'skills_read'));
      assert.ok(body.tools.some(tool => tool.function.name === 'exec_command'));
      const call = (name, args) => ({ content: null, tool_calls: [{ id: `call-${bodies.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      let message;
      if (bodies.length === 1) message = call('skills_read', { name: 'review-demo' });
      else if (bodies.length === 2) {
        assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('FULL_SKILL_BODY')));
        const program = "import {writeFile} from 'node:fs/promises';await writeFile('result.mjs','export default () => 42;\\n');let f=(await import('./result.mjs')).default;if(f()!==42)throw Error('wrong');console.log('verified42');";
        message = call('exec_command', { command: `${JSON.stringify(process.execPath)} --input-type=module -e ${JSON.stringify(program)}` });
      } else {
        assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('verified42')));
        message = { content: JSON.stringify({ verdict: 'pass', reason: '已修复并实际执行验证', evidence: ['verified42'] }) };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    } catch (error) { res.writeHead(400); res.end(error.message); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  let reviews = 0;
  const executor = createDirectNodeWorkspace({ projectRoot, reviewTurn: options => {
    reviews++;
    return startDeepSeekTurn({ ...options, environment: { ...options.environment, CODEX_HOME: codexHome,
      TASK_TREE_GLOBAL_ENV_FILE: path.join(root, 'nonexistent.env'), MODEL_AGENT_MAIN_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      MODEL_AGENT_MAIN_API_KEY: 'fixture', MODEL_AGENT_MAIN_MODEL: 'fixture', MODEL_AGENT_MAIN_FALLBACK_BASE_URLS: '' },
      runtimeFactory: opts => createAgentRuntime({ ...opts, homeDir: root }) });
  } });
  const state = await executor.prepare('http-review');
  await writeFile(path.join(state.workerPath, 'result.mjs'), 'export default () => 0;\n');
  const receipt = await executor.finish(state, { nodeId: 'ROOT', objective: 'result.mjs 返回42，不修改任务树', sharedContract:'WIRE_CONTRACT_RETURN_42：默认同步函数返回数值42；不是字符串。', status: 'completed' });
  assert.equal(reviews, 1); assert.equal(bodies.length, 3);
  assert.deepEqual(receipt.review.evidence, ['verified42']);
  assert.equal(await readFile(path.join(projectRoot, 'result.mjs'), 'utf8'), 'export default () => 42;\n');
  const hooks = (await readFile(hookLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(hooks.map(h => h.event), ['SessionStart', 'UserPromptSubmit', 'Stop']);
  assert.equal(new Set(hooks.map(h => h.session)).size, 1);
});
