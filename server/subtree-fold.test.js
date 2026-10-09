import test from 'node:test';
import assert from 'node:assert/strict';
import {planSubtreeFold} from './subtree-fold.js';
import {parseTreeNodeFields} from './tree-quality.js';

const node=(id,text=id)=>`## ${id} - ${text}\n- Problem: ${text}的问题\n- Notes: ${text}原有事实\n`;
const edge=(id,a,b)=>`## ${id} - 关系\n- Endpoints: ${a}, ${b}\n- Label: 原有关系\n`;
const tree=(nodes,edges,state='- Current: ROOT\n- Next: N9_1\n- NextPlan: 用户备忘')=>`# LLM Task Graph\n\n${nodes.join('\n')}\n# GraphState\n${state}\n\n# Edges\n${edges.join('\n')}`;
const sub=(nodes,edges)=>tree(nodes,edges,'- Current: N9\n- Next: N9_1').replace('# LLM Task Graph','# LLM Task Graph Subtree\n\n> Fold root: N9');
const main=()=>tree([node('ROOT'),node('N9'),node('N9_1'),node('N9_2'),node('N10')],[edge('E1','ROOT','N9'),edge('E2','N9_1','N9'),edge('E3','N9_1','N9_2'),edge('E4','ROOT','N10')]);
const ids=markdown=>parseTreeNodeFields(markdown).map(n=>n.id);

test('fold existing descendants with stable IDs instead of treating them as overlap',()=>{
  const before=main();
  const result=planSubtreeFold(before,sub([node('N9'),node('N9_1','新标准')],[edge('E2','N9','N9_1')]),{rootId:'N9'});
  assert.deepEqual(ids(result.markdown),['ROOT','N9','N10']);
  assert.deepEqual(new Set(ids(result.subtreeMarkdown)),new Set(['N9','N9_1','N9_2']));
  assert.deepEqual(result.movedNodeIds,['N9_1','N9_2']);
  assert.match(result.subtreeMarkdown,/新标准原有事实/);
  assert.match(result.subtreeMarkdown,/N9_2原有事实/);
  assert.match(result.subtreeMarkdown,/- Endpoints: N9_1, N9_2/);
  assert.doesNotMatch(result.markdown,/## E[23] -/);
  assert.match(result.markdown,/- Endpoints: ROOT, N9/);
  assert.match(result.markdown,/- Next: N9_1\n- NextPlan: 用户备忘/);
});

test('root facts omitted by the model move into subtree; main root stays intact for host stub patch',()=>{
  const result=planSubtreeFold(main(),sub(['## N9 - 身体底盘\n',node('NEW')],[edge('E5','N9','NEW')]),{rootId:'N9'});
  const root=parseTreeNodeFields(result.subtreeMarkdown).find(n=>n.id==='N9');
  assert.equal(root.fields.Problem.trim(),'N9的问题');
  assert.equal(root.fields.Notes.trim(),'N9原有事实');
  assert.equal(parseTreeNodeFields(result.markdown).find(n=>n.id==='N9').fields.Notes.trim(),'N9原有事实');
});

test('new nodes need actual connectivity to the root',()=>{
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9'),node('NEW')],[]),{rootId:'N9'}),/未连接|连通/);
});

test('external siblings are never migrated even when prompt references their ID',()=>{
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9'),node('N10')],[edge('E5','N9','N10')]),{rootId:'N9'}),/N10.*主树|主树.*N10|其它分支/);
});

test('previous subtree nodes and original edges survive an update that omits them',()=>{
  const current=tree([node('ROOT'),'## N9 - 身体索引\n- Folded: true\n- SubtreeFile: subtrees/N9-subtree.md\n- Notes:\n',node('N10')],[edge('E1','ROOT','N9'),edge('E4','ROOT','N10')]);
  const previous=sub([node('N9','底盘'),node('OLD')],[edge('Eold','N9','OLD')]);
  const result=planSubtreeFold(current,sub(['## N9 - 底盘\n',node('NEW')],[edge('Enew','N9','NEW')]),{rootId:'N9',previous});
  assert.deepEqual(result.movedNodeIds,[]);
  assert.deepEqual(new Set(ids(result.subtreeMarkdown)),new Set(['N9','OLD','NEW']));
  assert.match(result.subtreeMarkdown,/底盘原有事实/);
  assert.match(result.subtreeMarkdown,/- Endpoints: N9, OLD/);
  assert.doesNotMatch(result.subtreeMarkdown,/- Folded:|SubtreeFile:/);
});

test('cross-branch edges with moved endpoints refuse instead of silently deleting the relationship',()=>{
  const current=main()+ '\n'+edge('Ecross','N9_2','N10');
  // BFS may place N9_2 under N10 because the cross edge shortens its root
  // distance; either resulting boundary is ambiguous and must be refused.
  assert.throws(()=>planSubtreeFold(current,sub([node('N9')],[]),{rootId:'N9'}),/跨分支关系.*不能无损折叠/);
});

test('Edges are undirected binary relationships, not endpoint-order parent declarations',()=>{
  const current=tree([node('ROOT'),node('N9'),node('N9_1')],[edge('E1','N9','ROOT'),edge('E2','N9_1','N9')]);
  const result=planSubtreeFold(current,sub([node('N9')],[]),{rootId:'N9'});
  assert.deepEqual(result.movedNodeIds,['N9_1']);
});

test('missing fold root, mismatched header, duplicate IDs and invalid edges are explicit errors',()=>{
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9')],[]),{rootId:'MISSING'}),/折叠根|root/);
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9'),node('N9')],[]),{rootId:'N9'}),/重复|唯一/);
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9')],[edge('Ebad','N9','UNKNOWN')]),{rootId:'N9'}),/端点|有效/);
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9')],[]).replace('Fold root: N9','Fold root: N10'),{rootId:'N9'}),/Fold root|不一致/);
});

test('folding has no arbitrary byte-size gate and never truncates retained facts',()=>{
  const complete='完整事实'.repeat(10000);
  const current=main().replace('N9_2原有事实',complete);
  const result=planSubtreeFold(current,sub([node('N9')],[]),{rootId:'N9'});
  assert.ok(result.subtreeMarkdown.includes(complete));
});

test('new internal edge ID collisions are renamed deterministically without altering either relationship',()=>{
  const proposed=sub([node('N9'),node('NEW')],[edge('E4','N9','NEW'),edge('E4_N9','N9','NEW')]);
  const result=planSubtreeFold(main(),proposed,{rootId:'N9'});
  assert.match(result.markdown,/## E4 - 关系\n- Endpoints: ROOT, N10/);
  assert.match(result.subtreeMarkdown,/## E4_N9_2 - 关系\n- Endpoints: N9, NEW/);
  assert.match(result.subtreeMarkdown,/## E4_N9 - 关系\n- Endpoints: N9, NEW/);
  assert.deepEqual(result.renamedEdges,[{from:'E4',to:'E4_N9_2',endpoints:['N9','NEW']}]);
  assert.deepEqual(result,planSubtreeFold(main(),proposed,{rootId:'N9'}));
});

test('proposed copies of existing main external relationships stay in main even with reversed endpoints and new IDs',()=>{
  const proposed=sub([node('N9'),node('NEW')],[edge('E1_NEW','N9','ROOT'),edge('E5','N9','NEW')]);
  const result=planSubtreeFold(main(),proposed,{rootId:'N9'});
  assert.match(result.markdown,/## E1 - 关系\n- Endpoints: ROOT, N9\n- Label: 原有关系/);
  assert.doesNotMatch(result.subtreeMarkdown,/## E1_NEW -|Endpoints: N9, ROOT/);
  assert.deepEqual(result.retainedMainEdges,[{proposedId:'E1_NEW',mainId:'E1',endpoints:['ROOT','N9']}]);
  assert.deepEqual(ids(result.subtreeMarkdown),['N9','NEW','N9_1','N9_2']);
});

test('external edge labels cannot be silently replaced by an existing relationship with different meaning',()=>{
  const proposed=sub([node('N9')],[edge('E1_NEW','N9','ROOT').replace('原有关系','新的含义')]);
  assert.throws(()=>planSubtreeFold(main(),proposed,{rootId:'N9'}),/外部关系.*事实不一致/);
});

test('external edge notes cannot be dropped when endpoint pairs happen to match',()=>{
  const current=main().replace('- Endpoints: ROOT, N9\n- Label: 原有关系','- Endpoints: ROOT, N9\n- Label: 原有关系\n- Notes: 已确认的前置约束');
  const proposed=sub([node('N9')],[edge('E1_NEW','N9','ROOT')+'- Notes: 新增另一项约束\n']);
  assert.throws(()=>planSubtreeFold(current,proposed,{rootId:'N9'}),/外部关系.*事实不一致/);
});

test('omitted external edge facts leave the full main relationship untouched',()=>{
  const proposed=sub([node('N9')],[edge('E1_NEW','N9','ROOT').replace('- Label: 原有关系\n','')]);
  const result=planSubtreeFold(main(),proposed,{rootId:'N9'});
  assert.match(result.markdown,/## E1 - 关系\n- Endpoints: ROOT, N9\n- Label: 原有关系/);
  assert.deepEqual(result.retainedMainEdges,[{proposedId:'E1_NEW',mainId:'E1',endpoints:['ROOT','N9']}]);
});

test('multiple main relationships with identical endpoints match supplied facts, not map insertion order',()=>{
  const current=main()+'\n'+edge('Esecond','ROOT','N9').replace('原有关系','另一种关系');
  const proposed=sub([node('N9')],[edge('E1_NEW','N9','ROOT')]);
  const result=planSubtreeFold(current,proposed,{rootId:'N9'});
  assert.deepEqual(result.retainedMainEdges,[{proposedId:'E1_NEW',mainId:'E1',endpoints:['ROOT','N9']}]);
  assert.match(result.markdown,/## Esecond - 关系/);
});

test('unknown external relationships remain errors, and existing parents cannot be migrated',()=>{
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9')],[edge('NEW_CROSS','N9','N10')]),{rootId:'N9'}),/端点|有效/);
  assert.throws(()=>planSubtreeFold(main(),sub([node('N9'),node('ROOT')],[edge('E1','ROOT','N9')]),{rootId:'N9'}),/ROOT.*其它分支/);
});

test('internal edges with equal endpoints but different IDs and labels both survive',()=>{
  const proposed=sub([node('N9'),node('NEW')],[edge('NEW_A','N9','NEW').replace('原有关系','提供时间'),edge('NEW_B','NEW','N9').replace('原有关系','反馈精力')]);
  const result=planSubtreeFold(main(),proposed,{rootId:'N9'});
  assert.match(result.subtreeMarkdown,/## NEW_A - 关系\n- Endpoints: N9, NEW\n- Label: 提供时间/);
  assert.match(result.subtreeMarkdown,/## NEW_B - 关系\n- Endpoints: NEW, N9\n- Label: 反馈精力/);
});

test('multiline facts and dependency labels omitted by a model are retained intact',()=>{
  const current=main().replace('- Notes: N9_2原有事实','- Notes:\n  - 第一项\n  - 第二项');
  const result=planSubtreeFold(current,sub([node('N9')],[]),{rootId:'N9'});
  assert.ok(result.subtreeMarkdown.includes('- Notes:\n  - 第一项\n  - 第二项'));
  assert.match(result.subtreeMarkdown,/## E3 - 关系\n- Endpoints: N9_1, N9_2\n- Label: 原有关系/);
});

test('fold plan leaves all input strings unchanged and is deterministic',()=>{
  const current=main(), proposed=sub([node('N9')],[]), options={rootId:'N9'};
  assert.deepEqual(planSubtreeFold(current,proposed,options),planSubtreeFold(current,proposed,options));
  assert.equal(current,main());assert.equal(proposed,sub([node('N9')],[]));
});

test('folding parent retains nested-child subtree indexes rather than losing linked descendants',()=>{
  const current=main().replace('- Notes: N9_2原有事实','- Notes: N9_2原有事实\n- Folded: true\n- SubtreeFile: subtrees/N9_2-subtree.md\n- SubtreeCount: 5');
  const result=planSubtreeFold(current,sub([node('N9')],[]),{rootId:'N9'});
  const child=parseTreeNodeFields(result.subtreeMarkdown).find(n=>n.id==='N9_2');
  assert.equal(child.fields.Folded.trim(),'true');
  assert.equal(child.fields.SubtreeFile.trim(),'subtrees/N9_2-subtree.md');
  assert.equal(child.fields.SubtreeCount.trim(),'5');
});
