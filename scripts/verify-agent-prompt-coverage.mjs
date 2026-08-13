import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const auditDir = path.join(root, "docs", "agent-context-research", "prompt-audit");
const coverage = JSON.parse(fs.readFileSync(path.join(auditDir, "coverage.json"), "utf8"));
const prompt = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
const annotated = fs.readFileSync(path.join(auditDir, "AGENTS.annotated.md"), "utf8");
const original = fs.readFileSync(path.join(auditDir, "AGENTS.original.20260710.md"), "utf8").replace(/\r\n/g, "\n");
const fullProtocol = fs.readFileSync(path.join(root, "llm-task-tree", "AGENTS.task-tree.md"), "utf8").replace(/\r\n/g, "\n");
const buildKit = fs.readFileSync(path.join(root, "scripts", "build-kit.ps1"), "utf8");

const failures = [];
const expectedIds = Array.from({ length: 21 }, (_, i) => `F${String(i).padStart(2, "0")}`);
for (const id of expectedIds) {
  if (!coverage.functionCounts[id]) failures.push(`original mapping missing ${id}`);
  if (!prompt.includes(`[${id}]`)) failures.push(`new AGENTS.md missing route/tag ${id}`);
}

const annotatedRecovered = annotated
  .split("\n")
  .filter((line) => !/^<!-- L\d{4} \| F\d{2} \|/.test(line))
  .join("\n");
if (annotatedRecovered !== original) failures.push("annotated file does not preserve original exactly");
if (fullProtocol !== original) failures.push("canonical detailed protocol is not an exact copy of the frozen original");
if (!buildKit.includes('llm-task-tree\\AGENTS.task-tree.md')) failures.push("build-kit does not package the canonical detailed protocol");

const nonBlank = original.split("\n").filter((line) => line.length > 0).length;
if (coverage.nonBlankLines !== nonBlank) failures.push(`line coverage ${coverage.nonBlankLines}/${nonBlank}`);
if (coverage.lineCoverage.some((x) => x.units < 1)) failures.push("one or more nonblank lines lack statement units");

const requiredFiles = [
  "llm-task-tree/AGENTS.task-tree.md",
  "llm-task-tree/skills/task-tree-grill/SKILL.md",
  "llm-task-tree/skills/task-tree-grill/references/schema-template.md",
  "scripts/README.md",
  "scripts/steps/README.md",
  "llm-task-tree-kit/templates/AGENTS.merge.md"
];
for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`missing routed file ${relative}`);
}

const bytes = Buffer.byteLength(prompt, "utf8");
if (bytes > 8192) failures.push(`new AGENTS.md is ${bytes} bytes, exceeds 8192-byte target`);

const result = {
  passed: failures.length === 0,
  originalLines: coverage.totalLines,
  mappedNonBlankLines: coverage.nonBlankLines,
  statementUnits: coverage.statementUnits,
  functionsCovered: Object.keys(coverage.functionCounts).length,
  canonicalProtocolExact: fullProtocol === original,
  newPromptBytes: bytes,
  reduction: 1 - bytes / Buffer.byteLength(original, "utf8"),
  failures
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
