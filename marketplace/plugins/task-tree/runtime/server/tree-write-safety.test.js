import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRenderableTree} from './tree-write-safety.js';

test('every node heading is validated before the node parser can ignore it',()=>{
  for(const newline of ['\n','\r\n']) {
    for(const heading of ['## DOC_S13_药品业务入口','## N1','## N1 -','## N1 -   ','##']) {
      assert.throws(()=>assertRenderableTree(['# LLM Task Graph','## ROOT - 根节点',heading,'# GraphState','# Edges'].join(newline)),/节点标题/);
    }
  }
});

test('valid ASCII IDs support Chinese titles without adding section requirements',()=>{
  assert.doesNotThrow(()=>assertRenderableTree('## N1 - 中文标题\n- Notes: 中文正文\n'));
  assert.doesNotThrow(()=>assertRenderableTree('## N1 - 中文标题\r\n# Edges\r\n## E1 - 中文边标题\r\n'));
  assert.throws(()=>assertRenderableTree('## N1_中文 - 合法标题\n'),/节点 ID/);
});
