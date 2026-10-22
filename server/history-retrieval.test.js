import test from 'node:test';
import assert from 'node:assert/strict';
import { historySnapshot, createHistorySession, createHistoryIndexCache } from './history-retrieval.js';

const archive = [
  {role:'user',content:'请讨论导出格式'},
  {role:'assistant',content:'  导出 CSV 原样保留空格\n使用 UTF-8，不丢汉字。  '},
  {role:'user',content:'可以，就使用这个'},
  {role:'assistant',content:'确定导出方式'},
  {role:'user',content:'布局改成淡蓝色'},
  {role:'assistant',content:'布局说明'},
  {role:'user',content:'继续'}
];
test('restores exact episodes and acceptance, deduplicates IDs not repeated dialogue text', () => {
  const s = historySnapshot(archive,{node:'A'},archive.filter(m=>m.role==='user'));
  const read = createHistorySession(s);
  const result = read('history_search',{query:'CSV UTF-8'});
  assert.deepEqual(result.sources.map(m=>m.content),[archive[1].content,archive[3].content]);
  assert.equal(result.sourceIds.length,4);
  assert.equal(new Set(result.sourceIds).size,4);
  assert.equal(result.alreadyInInput.length,2);
  assert.equal(result.modelCalls,0);
  assert.ok(!result.sources.some(m=>m.content===archive[5].content));
  assert.equal(read('history_read',{sourceIds:[result.sourceIds[1],result.sourceIds[1]]}).sources.length,1);
  const all = read('history_read',{all:true});
  assert.deepEqual(all.sources.map(m=>m.content),archive.map(m=>m.content));
});
test('a lexical miss is uncertain with an explicit complete-scope restore, not absence',()=>{
  const read=createHistorySession(historySnapshot(archive));
  const result=read('history_search',{query:'量子猫不存在的关键词'});
  assert.equal(result.uncertain,true);assert.equal(result.sources.length,0);
  assert.equal(result.catalogue.length,archive.length);
  assert.equal(read('history_read',{all:true}).sources.length,archive.length);
});
test('scope and edits invalidate source IDs; repeated continue remains distinct',()=>{
  const a=createHistorySession(historySnapshot(archive,{project:'p',node:'A'}));
  const b=createHistorySession(historySnapshot(archive,{project:'p',node:'B'}));
  const ids=a('history_read',{all:true}).sourceIds;
  assert.throws(()=>b('history_read',{sourceIds:ids}),/UNKNOWN_HISTORY_SOURCE/);
  const changed=createHistorySession(historySnapshot([...archive.slice(0,-1),{role:'user',content:'改为 JSON'}],{project:'p',node:'A'}));
  assert.throws(()=>changed('history_read',{sourceIds:ids}),/UNKNOWN_HISTORY_SOURCE/);
  const twice=createHistorySession(historySnapshot([...archive,{role:'user',content:'继续'}]));
  assert.equal(twice('history_read',{all:true}).sources.filter(m=>m.content==='继续').length,2);
});
test('cache reuse is lazy, isolated and survives eviction in a live session',()=>{
  const cache=createHistoryIndexCache(1),snapshot=historySnapshot(archive);
  const a=createHistorySession(snapshot,cache),b=createHistorySession(snapshot,cache);
  assert.equal(a('history_search',{query:'CSV'}).indexReused,false);
  assert.equal(b('history_search',{query:'CSV'}).indexReused,true);
  createHistorySession(historySnapshot(archive,{node:'other'}),cache)('history_read',{all:true});
  assert.equal(a('history_search',{query:'CSV'}).indexMs,0);
});
test('tools, reasoning and Base64 materialized attachments never become memory sources',()=>{
  const s=historySnapshot([...archive,{role:'tool',content:'tool secret'},
    {role:'assistant',content:null,reasoning_content:'private reasoning'},
    {role:'user',content:[{type:'image_url',image_url:{url:'data:base64,abc'}}]}]);
  assert.equal(s.archive.length,archive.length);
  assert.ok(!JSON.stringify(s).includes('base64'));
});
test('dense contracts do not suffer a universal tiny top-k cutoff',()=>{
  const dense=Array.from({length:15},(_,i)=>[{role:'user',content:`约定${i}`},{role:'assistant',content:`API 错误契约${i} 必须遵守`}]).flat();
  const result=createHistorySession(historySnapshot(dense))('history_search',{query:'API 错误契约'});
  assert.equal(result.sources.length,30);
});
test('sources replaced by a handoff summary become retrievable again',()=>{
  const s=historySnapshot(archive,{},archive),read=createHistorySession(s);
  assert.equal(read('history_search',{query:'CSV'}).sources.length,0);
  assert.ok(read('history_search',{query:'CSV'},[]).sources.some(m=>m.content===archive[1].content));
});
