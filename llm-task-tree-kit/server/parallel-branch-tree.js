import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadTreeRegistry, saveTreeRegistry, findTree } from './tree-registry.js';
import { patchNodeFields } from './tree-node-patch.js';

const line = value => String(value || '').replace(/\r?\n/g, ' ').trim();
const section = (id, title, fields) => [
  `## ${id} - ${line(title)}`, '',
  ...Object.entries(fields).map(([key, value]) => `- ${key}: ${line(value)}`), ''
].join('\n');
const graph = id => `# GraphState\n\n- Current: ${id}\n- Next: ${id}\n- NextPlan:\n\n# Edges\n`;

export async function readParallelSource(projectRoot, { treeId, subtree, nodeId } = {}) {
  const registry = await loadTreeRegistry({ projectRoot, registryFile: path.join(projectRoot, 'task-trees.json'), create: false });
  const entry = findTree(registry, treeId);
  if (!entry) throw new Error(`找不到选中的树：${treeId}`);
  const relative = subtree || entry.path;
  const resolved = path.resolve(projectRoot, relative);
  if (!resolved.startsWith(path.resolve(projectRoot) + path.sep) || !relative.endsWith('.md')) throw new Error('任务树路径必须属于当前工程');
  return { tree: { id: entry.id, title: entry.title, path: path.relative(projectRoot, resolved).replace(/\\/g, '/') },
    markdown: await readFile(resolved, 'utf8'), nodeId: nodeId || '' };
}

// A plan is not a task tree until both the UI and isolated workers can read it.
// Do not replace an existing folded branch or change the user's global focus.
export async function materializeParallelBranches(projectRoot, run, jobs = run.jobs) {
  const prefix = `P_${run.id.replace(/-/g, '')}`;
  run.branchTree ||= { id: `parallel-${run.id}`, path: `trees/parallel-${run.id}.md`, title: `并行：${run.goal?.immediate || run.objective}` };
  run.branchTree.planPath ||= `trees/parallel-${run.id}.plan.json`;
  await mkdir(path.join(projectRoot, 'subtrees'), { recursive: true });
  await mkdir(path.join(projectRoot, 'trees'), { recursive: true });
  for (const job of jobs) {
    job.executionNodeId ||= `${prefix}_${job.taskId.replace(/\./g, '_')}_${createHash('sha256').update(job.taskId).digest('hex').slice(0, 8)}`;
    job.subtreeFile ||= `subtrees/${job.executionNodeId}.md`;
    job.taskFile ||= `subtrees/${job.executionNodeId}.task.json`;
    await writeFile(path.join(projectRoot, job.taskFile), JSON.stringify({
      sourceTree: run.sourceTree, taskId: job.taskId, sourceNodeId: job.nodeId, title: job.title,
      instruction: job.instruction, branchContext: job.branchContext, dependsOn: job.dependsOn
    }, null, 2) + '\n', 'utf8');
    const file = path.join(projectRoot, job.subtreeFile);
    try { await readFile(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(file, '# LLM Task Graph\n\n' + section(job.executionNodeId, job.title, {
        Completion: '未开始', Problem: `如何完成“${job.title}”？`,
        Approach: '按分支任务推进，必要时增加本分支的子节点。',
        Input: `来源节点 ${job.nodeId}；${run.sourceTree?.path || 'task-tree.md'}`,
        Output: '本分支实际交付物与结果证据。', Metrics: '完成指定交付物并说明仍未解决的问题。',
        Notes: `完整任务说明见 ${job.taskFile}。`,
        CurrentResult: '尚未执行，结果待工作分支完成后合入。', NextIdea: `执行 ${job.taskFile} 的完整任务，并保存结果。`, SelectedSkills: ''
      }) + graph(job.executionNodeId), 'utf8');
    }
  }
  const registryFile = path.join(projectRoot, 'task-trees.json');
  const registry = await loadTreeRegistry({ projectRoot, registryFile, create: false });
  if (!registry.trees.some(t => t.id === run.branchTree.id)) await saveTreeRegistry({ registryFile, registry: {
    ...registry, trees: [...registry.trees, { ...run.branchTree, role: 'reference', description: `来源：${run.sourceTree?.path || 'task-tree.md'}`, editable: true, flowEnabled: false }]
  } });
  let markdown = '# LLM Task Graph\n\n' + section(prefix, '本轮并行任务', {
    Completion: '进行中', Problem: `如何完成本轮目标？`,
    Input: `来源：${run.sourceTree?.path || 'task-tree.md'}；目标全文见 ${run.branchTree.planPath}。`,
    CurrentResult: `本轮 ${run.jobs.length} 个分支；完整进度见并行运行窗口。`,
    NextIdea: '进入各分支子树查看当前任务与结果。'
  });
  for (const job of run.jobs) markdown += section(job.executionNodeId, job.title, {
    Completion: job.status === 'completed' ? '已完成' : '未开始',
    Problem: `如何完成“${job.title}”？`, Folded: 'true', SubtreeFile: job.subtreeFile, SubtreeCount: '1'
  });
  markdown += graph(prefix);
  for (const [i, job] of run.jobs.entries()) markdown += `\n## EP${i} - 分支\n- Endpoints: ${prefix}, ${job.executionNodeId}\n- Label: 分支\n`;
  const byId = new Map(run.jobs.map(j => [j.taskId, j]));
  let edge = 0;
  for (const job of run.jobs) for (const dep of job.dependsOn) markdown += `\n## ED${edge++} - 前置结果\n- Endpoints: ${byId.get(dep).executionNodeId}, ${job.executionNodeId}\n- Label: 前置结果\n`;
  await writeFile(path.join(projectRoot, run.branchTree.path), markdown, 'utf8');
  await writeFile(path.join(projectRoot, run.branchTree.planPath), JSON.stringify({
    schema: 'parallel-branch-plan/v1', runId: run.id, sourceTree: run.sourceTree,
    goal: run.goal, coverage: run.coverage,
    jobs: run.jobs.map(({ taskId, nodeId, executionNodeId, title, instruction, branchContext, writeSet, dependsOn, subtreeFile, taskFile }) =>
      ({ taskId, nodeId, executionNodeId, title, instruction, branchContext, writeSet, dependsOn, subtreeFile, taskFile }))
  }, null, 2) + '\n', 'utf8');
  return run.branchTree;
}

export async function recordParallelBranchResults(projectRoot, run) {
  if (!run.branchTree) return;
  const file = path.join(projectRoot, run.branchTree.path);
  let markdown = await readFile(file, 'utf8');
  for (const job of run.jobs) markdown = patchNodeFields(markdown, job.executionNodeId, {
    Completion: job.status === 'completed' ? '已完成' : '需重做'
  }).markdown;
  markdown = patchNodeFields(markdown, `P_${run.id.replace(/-/g, '')}`, {
    Completion: run.status === 'accepted' ? '已完成' : '需重做',
    CurrentResult: `本轮已完成 ${run.jobs.filter(j => j.status === 'completed').length}/${run.jobs.length} 个分支；${run.status === 'accepted' ? '结果已自动合入原工程。' : '有分支未完成，失败原因与保留结果见并行运行窗口。'}`
  }).markdown;
  await writeFile(file, markdown, 'utf8');
}
