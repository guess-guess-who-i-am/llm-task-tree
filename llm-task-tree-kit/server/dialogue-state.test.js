import test from 'node:test';
import { dialogueWithCompletionReceipt } from './dialogue-state.js';
import assert from 'node:assert/strict';
import { dialogueMessages, serializeDialogueState, restoreDialogueState } from './dialogue-state.js';

test('presentation survives disk roundtrip without leaking reasoning or changing raw text',()=>{
  const message={role:'assistant',content:'正式回答\n\n【实际交付回执】\n完整差异',presentation:{process:'先读取。再修改。',answer:'正式回答',reasoning:'PRIVATE'}};
  const clean=dialogueMessages([message])[0];
  assert.deepEqual(clean.presentation,{process:'先读取。再修改。',answer:'正式回答'});
  const state=restoreDialogueState(serializeDialogueState({runs:[{id:'r',status:'completed',messages:[message],presentation:message.presentation}],conversations:[{id:'c',messages:[message]}]}));
  assert.deepEqual(state.runs[0].presentation,clean.presentation);
  assert.deepEqual(state.conversations[0].messages[0],clean);
});

test('restart does not append aggregated process output after a separately saved answer',()=>{
  const presentation={process:'先读取再修改',answer:'最终答案'};
  const messages=[{role:'user',content:'执行'},{role:'assistant',content:'最终答案\n\n【实际交付回执】\n文件',presentation}];
  const run={id:'r',nodeId:'N1',treeId:'tree',status:'running',messages,output:presentation.process+presentation.answer,presentation};
  assert.equal(restoreDialogueState({runs:[run]}).conversations[0].messages.length,2);
});

test('tree validation diagnostics retain their stage and cause across restart',()=>{
  const review={verdict:'failed',reason:'注册表仍引用已删除树',failureCategory:'tree-reference',stage:'tree-validation',causeCode:'TREE_REFERENCE_MISSING'};
  const restored=restoreDialogueState({runs:[{id:'missing-tree',status:'failed',review}]}).runs[0];
  assert.equal(restored.review.failureCategory,review.failureCategory);
  assert.equal(restored.review.stage,review.stage);
  assert.equal(restored.review.causeCode,review.causeCode);
});

test('lightweight acceptance phase survives restart without persisting tool bodies or private thoughts',()=>{
  const run={id:'review',status:'running',phase:'checking',workerCompleted:true,
    reviewActivity:{message:'正在接收验收输出',startedAt:'start',at:'last',round:2,receivedChars:50,private:'secret'},
    integrationTimings:[{role:'review-stage',operation:'review.prompt',durationMs:12,attempt:0,private:'secret'}]};
  const saved=serializeDialogueState({runs:[run]});
  assert.equal(saved.runs[0].phase,'checking');
  assert.equal(saved.runs[0].reviewActivity.receivedChars,50);
  assert.equal(saved.runs[0].integrationTimings[0].durationMs,12);
  assert.ok(!JSON.stringify(saved).includes('secret'));
  const restored=restoreDialogueState(saved).runs[0];
  assert.equal(restored.workerCompleted,true);
  assert.equal(restored.recoveryPending,true);
  assert.equal(restored.phase,'checking');
});

const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });

test('restart retains recovery identity without retaining arbitrary runtime payloads',()=>{
  const recovery={action:'fresh-context',signature:'same-failure',reason:'重复超长摘要',codes:['CONTEXT_SUMMARY_NO_PROGRESS'],at:'now'};
  const run={id:'recovery',status:'stopped',recoveryHistory:[{...recovery,toolResult:'PRIVATE_TOOL',reasoning:'PRIVATE_THOUGHT'}]};
  const saved=serializeDialogueState({runs:[run]});
  assert.deepEqual(saved.runs[0].recoveryHistory,[recovery]);
  assert.deepEqual(restoreDialogueState(saved).runs[0].recoveryHistory,[recovery]);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_/);
});

test('restart recovers stopping partial output but preserves a completed stopped record', () => {
  for (const status of ['stopping', 'stopped']) {
    const state = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', nodeId: 'N1', treeId: 'a', status, messages: [user('开始')], output: '完整部分输出' }],
      conversations: [{ id: 'c', treeId: 'a', nodeId: 'N1', messages: status === 'stopped' ? [user('开始'), assistant('完整部分输出')] : [user('开始')] }] });
    assert.equal(state.runs[0].status, 'stopped');
    assert.deepEqual(state.conversations[0].messages, [user('开始'), assistant('完整部分输出')]);
  }
});

test('durable messages contain only full user and assistant text', () => {
  const full = '完整、不截断的对话🙂\n'.repeat(20000);
  assert.deepEqual(dialogueMessages([
    { role: 'system', content: 'private policy' }, user('  '), user(''),
    { role: 'user', content: [{ type: 'text', text: 'not a string' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'secret-call' }] },
    { role: 'tool', content: 'SECRET_TOOL_RESULT' },
    { role: 'assistant', content: full, reasoning_content: 'PRIVATE_REASONING', tool_calls: [] },
    user('继续'),
  ]), [assistant(full), user('继续')]);
  assert.deepEqual(dialogueMessages(null), []);
});

test('v2 serializer excludes tools, reasoning, events and internal runtime state', () => {
  const run = {
    id: 'r', treeId: 'tree', nodeId: 'N1', conversationId: 'c', prompt: '开始',
    messages: [user('开始'), { role: 'tool', content: 'SECRET_TOOL_RESULT' }],
    output: '', status: 'running', threadId: 't', turnId: 'turn', error: '', createdAt: 'before', updatedAt: 'now',
    treeChanges: [],
    reasoning: 'PRIVATE_REASONING', events: [{ result: 'SECRET_EVENT_RESULT' }],
    streams: { agentMessage: { text: '部分答复' }, reasoning: { text: 'PRIVATE_REASONING' }, tool: { text: 'SECRET_STREAM' } },
  };
  const conversation = { id: 'c', treeId: 'tree', nodeId: 'N1', messages: run.messages, activeRunId: 'r', threadId: 't', secret: 'SECRET_EXTRA' };
  const saved = serializeDialogueState({ runs: new Map([['r', run]]), conversations: [conversation] });
  assert.equal(saved.schema, 'task-tree-direct-state/v2');
  assert.equal(saved.runs[0].output, '部分答复');
  assert.deepEqual(saved.runs[0].messages, [user('开始')]);
  assert.deepEqual(Object.keys(saved.runs[0]), ['id', 'treeId', 'projectRoot', 'treePath', 'nodeId', 'conversationId', 'prompt', 'messages', 'output', 'status', 'threadId', 'turnId', 'error', 'workspacePath', 'checkpoint', 'recoveryPending', 'recoveryHistory', 'workerCompleted', 'phase', 'reviewActivity', 'integrationTimings', 'changedFiles', 'appliedFiles', 'treeChanges', 'review', 'executionMode', 'parallel', 'createdAt', 'updatedAt']);
  assert.deepEqual(Object.keys(saved.conversations[0]), ['id', 'nodeId', 'treeId', 'messages', 'activeRunId', 'threadId']);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET_|PRIVATE_REASONING|tool_calls|reasoning_content/);
  assert.equal(run.status, 'running');
  assert.equal(run.events.length, 1);
  assert.equal(serializeDialogueState({ runs: [{ ...run, output: '最终答复' }] }).runs[0].output, '最终答复');
});

test('final review outcome survives restart without saving transient tool traces', () => {
  const review = { verdict: 'failed', reason: '修复仍失败', evidence: ['相关用例失败'], rootCause: '接口不匹配', caseStudy: '定位首个错误边界', sources: [{ url: 'https://example.org/reference', finding: '接口定义' }], solution: '统一接口', tools: ['PRIVATE_TOOL_TRACE'] };
  const state = restoreDialogueState(JSON.parse(JSON.stringify(serializeDialogueState({ runs: [{ id: 'r', status: 'failed', review }] }))));
  const { tools, ...expected } = review;
  assert.deepEqual(state.runs[0].review, expected);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_TOOL_TRACE/);
});

test('restart restores interrupted user and partial assistant text exactly once', () => {
  const history = [user('第一轮'), assistant('第一轮答复')];
  const state = { schema: 'task-tree-direct-state/v1',
    runs: [{ id: 'r', conversationId: 'c', nodeId: 'N1', treeId: 'tree', status: 'running', messages: [...history, user('第二轮')], streams: { agentMessage: { text: '第二轮部分答复' } } }],
    conversations: [{ id: 'c', treeId: 'tree', nodeId: 'N1', messages: history, activeRunId: 'r' }],
  };
  const restored = restoreDialogueState(state);
  assert.equal(restored.runs[0].status, 'starting');
  assert.equal(restored.runs[0].recoveryPending,true);
  assert.equal(restored.conversations[0].activeRunId, 'r');
  assert.deepEqual(restored.conversations[0].messages, [...history, user('第二轮'), assistant('第二轮部分答复')]);
  assert.deepEqual(restoreDialogueState(serializeDialogueState(restored)), restored);
  assert.equal(state.runs[0].status, 'running');
});

test('eight independent conversations survive restart without mixing or truncation', () => {
  const runs = [], conversations = [];
  for (let i = 0; i < 8; i++) {
    const text = `会话${i}🙂`.repeat(20000);
    runs.push({ id: `r${i}`, conversationId: `c${i}`, nodeId: `N${i}`, treeId: `tree${i}`, status: i % 2 ? 'starting' : 'running', messages: [user(text)], output: `输出${i}` });
    conversations.push({ id: `c${i}`, nodeId: `N${i}`, treeId: `tree${i}`, messages: [], activeRunId: `r${i}` });
  }
  const restored = restoreDialogueState(JSON.parse(JSON.stringify(serializeDialogueState({ runs, conversations }))));
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(restored.conversations[i].messages, [user(`会话${i}🙂`.repeat(20000)), assistant(`输出${i}`)]);
    assert.equal(restored.conversations[i].treeId, `tree${i}`);
    assert.equal(restored.runs[i].status, 'starting');
    assert.equal(restored.runs[i].recoveryPending,true);
  }
});

test('legacy completed state retains text only, repeated legitimate turns and existing errors', () => {
  const repeated = [user('继续'), assistant('收到'), user('继续'), assistant('收到')];
  const state = { runs: [{ id: 'r', status: 'completed', output: '收到', messages: repeated, events: [{ type: 'tool' }] }], conversations: [{ id: 'c', activeRunId: 'missing', messages: [...repeated, { role: 'tool', content: 'SECRET' }] }] };
  const restored = restoreDialogueState(state);
  assert.deepEqual(restored.conversations[0].messages, repeated);
  assert.equal(restored.runs[0].status, 'completed');
  assert.equal(restored.conversations[0].activeRunId, '');
  assert.doesNotMatch(JSON.stringify(restored), /SECRET|events/);
  assert.deepEqual(restoreDialogueState(null), { runs: [], conversations: [] });
});

test('interrupted state without a conversation recreates it and avoids duplicated final output', () => {
  const restored = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', nodeId: 'N', treeId: 'tree', threadId: 'thread', status: 'running', prompt: '开始', messages: [user('开始'), assistant('部分')], output: '部分' }] });
  assert.deepEqual(restored.conversations[0], { id: 'c', nodeId: 'N', treeId: 'tree', messages: [user('开始'), assistant('部分')], activeRunId: 'r', threadId: 'thread' });
  const queued = restoreDialogueState({ runs: [{ id: 'q', conversationId: 'qc', status: 'starting', prompt: '排队请求' }] });
  assert.deepEqual(queued.conversations[0].messages, [user('排队请求')]);
});

test('recovery uses only the matching conversation tree and does not duplicate overlapping history', () => {
  const history = [user('一'), assistant('二'), user('三')];
  const restored = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', treeId: 'tree', status: 'running', messages: history, output: '四' }], conversations: [{ id: 'c', treeId: 'tree', messages: history, activeRunId: 'r' }] });
  assert.deepEqual(restored.conversations[0].messages, [...history, assistant('四')]);
  const foreign = restoreDialogueState({ runs: [{ id: 'r', conversationId: 'c', treeId: 'other', status: 'running', messages: [user('不属于本树')]}], conversations: [{ id: 'c', treeId: 'tree', messages: [user('原树')], activeRunId: 'r' }] });
  assert.deepEqual(foreign.conversations[0].messages, [user('原树')]);
});
test('final dialogue and export include actual checker repairs, not just the worker plan',()=>{
  const source=[{role:'user',content:'创建文件'},{role:'assistant',content:'下一步可以创建文件'}];
  const result=dialogueWithCompletionReceipt(source,{status:'completed',appliedFiles:['result.txt'],review:{verdict:'pass',reason:'已补齐并验证'}});
  assert.match(result.at(-1).content,/实际交付回执[\s\S]*已补齐并验证[\s\S]*result.txt/);
  assert.equal(source.at(-1).content,'下一步可以创建文件');
  for(const status of ['failed','stopped'])assert.deepEqual(dialogueWithCompletionReceipt(source,{status,review:{verdict:'pass'}}),source);
  const readOnly=dialogueWithCompletionReceipt(source,{status:'completed',appliedFiles:[],review:{verdict:'pass',reason:'只读解释正确'}});
  assert.match(readOnly.at(-1).content,/本轮未修改文件/);
  const legacy=restoreDialogueState({runs:[{status:'completed',appliedFiles:['task-tree.md'],review:{verdict:'pass',reason:'旧记录'}}]}).runs[0];
  assert.match(dialogueWithCompletionReceipt(source,legacy).at(-1).content,/旧记录未保存节点差异/);
});

test('host receipt names the owning project/tree and actual persisted node fields across restart',()=>{
  const run={status:'completed',projectRoot:'/project',treeId:'method',treePath:'task-tree.md',nodeId:'N1',
    appliedFiles:['subtrees/N1.md'],review:{verdict:'pass',reason:'已核对'},
    treeChanges:[{treePath:'subtrees/N1.md',changes:[{kind:'node-field',nodeId:'N1',title:'研究',field:'CurrentResult',before:'旧结果',after:'新结果'}]}]};
  const restored=restoreDialogueState(serializeDialogueState({runs:[run]})).runs[0];
  assert.equal(restored.projectRoot,run.projectRoot);
  assert.equal(restored.treePath,run.treePath);
  assert.deepEqual(restored.treeChanges,run.treeChanges);
  const result=dialogueWithCompletionReceipt([{role:'assistant',content:'已写入工作区'}],restored);
  assert.match(result.at(-1).content,/\/project[\s\S]*method[\s\S]*subtrees\/N1.md[\s\S]*N1[\s\S]*CurrentResult[\s\S]*旧结果 → 新结果/);
});
