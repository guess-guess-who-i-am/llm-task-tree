import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDirectNodeWorkspace} from '../server/direct-node-workspace.js';
import {startDeepSeekTurn} from '../server/deepseek-run.js';
import {localNetworkEnvironment} from '../server/network-environment.js';

if(!process.argv.includes('--live'))throw Error('必须显式 --live 才调用正常配置的真实模型');
if(!process.argv.includes('--network-ready')){
  const child=spawn(process.execPath,[...process.argv.slice(1),'--network-ready'],{env:await localNetworkEnvironment(),stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exit(1);});
  child.once('exit',code=>process.exit(code??1));
  await new Promise(()=>{});
}
const source=path.resolve(import.meta.dirname,'..');
const out=path.resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6)||'docs/review-dependency-live-20261022.json');
const root=await mkdtemp(path.join(os.tmpdir(),'review-dependency-live-'));
await mkdir(path.join(root,'llm-task-tree'));
await writeFile(path.join(root,'llm-task-tree/setup-task-tree.kitpath'),source);
await writeFile(path.join(root,'AGENTS.md'),'本项目只核对机构角色的中文分析报告与给定事实，不改业务程序、不启动服务、不做联网研究。任务树已准确记录状态，无需重复写树。按本轮目标使用适用全局方法。');
await writeFile(path.join(root,'task-tree.md'),'# LLM Task Graph\n## ROOT - 机构角色说明\n- Problem: 机构审核员和研究中心管理员有何不同？\n- CurrentResult: 报告已完成并与给定事实一致，等待独立核对；不涉及业务实现。\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
await writeFile(path.join(root,'facts.txt'),'机构审核员只审核自己所属机构的申请。\n研究中心管理员负责指定研究中心的入组与随访，不因此获得机构审核权限。\n');
await writeFile(path.join(root,'other-task.txt'),'其他并发任务的初始内容。\n');
const samples=[],events=[],mutations=[],modelResults=[];let reviews=0;
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort(new Error('实验被停止，保留原始诊断')));
console.log(JSON.stringify({fixture:root,out}));
const executor=createDirectNodeWorkspace({projectRoot:root,reviewTurn:options=>{
  reviews++;
  return startDeepSeekTurn({...options,model:'gpt-6.1-sol',
    environment:{...options.environment,TASK_TREE_GLOBAL_ENV_FILE:path.join(source,'..','.env')},
    onNotification:event=>{
      options.onNotification?.(event);
      const p=event.params||{};
      if(['hook/completed','tool/completed','model/request-started','model/request-retrying'].includes(event.method)){
        events.push({at:new Date().toISOString(),method:event.method,toolName:p.toolName,event:p.event,durationMs:p.durationMs,round:p.round,model:p.model});
        console.log(JSON.stringify(events.at(-1)));
      }
      if(event.method==='tool/started'&&p.toolName==='exec_command')mutations.push(writeFile(path.join(root,'other-task.txt'),`无关任务第${mutations.length+1}次更新。\n`));
    }}).then(result=>{modelResults.push({status:result.status,output:result.output,error:result.error?.message});console.log(JSON.stringify(modelResults.at(-1)));return result;});
}});
const begin=performance.now();const state=await executor.prepare('analysis-review');
const report='机构审核员和研究中心管理员不是同一种角色。因为机构申请要由本机构的人审核，所以机构审核员只能处理本机构的申请。研究中心管理员的职责是指定研究中心的患者入组和随访，因此不能仅凭中心管理员身份审核机构申请。本报告只解释角色边界，没有修改业务实现，也不声称已实测线上权限。\n';
await writeFile(path.join(state.workerPath,'report.md'),report);
let result;
try{
  const receipt=await executor.finish(state,{nodeId:'ROOT',objective:'核对report.md是否准确解释facts.txt中的两类角色和职责边界。只交付中文分析，不修改业务代码，不要求启动服务。',
    status:'completed',signal:controller.signal,output:'分析已完成，完整说明在report.md，唯一业务事实来源facts.txt。未修改业务实现，无需再研究其他业务模块；请核对两份文件与已有节点的一致性。',
    onTiming:sample=>{samples.push(sample);if(['review-invalidated','review-dependency-receipt'].includes(sample.role))console.log(JSON.stringify(sample));if(sample.role==='review-invalidated')controller.abort(new Error('无关编辑导致检查重启，实验断言失败，不继续付费重试'));}});
  await Promise.all(mutations);
  assert.equal(receipt.review.verdict,'pass');
  assert.equal(reviews,1,'无关并发编辑不得重启整轮检查');
  assert.ok(events.some(event=>event.toolName==='exec_command'),'真实模型必须执行至少一次命令验证');
  assert.ok(mutations.length>0);
  assert.equal(await readFile(path.join(root,'report.md'),'utf8'),report);
  assert.ok(receipt.review.dependencyScope?.complete,'模型应提交实际完整依赖清单');
  result={ok:true,review:receipt.review};
}catch(error){result={ok:false,error:error.message,review:error.review};}
const record={...result,observedAt:new Date().toISOString(),model:'gpt-6.1-sol',fixture:root,wallMs:performance.now()-begin,reviews,unrelatedEdits:mutations.length,samples,events,modelResults,
  limitation:'同模型真实单次小型分析验收，保留正常全局Hook；并发无关编辑受控注入。不是原业务整轮复跑或普遍提速/成功率证明。'};
await writeFile(out,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({ok:record.ok,wallMs:record.wallMs,reviews,unrelatedEdits:record.unrelatedEdits,review:record.review,error:record.error,out}));
if(!record.ok)process.exitCode=1;
