import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dialogueMarkdown } from './dialogue-actions.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function fn(name){const ds=[...source.matchAll(/^(?:async )?function (\w+)\(/gm)],i=ds.findIndex(d=>d[1]===name);assert.ok(i>=0,name);return source.slice(ds[i].index,ds[i+1]?.index??source.length);}
const ui=vm.createContext({escapeHtml:s=>String(s).replaceAll('<','&lt;'),attr:String,renderMarkdownLite:s=>String(s).replaceAll('<','&lt;')});
for(const name of ['directRunMessageParts','directRunDisclosureHtml','directRunMessageHtml','directRunLiveParts','directRunEventsHtml','directRunParallelHtml','directRunCompletionNotice','directRunTypingLabel','directRunStreamValue','directRunTranscriptHtml'])vm.runInContext(fn(name),ui);

test('legacy receipts including receipt-only replies are folded without shortening original text',()=>{
  const content='简明正式回答\n\n【实际交付回执】\n'+('N1 字段：旧值 → 新值\n'.repeat(165));
  const run={status:'completed',messages:[{role:'assistant',content}],output:'简明正式回答'};
  const html=ui.directRunTranscriptHtml(run);
  assert.match(html,/<details[^>]*class="directRunDisclosure directRunReceipt"/);
  assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
  assert.match(html,/<article[^>]*>[\s\S]*简明正式回答[\s\S]*<\/article>/);
  assert.ok(!html.match(/<article[\s\S]*?<\/article>/)?.[0].includes('N1 字段'));
  assert.equal(content.length,run.messages[0].content.length);
  const only=ui.directRunTranscriptHtml({status:'completed',messages:[{role:'assistant',content:'【实际交付回执】\n文件清单'}]});
  assert.ok(!only.includes('<article'));
});
test('streaming narration is folded, formal answer and reasoning have separate owners',()=>{
  const history=[{role:'user',content:'执行'},{role:'assistant',content:'完成\n\n【实际交付回执】\n文件完整清单',presentation:{process:'读文件\n写文件',answer:'完成'}}];
  const html=ui.directRunTranscriptHtml({status:'completed',messages:history,output:'读文件\n写文件完成',reasoning:'独立推理'});
  assert.equal((html.match(/>完成<\/div>/g)||[]).length,1,'answer not duplicated by run.output');
  assert.match(html,/directRunProcess/);assert.match(html,/directRunReasoning/);assert.match(html,/directRunReceipt/);
  const live=ui.directRunTranscriptHtml({status:'running',messages:[history[0]],output:'先检查文件。'});
  assert.match(live,/directRunProcess/);assert.ok(!live.includes('directRunMessage--assistant'));
  const exported=dialogueMarkdown({messages:history});
  assert.match(exported,/读文件\n写文件/);assert.match(exported,/文件完整清单/);
});
