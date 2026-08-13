import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const source = process.argv[2] || path.join(root, "docs", "agent-context-research", "prompt-audit", "AGENTS.original.20260710.md");
const outDir = process.argv[3] || path.dirname(source);

const ranges = [
  [1, 6, "F00", "项目入口与任务树权威", "AGENTS.md"],
  [7, 16, "F01", "compact live state", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §0"],
  [17, 26, "F02", "字段硬预算", "llm-task-tree/AGENTS.task-tree.md §0/§3 + tree-lint"],
  [27, 31, "F03", "大树测量压缩", "llm-task-tree/AGENTS.task-tree.md §0 + tree-lint"],
  [32, 35, "F04", "节点成本与方法替换", "llm-task-tree/AGENTS.task-tree.md §0/§4"],
  [36, 36, "F13", "方法变化同步 flow", "AGENTS.md + scripts/README.md"],
  [37, 48, "F01", "冲突与噪声清理", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §0"],
  [49, 55, "F05", "任务开始与焦点读取", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §1"],
  [56, 60, "F16", "恢复/回滚起始处理", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §8"],
  [61, 64, "F05", "建树、逐节点与方向变化", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §1"],
  [65, 72, "F06", "skill 路由", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §1/§6"],
  [73, 92, "F07", "Edit-Tree Gate", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §1b"],
  [93, 114, "F08", "Edit-Flow Gate", "AGENTS.md + scripts/README.md"],
  [115, 135, "F09", "结束写回与字段时机", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §2"],
  [136, 141, "F10", "GraphState 所有权", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §2"],
  [142, 143, "F12", "边更新", "llm-task-tree/AGENTS.task-tree.md §2/§4"],
  [144, 145, "F13", "方法变化同步 flow", "AGENTS.md + scripts/README.md"],
  [146, 149, "F09", "最终告知", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §2"],
  [150, 246, "F11", "字段写法、样例与推理图质量", "llm-task-tree/AGENTS.task-tree.md §3 + skill references"],
  [247, 256, "F12", "节点和二元边规则", "llm-task-tree/AGENTS.task-tree.md §4"],
  [257, 267, "F13", "执行流程分工与审计", "AGENTS.md + scripts/README.md"],
  [268, 371, "F12", "Markdown schema 与字段语义", "llm-task-tree/AGENTS.task-tree.md §5 + schema reference"],
  [372, 391, "F14", "skill routing log", "llm-task-tree/AGENTS.task-tree.md §6"],
  [392, 400, "F15", "版本备份", "llm-task-tree/AGENTS.task-tree.md §7 + scripts/README.md"],
  [401, 413, "F16", "回滚与文件漂移", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §8"],
  [414, 432, "F17", "结束检查清单", "llm-task-tree/AGENTS.task-tree.md §9 + postflight"],
  [433, 448, "F18", "Agent chain run", "AGENTS.md + llm-task-tree/AGENTS.task-tree.md §10"],
  [449, 511, "F19", "跨项目安装 stub", "llm-task-tree-kit/templates/AGENTS.merge.md"],
  [512, 554, "F20", "工具调用规则", "AGENTS.md"]
];

function metadataFor(lineNo) {
  const hit = ranges.find(([start, end]) => lineNo >= start && lineNo <= end);
  if (!hit) throw new Error(`No function mapping for line ${lineNo}`);
  return { id: hit[2], label: hit[3], destination: hit[4] };
}

function kindOf(line, inFence) {
  const t = line.trim();
  if (t.startsWith("```")) return "fence";
  if (inFence) return "code";
  if (t.startsWith("#")) return "heading";
  if (t.startsWith("<!--")) return "marker";
  if (/^\|.*\|$/.test(t)) return "table";
  if (/^([-*]|\d+\.)\s/.test(t)) return "list";
  return "prose";
}

function splitUnits(line, kind) {
  if (kind !== "prose" && kind !== "list") return [line];
  let prefix = "";
  let content = line;
  if (kind === "list") {
    const match = line.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);
    if (match) {
      prefix = match[1];
      content = match[2];
    }
  }
  const matches = content.match(/.*?(?:[.!?。！？]+(?:\s+|$)|$)/g)?.filter(Boolean) || [content];
  if (prefix) matches[0] = prefix + matches[0];
  return matches.join("") === line ? matches : [line];
}

const text = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");
const annotated = [];
const rows = ["line_no\tunit_no\tfunction_id\tfunction\tdestination\tkind\texact_text_json"];
const lineCoverage = [];
const functionCounts = {};
let inFence = false;
let statementCount = 0;

for (let index = 0; index < lines.length; index += 1) {
  const lineNo = index + 1;
  const line = lines[index];
  if (line.length === 0) {
    annotated.push("");
    continue;
  }
  const meta = metadataFor(lineNo);
  const kind = kindOf(line, inFence);
  annotated.push(`<!-- L${String(lineNo).padStart(4, "0")} | ${meta.id} | ${meta.label} -->`);
  annotated.push(line);
  const units = splitUnits(line, kind);
  units.forEach((unit, unitIndex) => {
    statementCount += 1;
    rows.push([
      lineNo,
      unitIndex + 1,
      meta.id,
      meta.label,
      meta.destination,
      kind,
      JSON.stringify(unit)
    ].join("\t"));
  });
  lineCoverage.push({ lineNo, functionId: meta.id, units: units.length });
  functionCounts[meta.id] = (functionCounts[meta.id] || 0) + units.length;
  if (line.trim().startsWith("```")) inFence = !inFence;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "AGENTS.annotated.md"), annotated.join("\n"), "utf8");
fs.writeFileSync(path.join(outDir, "statement-map.tsv"), rows.join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(outDir, "coverage.json"), JSON.stringify({
  source: path.relative(root, source).replaceAll("\\", "/"),
  sha256: crypto.createHash("sha256").update(text).digest("hex"),
  totalLines: lines.length,
  nonBlankLines: lineCoverage.length,
  statementUnits: statementCount,
  functionCounts,
  lineCoverage
}, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ lines: lines.length, nonBlank: lineCoverage.length, statements: statementCount, functions: Object.keys(functionCounts).length }, null, 2));
