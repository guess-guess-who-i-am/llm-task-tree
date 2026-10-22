import test from 'node:test';
import assert from 'node:assert/strict';
import { patchNodeFields } from './tree-node-patch.js';
import { mergeIndependentTreeFields } from './tree-field-merge.js';

const base = `# LLM Task Graph
## ROOT - 项目
- Problem: 保留两节点
## A - A节点
- CurrentResult:
## B - B节点
- CurrentResult:
# GraphState
- Current: ROOT
- Next: ROOT
# Edges
`;
const patch = (text, nodeId, fields) => patchNodeFields(text, nodeId, fields).markdown;

test('adjacent node fields merge without model negotiation or lost updates', () => {
  const a = patch(base, 'A', { CurrentResult: 'A已完成' });
  const b = patch(base, 'B', { CurrentResult: 'B已完成' });
  const merged = mergeIndependentTreeFields(base, a, b);
  assert.equal(merged, patch(a, 'B', { CurrentResult: 'B已完成' }));
});

test('competing values and structural changes are left to a conflict agent', () => {
  const a = patch(base, 'A', { CurrentResult: 'A版本一' });
  const other = patch(base, 'A', { CurrentResult: 'A版本二' });
  assert.equal(mergeIndependentTreeFields(base, a, other), null);
  assert.equal(mergeIndependentTreeFields(base, a, `${base}\n## E1 - 新关系\n- Endpoints: ROOT, A\n`), null);
});

test('browser layout serialization and an independent node result merge without negotiation', () => {
  const browser = `# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。
## ROOT - 项目
- Position: 40,40
- Size: 520,720
- Problem: 保留两节点

## A - A节点
- Position: 596,40
- Size: 520,720
- CurrentResult:

## B - B节点
- Position: 1152,40
- Size: 520,720
- CurrentResult: B已完成

# GraphState
- Current: ROOT
- Next: ROOT
- NextPlan:

# Edges
`;
  const independent = patch(base, 'A', { CurrentResult: 'A已完成' })
    .replace('# GraphState\n', '# GraphState\n- NextPlan: \n');
  const merged = mergeIndependentTreeFields(base, browser, independent);
  assert.ok(merged, 'the independent field patch must apply onto the browser version');
  assert.match(merged, /- Position: 1152,40/);
  assert.match(merged, /- CurrentResult: A已完成/);
  assert.match(merged, /- CurrentResult: B已完成/);
  const reverse = mergeIndependentTreeFields(base, independent, browser);
  assert.ok(reverse);
  assert.match(reverse, /- Position: 1152,40/);
  assert.match(reverse, /- CurrentResult: A已完成/);
  assert.match(reverse, /- CurrentResult: B已完成/);
});

test('renderer-added empty edge metadata is harmless, but a changed endpoint remains a conflict', () => {
  const withEdge = `${base}## E1 - A\n- Endpoints: ROOT, A\n`;
  const result = patch(withEdge, 'A', { CurrentResult: 'A已完成' });
  const rendered = patch(withEdge, 'B', { CurrentResult: 'B已完成' })
    .replace('## E1 - A\n- Endpoints: ROOT, A', '## E1 - A\n\n- Endpoints: ROOT, A\n- LabelOffset:\n- Label: A\n- Notes:');
  assert.ok(mergeIndependentTreeFields(withEdge, rendered, result));
  assert.equal(mergeIndependentTreeFields(withEdge,
    rendered.replace('Endpoints: ROOT, A', 'Endpoints: ROOT, B'), result), null);
});
