import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTreeSummary, readTreeSummary, treeContextHandler, buildRunOutcomeSummary } from './tree-context.js';
import { buildBranchInputContext, buildPlannerPrompt } from './codex-coordinator.js';

const main = '# LLM Task Graph\n## ROOT - 根目标\n- Problem: 正确并且快速\n## N1 - 当前分支\n- Problem: 原索引\n- CurrentResult: 旧摘要\n- SubtreeFile: subtrees/N1.md\n- SubtreeCount: 2\n## N2 - 其它分支\n- Problem: 不丢失其它目标\n- Notes: PRIVATE_DETAIL_ONLY_IN_FULL\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n## E1 - 依赖\n- Endpoints: ROOT, N1\n- Type: dependency\n- Label: 根目标分支\n';
const subtree = result => `# LLM Task Graph Subtree\n> Fold root: N1\n## N1 - 最新分支\n- Problem: 真正问题\n- CurrentResult: ${result}\n- NextIdea: 继续处理尚未完成的内容\n## N1_A - 子树后代\n- Notes: FOLDED_DESCENDANT_SECRET_DETAIL\n# GraphState\n- Current: N1\n- Next: N1_A\n# Edges\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), main);
  await writeFile(path.join(root, 'subtrees/N1.md'), subtree('最新的执行成果'));
  return root;
}

test('map includes every main node and edge without file detail or folded descendants', () => {
  const summary = buildTreeSummary(main);
  assert.deepEqual(summary.nodes.map(n => n.id), ['ROOT', 'N1', 'N2']);
  assert.deepEqual(summary.edges, [{ id: 'E1', endpoints: ['ROOT', 'N1'], label: '根目标分支', type: 'dependency' }]);
  assert.equal(summary.nodes[1].subtreeFile, 'subtrees/N1.md');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_DETAIL_ONLY_IN_FULL/);
});

test('fresh folded-root facts replace stale stubs; completion snapshot survives restart', async t => {
  const root = await fixture(t);
  const first = await readTreeSummary({ projectRoot: root, persist: true });
  assert.equal(first.nodes[1].fields.CurrentResult, '最新的执行成果');
  assert.doesNotMatch(JSON.stringify(first), /FOLDED_DESCENDANT_SECRET_DETAIL|旧摘要/);
  await writeFile(path.join(root, 'subtrees/N1.md'), subtree('第二轮已完成'));
  const final = await readTreeSummary({ projectRoot: root, persist: true });
  assert.notEqual(final.fingerprint, first.fingerprint);
  const stored = JSON.parse(await readFile(path.join(root, final.snapshotPath), 'utf8'));
  assert.equal(stored.nodes[1].fields.CurrentResult, '第二轮已完成');
  assert.equal((await readTreeSummary({ projectRoot: root })).fingerprint, final.fingerprint);
  assert.equal(await readFile(path.join(root, 'task-tree.md'), 'utf8'), main, 'derived summary must not rewrite user facts');
});

test('missing or invalid subtree is visible as a warning, not a verified summary', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'subtrees/N1.md'));
  assert.match((await readTreeSummary({ projectRoot: root })).nodes[1].summaryWarning, /ENOENT/);
  const invalid = main.replace('subtrees/N1.md', '../outside.md');
  const result = await readTreeSummary({ projectRoot: root, markdown: invalid });
  assert.match(result.nodes[1].summaryWarning, /子树路径/);
});

test('explicit full read is exact and does not automatically unfold', async t => {
  const root = await fixture(t), call = treeContextHandler(root);
  assert.equal((await call('task_tree_read')).markdown, main);
  assert.doesNotMatch(JSON.stringify(await call('task_tree_summary')), /FOLDED_DESCENDANT_SECRET_DETAIL/);
  await assert.rejects(call('unknown'), /未知上下文/);
});

test('planner and worker default to map; neither receives raw notes/history outputs', async t => {
  const root = await fixture(t), treeSummary = await readTreeSummary({ projectRoot: root });
  const history = [{ runId: 'r1', status: 'accepted', immediate: '上一轮', result: '实际完成', jobs: [{ output: 'RAW_HISTORY_OUTPUT' }] }];
  const planner = buildPlannerPrompt(main, '新目标', history, treeSummary);
  const worker = buildBranchInputContext({ nodeId: 'N1', instruction: '实现功能' }, { markdown: main, history, treeSummary });
  for (const prompt of [planner, worker]) {
    assert.match(prompt, /N2|其它分支/);
    assert.match(prompt, /最新的执行成果/);
    assert.match(prompt, /task_tree_read/);
    assert.doesNotMatch(prompt, /PRIVATE_DETAIL_ONLY_IN_FULL|RAW_HISTORY_OUTPUT|FOLDED_DESCENDANT_SECRET_DETAIL/);
  }
  const longCore = '不截断真实核心结果'.repeat(2000);
  assert.equal(buildTreeSummary(main.replace('旧摘要', longCore)).nodes[1].fields.CurrentResult, longCore);
});

test('execution summary records outcomes, not planner decomposition promises', () => {
  const summary = buildRunOutcomeSummary({ summary: '保证全部成功', goal: { immediate: '提升速度' }, jobs: [
    { taskId: 'a', nodeId: 'N1', status: 'completed', evidence: '已保存功能' },
    { taskId: 'b', nodeId: 'N2', status: 'failed', error: '网关502' }
  ] });
  assert.match(summary, /1\/2/); assert.match(summary, /已保存功能/); assert.match(summary, /网关502/);
  assert.doesNotMatch(summary, /保证全部成功/);
  const failed = buildRunOutcomeSummary({ status: 'failed', error: 'Planner 网关502', jobs: [] });
  assert.match(failed, /0\/0/);
  assert.match(failed, /Planner 网关502/);
});
