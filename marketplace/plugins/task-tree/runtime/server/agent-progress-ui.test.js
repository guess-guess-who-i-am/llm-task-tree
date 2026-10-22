import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('branch cards expose strategy, compaction and communication without leaking HTML',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('function directRunParallelHtml('),source.indexOf('\nfunction directRunCompletionNotice('));
  const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const context=vm.createContext({escapeHtml:escape,attr:escape});
  vm.runInContext(fn,context);
  const html=context.directRunParallelHtml({parallel:{id:'run',coordination:{message:'<定点恢复>，其它分支继续'},jobs:[{taskId:'a',status:'running',title:'分支A',
    communication:{label:'已收到 2 条回复'},executionStrategy:{reason:'<接口待确认>'},contextActivity:{message:'本分支压缩完成'}}]}});
  assert.match(html,/已收到 2 条回复/);assert.match(html,/本分支压缩完成/);
  assert.match(html,/执行方式：&lt;接口待确认&gt;/);assert.ok(!html.includes('<接口待确认>'));
  assert.match(html,/查看进展 \/ 对话/);
  assert.match(html,/协调器：&lt;定点恢复&gt;，其它分支继续/);
  assert.equal(context.directRunParallelHtml({}), '');
});
