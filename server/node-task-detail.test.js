import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function ui(fetch) {
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('const nodeTaskDetailCache =');
  assert.notEqual(start,-1,'full task UI must exist, not just a Notes file pointer');
  const end=source.indexOf('\nfunction compactNodeDetails(',start);
  const context=vm.createContext({fetch,viewTreeId:'method',escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),attr:s=>String(s),renderMarkdownLite:s=>String(s).replaceAll('<','&lt;')});
  vm.runInContext(source.slice(start,end),context);
  return context;
}
test('old folded tasks and subtree roots expose the entire instruction with lazy deduplicated loading',async()=>{
  const instruction='完整任务\n'+ '中文要求'.repeat(5000)+'\nTAIL_NOT_TRUNCATED';
  let calls=0;
  const ctx=await ui(async url=>{calls++;assert.equal(url,'/api/file?path=subtrees%2FP_run_person.task.json');return {ok:true,text:async()=>JSON.stringify({title:'人物建模',instruction,branchContext:'<img onerror=x>上下文',dependsOn:['literature']})};});
  assert.equal(ctx.nodeTaskDetailPath({id:'N1',subtreeFile:'subtrees/P_run_person.md'}),'subtrees/P_run_person.task.json');
  assert.equal(ctx.nodeTaskDetailPath({id:'P_run_person',notes:'完整任务说明见 subtrees/P_run_person.task.json。'}),'subtrees/P_run_person.task.json');
  const [a,b]=await Promise.all([ctx.loadNodeTaskDetail('subtrees/P_run_person.task.json'),ctx.loadNodeTaskDetail('subtrees/P_run_person.task.json')]);
  assert.equal(calls,1);assert.equal(a.instruction,instruction);assert.equal(b.instruction,instruction);
  const html=ctx.nodeTaskDetailBox({id:'P_run_person'});
  assert.ok(html.includes(instruction));assert.match(html,/TAIL_NOT_TRUNCATED/);assert.doesNotMatch(html,/<img/);assert.match(html,/上下文|literature/);
  assert.equal(ctx.nodeTaskDetailBox({id:'ordinary'}),'');
});
test('missing task is visible and retryable, never a successful empty instruction',async()=>{
  let calls=0;const ctx=await ui(async()=>{calls++;return {ok:false,status:404,text:async()=>'找不到文件'};});
  await assert.rejects(ctx.loadNodeTaskDetail('subtrees/P_run_missing.task.json'),/找不到文件/);
  const html=ctx.nodeTaskDetailBox({id:'P_run_missing'});
  assert.match(html,/找不到文件/);assert.match(html,/重试/);
  await assert.rejects(ctx.loadNodeTaskDetail('subtrees/P_run_missing.task.json'),/找不到文件/);assert.equal(calls,2);
});

test('completion notice distinguishes worker prose, final checking, failure and terminal success',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function directRunCompletionNotice('),end=source.indexOf('\nfunction directRunTranscriptHtml',start);
  const ctx=vm.createContext({});vm.runInContext(source.slice(start,end),ctx);
  assert.match(ctx.directRunCompletionNotice({status:'running',workerCompleted:true,reviewActivity:{message:'验收调用 read_file'}}),/整轮尚未结束.*read_file/);
  assert.match(ctx.directRunCompletionNotice({status:'running',progress:{phase:'repairing',label:'正在修复'}}),/不代表系统已经结束/);
  assert.equal(ctx.directRunCompletionNotice({status:'completed',workerCompleted:true}),'');
  assert.equal(ctx.directRunCompletionNotice({status:'failed',workerCompleted:true}),'');
  assert.match(ctx.directRunCompletionNotice({status:'stopped',workspacePath:'/candidate',appliedFiles:[]}),/执行者报告不代表主树已更新[\s\S]*\/candidate[\s\S]*没有文件合入/);
  assert.match(ctx.directRunCompletionNotice({status:'failed',workspacePath:'/candidate',appliedFiles:['early.txt']}),/部分成果已合入/);
});

test('typing label shows host acceptance activity rather than waiting for more worker prose',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function directRunTypingLabel('),end=source.indexOf('\nfunction directRunNodeKey',start);
  const ctx=vm.createContext({});vm.runInContext(source.slice(start,end),ctx);
  assert.match(ctx.directRunTypingLabel({status:'running',workerCompleted:true,reviewActivity:{message:'正在接收验收输出'}}),/正在接收验收输出/);
  assert.match(ctx.directRunTypingLabel({status:'running',progress:{phase:'merging',label:'正在合入'}}),/正在合入/);
  assert.match(ctx.directRunTypingLabel({status:'failed',workerCompleted:true}),/本轮已结束/);
});

test('empty-send continuation reuses a completed worker checkpoint after failed final checking',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function continueDirectRun()'),end=source.indexOf('\nasync function stopDirectRun()',start);
  let payload;
  const ctx=vm.createContext({activeDirectRunId:'saved-run',directRunStates:new Map([['saved-run',{
    id:'saved-run',treeId:'method',nodeId:'ROOT',status:'failed',workerCompleted:true,workspacePath:'/saved-candidate'
  }]]),els:{directRunMessageInput:{value:''}},attachmentDrafts:()=>[],directRunEditing:null,
    isDirectRunBusy:()=>false,directRunDeletingNodes:new Set(),directRunSubmittingNodes:new Set(),
    directRunNodeKey:r=>r.nodeId,renderDirectRunDialog:()=>{},nodes:[],directRunMaterialSelection:new Map(),
    viewTreeId:'method',runCodex:async body=>{payload=body;return {};}});
  vm.runInContext(source.slice(start,end),ctx);
  await ctx.continueDirectRun();
  assert.equal(payload.resumeRunId,'saved-run');
});
