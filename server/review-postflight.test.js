import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {createAgentRuntime} from './agent-runtime.js';
import {startDeepSeekTurn} from './deepseek-run.js';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';

const kitRoot=fileURLToPath(new URL('../',import.meta.url));
const hookRoot=existsSync(path.join(kitRoot,'.codex/hooks/stop-postflight.mjs')) ? path.join(kitRoot,'.codex/hooks') : path.join(kitRoot,'templates/codex/hooks');
const tree='# LLM Task Graph\n\n## ROOT - 交付目标\n- Problem: 如何交付？\n- CurrentResult: 产物已建立，待验证。\n\n## N1 - 执行节点\n- Problem: 如何完成实现？\n- CurrentResult: 待验证。\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'review-real-postflight-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.codex/hooks'),{recursive:true});
  await mkdir(path.join(root,'llm-task-tree'),{recursive:true});
  await writeFile(path.join(root,'llm-task-tree/task-tree.config.json'),JSON.stringify({sharedKitDir:kitRoot}));
  for(const script of ['turn-start.mjs','stop-postflight.mjs'])await copyFile(path.join(hookRoot,script),path.join(root,'.codex/hooks',script));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await writeFile(path.join(root,'task-trees.json'),JSON.stringify({activeMethod:'method',trees:[{id:'method',role:'method',path:'task-tree.md',flowEnabled:false}]}));
  await writeFile(path.join(root,'.codex/hooks.json'),JSON.stringify({hooks:Object.fromEntries([['UserPromptSubmit','turn-start.mjs'],['Stop','stop-postflight.mjs']].map(([event,script])=>[event,[{hooks:[{type:'command',command:`"${process.execPath}" .codex/hooks/${script}`}]}]]))}));
  return root;
}

for(const verdict of ['pass','failed'])test(`real Stop records ${verdict} after review repair with one model request`,async t=>{
  const root=await fixture(t),requests=[];
  const review={verdict,reason:verdict==='pass'?'修复与测试通过':'修复后断言失败',evidence:['实际断言结果'],...(verdict==='failed'?{rootCause:'接口值仍错误'}:{})};
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    // A real on-disk repair, after UserPromptSubmit recorded the baseline.
    await writeFile(path.join(root,'result.js'),'export const value=42;\n');
    await writeFile(path.join(root,'task-tree.md'),tree.replace('产物已建立，待验证。','检查有实际结果。').replace('待验证。',verdict==='pass'?'实际断言通过。':'实际断言失败。'));
    return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'submit',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify(review)}}]},finish_reason:'tool_calls'}]}),{headers:{'content-type':'application/json'}});
  });
  const result=await startDeepSeekTurn({cwd:root,prompt:'最后核对',completionReview:true,stopHookPolicy:'fail',waitForCompletion:true,
    environment:{TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),MODEL_AGENT_MAIN_BASE_URL:'https://fixture.invalid',MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture',TASK_TREE_CONTEXT_NODE_ID:'N1'},
    runtimeFactory:args=>createAgentRuntime({...args,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})})});
  assert.equal(result.status,'completed',result.error?.message);
  assert.equal(JSON.parse(result.structuredOutput).verdict,verdict,'failed verdict must remain failed for the applying consumer');
  assert.equal(requests.length,1,'no acknowledgement, retry or extra checker LLM call');
  const status=JSON.parse(await readFile(path.join(root,'.task-tree-maintenance/latest/status.json'),'utf8'));
  assert.equal(status.ok,true,JSON.stringify(status.issues));
  assert.ok(status.repairs.some(r=>r.code==='STEP_EVIDENCE_CREATED'));
  const step=JSON.parse(await readFile(path.join(root,'scripts/steps/N1/latest/step.json'),'utf8'));
  assert.deepEqual(step.substeps.at(-1).completionReview,review);
  assert.equal(step.substeps.at(-1).outputs[0].path,'result.js');
});

for(const verdict of ['pass','failed'])test(`real Stop accepts document-only correction with tree consistency and preserves ${verdict} in one request`,async t=>{
  const root=await fixture(t);let requests=0;
  const review={verdict,reason:'已修正文献获取方式',evidence:['PDF已存在且方案引用一致'],treeState:{status:'consistent',reason:'N1已记录交付物与缺口，此次勘误不改变任务进度'}};
  t.mock.method(globalThis,'fetch',async()=>{
    requests++;
    await mkdir(path.join(root,'knowledge-base'),{recursive:true});
    await writeFile(path.join(root,'knowledge-base/schema.md'),'Meehl 1954 已获取开放PDF。\n');
    return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'submit',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify(review)}}]},finish_reason:'tool_calls'}]}),{headers:{'content-type':'application/json'}});
  });
  const result=await startDeepSeekTurn({cwd:root,prompt:'最后核对',completionReview:true,stopHookPolicy:'fail',waitForCompletion:true,
    environment:{TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),MODEL_AGENT_MAIN_BASE_URL:'https://fixture.invalid',MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture',TASK_TREE_CONTEXT_NODE_ID:'N1'},
    runtimeFactory:args=>createAgentRuntime({...args,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})})});
  assert.equal(result.status,'completed',result.error?.message);
  assert.equal(JSON.parse(result.structuredOutput).verdict,verdict);
  assert.equal(requests,1,'no extra confirmation or reviewer');
  assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),tree);
  const status=JSON.parse(await readFile(path.join(root,'.task-tree-maintenance/latest/status.json'),'utf8'));
  assert.equal(status.ok,true,JSON.stringify(status.issues));
});

test('real reviewer Stop remains blocked on repeated unresolved maintenance instead of silently passing',async t=>{
  const root=await fixture(t);
  const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  try{
    const input={session_id:'repeat',turn_id:'one',execution_node_id:'N1',completion_review:{verdict:'pass',reason:'修复已验证',evidence:['断言']}};
    await runtime.hooks('UserPromptSubmit',input);
    await writeFile(path.join(root,'result.js'),'export const value=42;');
    for(const stop_hook_active of [false,true]){
      const stop=await runtime.hooks('Stop',{...input,stop_hook_active});
      assert.equal(stop.blocked,true,'second attempt must not waive tree maintenance');
      assert.equal(stop.maintenanceOnly,true);
    }
  }finally{await runtime.close();}
});

test('legacy final verdict receives real maintenance feedback and continues without rerunning verification',async t=>{
  const root=await fixture(t);let requests=0,repairs=0;
  const review={verdict:'pass',reason:'真实验证已通过',evidence:['返回42已断言']};
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    requests++;
    if(requests===1){
      await writeFile(path.join(root,'result.js'),'export const value=42;\n');
    }else{
      assert.match(JSON.parse(init.body).messages.at(-1).content,/只补齐.*维护/);
    }
    assert.ok(requests<=2,'must not add another checker or repeat artifact work');
    const args=requests===1?review:{...review,treeState:{status:'consistent',reason:'N1已有结论与实际一致，修改只纠正文档事实'}};
    return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'submit',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]}),{headers:{'content-type':'application/json'}});
  });
  const result=await startDeepSeekTurn({cwd:root,prompt:'最后核对',completionReview:true,stopHookPolicy:'fail',waitForCompletion:true,
    environment:{TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),MODEL_AGENT_MAIN_BASE_URL:'https://fixture.invalid',MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture',TASK_TREE_CONTEXT_NODE_ID:'N1'},
    runtimeFactory:args=>createAgentRuntime({...args,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})})});
  assert.equal(result.status,'completed',result.error?.message);assert.equal(requests,2);
  const status=JSON.parse(await readFile(path.join(root,'.task-tree-maintenance/latest/status.json'),'utf8'));
  assert.equal(status.ok,true,JSON.stringify(status.issues));
  assert.deepEqual(status.substantiveFiles,['result.js'],'backups must not count as new work');
  assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),tree);
});

test('real Stop retains ordinary engineering obligations without a host review verdict',async t=>{
  const root=await fixture(t);
  const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  try {
    const input={session_id:'ordinary',turn_id:'one',execution_node_id:'N1'};
    await runtime.hooks('UserPromptSubmit',input);
    await writeFile(path.join(root,'result.js'),'export const value=42;');
    const stop=await runtime.hooks('Stop',input);
    assert.equal(stop.blocked,true);
    assert.match(stop.context,/STEP_EVIDENCE_MISSING/);
  } finally {await runtime.close();}
});

test('reviewing another registered tree uses its node, not the global active tree or focus',async t=>{
  const root=await fixture(t);
  await mkdir(path.join(root,'trees'));
  const other=tree.replaceAll('N1','N9');
  await writeFile(path.join(root,'trees/work.md'),other);
  await writeFile(path.join(root,'task-trees.json'),JSON.stringify({activeMethod:'method',trees:[
    {id:'method',role:'method',path:'task-tree.md',flowEnabled:false},
    {id:'work',role:'method',path:'trees/work.md',flowEnabled:false}]}));
  const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  try {
    const input={session_id:'other',turn_id:'one',execution_node_id:'N9',execution_tree_file:'trees/work.md'};
    await runtime.hooks('UserPromptSubmit',input);
    await writeFile(path.join(root,'result.js'),'export const value=42;');
    await writeFile(path.join(root,'trees/work.md'),other.replace('产物已建立，待验证。','产物已整合。').replace('待验证。','实际返回42。'));
    const stop=await runtime.hooks('Stop',{...input,completion_review:{verdict:'pass',reason:'通过',evidence:['实际断言']}});
    assert.equal(stop.blocked,false,stop.context);
    const status=JSON.parse(await readFile(path.join(root,'.task-tree-maintenance/latest/status.json'),'utf8'));
    assert.equal(status.activeTree.id,'work');
    assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),tree);
    const step=JSON.parse(await readFile(path.join(root,'scripts/steps/N9/latest/step.json'),'utf8'));
    assert.equal(step.nodeId,'N9');
  }finally{await runtime.close();}
});

for(const updateTree of [true,false])test(`real checker repair and evidence reach live Git together (tree changed=${updateTree})`,async t=>{
  const root=await fixture(t);let requests=0,checks=0;
  t.mock.method(globalThis,'fetch',async()=>{
    requests++;
    return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'submit',type:'function',function:{name:'completion_review_submit',arguments:JSON.stringify({verdict:'pass',reason:'修复并验证返回42',evidence:['候选实际返回42'],...(!updateTree?{treeState:{status:'consistent',reason:'指定节点的目标、交付物和缺口与当前成果一致'}}:{})})}}]},finish_reason:'tool_calls'}]}),{headers:{'content-type':'application/json'}});
  });
  const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
    checks++;
    const runtime=await createAgentRuntime({cwd:options.cwd,environment:options.environment,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
    const originalHooks=runtime.hooks;
    runtime.hooks=async(event,input)=>{
      const result=await originalHooks(event,input);
      if(event==='UserPromptSubmit'){
        await writeFile(path.join(options.cwd,'result.js'),'export const value=42;\n');
        if(updateTree)await writeFile(path.join(options.cwd,'task-tree.md'),tree.replace('产物已建立，待验证。','产物已整合。').replace('待验证。','实际返回42。'));
        const module=await import(new URL('file://'+path.join(options.cwd,'result.js')));
        assert.equal(module.value,42);
      }
      return result;
    };
    return startDeepSeekTurn({...options,environment:{...options.environment,TASK_TREE_GLOBAL_ENV_FILE:path.join(root,'absent.env'),MODEL_AGENT_MAIN_BASE_URL:'https://fixture.invalid',MODEL_AGENT_MAIN_API_KEY:'fixture',MODEL_AGENT_MAIN_MODEL:'fixture'},runtimeFactory:async()=>runtime});
  }});
  const state=await executor.prepare('postflight-repair');
  await writeFile(path.join(state.workerPath,'result.js'),'export const value=0;\n');
  const receipt=await executor.finish(state,{nodeId:'N1',objective:'返回42',status:'completed',output:'待最终验收'});
  assert.equal(receipt.status,'completed');
  assert.equal(checks,1);assert.equal(requests,1);
  assert.equal(await readFile(path.join(root,'result.js'),'utf8'),'export const value=42;\n');
  const step=JSON.parse(await readFile(path.join(root,'scripts/steps/N1/latest/step.json'),'utf8'));
  assert.equal(step.substeps.at(-1).completionReview.verdict,'pass');
  assert.match(await readFile(path.join(root,'scripts/steps/N1/latest/report.zh.md'),'utf8'),/修复并验证返回42/);
  if(!updateTree)assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),tree);
});

test('six isolated final reviewers save their own receipts concurrently without cross-node pollution',async t=>{
  const roots=await Promise.all(Array.from({length:6},()=>fixture(t)));
  await Promise.all(roots.map(async(root,index)=>{
    const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome:path.join(root,'absent-home'),treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
    try {
      const input={session_id:`parallel-${index}`,turn_id:'one',execution_node_id:'N1'};
      await runtime.hooks('UserPromptSubmit',input);
      await writeFile(path.join(root,`result-${index}.js`),`export const value=${index};`);
      if(index%2===0)await writeFile(path.join(root,'task-tree.md'),tree.replace('待验证。',`实际结果${index}已验证。`));
      const review={verdict:'pass',reason:`独立节点${index}完成`,evidence:[`实际结果${index}`],...(index%2?{treeState:{status:'consistent',reason:'当前结论与缺口准确'}}:{})};
      const stop=await runtime.hooks('Stop',{...input,completion_review:review});
      assert.equal(stop.blocked,false,stop.context);
      const step=JSON.parse(await readFile(path.join(root,'scripts/steps/N1/latest/step.json'),'utf8'));
      assert.deepEqual(step.substeps.at(-1).completionReview,review);
      assert.deepEqual(step.substeps.at(-1).outputs,[{path:`result-${index}.js`}]);
    }finally{await runtime.close();}
  }));
});
