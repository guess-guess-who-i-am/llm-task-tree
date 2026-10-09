import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseTreeNodeFields } from './tree-quality.js';
import { parseFlowMarkdown } from './flow-script.js';

// This is a field projection, not a substring/token truncation. Details remain
// in the authoritative files and can be read explicitly by either agent role.
const coreFields = ['Completion', 'Problem', 'CurrentResult', 'NextIdea'];
const anchorFields = [...coreFields, 'Approach', 'Metrics'];
const pick = (fields, keys) => Object.fromEntries(keys.filter(k => String(fields?.[k] || '').trim())
  .map(k => [k, String(fields[k]).trim()]));
const digest = value => createHash('sha256').update(value).digest('hex');
const saves = new Map();

function mapEdges(markdown) {
  const edges = []; let current = null, inEdges = false;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^# Edges\s*$/.test(line)) { inEdges = true; continue; }
    if (!inEdges) continue;
    const title = line.match(/^##\s+(\S+)\s+-\s+(.*)$/);
    if (title) { current = { id: title[1], endpoints: [], label: title[2] }; edges.push(current); continue; }
    const field = line.match(/^-\s+(Endpoints|Label|Type):\s*(.*)$/);
    if (!current || !field) continue;
    if (field[1] === 'Endpoints') current.endpoints = field[2].split(',').map(s => s.trim()).filter(Boolean);
    else current[field[1].toLowerCase()] = field[2].trim();
  }
  return edges;
}

export function buildTreeSummary(markdown, { tree = { id: 'method', path: 'task-tree.md' }, foldedRoots = new Map() } = {}) {
  const parsed = parseFlowMarkdown(markdown);
  const anchors = new Set(['ROOT', parsed.graphState.current, parsed.graphState.next]);
  const nodes = parseTreeNodeFields(markdown).map(node => {
    const subtreeFile = String(node.fields.SubtreeFile || '').trim();
    const actual = foldedRoots.get(subtreeFile);
    return {
      id: node.id, title: actual?.root?.title || node.title,
      fields: pick(actual?.root?.fields || node.fields, anchors.has(node.id) ? anchorFields : coreFields),
      ...(subtreeFile ? { folded: true, subtreeFile,
        subtreeCount: actual?.nodeCount ?? (node.fields.SubtreeCount?.trim() || ''),
        ...(actual?.progress ? { subtreeProgress: actual.progress } : {}),
        summarySource: actual?.root ? subtreeFile : tree.path,
        ...(actual?.error ? { summaryWarning: actual.error } : {}) } : {})
    };
  });
  return { schema: 'task-tree-summary/v1', treeId: tree.id, treePath: tree.path,
    graphState: { current: parsed.graphState.current || '', next: parsed.graphState.next || '' },
    nodes, edges: mapEdges(markdown),
    readPolicy: '摘要只含主树地图及折叠根当前状态，不展开子树后代。需要细节时用 task_tree_read 读取完整主树，或 task_tree_subtree(action=read,path) 读取指定子树。' };
}

export async function readTreeSummary({ projectRoot, tree = { id: 'method', path: 'task-tree.md' }, markdown, persist = false } = {}) {
  const main = markdown ?? await readFile(path.resolve(projectRoot, tree.path), 'utf8');
  const nodes = parseTreeNodeFields(main);
  const refs = [...new Set(nodes.map(n => n.fields.SubtreeFile?.trim()).filter(Boolean))];
  const foldedRoots = new Map();
  const sources = [{ path: tree.path, sha256: digest(main) }];
  await Promise.all(refs.map(async relative => {
    const file = path.resolve(projectRoot, relative);
    const resolved = path.relative(projectRoot, file).replace(/\\/g, '/');
    if (!/^subtrees\/.+\.md$/.test(resolved) || resolved.startsWith('../')) {
      foldedRoots.set(relative, { error: '子树路径不在项目 subtrees/ 中' }); return;
    }
    try {
      const content = await readFile(file, 'utf8');
      const index = nodes.find(n => n.fields.SubtreeFile?.trim() === relative);
      const subtreeNodes = parseTreeNodeFields(content);
      const root = subtreeNodes.find(n => n.id === index.id);
      const descendants = subtreeNodes.filter(n => n.id !== index.id);
      const count = status => descendants.filter(n => n.fields.Completion?.trim() === status).length;
      const progress = { total: descendants.length, completed: count('已完成'), inProgress: count('进行中'),
        notStarted: count('未开始'), redo: count('需重做'), unknown: descendants.filter(n => !['已完成', '进行中', '未开始', '需重做'].includes(n.fields.Completion?.trim())).length };
      foldedRoots.set(relative, root ? { root, nodeCount: subtreeNodes.length, progress } : { error: `子树缺少折叠根 ${index.id}` });
      sources.push({ path: relative, sha256: digest(content) });
    } catch (error) { foldedRoots.set(relative, { error: `读取子树失败：${error.code || error.message}` }); }
  }));
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const summary = buildTreeSummary(main, { tree, foldedRoots });
  const snapshot = { ...summary, generatedAt: new Date().toISOString(), sources,
    fingerprint: digest(JSON.stringify(sources)), mainBytes: Buffer.byteLength(main) };
  if (persist) {
    const relative = `.task-tree-maintenance/tree-summaries/${digest(`${tree.id}\n${tree.path}`)}.json`;
    const file = path.join(projectRoot, relative);
    const previous = saves.get(file) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      await rename(temp, file);
    });
    saves.set(file, next);
    try { await next; } finally { if (saves.get(file) === next) saves.delete(file); }
    snapshot.snapshotPath = relative;
  }
  return snapshot;
}

export const TREE_CONTEXT_TOOLS = [
  { type: 'function', function: { name: 'task_tree_summary', description: '读取新鲜的主树地图摘要，包含折叠根状态，不向模型展开子树后代。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'task_tree_read', description: '按需读取完整主树 Markdown；不会自动展开折叠子树。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } }
];

export function treeContextHandler(projectRoot) {
  return async name => {
    if (name === 'task_tree_summary') return readTreeSummary({ projectRoot });
    if (name === 'task_tree_read') return { treePath: 'task-tree.md', markdown: await readFile(path.join(projectRoot, 'task-tree.md'), 'utf8') };
    throw new Error(`未知上下文工具 ${name}`);
  };
}

export function buildRunOutcomeSummary(run) {
  const jobs = run.jobs || [];
  const completed = jobs.filter(job => job.status === 'completed').length;
  return [`本轮完成 ${completed}/${jobs.length} 个分支；目标：${run.goal?.immediate || run.objective || '按分支任务执行'}。`,
    ...(run.status ? [`本轮状态：${run.status}${run.error ? `；失败原因：${run.error}` : ''}`] : []),
    ...jobs.map(job => `${job.taskId}（${job.nodeId}）：${job.status}；${job.evidence || job.error || '未记录结果证据'}`)].join('\n');
}
