import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { requestDeepSeekPlanner, buildPlannerPrompt } from './codex-coordinator.js';

test('production planner request runs the shared global Hook and includes its full context', async t => {
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'tree-planner-global-'));
  const codexHome=path.join(projectRoot,'codex'); await mkdir(codexHome);
  await writeFile(path.join(codexHome,'AGENTS.md'),'PLANNER_GLOBAL_RULE');
  const hook=path.join(codexHome,'hook.mjs');
  await writeFile(hook,`let s='';for await(const c of process.stdin)s+=c;const input=JSON.parse(s);console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'PLANNER_HOOK_'+input.hook_event_name}}));`);
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:`'${process.execPath}' '${hook}'`}]}]}}));
  let captured;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;captured=JSON.parse(raw);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'计划已生成',tool_calls:[{id:'plan-submit',type:'function',function:{name:'structured_result_submit',arguments:'{"summary":"test","coverage":[],"jobs":[]}'}}]}}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const environment={CODEX_HOME:codexHome,TASK_TREE_PLANNER_BASE_URL:`http://127.0.0.1:${server.address().port}`,TASK_TREE_PLANNER_API_KEY:'fixture',TASK_TREE_PLANNER_MODEL:'fixture'};
  environment.TASK_TREE_GLOBAL_ENV_FILE = path.join(projectRoot, '.env');
  environment.TASK_TREE_API_CONNECTIONS_FILE = path.join(projectRoot, 'api-connections.json');
  const previous=Object.fromEntries(Object.keys(environment).map(k=>[k,process.env[k]]));
  Object.assign(process.env,environment);
  t.after(async()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await new Promise(r=>server.close(r));});
  const notifications=[];
  const result=await requestDeepSeekPlanner({projectRoot,prompt:'return JSON plan',
    outputSchema:{type:'object',required:['summary','coverage','jobs'],properties:{summary:{type:'string'},coverage:{type:'array'},jobs:{type:'array'}}},
    historyMessages:[{role:'user',content:'PLANNER_USER_ACCEPTANCE'},{role:'assistant',content:'OLD_PLANNER_NARRATION'},{role:'user',content:'计划只覆盖本节点'}],
    onNotification:m=>notifications.push(m)});
  assert.equal(JSON.parse(result.output).summary,'test');
  assert.match(JSON.stringify(captured.messages),/PLANNER_USER_ACCEPTANCE/);
  // The latest reply may survive, but unrelated earlier narration may not.
  assert.equal(result.timing.historyProjection.policy,'tree-user-history/v1');
  assert.match(captured.messages[0].content,/PLANNER_GLOBAL_RULE/);
  assert.match(captured.messages[0].content,/PLANNER_HOOK_UserPromptSubmit/);
  assert.equal(captured.response_format,undefined);
  assert.ok(captured.tools.some(t=>t.function.name==='structured_result_submit'));
  assert.ok(captured.tools.some(t=>t.function.name==='history_search'));
  assert.ok(captured.tools.some(t=>t.function.name==='history_read'));
  assert.ok(!captured.tools.some(t=>t.function.name==='exec_command'||t.function.name==='task_tree_write'));
  assert.ok(notifications.some(m=>m.method==='hook/completed'&&m.params.event==='UserPromptSubmit'));
});

test('production planner can opt into full main-tree and subtree reads after the summary', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'planner-optional-read-'));
  const codexHome = path.join(projectRoot, 'codex'); await mkdir(codexHome);
  const main = '# LLM Task Graph\n## ROOT - 目标\n- Problem: 完成两个结果\n## N1 - 分支\n- Problem: 两项可并行\n- Notes: FULL_MAIN_DETAIL\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n';
  await writeFile(path.join(projectRoot, 'task-tree.md'), main);
  await mkdir(path.join(projectRoot, 'subtrees'));
  await writeFile(path.join(projectRoot, 'subtrees/N1.md'), 'FULL_SUBTREE_DETAIL');
  const captured = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    captured.push(JSON.parse(raw));
    const read = [['task_tree_read', {}], ['read_file', { path: 'subtrees/N1.md' }]][captured.length - 1];
    const message = read ? { content: '', tool_calls: [{ id: `r${captured.length}`, type: 'function', function: { name: read[0], arguments: JSON.stringify(read[1]) } }] }
      : { content: '{"summary":"读到完整资料后生成计划","coverage":[],"jobs":[]}' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: read ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const environment = { CODEX_HOME: codexHome, TASK_TREE_PLANNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, TASK_TREE_PLANNER_API_KEY: 'fixture', TASK_TREE_PLANNER_MODEL: 'fixture' };
  environment.TASK_TREE_GLOBAL_ENV_FILE = path.join(projectRoot, '.env');
  environment.TASK_TREE_API_CONNECTIONS_FILE = path.join(projectRoot, 'api-connections.json');
  const previous = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
  Object.assign(process.env, environment);
  t.after(async () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await new Promise(r => server.close(r)); });
  const result = await requestDeepSeekPlanner({ projectRoot, prompt: buildPlannerPrompt(main) });
  assert.equal(result.output.includes('读到完整资料'), true);
  assert.doesNotMatch(JSON.stringify(captured[0].messages), /FULL_MAIN_DETAIL|FULL_SUBTREE_DETAIL/);
  assert.equal(JSON.parse(captured[1].messages.at(-1).content).markdown, main);
  assert.equal(JSON.parse(captured[2].messages.at(-1).content).content, 'FULL_SUBTREE_DETAIL');
  assert.ok(captured[0].tools.some(t => t.function.name === 'task_tree_read'));
  assert.ok(captured[0].tools.some(t => t.function.name === 'task_tree_summary'));
});
