import { JOB_DELIVERY_PROPERTIES } from './execution-coordination.js';

export const NODE_EXECUTION_TOOL = {
  type: 'function',
  function: {
    name: 'task_tree_plan_execute',
    description: '当前节点有两个以上需分别分析、推导、实现或撰写的独立成果时，默认主动委派主要成果。共享字段、术语或风格不等于强依赖，固定公共约定再委派；仅必须消费他支尚未产生的实际结果才依赖。短标签机械替换或真实不可拆任务直接完成。已有修改保存复用；工具整合并一次最终验收，返回后本轮结束。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['reason', 'jobs'],
      properties: {
        reason: { type: 'string', minLength: 1, description: '为什么拆分能加快当前目标，哪些交付物可独立完成' },
        sharedContract: { type: 'string', description: 'Planner 一次约定各分支共享的接口、字段、错误语义及负责人；无跨分支接口可省略。原文发给所有 Worker。' },
        acceptanceCriteria: JOB_DELIVERY_PROPERTIES.acceptanceCriteria,
        jobs: { type: 'array', minItems: 2, items: {
          type: 'object', additionalProperties: false, required: ['taskId', 'title', 'instruction'],
          properties: {
            taskId: { type: 'string', minLength: 1 },
            nodeId: { type: 'string', description: '已有的本分支节点 ID；省略时使用当前节点' },
            title: { type: 'string', minLength: 1 },
            instruction: { type: 'string', minLength: 1, description: '独立交付物、输入、接口职责、边界、完成依据及回写节点；避免重复' },
            workEstimate: { type: 'string', description: '相对工作量及理由；优先约10–15分钟的独立成果，较大工作可继续拆分；这是分工软目标，不是执行期限' },
            ...JOB_DELIVERY_PROPERTIES,
            writeSet: { type: 'array', items: { type: 'string' } },
            dependsOn: { type: 'array', items: { type: 'string' } }
          }
        } }
      }
    }
  }
};

export const ADAPTIVE_NODE_INSTRUCTIONS = [
  '有两个以上分别需要分析、推导、实现或撰写的独立成果，默认主动并行。尽早发布共享接口并委派主要成果，调用 task_tree_plan_execute 同时启动；必要读取批量进行，不先单人做完大部分再拆。不另开Planner会话。宿主保存已有成果供分支复用，不重复分配。',
  '规格具体不等于工作量小，能一次写完也不等于微小：按实现和边界验证的工作量、独立交付性和耦合分成均衡、能可靠完成的任务。短标签机械替换这类微小操作、确实不可拆的任务是单人例外。不递归拆微任务，不按文件数平均。宿主立即启动就绪任务，数量不固定。',
  '覆盖本轮交付物，避免重复。共享字段、术语或风格不等于强依赖；固定公共约定再委派，仅必须消费他支尚未产生的实际结果才写 dependsOn；普通树边不是依赖。sharedContract统一接口、字段、失败语义和负责人，原文发给全部Worker。instruction写输入、成果、负责边界和回写节点。',
  '按约10–15分钟可交付成果为分工软目标，不是停止期限；大任务执行中继续拆分，优先拆最长剩余分支。同一份文档的章节分别分析、按统一提纲并行撰写，片段最终组装，不把主要工作留给单人。同产物按模块或数据均衡分片，约定ID和去重；独立搜索、读取、下载批量并发，按服务限流调整，不为凑并发制造交接。',
  'Planner明确交付合同：各任务deliverables写实际文件路径、mode（update真实变化，present允许已满足，delete删除）及树nodeIds；acceptanceCriteria写可观察的完成依据。只读论证不强造文件。协调器核对落盘、定点恢复，独立检查判质量，不以旁白当成果。',
  'one-shot（各章节分析并行，最终一份 docs/guide.md）：task_tree_plan_execute({"reason":"两章独立论证","sharedContract":"沿用既有API；片段均用##章标题；最终检查同一会话将api.md、ops.md按序组装为docs/guide.md","jobs":[{"taskId":"api","title":"接口章","instruction":"分析兼容与错误边界，写api.md"},{"taskId":"ops","title":"运维章","instruction":"分析监控与回滚，写ops.md"}]})。全部正文由Worker产出，片段不是最终交付；示例路径和约定需换为本轮实际值。',
  '分支完成后直接整合为待验收成果，不启动分支检查。所有分支结束后由一个最终检查 Agent 对照整个用户目标、共享接口及实际成果，必要修复和复验在同一会话完成，并维护父节点。该工具直接交付最终回执，父 Agent 不再续接确认；失败保留成果但不冒称成功，报告根因、案例证据与建议。',
  '树回写 one-shot：模块已实现且现有用例通过时，一次 task_tree_write(nodeId=自己的执行节点,fields={Completion:"已完成",CurrentResult:"已实现附件保存；成功与失败用例通过，证据见 docs/attachment-test.md，无本轮缺口。",NextIdea:"本轮已完成。"},reason="回写实际成果")。只报持久化 changes；不把原始命令、样例或 Evidence 子字段塞入 CurrentResult。成功回执后不因措辞修饰重写。'
].join('\n');

export const WORKER_SPLIT_TOOL = {
  ...NODE_EXECUTION_TOOL,
  function: {...NODE_EXECUTION_TOOL.function, name:'task_tree_split_work',
    description:'剩余范围有两个以上需分别分析、推导、实现或撰写的独立成果时，默认主动委派主要成果。共享字段、术语或风格不等于强依赖，固定公共约定再委派；仅必须消费他支尚未产生的实际结果才依赖。宿主保存已有成果供子分支复用并启动就绪分支，沿用共享接口，仅最终验收一次；成功后当前会话结束。',
    parameters:{...NODE_EXECUTION_TOOL.function.parameters,properties:{reason:NODE_EXECUTION_TOOL.function.parameters.properties.reason,jobs:NODE_EXECUTION_TOOL.function.parameters.properties.jobs}}}
};

export function createAdaptiveNodeExecution({ coordinator, workspace, state, nodeId, treeScope, objective, contextMessages = [], historyMessages = contextMessages, onProgress = () => {}, resumeRunId }) {
  let delegated = false;
  return async (name, args, { signal } = {}) => {
    if (name !== NODE_EXECUTION_TOOL.function.name) throw new Error(`未知执行工具：${name}`);
    if (delegated) throw new Error('本轮已提交拆分，请复用返回的实际分支结果，不重复提交。');
    signal?.throwIfAborted();
    const jobs = args.jobs.map(job => ({ ...job, nodeId: job.nodeId || nodeId, dependsOn: job.dependsOn || [], writeSet: job.writeSet || [] }));
    if (jobs.filter(job => !job.dependsOn.length).length < 2) throw new Error('该拆分没有至少两个能同时开始的任务，请合并串行小步骤后直接执行，或重新拆成独立交付物。');
    if (!resumeRunId && await workspace.hasChanges(state)) {
      onProgress({status:'preparing',reason:args.reason,phase:'checkpoint',message:'保存已有成果后拆分剩余工作'});
      const checkpoint=await workspace.checkpoint(state,{nodeId,objective,signal,treeFile:treeScope.tree.path,historyMessages,sharedContract:args.sharedContract});
      state.delegationCheckpoint={...checkpoint,appliedFiles:[...new Set([...(state.delegationCheckpoint?.appliedFiles||[]),...checkpoint.appliedFiles])],
        treeChanges:[...(state.delegationCheckpoint?.treeChanges||[]),...(checkpoint.treeChanges||[])]};
    }
    const options = {
      treeId: treeScope.tree.id, subtree: treeScope.tree.path, nodeId, objective,
      incremental: true, finalReviewOnly: true, signal, contextMessages, historyMessages, sharedContract: args.sharedContract || '', acceptanceCriteria:args.acceptanceCriteria,
      reviewBaselineCommit: state.snapshotCommit, initialReceipt: state.delegationCheckpoint,
      onProgress: progress => onProgress({ ...progress, reason: args.reason })
    };
    const run = resumeRunId ? await coordinator.resume(resumeRunId,options) : await coordinator.start(jobs,options);
    delegated = true;
    onProgress({ id: run.id, status: run.status, jobs: run.jobs, reason: args.reason });
    const result = await coordinator.wait(run.id);
    // Successful siblings stay applied even when another branch fails or is stopped.
    // Parent won't edit or continue after this operation. Refreshing two
    // worktrees merely to report already integrated results is unnecessary.
    signal?.throwIfAborted();
    const failedReview = result.jobs.find(job => job.reviewFailed);
    if (failedReview) {
      const error = new Error(failedReview.error || '分支最后检查失败，本轮停止；已合入的成功分支保留。');
      error.code = 'COMPLETION_REVIEW_FAILED';
      error.review = failedReview.review;
      error.workspacePath = failedReview.workspacePath;
      throw error;
    }
    const receipt = {
      ok: result.status === 'accepted', runId: run.id, status: result.status,
      error: result.error || '',
      review: result.review || null,
      workspacePath: result.workspacePath || '',
      sharedContract: args.sharedContract || '',
      reviewBaselineCommit: state.snapshotCommit,
      appliedFiles: result.result?.appliedFiles || [],
      treeChanges: result.result?.treeChanges || [],
      jobs: result.jobs.map(job => ({ taskId: job.taskId, nodeId: job.nodeId, title: job.title, instruction:job.instruction,
        status: job.status, output: job.output, error: job.error, changedFiles: job.changedFiles,
        appliedFiles: job.appliedFiles || [], review: job.review || null, subtreeFile: job.subtreeFile, workspacePath: job.workspacePath || '' }))
    };
    // The one final checker owns acceptance. The parent only keeps its receipt.
    state.delegationReceipt = receipt;
    state.finalDelegationReceipt = receipt;
    return { ...receipt, hostCompletion: { status: receipt.ok ? 'completed' : 'failed',
      output: receipt.ok ? `本轮 ${receipt.jobs.length} 个分支已整合，最终任务检查通过。\n${receipt.review?.reason || result.result?.summary || ''}` : `执行失败；已整合成果保留但尚未验收。\n${receipt.error}`,
      ...(receipt.ok ? {} : { error: { message:receipt.error, code:'COMPLETION_REVIEW_FAILED', review:receipt.review } }) } };
  };
}
