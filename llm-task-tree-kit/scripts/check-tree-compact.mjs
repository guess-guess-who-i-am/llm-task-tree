import path from "node:path";
import { locateProjectRoot } from "../server/turn-tracker.js";
import { findTree, loadTreeRegistry, resolveTreeFile } from "../server/tree-registry.js";
import { ACTIVE_METHOD_TREE_MAX_BYTES, compactViolationSummary, inspectTreeFile, isTreeMarkdownPath } from "../server/tree-quality.js";

const rootArgIndex = process.argv.indexOf("--project-root");
const explicitRoot = rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : "";
const root = locateProjectRoot({
  cwd: explicitRoot || process.cwd(),
  fallbackDir: explicitRoot || process.cwd()
});
const requested = process.argv
  .slice(2)
  .filter((item, index, all) => item !== "--project-root" && all[index - 1] !== "--project-root")
  .filter((item) => !item.startsWith("--"))
  .map((item) => path.isAbsolute(item) ? path.relative(root, item) : item)
  .filter(isTreeMarkdownPath);

const registryFile = path.join(root, "task-trees.json");
const registry = await loadTreeRegistry({ projectRoot: root, registryFile, create: false });
const active = findTree(registry, registry.activeMethod);
const activePath = active
  ? path.relative(root, resolveTreeFile(root, active)).replace(/\\/g, "/")
  : "task-tree.md";

let files = requested;
if (!files.length) {
  files = [activePath];
}

const reports = [];
for (const file of [...new Set(files)]) {
  const normalizedFile = String(file).replace(/\\/g, "/");
  const report = await inspectTreeFile(root, file, {
    maxBytes: normalizedFile === activePath ? ACTIVE_METHOD_TREE_MAX_BYTES : 0
  });
  if (report) reports.push(report);
}

if (!reports.length) {
  console.error(`没有可检查的任务树：${files.join(", ") || "active method tree"}`);
  process.exit(2);
}

const violations = reports.flatMap((report) => report.violations || []);
const longLines = reports.flatMap((report) =>
  (report.longLines || []).map((item) => ({ ...item, file: report.file }))
);
const result = {
  ok: violations.length === 0 && longLines.length === 0,
  projectRoot: root,
  checked: reports.map((report) => ({
    file: report.file,
    bytes: report.bytes,
    lines: report.lines,
    nodes: report.nodes,
    overBudgetFields: report.budgetViolations,
    styleViolations: report.styleViolations,
    longLines: report.longLines.length
  })),
  violations,
  longLines
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error(`\n任务树未通过精炼门禁：${compactViolationSummary(reports) || `${longLines.length} 行超过 240 字符`}`);
  console.error("请让 Agent 语义精炼并改为简明中文；代码、命令、公式、原始数据和复杂英文术语移到证据文件。禁止机械截断。");
  process.exitCode = 1;
}
