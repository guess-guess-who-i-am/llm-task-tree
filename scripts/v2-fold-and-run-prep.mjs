#!/usr/bin/env node
/** 折叠 N3/N6/N7 为 v2 并行试跑准备 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const treeFile = path.join(root, "task-tree.md");
const subtreesDir = path.join(root, "subtrees");
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
copyFileSync(treeFile, path.join(root, "versions", `${ts}_v2试跑前折叠N3N6N7.md`));

let md = readFileSync(treeFile, "utf8");

function extractNode(id) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${id} - `));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## [A-Za-z0-9_-]+ - /.test(lines[i]) || /^# GraphState/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, block: lines.slice(start, end).join("\n"), title: lines[start].replace(/^## \S+ - /, "") };
}

function stubFor(id, title, subtreeFile, assignedTo) {
  return [
    `## ${id} - ${title}`,
    "- Position:",
    "- Size:",
    "- Completion: 进行中",
    `- AssignedTo: ${assignedTo}`,
    `- Problem: [子树已折叠] → ${subtreeFile}`,
    "- CurrentResult:",
    "- Notes: v2 并行试跑；合并请 UI ⊞ 展开。",
    "- Folded: true",
    `- SubtreeFile: ${subtreeFile}`,
    "- SubtreeCount: 1"
  ].join("\n");
}

const folds = [
  { id: "N3", worker: "worker-N3", nextPlan: "读 task-tree.md 全文 + subtrees/N3-subtree.md；写 docs/subtree-parallel/v2-N3-findings.md（≤50行）：用 3 条要点总结 worker-v2 读树策略；更新 N3 CurrentResult；禁止读 N6/N7 subtree、禁止写 task-tree 详文" },
  { id: "N6", worker: "worker-N6", nextPlan: "读 task-tree.md 全文 + subtrees/N6-subtree.md；在 server.js 中列出 /api/model-agents 相关路由（路径+一行说明），写入 docs/subtree-parallel/v2-N6-findings.md；更新 N6 CurrentResult；禁止读其它 subtree" },
  { id: "N7", worker: "worker-N7", nextPlan: "读 task-tree.md 全文 + subtrees/N7-subtree.md；在 server.js 中列出 /api/knowledge 与 /api/web-search 路由，写入 docs/subtree-parallel/v2-N7-findings.md；更新 N7 CurrentResult；禁止读其它 subtree" }
];

mkdirSync(subtreesDir, { recursive: true });

for (const f of folds) {
  const node = extractNode(f.id);
  if (!node) {
    console.error("missing node", f.id);
    process.exit(1);
  }
  const rel = `subtrees/${f.id}-subtree.md`;
  const subtreeMd = [
    "# LLM Task Graph Subtree",
    "",
    `> Fold root: ${f.id}`,
    "> v2 并行试跑包",
    "",
    node.block,
    "",
    "# GraphState",
    "",
    `- Current: ${f.id}`,
    `- Next: ${f.id}`,
    `- NextPlan: ${f.nextPlan}`,
    "",
    "# Edges",
    ""
  ].join("\n");
  writeFileSync(path.join(root, rel), subtreeMd, "utf8");
  const stub = stubFor(f.id, node.title, rel, f.worker);
  const lines = md.split(/\r?\n/);
  md = [...lines.slice(0, node.start), stub, ...lines.slice(node.end)].join("\n");
  console.log("folded", f.id, "→", rel);
}

writeFileSync(treeFile, md, "utf8");
console.log("done");
