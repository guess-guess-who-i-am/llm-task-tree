#!/usr/bin/env node
/** 控制变量实验：主树全展开 vs 全折叠 stub 后的体积对比 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const treeFile = path.join(root, "task-tree.md");
const md = readFileSync(treeFile, "utf8");
const lines = md.split(/\r?\n/);

function extractNode(id) {
  const start = lines.findIndex((l) => l.startsWith(`## ${id} - `));
  if (start < 0) return { lines: 0, chars: 0 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## [A-Za-z0-9_-]+ - /.test(lines[i]) || /^# GraphState/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end).join("\n");
  return { lines: end - start, chars: block.length };
}

function stubEstimate(id, title, subtreeFile, count = 1) {
  return [
    `## ${id} - ${title}`,
    "- Completion:",
    "- AssignedTo:",
    `- Problem: [子树已折叠] → ${subtreeFile}`,
    "- CurrentResult:",
    "- Notes: 详情在子树；合并请 UI ⊞ 展开",
    "- Folded: true",
    `- SubtreeFile: ${subtreeFile}`,
    `- SubtreeCount: ${count}`
  ].join("\n");
}

const nodeIds = lines
  .filter((l) => /^## [A-Za-z0-9_-]+ - /.test(l) && !l.startsWith("## E"))
  .map((l) => l.match(/^## ([A-Za-z0-9_-]+) - /)[1]);

const full = { lines: lines.length, chars: md.length };
const perNode = {};
let foldableChars = 0;
let foldableLines = 0;
const foldCandidates = ["N3", "N4", "N5", "N6", "N7", "N9", "N10", "N1"];

for (const id of nodeIds) {
  const s = extractNode(id);
  perNode[id] = s;
  if (foldCandidates.includes(id)) {
    foldableChars += s.chars;
    foldableLines += s.lines;
  }
}

const stubChars = foldCandidates.reduce((sum, id) => {
  const title = lines.find((l) => l.startsWith(`## ${id} - `))?.replace(/^## \S+ - /, "") || id;
  return sum + stubEstimate(id, title, `subtrees/${id}-subtree.md`).length;
}, 0);

const projectedChars = full.chars - foldableChars + stubChars;
const agentContextMap = extractNode("ROOT").chars + stubEstimate("ST-P1", "x", "subtrees/ST-P1-subtree.md").length * 2 + 200;

const report = {
  current: {
    taskTreeLines: full.lines,
    taskTreeChars: full.chars,
    taskTreeTokensEst: Math.round(full.chars / 2.5),
    nodeCount: nodeIds.length,
    foldedStubCount: 2
  },
  ifFold8Branches: {
    projectedChars: Math.round(projectedChars),
    projectedTokensEst: Math.round(projectedChars / 2.5),
    savedPct: Math.round((1 - projectedChars / full.chars) * 100),
    perNode
  },
  agentContextMapTokensEst: Math.round(agentContextMap / 2.5),
  subtrees: {}
};

import { readdirSync, statSync } from "node:fs";
const stDir = path.join(root, "subtrees");
try {
  for (const f of readdirSync(stDir).filter((x) => x.endsWith(".md"))) {
    const c = readFileSync(path.join(stDir, f), "utf8");
    report.subtrees[f] = { chars: c.length, tokensEst: Math.round(c.length / 2.5) };
  }
} catch {}

console.log(JSON.stringify(report, null, 2));
