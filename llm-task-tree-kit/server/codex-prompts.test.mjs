import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAcceptedParallelStateSyncPrompt,
  resolveAcceptedParallelNodeIds
} from "./codex-prompts.js";

function buildPrompt() {
  return buildAcceptedParallelStateSyncPrompt({
    scopeId: "scope-sync-prompt",
    nodeIds: ["N3", "N3"],
    summary: "并行实现已接受",
    appliedFiles: ["server.js", "server/codex-prompts.js"],
    integrationTests: "PASS node --test server/codex-prompts.test.mjs",
    coordinatorEvidence: "纯函数单元断言通过"
  });
}

test("accepted-run sync prompt anchors state to the root and N3 stage goals", () => {
  const prompt = buildPrompt();

  assert.match(prompt, /ROOT 的 Problem \/ Approach \/ Metrics/);
  assert.match(prompt, /受限节点 N3 的 Problem \/ Approach \/ Metrics/);
  assert.match(prompt, /ROOT 定义根目标.*受限节点定义当前阶段目标与完成判据/);
  assert.match(prompt, /ROOT 只读/);
  assert.match(prompt, /CurrentResult.*根目标.*阶段目标/);
  assert.match(prompt, /已由证据验证的能力、仍未解决的缺口.*是否可以宣称达到目标/);
});

test("accepted-run sync prompt carries evidence without treating it as proof", () => {
  const prompt = buildPrompt();

  assert.match(prompt, /Accepted result: 并行实现已接受/);
  assert.match(prompt, /Applied files: server\.js, server\/codex-prompts\.js/);
  assert.match(prompt, /Integration tests: PASS node --test/);
  assert.match(prompt, /Coordinator evidence: 纯函数单元断言通过/);
  assert.match(prompt, /仅作为待核验线索/);
  assert.match(prompt, /摘要、文件名、worker 报告或测试通过本身.*目标已达到的证明/);
});

test("accepted-run sync prompt prevents local success from becoming false completion", () => {
  const prompt = buildPrompt();

  assert.match(prompt, /Completion 只有在证据同时满足该节点阶段目标及其 Metrics 时才能置为已完成/);
  assert.match(prompt, /不得仅凭局部测试通过就把 Completion 置为已完成/);
  assert.match(prompt, /不得由接受并行结果推断根目标已经达到/);
  assert.match(prompt, /NextIdea 必须替换为下一条可执行的未决动作/);
});

test("accepted-run sync prompt preserves scope and excludes raw records", () => {
  const prompt = buildPrompt();

  assert.match(prompt, /writable nodes: N3/);
  assert.doesNotMatch(prompt, /writable nodes: N3, N3/);
  assert.match(prompt, /只允许用 task_tree_write 写受限节点 N3/);
  assert.match(prompt, /不得写 ROOT、未列出的节点、flow 顺序或任何 GraphState 字段/);
  assert.match(prompt, /不得移动 GraphState\.Current \/ Next \/ NextPlan \/ ChainForceNext/);
  assert.match(prompt, /禁止复制过程叙述、原始日志、完整测试输出或 worker 报告/);
});

test("accepted-run node scope cannot expand beyond the parallel job sources", () => {
  assert.deepEqual(
    resolveAcceptedParallelNodeIds({
      sourceNodeIds: ["N3", "N3"],
      reportedNodeIds: ["N2", "N3", "N4"]
    }),
    ["N3"]
  );
  assert.deepEqual(
    resolveAcceptedParallelNodeIds({
      sourceNodeIds: ["N3"],
      reportedNodeIds: ["N2"]
    }),
    ["N3"]
  );
});
