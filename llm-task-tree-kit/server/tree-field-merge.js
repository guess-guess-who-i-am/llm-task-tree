import { diffTreeMarkdown } from './tree-diff.js';
import { patchNodeFields } from './tree-node-patch.js';

function structureWithoutNodeFields(markdown) {
  const text = String(markdown);
  const match = text.match(/^# GraphState\b/m);
  if (!match) return null;
  const split = match.index;
  const beforeState = text.slice(0, split).split('\n');
  const structural = [];
  let insideField = false;
  for (const line of beforeState) {
    if (/^-\s+[A-Za-z][A-Za-z0-9]*:/.test(line)) { insideField = true; continue; }
    if (insideField && (!line.trim() || /^\s+/.test(line))) continue;
    insideField = false;
    if (!line.trim() || line === '> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。') continue;
    structural.push(line.trimEnd());
  }
  const tail = text.slice(split);
  const edgesAt = tail.search(/^# Edges\b/m);
  if (edgesAt < 0) return null;
  const stateLines = tail.slice(0, edgesAt).split('\n').filter(line => line.trim());
  if (stateLines.shift() !== '# GraphState') return null;
  const state = [];
  for (const line of stateLines) {
    const field = line.match(/^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!field) return null;
    if (field[2].trim()) state.push(`${field[1]}:${field[2].trim()}`);
  }
  const edgeLines = tail.slice(edgesAt).split('\n').filter(line => line.trim());
  if (edgeLines.shift() !== '# Edges') return null;
  const edges = [];
  let edgeTitle = '';
  for (const line of edgeLines) {
    const heading = line.match(/^##\s+\S+\s+-\s+(.+)$/);
    if (heading) { edgeTitle = heading[1].trim(); edges.push(line.trimEnd()); continue; }
    const field = line.match(/^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!field) return null;
    const value = field[2].trim();
    if (value && !(field[1] === 'Label' && value === edgeTitle)) edges.push(`${field[1]}:${value}`);
  }
  return `${structural.join('\n')}\n# GraphState\n${state.sort().join('\n')}\n# Edges\n${edges.join('\n')}`;
}

// Only auto-resolve the narrow case the tree field-patch API can prove safe:
// both branches are exactly reproducible as field patches from the same base,
// and any shared field has the same resulting value. Structural edits and
// competing values are left for the conflict Agent.
export function mergeIndependentTreeFields(base, current, incoming) {
  const normalized = [base, current, incoming].map(value => String(value).replace(/\r\n/g, '\n'));
  const [ancestor, ours, theirs] = normalized;
  const oursChanges = diffTreeMarkdown(ancestor, ours);
  const theirsChanges = diffTreeMarkdown(ancestor, theirs);
  if (![...oursChanges, ...theirsChanges].every(change => change.kind === 'node-field')) return null;
  const structure = structureWithoutNodeFields(ancestor);
  if (structure === null || structure !== structureWithoutNodeFields(ours) || structure !== structureWithoutNodeFields(theirs)) return null;
  try {
    const changedByUs = new Map(oursChanges.map(change => [`${change.nodeId}\0${change.field}`, change.after]));
    let merged = ours;
    for (const change of theirsChanges) {
      const key = `${change.nodeId}\0${change.field}`;
      if (changedByUs.has(key)) {
        if (changedByUs.get(key) !== change.after) return null;
        continue;
      }
      merged = patchNodeFields(merged, change.nodeId, { [change.field]: change.after }).markdown;
    }
    return merged;
  } catch {
    return null;
  }
}
