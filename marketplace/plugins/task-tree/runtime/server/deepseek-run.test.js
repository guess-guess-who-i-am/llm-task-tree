import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDeepSeekTurn } from './deepseek-run.js';

let root;
const previous = {};
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-loop-test-'));
  for (const key of ['TASK_TREE_GLOBAL_ENV_FILE', 'TASK_TREE_PROJECT_ROOT']) previous[key] = process.env[key];
  process.env.TASK_TREE_GLOBAL_ENV_FILE = path.join(root, '.env');
  process.env.TASK_TREE_PROJECT_ROOT = root;
});
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const schema = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const call = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (message, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
const sse = (events, trailingNewline = true) => {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n') + (trailingNewline ? '\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    // Deliberately split every UTF-8 code point and every JSON/tool argument fragment.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};

async function run(t, responses, options = {}) {
  const requests = [], requestUrls=[], notifications = [], hooks = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requestUrls.push(url);
    requests.push(JSON.parse(init.body));
    assert.ok(responses.length, 'unexpected model round');
    const response = responses.shift();
    return typeof response === 'function' ? response(init) : response;
  });
  const runtime = {
    systemPrompt: 'GLOBAL_RULE', skillCount: 15656, hookSources: ['global'], tools: [],
    hooks: async (event, input) => { hooks.push({ event, input }); return { blocked: false, context: event === 'UserPromptSubmit' ? 'GLOBAL_HOOK' : '' }; },
    call: async () => { throw new Error('unexpected runtime tool'); },
    ...(options.runtime || {})
  };
  const { runtime: ignored, ...turnOptions } = options;
  const result = await startDeepSeekTurn({
    prompt: '真实执行', cwd: root, waitForCompletion: true,
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model' },
    runtimeFactory: async () => runtime,
    onNotification: message => notifications.push(message),
    ...turnOptions
  });
  return { result, requests, requestUrls, notifications, hooks };
}

const fallbackEnvironment={MODEL_AGENT_MAIN_BASE_URL:'https://primary.invalid/v1',MODEL_AGENT_MAIN_API_KEY:'test-only',MODEL_AGENT_MAIN_MODEL:'test-model',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:'https://backup-a.invalid/v1,https://backup-b.invalid/v1'};

test('local image tool outputs become native user image blocks after all tool receipts, never Base64 tool text', async t => {
  const state = await run(t, [json({ tool_calls: [call('view_image')] }, 'tool_calls'), json({ content: '背景是蓝色。' })], {
    tools: [schema('view_image')], toolHandler: async () => ({ path: 'photo.jpg', image: { mimeType: 'image/jpeg', data: '/9j/fixture-original' } })
  });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  const tool = state.requests[1].messages.find(m => m.role === 'tool');
  assert.ok(!tool.content.includes('/9j/fixture-original'), 'Base64 must not be serialized as textual tool output');
  const imageMessage = state.requests[1].messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.equal(imageMessage?.content.find(c => c.type === 'image_url')?.image_url.url, 'data:image/jpeg;base64,/9j/fixture-original');
  assert.ok(state.requests[1].messages.indexOf(imageMessage) > state.requests[1].messages.indexOf(tool));
  assert.equal(state.result.timing.tools.length, 1, 'reading JPEG does not require conversion commands');
});

test('image receipts stay ahead of images across parallel reads and a mutation barrier, without leaking into hooks or dialogue', async t => {
  const saved = [];
  const state = await run(t, [json({ tool_calls: [call('view_image', {}, 'image-1'), call('read_file', {}, 'text'), call('write', {}, 'barrier'), call('view_image', {}, 'image-2')] }, 'tool_calls'), json({ content: '读图完成' })], {
    tools: ['view_image', 'read_file', 'write'].map(schema),
    runtime: { saveDialogue: async (_, messages) => saved.push(messages) },
    toolHandler: async name => name === 'view_image' ? { path: 'photo.png', image: { mimeType: 'image/png', data: 'ORIGINAL_IMAGE_BYTES' } } : { ok: true }
  });
  const messages = state.requests[1].messages;
  const receipts = messages.filter(m => m.role === 'tool');
  const images = messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.equal(receipts.length, 4);
  assert.equal(images.content.filter(c => c.type === 'image_url').length, 2);
  assert.ok(receipts.every(m => messages.indexOf(m) < messages.indexOf(images)));
  assert.ok(!JSON.stringify(state.hooks).includes('ORIGINAL_IMAGE_BYTES'));
  assert.ok(!JSON.stringify(state.notifications).includes('ORIGINAL_IMAGE_BYTES'));
  assert.ok(saved.length > 0);
  assert.ok(!JSON.stringify(saved).includes('ORIGINAL_IMAGE_BYTES'));
});

test('a blocked image tool result cannot be sent to the model', async t => {
  const state = await run(t, [json({ tool_calls: [call('view_image')] }, 'tool_calls'), json({ content: '被阻止' })], {
    tools: [schema('view_image')], toolHandler: async () => ({ path: 'private.jpg', image: { mimeType: 'image/jpeg', data: 'PRIVATE_BYTES' } }),
    runtime: { hooks: async event => ({ blocked: event === 'PostToolUse', context: event === 'PostToolUse' ? '禁止发送' : '' }) }
  });
  assert.ok(!JSON.stringify(state.requests[1]).includes('PRIVATE_BYTES'));
});

test('failed primary switches to an explicitly configured backup without changing the model or body',async t=>{
  const state=await run(t,[gatewayFailure(),json({content:'已恢复'})],{environment:fallbackEnvironment});
  assert.equal(state.result.status,'completed');
  assert.deepEqual(state.requestUrls,['https://primary.invalid/v1/chat/completions','https://backup-a.invalid/v1/chat/completions']);
  assert.deepEqual(state.requests[0],state.requests[1]);
  assert.equal(state.result.timing.rounds[0].attempts[1].endpoint,'https://backup-a.invalid/v1');
});

test('all three configured endpoints are attempted once, not primary three times',async t=>{
  const state=await run(t,[gatewayFailure(524),gatewayFailure(502),json({content:'完成'})],{environment:fallbackEnvironment});
  assert.equal(state.result.status,'completed');
  assert.equal(new Set(state.requestUrls).size,3);
});

test('a successful backup is reused by later rounds and prior writes execute only once',async t=>{
  let writes=0;
  const state=await run(t,[json({tool_calls:[call('task_tree_write')]},'tool_calls'),gatewayFailure(502),json({tool_calls:[call('task_tree_read')]},'tool_calls'),json({content:'完成'})],{
    environment:fallbackEnvironment,tools:[schema('task_tree_write'),schema('task_tree_read')],toolHandler:async name=>{if(name==='task_tree_write')writes++;return{ok:true};}
  });
  assert.equal(state.result.status,'completed');assert.equal(writes,1);
  assert.deepEqual(state.requestUrls,['https://primary.invalid/v1/chat/completions','https://primary.invalid/v1/chat/completions','https://backup-a.invalid/v1/chat/completions','https://backup-a.invalid/v1/chat/completions']);
});

test('authenticated requests never automatically follow a redirect to an unconfigured origin',async t=>{
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    assert.equal(init.redirect,'manual');
    return new Response('',{status:307,headers:{location:'https://unapproved.invalid/collect'}});
  });
  const runtime={systemPrompt:'test',tools:[],skillCount:0,hookSources:[],hooks:async()=>({blocked:false,context:''})};
  const state=await startDeepSeekTurn({cwd:root,prompt:'test',waitForCompletion:true,environment:fallbackEnvironment,runtimeFactory:async()=>runtime});
  assert.equal(state.status,'failed');assert.match(state.error.message,/HTTP 307/);
  assert.equal(state.timing.rounds[0].attempts.length,1);
});

test('backup header timeout advances to next endpoint, never replaying a tool write',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let headersStarted;
  const ready=new Promise(r=>{headersStarted=r});
  const pending=run(t,[init=>new Promise((resolve,reject)=>{
    headersStarted();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }),json({content:'完成'})],{environment:fallbackEnvironment,completionTimeoutMs:120000});
  await ready;t.mock.timers.tick(45000);
  await new Promise(r=>setImmediate(r));t.mock.timers.tick(1000);
  const state=await pending;
  assert.equal(state.result.status,'completed');
  assert.equal(state.requestUrls[1],'https://backup-a.invalid/v1/chat/completions');
});

test('backup URLs must be HTTPS and never contain credentials, query or fragments',async t=>{
  for(const url of ['http://remote.invalid/v1','https://user:secret@host.invalid/v1','https://host.invalid/v1?key=secret']){
    t.mock.restoreAll();
    await assert.rejects(()=>run(t,[],{environment:{...fallbackEnvironment,MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:url}}),/备用.*HTTPS|备用.*凭据/);
  }
});

test('SSE UTF8 and fragmented tools become real execution and tool results in next request', async t => {
  const executed = [];
  const events = [
    { choices: [{ delta: { content: '中文', reasoning_content: '思考', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '"树.md"}' } }] }, finish_reason: 'tool_calls' }] }
  ];
  const state = await run(t, [sse(events), json({ content: '完成' })], {
    tools: [schema('read_file')], toolHandler: async (name, args) => { executed.push({ name, args }); return { content: '完整正文' }; }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(state.result.output, '中文完成');
  assert.deepEqual(executed, [{ name: 'read_file', args: { path: '树.md' } }]);
  const conversation = state.requests[1].messages;
  assert.equal(conversation[0].content, 'GLOBAL_RULE\n\nGLOBAL_HOOK');
  assert.equal(conversation.at(-2).reasoning_content, '思考');
  assert.equal(conversation.at(-1).tool_call_id, 'c1');
  assert.deepEqual(JSON.parse(conversation.at(-1).content), { content: '完整正文' });
});

test('SSE final data record without newline is not silently dropped', async t => {
  const { result } = await run(t, [sse([{ choices: [{ delta: { content: '最后一句' }, finish_reason: 'stop' }] }], false)]);
  assert.equal(result.output, '最后一句');
});

const gatewayFailure = (status = 502, headers = {}) => new Response('<html>Bad gateway</html>', { status, headers });

test('transient gateway failure retries the identical model request within one logical round', async t => {
  const state = await run(t, [gatewayFailure(502, { 'cf-ray': 'test-ray', server: 'cloudflare' }), json({ content: '恢复完成' })]);
  assert.equal(state.result.status, 'completed');
  assert.deepEqual(state.requests[0], state.requests[1]);
  assert.equal(state.result.timing.rounds.length, 1);
  const round = state.result.timing.rounds[0];
  assert.deepEqual(round.attempts.map(a => a.status), [502, 200]);
  assert.equal(round.attempts[0].responseHeaders['cf-ray'], 'test-ray');
  assert.ok(round.attempts[0].retryDelayMs > 0);
  assert.ok(round.requestBytes > 0);
  assert.equal(round.model, 'test-model');
  assert.match(state.notifications.find(n => n.method === 'model/request-retrying').params.message, /恢复|重试/);
});

test('gateway retry after a saved write never replays tools or startup Hooks', async t => {
  let writes = 0;
  const state = await run(t, [json({ tool_calls: [call('task_tree_write')] }, 'tool_calls'), gatewayFailure(503), json({ content: '完成' })], {
    tools: [schema('task_tree_write')], toolHandler: async () => { writes++; return { ok: true, saved: true }; }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(state.hooks.filter(h => h.event === 'UserPromptSubmit').length, 1);
  assert.deepEqual(state.requests[1], state.requests[2]);
  assert.equal(state.result.timing.rounds.length, 2);
});

test('persistent gateway failure stops after three attempts and records the exhaustion', async t => {
  const state = await run(t, [gatewayFailure(), gatewayFailure(504), gatewayFailure()]);
  assert.equal(state.result.status, 'failed');
  assert.equal(state.requests.length, 3);
  assert.match(state.result.error.message, /DeepSeek HTTP 502.*已重试 2 次/);
  assert.deepEqual(state.result.timing.rounds[0].attempts.map(a => a.status), [502, 504, 502]);
});

test('authentication and invalid request errors are not automatically retried', async t => {
  for (const status of [400, 401, 403, 404]) {
    t.mock.restoreAll();
    const state = await run(t, [gatewayFailure(status)]);
    assert.equal(state.result.status, 'failed');
    assert.equal(state.requests.length, 1);
    assert.match(state.result.error.message, new RegExp(`HTTP ${status}`));
  }
});

test('partial output is never automatically replayed', async t => {
  const state = await run(t, [sse([{ choices: [{ delta: { content: '已输出部分' } }] }])]);
  assert.equal(state.result.status, 'failed');
  assert.equal(state.requests.length, 1);
  assert.equal(state.notifications.some(n => n.method === 'model/request-retrying'), false);
});

test('deadline prevents retry backoff that cannot finish within remaining time', async t => {
  const state = await run(t, [gatewayFailure(503, { 'retry-after': '2' })], { completionTimeoutMs: 1000 });
  assert.equal(state.result.status, 'failed');
  assert.equal(state.requests.length, 1);
  assert.match(state.result.error.message, /剩余时间/);
});

test('Retry-After outside the original deadline fails without extending it', async t => {
  const state = await run(t, [gatewayFailure(503, { 'retry-after': '60' })],{completionTimeoutMs:1000});
  assert.equal(state.result.status, 'failed');
  assert.equal(state.requests.length, 1);
  assert.match(state.result.error.message, /Retry-After/);
});

test('rate limits and temporary gateway timeouts retry without replaying tools', async t => {
  for (const status of [408,429,500,520,522,524]) {
    t.mock.restoreAll();
    const state=await run(t,[gatewayFailure(status),json({content:'已恢复'})]);
    assert.equal(state.result.status,'completed',`HTTP ${status} must recover`);
    assert.deepEqual(state.result.timing.rounds[0].attempts.map(a=>a.status),[status,200]);
  }
});

test('transient connection reset retries but certificate and generic errors do not', async t => {
  const reset=await run(t,[()=>{throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});},json({content:'已恢复'})]);
  assert.equal(reset.result.status,'completed');
  assert.equal(reset.result.timing.rounds[0].attempts[0].errorCode,'ECONNRESET');
  t.mock.restoreAll();
  const cert=await run(t,[()=>{throw new TypeError('fetch failed',{cause:{code:'CERT_HAS_EXPIRED'}});}]);
  assert.equal(cert.result.status,'failed');assert.equal(cert.requests.length,1);
});

test('524 respects 120-second Retry-After within the unchanged overall deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let retryStarted;
  const ready=new Promise(resolve=>{retryStarted=resolve;});
  const notices=[];
  const pending=run(t,[gatewayFailure(524,{'retry-after':'120'}),json({content:'已恢复'})],{
    completionTimeoutMs:240000,
    onNotification:message=>{notices.push(message);if(message.method==='model/request-retrying')retryStarted();}
  });
  // Old behavior never sends this event, so expose its premature failure instead
  // of letting the regression test hang waiting for a mocked timer.
  const first=await Promise.race([ready.then(()=>null),pending]);
  assert.equal(first,null,'524 must enter recovery instead of failing immediately');
  assert.equal(notices.find(n=>n.method==='model/request-retrying').params.delayMs,120000);
  t.mock.timers.tick(120000);
  const state=await pending;
  assert.equal(state.result.status,'completed');
  assert.deepEqual(state.result.timing.rounds[0].attempts.map(a=>a.status),[524,200]);
  assert.equal(state.requests.length,2);
});

test('original timeout aborts an active backoff and never sends the next request', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let notifyRetry;
  const ready=new Promise(resolve=>{notifyRetry=resolve;});
  const pending=run(t,[gatewayFailure(524,{'retry-after':'120'})],{
    completionTimeoutMs:240000,
    onNotification:message=>{if(message.method==='model/request-retrying')notifyRetry();}
  });
  await ready;
  t.mock.timers.tick(240000);
  const state=await pending;
  assert.equal(state.result.status,'failed');
  assert.match(state.result.error.message,/超时/);
  assert.equal(state.requests.length,1);
});

test('Stop block is sent back for repair, persistent block fails after two repair attempts', async t => {
  let attempts = 0;
  const repaired = await run(t, [json({ content: '未完成' }), json({ content: '已修复' })], {
    runtime: { hooks: async event => ({ blocked: event === 'Stop' && attempts++ === 0, context: '修复树节点' }) }
  });
  assert.equal(repaired.result.status, 'completed');
  assert.match(repaired.requests[1].messages.at(-1).content, /修复树节点/);
  t.mock.restoreAll();
  const blocked = await run(t, [json({ content: '未完成' }), json({ content: '未完成' }), json({ content: '未完成' })], {
    runtime: { hooks: async event => ({ blocked: event === 'Stop', context: '必须写入' }) }
  });
  assert.equal(blocked.result.status, 'failed');
  assert.match(blocked.result.error.message, /Stop Hook/);
});

test('tool errors become structured tool results for correction; round limit never claims completion', async t => {
  const errored = await run(t, [json({ tool_calls: [call('read_file')] }, 'tool_calls'), json({ content: '报告错误' })], {
    tools: [schema('read_file')], toolHandler: async () => { throw new Error('不存在'); }
  });
  assert.deepEqual(JSON.parse(errored.requests[1].messages.at(-1).content), { ok: false, error: '不存在' });
  t.mock.restoreAll();
  const limited = await run(t, [json({ tool_calls: [call('read_file')] }, 'tool_calls')], {
    maxToolRounds: 1, tools: [schema('read_file')], toolHandler: async () => ({ ok: true })
  });
  assert.equal(limited.result.status, 'failed');
  assert.match(limited.result.error.message, /超过 1 轮/);
});

test('safe reads overlap, mutations form ordering barriers, and per-call timing is recorded', async t => {
  const order = []; let active = 0, peak = 0;
  const calls = ['read_file', 'skills_read', 'task_tree_write', 'task_tree_focus', 'exec_command'];
  const state = await run(t, [json({ tool_calls: calls.map(name => call(name)) }, 'tool_calls'), json({ content: '完成' })], {
    tools: calls.map(schema), toolHandler: async name => {
      order.push(`start:${name}`); active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 12));
      active--; order.push(`end:${name}`); return { ok: true };
    }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(peak, 2, 'independent read-only calls should overlap');
  assert.ok(order.indexOf('start:task_tree_write') > order.indexOf('end:read_file'));
  assert.ok(order.indexOf('start:task_tree_write') > order.indexOf('end:skills_read'));
  assert.ok(order.indexOf('start:task_tree_focus') > order.indexOf('end:task_tree_write'));
  assert.ok(order.indexOf('start:exec_command') > order.indexOf('end:task_tree_focus'));
  assert.deepEqual(state.requests[1].messages.filter(x => x.role === 'tool').map(x => x.name), calls);
  assert.equal(state.result.timing.rounds.length, 2);
  for (const round of state.result.timing.rounds) {
    assert.ok(round.requestMs >= 0); assert.ok(round.streamMs >= 0); assert.ok(round.totalMs >= round.requestMs);
  }
  assert.equal(state.result.timing.tools.length, 5);
  for (const event of state.notifications.filter(x => x.method === 'tool/completed')) assert.ok(event.params.durationMs >= 0);
});

test('host prepares focus and full tree before the first model request, without another model round', async t => {
  const prepared = [], trace = [];
  const state = await run(t, [json({ content: '资料已齐，本轮已完成' })], {
    initialToolCalls: [call('task_tree_focus', {nodeId:'N9'}, 'seed-focus'), call('task_tree_read', {}, 'seed-tree')],
    tools: ['task_tree_focus', 'task_tree_read'].map(schema),
    toolHandler: async name => {
      trace.push(`start:${name}`);
      await new Promise(r=>setTimeout(r, 10));
      trace.push(`end:${name}`); prepared.push(name);
      return {ok:true,content:'完整资料'.repeat(1000)};
    }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(prepared.length, 2);
  assert.equal(state.requests.length, 1);
  assert.ok(trace.indexOf('start:task_tree_read') < trace.indexOf('end:task_tree_focus'));
  assert.equal(state.requests[0].parallel_tool_calls, true);
  assert.equal(state.requests[0].messages.filter(m=>m.role==='tool').length, 2);
  assert.equal(state.result.timing.tools[0].round, 0);
  assert.equal(state.result.timing.readWaves[0].width, 2);
});

test('host preparation cannot execute writes or bypass tool rejection', async t => {
  let executed = 0;
  const state = await run(t, [], { initialToolCalls: [call('task_tree_write')], tools:[schema('task_tree_write')], toolHandler: async()=>{executed++;} });
  assert.equal(state.result.status,'failed'); assert.match(state.result.error.message,/只读/); assert.equal(executed,0);
  t.mock.restoreAll();
  const rejected=await run(t,[json({content:'报告权限拒绝'})],{
    initialToolCalls:[call('task_tree_read')],tools:[schema('task_tree_read')],toolHandler:async()=>{executed++;},
    runtime:{hooks:async event=>({blocked:event==='PreToolUse',context:'拒绝读取'})}
  });
  assert.equal(executed,0);
  assert.equal(JSON.parse(rejected.requests[0].messages.at(-1).content).ok,false);
});

test('invalid required argument is rejected before PreToolUse or execution', async t => {
  const tool = schema('task_tree_read');
  tool.function.parameters = { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'], additionalProperties: false };
  let executed = false;
  const state = await run(t, [json({ tool_calls: [call('task_tree_read', { nodeID: 'ROOT' })] }, 'tool_calls'), json({ content: '错误已告知' })], {
    tools: [tool], toolHandler: async () => { executed = true; }
  });
  assert.equal(executed, false);
  assert.equal(state.hooks.some(x => x.event === 'PreToolUse'), false);
  assert.equal(JSON.parse(state.requests[1].messages.at(-1).content).ok, false);
});

test('versions and subtree reads overlap but their modifying actions stay exclusive', async t => {
  const toolCalls = [
    call('task_tree_versions', { action: 'list' }, 'list'),
    call('task_tree_subtree', { action: 'context' }, 'context'),
    call('task_tree_versions', { action: 'restore' }, 'restore'),
    call('task_tree_subtree', { action: 'read' }, 'read'),
    call('task_tree_subtree', { action: 'write' }, 'write')
  ];
  const trace = []; let active = 0, peak = 0;
  const state = await run(t, [json({ tool_calls: toolCalls }, 'tool_calls'), json({ content: 'done' })], {
    tools: ['task_tree_versions', 'task_tree_subtree'].map(schema),
    toolHandler: async (_name, args) => {
      trace.push(`start:${args.action}`); active++; peak = Math.max(peak, active);
      if (['restore', 'write'].includes(args.action)) assert.equal(active, 1);
      await new Promise(resolve => setTimeout(resolve, 5));
      trace.push(`end:${args.action}`); active--; return { ok: true };
    }
  });
  assert.equal(state.result.status, 'completed'); assert.equal(peak, 2);
  assert.ok(trace.indexOf('start:restore') > trace.indexOf('end:context'));
  assert.ok(trace.indexOf('start:write') > trace.indexOf('end:read'));
});

test('PreToolUse rejection never reaches execution, but model receives correction context', async t => {
  let executed = false;
  const state = await run(t, [json({ tool_calls: [call('exec_command')] }, 'tool_calls'), json({ content: 'blocked' })], {
    tools: [schema('exec_command')], toolHandler: async () => { executed = true; },
    runtime: { hooks: async event => ({ blocked: event === 'PreToolUse', context: event === 'PreToolUse' ? '禁止当前命令' : '' }) }
  });
  assert.equal(executed, false);
  assert.deepEqual(JSON.parse(state.requests[1].messages.at(-1).content), { ok: false, error: '禁止当前命令' });
});

test('length exhaustion and truncated SSE are failures, not successful completion', async t => {
  const truncated = await run(t, [json({ content: '尚未完成' }, 'length')]);
  assert.equal(truncated.result.status, 'failed'); assert.match(truncated.result.error.message, /长度限制/);
  t.mock.restoreAll();
  const disconnected = await run(t, [sse([{ choices: [{ delta: { content: '半截' } }] }])]);
  assert.equal(disconnected.result.status, 'failed'); assert.match(disconnected.result.error.message, /提前结束/);
});

test('explicit tool handlers override the shared runtime implementation with the same name', async t => {
  let customCalls = 0, runtimeCalls = 0;
  const state = await run(t, [json({ tool_calls: [call('task_tree_read')] }, 'tool_calls'), json({ content: 'done' })], {
    tools: [schema('task_tree_read')],
    toolHandler: async () => { customCalls++; return { tree: 'selected-tree' }; },
    runtime: { tools: [schema('task_tree_read')], call: async () => { runtimeCalls++; return { tree: 'wrong-default-tree' }; } }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(runtimeCalls, 0); assert.equal(customCalls, 1);
  assert.equal(state.requests[0].tools.filter(x => x.function.name === 'task_tree_read').length, 1);
});

test('timing measures real request, stream and hooks, including failed model requests', async t => {
  const delay = () => new Promise(resolve => setTimeout(resolve, 12));
  const state = await run(t, [async () => {
    await delay();
    return new Response(new ReadableStream({ async start(controller) {
      await delay();
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }], { runtime: { hooks: async () => { await delay(); return { blocked: false, context: '' }; } } });
  assert.equal(state.result.status, 'completed');
  const [round] = state.result.timing.rounds;
  assert.ok(round.requestMs >= 8); assert.ok(round.streamMs >= 8);
  assert.ok(round.totalMs >= round.requestMs + round.streamMs);
  for (const hook of state.result.timing.hooks) assert.ok(hook.durationMs >= 8);
  t.mock.restoreAll();
  const failed = await run(t, [async () => { await delay(); throw new Error('network unavailable'); }]);
  assert.equal(failed.result.status, 'failed');
  assert.ok(failed.result.timing.rounds[0].totalMs >= 8);
  assert.equal(failed.result.timing.rounds[0].requestMs, null);
});

test('resumed conversations retain all prior user messages and run UserPromptSubmit without SessionStart', async t => {
  const prior = [
    { role: 'user', content: '历史问题一' }, { role: 'assistant', content: '历史答案一' },
    { role: 'user', content: '历史问题二' }, { role: 'assistant', content: '历史答案二' },
    { role: 'user', content: '历史问题三' }, { role: 'assistant', content: '历史答案三' }
  ];
  const writes = [];
  const state = await run(t, [json({ content: '继续回答' })], {
    threadId: 'deepseek-existing', prompt: '新的问题',
    runtime: {
      loadDialogue: async id => { assert.equal(id, 'deepseek-existing'); return prior; },
      saveDialogue: async (id, messages) => writes.push({ id, messages })
    }
  });
  assert.equal(state.result.status, 'completed');
  assert.equal(state.result.threadId, 'deepseek-existing');
  assert.equal(state.hooks.filter(x => x.event === 'UserPromptSubmit').length, 1);
  assert.equal(state.hooks.filter(x => x.event === 'SessionStart').length, 0);
  assert.deepEqual(state.requests[0].messages.filter(x => x.role === 'user').map(x => x.content), ['历史问题一', '历史问题二', '历史问题三', '新的问题']);
  assert.equal(writes.at(-1).messages.filter(x => x.role === 'user').length, 4);
});

test('planner JSON mode narrows tools but preserves global rules and the prompt Hook', async t => {
  const state = await run(t, [json({ content: '{"tasks":[]}' })], {
    responseFormat: { type: 'json_object' }, runtimeToolNames: ['skills_read'],
    runtime: { tools: ['skills_read', 'exec_command', 'read_file'].map(schema) }
  });
  assert.equal(state.result.status, 'completed');
  assert.deepEqual(state.requests[0].response_format, { type: 'json_object' });
  assert.deepEqual(state.requests[0].tools.map(x => x.function.name), ['skills_read']);
  assert.match(state.requests[0].messages[0].content, /GLOBAL_RULE/);
  assert.match(state.requests[0].messages[0].content, /GLOBAL_HOOK/);
});

test('blocked startup cannot overwrite an existing durable conversation with empty history', async t => {
  let writes = 0;
  const state = await run(t, [], {
    forkThreadId: 'deepseek-existing',
    runtime: {
      hooks: async event => ({ blocked: event === 'SessionStart', context: 'startup blocked' }),
      loadDialogue: async () => [{ role: 'user', content: 'must survive' }],
      saveDialogue: async () => { writes++; }
    }
  });
  assert.equal(state.result.status, 'failed');
  assert.equal(state.requests.length, 0);
  assert.equal(writes, 0);
});

test('completion is published only after durable writes and runtime close on success and failure', async t => {
  for (const failed of [false, true]) {
    const events = [];
    await run(t, [failed ? () => { throw new Error('network failure'); } : json({ content: '答复' })], {
      runtime: {
        loadDialogue: async () => [],
        saveDialogue: async () => { events.push('save'); },
        close: async () => { events.push('close'); }
      },
      onCompleted: async () => { events.push('completed'); }
    });
    assert.equal(events.at(-1), 'completed');
    assert.ok(events.indexOf('close') < events.indexOf('completed'));
    assert.ok(events.lastIndexOf('save') < events.indexOf('completed'));
  }
});
