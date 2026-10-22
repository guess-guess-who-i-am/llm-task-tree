import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runReadWaves} from './read-wave.js';
const items=count=>Array.from({length:count},(_,index)=>({id:`read-${index}`,index}));
test('100 independent reads overlap by default with stable output',async()=>{
  let active=0,peak=0;const reports=[];
  const output=await runReadWaves(items(100),async item=>{peak=Math.max(peak,++active);await delay(10);active--;return {ok:true,index:item.index};},{onWave:report=>reports.push(report)});
  assert.equal(peak,100);assert.deepEqual(output.map(x=>x.index),items(100).map(x=>x.index));
  assert.equal(reports.length,1);assert.equal(reports[0].mode,'rolling');assert.equal(reports[0].width,100);assert.equal(reports[0].executions.length,100);
});
test('a freed slot starts queued work before an unrelated slow sibling finishes',async()=>{
  let releaseSlow,finishedQueue;const gate=new Promise(resolve=>releaseSlow=resolve),events=[],done=new Promise(resolve=>finishedQueue=resolve);
  const pending=runReadWaves(items(5),async item=>{
    events.push(`start:${item.index}`);if(item.index===0)await gate;else await delay(5);
    events.push(`end:${item.index}`);if(item.index===4)finishedQueue();return item.index;
  },{initialWidth:2,maxWidth:2});
  await Promise.race([done,delay(1000)]);const refilled=events.includes('end:4')&&!events.includes('end:0');releaseSlow();
  assert.deepEqual(await pending,[0,1,2,3,4]);assert.equal(refilled,true);
});
test('configured concurrency above 100 has no hard ceiling',async()=>{
  let active=0,peak=0;await runReadWaves(items(120),async()=>{peak=Math.max(peak,++active);await delay(5);active--;},{initialWidth:120,maxWidth:120});assert.equal(peak,120);
});
test('invalid widths fail at the contract boundary',async()=>{
  for(const width of [0,-1,NaN,Infinity])await assert.rejects(runReadWaves(items(1),()=>{}, {initialWidth:width}),/positive/);
});
