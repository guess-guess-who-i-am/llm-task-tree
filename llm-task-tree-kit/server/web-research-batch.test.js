import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalWebUrl,searchQuality,searchWebBatch,createSearchMemo} from './web-research-batch.js';
test('URL dedup strips tracking, not meaningful query identity',()=>{
 assert.equal(canonicalWebUrl('https://example.org/p?utm_source=x&id=2#x'),'https://example.org/p?id=2');
 assert.notEqual(canonicalWebUrl('https://example.org/p?id=2'),canonicalWebUrl('https://example.org/p?id=3'));
 assert.equal(canonicalWebUrl('file:///secret'),null);
});
test('site mismatch is rejected with original evidence; lexical mismatch is not semantic proof',()=>{
 const q=searchQuality('site:aclanthology.org parallel retrieval',[{url:'https://baidu.com',title:'2025'},{url:'https://aclanthology.org/x',title:'LLMCompiler',content:'none'}]);
 assert.equal(q.results.length,1);assert.equal(q.rejected[0].reason,'site_constraint_mismatch');
 assert.ok(q.warnings.some(x=>x.code==='no_query_token_evidence'));assert.equal(q.relevanceVerified,false);
});
test('batch starts independent directions before awaiting, coalesces repeats, dedups with complete provenance',async()=>{
 const started=[];let release;const gate=new Promise(r=>release=r);
 const pending=searchWebBatch({queries:['a','b',{query:'a',direction:'repeat'}]},async({query})=>{started.push(query);await gate;return {results:[{url:'https://example.org/doc?utm_source='+query,title:query,content:'全文摘要'}]};});
 await new Promise(r=>setImmediate(r));assert.deepEqual(started,['a','b']);release();const result=await pending;
 assert.equal(result.results.length,1);assert.equal(result.results[0].matches.length,3);
 assert.equal(result.results[0].rankScore,2/61);assert.equal(result.fullDocumentsFetched,0);
});
test('failure is recorded per direction and never erases successful candidates',async()=>{
 const result=await searchWebBatch({queries:['ok','fail']},async({query})=>{if(query==='fail')throw new Error('502');return {results:[{url:'https://example.org'}]};});
 assert.equal(result.counts.successfulQueries,1);assert.equal(result.results.length,1);assert.equal(result.queries[1].error,'502');
});
test('memo coalesces inflight, expires, refreshes, isolates identities and retries empty/error results',async()=>{
 let clock=0,calls=0;const memo=createSearchMemo({ttlMs:10,now:()=>clock});
 const search=async()=>{calls++;return {results:[{url:'https://example.org'}]};};
 await Promise.all([memo('a',search),memo('a',search)]);assert.equal(calls,1);
 assert.equal((await memo('a',search)).cache.hit,true);
 await memo('b',search);clock=11;await memo('a',search);await memo('a',search,{refresh:true});assert.equal(calls,4);
 let empty=0;await memo('empty',async()=>{empty++;return {results:[]};});await memo('empty',async()=>{empty++;return {results:[]};});assert.equal(empty,2);
 await assert.rejects(memo('bad',async()=>{throw new Error('502');}),/502/);assert.equal((await memo('bad',search)).cache.hit,false);
});
test('manual abort stops launching queued requests and is not disguised as partial success',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(searchWebBatch({queries:['a']},async()=>({}),{signal:c.signal}),/abort/i);
});
test('a healthy engine cannot hide wholly query-drifted Bing candidates',()=>{
 const result=searchQuality('LLMCompiler ICML parallel function',[{engine:'duckduckgo',url:'https://icml.cc/paper',title:'LLMCompiler parallel'},{engine:'bing',url:'https://dashi.163.com/',title:'邮箱大师'}]);
 assert.equal(result.results.length,1);assert.equal(result.rejected[0].reason,'engine_query_drift');
 assert.ok(result.warnings.some(x=>x.code==='engine_query_drift'));
});
test('HTTP success with zero results is empty, not a successfully covered direction',async()=>{
 const result=await searchWebBatch({queries:['empty']},async()=>({results:[]}));
 assert.equal(result.queries[0].status,'empty');assert.equal(result.counts.successfulQueries,0);
 assert.equal(result.counts.nonemptyQueries,0);assert.equal(result.timing.firstResultMs,null);
});
test('broad first pass defaults to ten per direction; explicit deeper search is preserved',async()=>{
 const calls=[];
 const search=async args=>{calls.push(args);return {results:[{url:'https://example.org/'+args.query,title:args.query}]};};
 await searchWebBatch({queries:['first','second']},search);
 assert.deepEqual(calls.map(x=>x.topK),[10,10]);
 await searchWebBatch({queries:['deeper'],topK:15},search);
 assert.equal(calls.at(-1).topK,15);
});
