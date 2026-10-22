import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActiveUserHistory } from './active-user-history.js';

test('all user requirements survive, old narration drops, latest reply remains; archive is unchanged', () => {
  const source = [{ role:'user', content:'验收要求：中文，无损导出' }, {role:'assistant',content:'过时的过程'},
    {role:'user',content:'新增附件支持'}, {role:'assistant',content:'方案二是树加历史'}, {role:'user',content:'用方案二'}];
  const raw = JSON.stringify(source);
  const projection = projectActiveUserHistory(source);
  assert.deepEqual(projection.messages.map(m=>m.content), ['验收要求：中文，无损导出','新增附件支持','方案二是树加历史','用方案二']);
  assert.equal(JSON.stringify(source), raw);
});
test('explicit JSON updates remove only superseded keys, retaining surrounding constraints and nested values', () => {
  const messages = [{role:'user',content:'不改接口。配置完整JSON：{"port":1,"options":{"a":2},"caption":"花括号}可用"} 保留验收'},
    {role:'user',content:'最新更正：{"port":3}'}];
  const result = projectActiveUserHistory(messages).messages;
  assert.ok(!result[0].content.includes('"port":1'));
  assert.ok(result[0].content.includes('"options":{"a":2}'));
  assert.ok(result[0].content.includes('保留验收'));
  assert.deepEqual(result[1], messages[1]);
});
test('natural-language corrections, quoted JSON examples, large text and attachments are not guessed away', () => {
  const messages = [{role:'user',content:'例如 {"port":1}；原要求'+ '整段保留'.repeat(10000),attachments:[{id:'image'}]},
    {role:'user',content:'这个地方改一下，暂时不要上次那个方法'}];
  assert.deepEqual(projectActiveUserHistory(messages).messages, messages);
});
test('current tool calls, receipts, vision input and current answer keep exact protocol objects', () => {
  const messages=[{role:'system',content:'全局'}, {role:'user',content:'本轮'},
    {role:'assistant',content:null,tool_calls:[{id:'x'}]}, {role:'tool',tool_call_id:'x',content:'成功'},
    {role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,x'}}]}, {role:'assistant',content:'本轮进度'}];
  assert.deepEqual(projectActiveUserHistory(messages).messages,messages);
});
