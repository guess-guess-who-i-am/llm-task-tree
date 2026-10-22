import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';

const graph = result => `# LLM Task Graph\n## ROOT - 验收\n- Problem: 两个独立交付\n- CurrentResult: ${result}\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n`;
const receipt = {ok:true,status:'accepted',jobs:['a','b'].map(taskId=>({taskId,status:'completed',instruction:`交付${taskId}`,review:{verdict:'pass',reason:'真实验证通过',evidence:['独立断言通过']},appliedFiles:[`${taskId}.txt`]}))};
for (const kind of ['report','added-report-fields','empty-focus','none','code','stale','unreviewed','objective','structure','interface']) test(`final owner checks ${kind} with full tools and original requirements`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'parent-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'task-tree.md'),graph('未完成'));
 const observations=[];
 const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:async options=>{
   observations.push(options);
   return {status:'completed',output:'{"verdict":"pass","reason":"已核对"}'};
 }});
 const state=await executor.prepare('parent');
 state.delegationReceipt=structuredClone(receipt);
 state.delegationReceipt.reviewBaselineCommit=state.snapshotCommit;
 if(kind==='stale')state.delegationReceipt.reviewBaselineCommit='old';
 if(kind==='unreviewed')state.delegationReceipt.jobs[0].review=null;
 if(kind==='interface')state.delegationReceipt.sharedContract='公共接口需要联调';
 if(kind!=='none')await writeFile(path.join(state.workerPath,'task-tree.md'),kind==='objective'?graph('完成').replace('两个独立交付','新增目标'):kind==='structure'?graph('完成')+'## E1 - 新关系\n- Endpoints: ROOT, ROOT\n':graph('完成'));
 if(kind==='code')await writeFile(path.join(state.workerPath,'new.mjs'),'export default 1;');
 if(kind==='added-report-fields')await writeFile(path.join(state.workerPath,'task-tree.md'),graph('完成').replace('- CurrentResult: 完成','- Completion: 已完成\n- CurrentResult: 完成\n- NextIdea: 本轮完成'));
 if(kind==='empty-focus')await writeFile(path.join(state.workerPath,'task-tree.md'),graph('完成').replace('# GraphState\n','# GraphState\n- NextPlan: \n'));
 const timings=[];
 await executor.finish(state,{nodeId:'ROOT',objective:'两个独立交付',status:'completed',historyMessages:[{role:'user',content:'之前的有效约束：不能改变输入'},{role:'user',content:'两个独立交付'}],onTiming:s=>timings.push(s)});
 assert.equal(observations.length,1);
 assert.equal(observations[0].completionReview,true);
 assert.equal(observations[0].messages[0].content,'之前的有效约束：不能改变输入');
 assert.equal(observations[0].messages.length,2,'only the duplicate current request is omitted, not old requirements');
 assert.equal(observations[0].runtimeToolNames,undefined,`${kind} must retain full checking tools and applicable methods`);
 assert.match(observations[0].prompt,/用户目标：两个独立交付/);
 assert.doesNotMatch(observations[0].prompt,/仅核对父节点汇报/);
 assert.ok(timings.some(s=>s.role==='review-scope'));
});
