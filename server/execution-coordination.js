import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseTreeNodeFields} from './tree-quality.js';

// Shared by the independent Planner and the in-turn delegation tool. Old saved
// plans without these optional fields keep working; writeSet remains advisory.
export const JOB_DELIVERY_PROPERTIES = {
  deliverables: {type:'array',description:'明确交付的文件或树节点；不是写权限限制，不列背景材料或宿主执行汇报。只读论证可省略。',items:{
    type:'object',additionalProperties:false,required:['path','mode'],properties:{
      path:{type:'string',minLength:1,description:'实际文件路径，不用通配符；树节点必须给实际所属树文件'},
      mode:{type:'string',enum:['update','present','delete'],description:'update必须有真实变化；present只要求存在，允许本来已满足；delete要求已删除'},
      nodeIds:{type:'array',items:{type:'string',minLength:1},description:'交付树节点时指定节点ID；不要写宿主生成的执行节点ID'}
    }
  }},
  acceptanceCriteria:{type:'array',items:{type:'string',minLength:1},description:'完成依据，写可观察的行为和质量要求；最后检查逐项核对，不等同文件存在'}
};

export function normalizeDeliveryContract(job) {
  if(job.deliverables!==undefined&&!Array.isArray(job.deliverables))throw new Error('deliverables 必须是数组');
  if(job.acceptanceCriteria!==undefined&&!Array.isArray(job.acceptanceCriteria))throw new Error('acceptanceCriteria 必须是数组');
  const deliverables=(job.deliverables||[]).map(item=>{
    if(!item||typeof item.path!=='string'||!item.path.trim()||!['update','present','delete'].includes(item.mode))throw new Error('交付物需要实际 path 和 update/present/delete mode');
    if(item.nodeIds!==undefined&&(!Array.isArray(item.nodeIds)||item.nodeIds.some(id=>typeof id!=='string'||!id.trim())))throw new Error('交付物 nodeIds 必须是非空字符串数组');
    return {path:item.path.trim(),mode:item.mode,...(item.nodeIds?{nodeIds:[...new Set(item.nodeIds)]}:{})};
  });
  const acceptanceCriteria=(job.acceptanceCriteria||[]).map(item=>{
    if(typeof item!=='string'||!item.trim())throw new Error('验收条件必须是非空字符串');
    return item.trim();
  });
  return {deliverables,acceptanceCriteria};
}

const digest=value=>createHash('sha256').update(value).digest('hex');
export async function snapshotDeliverables(root,deliverables=[],{projectRoot=root}={}) {
  return Promise.all(deliverables.map(async item=>{
    const declared=path.resolve(root,item.path),relative=path.relative(path.resolve(projectRoot),declared);
    const internal=path.isAbsolute(item.path)&&relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);
    const file=internal?path.resolve(root,relative):declared;
    try {
      const info=await stat(file);
      if(!info.isFile())return {path:item.path,exists:true,error:'声明的交付物不是文件，请指定实际文件'};
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(file))hash.update(chunk);
      const nodes=item.nodeIds?.length?parseTreeNodeFields(await readFile(file,'utf8')):[];
      return {path:item.path,exists:true,fingerprint:hash.digest('hex'),
        ...(item.nodeIds?.length?{nodes:Object.fromEntries(nodes.filter(node=>item.nodeIds.includes(node.id)).map(node=>[node.id,digest(JSON.stringify(node))]))}:{})};
    } catch(error) {
      if(error.code==='ENOENT')return {path:item.path,exists:false};
      throw error;
    }
  }));
}

export async function inspectDeliverables(root,job,options) {
  const current=await snapshotDeliverables(root,job.deliverables,options);
  return (job.deliverables||[]).map((item,index)=>{
    const actual=current[index],before=job.deliveryBaseline?.[index];
    let reason=actual.error||'';
    if(!reason&&item.mode==='delete') {if(actual.exists)reason='应删除的文件仍存在';}
    else if(!reason) {
      if(!actual.exists)reason='声明的交付文件不存在';
      else if(item.nodeIds?.some(id=>!actual.nodes?.[id]))reason=`交付树文件缺少节点：${item.nodeIds.filter(id=>!actual.nodes?.[id]).join('、')}`;
      else if(item.mode==='update'&&before?.exists) {
        if(item.nodeIds?.length) {
          const unchanged=item.nodeIds.filter(id=>actual.nodes?.[id]===before.nodes?.[id]);
          if(unchanged.length)reason=`指定节点没有真实变化：${unchanged.join('、')}`;
        } else if(actual.fingerprint===before.fingerprint)reason='声明需要更新的文件没有真实变化';
      }
    }
    return {...item,status:reason?'missing':'satisfied',reason,...(actual.fingerprint?{fingerprint:actual.fingerprint}:{})};
  });
}

function errorCodes(error) {
  const codes=new Set(),seen=new Set();
  for(let item=error;item&&typeof item==='object'&&!seen.has(item);item=item.cause){
    seen.add(item);for(const key of ['code','causeCode'])if(item[key])codes.add(String(item[key]));
  }
  return codes;
}

function errorHasStage(error,stage) {
  const seen=new Set();
  for(let item=error;item&&typeof item==='object'&&!seen.has(item);item=item.cause){
    seen.add(item);if(item.stage===stage)return true;
  }
  return false;
}

// No task deadline, tool-count cap or per-success model call. A specific failed
// recovery may run once automatically; repeating the same failure is a blocker,
// not evidence of progress. Users can explicitly retry after fixing the cause.
export function recoveryDecision(job,error,{aborted=false}={}) {
  const codes=errorCodes(error);
  if(aborted||codes.has('20')||codes.has('ABORT_ERR')||codes.has('COMPLETION_REVIEW_FAILED')||error.name==='AbortError')return null;
  let action;
  if(codes.has('DELIVERY_CONTRACT_UNSATISFIED'))action='complete-delivery';
  else if([...codes].some(code=>['CONTEXT_SUMMARY_NO_PROGRESS','CONTEXT_SUMMARY_IRREDUCIBLE','CONTEXT_SUMMARY_FAILED','MODEL_CONTEXT_CAPACITY','SUMMARY_RETRY_EXHAUSTED'].includes(code))
    || (errorHasStage(error,'context-summary')&&[...codes].some(code=>['MODEL_HEADERS_TIMEOUT','MODEL_IDLE_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT'].includes(code))))action='fresh-context';
  else if(job.workerCompleted&&[...codes].some(code=>['EBUSY','EAGAIN','EINTR','GIT_INDEX_LOCKED'].includes(code)))action='integrate-only';
  if(!action)return null;
  const signature=digest(JSON.stringify({action,codes:[...codes].sort(),
    ...(action==='complete-delivery'?{missing:(job.deliveryReceipt||[]).filter(item=>item.status!=='satisfied').map(item=>({path:item.path,reason:item.reason}))}:{})}));
  if(job.recoveryHistory?.some(item=>item.signature===signature))return null;
  return {action,signature,codes:[...codes],reason:String(error.message||error),at:new Date().toISOString()};
}

export function coordinationEvidence(run) {
  return {schema:'task-tree-coordination/v1',runId:run.id,projectRoot:run.projectRoot,objective:run.objective||run.goal?.immediate||'',
    sourceTree:run.sourceTree,sourceSelection:run.sourceSelection,sharedContract:run.sharedContract||'',coverage:run.coverage||[],
    acceptanceCriteria:run.acceptanceCriteria||[],userGuidance:run.userMessages||[],initialReceipt:run.initialReceipt||null,
    jobs:(run.jobs||[]).map(job=>({taskId:job.taskId,parentTaskId:job.parentTaskId||'',nodeId:job.nodeId,executionNodeId:job.executionNodeId,
      instruction:job.instruction,status:job.status,deliverables:job.deliverables||[],acceptanceCriteria:job.acceptanceCriteria||[],
      deliveryReceipt:job.deliveryReceipt||[],evidence:job.evidence||'',output:job.output||'',error:job.error||'',
      changedFiles:job.changedFiles||[],appliedFiles:job.appliedFiles||[],treeChanges:job.treeChanges||[],taskFile:job.taskFile,subtreeFile:job.subtreeFile,
      recoveryHistory:job.recoveryHistory||[]}))};
}

export async function stageCoordinationEvidence(candidatePath,receipt) {
  if(!receipt?.jobs?.length)return '';
  // Deterministic host metadata, excluded from Git delivery. Never substitute
  // self-reports for actual verification, or inline all branch conversations.
  const relative='.task-tree-runs/coordination-evidence.json';
  await mkdir(path.join(candidatePath,'.task-tree-runs'),{recursive:true});
  await writeFile(path.join(candidatePath,relative),JSON.stringify(receipt,null,2)+'\n');
  return `验收证据清单：${relative}\n先读取清单，逐项核对目标覆盖、分支交付物和完成依据，再验证真实产物；清单中的报告不是通过证据。缺漏可在当前验收会话修复并复验，不再重新猜测分工或要求用户验收。`;
}

// Direct nodes use the same recovery policy as fan-out workers. Intercept only
// execution failure, never a final review rejection. The provider has already
// saved its dialogue and closed tools before publishing onCompleted.
export function startCoordinatedNodeTurn(startTurn,options,{state,runId,onRecovery=async()=>{},resumeFromCheckpoint=false,resumeState=state}) {
  const completed=options.onCompleted;
  const fresh=async(result,recovery)=>{
      options.signal?.throwIfAborted();
      const previousThreadId=result.threadId||state.threadId||options.threadId||'';
      const checkpointPath=`.task-tree-runs/${runId}.coordination-checkpoint.json`;
      await mkdir(path.join(options.cwd,'.task-tree-runs'),{recursive:true});
      await writeFile(path.join(options.cwd,checkpointPath),JSON.stringify({schema:'node-recovery/v1',
        objective:options.prompt,previousThreadId,output:result.output||'',messages:options.dialogueContext||options.messages||[],failure:recovery},null,2)+'\n');
      state.recoveryHistory=[...(state.recoveryHistory||[]),recovery];
      await onRecovery({...recovery,checkpointPath,previousThreadId});
      const prompt=`【协调器：从检查点继续】上一会话的上下文整理没有完成。复用当前隔离工作区及任务树，只继续未完成工作；不重放已成功写入。旧会话${previousThreadId}和完整交接内容保存在${checkpointPath}，缺少决定或证据时按需读取，勿重新载入整段失败历史。\n原始任务：\n${options.prompt}`;
      return startTurn({...options,threadId:'',forkThreadId:'',forceNewThread:true,
        messages:[...(options.messages||[]).filter(message=>message.role==='user'&&message.content!==options.prompt),{role:'user',content:prompt}],
        prompt,onCompleted:finish});
  };
  const finish=async result=>{
    const recovery=result?.status==='failed'?recoveryDecision(state,result.error||{}, {aborted:options.signal?.aborted}):null;
    if(recovery?.action==='fresh-context')return fresh(result,recovery);
    return completed?.(result);
  };
  if(resumeFromCheckpoint)return fresh({threadId:resumeState.threadId,output:resumeState.output},{action:'fresh-context',signature:'explicit-checkpoint-resume',
    reason:'用户明确要求保留检查点后换新上下文续跑',codes:[],at:new Date().toISOString()});
  return startTurn({...options,onCompleted:finish});
}
