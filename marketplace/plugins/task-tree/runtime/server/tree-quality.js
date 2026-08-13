import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const TREE_FIELD_BUDGETS = Object.freeze({
  Problem: 140,
  Approach: 450,
  Input: 700,
  Output: 700,
  Metrics: 300,
  Notes: 450,
  CurrentResult: 500,
  RootCauseAnalysis: 350,
  CaseStudy: 400,
  NextIdea: 160
});

export const ACTIVE_METHOD_TREE_MAX_BYTES = 12 * 1024;

const NODE_PROSE_FIELDS = new Set([
  "Problem",
  "Approach",
  "Input",
  "Output",
  "Metrics",
  "Notes",
  "CurrentResult",
  "RootCauseAnalysis",
  "CaseStudy",
  "NextIdea"
]);

const CODE_LINE_PATTERNS = [
  /```|~~~/,
  /(?:^|\s)[{[]\s*["'][^"']+["']\s*:/,
  /^(?:[$>#]\s*)?(?:npm|pnpm|yarn|pip|python|node|git|curl|wget|ssh|docker|kubectl|powershell|pwsh|bash|sh)\b(?:\s|$)/i,
  /^(?:const|let|var|function|class|def|import|from|SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/i,
  /^(?:[A-Za-z_$][\w$.[\]-]*)\s*=\s*[^=]/,
  /^(?:[A-Za-z_][\w.-]*):\s+\S/,
  /=>|;\s*$/,
  /^<\/?[A-Za-z][^>]*>$/,
  /^[^，\n]+(?:,[^，\n]+){2,}$/
];

const ALLOWED_TECHNICAL_WORDS = new Set([
  "llm",
  "token",
  "api",
  "mcp",
  "ui",
  "url",
  "id",
  "codex",
  "agent",
  "prompt",
  "markdown",
  "linux",
  "playwright"
]);

const NODE_FIELD_RE = /^-\s+(Position|Size|Completion|Problem|Approach|Input|Output|Metrics|Notes|CodeLoc|CurrentResult|RootCauseAnalysis|CaseStudy|NextIdea|SelectedSkills|Folded|SubtreeFile|SubtreeCount|ReadStatus|ReadFingerprint):\s*(.*)$/;

function normalized(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function visibleLength(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .length;
}

function plainFieldLine(value) {
  return String(value || "")
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function isArtifactPointerLine(value) {
  const line = plainFieldLine(value).split(/\s+#\s+/, 1)[0].trim();
  if (!line) return false;
  if (/^(?:https?:\/\/|ui:\/\/|[A-Za-z]:[\\/]|\.{0,2}[\\/]|\/)[^\s]+$/i.test(line)) return true;
  if (/^[^\s，。；]+[\\/][^\s，。；]+(?::\d+)?$/i.test(line)) return true;
  if (/^[\w.@()-]+\.(?:md|txt|json|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|ps1|sh|toml|ya?ml|html?|css|pdf)(?::\d+)?$/i.test(line)) return true;
  return false;
}

function isAllowedTechnicalList(value) {
  const words = plainFieldLine(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return words.length >= 2 && words.every((word) => ALLOWED_TECHNICAL_WORDS.has(word.toLowerCase()));
}

function englishHeavy(value) {
  const line = plainFieldLine(value);
  if (!line || isArtifactPointerLine(line)) return false;
  const prose = line
    .replace(/`[^`\n]+`/g, " ")
    .replace(/(?:https?:\/\/|ui:\/\/)[^\s]+/gi, " ")
    .replace(/[^\s，。；、()（）]*[\\/][^\s，。；、()（）]*/g, " ")
    .replace(/\b[\w.@()-]+\.[A-Za-z0-9]{1,8}(?::\d+)?\b/g, " ");
  const words = prose.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
  if (isAllowedTechnicalList(line)) return false;
  if (!/[\u3400-\u9fff]/u.test(prose)) {
    if (words.every((word) => ALLOWED_TECHNICAL_WORDS.has(word.toLowerCase()))) return false;
    return words.length >= 3;
  }
  return /\b[A-Za-z][A-Za-z'-]{2,}(?:\s+[A-Za-z][A-Za-z'-]{2,}){3,}\b/.test(prose);
}

function nodeWritingViolations(node, file) {
  const violations = [];
  for (const [field, value] of Object.entries(node.fields || {})) {
    if (!NODE_PROSE_FIELDS.has(field)) continue;
    const lines = String(value || "").replace(/\r/g, "").split("\n");
    let codeReported = false;
    let englishReported = false;
    lines.forEach((rawLine, index) => {
      const line = plainFieldLine(rawLine);
      if (!line) return;
      const naturalLabel = /^(?:case|example|reason|result|note|lesson)\b/i.test(line);
      const codeLike = CODE_LINE_PATTERNS.some((pattern) => pattern.test(line))
        && !(naturalLabel && /^[A-Za-z][\w.-]*:\s+/i.test(line))
        && !isAllowedTechnicalList(line);
      if (!codeReported && !isArtifactPointerLine(line) && codeLike) {
        codeReported = true;
        violations.push({
          code: "NODE_CODE_SNIPPET",
          file: normalized(file),
          nodeId: node.id,
          field,
          line: index + 1,
          message: "节点语义字段不得包含代码、命令、公式或原始数据样例"
        });
      }
      if (!englishReported && englishHeavy(line)) {
        englishReported = true;
        violations.push({
          code: "NODE_ENGLISH_HEAVY",
          file: normalized(file),
          nodeId: node.id,
          field,
          line: index + 1,
          message: "节点语义字段应改为简明中文；复杂英文术语移到证据文件"
        });
      }
    });
  }
  return violations;
}

export function parseTreeNodeFields(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const nodes = [];
  let section = "meta";
  let node = null;
  let field = "";

  const flushNode = () => {
    if (node) nodes.push(node);
    node = null;
    field = "";
  };

  for (const line of lines) {
    if (/^# GraphState\b/.test(line)) {
      flushNode();
      section = "graphState";
      continue;
    }
    if (/^# Edges\b/.test(line)) {
      flushNode();
      section = "edges";
      continue;
    }
    const heading = line.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (heading && section !== "edges") {
      flushNode();
      section = "nodes";
      node = { id: heading[1], title: heading[2].trim(), fields: {} };
      continue;
    }
    if (section !== "nodes" || !node) continue;

    const fieldMatch = line.match(NODE_FIELD_RE);
    if (fieldMatch) {
      field = fieldMatch[1];
      node.fields[field] = fieldMatch[2] || "";
      continue;
    }
    if (field) node.fields[field] = `${node.fields[field] || ""}\n${line}`;
  }
  flushNode();
  return nodes;
}

export function inspectTreeMarkdown(markdown, { file = "task-tree.md", maxBytes = 0 } = {}) {
  const text = String(markdown || "");
  const nodes = parseTreeNodeFields(text);
  const violations = [];
  for (const node of nodes) {
    for (const [field, budget] of Object.entries(TREE_FIELD_BUDGETS)) {
      const chars = visibleLength(node.fields[field]);
      if (chars > budget) {
        violations.push({
          code: "FIELD_BUDGET",
          file: normalized(file),
          nodeId: node.id,
          field,
          chars,
          budget,
          excess: chars - budget
        });
      }
    }
    violations.push(...nodeWritingViolations(node, file));
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (maxBytes > 0 && bytes > maxBytes) {
    violations.push({
      code: "TREE_TOTAL_BYTES",
      file: normalized(file),
      nodeId: "<TREE>",
      field: "TotalBytes",
      chars: bytes,
      budget: maxBytes,
      excess: bytes - maxBytes,
      unit: "bytes"
    });
  }
  const longLines = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, chars: line.length }))
    .filter((item) => item.chars > 240);
  return {
    file: normalized(file),
    bytes,
    lines: text.split(/\r?\n/).length,
    nodes: nodes.length,
    violations,
    budgetViolations: violations.filter((item) => item.code === "FIELD_BUDGET" || item.code === "TREE_TOTAL_BYTES").length,
    styleViolations: violations.filter((item) => item.code === "NODE_CODE_SNIPPET" || item.code === "NODE_ENGLISH_HEAVY").length,
    longLines
  };
}

export function isTreeMarkdownPath(file) {
  const rel = normalized(file);
  return rel === "task-tree.md"
    || /^trees\/.+\.md$/i.test(rel)
    || /^subtrees\/.+\.md$/i.test(rel);
}

export async function inspectTreeFile(projectRoot, file, options = {}) {
  const rel = normalized(file);
  const fullPath = path.resolve(projectRoot, rel);
  if (!existsSync(fullPath)) return null;
  return inspectTreeMarkdown(await readFile(fullPath, "utf8"), { ...options, file: rel });
}

export function compactViolationSummary(reports, { limit = 12 } = {}) {
  const violations = reports.flatMap((report) => report?.violations || []);
  const shown = violations
    .sort((a, b) => Number(b.excess || 0) - Number(a.excess || 0))
    .slice(0, limit)
    .map((item) => item.message
      ? `${item.file}:${item.nodeId}.${item.field}${item.line ? `:${item.line}` : ""} ${item.message}`
      : `${item.file}:${item.nodeId}.${item.field} ${item.chars}>${item.budget}${item.unit === "bytes" ? " bytes" : " chars"}`);
  const rest = Math.max(0, violations.length - shown.length);
  return `${shown.join("；")}${rest ? `；另有 ${rest} 项` : ""}`;
}
