import test from 'node:test';
import assert from 'node:assert/strict';
import{encodeRepeatedText,decodeRepeatedText,reversibleArchive}from'./reversible-handoff-text.js';
test('consecutive repeats are exactly reversible including multiplicity and Unicode',()=>{
 const text='接口必须保留完整标签 Ω。无新增实施决定。'.repeat(1)+'无新增实施决定。'.repeat(20)+'\n最后不是重复。';
 const encoded=encodeRepeatedText(text);
 assert.equal(decodeRepeatedText(encoded),text);
 assert.ok(JSON.stringify(encoded).length<text.length);
});
test('unique messages and empty texts remain exact, no semantic sentence deletion',()=>{
 for(const text of ['','label="保留完整标签 Ω"。label="只保留Ω"。','a\nb\n','最终一行无句号'])assert.equal(decodeRepeatedText(encodeRepeatedText(text)),text);
});
test('archive retains source IDs roles and order for corrections rather than resolving them by a hidden oracle',()=>{
 const archive=[{id:'m1',role:'user',time:1,content:'取2。'},{id:'m2',role:'user',time:2,content:'改为3。'}];
 const state=JSON.parse(reversibleArchive(archive));assert.deepEqual(state.messages.map(m=>m.id),['m1','m2']);
 assert.equal(decodeRepeatedText(state.messages[1]),'改为3。');
});
