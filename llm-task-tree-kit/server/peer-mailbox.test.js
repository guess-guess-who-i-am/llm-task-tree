import test from 'node:test';
import assert from 'node:assert/strict';
import {createPeerMailbox} from './peer-mailbox.js';

const fixture=()=>({status:'running',jobs:[
  {taskId:'a',status:'running',instruction:'实现A'},
  {taskId:'b',status:'running',instruction:'实现B'}
]});

test('failed durable delivery retries both questions and answers without losing resume or claiming delivery',async()=>{
  const run=fixture();let fail=false;
  const events=[];
  const mailbox=createPeerMailbox(run,{persist:async()=>{if(fail)throw new Error('disk unavailable');},onEvent:(type,detail)=>events.push({type,...detail})});
  const posted=await mailbox.exchange('a',{resume:'A已完成映射，继续缓存测试',questions:[{toTaskId:'b',question:'字段和错误约定是什么？'}]});
  fail=true;
  await assert.rejects(mailbox.drain('b'),/disk unavailable/);
  assert.equal(run.peerMessages[0].deliveredAt,undefined);
  assert.ok(!events.some(event=>event.type==='peer_delivered'));
  fail=false;
  const questions=await mailbox.drain('b');
  assert.equal(questions.length,1);assert.match(questions[0].content,/字段和错误/);
  assert.equal(run.peerMessages[0].status,'delivered');
  await mailbox.exchange('b',{resume:'B继续序列化实现',answers:[{requestId:posted.receipts[0].requestId,answer:'id，失败返回error'}]});
  fail=true;await assert.rejects(mailbox.drain('a'),/disk unavailable/);
  assert.equal(run.peerMessages[0].answerReceivedAt,undefined);
  fail=false;
  const answers=await mailbox.drain('a');
  assert.match(answers[0].content,/A已完成映射/);assert.match(answers[0].content,/失败返回error/);
  assert.deepEqual(await mailbox.drain('a'),[]);
  assert.equal(events.filter(event=>event.type==='peer_delivered').length,1);
  assert.equal(events.filter(event=>event.type==='peer_answer_received').length,1);
});

test('already-ended peer returns saved evidence honestly, never remains a queued live consultation',async()=>{
  const run=fixture();run.jobs[1].status='completed';run.jobs[1].output='B已保存：字段id';
  const mailbox=createPeerMailbox(run);
  const result=await mailbox.exchange('a',{resume:'继续A',questions:[{toTaskId:'b',question:'字段是什么？'}]});
  assert.equal(result.receipts[0].peerStatus,'completed');
  assert.equal(result.receipts[0].peerOutput,'B已保存：字段id');
  assert.equal(result.receipts[0].status,'unavailable');
  assert.equal(run.jobs[0].communication.waitingForReply,0);
  assert.match(run.jobs[0].communication.label,/无法实时回复/);
  assert.deepEqual(await mailbox.drain('b'),[]);
});

test('batch consultation is visible at request boundaries, with separate pending incoming and outgoing counts',async()=>{
  const run=fixture();const mailbox=createPeerMailbox(run);
  const posted=await mailbox.exchange('a',{resume:'继续A测试',questions:[{toTaskId:'b',key:'contract',question:'字段和异常？'}]});
  assert.equal(run.jobs[0].communication.waitingForReply,1);
  assert.equal(run.jobs[1].communication.pendingIncoming,1);
  await mailbox.drain('b');
  assert.match(run.jobs[1].communication.label,/待回复 1/);
  await mailbox.exchange('b',{resume:'继续B测试',answers:[{requestId:posted.receipts[0].requestId,answer:'id/error'}]});
  await mailbox.drain('a');
  assert.equal(run.jobs[0].communication.waitingForReply,0);
  assert.equal(run.jobs[0].communication.answersReceived,1);
  assert.equal(run.jobs[1].communication.pendingIncoming,0);
});

test('same-agent concurrent request drains cannot inject the same peer batch twice',async()=>{
  const run=fixture();let hold=false;
  const blocked=Promise.withResolvers(),started=Promise.withResolvers();
  const mailbox=createPeerMailbox(run,{persist:async()=>{if(hold){started.resolve();await blocked.promise;}}});
  await mailbox.exchange('a',{resume:'继续A',questions:[{toTaskId:'b',question:'接口？'}]});
  // Both calls run at the same request boundary; durable I/O must not duplicate delivery.
  hold=true;const first=mailbox.drain('b');await started.promise;
  const second=mailbox.drain('b');blocked.resolve();
  const results=await Promise.all([first,second]);
  assert.equal(results.flat().length,1);
});

test('a peer ending after send produces a saved-result notice instead of an indefinite reply wait',async()=>{
  const run=fixture();const mailbox=createPeerMailbox(run);
  await mailbox.exchange('a',{resume:'A继续验证',questions:[{toTaskId:'b',question:'边界约定？'}]});
  run.jobs[1].status='completed';run.jobs[1].output='边界约定保存在接口文档';
  const messages=await mailbox.drain('a');
  assert.equal(messages.length,1);assert.match(messages[0].content,/边界约定保存在接口文档/);
  assert.match(messages[0].content,/unavailable/);assert.equal(run.jobs[0].communication.waitingForReply,0);
  assert.deepEqual(await mailbox.drain('a'),[]);
});

test('delivery rollback never erases a reply saved concurrently by the other agent',async()=>{
  const run=fixture();let failNext=false;
  const held=Promise.withResolvers(),started=Promise.withResolvers();
  const mailbox=createPeerMailbox(run,{persist:async()=>{
    if(failNext){failNext=false;started.resolve();await held.promise;throw new Error('temporary write failure');}
  }});
  const result=await mailbox.exchange('a',{resume:'继续A',questions:[{toTaskId:'b',question:'接口？'}]});
  failNext=true;const failed=mailbox.drain('b');await started.promise;
  await mailbox.exchange('b',{resume:'继续B',answers:[{requestId:result.receipts[0].requestId,answer:'统一为id'}]});
  held.resolve();await assert.rejects(failed,/temporary write failure/);
  assert.equal(run.peerMessages[0].status,'answered');
  assert.equal(run.peerMessages[0].response,'统一为id');
  const answer=await mailbox.drain('a');assert.match(answer[0].content,/统一为id/);
});

test('100 independent agent mailboxes deliver in parallel, without extra inference or a global delivery lock',async()=>{
  const jobs=Array.from({length:100},(_,i)=>({taskId:String(i),status:'running',instruction:`继续${i}`}));
  const run={status:'running',jobs};let active=0,peak=0;
  const mailbox=createPeerMailbox(run,{persist:async()=>{
    active++;peak=Math.max(peak,active);await Promise.resolve();active--;
  }});
  const receipts=await Promise.all(jobs.map((job,i)=>mailbox.exchange(job.taskId,{resume:`${i}继续原任务`,
    questions:[{toTaskId:String((i+1)%100),key:'interface',question:'请确认接口，后续继续自己任务'}]})));
  peak=0;
  const deliveries=await Promise.all(jobs.map(job=>mailbox.drain(job.taskId)));
  assert.equal(deliveries.flat().length,100);assert.equal(peak,100);
  await Promise.all(jobs.map((job,i)=>mailbox.exchange(job.taskId,{resume:`${i}继续原任务`,
    answers:[{requestId:receipts[(i+99)%100].receipts[0].requestId,answer:'使用已发布接口'}]})));
  const answers=await Promise.all(jobs.map(job=>mailbox.drain(job.taskId)));
  assert.equal(answers.flat().length,100);
  assert.ok(jobs.every(job=>job.communication.waitingForReply===0&&job.communication.pendingIncoming===0&&job.communication.answersReceived===1));
});
