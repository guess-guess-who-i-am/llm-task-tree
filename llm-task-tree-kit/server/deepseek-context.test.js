import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekContext, estimateContextTokens } from './deepseek-context.js';

const history = () => Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}：` + '历史正文'.repeat(450) }));

function historyNearTokens(target) {
  const messages = [{ role: 'system', content: '保留固定规则' }];
  let index = 0;
  while (estimateContextTokens(messages) < target) {
    messages.push({ role: index % 2 ? 'assistant' : 'user', content: `历史片段${index}：` + '历史记录'.repeat(1000) });
    index++;
  }
  return messages;
}

test('270K worker window compacts history only above the 200K threshold', async () => {
  const defaults = createDeepSeekContext({ windowTokens: 270000 });
  assert.equal(defaults.measure([]).windowTokens, 270000);
  assert.equal(defaults.measure([]).compactionThresholdTokens, 200000);

  let belowCalls = 0;
  const below = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 200000,
    summarize: async () => { belowCalls++; return '摘要'; } });
  const belowSource = historyNearTokens(190000);
  assert.ok(estimateContextTokens(belowSource) < 200000);
  assert.equal(await below.prepare(belowSource), belowSource);
  assert.equal(belowCalls, 0);

  let aboveCalls = 0;
  const above = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 200000,
    summarize: async () => { aboveCalls++; return '保留目标、决定和最新进度。'; } });
  const aboveSource = historyNearTokens(205000);
  assert.ok(estimateContextTokens(aboveSource) > 200000);
  const compacted = await above.prepare(aboveSource);
  assert.ok(aboveCalls > 0);
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(aboveSource));
});

test('default worker context follows the IDE 270K window and 200K compaction threshold', async () => {
  let summaries = 0;
  const context = createDeepSeekContext({ summarize: async () => { summaries++; return '目标和当前进展'; } });
  const below = historyNearTokens(100000);
  assert.equal(await context.prepare(below), below, 'a 100K input must not inherit the old 60K effective ceiling');
  assert.equal(summaries, 0);
  await context.prepare(historyNearTokens(205000));
  assert.ok(summaries > 0, 'the configured 200K threshold still triggers compaction');
});

test('provider usage above the compaction threshold cannot bypass compression via accepted-pressure allowance', async () => {
  let summaries = 0;
  const source = historyNearTokens(205000);
  const context = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 200000,
    summarize: async () => { summaries++; return '保留有效工作记忆。'; } });
  context.observeUsage(source, [], { inputTokens: 267000 });
  const compacted = await context.prepare(source);
  assert.ok(summaries > 0);
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(source));
});

test('automatic compaction keeps retrying transient summary failures without waiting for input growth',async()=>{
  let calls=0;const events=[];
  const context=createDeepSeekContext({windowTokens:8192,onCompaction:e=>events.push(e),summarize:async()=>{
    if(++calls<=3)throw Object.assign(new Error('temporary gateway unavailable'),{requestExhausted:true});
    return '目标与更正已保留；已保存操作不重放。';
  }});
  const source=[...history(),{role:'user',content:'继续完成'}],original=JSON.stringify(source);
  const result=await context.prepare(source,{initial:true});
  assert.ok(estimateContextTokens(result)<estimateContextTokens(source));
  assert.ok(calls>3);assert.ok(!events.some(e=>e.phase==='deferred'));
  assert.equal(JSON.stringify(source),original);
});

test('mandatory compaction ends with a resumable error after repeated summary API failures',async()=>{
  let calls=0;const events=[];
  const context=createDeepSeekContext({windowTokens:8192,summaryRetryLimit:2,onCompaction:e=>events.push(e),summarize:async()=>{
    calls++;throw Object.assign(new Error('summary gateway unavailable'),{requestExhausted:true});
  }});
  const source=[...history(),{role:'user',content:'继续验收'}],snapshot=JSON.stringify(source);
  await assert.rejects(context.prepare(source,{initial:true,force:true}),{code:'SUMMARY_RETRY_EXHAUSTED'});
  assert.equal(calls,3);
  assert.equal(JSON.stringify(source),snapshot,'failed compression never mutates or discards the raw dialogue');
  assert.equal(context.cache,null,'partial summary pieces are not committed');
  assert.equal(events.filter(event=>event.phase==='retrying').length,2);
});

test('a rejected summary input shrinks transport pieces without losing Unicode or source tails',async()=>{
  const accepted=[],sizes=[],events=[];
  const context=createDeepSeekContext({windowTokens:64000,onCompaction:e=>events.push(e),summarize:async(batch,previous)=>{
    sizes.push(Buffer.byteLength(batch));
    if(Buffer.byteLength(batch)>1700)throw Object.assign(new Error('prompt is too long: 9000 tokens > 8192 maximum'),{code:'MODEL_CONTEXT_REJECTED'});
    accepted.push(batch);return '已保存事实；继续验收，不重放。';
  }});
  const source=[...Array.from({length:3},(_,i)=>({role:'assistant',content:`起点${i}：`+'中文🌱关键事实。'.repeat(250)+`末尾${i}：接口v2。`})),{role:'user',content:'继续'}];
  const original=JSON.stringify(source),result=await context.prepare(source,{initial:true,handoff:true});
  assert.ok(estimateContextTokens(result)<estimateContextTokens(source));
  assert.equal(accepted.join(''),source.slice(0,-1).map(m=>JSON.stringify(m)).join('\n'),'all original source bytes are consumed in order');
  assert.ok(sizes[0]>1700&&sizes.some(n=>n<=1700));
  assert.ok(events.some(e=>e.phase==='retrying'&&e.reason==='summary-capacity'));
  assert.equal(JSON.stringify(source),original);
});

test('an oversized rolling memory is condensed before retrying the failed delta',async()=>{
  let calls=0;const repairs=[];
  const memory='有效旧记忆'.repeat(500);
  const context=createDeepSeekContext({windowTokens:64000,summarize:async(batch,previous,options)=>{
    calls++;
    if(calls===1)return memory;
    if(options.purpose==='summary-repair'){repairs.push(batch);return '有效旧记忆：接口v2，写入已保存。';}
    if(Buffer.byteLength(previous)>1000)throw Object.assign(new Error('context_length_exceeded'),{code:'MODEL_CONTEXT_REJECTED'});
    return '旧记忆和新增尾部均保留；继续验收。';
  }});
  const source=[...history(),...history(),{role:'user',content:'继续验收'}];
  const result=await context.prepare(source,{initial:true,handoff:true});
  assert.ok(estimateContextTokens(result)<estimateContextTokens(source));
  assert.equal(repairs[0],memory,'the exact prior memory is refined, not discarded');
});

test('improving oversized drafts continue semantic repair rather than stopping at two attempts',async()=>{
  let calls=0;const seen=[];
  const drafts=[1000,950,900].map(n=>'超长有效草稿'.repeat(n)+'末尾：已保存，不能重放。');
  const context=createDeepSeekContext({windowTokens:64000,summarize:async(batch,previous,options)=>{
    seen.push({batch,previous,options});return drafts[calls++]||'接口v2；已保存，不重放；继续验收。';
  }});
  const source=[{role:'assistant',content:'完整原历史。'.repeat(400)},{role:'user',content:'继续'}];
  const result=await context.prepare(source,{initial:true,handoff:true});
  assert.ok(estimateContextTokens(result)<estimateContextTokens(source));
  assert.equal(calls,4);assert.ok(seen.slice(1).every((s,i)=>s.options.purpose==='summary-repair'&&s.batch===drafts[i]));
});

test('consecutive over-budget summaries progressively tighten the semantic target while preserving complete drafts',async()=>{
  const seen=[];
  const tail='末尾约束：接口v2；已保存操作不能重放；保留未验证状态。';
  const drafts=[13661,13307,12546].map(bytes=>'正文'.repeat(Math.ceil(bytes/6))+tail);
  const context=createDeepSeekContext({windowTokens:64000,summarize:async(batch,previous,options)=>{
    seen.push({batch,previous,options});
    return drafts[seen.length-1]||'接口v2；已保存操作不能重放；产物仍未验证，继续最终验收。';
  }});
  const source=[{role:'assistant',content:'原始历史材料。'.repeat(400)},{role:'user',content:'继续验收'}];
  const snapshot=JSON.stringify(source),result=await context.prepare(source,{initial:true,handoff:true});
  assert.equal(seen.length,4);
  assert.deepEqual(seen.map(s=>s.options.maxOutputBytes),[12000,8400,5880,4116],
    'a repeated oversized draft must not receive the same ineffective 8400-byte target');
  for(let i=1;i<seen.length;i++){
    assert.equal(seen[i].batch,drafts[i-1],'each repair consumes the complete latest draft, including tail constraints');
    assert.equal(seen[i].previous,'');
    assert.equal(seen[i].options.purpose,'summary-repair');
  }
  assert.ok(result.some(m=>typeof m.content==='string'&&m.content.includes('产物仍未验证')));
  assert.equal(JSON.stringify(source),snapshot,'raw history is never modified');
});

test('transient summary retries retain the semantic target until actual oversized output supplies feedback',async()=>{
  const seen=[];
  const draft='超长有效草稿。'.repeat(1000)+'末尾：已保存，不重放。';
  const context=createDeepSeekContext({windowTokens:64000,summarize:async(batch,previous,options)=>{
    seen.push({batch,previous,options});
    if(seen.length===2)throw Object.assign(new Error('temporary gateway unavailable'),{requestExhausted:true});
    if(seen.length<=3)return seen.length===1?draft:draft.replace('超长有效草稿。','精炼草稿。');
    return '已保存，不重放；继续验收。';
  }});
  await context.prepare([{role:'assistant',content:'原始历史。'.repeat(400)},{role:'user',content:'继续'}],{initial:true,handoff:true});
  assert.deepEqual(seen.map(s=>s.options.maxOutputBytes),[12000,8400,8400,5880]);
  assert.equal(seen[1].batch,seen[2].batch,'a transport retry must not lose or replace the failed draft');
});

test('mandatory compaction retains successful pieces across exhausted transient summary requests',async()=>{
  const seen=[];let calls=0;
  const context=createDeepSeekContext({windowTokens:8192,summarize:async(batch,previous)=>{
    seen.push({batch,previous});calls++;
    if(calls===2||calls===3)throw Object.assign(new Error('summary gateway unavailable'),{requestExhausted:true});
    return '有效滚动记忆：已保存，不重放；继续验收。';
  }});
  const source=[...history(),{role:'user',content:'继续验收'}];
  const original=JSON.stringify(source);
  const result=await context.prepare(source,{initial:true,force:true});
  assert.ok(result.length<source.length);
  assert.equal(seen[1].batch,seen[2].batch);
  assert.equal(seen[1].batch,seen[3].batch);
  assert.equal(seen[1].previous,'有效滚动记忆：已保存，不重放；继续验收。');
  assert.notEqual(seen[0].batch,seen[1].batch,'successful piece is not summarized again');
  assert.equal(JSON.stringify(source),original);
});

test('user stop interrupts mandatory summary recovery backoff without committing partial memory',async()=>{
  const controller=new AbortController();let calls=0;
  const context=createDeepSeekContext({windowTokens:8192,signal:controller.signal,
    onCompaction:event=>{if(event.phase==='retrying')controller.abort();},
    summarize:async()=>{calls++;throw Object.assign(new Error('temporary gateway failure'),{requestExhausted:true});}});
  await assert.rejects(context.prepare([...history(),{role:'user',content:'继续'}],{force:true}),{name:'AbortError'});
  assert.equal(calls,1);assert.equal(context.cache,null);
});

test('oversize Chinese summaries are re-condensed from the draft with an explicit byte budget, not regenerated from raw history',async()=>{
  const seen=[];
  const draft='中文摘要'.repeat(5000)+'尾部验收：接口v2，不重放已保存操作。';
  const context=createDeepSeekContext({windowTokens:64000,summarize:async(batch,previous,options)=>{
    seen.push({batch,previous,options});
    return seen.length===1?draft:'保留用户目标；接口v2；操作已保存，不重放；继续最终验收。';
  }});
  const source=[...Array.from({length:8},()=>({role:'assistant',content:'原历史材料'.repeat(200)})),{role:'user',content:'继续完成'}];
  const original=JSON.stringify(source);
  const result=await context.prepare(source,{initial:true,force:true});
  assert.ok(result.length<source.length);
  assert.equal(seen.length,2);
  assert.equal(seen[1].batch,draft,'repair operates on the complete draft, including tail constraints');
  assert.equal(seen[1].previous,'','draft already incorporates previous memory');
  assert.equal(seen[1].options.purpose,'summary-repair');
  assert.equal(seen[0].options.maxOutputBytes,12000,'budget uses the same byte unit as validation');
  assert.ok(seen[1].options.maxOutputBytes<seen[0].options.maxOutputBytes,'repair asks for headroom');
  assert.equal(JSON.stringify(source),original);
});

test('accepted input usage prevents false handoffs while new tool data is still counted conservatively', async () => {
  let summaries = 0;
  const context = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 60000,
    summarize: async () => { summaries++; return '已读事实'; } });
  const base = [{ role: 'system', content: '全局规则'.repeat(6500) }, { role: 'user', content: '继续执行' }];
  assert.equal(await context.prepare(base), base);
  context.observeUsage(base, [], { inputTokens: 22815 });
  const append = content => [{ role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read', content }];
  const next = [...base, ...append('文件'.repeat(8000))];
  assert.ok(estimateContextTokens(next) > 60000, 'reproduces the byte estimate that triggered the real false handoff');
  assert.equal(await context.prepare(next), next);
  context.observeUsage(next, [], { inputTokens: 0 }); // Some gateway rounds omit usage.
  assert.deepEqual(await context.prepare([...next]), next);
  assert.equal(summaries, 0);
  await context.prepare([...next, ...append('新'.repeat(240000))]);
  assert.ok(summaries > 0, 'genuinely large new data must still trigger compaction');
});

test('usage accounting cannot transfer across models, tools or edited prefix content', async () => {
  let key = 'model-a', summaries = 0;
  const context = createDeepSeekContext({ windowTokens: 64000, compactionThresholdTokens: 60000,
    getAccountingKey: () => key, summarize: async () => { summaries++; return '已读事实'; } });
  const base = [{ role: 'system', content: '规则'.repeat(10000) }, { role: 'user', content: '任务' }];
  context.observeUsage(base, [], { inputTokens: 1000 });
  const next = [...base, ...history()];
  assert.deepEqual(await context.prepare(next), next);
  assert.equal(summaries, 0);
  key = 'model-b';
  await context.prepare(next);
  assert.ok(summaries > 0, 'a new model must use the uncalibrated conservative estimate');
  key = 'model-a'; summaries = 0;
  await context.prepare([{ ...base[0], content: base[0].content + 'edited' }, ...next.slice(1)]);
  assert.ok(summaries > 0, 'changed rules cannot inherit the old discount');
});

test('changed tools and real capacity rejection invalidate accepted usage credit', async () => {
  for (const variant of ['tools', 'rejected']) {
    const tools = [];
    let summaries = 0;
    const context = createDeepSeekContext({ windowTokens: 64000, compactionThresholdTokens: 60000, tools,
      summarize: async () => { summaries++; return '有效历史事实'; } });
    const base = [{role:'system',content:'规则'.repeat(10000)},{role:'user',content:'任务'}];
    context.observeUsage(base, tools, {inputTokens:1000});
    const source = [...base, ...history()];
    if (variant === 'tools') tools.push({type:'function',function:{name:'new_tool',parameters:{type:'object'}}});
    await context.prepare(source, variant === 'rejected' ? {force:true} : {});
    assert.ok(summaries > 0, `${variant} must not use the earlier accepted prefix to skip recovery`);
  }
});

test('accepted request accounting survives explicitly identified temporary strategy tails and tool subsets', async () => {
  const read = { type: 'function', function: { name: 'read', description: '读规则'.repeat(400), parameters: { type: 'object' } } };
  const delegate = { type: 'function', function: { name: 'delegate', description: '分工接口'.repeat(600), parameters: { type: 'object' } } };
  const tools = [read, delegate];
  const base = [{ role: 'system', content: '全局方法'.repeat(16000) }, { role: 'user', content: '实现并验收' }];
  const temporary = { role: 'system', content: '本次响应只选择调度工具。' };
  let summaries = 0;
  const context = createDeepSeekContext({ tools, summarize: async () => { summaries++; return '已读事实'; } });
  context.observeUsage([...base, temporary], [delegate], { inputTokens: 30000 }, { conversationMessages: base });
  const missingToolCost = estimateContextTokens([], [read]) - estimateContextTokens([], []);
  const measured = context.measure(base);
  assert.equal(measured.estimatedInputTokens, 30000 + missingToolCost,
    'temporary instruction tokens stay counted; unseen tool definitions pay their full estimate');
  assert.equal(measured.basis, 'accepted-usage-plus-estimated-delta');
  assert.equal(await context.prepare(base), base);
  const next = [...base, { role: 'assistant', content: '开始实现' }, { role: 'user', content: '新增模块'.repeat(2000) }];
  assert.equal(context.measure(next).estimatedInputTokens,
    30000 + missingToolCost + estimateContextTokens(next, tools) - estimateContextTokens(base, tools));
  assert.equal(await context.prepare(next), next);
  assert.equal(summaries, 0);
  assert.equal(context.measure([{ ...base[0], content: base[0].content + '新规则' }, ...base.slice(1)]).basis, 'local-estimate');
});

test('an invalid declared persistent prefix cannot acquire accepted usage credit', () => {
  const base = [{ role: 'system', content: '全局规则'.repeat(12000) }, { role: 'user', content: '执行任务' }];
  const context = createDeepSeekContext();
  context.observeUsage(base, [], { inputTokens: 1000 }, { conversationMessages: [{ ...base[0], content: '不同规则' }] });
  assert.equal(context.measure(base).basis, 'local-estimate');
});

test('accepted over-configured input gets bounded growth room instead of a handoff on every tool turn', async () => {
  let summaries = 0;
  const context = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 200000,
    summarize: async () => { summaries++; return '已保存接口v2；继续验证，不重放。'; } });
  const rules = { role: 'system', content: '全局固定规则'.repeat(20000) };
  const current = { role: 'user', content: '完成真实任务' };
  let view = [rules, current];
  for (let i = 0; i < 20; i++) {
    context.observeUsage(view, [], { inputTokens: 101000 + i * 30 });
    view = [...view, { role: 'assistant', tool_calls: [{ id: `r${i}`, function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `r${i}`, content: '已读取事实'.repeat(10) }];
    assert.equal(await context.prepare(view), view, 'small growth must not resummarize a provider-accepted fixed floor');
  }
  assert.equal(summaries, 0);
  view = [...view, { role: 'assistant', content: '新增待交接事实'.repeat(30000) }, { role: 'assistant', content: '继续保存' }];
  const compacted = await context.prepare(view);
  assert.ok(summaries > 0, 'successive usage observations cannot keep moving the growth threshold');
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(view));
  const count = summaries;
  const next = [...compacted, { role: 'assistant', content: '少量新事实' }];
  assert.equal(await context.prepare(next), next, 'summary replacement must not erase the fixed-floor growth allowance');
  assert.equal(summaries, count);
  await context.prepare(next, { force: true });
  assert.ok(summaries > count, 'a real capacity rejection always overrides provider-accepted allowance');
});

test('accepted over-configured growth allowance cannot cross rule, request, tool or model changes', async () => {
  for (const variant of ['rules', 'request', 'tools', 'model']) {
    let key = 'a', calls = 0;
    const tools = [];
    const current = { role: 'user', content: '当前任务' };
    const context = createDeepSeekContext({ windowTokens: 270000, compactionThresholdTokens: 200000,
      tools, protectedMessages: [current], getAccountingKey: () => key,
      summarize: async () => { calls++; return '接口v2；继续保存并验证。'; } });
    const source = [{ role: 'system', content: '全局规则'.repeat(30000) }, current, ...history()];
    context.observeUsage(source, tools, { inputTokens: 101000 });
    assert.equal(await context.prepare(source), source);
    if (variant === 'rules') source[0] = { ...source[0], content: source[0].content + '修改规则' };
    if (variant === 'request') current.content += '修改需求';
    if (variant === 'tools') tools.push({ type: 'function', function: { name: 'new', parameters: { type: 'object' } } });
    if (variant === 'model') key = 'b';
    await context.prepare(source);
    assert.ok(calls > 0, `${variant} must invalidate the old growth allowance`);
  }
});

test('branch history is compacted even when immutable rules and current instructions exceed the local soft target', async () => {
  const rules = { role: 'system', content: '完整全局方法'.repeat(5000) };
  const current = { role: 'user', content: '完成分支任务，保持接口v2和验收要求。' };
  const latest = { role: 'assistant', content: '已完成读取，下一步按接口v2保存。' };
  const source = [rules, current, ...history(), latest], snapshot = JSON.stringify(source), batches = [], events = [];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current],
    onCompaction: e => events.push(e), summarize: async batch => { batches.push(batch); return '接口v2；已读取；继续保存后测试，不重放已完成调用。'; } });
  const view = await context.prepare(source);
  assert.ok(batches.length > 0, 'an over-target fixed floor must not disable useful history compaction');
  assert.ok(estimateContextTokens(view) < estimateContextTokens(source));
  assert.ok(estimateContextTokens(view) > 8192 - 4000, 'the estimate must not misrepresent the irreducible floor');
  for (const message of [rules, current, latest]) assert.ok(view.includes(message));
  assert.ok(context.cache?.summary.includes('接口v2'));
  assert.equal(JSON.stringify(source), snapshot);
  const count = batches.length;
  assert.equal(await context.prepare(view), view);
  assert.equal(batches.length, count, 'unchanged fixed pressure must not immediately summarize the same memory again');
  assert.ok(events.some(e => e.phase === 'completed'));
});

test('new accepted usage cannot make an earlier fixed-floor deferral hide growing branch history', async () => {
  const rules = { role: 'system', content: '完整全局方法'.repeat(5000) };
  const current = { role: 'user', content: '按接口v2完成任务' };
  let calls = 0;
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current],
    summarize: async () => { calls++; return '接口v2；保留已保存事实，继续测试。'; } });
  const view = await context.prepare([rules, current, ...history(), { role: 'assistant', content: '完成读取' }]);
  const earlierCalls = calls;
  assert.ok(earlierCalls > 0);
  context.observeUsage(view, [], { inputTokens: 1000 }, { conversationMessages: view });
  const next = [...view, ...Array.from({ length: 2 }, () => ({ role: 'assistant', content: '新增事实'.repeat(400) }))];
  assert.ok(context.measure(next).estimatedInputTokens > 8192 - 4000);
  const compacted = await context.prepare(next);
  assert.ok(calls > earlierCalls, 'defer compares raw pressure to raw pressure, never raw tokens to accepted usage');
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(next));
});

test('summary retries the failed piece once with old memory intact and commits only success',async()=>{
  let calls=0;const seen=[];
  const source=[...history(),{role:'user',content:'最新任务'}];
  const original=JSON.stringify(source);
  const context=createDeepSeekContext({windowTokens:8192,summarize:async(batch,previous,options)=>{
    seen.push({batch,previous,options});
    if(++calls===1)return '';
    return '有效记忆，保留验收与当前目标';
  }});
  const view=await context.prepare(source,{initial:true});
  assert.ok(view.length<source.length);
  assert.deepEqual(seen[1].batch,seen[0].batch);
  assert.equal(seen[1].previous,seen[0].previous);
  assert.match(seen[1].options.retryReason,/摘要为空/);
  assert.equal(JSON.stringify(source),original);
  assert.ok(context.cache);
});

test('short context is unchanged and makes no summary request', async () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }];
  const context = createDeepSeekContext({ summarize: () => { throw new Error('unexpected'); } });
  assert.deepEqual(await context.prepare(messages), messages);
});

test('malformed persisted coverage cannot remove any raw dialogue or be silently reused', async () => {
  const messages=[...history(),{role:'user',content:'最新任务'}];
  const first=createDeepSeekContext({windowTokens:8192,summarize:async()=>'有效记忆'});
  await first.prepare(messages,{initial:true});
  for(const coveredIndexes of [[-1],[first.cache.sourceCount],['0'],[0,0],[], '0']){
    const context=createDeepSeekContext({windowTokens:64000,cache:{...first.cache,coveredIndexes},summarize:()=>{throw new Error('不应需要摘要');}});
    assert.deepEqual(await context.prepare(messages,{initial:true}),messages);
    assert.equal(context.cache,null);
  }
});

test('ordinary turns inside capacity never generate a handoff, including above the old 70% trigger', async () => {
  const messages = softHistory(); messages[0].content += '旧'.repeat(80);
  let calls = 0;
  const context = createDeepSeekContext({ windowTokens: 14000, summarize: async () => { calls++; return '摘要'; } });
  assert.equal(await context.prepare(messages, { initial: true }), messages);
  const next = [...messages];
  assert.equal(await context.prepare(next), next);
  assert.equal(calls, 0);
});

test('successive handoffs advance durable coverage and pass only the old memory plus new delta', async () => {
  const archive = [...history(), { role: 'user', content: '当前问题' }];
  const calls = [];
  const context = createDeepSeekContext({ windowTokens: 8192, getArchive: () => archive,
    summarize: async (batch, previous) => { calls.push({ batch, previous }); return '第一代记忆'; } });
  let view = await context.prepare(archive, { initial: true });
  const firstCount = context.cache.sourceCount;
  const firstSummary = context.cache.summary;
  const tail = Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `增量${i}：` + '新进展'.repeat(700) }));
  archive.push(...tail, { role: 'user', content: '最新更正：改用GLM，不再用旧模型' });
  calls.length = 0;
  view = await context.prepare([...view, ...tail, archive.at(-1)]);
  assert.ok(context.cache.sourceCount > firstCount);
  assert.equal(context.cache.generation, 2);
  assert.equal(calls[0].previous, firstSummary);
  const delta = calls.map(c => c.batch).join('');
  for (const m of archive.slice(0, firstCount)) assert.ok(!delta.includes(m.content));
  assert.ok(!delta.includes('【历史上下文摘要】'));
  assert.ok(view.includes(archive.at(-1)));
  const cache = JSON.parse(JSON.stringify(context.cache));
  const resumed = createDeepSeekContext({ windowTokens: 8192, cache, getArchive: () => archive,
    summarize: () => { throw new Error('restart must reuse latest memory'); } });
  const restored = await resumed.prepare(archive, { initial: true });
  for (const index of cache.coveredIndexes) assert.ok(!restored.includes(archive[index]));
});

test('mid-turn handoff persists a dialogue boundary but never stores raw tool payloads', async () => {
  const archive = [...history(), { role: 'user', content: '继续任务' }];
  const context = createDeepSeekContext({ windowTokens: 8192, getArchive: () => archive, summarize: async () => '记忆更新：操作报告成功，仍需核对文件' });
  const tool = { role: 'tool', tool_call_id: 'x', content: 'RAW_TOOL_SECRETLESS_PAYLOAD'.repeat(800) };
  const view = await context.prepare([...archive.slice(0, 8), { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }, tool,
    ...archive.slice(8)], { force: true });
  assert.ok(context.cache.sourceCount > 0);
  assert.ok(!JSON.stringify(context.cache).includes('RAW_TOOL_SECRETLESS_PAYLOAD'));
  assert.ok(view.at(-1).content === '继续任务');
});

test('a protected earlier user request remains raw after restart while later covered turns stay omitted', async () => {
  const request = { role: 'user', content: '原始任务不能被吞掉' };
  const archive = [request, ...history(), { role: 'user', content: '继续' }];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [request], getArchive: () => archive,
    summarize: async () => '进度记忆' });
  await context.prepare(archive, { initial: true });
  assert.ok(context.cache.sourceCount > 1);
  assert.ok(!context.cache.coveredIndexes.includes(0));
  const resumed = createDeepSeekContext({ windowTokens: 8192, cache: context.cache, getArchive: () => archive,
    summarize: () => { throw new Error('unnecessary'); } });
  const view = await resumed.prepare(archive, { initial: true });
  assert.ok(view.includes(request));
  for (const index of context.cache.coveredIndexes) assert.ok(!view.includes(archive[index]));
});

test('an attachment-altered model projection cannot partially apply an archive checkpoint', async () => {
  const archive = [...history(), { role: 'user', content: '最新' }];
  const first = createDeepSeekContext({ windowTokens: 8192, getArchive: () => archive, summarize: async () => '旧记忆' });
  await first.prepare(archive, { initial: true });
  const changed = archive.map((m, i) => i === 0 ? { ...m, content: m.content + '\n附件正文' } : m);
  const second = createDeepSeekContext({ windowTokens: 64000, cache: first.cache, getArchive: () => archive,
    summarize: () => { throw new Error('not needed'); } });
  const view = await second.prepare(changed, { initial: true });
  assert.deepEqual(view, changed);
  assert.equal(second.cache, null);
});

const softHistory = () => [...Array.from({ length: 8 }, () => ({ role: 'assistant', content: '旧'.repeat(800) })), { role: 'user', content: '继续工作' }];

test('a failed optional summary only defers stable pressure, not a later large tool result',async()=>{
  const messages=softHistory();let requests=0,healthy=false;
  const context=createDeepSeekContext({windowTokens:14000,summarize:async()=>{
    requests++;
    if(!healthy)throw Object.assign(new Error('MODEL_HEADERS_TIMEOUT'),{code:'MODEL_HEADERS_TIMEOUT'});
    return '已读取资料；文件保持已保存状态，继续当前任务。';
  }});
  assert.equal(await context.prepare(messages,{handoff:true}),messages);
  assert.equal(requests,1);
  assert.equal(await context.prepare([...messages,{role:'assistant',content:'继续'}]).then(v=>v.length),messages.length+1);
  assert.equal(requests,1,'stable input does not trigger a summary loop');
  healthy=true;
  const assistant={role:'assistant',content:null,tool_calls:[{id:'large',function:{name:'read_file',arguments:'{}'}}]};
  const receipt={role:'tool',tool_call_id:'large',content:'新增大结果'.repeat(4500)};
  const expanded=[...messages,assistant,receipt], snapshot=JSON.stringify(expanded);
  const view=await context.prepare(expanded);
  assert.ok(requests>1,'new material pressure must re-enable recovery');
  assert.ok(estimateContextTokens(view)<estimateContextTokens(expanded));
  assert.ok(view.some(m=>m.tool_call_id==='large'));
  assert.equal(JSON.stringify(expanded),snapshot,'archive remains untouched');
});

test('optional summary failure preserves exact context and defers further soft attempts until hard pressure', async () => {
  const messages = softHistory(), events = [];
  let requests = 0;
  const context = createDeepSeekContext({ windowTokens: 14000, onCompaction: event => events.push(event), summarize: async () => { requests++; throw Object.assign(new Error('MODEL_HEADERS_TIMEOUT'),{code:'MODEL_HEADERS_TIMEOUT'}); } });
  // Use a real soft-pressure window: threshold 9800, hard budget 10000.
  messages[0].content += '旧'.repeat(80);
  assert.ok(estimateContextTokens(messages) > 9800 && estimateContextTokens(messages) <= 10000);
  const snapshot = JSON.stringify(messages);
  assert.equal(await context.prepare(messages, { initial: true, handoff: true }), messages);
  const second = [...messages];
  assert.equal(await context.prepare(second), second);
  assert.equal(JSON.stringify(messages), snapshot);
  assert.equal(requests, 1);
  assert.equal(context.cache, null);
  assert.equal(events.at(-1).phase, 'deferred');
  const hard = [...messages, { role: 'assistant', content: '新增'.repeat(500) }];
  await assert.rejects(context.prepare(hard, { force: true }), /上下文摘要.*MODEL_HEADERS_TIMEOUT/);
  assert.equal(requests, 2);
  assert.equal(events.at(-1).phase, 'failed');
});

test('empty summaries remain cancellable without committing partial cache', async () => {
  const messages = softHistory(); messages[0].content += '旧'.repeat(80);
  for (const summary of ['']) {
    const controller=new AbortController();let calls=0;
    const context = createDeepSeekContext({ windowTokens: 14000,signal:controller.signal,summarize: async () => {
      if(++calls===4)controller.abort();return summary;
    } });
    await assert.rejects(context.prepare(messages, { handoff: true }),{name:'AbortError'});
    assert.equal(calls,4,'no two-attempt ceiling');
    assert.equal(context.cache, null);
  }
  const controller = new AbortController();
  const context = createDeepSeekContext({ windowTokens: 14000, signal: controller.signal, summarize: async () => { controller.abort(); controller.signal.throwIfAborted(); } });
  await assert.rejects(context.prepare(messages, { handoff: true }), { name: 'AbortError' });
});

test('identical oversized summary drafts cannot trap a worker in an infinite repair loop', async () => {
  const source = softHistory(), original = JSON.stringify(source);
  let calls = 0;
  const controller = new AbortController();
  const context = createDeepSeekContext({windowTokens:14000, signal:controller.signal, summarize:async()=>{
    // A bounded harness reproduces the formerly unbounded production loop.
    if (++calls === 6) controller.abort();
    return '无变化的过长摘要'.repeat(5000);
  }});
  await assert.rejects(context.prepare(source,{force:true}),{code:'CONTEXT_SUMMARY_NO_PROGRESS'});
  assert.equal(calls,2);
  assert.equal(context.cache,null);
  assert.equal(JSON.stringify(source),original);
});

test('summary capacity rejection cannot retry an indivisible fragment forever',async()=>{
  let calls=0;const source=[{role:'assistant',content:'短事实'},{role:'user',content:'继续'}];
  const context=createDeepSeekContext({windowTokens:8192,summarize:async()=>{
    calls++;throw Object.assign(new Error('context_length_exceeded'),{code:'MODEL_CONTEXT_REJECTED'});
  }});
  await assert.rejects(context.prepare(source,{force:true}),/最小片段/);
  assert.ok(calls<12);assert.equal(context.cache,null);
});

test('million-scale history has no total-length ceiling and every transport fragment is consumed',async()=>{
  const source=[{role:'assistant',content:'原始事实🌱'.repeat(200000)+'最后约束：MILLION-73。'},{role:'user',content:'继续验收'}];
  const expected=JSON.stringify(source[0]);let accepted='',calls=0,rejected=0;
  const context=createDeepSeekContext({windowTokens:64000,summarize:async batch=>{
    calls++;
    if(calls===1){rejected++;throw Object.assign(new Error('context_length_exceeded'),{code:'MODEL_CONTEXT_REJECTED'});}
    accepted+=batch;return '原始事实保留；最后约束MILLION-73；继续验收。';
  }});
  assert.ok(estimateContextTokens(source)>1000000);
  const result=await context.prepare(source,{initial:true});
  assert.equal(accepted,expected,'no source segment is dropped or reordered after capacity recovery');
  assert.ok(rejected===1&&calls>10);assert.ok(estimateContextTokens(result)<1000);
});

test('summary preserves current request, instructions and complete latest tool group; never mutates history', async () => {
  const current = { role: 'user', content: '最新要求：不要删节点，改用中文' };
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] };
  const tools = ['a', 'b'].map(id => ({ role: 'tool', tool_call_id: id, content: `已保存${id}` }));
  const messages = [{ role: 'system', content: '全局规则' }, ...history(), current, assistant, ...tools, { role: 'system', content: '本轮规则' }];
  const original = JSON.stringify(messages), batches = [];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current], summarize: async (batch, previous) => { batches.push(batch); return `${previous ? '继承先前状态；' : ''}目标：展开子树；已完成：读树；待办：保存；旧用户要求服从最新原话。`; } });
  const compacted = await context.prepare(messages, { initial: true });
  assert.ok(batches.length > 0);
  for (const message of [messages[0], current, assistant, ...tools, messages.at(-1)]) assert.ok(compacted.includes(message));
  assert.ok(compacted.some(m => m.content?.includes('历史上下文摘要')));
  assert.equal(JSON.stringify(messages), original);
  assert.ok(estimateContextTokens(compacted) < estimateContextTokens(messages));
  assert.ok(context.cache.sourceCount > 0);
});

test('large messages are fully consumed across chunks, including their final characters', async () => {
  const huge = '开头' + '甲乙丙🙂'.repeat(12000) + '最后的约束';
  const messages = [{ role: 'user', content: huge }, ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: '短消息' })), { role: 'user', content: '当前问题' }];
  const seen = [];
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async batch => { seen.push(batch); return '保留约束的摘要'; } });
  await context.prepare(messages, { initial: true });
  assert.ok(seen.length > 1);
  assert.ok(seen.join('').includes('最后的约束'));
  assert.ok(seen.every(s => !/[\ud800-\udbff]$/.test(s)), 'do not split Unicode surrogate pairs');
  assert.equal(seen.join('').split('甲乙丙🙂').length - 1, 12000, 'every character reaches the summarizer');
});

test('saved summary is reusable after restart, but an edited history invalidates it', async () => {
  const messages = [...history(), { role: 'user', content: '当前问题' }];
  const first = createDeepSeekContext({ windowTokens: 8192, summarize: async () => '目标与状态摘要' });
  await first.prepare(messages, { initial: true });
  const second = createDeepSeekContext({ windowTokens: 8192, cache: first.cache, summarize: () => { throw new Error('cache must be reused'); } });
  assert.ok((await second.prepare(messages, { initial: true })).some(m => m.content?.includes('目标与状态摘要')));
  let requests = 0;
  const edited = messages.map((m, i) => i === 0 ? { ...m, content: '编辑后的新要求' + m.content } : m);
  const third = createDeepSeekContext({ windowTokens: 8192, cache: first.cache, summarize: async () => { requests++; return '新的摘要'; } });
  await third.prepare(edited, { initial: true });
  assert.ok(requests > 0);
});

test('failed compaction and oversized current request do not discard or silently truncate messages', async () => {
  const messages = [...history(), { role: 'user', content: '当前问题' }], original = JSON.stringify(messages);
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async () => { throw new Error('502'); } });
  assert.equal(await context.prepare(messages), messages, 'local estimation alone cannot fail a task');
  await assert.rejects(context.prepare(messages, { force: true }), /502/);
  assert.equal(JSON.stringify(messages), original);
  const current = { role: 'user', content: '最新要求'.repeat(20000) };
  const pinned = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current], summarize: async () => '摘要' });
  const source = [current];
  assert.equal(await pinned.prepare(source), source, 'send irreducible input to the real provider before rejecting it');
  await assert.rejects(pinned.prepare(source, { force: true }), /当前规则|上下文/);
});

test('images count as vision inputs, not millions of textual Base64 tokens', () => {
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'a'.repeat(1000000) } }] }];
  assert.ok(estimateContextTokens(messages) < 10000);
});

test('soft pressure does not summarize when the indivisible latest tool group alone stays above the soft target', async () => {
  const current = { role: 'user', content: '完成八模块并回写节点' };
  const assistant = { role: 'assistant', content: null, reasoning_content: '推理'.repeat(13500), tool_calls: [{ id: 'write', function: { name: 'exec_command', arguments: '{}' } }] };
  const receipt = { role: 'tool', tool_call_id: 'write', content: '八模块已经写入' };
  const messages = [{ role: 'system', content: '规则'.repeat(2000) }, current,
    { role: 'assistant', content: '检查接口'.repeat(1000) }, assistant, receipt];
  const before = estimateContextTokens(messages);
  assert.ok(before > 64000 * 0.7 && before < 60000);
  let requests = 0;
  const context = createDeepSeekContext({ summarize: async () => { requests++; return '八模块已写入；下一步回写树。'; } });
  assert.equal((await context.prepare(messages)) === messages, true);
  assert.equal(requests, 0, 'summary cannot solve soft pressure while latest tool group remains protected');
  const forced = await context.prepare(messages, { force: true });
  assert.ok(requests > 0, 'provider context rejection bypasses the soft-pressure deferral');
  assert.ok(forced.includes(assistant) && forced.includes(receipt) && forced.includes(current));
  requests = 0;
  // Once a newer small group has completed, the large group is eligible for a
  // real summary. Preserve reasoning until then, not a tokenizer assumption.
  const nextAssistant = { role: 'assistant', content: '回写节点', reasoning_content: '简短推理', tool_calls: [{ id: 'tree' }] };
  const nextReceipt = { role: 'tool', tool_call_id: 'tree', content: '树已保存' };
  const compacted = await context.prepare([...messages, nextAssistant, nextReceipt], { handoff: true });
  assert.ok(requests > 0);
  assert.ok(estimateContextTokens(compacted) < 64000 * 0.7);
  assert.ok(compacted.includes(nextAssistant) && compacted.includes(nextReceipt) && compacted.includes(current));
  assert.equal(messages[3], assistant, 'source reasoning and original dialogue remain untouched');
});

function assertCompletedToolGroup(messages, expectedIds) {
  const pending = new Set(), calls = [], receipts = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      assert.equal(pending.size, 0, 'a new tool group cannot precede unfinished receipts');
      for (const call of message.tool_calls) {
        assert.ok(!calls.includes(call.id), 'completed tools must not be synthesized for replay');
        calls.push(call.id); pending.add(call.id);
      }
    } else if (message.role === 'tool') {
      assert.ok(pending.has(message.tool_call_id), 'every receipt must follow its matching tool call');
      receipts.push(message.tool_call_id); pending.delete(message.tool_call_id);
    } else {
      assert.equal(pending.size, 0, 'an ordinary message cannot split an unfinished tool group');
    }
  }
  assert.equal(pending.size, 0, 'every preserved tool call must retain its receipt');
  assert.deepEqual(calls, expectedIds, 'compaction must neither remove nor repeat completed calls');
  assert.deepEqual(receipts, expectedIds, 'all completed receipts remain paired in order');
}

test('an oversized latest tool receipt is summarized and execution can continue without replaying its completed write', async () => {
  const current = { role: 'user', content: '继续实现节点：文件已经写好后核对验收，不要再次覆盖。' };
  const assistant = { role: 'assistant', content: null, tool_calls: [
    { id: 'saved-write', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"完成写入并打印报告"}' } }
  ] };
  const receipt = { role: 'tool', tool_call_id: 'saved-write', content: '保存成功：src/feature.js\n' + '完整执行报告'.repeat(5000) + '\n末尾验收事实：文件已保存，下一步核对接口。' };
  const source = [{ role: 'system', content: '项目规则：以真实落盘结果继续。' }, current, assistant, receipt];
  const before = JSON.stringify(source), batches = [], events = [];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current],
    onCompaction: event => events.push(event), summarize: async batch => {
      batches.push(batch); return '保存成功：src/feature.js；已执行 saved-write；下一步核对接口，不要重新写入。';
    } });
  assert.ok(estimateContextTokens(source) > 8192 - 4000);
  const view = await context.prepare(source, { initial: true });
  assert.ok(estimateContextTokens(view) <= 8192 - 4000, 'recovered request fits the real configured response reserve');
  assert.ok(view.includes(current), 'the latest user intent remains verbatim');
  assertCompletedToolGroup(view, ['saved-write']);
  assert.ok(JSON.stringify(view).includes('保存成功：src/feature.js'), 'completed work remains available to the next model request');
  const consumed = batches.join('');
  assert.ok(consumed.includes('末尾验收事实：文件已保存，下一步核对接口。'), 'the report tail is consumed rather than clipped');
  assert.equal(consumed.split('完整执行报告').length - 1, 5000, 'every part of the report reaches compaction');
  assert.ok(events.some(event => event.phase === 'completed'));
  assert.equal(JSON.stringify(source), before, 'the source and full tool report are not overwritten');
});

test('several latest completed tool receipts recover as one valid tool group when their combined size exceeds capacity', async () => {
  const current = { role: 'user', content: '整合两份已保存的模块，保留共同接口，再完成这个节点。' };
  const ids = ['saved-ui', 'saved-api'];
  const assistant = { role: 'assistant', content: null, tool_calls: ids.map(id => ({
    id, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: `保存 ${id} 并输出证据` }) }
  })) };
  const receipts = ids.map((id, i) => ({ role: 'tool', tool_call_id: id,
    content: `保存成功：${id}\n` + `模块${i}证据`.repeat(1800) + `\n${id}末尾：共同接口版本v2，文件已保存。` }));
  const source = [{ role: 'system', content: '共同接口v2；保护用户目标。' }, current, assistant, ...receipts];
  const before = JSON.stringify(source), batches = [];
  const context = createDeepSeekContext({ windowTokens: 8192, protectedMessages: [current], summarize: async batch => {
    batches.push(batch); return '保存成功：saved-ui、saved-api；两份模块已执行保存，共同接口版本v2；继续整合验收。';
  } });
  const view = await context.prepare(source, { initial: true });
  assert.ok(estimateContextTokens(view) <= 8192 - 4000);
  assert.ok(view.includes(current));
  assertCompletedToolGroup(view, ids);
  assert.ok(JSON.stringify(view).includes('共同接口版本v2'), 'handoff retains the interface required to finish this node');
  const consumed = batches.join('');
  for (const [i, id] of ids.entries()) {
    assert.ok(consumed.includes(`${id}末尾：共同接口版本v2，文件已保存。`));
    assert.equal(consumed.split(`模块${i}证据`).length - 1, 1800);
  }
  assert.equal(JSON.stringify(source), before);
});

test('latest tool recovery keeps reasoning verbatim, never caches ephemeral receipt text, and is atomic on failure or cancellation', async () => {
  const current = { role: 'user', content: '保留接口继续完成' };
  const assistant = { role: 'assistant', content: null, reasoning_content: '最新推理原文', tool_calls: [{ id: 'a' }, { id: 'b' }] };
  const receipts = ['a', 'b'].map(id => ({ role: 'tool', tool_call_id: id, content: `已保存${id}：` + '全文'.repeat(3000) }));
  const source = [current, assistant, ...receipts], snapshot = JSON.stringify(source);
  let calls = 0;
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async batch => { calls++; if (batch.includes('"tool_call_id":"b"')) throw new Error('第二结果失败'); return '已保存a；接口不变。'; } });
  const view = await context.prepare(source);
  assert.equal(view, source, 'failed multi-result recovery commits no partial replacements');
  assert.equal(context.cache, null);
  assert.ok(calls > 1, 'the first result completed before the second result failed');
  assert.equal(JSON.stringify(source), snapshot);
  const success = createDeepSeekContext({ windowTokens: 8192, summarize: async () => '工具报告已保存；继续核对接口。' });
  const compacted = await success.prepare(source);
  assert.ok(compacted.includes(assistant));
  assertCompletedToolGroup(compacted, ['a', 'b']);
  assert.equal(success.cache, null, 'tool-only compaction must not claim any durable dialogue coverage');
  const controller = new AbortController();
  const cancelled = createDeepSeekContext({ windowTokens: 8192, signal: controller.signal, summarize: async () => { controller.abort(); return '摘要'; } });
  await assert.rejects(cancelled.prepare(source), { name: 'AbortError' });
  assert.equal(JSON.stringify(source), snapshot);
});

test('an unfinished tool group cannot be condensed and capacity estimation alone cannot reject pinned rules or images', async () => {
  let calls = 0;
  for (const source of [
    [{ role: 'system', content: '完整规则'.repeat(3000) }, { role: 'user', content: '任务' }],
    [{ role: 'user', content: Array.from({ length: 3 }, () => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,a' } })) }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'done' }, { id: 'pending' }] }, { role: 'tool', tool_call_id: 'done', content: '报告'.repeat(3000) }]
  ]) {
    const events = [];
    const context = createDeepSeekContext({ windowTokens: 8192, onCompaction: e => events.push(e), summarize: async () => { calls++; return '摘要'; } });
    assert.equal(await context.prepare(source), source);
    assert.equal(await context.prepare(source), source);
    assert.equal(events.filter(e => e.phase === 'capacity-warning').length, 1, 'unchanged pressure is not repeated every tool boundary');
    assert.ok(events[0].components.rules > 0);
    await assert.rejects(context.prepare(source, { force: true }), /网关已拒绝上下文/);
  }
  assert.equal(calls, 0);
});

test('provider-forced recovery shrinks huge latest results above an immutable fixed floor', async () => {
  const rules = { role: 'system', content: '保留完整规则'.repeat(6000) };
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'saved' }] };
  const receipt = { role: 'tool', tool_call_id: 'saved', content: '实际保存成功'.repeat(8000) };
  const source = [rules, { role: 'user', content: '继续' }, assistant, receipt];
  for (const force of [false, true]) {
    const events = [];
    const context = createDeepSeekContext({ windowTokens: 8192, onCompaction: event => events.push(event),
      summarize: async () => '工具报告已保存，继续验收。' });
    const recovered = await context.prepare(source, { force });
    if (!force) {
      assert.deepEqual(recovered, source, 'optional compaction defers when the immutable floor leaves no safe summary budget');
      assert.ok(events.some(event => event.phase === 'deferred'));
      continue;
    }
    assert.ok(estimateContextTokens(recovered) > 8192 - 4000, 'do not claim the heuristic is the actual model capacity');
    assert.ok(estimateContextTokens(recovered) < estimateContextTokens(source));
    assert.ok(recovered.includes(rules) && recovered.includes(assistant));
    assertCompletedToolGroup(recovered, ['saved']);
  }
});

test('a rejected derived memory can be condensed again without new history or losing durable coverage', async () => {
  const source = [...history(), { role: 'user', content: '当前任务不能变化' }];
  let shorter = false;
  const inputs = [];
  const context = createDeepSeekContext({ windowTokens: 8192, summarize: async (batch, previous) => {
    inputs.push({ batch, previous }); return shorter ? '目标未变；继续保存。' : '有效约束'.repeat(50);
  } });
  const first = await context.prepare(source), indexes = context.cache.coveredIndexes;
  shorter = true; inputs.length = 0;
  const second = await context.prepare(first, { force: true });
  assert.ok(estimateContextTokens(second) < estimateContextTokens(first));
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].batch.includes('有效约束'));
  assert.equal(inputs[0].previous, '');
  assert.deepEqual(context.cache.coveredIndexes, indexes);
  assert.ok(second.includes(source.at(-1)));
});

test('summary transport includes escaping and rolling memory in its budget without dropping Windows path data', async () => {
  const tool = { role: 'tool', tool_call_id: 'saved', content: '已保存 C:\\path\\file.txt：' + '\\'.repeat(160000) + '尾部接口v2' };
  const source = [{ role: 'user', content: '继续' }, { role: 'assistant', content: null, tool_calls: [{ id: 'saved' }] }, tool];
  const batches = [];
  const context = createDeepSeekContext({ windowTokens: 64000, summarize: async (batch, previous) => {
    const messages = [{ role: 'system', content: '只生成中文交接摘要；保留实际结果。' }, { role: 'user', content: `前段摘要：\n${previous}\n以下片段：\n${batch}` }];
    assert.ok(estimateContextTokens(messages) <= 64000 - 4000, 'the serialized summary request itself fits with output reserve');
    batches.push(batch); return '文件已保存；保留接口v2。';
  } });
  const view = await context.prepare(source);
  assert.ok(estimateContextTokens(view) < 64000 - 4000);
  assert.equal(batches.join(''), JSON.stringify(tool));
});
