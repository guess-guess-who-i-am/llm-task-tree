import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';

const graph=(nodes,edges)=>`# LLM Task Graph\n${nodes.map(id=>`## ${id} - ${id}\n- Problem: 阶段目标\n`).join('')}# GraphState\n- Current: DOC_ROOT\n- Next: DOC_S02\n# Edges\n${edges.map(([a,b],i)=>`## E${i} - 顺序\n- Endpoints: ${a}, ${b}\n- Label: 下一阶段\n`).join('')}`;
test('HTTP and MCP attach keep sequential stages visible and reject main-node theft before persistence',{timeout:60000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'subtree-attach-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stages=['DOC_ROOT',...Array.from({length:16},(_,i)=>`DOC_S${String(i+1).padStart(2,'0')}`)];
  const current=graph(stages,stages.slice(1).map((id,i)=>[stages[i],id])).replace('## DOC_S16 - DOC_S16\n','## DOC_S16 - DOC_S16\n- SubtreeFile: subtrees/reserved.md\n');
  await writeFile(path.join(root,'task-tree.md'),current);
  await mkdir(path.join(root,'subtrees'));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,TASK_TREE_PROJECT_ROOT:root,PORT:'0',TASK_TREE_NO_OPEN:'1'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;});
  let log='';
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log)),15000);child.stdout.on('data',chunk=>{log+=chunk;const url=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];if(url){clearTimeout(timer);resolve(url);}});child.stderr.on('data',chunk=>log+=chunk);child.once('error',reject);});
  const bridge=await createTaskTreeAgentTools({cwd:root,environment:{TASK_TREE_CONTEXT_TREE_FILE:'task-tree.md',TASK_TREE_QUALITY_MODE:'advisory'}});
  t.after(()=>bridge.close());
  const definition=bridge.tools.find(t=>t.function.name==='task_tree_subtree');
  assert.deepEqual(definition.function.parameters.properties.mode.enum,['attach','fold']);
  for(const [index,transport] of ['http','mcp'].entries()){
    const rootId=stages[index+1],newId=`NEW_${index}`;
    const args={action:'write',mode:'attach',path:`subtrees/${rootId}.md`,foldRoot:rootId,markdown:graph([rootId,newId],[[rootId,newId]]),reason:'验证阶段子树接入'};
    const invoke=async input=>transport==='http'?await(await fetch(base+'/api/subtree-file/fold',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).json():await bridge.call('task_tree_subtree',input);
    for(const [name,previous,mode,pattern] of [
      ['different-header',`> Fold root: DOC_S16\n${graph([rootId,'OLD'],[[rootId,'OLD']])}`,'attach',/其它折叠根|不一致/],
      ['missing-root',graph(['OTHER'],[]),'attach',/缺少折叠根/],
      ['main-collision',graph([rootId,'DOC_S15'],[[rootId,'DOC_S15']]),'attach',/其它分支/],
      ['reserved',graph([rootId,'OLD'],[[rootId,'OLD']]),'attach',/其它.*根|其它.*节点|已.*使用/],
      ['legacy-fold',graph([rootId,'OLD'],[[rootId,'OLD']]),'fold',/其它折叠根/],
      ['legacy-default',graph([rootId,'OLD'],[[rootId,'OLD']]),undefined,/其它折叠根/],
    ]) {
      const target=`subtrees/${name==='reserved'?name:`${transport}-${name}`}.md`;
      await writeFile(path.join(root,target),previous);
      const before=await readFile(path.join(root,'task-tree.md'),'utf8');
      let failure;
      try {const result=await invoke({...args,path:target,mode});failure=result.error;}catch(error){failure=error.message;}
      assert.match(failure || '',pattern,`${transport}: ${name}`);
      assert.equal(await readFile(path.join(root,target),'utf8'),previous);
      assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),before);
    }
    await writeFile(path.join(root,args.path),graph([rootId,`OLD_${index}`],[[rootId,`OLD_${index}`]]).replace('## E0 -',`## E_OLD_${index} -`));
    const result=transport==='http'?await(await fetch(base+'/api/subtree-file/fold',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)})).json():await bridge.call('task_tree_subtree',args);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(result.movedNodeIds,[]);
    assert.match(await readFile(path.join(root,args.path),'utf8'),new RegExp(`## OLD_${index} -`));
    assert.match(await readFile(path.join(root,args.path),'utf8'),new RegExp(`> Fold root: ${rootId}`));
    const saved=await readFile(path.join(root,'task-tree.md'),'utf8');
    for(const id of stages)assert.ok(saved.includes(`## ${id} -`),id);
    assert.equal(saved.slice(saved.indexOf('# Edges')),current.slice(current.indexOf('# Edges')));
    assert.match(saved,/- Current: DOC_ROOT\n- Next: DOC_S02\n/);
    assert.ok(!(await readFile(path.join(root,args.path),'utf8')).includes(`## ${stages[3]} -`));
  }
  const before=await readFile(path.join(root,'task-tree.md'),'utf8');
  const response=await fetch(base+'/api/subtree-file/fold',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'attach',path:'subtrees/stolen.md',foldRoot:'DOC_S03',markdown:graph(['DOC_S03','DOC_S04'],[['DOC_S03','DOC_S04']]),reason:'非法主干迁移'})});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/其它分支/);
  assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),before);
  const invalid=await fetch(base+'/api/subtree-file/fold',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'typo',path:'subtrees/invalid.md',foldRoot:'DOC_S03',markdown:graph(['DOC_S03','NEW_BAD'],[['DOC_S03','NEW_BAD']]),reason:'验证模式错误'})});
  assert.equal(invalid.status,400);
  assert.match((await invalid.json()).error,/mode/);
  assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),before);
  const updated=await bridge.call('task_tree_subtree',{mode:'attach',action:'write',path:'subtrees/DOC_S01.md',foldRoot:'DOC_S01',markdown:graph(['DOC_S01','NEW_UPDATE'],[['DOC_S01','NEW_UPDATE']]),reason:'验证更新保留旧子树'});
  assert.equal(updated.ok,true);
  assert.deepEqual(updated.movedNodeIds,[]);
  const subtree=await readFile(path.join(root,'subtrees/DOC_S01.md'),'utf8');
  assert.match(subtree,/## NEW_0 -/);
  assert.match(subtree,/## NEW_UPDATE -/);
  const saved=await readFile(path.join(root,'task-tree.md'),'utf8');
  for(const id of stages)assert.ok(saved.includes(`## ${id} -`));
  assert.equal(saved.slice(saved.indexOf('# Edges')),current.slice(current.indexOf('# Edges')));
});
