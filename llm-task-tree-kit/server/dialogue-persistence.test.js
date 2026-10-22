import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import http from 'node:http';
import {starterTreeMarkdown} from './tree-registry.js';

const history=[{role:'user',content:'第一轮问题'}, {role:'assistant',content:'第一轮答案'},
  {role:'user',content:'甲和乙有矛盾，应按实际关系分类'}, {role:'assistant',content:'保留事实，不按同群推断互信'}];
async function fixture(t,{messages=history,run={},environment={}}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'dialogue-persistence-'));
  await mkdir(path.join(root,'trees'));
  await writeFile(path.join(root,'task-tree.md'),starterTreeMarkdown({title:'方法树',role:'method'}));
  await writeFile(path.join(root,'trees/people.md'),starterTreeMarkdown({title:'人物树',role:'method'}));
  await writeFile(path.join(root,'task-trees.json'),JSON.stringify({schema:'task-tree-registry/v1',activeMethod:'method',trees:[
    {id:'method',title:'方法树',role:'method',path:'task-tree.md'}, {id:'people',title:'人物树',role:'method',path:'trees/people.md'}]}));
  await writeFile(path.join(root,'.task-tree-direct-state.json'),JSON.stringify({runs:[{
    id:'saved-run',treeId:'method',nodeId:'ROOT',conversationId:'["method","ROOT"]',status:'completed',messages:messages.slice(0,2),output:messages.at(-1).content,createdAt:'2026-10-17T10:00:00Z',...run}],
    conversations:[{id:'["method","ROOT"]',treeId:'method',nodeId:'ROOT',messages}]}));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,TASK_TREE_PROJECT_ROOT:root,PORT:'0',TASK_TREE_NO_OPEN:'1',...environment},stdio:['ignore','pipe','pipe']});
  let log='';
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log)),12000);
    child.stdout.on('data',data=>{log+=data;const url=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];if(url){clearTimeout(timer);resolve(url);}});
    child.stderr.on('data',data=>log+=data);child.once('error',reject);});
  t.after(async()=>{const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;await rm(root,{recursive:true,force:true});});
  return {root,base};
}

test('real HTTP execution publishes process metadata through host acceptance, API and durable history', {timeout:30000},async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'dialogue-presentation-home-'));let calls=0,workerPid;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),review=body.messages.some(m=>typeof m.content==='string'&&m.content.includes('【功能验收】'));
    if(body.tool_choice==='required'&&body.tools?.some(t=>t.function.name==='task_tree_continue_single')){
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'mode',type:'function',function:{name:'task_tree_continue_single',arguments:JSON.stringify({reason:'只读对话回归，无独立交付分支',nextCheckpoint:'读取当前树并回答'})}}]}}]}));return;
    }
    const message=review?{tool_calls:[{id:'verdict',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify({verdict:'pass',reason:'只读回答已核对',evidence:['已读取任务树']})}}]}:
      ++calls===1?{content:'正在读取任务树。',tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"task-tree.md"}'}}]}:{content:'正式回答：已核对当前树。'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>provider.close(r));if(workerPid)try{process.kill(workerPid,'SIGTERM');}catch{}await rm(home,{recursive:true,force:true});});
  const {root,base}=await fixture(t,{environment:{CODEX_HOME:home,TASK_TREE_GLOBAL_ENV_FILE:path.join(home,'.env'),TASK_TREE_API_CONNECTIONS_FILE:path.join(home,'api.json'),
    MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${provider.address().port}`,MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture',MODEL_AGENT_MAIN_FALLBACK_MODELS:'',MODEL_AGENT_MAIN_FALLBACK_BASE_URLS:''}});
  const response=await fetch(base+'/api/codex/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({treeId:'method',nodeId:'ROOT',prompt:'只读取当前任务树并简述结果',fresh:false,open:false,progress:true})});
  assert.equal(response.status,202);const {id}=await response.json();
  let run;const deadline=Date.now()+15000;
  do {run=(await(await fetch(base+'/api/codex/run/'+id)).json()).run;if(['completed','failed','stopped'].includes(run.status))break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<deadline);
  assert.equal(run.status,'completed',run.error);assert.equal(calls,2,'one tool round plus final answer, no presentation LLM');
  workerPid=run.timing?.workerPid;
  assert.deepEqual(run.presentation,{process:'正在读取任务树。',answer:'正式回答：已核对当前树。'});
  assert.deepEqual(run.messages.at(-1).presentation,run.presentation);
  assert.match(run.messages.at(-1).content,/正式回答：[\s\S]*【实际交付回执】/);
  const saved=JSON.parse(await readFile(path.join(root,'.task-tree-direct-state.json')));
  assert.deepEqual(saved.conversations.find(c=>c.nodeId==='ROOT'&&c.treeId==='method').messages.at(-1).presentation,run.presentation);
});

test('answers, process and long legacy receipts stay separate across streaming, reload and mobile', {timeout:45000},async t=>{
  const receipt='【实际交付回执】\n'+Array.from({length:165},(_,i)=>`N${i} · CurrentResult：旧状态 → 已验证的新状态`).join('\n');
  const messages=[{role:'user',content:'请完成节点'},
    {role:'assistant',content:'正式回答：已经完成。\n\n'+receipt},
    {role:'user',content:'继续完善'},
    {role:'assistant',content:'最终回答：已完善并测试。\n\n'+receipt,presentation:{process:'读取资料。\n修改文件。\n运行测试。',answer:'最终回答：已完善并测试。'}}];
  const {base}=await fixture(t,{messages,run:{output:'读取资料。\n修改文件。\n运行测试。最终回答：已完善并测试。',presentation:messages.at(-1).presentation}});
  const {chromium}=createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(base+'/?tree=method');await page.waitForFunction(()=>window.taskTreeBoot?.state==='ready');
    if(await page.locator('#projectOverviewDialog').evaluate(e=>e.open))await page.locator('#projectOverviewClose').click();
    await page.locator('#directRunReopenBtn').click();};
  await open();
  const transcript=page.locator('#directRunTranscript');
  assert.equal(await transcript.locator('.directRunReceipt').count(),2);
  assert.equal(await transcript.locator('.directRunProcess').count(),1);
  assert.equal(await transcript.locator('details[open]').count(),0);
  assert.equal(await transcript.locator('.directRunMessage--assistant').count(),2);
  assert.ok(!(await transcript.locator('.directRunMessage--assistant').allTextContents()).join('').includes('CurrentResult'));
  const answerHeight=await transcript.locator('.directRunMessage--assistant').last().evaluate(e=>e.getBoundingClientRect().height);
  assert.ok(answerHeight<150,`answer height ${answerHeight}`);
  const receiptSummary=transcript.locator('.directRunReceipt summary').first();await receiptSummary.focus();await page.keyboard.press('Enter');
  assert.equal(await transcript.locator('.directRunReceipt').first().evaluate(e=>e.open),true);
  await page.evaluate(()=>{const r=directRunStates.get(activeDirectRunId);r.reasoning='独立思考';renderDirectRunDialog();});
  assert.equal(await transcript.locator('.directRunReceipt').first().evaluate(e=>e.open),true,'open state survives full rerender');
  assert.equal(await transcript.locator('.directRunReasoning').evaluate(e=>e.open),false);
  await transcript.locator('.directRunReceipt summary').first().click();
  await transcript.evaluate(e=>e.scrollTop=e.scrollHeight);
  await page.screenshot({path:'artifacts/dialogue-sections-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await transcript.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  const geometry=await page.locator('#directRunDialog').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:[...e.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>e.getBoundingClientRect().right+1).slice(0,10).map(x=>[x.tagName,x.id,x.className,x.getBoundingClientRect().width])}));
  assert.ok(geometry.scroll<=geometry.width+1,`dialog must not clip content horizontally: ${JSON.stringify(geometry)}`);
  await page.screenshot({path:'artifacts/dialogue-sections-mobile.png'});
  await page.evaluate(()=>{const r=directRunStates.get(activeDirectRunId);r.status='running';r.workerCompleted=false;r.messages=[{role:'user',content:'当前请求'}];r.output='先检查文件。';delete r.presentation;renderDirectRunDialog();});
  assert.equal(await transcript.locator('.directRunMessage--assistant').count(),0);
  const liveProcess=transcript.locator('[data-direct-run-disclosure="live-process"]');await liveProcess.locator('summary').click();
  await page.evaluate(()=>{const r=directRunStates.get(activeDirectRunId);r.output+='准备修改。';renderDirectRunDialog();r.reasoning+='新的推理';r.messages.push({role:'user',content:'即时指导'});renderDirectRunDialog();});
  assert.equal(await liveProcess.evaluate(e=>e.open),true);
  assert.match(await liveProcess.textContent(),/准备修改/);
  await open();
  assert.equal(await transcript.locator('details[open]').count(),0,'fresh load defaults collapsed');
  assert.equal((await(await fetch(base+'/api/codex/runs')).json()).runs[0].messages.at(-1).content,messages.at(-1).content,'rendering never rewrites raw history');
  assert.deepEqual(errors,[]);
});

test('HTTP history returns complete dialogue after actual server startup',async t=>{
  const {base}=await fixture(t);
  const data=await(await fetch(base+'/api/codex/runs')).json();
  assert.deepEqual(data.runs[0].messages,history);
});

test('node drafts persist on disk, serialize concurrent keys, reject invalid input and preserve latest clear',async t=>{
  const {base,root}=await fixture(t);
  const put=body=>fetch(base+'/api/codex/drafts',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await put({treeId:'method',nodeId:'ROOT',text:'未发送草稿',attachments:[],updatedAt:100})).status,200);
  await Promise.all(Array.from({length:12},(_,i)=>put({treeId:'method',nodeId:'N'+i,text:'草稿'+i,attachments:[],updatedAt:101})));
  const data=await(await fetch(base+'/api/codex/drafts')).json();
  assert.equal(data.drafts.length,13);
  assert.equal(JSON.parse(await readFile(path.join(root,'.task-tree-dialogue-drafts.json'))).drafts.length,13);
  await put({treeId:'method',nodeId:'ROOT',text:'',attachments:[],updatedAt:200});
  await put({treeId:'method',nodeId:'ROOT',text:'过期请求不能复活草稿',attachments:[],updatedAt:150});
  assert.equal((await(await fetch(base+'/api/codex/drafts')).json()).drafts.find(d=>d.nodeId==='ROOT').text,'');
  assert.equal((await put({treeId:'method',text:'missing node'})).status,400);
  assert.equal((await put({treeId:'method',nodeId:'ROOT',text:[],updatedAt:300})).status,400);
  await put({treeId:'method',nodeId:'ROOT',text:'删除会话时一起清理',updatedAt:301});
  assert.equal((await fetch(base+'/api/codex/conversation?treeId=method&nodeId=ROOT',{method:'DELETE'})).status,200);
  assert.equal((await(await fetch(base+'/api/codex/drafts')).json()).drafts.find(d=>d.nodeId==='ROOT').text,'');
});

test('other-tree history is discoverable, and unsent drafts survive reload plus a fresh browser context', {timeout:45000},async t=>{
  const {base}=await fixture(t);
  const {chromium}=createRequire(import.meta.url)('../prototype/swimlane-view/node_modules/playwright');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?tree=people');await page.waitForFunction(()=>window.taskTreeBoot?.state==='ready');
  if(await page.locator('#projectOverviewDialog').evaluate(e=>e.open))await page.locator('#projectOverviewClose').click();
  await page.locator('#directRunReopenBtn').waitFor({state:'visible',timeout:3000});
  await page.locator('#directRunReopenBtn').click();
  assert.match(await page.locator('#directRunConversationSelect').textContent(),/方法树/);
  await page.locator('#directRunConversationSelect').selectOption('saved-run');
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('tree')==='method');
  await page.waitForFunction(()=>document.querySelector('#directRunTranscript').textContent.includes('甲和乙有矛盾'));
  await page.locator('#directRunMessageInput').fill('还没发送的分类补充');
  await page.reload();await page.waitForFunction(()=>window.taskTreeBoot?.state==='ready');
  if(await page.locator('#projectOverviewDialog').evaluate(e=>e.open))await page.locator('#projectOverviewClose').click();
  await page.locator('#directRunReopenBtn').click();
  await page.waitForFunction(()=>document.querySelector('#directRunMessageInput').value==='还没发送的分类补充');
  const context=await browser.newContext(),other=await context.newPage();
  await other.goto(base+'/?tree=method');await other.waitForFunction(()=>window.taskTreeBoot?.state==='ready');
  if(await other.locator('#projectOverviewDialog').evaluate(e=>e.open))await other.locator('#projectOverviewClose').click();
  await other.locator('#directRunReopenBtn').click();
  await other.waitForFunction(()=>document.querySelector('#directRunMessageInput').value==='还没发送的分类补充');
  await other.locator('#directRunDeleteBtn').click();
  await other.waitForFunction(()=>document.querySelector('#directRunMessageInput').value==='');
  await other.reload();await other.waitForFunction(()=>window.taskTreeBoot?.state==='ready');
  assert.equal((await(await fetch(base+'/api/codex/runs')).json()).runs.length,0);
  assert.equal((await(await fetch(base+'/api/codex/drafts')).json()).drafts.find(d=>d.nodeId==='ROOT').text,'');
  assert.equal(await other.locator('#directRunReopenBtn').isVisible(),false,'deleted draft must not resurrect a conversation on reload');
  assert.deepEqual(errors,[]);
});
