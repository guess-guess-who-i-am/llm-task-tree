import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffStrategies, memoryProjection, evolveMemory, retrieveHandoffSources, sourceProjection, chainMemorySources } from './handoff-memory-strategies.js';
const strategy=id=>handoffStrategies.find(s=>s.id===id);
test('temporal versioning retains prior facts in storage but excludes superseded facts from execution',()=>{
  const old=JSON.stringify({facts:[{id:'old',nodeId:'N1',key:'scale',value:2,validFrom:1}]});
  const updated=evolveMemory(strategy('apex'),old,JSON.stringify({facts:[{id:'new',nodeId:'N1',key:'scale',value:7,validFrom:2,supersedes:['old']}]}));
  assert.equal(JSON.parse(updated).facts.length,2);
  assert.deepEqual(JSON.parse(memoryProjection(strategy('apex'),updated,'scale')).facts.map(f=>f.value),[7]);
});
test('note evolution creates bidirectional links without self links',()=>{
  const state=evolveMemory(strategy('amem'),'{}',JSON.stringify({notes:[{id:'a',text:'N1 shared API scale'},{id:'b',text:'N1 shared API offset'}]}));
  assert.deepEqual(JSON.parse(state).notes.map(n=>n.links),[['b'],['a']]);
});
test('raw source retrieval uses only provided archive and query; unknown IDs do not invent evidence',()=>{
  const archive=[{id:'m0',role:'user',time:0,content:'node N1 interface scale'},{id:'m1',role:'user',time:1,content:'unrelated weather'}];
  assert.deepEqual(retrieveHandoffSources(archive,{sourceIds:['missing']}),[]);
  assert.deepEqual(retrieveHandoffSources(archive,{query:'interface'}).map(m=>m.id),['m0']);
  assert.equal(JSON.parse(sourceProjection(strategy('com'),'',archive,'interface')).chain[0].content,archive[0].content);
});
test('chain evolution does not include zero-relevance notes and keeps source order',()=>{
  const archive=[{id:'a',time:0,content:'N1 scale offset interface'},{id:'b',time:1,content:'N1 scale updated interface'},{id:'c',time:2,content:'weather cloudy'}];
  const chain=chainMemorySources(archive,'N1 interface',{beta:0});
  assert.deepEqual(chain.map(m=>m.id),['a','b']);
});
test('invalid generated JSON is preserved as text rather than silently deleting prior information',()=>{
  assert.equal(evolveMemory(strategy('amem'),'{}','not JSON'),'not JSON');
});
