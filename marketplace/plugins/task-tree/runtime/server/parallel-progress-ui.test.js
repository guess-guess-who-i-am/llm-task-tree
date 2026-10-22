import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('main panel polls through final checking and preserves cleanup polling',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const context=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function parallelRunTerminal('),source.indexOf('function parallelPollDelay(')),context);
  for(const status of ['planning','queued','preparing','running','applying','checking'])assert.equal(context.parallelRunNeedsPolling({status}),true,status);
  assert.equal(context.parallelRunNeedsPolling({status:'accepted',result:{cleanup:{status:'running'}}}),true);
  for(const status of ['failed','stopped','accepted'])assert.equal(context.parallelRunNeedsPolling({status}),false);
});

test('agent panel requests progress plus only selected full detail, switches terminal branches, and retains guidance output',async()=>{
  class Element {
    constructor(){this.dataset={};this.listeners={};this.children=[];this.value='';this.open=false;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    setAttribute(){}
    showModal(){this.open=true;}
  }
  const elements=new Map(),listeners={},requests=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const full='完整正文😀'.repeat(6000);
  let status='running';
  const jobs=[{taskId:'a',status:'running',title:'甲'},{taskId:'b',status:'completed',title:'乙'}];
  const fetch=async(url,options)=>{
    requests.push(url);
    if(options?.method==='POST')return {ok:true,json:async()=>({run:{id:'run',status,jobs:jobs.map(job=>({...job,output:full}))}})};
    if(url.endsWith('?view=progress'))return {ok:true,json:async()=>({run:{id:'run',status,jobs}})};
    const taskId=url.split('/').at(-1);
    assert.ok(['a','b'].includes(taskId),`unexpected full run fetch ${url}`);
    return {ok:true,json:async()=>({job:{...jobs.find(job=>job.taskId===taskId),output:full+taskId,instruction:'完整说明'},userMessages:[],peerMessages:[]})};
  };
  const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element(),addEventListener:(name,fn)=>{listeners[name]=fn;}},
    fetch,AbortSignal,Date,crypto:{randomUUID:()=> 'message'},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(await readFile(new URL('../public/parallel-agents.js',import.meta.url),'utf8'),context);
  const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  listeners.click({target:{closest:()=>({dataset:{agentRun:'run',agentTask:'a'}})}});
  await settle();
  assert.equal(get('parallelAgentOutput').textContent,full+'a');
  assert.equal(get('parallelAgentTask').textContent,'完整说明');
  get('parallelAgentInput').value='指导';
  get('parallelAgentInput').listeners.input();
  await get('parallelAgentForm').listeners.submit({preventDefault(){}});
  await settle();
  assert.equal(get('parallelAgentOutput').textContent,full+'a');
  status='accepted';
  get('parallelAgentList').listeners.click({target:{closest:()=>({dataset:{agentSelect:'b'}})}});
  await settle();
  assert.equal(get('parallelAgentOutput').textContent,full+'b');
  assert.ok(requests.includes('/api/codex/parallel/run/jobs/a'));
  assert.ok(requests.includes('/api/codex/parallel/run/jobs/b'));
  assert.ok(requests.filter(url=>url.endsWith('/jobs/b')).length===1);
});
