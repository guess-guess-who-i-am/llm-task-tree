// Choose the execution mode once. Later opportunities stay advisory and never
// interrupt implementation or impose tool-count/time limits.
export const CONTINUE_SINGLE_TOOL = {
  type:'function', function:{name:'task_tree_continue_single',
    description:'选择单人执行，说明不可拆或微小任务的原因和下一交付成果；随后恢复全部实现工具，不会停止任务，也不代表完成。',
    parameters:{type:'object',additionalProperties:false,required:['reason','nextCheckpoint'],properties:{
      reason:{type:'string',minLength:1},nextCheckpoint:{type:'string',minLength:1}
    }}}
};

export function initialExecutionDecision(splitName, initial=true) {
  return `${initial ? '【首次执行方式选择】根据用户要求和已提供节点资料，调用以下一种工具：能拆则直接用 '+splitName+' 提交真实分工；微小、不可拆或必须先定位的问题用 task_tree_continue_single 说明原因和下一成果，随后立即继续实现。这只选择一次，不是完成报告。' : '【并行机会提示，无需专门回复】'}有两个以上分别需要分析、推导、实现或撰写的独立成果，默认主动并行：尽早发布共享接口并委派主要成果，调用 ${splitName} 同时启动，不等单人做完大部分才拆。能一次写完或规格具体不等于微小；只有短标签机械替换这类微小操作、确实不可拆的任务是单人例外。共享字段、术语或风格不等于强依赖，固定公共约定再委派；仅必须消费他支尚未产生的实际结果才有依赖，同一文档可并行分章节后组装。除总体协调者外，以每个 Agent 约 10–15 分钟可交付成果为分工软目标，不是执行期限，不因超时停止；大的独立剩余部分继续拆分，不递归拆微任务。复用已完成成果，不重复分配。`;
}

export function createExecutionReassessment(tools, {now=Date.now}={}) {
  const split=tools.find(t=>['task_tree_plan_execute','task_tree_split_work'].includes(t.function.name));
  let initialPending=!!split, nextHintAt=now()+600000;
  return {
    tools:split?[CONTINUE_SINGLE_TOOL]:[],
    toolsCompleted(){ /* Kept for callers; tool counts are not a scheduling gate. */ },
    request(){
      if(!split)return null;
      if(initialPending)return {phase:'initial',exclusive:true,tools:[split,CONTINUE_SINGLE_TOOL],toolChoice:'required',message:initialExecutionDecision(split.function.name)};
      if(now()<nextHintAt)return null;
      nextHintAt=now()+600000;
      return {phase:'opportunity',exclusive:false,toolChoice:'auto',message:initialExecutionDecision(split.function.name,false)};
    },
    continueSingle(args){
      if(!split || !args.reason?.trim() || !args.nextCheckpoint?.trim())throw new Error('继续单人执行需提供真实原因和下一成果检查点');
      initialPending=false;nextHintAt=now()+600000;
      return {ok:true,mode:'single',reason:args.reason,nextCheckpoint:args.nextCheckpoint};
    }
  };
}
