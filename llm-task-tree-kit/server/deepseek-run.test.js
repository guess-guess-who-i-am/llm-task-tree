import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDeepSeekTurn, loadDeepSeekConfig } from './deepseek-run.js';
import { estimateContextTokens } from './deepseek-context.js';

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
test('input telemetry attributes the immutable prompt without recording its contents',async t=>{
  const secrets=['RUNTIME_PRIVATE','SESSION_PRIVATE','PROMPT_PRIVATE','ATTACHMENT_PRIVATE','SCOPE_PRIVATE'];
  const state=await run(t,[json({content:'完成'})],{
    runtime:{systemPrompt:secrets[0],hooks:async event=>({blocked:false,context:event==='SessionStart'?secrets[1]:event==='UserPromptSubmit'?secrets[2]:'',reports:[]})},
    messages:[{role:'user',content:'执行'}],contextMessages:[{role:'user',content:secrets[3]}],systemPrompt:secrets[4]
  });
  const input=state.notifications.find(n=>n.method==='context/input-prepared')?.params;
  assert.ok(input);
  assert.equal(input.components.runtimeRulesBytes,Buffer.byteLength(secrets[0]));
  assert.equal(input.components.sessionHookBytes,Buffer.byteLength(secrets[1]));
  assert.equal(input.components.promptHookBytes,Buffer.byteLength(secrets[2]));
  assert.equal(input.components.executionScopeBytes,Buffer.byteLength(secrets[4]));
  assert.ok(input.components.ephemeralInputBytes>Buffer.byteLength(secrets[3]));
  assert.ok(input.messageBytes>0&&input.toolDefinitionBytes>0);
  assert.ok(!secrets.some(s=>JSON.stringify(input).includes(s)));
});
test('long auto execution keeps the full tool surface without a mandatory strategy round', async t => {
  let executions=0;
  const state=await run(t,[json({tool_calls:[call('task_tree_continue_single',{reason:'先核对统一映射',nextCheckpoint:'映射验证后'})]},'tool_calls'),...Array.from({length:12},(_,i)=>json({tool_calls:[call('exec_command',{},`work-${i}`)]},'tool_calls')),
    json({tool_calls:[call('task_tree_continue_single',{reason:'先确认统一映射才能可靠分片',nextCheckpoint:'映射小样本验证后'})]},'tool_calls'),json({content:'已完成'})],{
    tools:[schema('exec_command'),schema('task_tree_plan_execute')],toolHandler:async name=>{assert.equal(name,'exec_command');executions++;return {ok:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(state.requests[12].tool_choice,'auto');
  assert.deepEqual(state.requests[12].tools.map(t=>t.function.name),state.requests[1].tools.map(t=>t.function.name));
  assert.equal(state.requests[13].tool_choice,'auto');
  assert.equal(executions,12,'reassessment cannot replay work');
  assert.ok(state.notifications.some(n=>n.method==='execution/strategy'&&n.params.mode==='single'&&/映射/.test(n.params.message)));
});
test('ordinary writes remain executable at every scheduling boundary without replay or corrective rounds', async t => {
  const executed=[];
  const state=await run(t,[json({tool_calls:[call('task_tree_continue_single',{reason:'先迁移共享状态',nextCheckpoint:'迁移完成后'})]},'tool_calls'),...Array.from({length:12},(_,i)=>json({tool_calls:[call('write',{value:i},`w-${i}`)]},'tool_calls')),
    json({tool_calls:[call('write',{value:'not-authorized-this-batch'},'ignored-choice')]},'tool_calls'),
    json({tool_calls:[call('task_tree_continue_single',{reason:'接口迁移必须先串行完成',nextCheckpoint:'迁移测试通过后'})]},'tool_calls'),
    json({tool_calls:[call('write',{value:'resumed'})]},'tool_calls'),json({content:'完成'})],{
    tools:[schema('write'),schema('task_tree_plan_execute')],toolHandler:async(_name,args)=>{executed.push(args.value);return {ok:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.deepEqual(executed,[...Array.from({length:12},(_,i)=>i),'not-authorized-this-batch','resumed']);
  assert.equal(state.requests[13].tool_choice,'auto');
  assert.ok(state.requests[14].messages.some(m=>m.role==='tool'&&m.tool_call_id==='ignored-choice'&&!/尚未执行/.test(m.content)));
  assert.equal(state.requests[14].tool_choice,'auto');
});
test('manual stop at reassessment remains a real cancellation, never a hidden automatic retry', async t => {
  const controller=new AbortController();let executed=0;
  const state=await run(t,[json({tool_calls:[call('task_tree_continue_single',{reason:'读取单一错误链',nextCheckpoint:'定位后'})]},'tool_calls'),...Array.from({length:12},()=>json({tool_calls:[call('read')]},'tool_calls')),
    ()=>{controller.abort();throw Object.assign(new Error('aborted'),{name:'AbortError'});}],{
    signal:controller.signal,tools:[schema('read'),schema('task_tree_split_work')],toolHandler:async()=>{executed++;return {ok:true};}
  });
  assert.equal(state.result.status,'stopped');
  assert.equal(state.requests.length,14);assert.equal(executed,12);
});
test('first-request choice restores implementation tools and rejects unoffered work without replay',async t=>{
  let writes=0;
  const state=await run(t,[json({tool_calls:[call('task_tree_continue_single',{reason:'只改一处小标签',nextCheckpoint:'标签和相关测试完成'}),call('write')]},'tool_calls'),json({tool_calls:[call('write')]},'tool_calls'),json({content:'已交付'})],{
    tools:[schema('write'),schema('task_tree_plan_execute')],toolHandler:async()=>{writes++;return {ok:true};}
  });
  assert.equal(state.result.status,'completed');assert.equal(writes,1);assert.equal(state.requests.length,3);
  assert.equal(state.requests[0].tool_choice,'required');assert.ok(!state.requests[0].tools.some(t=>t.function.name==='write'));
  assert.equal(state.requests[1].tool_choice,'auto');assert.ok(state.requests[1].tools.some(t=>t.function.name==='write'));
  assert.ok(state.requests[0].messages.some(m=>/首次执行方式选择/.test(m.content||'')));
});
test('ignored or malformed initial choices continue in session and cannot falsely complete',async t=>{
  let writes=0;
  const state=await run(t,[json({content:'全部已完成'}),json({tool_calls:[call('write')]},'tool_calls'),
    json({tool_calls:[call('task_tree_continue_single',{})]},'tool_calls'),
    json({tool_calls:[call('task_tree_continue_single',{reason:'一个标签',nextCheckpoint:'用例通过'})]},'tool_calls'),
    json({tool_calls:[call('write')]},'tool_calls'),json({content:'真实交付'})],{
    tools:[schema('write'),schema('task_tree_plan_execute')],toolHandler:async()=>{writes++;return {ok:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);
  assert.ok(state.requests.slice(0,4).every(r=>r.tool_choice==='required'));
  assert.equal(state.requests[4].tool_choice,'auto');
  assert.equal(state.result.messages.at(-1).content,'真实交付');
  assert.equal(state.hooks.filter(h=>h.event==='Stop').length,1);
});
test('tool narration is presentation-only process, final answer stays distinct through persistence',async t=>{
  const saves=[],history=[{role:'user',content:'完成任务'}];
  const state=await run(t,[json({content:'先读取文件。',tool_calls:[call('read')]},'tool_calls'),json({content:'再进行修改。',tool_calls:[call('write')]},'tool_calls'),json({content:'修改完成，测试通过。'})],{
    dialogueContext:history,tools:[schema('read'),schema('write')],toolHandler:async()=>({ok:true}),
    runtime:{saveDialogue:async(_id,messages)=>saves.push(structuredClone(messages))}
  });
  assert.equal(state.result.status,'completed');
  assert.equal(state.result.messages.at(-1).content,'修改完成，测试通过。');
  assert.deepEqual(state.result.messages.at(-1).presentation,{process:'先读取文件。再进行修改。',answer:'修改完成，测试通过。'});
  assert.deepEqual(saves.at(-1).at(-1).presentation,state.result.messages.at(-1).presentation);
  assert.ok(state.notifications.some(n=>n.method==='assistant/presentation'&&n.params.presentation.answer==='修改完成，测试通过。'));
  assert.equal(state.result.output,'先读取文件。再进行修改。修改完成，测试通过。','consumer output remains complete');
});
test('presentation survives resumed archive but is never sent as extra model context',async t=>{
  const messages=[{role:'user',content:'之前要求'},{role:'assistant',content:'之前回答',presentation:{process:'DISPLAY_ONLY_SENTINEL',answer:'之前回答'}},{role:'user',content:'继续'}];
  const state=await run(t,[json({content:'继续完成。'})],{messages,historyPolicy:'full'});
  assert.equal(state.result.status,'completed');assert.equal(state.requests.length,1);
  assert.ok(!JSON.stringify(state.requests[0].messages).includes('DISPLAY_ONLY_SENTINEL'));
  assert.deepEqual(state.result.messages[1],messages[1]);
});
test('live user guidance reaches the next request and durable session history without mutating shared caller history',async t=>{
  const history=[{role:'user',content:'完成原始任务'}],saves=[];
  let polls=0;
  const state=await run(t,[json({content:'已完成原始任务'}),json({content:'已根据用户指导补齐验收说明'})],{
    dialogueContext:history,
    beforeModelRequest:async()=>++polls===2?[{role:'user',content:'用户实时指导：补上验收说明'}]:[],
    runtime:{saveDialogue:async(_id,messages)=>saves.push(structuredClone(messages))}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(state.requests.length,2,'only actual late guidance continues the session');
  assert.ok(state.requests[1].messages.some(m=>m.role==='user'&&m.content==='用户实时指导：补上验收说明'));
  assert.ok(saves.at(-1).some(m=>m.role==='user'&&m.content==='用户实时指导：补上验收说明'));
  assert.ok(state.result.messages.some(m=>m.content==='用户实时指导：补上验收说明'));
  assert.deepEqual(history,[{role:'user',content:'完成原始任务'}]);
});
test('unsolicited compaction narrative is not task completion and never becomes the final dialogue',async t=>{
  const handoff='<analysis>现在的这个压缩请求需要记录技术细节。</analysis>\n<summary>1. 当前工作：已经定位。\n9. 可选下一步：修改文件，继续完成原始任务。</summary>';
  let writes=0;
  const state=await run(t,[json({content:handoff}),json({tool_calls:[call('write_result')]},'tool_calls'),json({content:'已修改 result.txt 并验证。'})],{
    dialogueContext:[{role:'user',content:'请实际修改 result.txt'}],tools:[schema('write_result')],toolHandler:async()=>{writes++;return {ok:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);
  assert.equal(state.requests.length,3);
  assert.equal(state.hooks.filter(h=>h.event==='Stop').length,1);
  assert.equal(state.result.messages.at(-1).content,'已修改 result.txt 并验证。');
  assert.ok(!state.result.output.includes('<summary>'));
  assert.ok(state.notifications.some(n=>n.method==='model/continuing'&&/交接摘要/.test(n.params.message)));
});
test('ordinary requested summaries and literal XML documentation are not mistaken for compaction',async t=>{
  for(const content of ['<summary>项目摘要：实现已经交付。</summary>',
    '示例代码：```xml\n<analysis>分析压缩请求</analysis><summary>当前工作，可选下一步</summary>\n```']){
    const state=await run(t,[json({content})]);
    assert.equal(state.requests.length,1);
    assert.equal(state.result.status,'completed');
    assert.equal(state.result.output,content);
  }
});
test('hook timing retains per-source measurements without copying hook context or stderr', async t => {
  const report={event:'UserPromptSubmit',source:'/fixture/global/hooks.json',ok:true,startedAt:'2026-10-13T00:00:00Z',endedAt:'2026-10-13T00:00:02Z',durationMs:2000,contextSha256:'fingerprint',stderr:'private diagnostic',additionalContext:'private context'};
  const state=await run(t,[json({content:'完成'})],{runtime:{hooks:async event=>({blocked:false,context:'',reports:event==='UserPromptSubmit'?[report]:[]})}});
  const recorded=state.result.timing.hooks.find(h=>h.event==='UserPromptSubmit').reports;
  assert.equal(recorded?.[0]?.source,report.source);
  assert.equal(recorded[0].durationMs,2000);
  assert.equal(recorded[0].startedAt,report.startedAt);
  assert.equal(recorded[0].stderr,undefined);
  assert.equal(recorded[0].additionalContext,undefined);
});
test('review submits a terminal verdict with narration, without a formatting or acknowledgement round', async t => {
  const state = await run(t, [json({content:'已实际核对通过。',tool_calls:[call('completion_review_submit',{verdict:'pass',reason:'测试通过',evidence:['真实断言通过']})]},'tool_calls')], {completionReview:true});
  assert.equal(state.result.status,'completed');
  assert.equal(JSON.parse(state.result.messages.at(-1).content).verdict,'pass');
  assert.ok(state.requests[0].tools.some(t=>t.function.name==='completion_review_submit'));
  assert.equal(state.requests.length,1);
  assert.ok(state.hooks.some(h=>h.event==='Stop'));
});
test('terminal review cannot bypass unfinished tools and can resubmit after their receipts', async t => {
  let executions=0;
  const verdict={verdict:'pass',reason:'通过',evidence:['断言']};
  const state = await run(t, [json({tool_calls:[call('completion_review_submit',verdict),call('unfinished')]},'tool_calls'),json({tool_calls:[call('completion_review_submit',verdict)]},'tool_calls')], {completionReview:true,tools:[schema('unfinished')],toolHandler:async()=>{executions++;return {ok:true};}});
  assert.equal(state.result.status,'completed');
  assert.equal(executions,1);
  assert.equal(state.requests.length,2);
  assert.match(state.requests[1].messages.find(m=>m.role==='tool'&&m.name==='completion_review_submit').content,/单独/);
});
test('invalid review prose and tool arguments recover without replaying successful tools',async t=>{
  let executions=0;
  const state=await run(t,[json({tool_calls:[call('verify')]},'tool_calls'),json({content:'全部测试通过。\n{"verdict":"pass","reason":"通过","evidence":["测试"]}'}),json({tool_calls:[call('completion_review_submit',{verdict:'pass',reason:'通过',evidence:'wrong type'})]},'tool_calls'),json({tool_calls:[call('completion_review_submit',{verdict:'pass',reason:'通过',evidence:['已执行verify']})]},'tool_calls')],{completionReview:true,tools:[schema('verify')],toolHandler:async()=>{executions++;return {ok:true};}});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(executions,1);
  assert.equal(state.requests.length,4);
  assert.deepEqual(state.requests[2].tools.map(t=>t.function.name),['completion_review_submit']);
});
test('planner malformed final output is corrected by the same model',async t=>{
  const outputSchema={type:'object',required:['jobs'],properties:{jobs:{type:'array',minItems:1,items:{type:'string'}}},additionalProperties:false};
  const state=await run(t,[json({content:'计划：先做A。'}),json({tool_calls:[call('structured_result_submit',{jobs:['A']})]},'tool_calls')],{outputSchema});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(state.requests.length,2);
});
test('invalid checker output cannot launch tools in a formatting recovery',async t=>{
  let calls=0;
  const state=await run(t,[json({content:'检查完成'}),json({tool_calls:[call('verify')]},'tool_calls'),json({tool_calls:[call('completion_review_submit',{verdict:'failed',reason:'任务未完成',evidence:['未完成事实']})]},'tool_calls')],{completionReview:true,tools:[schema('verify')],toolHandler:async()=>{calls++;}});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(calls,0);
  assert.equal(state.requests.length,3);
  assert.equal(JSON.parse(state.result.messages.at(-1).content).verdict,'failed');
});
test('host delegation result ends the parent with no acknowledgement or parent Stop loop',async t=>{
  const state=await run(t,[json({content:'将拆为独立任务。',tool_calls:[call('task_tree_plan_execute',{})]},'tool_calls')],{
    dialogueContext:[{role:'user',content:'完成六份成果'}],
    tools:[schema('task_tree_plan_execute')],toolHandler:async()=>({ok:true,hostCompletion:{status:'completed',output:'六份成果已统一验收'}}),
    runtime:{hooks:async event=>({blocked:event==='Stop',context:'不应重复父检查',reports:[]})}
  });
  assert.equal(state.result.status,'completed');assert.equal(state.requests.length,1);
  assert.equal(state.result.output,'六份成果已统一验收');
  assert.deepEqual(state.result.messages.at(-1).presentation,{process:'将拆为独立任务。',answer:'六份成果已统一验收'});
  assert.ok(!state.hooks.some(h=>h.event==='Stop'));
});
test('worker subdivision ends only this branch without another model request or Stop loop',async t=>{
  const state=await run(t,[json({tool_calls:[call('task_tree_split_work')]},'tool_calls')],{
    tools:[schema('task_tree_split_work')],toolHandler:async()=>({ok:true,taskIds:['A.one','A.two'],hostCompletion:{status:'completed',output:'剩余工作已交给同轮子分支'}}),
    runtime:{hooks:async event=>({blocked:event==='Stop',context:'分支已交接，不应重复执行',reports:[]})}
  });
  assert.equal(state.result.status,'completed');assert.equal(state.requests.length,1);
  assert.equal(state.result.output,'剩余工作已交给同轮子分支');assert.ok(!state.hooks.some(h=>h.event==='Stop'));
});
test('tools following final delegation in the same batch cannot mutate accepted output',async t=>{
  const executed=[];
  const state=await run(t,[json({tool_calls:[call('task_tree_plan_execute'),call('mutate_after_review')]},'tool_calls')],{
    tools:[schema('task_tree_plan_execute'),schema('mutate_after_review')],
    toolHandler:async name=>{executed.push(name);return {ok:true,hostCompletion:{status:'completed',output:'整体已验收'}};}
  });
  assert.equal(state.result.status,'completed');
  assert.deepEqual(executed,['task_tree_plan_execute']);
  assert.equal(state.requests.length,1);
});
test('whole fenced review JSON is normalized locally in one request',async t=>{
  const state=await run(t,[json({content:'```json\n{"verdict":"pass","reason":"通过","evidence":["真实验证"]}\n```'})],{completionReview:true});
  assert.equal(state.result.status,'completed');assert.equal(state.requests.length,1);
});

test('unfinalized checker handoff closes as failed without a formatting retry',async t=>{
  const narrative='##### 仍未解决\n\n1. 尚未完成真实验证。\n\n执行者工作已结束，结果待宿主整合验收。';
  const state=await run(t,[json({content:narrative})],{completionReview:true});
  assert.equal(state.result.status,'completed');
  assert.equal(state.requests.length,1);
  const review=JSON.parse(state.result.structuredOutput);
  assert.equal(review.verdict,'failed');
  assert.equal(review.evidence[0],narrative);
});
const isSummary = body => /只生成中文(?:工具批次)?交接摘要|只语义精炼已有中文交接摘要/.test(body.messages[0]?.content||'');

test('final Stop receives the actual verdict and host node without another model round',async t=>{
  const verdict={verdict:'pass',reason:'修复已验证',evidence:['实际测试通过']};
  const inputs=[];
  const state=await run(t,[json({tool_calls:[call('completion_review_submit',verdict)]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',
    environment:{MODEL_AGENT_MAIN_BASE_URL:'https://isolated.invalid',MODEL_AGENT_MAIN_API_KEY:'test-only',MODEL_AGENT_MAIN_MODEL:'test-model',TASK_TREE_CONTEXT_NODE_ID:'N9',TASK_TREE_CONTEXT_TREE_FILE:'trees/work.md'},
    runtime:{hooks:async(event,input)=>{inputs.push({event,input});return {blocked:false,context:'',reports:[]};}}
  });
  assert.equal(state.result.status,'completed');
  assert.equal(state.requests.length,1);
  assert.equal(inputs.find(i=>i.event==='UserPromptSubmit').input.execution_node_id,'N9');
  assert.equal(inputs.find(i=>i.event==='Stop').input.execution_tree_file,'trees/work.md');
  assert.deepEqual(inputs.find(i=>i.event==='Stop').input.completion_review,verdict);
});

test('final reviewer retains Stop Hook but does not start a hook-driven repair loop', async t => {
  const state = await run(t, [json({ content: '{"verdict":"failed","reason":"修复失败"}' })], {
    stopHookPolicy: 'fail', runtime: { hooks: async event => ({ blocked: event === 'Stop', context: '验收仍失败', reports: [] }) }
  });
  assert.equal(state.result.status, 'failed');
  assert.match(state.result.error.message, /Stop Hook/);
  assert.equal(state.requests.length, 1);
});

test('reviewer resumes only structured maintenance in the same session and reopens tools after format recovery',async t=>{
  let stops=0,patches=0,prompts=0;
  const review={verdict:'pass',reason:'产物已通过',evidence:['实际断言']};
  const state=await run(t,[json({content:'判定通过'}),json({tool_calls:[call('completion_review_submit',review)]},'tool_calls'),
    json({tool_calls:[call('maintain_tree')]},'tool_calls'),json({tool_calls:[call('completion_review_submit',review)]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',tools:[schema('maintain_tree')],toolHandler:async()=>{patches++;return {ok:true};},
    runtime:{hooks:async event=>{if(event==='UserPromptSubmit')prompts++;return event==='Stop'&&++stops===1?{blocked:true,maintenanceOnly:true,context:'TREE_NOT_UPDATED',reports:[]}:{blocked:false,context:'',reports:[]};}}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(patches,1);assert.equal(stops,2);
  assert.ok(state.requests[2].tools.some(t=>t.function.name==='maintain_tree'));
  assert.match(state.requests[2].messages.at(-1).content,/只补齐.*维护/);
  assert.equal(prompts,1);
});

test('legacy maintenance Hook context is classified separately and continues final review',async t=>{
  let stops=0;
  const review={verdict:'pass',reason:'产物已通过',evidence:['实际断言']};
  const state=await run(t,[json({tool_calls:[call('completion_review_submit',review)]},'tool_calls'),
    json({tool_calls:[call('completion_review_submit',review)]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',
    runtime:{hooks:async event=>event==='Stop'&&++stops===1
      ?{blocked:true,maintenanceOnly:false,context:'任务维护未闭环：TREE_NOT_UPDATED',reports:[]}
      :{blocked:false,context:'',reports:[]}}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(stops,2);assert.equal(state.requests.length,2);
});

test('mixed maintenance and unrelated Hook blocks remain a real Hook failure',async t=>{
  const review={verdict:'pass',reason:'产物已通过',evidence:['实际断言']};
  const state=await run(t,[json({tool_calls:[call('completion_review_submit',review)]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',
    runtime:{hooks:async event=>event==='Stop'
      ?{blocked:true,maintenanceOnly:false,context:'TREE_NOT_UPDATED；权限策略阻止',nonMaintenanceBlockers:['global-hook'],reports:[]}
      :{blocked:false,context:'',reports:[]}}
  });
  assert.equal(state.result.status,'failed');
  assert.match(state.result.error.message,/Stop Hook/);
  assert.equal(state.requests.length,1);
});

test('Hook failure details survive the model turn result boundary',async t=>{
  const review={verdict:'pass',reason:'产物通过',evidence:['断言']};
  const reports=[{event:'Stop',source:'policy-hook',blocked:true,maintenanceOnly:false}];
  const state=await run(t,[json({tool_calls:[call('completion_review_submit',review)]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',runtime:{hooks:async event=>event==='Stop'
      ?{blocked:true,maintenanceOnly:false,maintenanceIssues:['TREE_NOT_UPDATED'],nonMaintenanceBlockers:['policy-hook'],context:'TREE_NOT_UPDATED；权限拒绝',reports}
      :{blocked:false,context:'',reports:[]}}
  });
  assert.equal(state.result.status,'failed');
  assert.equal(state.result.error.failureCategory,'hook-blocked');
  assert.deepEqual(state.result.error.maintenanceIssues,['TREE_NOT_UPDATED']);
  assert.deepEqual(state.result.error.nonMaintenanceBlockers,['policy-hook']);
  assert.deepEqual(state.result.error.hookReports,reports);
});

test('maintenance continuation cannot turn an already failed review into pass',async t=>{
  let stops=0;
  const failed={verdict:'failed',reason:'真实断言失败',evidence:['实际失败'],rootCause:'接口错误'};
  const state=await run(t,[json({tool_calls:[call('completion_review_submit',failed)]},'tool_calls'),
    json({tool_calls:[call('completion_review_submit',{...failed,verdict:'pass',reason:'维护已补齐'})]},'tool_calls')],{
    completionReview:true,stopHookPolicy:'fail',runtime:{hooks:async event=>event==='Stop'&&++stops===1?{blocked:true,maintenanceOnly:true,context:'TREE_NOT_UPDATED',reports:[]}:{blocked:false,context:'',reports:[]}}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(JSON.parse(state.result.structuredOutput).verdict,'failed');
  assert.equal(JSON.parse(state.result.structuredOutput).reason,failed.reason);
});

test('final-review failure stops the parent model without another implementation round', async t => {
  const review = { verdict: 'failed', reason: '接口不匹配' };
  const state = await run(t, [json({ tool_calls: [call('task_tree_plan_execute')] }, 'tool_calls')], {
    tools: [schema('task_tree_plan_execute')],
    toolHandler: async () => { const error = new Error('最后检查修复失败：接口不匹配'); error.code = 'COMPLETION_REVIEW_FAILED'; error.review = review; error.workspacePath = '/fixture/failed-candidate'; throw error; }
  });
  assert.equal(state.result.status, 'failed');
  assert.match(state.result.error.message, /接口不匹配/);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.result.error.review, review);
  assert.equal(state.result.error.workspacePath, '/fixture/failed-candidate');
});
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
    // These legacy tests exercise the full-history capacity fallback separately.
    historyPolicy: 'full',
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model' },
    runtimeFactory: async () => runtime,
    onNotification: message => notifications.push(message),
    ...turnOptions
  });
  return { result, requests, requestUrls, notifications, hooks };
}

test('completion publication failure reaches the host once without replaying model or acceptance', async t => {
  let publications=0, failures=0;
  const state=await run(t,[json({content:'执行者工作已结束，结果待宿主整合验收。'})],{
    onCompleted:async()=>{publications++;throw new Error('host acceptance unavailable');},
    onCompletedError:async(error,completed)=>{
      failures++;
      assert.match(error.message,/host acceptance unavailable/);
      assert.equal(completed.status,'completed');
    }
  });
  assert.equal(state.result.status,'failed');
  assert.equal(state.result.error.code,'HOST_COMPLETION_FAILED');
  assert.match(state.result.output,/执行者工作已结束/);
  assert.equal(publications,1);assert.equal(failures,1);
  assert.equal(state.requests.length,1);
});

test('detached background completion settles the host after callback failure',async t=>{
  let release,failed,publications=0;
  const ready=new Promise(resolve=>{release=resolve;});
  const settled=new Promise(resolve=>{failed=resolve;});
  const state=await run(t,[async()=>{await ready;return json({content:'交付已完成'});}],{
    waitForCompletion:false,
    onCompleted:async()=>{publications++;throw new Error('host failure');},
    onCompletedError:async()=>{failed();}
  });
  assert.equal(state.result.status,'running');
  release();await settled;
  assert.equal(publications,1);
  await new Promise(resolve=>setImmediate(resolve));
});

const fallbackEnvironment={MODEL_AGENT_MAIN_BASE_URL:'https://primary.invalid/v1',MODEL_AGENT_MAIN_API_KEY:'test-only',MODEL_AGENT_MAIN_MODEL:'test-model',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:'https://backup-a.invalid/v1,https://backup-b.invalid/v1'};

test('production history tools survive planner tool filtering and restore only requested old narration',async t=>{
  const messages=[{role:'user',content:'讨论附件字符编码'},
    {role:'assistant',content:'旧约定：文件使用 UTF-8，不丢中文。'},
    {role:'user',content:'可以，就这样'}, {role:'assistant',content:'已确认'},
    {role:'user',content:'请回忆附件字符编码'}];
  const state=await run(t,[json({tool_calls:[call('history_search',{query:'UTF-8'})]},'tool_calls'),json({content:'使用 UTF-8'})],{
    historyPolicy:'tree-user-history/v1',messages,runtimeToolNames:['skills_read']
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(!JSON.stringify(state.requests[0].messages).includes('旧约定：'));
  assert.ok(state.requests[0].tools.some(t=>t.function.name==='history_search'));
  assert.ok(state.requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('旧约定：')));
  assert.equal(state.requests.length,2);
  assert.ok(state.hooks.some(h=>h.event==='PreToolUse'&&h.input.tool_name==='history_search'));
});

test('ordinary turn has no retrieval, and parallel history reads use the existing read wave',async t=>{
  let opens=0;
  const runtime={openHistory:async()=>{opens++;return async()=>({sources:[],modelCalls:0});}};
  const ordinary=await run(t,[json({content:'完成'})],{historyPolicy:'tree-user-history/v1',runtime});
  assert.equal(ordinary.requests.length,1);assert.equal(opens,0);
  const state=await run(t,[json({tool_calls:[call('history_search',{query:'配置'},'h1'),call('history_search',{query:'约定'},'h2')]},'tool_calls'),json({content:'完成'})],{historyPolicy:'tree-user-history/v1',runtime});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(opens,1);
  assert.ok(state.result.timing.readWaves.some(w=>w.width===2));
});

test('repeat search does not resend already restored sources while explicit read can restore them',async t=>{
  const messages=[{role:'user',content:'编码要求'}, {role:'assistant',content:'CSV必须UTF-8'},
    {role:'user',content:'别的事'}, {role:'assistant',content:'最近答复'}, {role:'user',content:'回忆编码'}];
  const state=await run(t,[json({tool_calls:[call('history_search',{query:'UTF-8'},'h1')]},'tool_calls'),
    json({tool_calls:[call('history_search',{query:'UTF-8'},'h2')]},'tool_calls'),json({content:'完成'})],{historyPolicy:'tree-user-history/v1',messages});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  const receipts=state.requests[2].messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
  assert.ok(receipts[0].sources.some(s=>s.content==='CSV必须UTF-8'));
  assert.equal(receipts[1].sources.length,0);
});

test('default production policy projects scoped users plus tree once, keeps tools and raw archive', async t => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 测试目标\n- Problem: 留存验收要求\n## A - 当前分支\n- CurrentResult: 已保存A\n# GraphState\n- Current: A\n- Next: A\n# Edges\n');
  const messages=[{role:'user',content:'验收：端口配置完整JSON：{"port":1,"mode":"safe"}'},
    {role:'assistant',content:'过时旁白'}, {role:'user',content:'最新更正：{"port":3}'},
    {role:'assistant',content:'方案二：保存结果'}, {role:'user',content:'按方案二继续'}];
  let saved;
  const state=await run(t,[json({tool_calls:[call('write')]},'tool_calls'),json({content:'完成'})],{
    historyPolicy:'tree-user-history/v1',messages,tools:[schema('write')], toolHandler:async()=>({ok:true,receipt:'真实回执'}),
    runtime:{saveDialogue:async(_,archive)=>{saved=archive;},loadContext:async()=>({summary:'旧旁白摘要',sourceCount:1,fingerprint:'invalid'})}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  const input=JSON.stringify(state.requests[0].messages);
  assert.ok(input.includes('留存验收要求')); assert.ok(input.includes('已保存A'));
  assert.ok(input.includes('safe'));assert.ok(input.includes('方案二：保存结果'));
  assert.ok(!input.includes('过时旁白'));assert.ok(!input.includes('旧旁白摘要'));
  assert.ok(!input.includes('\\"port\\":1'));
  assert.ok(state.requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('真实回执')));
  assert.deepEqual(saved,[...messages,{role:'assistant',content:'完成'}]);
  assert.equal(state.result.timing.historyProjection.treeStatus,'included');
  assert.equal(state.result.timing.summaryRequests?.length||0,0);
});

const glmEnvironment = { ...fallbackEnvironment, MODEL_AGENT_MAIN_MODEL: 'glm-5.3', MODEL_AGENT_MAIN_FALLBACK_MODELS: 'deepseek-v4.1-flash', MODEL_AGENT_MAIN_HEADERS_TIMEOUT_MS: '60000' };

test('post-200 socket failure records the stream stage without replaying accepted output', async t => {
  const response = () => new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"保留这段"},"finish_reason":null}]}\n\n'));
    setImmediate(()=>controller.error(Object.assign(new Error('terminated'),{cause:{code:'UND_ERR_SOCKET'}})));
  }}), {headers:{'content-type':'text/event-stream'}});
  const state=await run(t,[response,json({content:'然后完成'})]);
  assert.equal(state.result.status,'completed',state.result.error?.message); assert.equal(state.result.output,'保留这段然后完成');
  assert.equal(state.requests.length,2);
  assert.ok(state.requests[1].messages.some(m=>m.role==='assistant'&&m.content==='保留这段'));
  assert.equal(state.result.timing.rounds[0].errorCode,'UND_ERR_SOCKET');
  assert.equal(state.result.timing.rounds[0].failedStage,'model-stream');
  assert.ok(Number.isFinite(state.result.timing.rounds[0].attempts[0].totalMs));
});

test('healthy long tools and more than two Stop repairs have no cumulative turn deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let stops = 0, writes = 0;
  const state = await run(t, [json({tool_calls:[call('write')]},'tool_calls'),
    ...Array.from({length:5},()=>json({content:'继续修复'}))], {
    completionTimeoutMs:1000, tools:[schema('write')],
    toolHandler:async()=>{writes++;t.mock.timers.tick(3600000);return {ok:true};},
    runtime:{hooks:async event=>({blocked:event==='Stop' && ++stops<5,context:'仍有可修复事项'})}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);assert.equal(stops,5);
  assert.ok(state.result.timing.totalMs>=3600000);
});

test('API stream stall fails locally while preserving partial output', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let ready;const started=new Promise(r=>ready=r);
  const pending=run(t,[new Response(new ReadableStream({start(stream){
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已保存进度"}}]}\n\n'));
  }}),{headers:{'content-type':'text/event-stream'}})],{
    environment:{...glmEnvironment,MODEL_AGENT_MAIN_STREAM_IDLE_TIMEOUT_MS:'1000'},
    onNotification:event=>{if(event.method==='item/updated')ready();}
  });
  await started;await new Promise(r=>setImmediate(r));t.mock.timers.tick(1000);
  const state=await pending;
  assert.equal(state.result.status,'failed');assert.equal(state.result.error.code,'MODEL_STREAM_IDLE_TIMEOUT');
  assert.match(state.result.output,/已保存进度/);assert.equal(state.requests.length,1);
});

test('SSE DONE ends a completed response without waiting for a gateway to close its connection', async t => {
  let cancelled=0;
  const frames=[
    {choices:[{delta:{content:'完整结果'},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'stop'}]},
    {choices:[],usage:{prompt_tokens:17,completion_tokens:3,total_tokens:20}}
  ];
  const response=new Response(new ReadableStream({start(stream){
    const text=frames.map(frame=>`data: ${JSON.stringify(frame)}\r\n\r\n`).join('')+'data: [DONE]\r\n\r\n';
    for(const byte of new TextEncoder().encode(text))stream.enqueue(Uint8Array.of(byte));
    // A gateway can leave its HTTP body open after its protocol terminator.
  },cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});
  const state=await run(t,[response],{environment:{...fallbackEnvironment,MODEL_AGENT_MAIN_STREAM_IDLE_TIMEOUT_MS:'100'}});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(state.result.output,'完整结果');
  assert.equal(state.result.timing.rounds[0].tokenUsage.totalTokens,20);
  assert.equal(state.requests.length,1);assert.equal(cancelled,1);
});

test('DONE without a completion reason cannot execute partial tools or claim success',async t=>{
  let writes=0;
  const text='data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...call('write',{value:'partial'})}]}}]})+'\n\ndata: [DONE]\n\n';
  const response=new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(text));stream.close();}}),{headers:{'content-type':'text/event-stream'}});
  const state=await run(t,[response,json({content:'重新读取后完成'})],{tools:[schema('write')],toolHandler:async()=>{writes++;return {ok:true};}});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(state.requests.length,2);assert.equal(writes,0);
  assert.equal(state.result.timing.rounds[0].errorCode,'MODEL_STREAM_INCOMPLETE');
});

test('healthy API streaming resets idle timeout and can exceed ten minutes', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let stream,ready;const started=new Promise(r=>ready=r);
  const encode=data=>new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  const pending=run(t,[new Response(new ReadableStream({start(s){stream=s;
    s.enqueue(encode({choices:[{delta:{content:'开始'}}]}));
  }}),{headers:{'content-type':'text/event-stream'}})],{completionTimeoutMs:1000,
    environment:{...glmEnvironment,MODEL_AGENT_MAIN_STREAM_IDLE_TIMEOUT_MS:'60000'},
    onNotification:e=>{if(e.method==='item/updated')ready();}
  });
  await started;
  for(let i=0;i<30;i++){
    await new Promise(r=>setImmediate(r));t.mock.timers.tick(30000);
    stream.enqueue(encode({choices:[{delta:{content:'继续'}}]}));
  }
  stream.enqueue(encode({choices:[{delta:{},finish_reason:'stop'}]}));stream.close();
  const state=await pending;assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(state.result.timing.totalMs>=900000);assert.equal(state.requests.length,1);
});

test('manual Stop interrupts a pending API body read even when the body ignores fetch cancellation', async t=>{
  const controller=new AbortController();let ready;const started=new Promise(r=>ready=r);
  const pending=run(t,[new Response(new ReadableStream({start(s){
    s.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"进度"}}]}\n\n'));
  }}),{headers:{'content-type':'text/event-stream'}})],{signal:controller.signal,
    onNotification:e=>{if(e.method==='item/updated')ready();}});
  await started;controller.abort();const state=await pending;
  assert.equal(state.result.status,'stopped');assert.match(state.result.output,/进度/);
});

test('GLM failures switch model and gateway in the same turn without replaying saved tools or Hooks', async t => {
  let writes = 0;
  const state = await run(t, [json({ tool_calls: [call('write')] }, 'tool_calls'), gatewayFailure(),
    json({ tool_calls: [call('read_file')] }, 'tool_calls'), json({ content: '恢复完成' })], {
    environment: glmEnvironment, tools: ['write', 'read_file'].map(schema),
    toolHandler: async name => { if (name === 'write') writes++; return { ok: true }; }
  });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.deepEqual(state.requests.map(r => r.model), ['glm-5.3', 'glm-5.3', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash']);
  assert.deepEqual(state.requests[1].messages, state.requests[2].messages);
  assert.equal(writes, 1);
  assert.equal(state.hooks.filter(h => h.event === 'UserPromptSubmit').length, 1);
  assert.equal(state.result.timing.rounds[1].model, 'deepseek-v4.1-flash');
  assert.equal(state.result.timing.rounds[1].attempts[0].model, 'glm-5.3');
  assert.match(state.notifications.find(n => n.params?.nextModel).params.message, /glm-5.3.*deepseek-v4.1-flash/);
});

test('silent response headers switch to DeepSeek within the configured header budget rather than 300 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let started;
  const ready = new Promise(resolve => started = resolve);
  const silent = init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); started();
  });
  const pending = run(t, [silent, json({ content: '备用模型完成' })], {
    environment: { ...glmEnvironment, MODEL_AGENT_MAIN_FALLBACK_BASE_URLS: '' }, completionTimeoutMs: 120000
  });
  await ready;
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const state = await pending;
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.deepEqual(state.requests.map(r => r.model), ['glm-5.3', 'deepseek-v4.1-flash']);
  assert.equal(state.result.timing.rounds[0].attempts[0].errorCode, 'MODEL_HEADERS_TIMEOUT');
});

test('a missing GLM alias can fall back, but authentication errors cannot', async t => {
  const unavailable = await run(t, [new Response('model_not_found', { status: 404 }), json({ content: '完成' })], { environment: glmEnvironment });
  assert.equal(unavailable.result.status, 'completed');
  assert.equal(unavailable.requests[1].model, 'deepseek-v4.1-flash');
  t.mock.restoreAll();
  const denied = await run(t, [new Response('denied', { status: 401 })], { environment: glmEnvironment });
  assert.equal(denied.result.status, 'failed');
  assert.equal(denied.requests.length, 1);
});

test('a partial streamed reply continues without switching models or replaying the turn', async t => {
  const state = await run(t, [new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已输出"}}]}\n\n'));
    setImmediate(() => stream.error(Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' })));
  } }), { headers: { 'content-type': 'text/event-stream' } }),json({content:'继续完成'})], { environment: glmEnvironment });
  assert.equal(state.result.status, 'completed');
  assert.equal(state.requests.length, 2);
  assert.equal(state.result.output,'已输出继续完成');
});

test('GLM is the unconfigured model default and planner can select its own fallback', () => {
  const env = { MODEL_AGENT_MAIN_BASE_URL: 'https://fixture.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: '', TASK_TREE_PLANNER_MODEL: '' };
  const config = loadDeepSeekConfig(root, { environment: env });
  assert.equal(config.model, 'glm-5.3');
  assert.equal(config.contextWindowTokens, 270000);
  assert.equal(config.contextCompactionThresholdTokens, 200000);
  assert.deepEqual(config.fallbackModels, ['deepseek-v4.1-flash']);
  const planner = loadDeepSeekConfig(root, { role: 'planner', environment: { ...env, TASK_TREE_PLANNER_FALLBACK_MODELS: 'deepseek-v4.1-flash' } });
  assert.deepEqual(planner.fallbackModels, ['deepseek-v4.1-flash']);
});

test('GLM and DeepSeek share three attempts before a new recovery request', async t => {
  const state = await run(t, [gatewayFailure(), gatewayFailure(503), gatewayFailure(504),json({content:'恢复'})], { environment: glmEnvironment });
  assert.equal(state.result.status, 'completed');
  assert.deepEqual(state.requests.map(r => r.model), ['glm-5.3', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash','glm-5.3']);
  assert.equal(state.result.timing.rounds[0].attempts.length,3);
});

test('cancellation while awaiting GLM headers never launches DeepSeek', async t => {
  const controller = new AbortController();
  const state = await run(t, [init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    setImmediate(() => controller.abort());
  })], { environment: glmEnvironment, signal: controller.signal });
  assert.equal(state.result.status, 'stopped');
  assert.equal(state.requests.length, 1);
});

test('main generation does not impose a fixed 4000 token ceiling on reasoning plus tool arguments', async t => {
  const state=await run(t,[json({content:'完整结果'})]);
  assert.equal(state.result.status,'completed');
  assert.equal(Object.hasOwn(state.requests[0],'max_tokens'),false);
});

test('user cancellation interrupts a live stream, retains partial dialogue and publishes only after cleanup', async t => {
  const controller = new AbortController(), saved = [], lifecycle = [];
  const state = await run(t, [init => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已收到的中文"}}]}\n\n'));
    init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true });
    setImmediate(() => controller.abort());
  } }), { headers: { 'content-type': 'text/event-stream' } })], {
    signal: controller.signal, dialogueContext: [{ role: 'user', content: '原问题' }],
    runtime: { saveDialogue: async (_, messages) => saved.push(messages), close: async () => lifecycle.push('closed') },
    onCompleted: result => { lifecycle.push('published'); assert.equal(result.status, 'stopped'); }
  });
  assert.equal(state.result.status, 'stopped'); assert.equal(state.result.error, undefined);
  assert.equal(state.result.output, '已收到的中文'); assert.equal(state.requests.length, 1);
  assert.deepEqual(state.result.messages, [{ role: 'user', content: '原问题' }, { role: 'assistant', content: '已收到的中文',presentation:{process:'已收到的中文',answer:''} }]);
  assert.deepEqual(saved.at(-1), state.result.messages); assert.deepEqual(lifecycle, ['closed', 'published']);
});

test('user cancellation during retry backoff prevents all subsequent requests', async t => {
  const controller = new AbortController();
  const state = await run(t, [() => { setTimeout(() => controller.abort(), 30); return new Response('暂时异常', { status: 502 }); }], { signal: controller.signal });
  assert.equal(state.result.status, 'stopped'); assert.equal(state.requests.length, 1);
});

test('cancelling a tool stops its signal and prevents the next write and model round', async t => {
  const controller = new AbortController(), executed = [];
  const state = await run(t, [json({ content: '开始工具', tool_calls: [call('long_tool'), call('next_write')] }, 'tool_calls')], {
    signal: controller.signal, tools: [schema('long_tool'), schema('next_write')],
    toolHandler: async (name, _, context) => {
      executed.push(name);
      return new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); setImmediate(() => controller.abort()); });
    }
  });
  assert.equal(state.result.status, 'stopped'); assert.deepEqual(executed, ['long_tool']);
  assert.equal(state.requests.length, 1); assert.equal(state.result.output, '开始工具');
});

test('already cancelled turns do not load a runtime or send a request', async t => {
  const controller = new AbortController(); controller.abort();
  const cancelled = await run(t, [], { signal: controller.signal, runtimeFactory: async () => { throw new Error('must not load'); } });
  assert.equal(cancelled.result.status, 'stopped'); assert.equal(cancelled.requests.length, 0);
});

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

test('MCP render image blocks use native vision, not textual Base64, and keep all receipts and captions', async t => {
  const bytes = 'MCP_RENDER_BYTES'.repeat(80000);
  const state = await run(t, [json({tool_calls:[call('task_tree_render',{},'render'),call('read_file',{},'read')]},'tool_calls'),json({content:'看图完成'})], {
    tools:[schema('task_tree_render'),schema('read_file')],
    toolHandler:async name => name === 'task_tree_render' ? {content:[
      {type:'image',mimeType:'image/png',data:bytes},
      {type:'text',text:'任务图：测试，当前节点 ROOT'},
      {type:'image',mimeType:'image/jpeg',data:'SECOND_IMAGE'}
    ]} : {ok:true}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  const messages=state.requests[1].messages, receipts=messages.filter(m=>m.role==='tool');
  assert.equal(receipts.length,2);
  assert.ok(!receipts.some(m=>m.content.includes(bytes)),'MCP image bytes cannot become text tokens');
  const visual=messages.find(m=>Array.isArray(m.content));
  assert.equal(visual?.content.filter(c=>c.type==='image_url').length,2);
  assert.ok(receipts.every(m=>messages.indexOf(m)<messages.indexOf(visual)));
  assert.ok(receipts.some(m=>m.content.includes('当前节点 ROOT')));
  assert.ok(!JSON.stringify(state.hooks).includes(bytes));
  assert.ok(!JSON.stringify(state.notifications).includes(bytes));
  assert.ok(!JSON.stringify(state.result.messages).includes(bytes));
  assert.ok(estimateContextTokens(messages)<10000,'two images count as vision, not hundreds of thousands of text tokens');
});

test('blocked MCP render images never bypass PostToolUse',async t=>{
  const state=await run(t,[json({tool_calls:[call('task_tree_render')]},'tool_calls'),json({content:'已阻止'})],{
    tools:[schema('task_tree_render')],toolHandler:async()=>({content:[{type:'image',mimeType:'image/png',data:'BLOCKED_MCP_BYTES'}]}),
    runtime:{hooks:async event=>({blocked:event==='PostToolUse',context:event==='PostToolUse'?'禁止发送':''})}
  });
  assert.ok(!JSON.stringify(state.requests[1]).includes('BLOCKED_MCP_BYTES'));
});

test('user-facing task graph screenshots never enter model requests, while image provenance is measured',async t=>{
  const state=await run(t,[json({tool_calls:[call('task_tree_render')]},'tool_calls'),json({content:'已展示；读取结构继续任务。'})],{
    tools:[schema('task_tree_render')],toolHandler:async()=>({content:[{type:'image',mimeType:'image/png',data:'ONLY_USER_GRAPH',annotations:{audience:['user']}},{type:'text',text:'任务图已生成'}]})
  });
  assert.equal(state.result.status,'completed');
  assert.ok(!JSON.stringify(state.requests).includes('ONLY_USER_GRAPH'));
  assert.ok(!JSON.stringify(state.hooks).includes('ONLY_USER_GRAPH'));
  assert.equal(state.result.timing.tools[0].imageSource,'task_tree_render');
  assert.equal(state.result.timing.tools[0].imageInputs,0);
});

test('image stays in a failed request retry, disappears after one successful tool-only response, and deduplicates rereads',async t=>{
  const bytes='ONE_TIME_IMAGE';
  const state=await run(t,[json({tool_calls:[call('view_image')]},'tool_calls'),new Response('upstream',{status:502}),
    json({tool_calls:[call('work')]},'tool_calls'),json({tool_calls:[call('view_image')]},'tool_calls'),json({content:'完成'})],{
    tools:[schema('view_image'),schema('work')],toolHandler:async name=>name==='view_image'?{image:{mimeType:'image/png',data:bytes}}:{ok:true}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(JSON.stringify(state.requests[1]).includes(bytes));
  assert.ok(JSON.stringify(state.requests[2]).includes(bytes),'retry must still contain the image');
  assert.ok(!JSON.stringify(state.requests[3]).includes('base64,'+bytes),'no textual reply is required for acknowledgement');
  assert.ok(!JSON.stringify(state.requests[4]).includes('base64,'+bytes),'same file reread does not redeliver without explicit recall');
});

test('tool and user images send once after success, remain exactly recallable, and never mutate original attachments', async t => {
  const bytes='EXACT_TOOL_IMAGE_BYTES'.repeat(10000);
  const uploads={role:'user',content:[{type:'text',text:'用户原始附件'},{type:'image_url',image_url:{url:'data:image/png;base64,USER_UPLOAD_BYTES'}}]};
  let reference;const imageNotifications=[];
  const responses=[json({tool_calls:[call('view_image')]},'tool_calls'),
    ...Array.from({length:4},(_,i)=>json({content:i===0?'已看清截图，当前界面可继续操作。':'继续下一项操作。',tool_calls:[call('work',{},`w-${i}`)]},'tool_calls')),
    ()=>json({tool_calls:[call('tool_image_recall',{reference})]},'tool_calls'),json({content:'复查原图完成'})];
  const state=await run(t,responses,{
    messages:[uploads],tools:[schema('view_image'),schema('work')],
    toolHandler:async name=>name==='view_image'?{path:'/tmp/no-longer-present.png',image:{mimeType:'image/png',data:bytes}}:{ok:true},
    onNotification:message=>{
      imageNotifications.push(message);
      if(message.method==='tool/completed'&&message.params.toolName==='view_image') reference=message.params.result.image.reference;
    }
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(reference);
  assert.ok(JSON.stringify(state.requests[1]).includes(bytes));
  assert.ok(!JSON.stringify(state.requests[2]).includes(bytes),'successful first response releases image immediately');
  assert.ok(!JSON.stringify(state.requests[1]).includes('USER_UPLOAD_BYTES'),'user image also sends once per successful consumption');
  assert.ok(JSON.stringify(uploads).includes('USER_UPLOAD_BYTES'),'original user attachment is never changed');
  assert.ok(JSON.stringify(state.requests[5]).includes(reference));
  assert.ok(JSON.stringify(state.requests[6]).includes(bytes),'recall restores the exact original even if its temporary path no longer exists');
  assert.ok(!JSON.stringify(state.result.messages).includes(bytes));
  assert.ok(imageNotifications.some(n=>n.method==='context/tool-images-released'&&n.params.bytesSaved>200000));
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
  assert.equal(images.content.filter(c => c.type === 'image_url').length, 1,'same original within a batch sends once');
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

test('gateway exhaustion renews at the session boundary with three attempts per request', async t => {
  const state = await run(t, [gatewayFailure(), gatewayFailure(504), gatewayFailure(),json({content:'恢复完成'})]);
  assert.equal(state.result.status, 'completed',state.result.error?.message);
  assert.equal(state.requests.length, 4);
  assert.deepEqual(state.requests[0].messages,state.requests[3].messages);
  assert.deepEqual(state.result.timing.rounds[0].attempts.map(a => a.status), [502, 504, 502]);
});

test('a slow healthy inference may win after a backup starts; hedging must not abort it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releasePrimary, releaseBackup, primaryAborted = false, primaryStarted;
  const started = new Promise(resolve => { primaryStarted = resolve; });
  const statePromise = run(t, [
    init => new Promise((resolve, reject) => {
      releasePrimary = resolve;
      init.signal.addEventListener('abort', () => { primaryAborted = true; reject(init.signal.reason); }, { once: true });
      primaryStarted();
    }),
    () => new Promise(resolve => { releaseBackup = resolve; })
  ], { environment: fallbackEnvironment });
  await started;
  try {
    t.mock.timers.tick(46000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseBackup, 'function', 'the backup should start without waiting for the primary to fail');
    releasePrimary(json({ content: '较慢的主请求成功' }));
    const state = await statePromise;
    assert.equal(state.result.status, 'completed', state.result.error?.message);
    assert.equal(state.result.output, '较慢的主请求成功');
    assert.equal(primaryAborted, false, 'slow inference is not a failed gateway');
    assert.equal(state.requests.length, 2);
  } finally {
    releasePrimary?.(json({ content: '清理' }));
    releaseBackup?.(json({ content: '清理' }));
  }
});

test('a healthy backup wins while a slow primary is cancelled only after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started, primaryAborted = false;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = run(t, [init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { primaryAborted = true; reject(init.signal.reason); }, { once: true });
    started();
  }), json({ content: '备用成功' })], { environment: fallbackEnvironment });
  await ready;
  t.mock.timers.tick(45000);
  const state = await pending;
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(state.result.output, '备用成功');
  assert.equal(primaryAborted, true);
  assert.equal(state.requests.length, 2);
});

test('a rejected backup cannot cancel a still-healthy primary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started, releasePrimary;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = run(t, [() => new Promise(resolve => { releasePrimary = resolve; started(); }), gatewayFailure(400)], { environment: fallbackEnvironment });
  await ready;
  try {
    t.mock.timers.tick(45000);
    await new Promise(resolve => setImmediate(resolve));
    releasePrimary(json({ content: '主请求仍然成功' }));
    const state = await pending;
    assert.equal(state.result.status, 'completed', state.result.error?.message);
    assert.equal(state.result.output, '主请求仍然成功');
    assert.equal(state.requests.length, 2);
  } finally { releasePrimary?.(json({ content: '清理' })); }
});

test('three silent gateways fail from request-local header timeouts, not task age', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const silent = init => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    started();
  });
  const pending = run(t, [silent, silent, silent], { environment: fallbackEnvironment, completionTimeoutMs: 120000 });
  await ready;
  for(let i=0;i<8;i++){t.mock.timers.tick(45000);await new Promise(resolve=>setImmediate(resolve));}
  const state = await pending;
  assert.equal(state.result.status, 'failed');
  assert.match(state.result.error.message, /MODEL_HEADERS_TIMEOUT/);
  assert.equal(state.result.error.code,'MODEL_HEADERS_TIMEOUT');
  assert.equal(state.requests.length, 3);
  assert.ok(state.result.timing.rounds[0].attempts.every(attempt => attempt.errorCode === 'MODEL_HEADERS_TIMEOUT'));
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
  const state = await run(t, [sse([{ choices: [{ delta: { content: '已输出部分' } }] }]),json({content:'续完'})]);
  assert.equal(state.result.status, 'completed');
  assert.equal(state.requests.length, 2);
  assert.equal(state.result.output,'已输出部分续完');
  assert.equal(state.notifications.some(n => n.method === 'model/request-retrying'), false);
});

test('Retry-After may outlive an obsolete completion timeout and still recover', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let ready;const started=new Promise(r=>ready=r);
  const pending=run(t,[gatewayFailure(503,{'retry-after':'60'}),json({content:'恢复完成'})],{
    completionTimeoutMs:1000,onNotification:m=>{if(m.method==='model/request-retrying')ready();}
  });
  await started;t.mock.timers.tick(60000);
  const state=await pending;assert.equal(state.result.status,'completed');assert.equal(state.requests.length,2);
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

test('524 respects 120-second Retry-After without a task deadline', async t => {
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

test('manual cancellation aborts an active backoff and never sends the next request', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let notifyRetry;
  const ready=new Promise(resolve=>{notifyRetry=resolve;});
  const controller=new AbortController();
  const pending=run(t,[gatewayFailure(524,{'retry-after':'120'})],{
    signal:controller.signal,
    onNotification:message=>{if(message.method==='model/request-retrying')notifyRetry();}
  });
  await ready;
  controller.abort();
  const state=await pending;
  assert.equal(state.result.status,'stopped');
  assert.equal(state.requests.length,1);
});

test('Stop block is sent back for repair without a repair-count cap', async t => {
  let attempts = 0;
  const repaired = await run(t, [json({ content: '未完成' }), json({ content: '已修复' })], {
    runtime: { hooks: async event => ({ blocked: event === 'Stop' && attempts++ === 0, context: '修复树节点' }) }
  });
  assert.equal(repaired.result.status, 'completed');
  assert.match(repaired.requests[1].messages.at(-1).content, /修复树节点/);
  assert.ok(repaired.notifications.some(message=>message.method==='execution/continuing' && message.params.reason==='stop-hook'), 'repair after completed prose must be explicitly visible');
});

test('tool errors become structured tool results for correction', async t => {
  const errored = await run(t, [json({ tool_calls: [call('read_file')] }, 'tool_calls'), json({ content: '报告错误' })], {
    tools: [schema('read_file')], toolHandler: async () => { throw new Error('不存在'); }
  });
  assert.deepEqual(JSON.parse(errored.requests[1].messages.at(-1).content), { ok: false, error: '不存在' });
});

test('large command output stays lossless on disk instead of forcing an immediate model summary',async t=>{
  const original={ok:false,exitCode:127,timedOut:false,stdout:'旧资料记录\n'.repeat(20000)+'最后一条必须保留\n',stderr:'命令尾部报错\n'};
  let executions=0;
  const state=await run(t,[json({tool_calls:[call('exec_command')]},'tool_calls'),json({content:'已根据落盘回执继续'})],{
    tools:[schema('exec_command')],toolHandler:async()=>{executions++;return original;}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(executions,1);
  assert.equal(state.requests.length,2);
  const receipt=JSON.parse(state.requests[1].messages.at(-1).content);
  assert.equal(receipt.exitCode,127);
  assert.equal(receipt.ok,false);
  assert.equal(typeof receipt.stdout,'undefined');
  assert.equal(await readFile(receipt.archivedOutput.stdoutPath,'utf8'),original.stdout);
  assert.equal(await readFile(receipt.archivedOutput.stderrPath,'utf8'),original.stderr);
  assert.deepEqual(JSON.parse(await readFile(receipt.archivedOutput.receiptPath,'utf8')),original);
  assert.deepEqual(state.notifications.find(n=>n.method==='tool/completed').params.result,original,'Hooks and user events keep the original receipt');
  assert.equal(state.notifications.some(n=>n.method==='context/compaction-started'),false);
  await rm(path.dirname(receipt.archivedOutput.receiptPath),{recursive:true,force:true});
});

test('tool execution continues past 40 rounds until the model completes, with no repeated writes', async t => {
  let writes = 0;
  const rounds = Array.from({ length: 55 }, (_, i) => json({ content: `第 ${i + 1} 轮`, tool_calls: [call('task_tree_write', { round: i + 1 }, `write-${i}`)] }, 'tool_calls'));
  const state = await run(t, [...rounds, json({ content: '所有工具工作已完成' })], {
    tools: [schema('task_tree_write')], toolHandler: async (_, args) => { assert.equal(args.round, ++writes); return { ok: true, saved: args.round }; }
  });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(writes, 55); assert.equal(state.requests.length, 56);
  assert.equal(state.result.timing.tools.length, 55); assert.equal(state.result.timing.rounds.length, 56);
  assert.ok(state.result.output.endsWith('所有工具工作已完成'));
});

test('manual stop remains effective after the previous tool round limit without starting another write', async t => {
  const controller = new AbortController(); let writes = 0;
  const state = await run(t, Array.from({ length: 45 }, (_, i) => json({ tool_calls: [call('task_tree_write', {}, `write-${i}`)] }, 'tool_calls')), {
    signal: controller.signal, tools: [schema('task_tree_write')],
    toolHandler: async () => { if (++writes === 45) controller.abort(); return { ok: true }; }
  });
  assert.equal(state.result.status, 'stopped'); assert.equal(writes, 45); assert.equal(state.requests.length, 45);
});

test('long history is summarized before execution without deleting archive text; cached summary resumes without another summary request', async t => {
  const original = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `原文${i}：` + '历史文字'.repeat(450) }));
  const messages = [...original, { role: 'user', content: '最新要求：只改N9，保留其他节点' }];
  const saved = [];
  const environment = { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' };
  const state = await run(t, Array.from({ length: 100 }, () => init => {
    const body = JSON.parse(init.body);
    return isSummary(body) ? sse([{choices:[{delta:{content:'用户目标：维护树；历史状态：已读文件；未决：完成N9。'},finish_reason:'stop'}]}]) : json({ content: '已经完成N9' });
  }), { messages, environment, runtime: { saveDialogue: async (_, archive, cache) => saved.push({ archive, cache }) } });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.ok(state.requests.filter(isSummary).every(body => body.stream === true));
  const main = state.requests.find(body => !isSummary(body));
  assert.ok(main.messages.some(m => m.content?.includes('历史上下文摘要')));
  assert.ok(main.messages.some(m => m.content === messages.at(-1).content));
  assert.deepEqual(saved.at(-1).archive, [...messages, { role: 'assistant', content: '已经完成N9' }]);
  assert.deepEqual(state.result.messages, saved.at(-1).archive);
  assert.ok(state.result.timing.compactions.length);
  for(const request of state.requests.filter(request=>request.messages[0]?.content?.includes('只生成中文交接摘要')))
    assert.equal(Object.hasOwn(request,'max_tokens'),false,'summary reasoning must not exhaust a fixed output cap before producing the handoff');
  assert.ok(state.result.timing.summaryRequests.every(s => Number.isFinite(s.totalMs)));
  assert.ok(!state.result.output.includes('用户目标：维护树'), 'summary is not presented as a new model reply');
  assert.ok(saved.at(-1).cache?.summary);
  t.mock.restoreAll();
  const resumed = await run(t, [json({ content: '继续完成' })], { threadId: state.result.threadId, environment,
    runtime: { loadDialogue: async () => saved.at(-1).archive, loadContext: async () => saved.at(-1).cache, saveDialogue: async (_, archive, cache) => { assert.ok(cache?.summary); } } });
  assert.equal(resumed.result.status, 'completed', resumed.result.error?.message);
  assert.equal(resumed.requests.length, 1);
  assert.ok(resumed.requests[0].messages.some(m => m.content?.includes('历史上下文摘要')));
});

test('real input usage is reused across zero-usage gateway rounds instead of repeatedly summarizing tools', async t => {
  const response = (message, inputTokens) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 } }), { headers: { 'content-type': 'application/json' } });
  let reads = 0;
  const replies = [response({tool_calls:[call('read')]},22815), response({tool_calls:[call('read')]},0), response({content:'两次读取已完成'},0)];
  const state = await run(t, Array.from({length:10},()=>init => isSummary(JSON.parse(init.body)) ? json({content:'工具事实摘要'}) : replies.shift()), {
    runtime:{systemPrompt:'全局规则'.repeat(6500)}, tools:[schema('read')],
    toolHandler:async()=>{reads++;return {content:'文件'.repeat(5000)};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(reads,2);
  assert.equal(state.result.timing.summaryRequests?.length || 0,0,'accepted input plus new data still fits the 64K window');
  assert.equal(state.requests.length,3);
  assert.equal(state.result.timing.rounds[2].contextInput.basis,'accepted-usage-plus-estimated-delta');
  assert.ok(state.result.timing.rounds[2].contextInput.rawEstimateTokens > 60000);
  assert.ok(state.result.timing.rounds[2].contextInput.estimatedInputTokens < 60000);
  assert.ok(state.requests.at(-1).messages.filter(m=>m.role==='tool').every(m=>m.content.includes('文件'.repeat(5000))), 'no file text is truncated');
});

test('stream usage uses final cumulative counts instead of keeping an early zero placeholder', async t => {
  const state = await run(t, [sse([
    {choices:[{delta:{content:'完成'},finish_reason:null}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}},
    {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:22815,completion_tokens:100,total_tokens:22915}},
    {choices:[],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}
  ])]);
  assert.equal(state.result.status,'completed');
  assert.equal(state.result.tokenUsage.inputTokens,22815);
  assert.equal(state.result.timing.rounds[0].tokenUsage.totalTokens,22915);
});

test('history below capacity goes directly to execution without optional summary requests', async t => {
  const messages = [...Array.from({length:8},()=>({role:'assistant',content:'旧'.repeat(1200)})),{role:'user',content:'继续保存'}];
  let writes = 0;
  const state = await run(t, [json({tool_calls:[call('write')]},'tool_calls'), json({content:'保存完成'})], {
    messages, tools:[schema('write')], toolHandler: async()=>{writes++;return {ok:true};},
    environment: {...glmEnvironment, MODEL_AGENT_MAIN_CONTEXT_WINDOW:'20000', MODEL_AGENT_MAIN_HEADERS_TIMEOUT_MS:'5'}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);
  assert.equal(state.result.timing.summaryRequests?.length || 0,0);
  const main = state.requests.filter(body=>!isSummary(body));
  for (const request of main) assert.equal(request.model,'glm-5.3');
  assert.deepEqual(main[0].messages.filter(m=>m.role!=='system'),messages);
  assert.ok(!state.notifications.some(n=>n.method.startsWith('context/compaction-')));
});

test('mandatory summary API timeout exposes its stage and failed timing rather than blaming the main model', async t => {
  const messages = [...Array.from({length:12},()=>({role:'assistant',content:'历史文字'.repeat(100)})),{role:'user',content:'继续'}];
  const state=await run(t,Array.from({length:8},()=>init=>isSummary(JSON.parse(init.body))
    ?Promise.reject(Object.assign(new Error('headers timed out'),{code:'MODEL_HEADERS_TIMEOUT'}))
    :new Response('context_length_exceeded: maximum context length',{status:400})),{
    messages,environment:{...glmEnvironment,MODEL_AGENT_MAIN_CONTEXT_WINDOW:'18000'}
  });
  assert.equal(state.result.status,'failed');
  assert.equal(state.result.error.stage,'context-summary');
  assert.match(state.result.error.message,/上下文摘要失败/);
  assert.equal(state.result.timing.rounds.length,1);
  assert.equal(state.result.timing.rounds[0].contextRejected,true);
  assert.equal(state.result.timing.summaryRequests[0].attempts.length,3);
  assert.equal(state.result.timing.summaryRequests[0].status,'failed');
});

test('mandatory recovery repairs an oversize draft and survives exhausted summary gateway attempts without replaying tools',async t=>{
  let mains=0,summaries=0,writes=0;const draft='完整中文草稿'.repeat(1200)+'末尾：接口v2，操作已保存，不重复。';
  const state=await run(t,Array.from({length:30},()=>init=>{
    const body=JSON.parse(init.body);
    if(isSummary(body)){
      summaries++;
      if(summaries<=3)return new Response('temporary summary gateway',{status:502});
      if(summaries===4)return json({content:draft});
      assert.match(body.messages[0].content,/只语义精炼/);
      assert.ok(body.messages[1].content.includes(draft),'complete draft is repaired, including tail');
      assert.ok(!body.messages[1].content.includes('RAW_HISTORY_SENTINEL'));
      return json({content:'接口v2，保存操作已完成，不重放；继续最终验收。'});
    }
    if(++mains===1)return json({tool_calls:[call('write',{},'saved-once')]},'tool_calls');
    if(mains===2)return new Response('prompt is too long: 1743408 tokens > 1048576 maximum',{status:400});
    return json({content:'接口v2已完成验收。'});
  }),{messages:[...Array.from({length:8},()=>({role:'assistant',content:'RAW_HISTORY_SENTINEL 历史事实。'.repeat(60)})),{role:'user',content:'继续验收，不重做保存。'}],
    tools:[schema('write')],toolHandler:async()=>{writes++;return {ok:true,saved:true};},
    environment:{MODEL_AGENT_MAIN_BASE_URL:'https://isolated.invalid',MODEL_AGENT_MAIN_API_KEY:'test-only',MODEL_AGENT_MAIN_MODEL:'test-model',MODEL_AGENT_MAIN_FALLBACK_MODELS:''}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);assert.equal(mains,3);assert.equal(summaries,5);
  assert.ok(state.result.timing.summaryRequests.some(s=>s.purpose==='summary-repair'));
  assert.ok(state.notifications.some(n=>n.method==='context/compaction-retrying'));
});

test('automatic handoff adapts a smaller summary endpoint window before making the main request',async t=>{
  const accepted=[];let rejected=0;
  const messages=[{role:'assistant',content:'旧事实：已保存接口v2。'.repeat(1400)+'末尾验收：PINE-92。'},{role:'user',content:'继续验收，不重放保存。'}];
  const original=JSON.stringify(messages);
  const state=await run(t,Array.from({length:100},()=>init=>{
    const body=JSON.parse(init.body);
    if(isSummary(body)){
      const prefix='以下是按时间顺序排列的历史消息片段：\n';
      const content=body.messages.at(-1).content;
      const batch=content.slice(content.indexOf(prefix)+prefix.length);
      if(Buffer.byteLength(batch)>5000){rejected++;return new Response(JSON.stringify({error:{message:JSON.stringify({msg:'prompt is too long: 12000 tokens > 8192 maximum'})}}),{status:400});}
      accepted.push(batch);return json({content:'已保存接口v2；末尾验收PINE-92；不重放。'});
    }
    assert.ok(accepted.length>1);assert.ok(JSON.stringify(body.messages).includes('PINE-92'));
    return json({content:'接口v2、PINE-92已验收。'});
  }),{messages,environment:{...glmEnvironment,MODEL_AGENT_MAIN_CONTEXT_WINDOW:'18000',MODEL_AGENT_MAIN_FALLBACK_MODELS:''}});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(rejected>0);
  assert.equal(accepted.join(''),JSON.stringify(messages[0]),'all history, including its tail, reaches the summary model');
  assert.equal(state.result.timing.rounds.length,1,'no oversized main request is used to trigger recovery');
  assert.ok(state.result.timing.summaryRequests.some(s=>s.status==='failed'));
  assert.ok(state.result.timing.compactions.some(s=>s.reason==='summary-capacity'));
  assert.equal(JSON.stringify(messages),original);
});

test('summary fallback model stays auxiliary and streaming deltas never appear in the chat', async t => {
  const messages=[...Array.from({length:8},()=>({role:'assistant',content:'旧'.repeat(1200)})),{role:'user',content:'继续'}];
  const state=await run(t,[new Response('unavailable',{status:502}),
    sse([{choices:[{delta:{reasoning_content:'内部推理哨兵'},finish_reason:null}]},{choices:[{delta:{content:'内部摘要哨兵'},finish_reason:'stop'}]}]),json({content:'工作完成'})],{
      messages,environment:{...glmEnvironment,MODEL_AGENT_MAIN_CONTEXT_WINDOW:'18000'}
    });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.deepEqual(state.requests.map(r=>r.model),['glm-5.3','deepseek-v4.1-flash','glm-5.3']);
  assert.ok(state.requests.at(-1).messages.some(m=>m.content?.includes('内部摘要哨兵')));
  assert.ok(!JSON.stringify(state.result.messages).includes('内部摘要哨兵'));
  assert.ok(!JSON.stringify(state.notifications.filter(n=>n.method==='item/updated')).includes('内部'));
  assert.ok(Number.isFinite(state.result.timing.summaryRequests[0].firstDeltaMs));
});

test('summary retry is never reported as completed with undefined token counts', async t => {
  const messages=[...Array.from({length:8},()=>({role:'assistant',content:'旧'.repeat(1200)})),{role:'user',content:'继续'}];
  const state=await run(t,[json({content:''}),json({content:'已保留当前目标和有效进度'}),json({content:'工作完成'})],{
    messages,environment:{...glmEnvironment,MODEL_AGENT_MAIN_CONTEXT_WINDOW:'18000'}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  const retry=state.notifications.find(n=>n.method==='context/compaction-retrying');
  assert.ok(retry);assert.match(retry.params.message,/重试/);
  assert.doesNotMatch(retry.params.message,/已完成|undefined/);
});

test('function-level timing includes summary usage and every execution round before notification',async t=>{
  const messages=[...Array.from({length:8},()=>({role:'assistant',content:'旧'.repeat(1200)})),{role:'user',content:'继续'}];
  const state=await run(t,[sse([{choices:[{delta:{content:'交接记忆'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}]),
    sse([{choices:[{delta:{reasoning_content:'推理',content:'完成'},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:5,total_tokens:35}}])],
    {messages,environment:{...glmEnvironment,MODEL_AGENT_MAIN_CONTEXT_WINDOW:'18000'}});
  assert.equal(state.result.status,'completed');
  assert.equal(state.result.timing.summaryRequests[0].tokenUsage.totalTokens,120);
  const round=state.result.timing.rounds[0];
  assert.equal(round.tokenUsage.totalTokens,35);
  assert.ok(Number.isFinite(round.firstDeltaMs));
  assert.equal(round.outputChars,2);assert.equal(round.reasoningChars,2);
  assert.equal(state.notifications.find(n=>n.method==='model/round-completed').params.tokenUsage.totalTokens,35);
});

test('cancelling a summary prevents execution and preserves the complete original chat', async t => {
  const controller = new AbortController(), saved = [];
  const messages = [...Array.from({ length: 12 }, () => ({ role: 'assistant', content: '历史文字'.repeat(450) })), { role: 'user', content: '最新请求' }];
  const state = await run(t, [init => new Promise((resolve, reject) => {
    assert.equal(JSON.parse(init.body).stream, true);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    setImmediate(() => controller.abort());
  })], { messages, signal: controller.signal,
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' },
    runtime: { saveDialogue: async (_, archive) => saved.push(archive) } });
  assert.equal(state.result.status, 'stopped');
  assert.deepEqual(saved.at(-1), messages);
  assert.equal(state.requests.length, 1); assert.equal(state.result.timing.tools.length, 0);
  assert.equal(state.result.timing.summaryRequests.length, 1);
  assert.ok(Number.isFinite(state.result.timing.summaryRequests[0].totalMs));
});

test('a gateway context-size rejection condenses history and retries without replaying saved writes', async t => {
  let mainRequests = 0, writes = 0;
  const state = await run(t, Array.from({ length: 20 }, () => init => {
    if (isSummary(JSON.parse(init.body))) return json({ content: '已保存第一项；继续，不重复保存。' });
    if (++mainRequests === 1) return json({ tool_calls: [call('write', {}, 'one')] }, 'tool_calls');
    if (mainRequests === 2) return new Response('context_length_exceeded: maximum context length', { status: 400 });
    return json({ content: '完成' });
  }), { messages: [...Array.from({ length: 10 }, () => ({ role: 'assistant', content: '历史内容'.repeat(100) })), { role: 'user', content: '当前要求' }],
    tools: [schema('write')], toolHandler: async () => { writes++; return { ok: true, saved: true }; } });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(writes, 1); assert.equal(mainRequests, 3);
  assert.ok(state.requests.at(-1).messages.some(m => m.content?.includes('历史上下文摘要')));
  assert.equal(state.requests.at(-1).messages.at(-1).tool_call_id, 'one');
});

test('nested prompt-too-long rejection recovers for HTTP and clean SSE without replaying successful writes',async t=>{
  for(const transport of ['http','sse']) await t.test(transport,async t=>{
    let mains=0,writes=0;
    const nested={error:{message:JSON.stringify({code:11115,msg:'prompt is too long: 1743408 tokens \\u003e 1048576 maximum'})}};
    const state=await run(t,Array.from({length:20},()=>init=>{
      if(isSummary(JSON.parse(init.body)))return json({content:'已保存文件，继续核对，不重放写入。'});
      if(++mains===1)return json({tool_calls:[call('write',{},'saved')]},'tool_calls');
      if(mains===2)return transport==='http'?new Response(JSON.stringify(nested),{status:400}):sse([nested]);
      return json({content:'完成'});
    }),{messages:[...Array.from({length:10},()=>({role:'assistant',content:'历史内容'.repeat(100)})),{role:'user',content:'继续当前任务'}],
      tools:[schema('write')],toolHandler:async()=>{writes++;return{ok:true};}});
    assert.equal(state.result.status,'completed',state.result.error?.message);
    assert.equal(mains,3);assert.equal(writes,1);
    assert.equal(state.result.timing.rounds[1].contextRejected,true);
    assert.equal(state.result.timing.rounds[1].errorCode,'MODEL_CONTEXT_REJECTED');
    assert.ok(state.requests.at(-1).messages.some(m=>m.tool_call_id==='saved'));
  });
});

test('an ordinary HTTP400 parameter error is not retried or mistaken for a capacity rejection',async t=>{
  const state=await run(t,[new Response(JSON.stringify({error:{message:'temperature is invalid'}}),{status:400})]);
  assert.equal(state.result.status,'failed');assert.equal(state.requests.length,1);
  assert.ok(!state.result.timing.rounds[0].contextRejected);
});

test('a large latest saved-file result automatically hands off and finishes without repeating the write or changing dialogue', async t => {
  const current = { role: 'user', content: '保存模块后核对接口v2，继续完成节点；已保存的文件不要重写。' };
  const messages = [current], original = JSON.stringify(messages), saved = [], summaryInputs = [];
  const fixture = path.join(root, 'context-handoff-saved-module.txt');
  const content = '保存成功：模块已使用接口v2\n' + '完整模块证据'.repeat(5000) + '\n最终验收线索：接口v2，下一步确认真实保存内容。';
  let mainRequests = 0, writes = 0, reads = 0;
  const state = await run(t, Array.from({ length: 200 }, () => init => {
    const body = JSON.parse(init.body);
    if (isSummary(body)) {
      const prefix='以下是按时间顺序排列的历史消息片段：\n';
      const input=body.messages.at(-1).content;
      assert.ok(input.includes(prefix));
      summaryInputs.push(input.slice(input.indexOf(prefix)+prefix.length));
      return json({ content: '保存成功：模块已使用接口v2；saved-module 写入完成，read-module 已核对；不要重复写入，继续验收。' });
    }
    if (++mainRequests === 1) return json({ tool_calls: [call('save_module', {}, 'saved-module'), call('read_file', {}, 'read-module')] }, 'tool_calls');
    assert.equal(mainRequests, 2, 'the completed write does not need another implementation model round');
    const calls = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
    const receipts = body.messages.filter(m => m.role === 'tool');
    assert.deepEqual(calls.map(c => c.id), ['saved-module', 'read-module']);
    assert.deepEqual(receipts.map(r => r.tool_call_id), ['saved-module', 'read-module']);
    assert.ok(body.messages.some(m => m.role === 'user' && m.content === current.content));
    assert.ok(JSON.stringify(body.messages).includes('接口v2'));
    return json({ content: '文件已保存并核对接口v2，节点完成。' });
  }), { messages, tools: [schema('save_module'), schema('read_file')],
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' },
    toolHandler: async name => {
      if (name === 'save_module') { writes++; await writeFile(fixture, content); return { ok: true, saved: fixture, interfaceVersion: 'v2' }; }
      reads++; return { ok: true, path: fixture, content: await readFile(fixture, 'utf8') };
    }, runtime: { saveDialogue: async (_, archive) => saved.push(archive) }
  });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(mainRequests, 2);
  assert.ok(summaryInputs.length > 0);
  assert.ok(summaryInputs.join('').includes('最终验收线索：接口v2，下一步确认真实保存内容。'), 'the large result tail reaches handoff');
  assert.equal(summaryInputs.join('').split('完整模块证据').length - 1, 5000, 'the full result is consumed across transport chunks');
  assert.equal(await readFile(fixture, 'utf8'), content);
  assert.equal(JSON.stringify(messages), original, 'caller dialogue remains untouched');
  assert.deepEqual(saved.at(-1), [...messages, { role: 'assistant', content: '文件已保存并核对接口v2，节点完成。' }]);
  assert.deepEqual(state.result.messages, saved.at(-1));
  assert.ok(!JSON.stringify(saved.at(-1)).includes('完整模块证据'), 'tool payloads are transient rather than new user dialogue');
  assert.ok(state.result.timing.compactions.some(event => event.phase === 'completed'));
});

test('an estimated oversized current request reaches the provider when no content can be condensed', async t => {
  const current = { role: 'user', content: '不可删除的当前输入'.repeat(1800) }, messages = [current];
  const state = await run(t, [json({ content: '提供方已接受，完成当前任务。' })], { messages,
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' }
  });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(state.requests.length, 1, 'local estimation cannot veto a request accepted by the actual provider');
  assert.equal(state.requests[0].messages.find(m => m.role === 'user').content, current.content);
  assert.equal(state.result.timing.summaryRequests?.length || 0, 0);
  assert.ok(state.notifications.some(n => n.params?.phase === 'capacity-warning'), 'local capacity pressure remains visible');
});

test('a provider context rejection cannot resend an unchanged irreducible request indefinitely', async t => {
  const current = { role: 'user', content: '不可删除的当前输入'.repeat(1800) }, messages = [current], saved = [];
  const state = await run(t, Array.from({ length: 5 }, () => new Response('context_length_exceeded: maximum context length', { status: 400 })), { messages,
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' },
    runtime: { saveDialogue: async (_, archive) => saved.push(archive) }
  });
  assert.equal(state.result.status, 'failed');
  assert.match(state.result.error.message, /上下文|context/i);
  assert.equal(state.requests.length, 1, 'one actual rejection is enough when no changed request can be produced');
  assert.equal(state.result.timing.summaryRequests?.length || 0, 0);
  assert.equal(state.result.timing.rounds.length, 1);
  assert.equal(state.result.timing.rounds[0].contextRejected, true);
  assert.deepEqual(saved.at(-1), messages, 'rejection keeps the complete latest dialogue available to continue');
});

test('a clean SSE context rejection hands off history and resumes without replaying a saved write',async t=>{
  let mainRequests=0,writes=0;
  const state=await run(t,Array.from({length:20},()=>init=>{
    if(isSummary(JSON.parse(init.body)))return json({content:'文件已成功保存；继续验收，不重复写入。'});
    if(++mainRequests===1)return json({tool_calls:[call('write',{},'sse-saved-write')]},'tool_calls');
    if(mainRequests===2)return sse([{error:{code:'context_length_exceeded',message:'context_length_exceeded: maximum context length'}}]);
    return json({content:'保存完成，验收通过。'});
  }),{messages:[...Array.from({length:10},()=>({role:'assistant',content:'历史内容'.repeat(100)})),{role:'user',content:'继续完成节点'}],
    tools:[schema('write')],toolHandler:async()=>{writes++;return {ok:true,saved:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(mainRequests,3);assert.equal(writes,1);
  assert.equal(state.result.timing.rounds[1].contextRejected,true);
  assert.equal(state.result.timing.rounds[1].failedStage,'model-stream');
  const main=state.requests.filter(body=>!isSummary(body));
  assert.notDeepEqual(main[1].messages,main[2].messages,'the rejected request is replaced before retry');
  assert.equal(main[2].messages.at(-1).tool_call_id,'sse-saved-write');
  assert.ok(main[2].messages.some(m=>m.content?.includes('历史上下文摘要')));
});

test('unchanged or expanding recovery summaries cannot create an unbounded provider rejection loop',async t=>{
  for(const summary of ['固定记忆：已保存，继续验收。','膨胀摘要'.repeat(20000)]){
    t.mock.restoreAll();
    const current={role:'user',content:'保存后继续核对，不重复写入。'};
    const messages=[...Array.from({length:10},()=>({role:'assistant',content:'已知历史'.repeat(100)})),current];
    const snapshot=JSON.stringify(messages),saved=[],rejected=[];
    let mainRequests=0,writes=0;
    const state=await run(t,Array.from({length:30},()=>init=>{
      const body=JSON.parse(init.body);
      if(isSummary(body))return json({content:summary});
      if(++mainRequests===1)return json({tool_calls:[call('write',{},'once-only')]},'tool_calls');
      rejected.push(JSON.stringify(body.messages));
      return new Response('context_length_exceeded: maximum context length',{status:400});
    }),{messages,tools:[schema('write')],toolHandler:async()=>{writes++;return {ok:true,saved:true};},
      runtime:{saveDialogue:async(_,archive)=>saved.push(archive)}
    });
    assert.equal(state.result.status,'failed');
    assert.equal(writes,1,'recovery never replays the successful write');
    assert.ok(mainRequests<=3,'after a failed recovery there is no further unchanged model request');
    assert.equal(new Set(rejected).size,rejected.length,'the same rejected projection is never sent twice');
    assert.equal(JSON.stringify(messages),snapshot);
    assert.deepEqual(saved.at(-1),messages);
    assert.match(state.result.error.message,/摘要|上下文/);
  }
});

test('ongoing tool history compacts between complete groups, while all writes execute once past forty rounds', async t => {
  let round = 0, writes = 0;
  const state = await run(t, Array.from({ length: 150 }, () => init => {
    const body = JSON.parse(init.body);
    if (isSummary(body)) return json({ content: '已经逐项保存；不重做先前写入，继续下一项。' });
    // This capacity test needs growing usage, not the generic fixture's fixed
    // three input tokens (which now correctly overrides the byte estimate).
    const input = estimateContextTokens(body.messages, body.tools);
    const message = ++round <= 50 ? { tool_calls: [call('write', { round }, `write-${round}`)] } : { content: '全部保存完成' };
    return new Response(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],
      usage:{prompt_tokens:input,completion_tokens:10,total_tokens:input+10}}),{headers:{'content-type':'application/json'}});
  }), { tools: [schema('write')], toolHandler: async (_, args) => { assert.equal(args.round, ++writes); return { ok: true, saved: writes, receipt: '完整返回'.repeat(60) }; },
    environment: { MODEL_AGENT_MAIN_BASE_URL: 'https://isolated.invalid', MODEL_AGENT_MAIN_API_KEY: 'test-only', MODEL_AGENT_MAIN_MODEL: 'test-model', MODEL_AGENT_MAIN_CONTEXT_WINDOW: '8192' } });
  assert.equal(state.result.status, 'completed', state.result.error?.message);
  assert.equal(writes, 50); assert.equal(round, 51);
  assert.ok(state.result.timing.compactions.length > 0);
  for (const body of state.requests.filter(b => b.stream)) {
    const calls = new Set();
    for (const m of body.messages) {
      for (const c of m.tool_calls || []) calls.add(c.id);
      if (m.role === 'tool') assert.ok(calls.has(m.tool_call_id), 'no orphan receipts after summary');
    }
  }
});

test('web research reads overlap but file downloads remain mutation barriers', async t => {
  const order=[];let active=0,peak=0;
  const calls=['web_search','fetch_url','read_document','download_file','fetch_url'];
  const state=await run(t,[json({tool_calls:calls.map((name,i)=>call(name,{},`web-${i}`))},'tool_calls'),json({content:'完成'})],{
    tools:[...new Set(calls)].map(schema),toolHandler:async name=>{
      order.push(`start:${name}`);active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,12));active--;order.push(`end:${name}`);return {ok:true};
    }
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(peak,3);
  assert.ok(order.indexOf('start:download_file')>order.indexOf('end:read_document'));
  assert.ok(order.lastIndexOf('start:fetch_url')>order.indexOf('end:download_file'));
  assert.equal(state.requests.length,2);
});

test('distinct non-overwriting downloads overlap and following reads wait for persistence',async t=>{
  const events=[];let active=0,peak=0;
  const state=await run(t,[json({tool_calls:[
    call('download_file',{url:'https://example.com/a',path:'papers/a.pdf'},'d1'),
    call('download_file',{url:'https://example.com/b',path:'papers/b.pdf'},'d2'),
    call('read_document',{path:'papers/a.pdf'},'r1')
  ]},'tool_calls'),json({content:'完成'})],{tools:[schema('download_file'),schema('read_document')],toolHandler:async(name,args)=>{
    events.push(`start:${args.path}`);peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,10));active--;events.push(`end:${args.path}`);return {ok:true};
  }});
  assert.equal(state.result.status,'completed',state.result.error?.message);assert.equal(peak,2);
  assert.ok(events.lastIndexOf('start:papers/a.pdf')>events.indexOf('end:papers/b.pdf'));assert.equal(state.requests.length,2);
});
test('tool pool concurrency can be configured above 100 without changing model requests',async t=>{
  let active=0,peak=0;
  const state=await run(t,[json({tool_calls:Array.from({length:120},(_,i)=>call('read_file',{path:String(i)},`read-${i}`))},'tool_calls'),json({content:'完成'})],{
    environment:{MODEL_AGENT_MAIN_BASE_URL:'https://isolated.invalid',MODEL_AGENT_MAIN_API_KEY:'test-only',MODEL_AGENT_MAIN_MODEL:'test-model',TASK_TREE_TOOL_CONCURRENCY:'120'},
    tools:[schema('read_file')],toolHandler:async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,10));active--;return {ok:true};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);assert.equal(peak,120);assert.equal(state.requests.length,2);
});
test('same-path aliases and explicit overwrites remain download ordering barriers',async t=>{
  let active=0,peak=0;
  const state=await run(t,[json({tool_calls:[call('download_file',{path:'papers/a.pdf'},'d1'),call('download_file',{path:'papers/../papers/a.pdf'},'d2'),call('download_file',{path:'papers/b.pdf',overwrite:true},'d3')]},'tool_calls'),json({content:'完成'})],{tools:[schema('download_file')],toolHandler:async()=>{
    peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return {ok:true};
  }});
  assert.equal(state.result.status,'completed',state.result.error?.message);assert.equal(peak,1);
});
test('symlinked download directories and ancestor destinations do not overlap',async t=>{
  const dir=await mkdtemp(path.join(root,'download-targets-'));await mkdir(path.join(dir,'real'));
  await symlink(path.join(dir,'real'),path.join(dir,'alias'),'dir');
  let active=0,peak=0;
  const state=await run(t,[json({tool_calls:[
    call('download_file',{path:path.join(dir,'real','a.txt')},'d1'),
    call('download_file',{path:path.join(dir,'alias','a.txt')},'d2'),
    call('download_file',{path:'new-parent'},'d3'),
    call('download_file',{path:'new-parent/child.txt'},'d4')
  ]},'tool_calls'),json({content:'完成'})],{tools:[schema('download_file')],toolHandler:async()=>{
    peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return {ok:true};
  }});
  assert.equal(state.result.status,'completed',state.result.error?.message);
  // d2 and d3 may overlap; the alias pair and ancestor pair may not.
  const spans=state.result.timing.tools;const overlaps=(a,b)=>Date.parse(a.startedAt)<Date.parse(b.endedAt)&&Date.parse(b.startedAt)<Date.parse(a.endedAt);
  assert.equal(overlaps(spans.find(s=>s.toolCallId==='d1'),spans.find(s=>s.toolCallId==='d2')),false);
  assert.equal(overlaps(spans.find(s=>s.toolCallId==='d3'),spans.find(s=>s.toolCallId==='d4')),false);assert.equal(peak,2);
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

test('length exhaustion and truncated SSE continue without claiming premature success', async t => {
  const truncated = await run(t, [json({ content: '尚未完成' }, 'length'),json({content:'现在完成'})]);
  assert.equal(truncated.result.status, 'completed',truncated.result.error?.message);
  assert.equal(truncated.result.output,'尚未完成现在完成');
  assert.equal(truncated.notifications.filter(n=>n.method==='item/completed').length,1);
  t.mock.restoreAll();
  const disconnected = await run(t, [sse([{ choices: [{ delta: { content: '半截' } }] }]),json({content:'后半截'})]);
  assert.equal(disconnected.result.status, 'completed',disconnected.result.error?.message);
  assert.equal(disconnected.result.output,'半截后半截');
});

test('continuation keeps every received paragraph in the durable answer and respects user stop',async t=>{
  const archive=[{role:'user',content:'原始目标'}];const saved=[];
  const state=await run(t,[json({content:'第一段'},'length'),json({content:'第二段'},'length'),json({content:'第三段'})],{
    dialogueContext:archive,runtime:{saveDialogue:async(_,messages)=>saved.push(messages)}
  });
  assert.equal(state.result.status,'completed');
  assert.deepEqual(saved.at(-1),[...archive,{role:'assistant',content:'第一段第二段第三段'}]);
  assert.deepEqual(state.result.messages,saved.at(-1));
  t.mock.restoreAll();
  const controller=new AbortController();
  const stopped=await run(t,[json({content:'已输出'},'length'),init=>new Promise((_,reject)=>{
    init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
    setImmediate(()=>controller.abort());
  })],{signal:controller.signal});
  assert.equal(stopped.result.status,'stopped');
  assert.equal(stopped.result.output,'已输出');
  assert.equal(stopped.requests.length,2);
});

test('incomplete tool arguments are not executed and completed writes are not replayed',async t=>{
  let writes=0;
  const state=await run(t,[json({tool_calls:[call('write')]},'tool_calls'),sse([{choices:[{delta:{tool_calls:[{index:0,id:'broken',function:{name:'write',arguments:'{"path":'}}]}}]}]),json({content:'已有保存结果，完成'})],{
    tools:[schema('write')],toolHandler:async()=>{writes++;return {ok:true,path:'saved.txt'};}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.equal(writes,1);
  assert.ok(state.requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('saved.txt')));
  assert.ok(!state.requests[2].messages.some(m=>m.tool_calls?.some(c=>c.id==='broken')));
});

test('successful dialogue save clears an earlier background error',async t=>{
  let saves=0;
  const state=await run(t,[json({tool_calls:[call('slow')]},'tool_calls'),json({content:'完成'})],{
    tools:[schema('slow')],toolHandler:async()=>{await new Promise(r=>setTimeout(r,650));return {ok:true};},
    runtime:{saveDialogue:async()=>{if(++saves===2)throw new Error('temporary disk error');}}
  });
  assert.ok(saves>=2);
  assert.equal(state.result.status,'completed',state.result.error?.message);
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

test('ephemeral review turns receive their task but never persist or return its prompt as dialogue',async t=>{
  let saves=0;
  const prompt='【独立合并检查】REVIEW_PROMPT_PRIVATE\n只核对候选产物';
  const state=await run(t,[json({content:'{"verdict":"pass","reason":"已核对"}'})],{
    prompt,messages:[{role:'user',content:prompt}],persistDialogue:false,
    runtime:{saveDialogue:async()=>{saves++;}}
  });
  assert.equal(state.result.status,'completed',state.result.error?.message);
  assert.ok(state.requests[0].messages.some(message=>message.role==='user'&&message.content===prompt));
  assert.equal(saves,0);
  assert.deepEqual(state.result.messages,[{role:'assistant',content:'{"verdict":"pass","reason":"已核对"}'}]);
  assert.ok(!state.notifications.some(message=>message.method==='execution/saving'));
});
