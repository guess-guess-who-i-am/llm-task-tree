import {parseTreeNodeFields} from './tree-quality.js';

export function assertRenderableTree(markdown) {
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
