import { createGitWorkspaceManager } from './parallel-worktree.js';
import { startCodexTurn } from './codex-run.js';
import { assertWorkspaceTreeFiles } from './tree-write-safety.js';
import { buildCompletionReviewPrompt, parseCompletionReview, completionReviewFailure, completionReviewInterruption } from './node-completion-review.js';
import {createReviewInputWatch} from './review-input-watch.js';
import { stageCoordinationEvidence } from './execution-coordination.js';
import {executionErrorDetails} from './execution-error.js';

function assertCompleted(result, role) {
  if (result?.status === 'failed' || result?.status === 'stopped' || result?.error) {
    throw Object.assign(new Error(`${role}失败：${result?.error?.message || result?.status || '未知错误'}`, {cause:result?.error}),
      executionErrorDetails(result?.error));
  }
}

function reviewUserMessages(messages, objective) {
  const users = (messages || []).filter(message => message?.role === 'user');
  const lastUserIndex = users.length - 1;
  const target = String(objective || '').trim();
  return users.flatMap((message, index) => {
    if (typeof message.content === 'string') {
      const content = message.content.trim();
      if (!content || (target && target.includes(content))) return [];
      return [{ role: 'user', content: message.content }];
    }
    if (!Array.isArray(message.content) || index !== lastUserIndex) return [];
    const content = message.content.filter(part => part?.type === 'image_url'
      || (typeof part?.text === 'string' && part.text.trim() && !target.includes(part.text.trim())));
    return content.length ? [{ role: 'user', content }] : [];
  });
}

function compactReviewGuidance(messages) {
  const entries = (Array.isArray(messages) ? messages : [])
    .map(message => typeof message === 'string' ? message : message?.content)
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(entries)].slice(-8).map(value => value.slice(0, 500)).join('\n').slice(0, 2400);
}

export function createDirectNodeWorkspace({ projectRoot, workspace = createGitWorkspaceManager({ projectRoot }), startTurn = startCodexTurn, reviewTurn = startTurn } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  async function check(candidatePath, sourceCommit, { nodeId, objective, onPhase, onTiming, onNotification, signal, delegationReceipt, historyMessages = [], userGuidance = [], treeFile, sharedContract = '', reviewInputs = [], executionFiles = [], reviewScopeFiles }, { attempt = 0, candidateId } = {}) {
    const measure=async(operation,fn)=>{const begin=performance.now();try{return await fn();}finally{onTiming?.({role:'review-stage',operation,attempt,candidateId,durationMs:performance.now()-begin});}};
    onPhase?.('checking', '独立检查正在核对整合结果');
    const inputMaterials=workspace.materializeReviewInputs
      ?await measure('review.inputs',()=>workspace.materializeReviewInputs(candidatePath,reviewInputs)):null;
    const summary = await measure('workspace.summarize',()=>workspace.summarize(candidatePath, sourceCommit,{forReview:true,deferFiles:executionFiles}));
    onTiming?.({role:'review-scope',attempt,candidateId,changedFiles:summary.changedFiles,branchCount:delegationReceipt?.jobs?.length||0});
    const reviewHistory=reviewUserMessages(historyMessages,objective);
    const guidance = compactReviewGuidance(userGuidance);
    const manifest = await measure('review.coordination-evidence',()=>stageCoordinationEvidence(candidatePath,delegationReceipt));
    const prompt = await measure('review.prompt',async()=>buildCompletionReviewPrompt([
        '【功能验收】直接在当前候选工作区验证用户要求的行为。',
        `节点：${nodeId}`,
        `用户目标：${objective}`,
        ...(guidance ? [`用户运行中补充要求：\n${guidance}`] : []),
        ...(sharedContract ? [`共享接口约定：\n${sharedContract}`] : []),
        ...(manifest ? [manifest] : []),
        ...(inputMaterials?.fileCount ? ['登记的本地验收输入已恢复到原路径。'] : [])
      ].join('\n\n')));
      onTiming?.({role:'review-input',attempt,candidateId,promptChars:prompt.length,promptBytes:Buffer.byteLength(prompt),
        changedFiles:summary.changedFiles.length,deferredFiles:summary.deferredEvidence?.files?.length||0});
      const inputWatch = await createReviewInputWatch({projectRoot,candidatePath,
        // The full original-to-current diff can contain concurrent tasks. A
        // caller-declared complete boundary replaces that ambient diff as the
        // dependency inventory; actual checker reads always join it below.
        files:reviewScopeFiles === undefined ? summary.changedFiles : [],
        ...(reviewScopeFiles === undefined ? {} : {dependencyScope:{complete:true,files:reviewScopeFiles}}),signal});
      onTiming?.({role:'review-dependencies',attempt,candidateId,
        strategy:reviewScopeFiles === undefined ? 'conservative-project-content' : 'declared-complete-scope',
        ...(reviewScopeFiles === undefined ? {} : {reviewScopeFiles})});
      let reviewPending;
      let result;
      const reviewStarted = performance.now();
      try {
      reviewPending = reviewTurn({
        cwd: candidatePath, signal:inputWatch.signal, stopHookPolicy: 'fail',
        onNotification: message=>{void inputWatch.observe(message).catch(()=>{});onNotification?.(message);},
        // The checker must write only to its isolated candidate. The live project
        // remains the external input watched for concurrent user changes.
        environment: { TASK_TREE_PROJECT_ROOT: candidatePath, TASK_TREE_CONTEXT_NODE_ID: nodeId, TASK_TREE_QUALITY_MODE: 'advisory', ...(treeFile ? { TASK_TREE_CONTEXT_TREE_FILE: treeFile } : {}) },
        prompt,
        completionReview:true,
        ...(reviewHistory.length ? { messages: [...reviewHistory, { role: 'user', content: prompt }] } : {}),
        persistDialogue: false,
        forceNewThread: true, waitForCompletion: true
      });
      result = await measure('review.turn',()=>Promise.race([reviewPending,inputWatch.changed]));
      await inputWatch.validate();
      } catch(error) {
        onTiming?.({role:'review',attempt,candidateId,status:error.code==='REVIEW_INPUT_CHANGED'?'cancelled':'failed',
          durationMs:performance.now()-reviewStarted,timing:result?.timing||null,errorCode:error.code||''});
        if(error.code==='REVIEW_INPUT_CHANGED')error.reviewPending=Promise.resolve(reviewPending).catch(()=>{});
        throw error;
      } finally {inputWatch.close();}
      onTiming?.({ role: 'review', attempt, candidateId, timing: result.timing || null, status: result.status });
      assertCompleted(result, '独立检查');
      const review = await measure('review.parse',async()=>parseCompletionReview(result.messages?.at(-1)?.content || result.output));
      if (review.verdict === 'failed') throw completionReviewFailure(review);
      // Include repairs in the commit that accept() applies, not just the original diff.
      await measure('review.tree-assert',async()=>assertWorkspaceTreeFiles(candidatePath, (await workspace.inspectChanges(candidatePath, sourceCommit)).changedFiles));
      await measure('workspace.commitCandidateRepairs',()=>workspace.commitCandidateRepairs(candidatePath));
      return review;
  }

  async function resolve(candidatePath, files, details) {
    details.onPhase?.('merging', `正在解决 ${files.length} 个合并冲突`);
    const prompt = [
        '【独立合并处理】Git cherry-pick 已停在冲突处。请读取冲突标记，保留当前项目修改与本节点修改的意图。',
        `节点：${details.nodeId}`,
        `目标：${details.objective}`,
        `执行者报告：${details.output || '(无)'}`,
        `本轮共享接口约定：${details.sharedContract || '复用项目已有接口'}`,
        `冲突文件：${files.join(', ')}`,
        '不要默认选择 ours 或 theirs，也不要把冲突两边机械拼接。按用户目标、共享接口和实际实现判断；互补修改保留，互斥实现统一到正确方案，说明取舍。必要时读取 Git 索引的基线、当前版本和待合入版本；报告不是完成证据。',
        '请仅编辑当前工作区的冲突文件并 git add；不要提交、继续或中止 cherry-pick。完成后简短说明。'
      ].join('\n\n');
    const result = await startTurn({
      cwd: candidatePath, prompt,
      ...(details.historyMessages?.length ? { messages: [...details.historyMessages, { role: 'user', content: prompt }] } : {}),
      environment: { TASK_TREE_PROJECT_ROOT: candidatePath, TASK_TREE_QUALITY_MODE: 'advisory', ...(details.treeFile ? { TASK_TREE_CONTEXT_TREE_FILE: details.treeFile } : {}) },
      signal: details.signal,
      onNotification: details.onNotification,
      forceNewThread: true,
      waitForCompletion: true
    });
    details.onTiming?.({ role: 'resolve', timing: result.timing || null, status: result.status });
    assertCompleted(result, '独立合并');
    await workspace.continueIntegration(candidatePath);
  }

  return {
    // Children have already been applied, but have deliberately NOT been
    // reviewed. One final owner checks the entire node against the original
    // baseline, including shared interfaces and every branch's evidence.
    async reviewIntegrated(state, details) {
      if(!details.reviewInputs&&state.workerPath&&workspace.captureReviewInputs)
        details={...details,reviewInputs:[await workspace.captureReviewInputs(state.workerPath)]};
      const candidateId=`final-${state.runId}-${Date.now()}`;
      const current = await workspace.prepare(candidateId);
      const workerPath = await workspace.createWorker(candidateId, 'review', current.snapshotCommit);
      let accepted = false;
      try {
        const review = await check(workerPath, state.snapshotCommit, details);
        const repairs = await workspace.inspectChanges(workerPath, current.snapshotCommit);
        let appliedFiles = [];
        let treeChanges = [];
        if (repairs.changedFiles.length) {
          const commit = await workspace.commit(workerPath, 'final node review repairs', current.snapshotCommit);
          await workspace.integrate(current.integrationPath, commit, current.snapshotCommit);
          const receipt = await workspace.accept({ integrationPath: current.integrationPath,
            snapshotCommit: current.snapshotCommit, changedFiles: repairs.changedFiles, signal: details.signal,
          // Repairs were verified on this exact candidate. If the related
          // repair base changed, do not silently resolve it after the final
          // check and call the new, unverified repair accepted.
          resolveConflict: async (_candidatePath,files)=>{throw Object.assign(new Error(`最终修复应用时输入已变化：${files.join(', ')}`),{code:'REVIEW_REPAIR_BASE_CHANGED'});} });
          appliedFiles = receipt.appliedFiles;
          treeChanges = receipt.treeChanges || [];
        }
        accepted = true;
        return { review, appliedFiles, treeChanges, reviewInputs:details.reviewInputs||[] };
      } catch (error) {
        if(error.code==='REVIEW_REPAIR_BASE_CHANGED') {
          details.signal?.throwIfAborted();
          details.onTiming?.({role:'review-invalidated',phase:'repair-apply',baseline:current.snapshotCommit});
          details.onPhase?.('checking','最终修复的基线已变化，更新基线后重新检查并修复；不接受过期结果。');
          await workspace.removeWorker(workerPath).catch(()=>{});
          await workspace.cleanup({...current,runId:candidateId}).catch(()=>{});
          return this.reviewIntegrated(state,details);
        }
        if(error.code==='REVIEW_INPUT_CHANGED'){
          details.onTiming?.({role:'review-invalidated',file:error.file,phase:'during-review'});
          // Abandoned checker can only write its isolated candidate. The new
          // check starts now; cleanup waits for cancellation to settle.
          void error.reviewPending.finally(async()=>{
            await workspace.removeWorker(workerPath).catch(()=>{});
            await workspace.cleanup({...current,runId:candidateId}).catch(()=>{});
          });
          return this.reviewIntegrated(state,details);
        }
        const failure = completionReviewInterruption(error);
        failure.workspacePath = workerPath;
        throw failure;
      } finally {
        if (accepted) {
          await workspace.removeWorker(workerPath);
          await workspace.cleanup({ ...current, runId:candidateId });
        }
      }
    },
    async hasChanges(state) {
      return (await workspace.inspectChanges(state.workerPath, state.snapshotCommit)).changedFiles.length > 0;
    },
    async refresh(state) { return workspace.refresh(state); },
    async checkpoint(state, details) {
      // Publish a recoverable partial result, not an acceptance decision. The
      // original snapshot remains the baseline for the one whole-node check.
      return createDirectNodeWorkspace({projectRoot,workspace,startTurn,reviewTurn:null})
        .finish(state,{...details,status:'completed',keepWorkspace:true});
    },
    async prepare(runId) {
      const state = await workspace.prepare(runId,{captureInputs:true});
      try {
        const workerPath = await workspace.createWorker(runId, 'node', state.snapshotCommit);
        if(state.reviewInputs?.length&&workspace.materializeReviewInputs)
          await workspace.materializeReviewInputs(workerPath,state.reviewInputs,{register:true});
        return { ...state, runId, workerPath };
      } catch (error) {
        await workspace.cleanup({ ...state, runId });
        throw error;
      }
    },
    async finish(state, details) {
      const { runId, workerPath, integrationPath, snapshotCommit } = state;
      if (state.finalDelegationReceipt) {
        // The tool finished execution AND the single final review. No parent
        // continuation or second checker is needed merely to repeat a receipt.
        const receipt = state.finalDelegationReceipt;
        if (receipt.ok) await this.abandon(state);
        return { status: receipt.ok ? 'completed' : 'failed', changedFiles: receipt.appliedFiles,
          appliedFiles: receipt.appliedFiles, review: receipt.review,
          treeChanges: receipt.treeChanges || [],
          workspacePath: receipt.workspacePath || '' };
      }
      if (details.status !== 'completed') {
        return { status: details.status, changedFiles: [], appliedFiles: [], workspacePath: workerPath };
      }
      // Capture before a checkpoint/delegation can delete or reuse the worker.
      // The dependency channel is independent of Git and never stages inputs.
      if(!details.reviewInputs&&workspace.captureReviewInputs){
        state.reviewInputs=[await workspace.captureReviewInputs(workerPath)];
        details={...details,reviewInputs:state.reviewInputs};
      }
      let applied = false;
      let finalReview = null;
      try {
        details.signal?.throwIfAborted();
        details.onPhase?.('merging', '正在整合节点修改');
        const inspected = await workspace.inspectChanges(workerPath, snapshotCommit);
        if (!inspected.changedFiles.length) {
          // Absence of a diff proves neither goal completion nor failure (a
          // read-only request may be correct). Use the same single goal checker
          // and repair-application path as integrated work, not a success shortcut.
          const receipt = reviewTurn ? await this.reviewIntegrated(state,
            {...details,delegationReceipt:state.delegationReceipt}) : {appliedFiles:[]};
          applied = true;
          return { status: 'completed', changedFiles: receipt.appliedFiles, reviewInputs:details.reviewInputs||[], ...receipt };
        }
        const commit = await workspace.commit(workerPath, `node ${details.nodeId}`, snapshotCommit);
        await workspace.integrate(integrationPath, commit, snapshotCommit);
        details.signal?.throwIfAborted();
        const receipt = await workspace.accept({
          integrationPath, snapshotCommit, changedFiles: inspected.changedFiles,
          resolveConflict: async (candidatePath, files) => {
            try {
              await resolve(candidatePath, files, { ...details, changedFiles: inspected.changedFiles });
            } catch (error) {
              await workspace.abortIntegration(candidatePath);
              throw error;
            }
          },
          signal: details.signal,
          onInvalidated: sample => {
            details.onTiming?.({ role: 'review-invalidated', ...sample });
            details.onPhase?.('checking', `${sample.file} 在检查期间发生相关变化，正在检查新的合并候选`);
          },
          validateCandidate: reviewTurn ? async (candidatePath, liveBaseCommit, candidate) => {
            details.signal?.throwIfAborted();
            try {
              finalReview = await check(candidatePath, liveBaseCommit, { ...details, delegationReceipt: state.delegationReceipt, changedFiles: inspected.changedFiles }, candidate);
            } catch (error) {
              if (details.signal?.aborted) throw error;
              if (error.code==='REVIEW_INPUT_CHANGED') throw error;
              throw completionReviewInterruption(error);
            }
            details.signal?.throwIfAborted();
          } : undefined
        });
        applied = true;
        return { status: 'completed', changedFiles: [...new Set([...inspected.changedFiles, ...receipt.appliedFiles])], appliedFiles: receipt.appliedFiles, treeChanges: receipt.treeChanges || [], review: finalReview, reviewInputs:details.reviewInputs||[] };
      } catch (error) {
        error.workspacePath ||= workerPath;
        throw error;
      } finally {
        if (applied && !details.keepWorkspace) {
          await workspace.removeWorker(workerPath);
          await workspace.cleanup({ ...state, runId });
        }
      }
    },
    async abandon(state) {
      await workspace.removeWorker(state.workerPath);
      await workspace.cleanup(state);
    }
  };
}
