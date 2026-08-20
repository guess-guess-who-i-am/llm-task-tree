import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextCheckpointPrompt,
  buildContextResumePrompt,
  extractRecentConversation
} from "./context-handoff.js";
import {
  canReuseCheckpoint,
  compileCheckpointState,
  contextTreeFingerprint,
  renderCheckpointMarkdown,
  validateCheckpointState
} from "./context-checkpoint.js";

const thread = {
  turns: [
    {
      id: "old",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "先把它做成一个任务树查看器。" }] },
        { type: "agentMessage", phase: "final_answer", text: "当前定位是任务树查看器。" }
      ]
    },
    {
      id: "latest",
      items: [
        { type: "reasoning", summary: ["不应进入 checkpoint"] },
        { type: "userMessage", content: [{ type: "text", text: "现在更像 Agent IDE；任务树和 Supervisor 才是特色，不要复刻 VS Code。" }] },
        { type: "commandExecution", command: "secret --flag" },
        { type: "agentMessage", phase: "final_answer", text: "产品方向是 Agent IDE 控制面；优先补事件流、实时执行和上下文编译器。" }
      ]
    },
    {
      id: "synthetic",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "<codex_delegation>\n<input>系统转发，不是用户确认</input>\n</codex_delegation>" }] },
        { type: "agentMessage", phase: "final_answer", text: "已记录" }
      ]
    },
    {
      id: "generated-resume",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "这是一次项目上下文换代。不要猜测旧聊天；以下 checkpoint 是续接依据。" }] },
        { type: "agentMessage", phase: "final_answer", text: "根本目标与产品方向已恢复。" }
      ]
    }
  ]
};

const focus = {
  rootPurpose: "让用户快速理解、纠正并持续维护模型的工作状态",
  rootDirection: "任务图作为外部认知工作台",
  rootSuccess: "换对话后仍保持目标和纠错能力",
  nodeId: "N3",
  title: "维护上下文",
  nextProblem: "如何换代而不丢产品方向？",
  stageSuccess: "三代连续纠错仍准确",
  nextIdea: "用新旧摘要做真实对照实验"
};

const ref = (turnId) => [{ kind: "user_message", threadId: "", turnId, treeId: "", nodeId: "", path: "" }];
const treeRef = (nodeId) => [{ kind: "tree", threadId: "", turnId: "", treeId: "method", nodeId, path: "task-tree.md" }];

function validFacts() {
  return [
    { id: "goal", section: "root_goal", text: "让用户快速理解、纠正并持续维护模型的工作状态。", kind: "verified_fact", status: "active", scope: "project", sourceRefs: treeRef("ROOT"), evidenceRefs: [], supersedes: [] },
    { id: "direction", section: "product_direction", text: "形成以任务树和 Supervisor 为核心的 Agent IDE。", kind: "user_confirmed", status: "active", scope: "project", sourceRefs: ref("latest"), evidenceRefs: [], supersedes: ["old-viewer"] },
    { id: "constraint", section: "user_constraint", text: "不要复刻 VS Code。", kind: "user_confirmed", status: "active", scope: "project", sourceRefs: ref("latest"), evidenceRefs: [], supersedes: [] },
    { id: "verified", section: "verified_state", text: "任务树和 Supervisor 已有代码与测试。", kind: "verified_fact", status: "active", scope: "project", sourceRefs: [{ kind: "evidence", threadId: "", turnId: "", treeId: "", nodeId: "", path: "server/codex-supervisor.test.js" }], evidenceRefs: ["server/codex-supervisor.test.js"], supersedes: [] },
    { id: "progress", section: "in_progress_state", text: "N3 正在验证上下文换代。", kind: "verified_fact", status: "active", scope: "project", sourceRefs: treeRef("N3"), evidenceRefs: [], supersedes: [] },
    { id: "decision", section: "decision", text: "产品方向由查看器更新为 Agent IDE。", kind: "user_confirmed", status: "active", scope: "project", sourceRefs: ref("latest"), evidenceRefs: [], supersedes: ["old-viewer"] },
    { id: "old-viewer", section: "decision", text: "把产品只定位为任务树查看器。", kind: "superseded", status: "superseded", scope: "project", sourceRefs: ref("old"), evidenceRefs: [], supersedes: [] },
    { id: "open", section: "unresolved_question", text: "长期业务中是否持续抓住最新方向仍未验证。", kind: "unknown", status: "active", scope: "project", sourceRefs: [], evidenceRefs: [], supersedes: [] },
    { id: "next", section: "next_action", text: "进行三代方向纠错实验。", kind: "model_proposal", status: "active", scope: "project", sourceRefs: [{ kind: "assistant_message", threadId: "", turnId: "latest", treeId: "", nodeId: "", path: "" }], evidenceRefs: [], supersedes: [] },
    { id: "evidence", section: "evidence", text: "上下文和 Supervisor 测试是当前证据入口。", kind: "verified_fact", status: "active", scope: "project", sourceRefs: [{ kind: "evidence", threadId: "", turnId: "", treeId: "", nodeId: "", path: "server/context-handoff.test.js" }], evidenceRefs: ["server/context-handoff.test.js"], supersedes: [] },
    { id: "unknown", section: "unknown", text: "尚不知道真实三代业务的错误继承率。", kind: "unknown", status: "active", scope: "project", sourceRefs: [], evidenceRefs: [], supersedes: [] }
  ];
}

test("recent checkpoint evidence preserves latest user corrections and excludes logs", () => {
  const recent = extractRecentConversation(thread);
  assert.equal(recent.length, 2);
  assert.match(recent.at(-1).user, /Agent IDE/);
  assert.equal(recent.at(-1).turnId, "latest");
  assert.match(recent.at(-1).assistantConclusion, /上下文编译器/);
  assert.doesNotMatch(JSON.stringify(recent), /secret|不应进入|系统转发/);
});

test("checkpoint prompt defines one source-aware JSON contract", () => {
  const recent = extractRecentConversation(thread);
  const previousState = { schemaVersion: 1, generation: 1, facts: validFacts() };
  const prompt = buildContextCheckpointPrompt({
    focus,
    anchors: [{ id: "architecture", title: "稳定架构", problem: "怎样形成 Agent IDE 控制面？", currentResult: "已有任务图和 Supervisor" }],
    recent,
    previousState
  });
  assert.match(prompt, /sourceRefs/);
  assert.match(prompt, /temporary_instruction/);
  assert.match(prompt, /turnId=latest/);
  assert.match(prompt, /最新用户要求覆盖更早计划/);
  assert.match(prompt, /N3 维护上下文/);
  assert.match(prompt, /上一代结构化 checkpoint/);
  assert.doesNotMatch(prompt, /控制在 1800 个中文字以内/);
});

test("structured checkpoint accepts sourced facts and renders a readable view", () => {
  const recent = extractRecentConversation(thread);
  const fingerprint = contextTreeFingerprint({ focus });
  const state = compileCheckpointState({ facts: validFacts() }, { sourceThreadId: "thread-old", treeFingerprint: fingerprint });
  const inspection = validateCheckpointState(state, { recent, focus });
  assert.equal(inspection.ok, true, inspection.errors.join(","));
  const markdown = renderCheckpointMarkdown(state);
  assert.match(markdown, /## 产品方向/);
  assert.match(markdown, /\[用户确认\].*Agent IDE/);
  assert.match(markdown, /用户消息 latest/);
  assert.match(markdown, /## 未知项/);
  assert.equal(markdown.match(/server\/codex-supervisor\.test\.js/g)?.length, 1);
});

test("fact gate rejects fluent hallucinations, transient instructions and unsupported verification", () => {
  const recent = extractRecentConversation(thread);
  const facts = validFacts();
  facts.find((fact) => fact.id === "direction").sourceRefs = [{ kind: "user_message", threadId: "", turnId: "invented" }];
  facts.find((fact) => fact.id === "constraint").text = "当前只生成 checkpoint，不执行任务、不调用工具。";
  const verified = facts.find((fact) => fact.id === "verified");
  verified.sourceRefs = [];
  verified.evidenceRefs = [];
  const state = compileCheckpointState({ facts }, { sourceThreadId: "thread-old", treeFingerprint: contextTreeFingerprint({ focus }) });
  const inspection = validateCheckpointState(state, { recent, focus });
  assert.equal(inspection.ok, false);
  assert.equal(inspection.invalidUserAttribution, 1);
  assert.equal(inspection.transientLeaks, 1);
  assert.equal(inspection.unsupportedVerification, 1);
});

test("derived checkpoint files cannot verify their own claims", () => {
  const recent = extractRecentConversation(thread);
  const facts = validFacts();
  const evidence = facts.find((fact) => fact.id === "evidence");
  evidence.sourceRefs = [{ kind: "evidence", threadId: "", turnId: "", treeId: "", nodeId: "", path: ".task-tree-maintenance/context-checkpoint.md" }];
  evidence.evidenceRefs = [".task-tree-maintenance/context-checkpoint.md"];
  const state = compileCheckpointState({ facts }, { sourceThreadId: "thread-old", treeFingerprint: contextTreeFingerprint({ focus }) });
  const inspection = validateCheckpointState(state, { recent, focus });
  assert.equal(inspection.ok, false);
  assert.equal(inspection.derivedEvidenceRefs, 1);
});

test("old product direction remains superseded beside the latest user correction", () => {
  const recent = extractRecentConversation(thread);
  const state = compileCheckpointState({ facts: validFacts() }, { sourceThreadId: "thread-old", treeFingerprint: contextTreeFingerprint({ focus }) });
  const active = state.facts.find((fact) => fact.id === "direction");
  const old = state.facts.find((fact) => fact.id === "old-viewer");
  assert.equal(active.kind, "user_confirmed");
  assert.deepEqual(active.supersedes, ["old-viewer"]);
  assert.equal(old.kind, "superseded");
  assert.equal(old.status, "superseded");
  assert.equal(validateCheckpointState(state, { recent, focus }).ok, true);
});

test("checkpoint reuse is invalidated by new user evidence or a changed tree anchor", () => {
  const recent = extractRecentConversation(thread);
  const fingerprint = contextTreeFingerprint({ focus });
  const state = compileCheckpointState({ facts: validFacts() }, { sourceThreadId: "thread-old", treeFingerprint: fingerprint });
  assert.equal(canReuseCheckpoint(state, { recent: [], treeFingerprint: fingerprint, focus }).ok, true);
  assert.equal(canReuseCheckpoint(state, { recent, treeFingerprint: fingerprint, focus }).reason, "new_user_evidence");
  const changedFocus = { ...focus, nextIdea: "新的真实下一动作" };
  const changed = contextTreeFingerprint({ focus: changedFocus });
  assert.equal(canReuseCheckpoint(state, { recent: [], treeFingerprint: changed, focus: changedFocus }).reason, "tree_changed");
});

test("resume prompt carries the generated view and exact latest user wording", () => {
  const recent = extractRecentConversation(thread);
  const state = compileCheckpointState({ facts: validFacts() }, { sourceThreadId: "thread-old", treeFingerprint: contextTreeFingerprint({ focus }) });
  const prompt = buildContextResumePrompt({ checkpointState: state, focus, recent, sourceThreadId: "thread-old" });
  assert.match(prompt, /最近用户原话/);
  assert.match(prompt, /不要复刻 VS Code/);
  assert.match(prompt, /checkpoint 与最近用户原话冲突，以最近用户原话为准/);
  assert.match(prompt, /thread-old/);
});
