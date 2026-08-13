import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectTreeMarkdown } from "../server/tree-quality.js";

function inspect(fieldLines) {
  return inspectTreeMarkdown([
    "# LLM Task Graph",
    "",
    "## N1 - 节点写作测试",
    "- Completion: 进行中",
    ...fieldLines,
    "",
    "# GraphState",
    "- Current: N1",
    "- Next: N1",
    "",
    "# Edges",
    ""
  ].join("\n"));
}

const allowed = inspect([
  "- Problem: 如何控制 LLM 的 token 预算并保持结果可读？",
  "- Approach: 通过 API 读取状态；详细实现见 server/tree-quality.js。",
  "- Input: 用户提供的评估记录；完整内容见 data/records.md。",
  "- Output: 已生成中文结论；详见 outputs/report.md。"
]);
assert.equal(allowed.styleViolations, 0, JSON.stringify(allowed.violations));

const json = inspect(["- Input: {\"patient_id\":\"P1\",\"value\":3}"]);
assert.ok(json.violations.some((item) => item.code === "NODE_CODE_SNIPPET"));

const command = inspect(["- NextIdea: python scripts/run_eval.py --input data.json"]);
assert.ok(command.violations.some((item) => item.code === "NODE_CODE_SNIPPET"));

const csv = inspect(["- Output: paper_id,layer,residual"]);
assert.ok(csv.violations.some((item) => item.code === "NODE_CODE_SNIPPET"));

const english = inspect(["- Problem: acute respiratory distress syndrome caused by severe systemic inflammation"]);
assert.ok(english.violations.some((item) => item.code === "NODE_ENGLISH_HEAVY"));

const translated = inspect(["- Problem: 如何识别严重全身炎症引发的急性呼吸窘迫综合征？"]);
assert.equal(translated.styleViolations, 0, JSON.stringify(translated.violations));

const ordinaryLabels = inspect(["- CaseStudy: case 1: 用户先写英文术语，后来改成中文。"]);
assert.equal(ordinaryLabels.styleViolations, 0, JSON.stringify(ordinaryLabels.violations));

const allowedList = inspect(["- Notes: LLM, token, API"]);
assert.equal(allowedList.styleViolations, 0, JSON.stringify(allowedList.violations));

const current = inspectTreeMarkdown(await readFile("task-tree.md", "utf8"), { file: "task-tree.md" });
assert.equal(current.styleViolations, 0, JSON.stringify(current.violations));

console.log("PASS node prose stays concise Chinese and code-free");
