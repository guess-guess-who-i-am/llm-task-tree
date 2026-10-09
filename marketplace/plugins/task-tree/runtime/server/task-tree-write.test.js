import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';

const source = path.resolve(import.meta.dirname,'..');
const main = '# LLM Task Graph\n\n## ROOT - 生活目标\n- Problem: 持续获得体验并守住生活底线。\n- NextIdea: 展开身体子树。\n\n## N9 - 身体底盘\n- Problem: 怎样先养好身体？\n- Approach: 优先建立睡眠、习惯和时间安排。\n- NextIdea: 展开三个可推进的行动。\n\n## N10 - 收入系统\n- Problem: 如何形成可持续收入？\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n- NextPlan: 用户备忘\n\n# Edges\n## E1 - 底盘\n- Endpoints: ROOT, N9\n## E2 - 收入\n- Endpoints: ROOT, N10\n';
const subtree = '# LLM Task Graph Subtree\n\n> Fold root: N9\n\n## N9 - 身体底盘\n- Problem: 怎样先养好身体？\n- NextIdea: 从睡眠开始。\n\n## N11 - 睡眠\n- Problem: 怎样形成稳定睡眠？\n- NextIdea: 记录三天睡眠时间。\n\n# GraphState\n- Current: N9\n- Next: N11\n\n# Edges\n## E9 - 睡眠\n- Endpoints: N9, N11\n';

test('real IDE tool boundary rejects subtree-as-main and links correct subtree without deleting siblings', async t => {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'tree-write-regression-'));
  const home=await mkdtemp(path.join(os.tmpdir(),'tree-write-home-'));
  await writeFile(path.join(cwd,'task-tree.md'),main);
  let call, seen=[];
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);seen.push(body);
    const last=body.messages.at(-1);
    const message=last.role==='tool' && !last.tool_call_id.startsWith('host-')?{content:'测试结束'}:{content:null,tool_calls:[{id:'fixture',type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const child=spawn(process.execPath,[path.join(source,'server.js')],{cwd:source,env:{...process.env,CODEX_HOME:home,PORT:'0',TASK_TREE_PROJECT_ROOT:cwd,TASK_TREE_NO_OPEN:'1',MODEL_AGENT_MAIN_BASE_URL:`http://127.0.0.1:${provider.address().port}`,MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill();await new Promise(r=>provider.close(r));});
  const url=await new Promise((resolve,reject)=>{
    let log='',stderr='';child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>reject(new Error('IDE startup timeout: '+stderr)),10000);
    child.stdout.on('data',c=>{log+=c;const m=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
    child.once('error',reject);
  });
  async function invoke(name,args,treeId='method'){
    call={name,args};seen=[];
    const accepted=await(await fetch(url+'/api/codex/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({progress:true,nodeId:'N9',treeId,prompt:'边界回归验证',conversationId:crypto.randomUUID()})})).json();
    for(let i=0;i<300;i++){
      const {run}=await(await fetch(url+'/api/codex/run/'+accepted.id)).json();
      if(!['starting','running'].includes(run.status)){
        assert.equal(run.status,'completed',run.error);
        return JSON.parse(seen.find(b=>b.messages.at(-1)?.role==='tool' && !b.messages.at(-1).tool_call_id.startsWith('host-')).messages.at(-1).content);
      }
      await new Promise(r=>setTimeout(r,20));
    }
    throw new Error('Fixture execution did not finish');
  }
  const wrong=await invoke('task_tree_write',{markdown:subtree,reason:'错误子树覆盖'});
  assert.equal(wrong.ok,false,'subtree payload must be rejected before touching main tree');
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),main);
  const mcp=await createTaskTreeAgentTools({cwd,environment:{CODEX_HOME:home}});
  t.after(()=>mcp.close());
  await assert.rejects(mcp.call('task_tree_write',{path:'subtrees/N9-subtree.md',markdown:subtree,reason:'MCP错误path'}),/path/);
  await assert.rejects(mcp.call('task_tree_write',{markdown:subtree,reason:'MCP子树误覆盖'}),/子树/);
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),main);
  const pathError=await invoke('task_tree_write',{path:'subtrees/N9-subtree.md',markdown:subtree,reason:'错传path'});
  assert.equal(pathError.ok,false);assert.match(pathError.error,/path|task_tree_subtree/);
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),main);
  const missing=await invoke('task_tree_write',{markdown:subtree.replace('# LLM Task Graph Subtree','# LLM Task Graph').replace('> Fold root: N9\n',''),reason:'缺少主树节点'});
  assert.equal(missing.ok,false);assert.match(missing.error,/ROOT|丢失|删除/);
  const invisible=await invoke('task_tree_subtree',{action:'write',path:'subtrees/N9-subtree.md',markdown:subtree.replaceAll('N11','N9.1'),foldRoot:'N9',reason:'不受界面支持的ID'});
  assert.equal(invisible.ok,false,'a node that the actual UI cannot parse must not be saved');
  await writeFile(path.join(cwd,'task-tree.md'),main.replace('- NextPlan: 用户备忘','- NextPlan: 用户备忘\n- ChainForceNext: N9'));
  const saved=await invoke('task_tree_subtree',{action:'write',path:'subtrees/N9-subtree.md',markdown:subtree,foldRoot:'N9',reason:'展开身体'});
  assert.equal(saved.ok,true,JSON.stringify(saved));
  const updated=await readFile(path.join(cwd,'task-tree.md'),'utf8');
  assert.equal(saved.receiptVerification?.readBack,true,'write receipt must be verified by the host');
  assert.equal(saved.foldReceipt?.rootDetailsPath,'subtrees/N9-subtree.md');
  assert.equal(saved.foldReceipt?.mainRootIsIndexOnly,true);
  assert.equal(saved.foldReceipt?.unchangedSiblings,true);
  assert.equal(saved.foldReceipt?.unchangedGraphState,true);
  const childPrepared=seen[0].messages.filter(m=>m.role==='tool'&&m.tool_call_id.startsWith('host-'));
  const edgeNormalization=await invoke('task_tree_subtree',{action:'write',path:'subtrees/N9-subtree.md',markdown:subtree+'\n## E2 - 新内部关系\n- Endpoints: N9, N11\n- Label: 子树内的另一含义\n\n## E_PARENT - 主树父关系\n- Endpoints: ROOT, N9\n',foldRoot:'N9',reason:'保留边语义并避免命名重试'});
  assert.equal(edgeNormalization.ok,true,JSON.stringify(edgeNormalization));
  assert.deepEqual(edgeNormalization.foldReceipt.renamedEdges,[{from:'E2',to:'E2_N9',endpoints:['N9','N11']}]);
  assert.equal(edgeNormalization.foldReceipt.retainedMainEdges[0].mainId,'E1');
  assert.match(await readFile(path.join(cwd,'subtrees/N9-subtree.md'),'utf8'),/## E2_N9 - 新内部关系/);
  assert.doesNotMatch(await readFile(path.join(cwd,'subtrees/N9-subtree.md'),'utf8'),/Endpoints: ROOT, N9/);
  assert.equal(childPrepared.length,2);
  assert.match(updated,/- ChainForceNext: N9/,'agent fold must preserve the pending user focus choice');
  assert.match(updated,/## ROOT - 生活目标/);assert.match(updated,/## N10 - 收入系统/);
  assert.match(updated,/- SubtreeFile: subtrees\/N9-subtree.md/);assert.match(updated,/- Folded: true/);
  assert.match(updated,/- NextPlan: 用户备忘/);
  const sub=await readFile(path.join(cwd,'subtrees/N9-subtree.md'),'utf8');assert.match(sub,/## N11 - 睡眠/);
  const focused=await invoke('task_tree_focus',{nodeId:'N11'});assert.equal(focused.node.id,'N11');assert.equal(focused.node.fields.NextIdea.trim(),'记录三天睡眠时间。');
  const childContext=seen[0].messages.find(m=>m.role==='tool'&&m.name==='task_tree_summary');
  assert.ok(childContext, 'host prepares a fresh map rather than an entire folded subtree');
  assert.doesNotMatch(childContext.content,/## N11 - 睡眠/,'folded descendants are opt-in, not automatically prepared');
  assert.ok(!seen[0].messages.some(m=>m.role==='tool'&&m.name==='task_tree_subtree'&&m.tool_call_id.startsWith('host-')));
  const childPatch=await invoke('task_tree_write',{nodeId:'N11',fields:{CurrentResult:'已记录第一天睡眠时间，尚未形成稳定习惯。'},reason:'子节点进展'});
  assert.equal(childPatch.ok,true);assert.equal(childPatch.treePath,'subtrees/N9-subtree.md');
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),updated);
  assert.match(await readFile(path.join(cwd,'subtrees/N9-subtree.md'),'utf8'),/已记录第一天睡眠时间/);
  const flow=await invoke('task_tree_flow_status',{});assert.equal(flow.ok,true);assert.equal(flow.available,false);
  const added=main.replace('# GraphState','## N12 - 新节点\n- Problem: 怎样推进？\n\n# GraphState');
  await writeFile(path.join(cwd,'task-tree.md'),main);
  const whole=await invoke('task_tree_write',{markdown:added,reason:'合法新增'});assert.equal(whole.ok,true,JSON.stringify(whole));
  await fetch(url+'/api/trees',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'other',role:'reference',path:'trees/other.md'})});
  await writeFile(path.join(cwd,'trees/other.md'),main);
  const mainBefore=await readFile(path.join(cwd,'task-tree.md'),'utf8');
  const selected=await invoke('task_tree_subtree',{action:'write',path:'subtrees/other-N9-subtree.md',foldRoot:'N9',markdown:subtree,reason:'选定另一树'},'other');
  assert.equal(selected.ok,true,JSON.stringify(selected));
  assert.equal(await readFile(path.join(cwd,'task-tree.md'),'utf8'),mainBefore,'non-active tree operations must not change active main');
  assert.match(await readFile(path.join(cwd,'trees/other.md'),'utf8'),/- SubtreeFile: subtrees\/other-N9-subtree.md/);
});
