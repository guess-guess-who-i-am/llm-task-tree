import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const roots=['..','../llm-task-tree-kit','../marketplace/plugins/task-tree/runtime'];
for(const root of roots) test(`graph section accepts namespaced edge IDs without silently dropping them: ${root}`,async()=>{
  const file=new URL(`${root}/public/app.js`,import.meta.url);
  const source=await readFile(file,'utf8');
  const context=vm.createContext({workspaceMode:'main'});
  vm.runInContext(source.slice(source.indexOf('const nodeFieldLabels ='),source.indexOf('\nlet nodes =')),context);
  for(const name of ['unique','sanitizeId','parseEndpointList','normalizeEdges','nextEdgeId','parseMarkdown']) {
    const match=source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match,`${name} exists`);vm.runInContext(match[0],context);
  }
  const markdown=`# LLM Task Graph
## DOC_ROOT - 医生流程
- Problem: 保留流程与连线
## DOC_S01 - 注册
- CurrentResult: 本阶段已建立
# GraphState
- Current: DOC_ROOT
- Next: DOC_S01
# Edges
## DOC_E1 - 开始注册
- Endpoints: DOC_ROOT, DOC_S01
- Label: 进入医生流程
## E2 - 旧式连线
- Endpoints: DOC_S01, DOC_ROOT
- Label: 返回
## RELATION-3 - 带命名空间的关系
- Endpoints: DOC_ROOT, DOC_S01
## INVALID - 引用不存在节点
- Endpoints: DOC_ROOT, ABSENT
`;
  for(const input of [markdown,markdown.replaceAll('\n','\r\n')]) {
    const parsed=context.parseMarkdown(input);
    assert.deepEqual(Array.from(parsed.nodes,n=>n.id),['DOC_ROOT','DOC_S01']);
    assert.deepEqual(Array.from(parsed.edges,e=>e.id),['DOC_E1','E2','RELATION-3']);
    assert.equal(parsed.edges[0].label,'进入医生流程');
    assert.equal(parsed.graphState.next,'DOC_S01');
  }
});
