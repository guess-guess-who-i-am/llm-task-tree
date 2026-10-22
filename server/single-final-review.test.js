import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createParallelCodexCoordinator} from './codex-coordinator.js';
import {createPeerMailbox} from './peer-mailbox.js';
import {createDirectNodeWorkspace} from './direct-node-workspace.js';
import {createGitWorkspaceManager} from './parallel-worktree.js';

const tree='# LLM Task Graph\n## ROOT - 整体目标\n- Problem: 交付完整目标\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
test('six branches integrate before one final checker; repairs and failure retain honest receipts', {timeout:60000},async t=>{
  for(const verdict of ['pass','failed']) {
    const root=await mkdtemp(path.join(os.tmpdir(),'single-final-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await writeFile(path.join(root,'task-tree.md'),tree);
    let reviews=0,earlyApplied=false,release;
    const hold=new Promise(resolve=>release=resolve);
    t.after(()=>release());
    const coordinator=createParallelCodexCoordinator({projectRoot:root,
      startTurn:async options=>{
        const id=options.prompt.match(/^Task id: (.+)$/m)[1];
        if(id==='j5'){
          await hold;
          const mail=await options.beforeModelRequest();
          assert.ok(mail.some(message=>message.content.includes('保留用户补充的验收要求')));
        }
        await writeFile(path.join(options.cwd,`${id}.txt`),id);
        return {status:'completed',output:`实际保存${id}`,threadId:`t-${id}`};
      },reviewTurn:async options=>{
        reviews++;
        assert.match(options.prompt,/完整目标/);
        assert.match(options.prompt,/SHARED_CONTRACT/);
        assert.match(options.prompt,/保留用户补充的验收要求/);
        assert.match(options.prompt,/用户运行中补充要求/);
        assert.doesNotMatch(options.prompt,/执行者报告|peerConsultations|changedFiles|j0\.txt|j5\.txt/);
        for(let i=0;i<6;i++)assert.equal(await readFile(path.join(options.cwd,`j${i}.txt`),'utf8'),`j${i}`);
        if(verdict==='pass')await writeFile(path.join(options.cwd,'repair.txt'),'final-repair');
        return {status:'completed',output:JSON.stringify({verdict,reason:'统一任务验收',evidence:['六份真实产物'],rootCause:'测试根因：目标遗漏',caseStudy:'本案可观察缺口',solution:'补齐缺口'})};
      }});
    const run=await coordinator.start(Array.from({length:6},(_,i)=>({taskId:`j${i}`,nodeId:'ROOT',instruction:`交付j${i}`})),
      {treeId:'method',nodeId:'ROOT',incremental:true,objective:'完整目标',sharedContract:'SHARED_CONTRACT'});
    for(let i=0;i<250;i++){
      if(await readFile(path.join(root,'j0.txt'),'utf8').catch(()=>null)){earlyApplied=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(earlyApplied,true,'fast branch must apply before slow branch finishes');
    assert.equal(reviews,0,'no individual branch checker');
    const pending=await coordinator.get(run.id);
    assert.equal(pending.jobs.find(j=>j.taskId==='j0').acceptanceStatus,'pending');
    await coordinator.sendAgentMessage(run.id,{taskId:'j5',content:'保留用户补充的验收要求',clientMessageId:'final-review-guidance'});
    release();
    const result=await coordinator.wait(run.id);await coordinator.drain();
    assert.equal(reviews,1,result.error);
    assert.equal(result.status,verdict==='pass'?'accepted':'failed',result.error);
    assert.equal(result.review.verdict,verdict);
    assert.ok(result.jobs.every(job=>job.acceptanceStatus===(verdict==='pass'?'passed':'failed')));
    assert.ok(result.jobs.every(job=>!job.review));
    assert.equal(await readFile(path.join(root,'j0.txt'),'utf8'),'j0','failed final review must retain integrated work');
    if(verdict==='pass')assert.equal(await readFile(path.join(root,'repair.txt'),'utf8'),'final-repair');
    else assert.match(result.error,/目标遗漏/);
  }
});

test('restart during final checking resumes only the final review and preserves integrated artifacts',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'final-review-restart-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);
  await writeFile(path.join(root,'saved.txt'),'integrated');
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const checkpoint=await workspace.prepare('interrupted');
  await mkdir(path.join(root,'.task-tree-runs'));
  await writeFile(path.join(root,'.task-tree-runs','interrupted.json'),JSON.stringify({id:'interrupted',status:'checking',
    workspace:checkpoint,incremental:true,finalReviewOnly:true,objective:'完整目标',goal:{immediate:'完整目标',history:[]},jobs:[{taskId:'a',nodeId:'ROOT',status:'completed',acceptanceStatus:'pending'}],events:[]}));
  let requests=0,reviews=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,startTurn:async()=>{requests++;throw new Error('must not replay');},reviewTurn:async()=>{
    reviews++;return {status:'completed',output:'{"verdict":"pass","reason":"恢复验收通过"}'};
  }});
  await coordinator.get('interrupted');await coordinator.drain();
  const result=await coordinator.get('interrupted');
  assert.equal(result.status,'accepted',result.error);assert.equal(result.review.verdict,'pass');
  assert.equal(reviews,1);assert.equal(result.jobs[0].acceptanceStatus,'passed');
  assert.equal(requests,0);assert.equal(await readFile(path.join(root,'saved.txt'),'utf8'),'integrated');
});

test('peer mailbox batches, deduplicates, preserves resume and survives persisted reconstruction',async()=>{
  let saves=0;
  const run={jobs:[{taskId:'a',instruction:'实现A',status:'running'},{taskId:'b',instruction:'实现B',status:'running'}]};
  let mailbox=createPeerMailbox(run,{persist:async()=>{saves++;}});
  const args={resume:'A已读接口，下一步完成缓存，不接管B',questions:[{toTaskId:'b',key:'contract',question:'字段是什么？错误如何返回？'}]};
  const posted=await mailbox.exchange('a',args);
  await mailbox.exchange('a',args);
  assert.equal(run.peerMessages.length,1);
  const b=await mailbox.drain('b');assert.equal(b.length,1);assert.match(b[0].content,/字段是什么/);
  assert.deepEqual(await mailbox.drain('b'),[]);
  // A process restart must not lose an unanswered request or checkpoint.
  const restored=JSON.parse(JSON.stringify(run));mailbox=createPeerMailbox(restored);
  assert.equal((await mailbox.drain('b')).length,1);
  await mailbox.exchange('b',{resume:'继续B验证',answers:[{requestId:posted.receipts[0].requestId,answer:'id字段，失败返回error',evidence:'接口实现'}]});
  const a=await mailbox.drain('a');assert.match(a[0].content,/A已读接口/);assert.match(a[0].content,/id字段/);
  assert.deepEqual(await mailbox.drain('a'),[]);
  await assert.rejects(mailbox.exchange('a',{resume:'继续A',answers:[{requestId:posted.receipts[0].requestId,answer:'伪造'}]}),/无权/);
  assert.ok(saves>=3);
});

test('restart preserves dirty worker files and resumes only unfinished branch in the same context',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'worker-resume-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);
  const workspace=createGitWorkspaceManager({projectRoot:root});
  const checkpoint=await workspace.prepare('resume');
  const workerPath=await workspace.createWorker('resume','b',checkpoint.snapshotCommit,{contextKey:'resume-b',persistentContext:true});
  await writeFile(path.join(workerPath,'partial.txt'),'已完成的前半段');
  await workspace.removeWorker(workerPath,{preserveContext:true});
  await mkdir(path.join(root,'.task-tree-runs'),{recursive:true});
  await writeFile(path.join(root,'.task-tree-runs','resume.json'),JSON.stringify({id:'resume',status:'running',workspace:checkpoint,
    incremental:true,finalReviewOnly:true,objective:'完整目标',goal:{immediate:'完整目标',history:[]},events:[],jobs:[
      {taskId:'a',nodeId:'ROOT',status:'completed',acceptanceStatus:'pending',output:'已整合'},
      {taskId:'b',nodeId:'ROOT',title:'续跑B',instruction:'完成后半段',writeSet:[],status:'running',sourceCommit:checkpoint.snapshotCommit,
       workerPath,contextKey:'resume-b',contextThreadId:'same-thread',contextSource:'parallel',dependsOn:[]}
    ]}));
  let workers=0,reviews=0;
  const coordinator=createParallelCodexCoordinator({projectRoot:root,workspace,
    startTurn:async options=>{
      workers++;assert.equal(options.cwd,workerPath);assert.equal(options.threadId,'same-thread');
      assert.match(options.prompt,/^Task id: b$/m);
      assert.match(options.prompt,/^Task: 完成后半段$/m);
      assert.match(options.prompt,/复用原隔离目录和会话/);
      assert.match(options.prompt,/先核对已落盘成果/);
      assert.match(options.prompt,/不重放成功操作/);
      assert.match(options.prompt,/只继续本分支剩余工作/);
      assert.equal(await readFile(path.join(options.cwd,'partial.txt'),'utf8'),'已完成的前半段');
      await writeFile(path.join(options.cwd,'final.txt'),'后半段完成');
      return {status:'completed',threadId:'same-thread',output:'已接续完成'};
    },reviewTurn:async()=>{reviews++;return {status:'completed',output:'{"verdict":"pass","reason":"全部目标完成"}'};}
  });
  await coordinator.resume('resume');await coordinator.drain();
  const result=await coordinator.get('resume');assert.equal(result.status,'accepted',result.error);
  assert.equal(workers,1);assert.equal(reviews,1);
  assert.equal(await readFile(path.join(root,'partial.txt'),'utf8'),'已完成的前半段');
  assert.equal(await readFile(path.join(root,'final.txt'),'utf8'),'后半段完成');
});

test('a stale checker is cancelled and replaced before its old response finishes', {timeout:30000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cancel-review-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'task-tree.md'),tree);
  let calls=0,releaseOld,oldStarted;
  const old=new Promise(resolve=>releaseOld=resolve),started=new Promise(resolve=>oldStarted=resolve);
  t.after(()=>releaseOld());
  let oldSignal;
  const executor=createDirectNodeWorkspace({projectRoot:root,startTurn:async()=>({status:'completed',output:'冲突已解决'}),
    reviewTurn:async options=>{
      calls++;
      if(calls===1){oldSignal=options.signal;oldStarted();await old;}
      return {status:'completed',output:JSON.stringify({verdict:'pass',reason:'当前产物已核对',evidence:['真实产物']})};
    }});
  const state=await executor.prepare('cancel-test');
  await writeFile(path.join(state.workerPath,'result.txt'),'A');
  const finished=executor.finish(state,{nodeId:'ROOT',objective:'交付结果',status:'completed'});
  await started;
  // Same candidate result is now live, so rebuilding needs no conflict solver.
  await writeFile(path.join(root,'result.txt'),'A');
  for(let i=0;i<250&&calls<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,2,'must not wait for old reviewer completion');
  assert.equal(oldSignal.aborted,true);
  releaseOld();
  const receipt=await finished;assert.equal(receipt.review.verdict,'pass');
});
