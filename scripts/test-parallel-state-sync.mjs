import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAcceptedParallelStateSyncPrompt } from "../server/codex-prompts.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(projectRoot, "e2e-simulation", "parallel-state-sync-fixture");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(fixtureRoot, relativePath), "utf8"));
}

function parseNode(markdown, nodeId) {
  const escapedNodeId = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^## ${escapedNodeId} - (.+)\\r?\\n([\\s\\S]*?)(?=^## |^# GraphState|(?![\\s\\S]))`, "m")
  );
  assert.ok(match, `fixture tree must contain node ${nodeId}`);

  const fields = Object.fromEntries(
    [...match[2].matchAll(/^- ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/gm)].map((field) => [field[1], field[2].trim()])
  );
  return { id: nodeId, title: match[1].trim(), fields };
}

function assertPromptIncludes(prompt, expected, message) {
  assert.ok(prompt.includes(expected), `${message}\nExpected prompt to include: ${expected}`);
}

const manifest = await readJson("fixture.json");
const acceptedRun = await readJson(manifest.acceptedRunFile);
const integrationEvidence = await readJson(manifest.integrationEvidenceFile);
const tree = await readFile(path.join(fixtureRoot, manifest.treeFile), "utf8");
const rootNode = parseNode(tree, manifest.rootNodeId);
const stageNode = parseNode(tree, manifest.stageNodeId);

assert.deepEqual(
  manifest.executionConstraints,
  { network: false, browser: false, humanInput: false },
  "semantic regression fixture must remain fully local and non-interactive"
);
assert.equal(acceptedRun.status, "accepted", "state sync requires an accepted parallel run");
assert.equal(
  acceptedRun.goalAssessment.goalAchieved,
  false,
  "fixture must preserve the unverified real-business goal before building the prompt"
);

const integrationTests = acceptedRun.review.integrationTests
  .map((test) => `${test.status === "passed" ? "PASS" : "FAIL"} ${test.command} (exit ${test.exitCode})`)
  .join("; ");
const coordinatorEvidence = [
  `Accepted run: ${acceptedRun.id}`,
  `Business objective: ${acceptedRun.objective}`,
  `ROOT purpose: ${rootNode.fields.Problem}`,
  `${stageNode.id} problem: ${stageNode.fields.Problem}`,
  `Integration evidence: status=${integrationEvidence.status}, exitCode=${integrationEvidence.exitCode}, assertions=${integrationEvidence.assertions}`,
  `Offline observation: networkUsed=${integrationEvidence.networkUsed}, browserUsed=${integrationEvidence.browserUsed}, humanInputUsed=${integrationEvidence.humanInputUsed}`,
  `Real-business evidence: ${acceptedRun.goalAssessment.realBusinessEvidence}`,
  `Residual gap: ${acceptedRun.goalAssessment.residualGap}`,
  `Goal achieved: ${acceptedRun.goalAssessment.goalAchieved}`
].join("; ");

const prompt = buildAcceptedParallelStateSyncPrompt({
  scopeId: "sync-oracle-business-regression",
  nodeIds: acceptedRun.affectedNodes,
  summary: acceptedRun.summary,
  appliedFiles: acceptedRun.review.appliedFiles,
  integrationTests,
  coordinatorEvidence
});

assertPromptIncludes(prompt, rootNode.fields.Problem, "prompt must carry the fixture's ROOT purpose");
assertPromptIncludes(prompt, stageNode.fields.Problem, "prompt must carry the fixture's N3 problem");
assertPromptIncludes(prompt, acceptedRun.summary, "prompt must carry the accepted-run summary as evidence");
for (const appliedFile of acceptedRun.review.appliedFiles) {
  assertPromptIncludes(prompt, appliedFile, `prompt must carry accepted applied file ${appliedFile}`);
}
assertPromptIncludes(prompt, integrationTests, "prompt must carry the accepted integration-test result");
assertPromptIncludes(
  prompt,
  `Integration evidence: status=${integrationEvidence.status}, exitCode=${integrationEvidence.exitCode}, assertions=${integrationEvidence.assertions}`,
  "prompt must carry locatable integration evidence"
);

assert.match(
  prompt,
  /CurrentResult 必须直接回答根目标和该节点的阶段目标：写明已由证据验证的能力、仍未解决的缺口，以及据此现在是否可以宣称达到目标/,
  "prompt must require both the residual gap and an explicit goal-achievement conclusion"
);
assertPromptIncludes(
  prompt,
  acceptedRun.goalAssessment.residualGap,
  "prompt must preserve the known real-business observation gap"
);
assertPromptIncludes(prompt, "Goal achieved: false", "prompt must carry the fixture's incomplete overall-goal assessment");

assert.match(
  prompt,
  /不得写 ROOT、未列出的节点、flow 顺序或任何 GraphState 字段，也不得移动 GraphState\.Current \/ Next \/ NextPlan \/ ChainForceNext/,
  "prompt must explicitly forbid GraphState writes and focus movement"
);
assert.doesNotMatch(
  prompt,
  /(?:请|必须|需要|应当)(?:更新|修改|写入|移动) GraphState/,
  "prompt must not positively instruct the state-sync worker to modify GraphState"
);

assert.match(
  prompt,
  /仅作为待核验线索.*不得把摘要、文件名、worker 报告或测试通过本身当成目标已达到的证明/,
  "prompt must treat worker reports and accepted-run metadata as leads, not facts"
);
assert.match(
  prompt,
  /禁止复制过程叙述、原始日志、完整测试输出或 worker 报告/,
  "prompt must keep raw worker reports out of persisted node state"
);

assert.match(
  prompt,
  /Completion 只有在证据同时满足该节点阶段目标及其 Metrics 时才能置为已完成/,
  "prompt must gate completion on stage goals and metrics"
);
assert.match(
  prompt,
  /不得仅凭局部测试通过就把 Completion 置为已完成，也不得由接受并行结果推断根目标已经达到/,
  "prompt must not convert local fixture success into false business completion"
);

console.log(
  "PASS accepted parallel state-sync prompt preserves ROOT/N3 semantics, evidence limits, GraphState scope, and the real-business gap"
);
