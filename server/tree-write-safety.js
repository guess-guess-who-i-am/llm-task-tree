import {parseTreeNodeFields} from './tree-quality.js';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

const treePath = file => file === 'task-tree.md' || /^(subtrees|trees)\/(?:[^/]+\/)*[^/]+\.md$/.test(file);
const relativePath = value => String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
async function optionalText(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Git's changed paths include deletions. Validate the resulting workspace,
// rather than trying to open a file that was intentionally removed/migrated.
export async function assertWorkspaceTreeFiles(workspacePath, files) {
  const deleted = new Set();
  for (const file of files.filter(treePath)) {
    const text = await optionalText(path.join(workspacePath, file));
    if (text === null) deleted.add(file);
    else assertRenderableTree(text);
  }
  if (!deleted.size) return;
  const missing = (file, owner) => {
    throw Object.assign(new Error(`树引用失效：${owner} 仍需要 ${file}，但候选工作区已删除该文件；请更新引用或恢复文件。`),
      {code:'TREE_REFERENCE_MISSING',stage:'tree-validation'});
  };
  if (deleted.has('task-tree.md')) missing('task-tree.md', '主树入口');
  const registryText = await optionalText(path.join(workspacePath, 'task-trees.json'));
  const registered = registryText === null ? [] : JSON.parse(registryText).trees || [];
  for (const entry of registered) if (deleted.has(relativePath(entry.path))) missing(entry.path, `树注册表 ${entry.id}`);
  const trees = new Set(['task-tree.md', ...registered.map(entry => relativePath(entry.path))]);
  async function collect(directory) {
    let entries;
    try { entries = await readdir(path.join(workspacePath, directory), {withFileTypes:true}); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && file.endsWith('.md')) trees.add(file);
    }
  }
  await Promise.all(['subtrees', 'trees'].map(collect));
  // Inspect surviving indexes, including unchanged siblings. Backups/history
  // deliberately do not keep an obsolete subtree alive.
  for (const file of trees) {
    const text = await optionalText(path.join(workspacePath, file));
    if (text === null) continue;
    for (const node of parseTreeNodeFields(text)) {
      const target = relativePath(node.fields.SubtreeFile);
      if (deleted.has(target)) missing(target, `${file} 的节点 ${node.id}`);
    }
  }
}

export function assertRenderableTree(markdown) {
  const nodeSection=String(markdown).replace(/\r/g,'').split(/^# (?:GraphState|Edges)\s*$/m)[0];
  for(const match of nodeSection.matchAll(/^##(?:[ \t][^\r\n]*)?$/gm)) {
    if(!/^##[ \t]+\S+[ \t]+-[ \t]+\S[^\r\n]*$/.test(match[0])) throw new Error(`节点标题必须使用 ## ID - 非空标题：${match[0]}`);
  }
  const invalid=parseTreeNodeFields(markdown).filter(n=>!/^[A-Za-z0-9_-]+$/.test(n.id));
  if(invalid.length) throw new Error(`界面不支持节点 ID ${invalid.map(n=>n.id).join('、')}；ID 只能使用字母、数字、下划线或横线，例如 N9_1，不能使用 N9.1。请同时修正节点标题、边端点和 GraphState 的对应 ID。`);
  for(const match of String(markdown).split(/^# Edges\s*$/m)[1]?.matchAll(/^##\s+(\S+)/gm)||[]) if(!/^E[A-Za-z0-9_-]*$/.test(match[1])) throw new Error('界面的边 ID 必须以 E 开头，仅含字母、数字、下划线或横线');
}

export function assertMainTreeWrite(current, next) {
  assertRenderableTree(next);
  if (/^# .*Subtree\b|^>\s*Fold root:/mi.test(next)) {
    throw new Error('这是子树内容，不能覆盖主树。请调用 task_tree_subtree(action="write", path="subtrees/<节点>-subtree.md", foldRoot="<节点>", markdown=子树正文)。');
  }
  const ids = new Set(parseTreeNodeFields(next).map(n=>n.id));
  const missing = parseTreeNodeFields(current).filter(n=>!ids.has(n.id)).map(n=>n.id);
  if (missing.length) throw new Error(`整树写入会丢失原节点 ${missing.join('、')}，已拒绝。展开子树使用 task_tree_subtree；更新节点使用 nodeId+fields；删除节点请使用界面中的明确删除操作。`);
}
