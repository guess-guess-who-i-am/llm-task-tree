import { createHash } from "node:crypto";

export const CONTEXT_CHECKPOINT_SCHEMA_VERSION = 1;

export const CONTEXT_SECTIONS = Object.freeze([
  ["root_goal", "根本目标"],
  ["product_direction", "产品方向"],
  ["user_constraint", "用户约束与偏好"],
  ["verified_state", "当前状态 / 已验证"],
  ["in_progress_state", "当前状态 / 正在进行"],
  ["decision", "关键决策"],
  ["unresolved_question", "未决问题"],
  ["next_action", "下一动作"],
  ["evidence", "关键证据"],
  ["unknown", "未知项"]
]);

export const CONTEXT_FACT_KINDS = Object.freeze([
  "user_confirmed",
  "model_proposal",
  "verified_fact",
  "superseded",
  "unknown"
]);

const REQUIRED_SECTIONS = new Set(CONTEXT_SECTIONS.map(([key]) => key));
const ALLOWED_SCOPES = new Set(["project", "run", "branch"]);
const ALLOWED_SOURCE_KINDS = new Set(["user_message", "assistant_message", "tree", "evidence"]);
const TRANSIENT_INSTRUCTION_PATTERNS = [
  /当前只生成\s*checkpoint/u,
  /只总结[，,、\s]*(不执行|不要执行)/u,
  /不执行任务[、，,\s]*不调用工具/u,
  /不要开始实现[，,、\s]*等待用户确认/u,
  /先用简短中文回复五项/u,
  /本轮生成\s*checkpoint/u
];
const DERIVED_CHECKPOINT_PATH = /^\.task-tree-maintenance\/context-checkpoint\.(json|md)$/i;

function cleanText(value, max = 4000) {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

function cleanRef(ref = {}) {
  const kind = cleanText(ref.kind, 40);
  return {
    kind,
    threadId: cleanText(ref.threadId, 120),
    turnId: cleanText(ref.turnId, 120),
    treeId: cleanText(ref.treeId, 120),
    nodeId: cleanText(ref.nodeId, 120),
    path: cleanText(ref.path, 500)
  };
}

function cleanFact(fact = {}, index = 0) {
  return {
    id: cleanText(fact.id || `fact-${index + 1}`, 120),
    section: cleanText(fact.section, 80),
    text: cleanText(fact.text, 1800),
    kind: cleanText(fact.kind, 80),
    status: cleanText(fact.status || "active", 40),
    scope: cleanText(fact.scope || "project", 40),
    sourceRefs: (Array.isArray(fact.sourceRefs) ? fact.sourceRefs : []).map(cleanRef),
    evidenceRefs: (Array.isArray(fact.evidenceRefs) ? fact.evidenceRefs : []).map((item) => cleanText(item, 500)).filter(Boolean),
    supersedes: (Array.isArray(fact.supersedes) ? fact.supersedes : []).map((item) => cleanText(item, 120)).filter(Boolean)
  };
}

export function contextTreeFingerprint({ focus = {}, anchors = [] } = {}) {
  const stable = {
    focus: {
      rootPurpose: cleanText(focus.rootPurpose, 1200),
      rootDirection: cleanText(focus.rootDirection, 1600),
      rootSuccess: cleanText(focus.rootSuccess, 1200),
      nodeId: cleanText(focus.nodeId, 120),
      title: cleanText(focus.title, 300),
      nextProblem: cleanText(focus.nextProblem, 1200),
      stageSuccess: cleanText(focus.stageSuccess, 1200),
      nextIdea: cleanText(focus.nextIdea, 1200)
    },
    anchors: (Array.isArray(anchors) ? anchors : []).map((anchor) => ({
      id: cleanText(anchor.id, 120),
      title: cleanText(anchor.title, 300),
      problem: cleanText(anchor.problem, 1200),
      approach: cleanText(anchor.approach, 1600),
      currentResult: cleanText(anchor.currentResult, 1600)
    })).sort((left, right) => left.id.localeCompare(right.id))
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function parseCheckpointModelOutput(output) {
  const text = String(output || "").trim();
  const candidates = [text, text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* try next candidate */ }
      }
    }
  }
  return null;
}

export function compileCheckpointState(output, {
  previousState = null,
  sourceThreadId = "",
  treeFingerprint = ""
} = {}) {
  const parsed = typeof output === "string" ? parseCheckpointModelOutput(output) : output;
  const generation = Math.max(1, Number(previousState?.generation || 0) + 1);
  return {
    schemaVersion: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
    generation,
    sourceThreadId: cleanText(sourceThreadId, 120),
    sourceTreeFingerprint: cleanText(treeFingerprint, 128),
    facts: (Array.isArray(parsed?.facts) ? parsed.facts : []).map(cleanFact)
  };
}

function sourceKey(ref = {}) {
  return [ref.kind, ref.threadId, ref.turnId, ref.treeId, ref.nodeId, ref.path].join("|");
}

function knownUserSources(recent = [], previousState = null) {
  const known = new Set();
  for (const entry of recent || []) {
    if (entry?.turnId) known.add(sourceKey({ kind: "user_message", threadId: entry.threadId || "", turnId: entry.turnId }));
    if (entry?.turnId) known.add(sourceKey({ kind: "user_message", threadId: "", turnId: entry.turnId }));
  }
  for (const fact of previousState?.facts || []) {
    for (const ref of fact.sourceRefs || []) {
      if (ref.kind === "user_message") known.add(sourceKey(ref));
    }
  }
  return known;
}

function isKnownUserSource(ref, known) {
  if (known.has(sourceKey(ref))) return true;
  return known.has(sourceKey({ ...ref, threadId: "" }));
}

export function validateCheckpointState(state, {
  recent = [],
  previousState = null,
  focus = {}
} = {}) {
  const errors = [];
  const facts = Array.isArray(state?.facts) ? state.facts : [];
  if (state?.schemaVersion !== CONTEXT_CHECKPOINT_SCHEMA_VERSION) errors.push("schema_version");
  if (!facts.length) errors.push("facts_empty");

  const ids = new Set();
  const sections = new Set();
  const knownUsers = knownUserSources(recent, previousState);
  let transientLeaks = 0;
  let invalidUserAttribution = 0;
  let unsupportedVerification = 0;
  let derivedEvidenceRefs = 0;

  for (const fact of facts) {
    if (!fact?.id || ids.has(fact.id)) errors.push(`fact_id:${fact?.id || "missing"}`);
    ids.add(fact?.id);
    if (!REQUIRED_SECTIONS.has(fact?.section)) errors.push(`fact_section:${fact?.id || "unknown"}`);
    else sections.add(fact.section);
    if (!fact?.text) errors.push(`fact_text:${fact?.id || "unknown"}`);
    if (!CONTEXT_FACT_KINDS.includes(fact?.kind)) errors.push(`fact_kind:${fact?.id || "unknown"}`);
    if (!ALLOWED_SCOPES.has(fact?.scope)) errors.push(`fact_scope:${fact?.id || "unknown"}`);
    if (!['active', 'superseded'].includes(fact?.status)) errors.push(`fact_status:${fact?.id || "unknown"}`);
    if (TRANSIENT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(String(fact?.text || "")))) transientLeaks += 1;

    const refs = Array.isArray(fact?.sourceRefs) ? fact.sourceRefs : [];
    if (refs.some((ref) => !ALLOWED_SOURCE_KINDS.has(ref.kind))) errors.push(`source_kind:${fact?.id || "unknown"}`);
    if (fact?.kind === "user_confirmed") {
      const userRefs = refs.filter((ref) => ref.kind === "user_message" && ref.turnId);
      if (!userRefs.length || userRefs.some((ref) => !isKnownUserSource(ref, knownUsers))) invalidUserAttribution += 1;
    }
    if (fact?.kind === "verified_fact") {
      const hasEvidence = (fact.evidenceRefs || []).length > 0 || refs.some((ref) => ref.kind === "tree" || ref.kind === "evidence");
      if (!hasEvidence) unsupportedVerification += 1;
    }
    const evidencePaths = [
      ...(fact.evidenceRefs || []),
      ...refs.filter((ref) => ref.kind === "evidence").map((ref) => ref.path)
    ].map((item) => String(item || "").replace(/\\/g, "/"));
    if (evidencePaths.some((item) => DERIVED_CHECKPOINT_PATH.test(item))) derivedEvidenceRefs += 1;
    if (fact?.kind === "superseded" && fact?.status !== "superseded") errors.push(`superseded_status:${fact?.id || "unknown"}`);
  }

  const missingSections = [...REQUIRED_SECTIONS].filter((section) => !sections.has(section));
  if (missingSections.length) errors.push(`missing_sections:${missingSections.join(",")}`);
  if (transientLeaks) errors.push(`transient_instruction:${transientLeaks}`);
  if (invalidUserAttribution) errors.push(`user_attribution:${invalidUserAttribution}`);
  if (unsupportedVerification) errors.push(`verification_evidence:${unsupportedVerification}`);
  if (derivedEvidenceRefs) errors.push(`derived_checkpoint_evidence:${derivedEvidenceRefs}`);

  const currentNode = cleanText(focus?.nodeId, 120);
  const currentNodeCovered = !currentNode || facts.some((fact) =>
    fact.section === "in_progress_state"
    && (fact.text.includes(currentNode) || (fact.sourceRefs || []).some((ref) => ref.kind === "tree" && ref.nodeId === currentNode))
  );
  if (!currentNodeCovered) errors.push(`current_node:${currentNode}`);

  return {
    ok: errors.length === 0,
    errors,
    factCount: facts.length,
    missingSections,
    transientLeaks,
    invalidUserAttribution,
    unsupportedVerification,
    derivedEvidenceRefs,
    currentNodeCovered
  };
}

function sourceLabel(ref = {}) {
  if (ref.kind === "user_message") return `用户消息 ${ref.threadId ? `${ref.threadId}/` : ""}${ref.turnId}`;
  if (ref.kind === "assistant_message") return `模型消息 ${ref.threadId ? `${ref.threadId}/` : ""}${ref.turnId}`;
  if (ref.kind === "tree") return `任务树 ${ref.treeId ? `${ref.treeId}/` : ""}${ref.nodeId}`;
  return ref.path ? `证据 ${ref.path}` : "证据入口";
}

function factLine(fact) {
  const kindLabel = {
    user_confirmed: "用户确认",
    model_proposal: "模型建议",
    verified_fact: "已验证",
    superseded: "已取代",
    unknown: "未知"
  }[fact.kind] || fact.kind;
  const refs = (fact.sourceRefs || []).map(sourceLabel).filter(Boolean);
  const evidence = (fact.evidenceRefs || []).map((item) => `证据 ${item}`);
  const labels = [...new Set([...refs, ...evidence])];
  const suffix = labels.length ? `（来源：${labels.join("；")}）` : "";
  return `- [${kindLabel}] ${fact.text}${suffix}`;
}

export function renderCheckpointMarkdown(state) {
  const bySection = new Map(CONTEXT_SECTIONS.map(([key]) => [key, []]));
  for (const fact of state?.facts || []) {
    if (bySection.has(fact.section)) bySection.get(fact.section).push(fact);
  }
  const section = (key, title) => [`## ${title}`, ...(bySection.get(key) || []).map(factLine)].join("\n");
  return [
    section("root_goal", "根本目标"),
    section("product_direction", "产品方向"),
    section("user_constraint", "用户约束与偏好"),
    "## 当前状态",
    "### 已验证",
    ...(bySection.get("verified_state") || []).map(factLine),
    "### 正在进行",
    ...(bySection.get("in_progress_state") || []).map(factLine),
    section("decision", "关键决策"),
    section("unresolved_question", "未决问题"),
    section("next_action", "下一动作"),
    section("evidence", "关键证据"),
    section("unknown", "未知项")
  ].join("\n\n").trim();
}

export function canReuseCheckpoint(state, { recent = [], treeFingerprint = "", focus = {} } = {}) {
  if ((recent || []).length) return { ok: false, reason: "new_user_evidence" };
  if (!state) return { ok: false, reason: "missing_state" };
  if (state.schemaVersion !== CONTEXT_CHECKPOINT_SCHEMA_VERSION) return { ok: false, reason: "schema_changed" };
  if (!treeFingerprint || state.sourceTreeFingerprint !== treeFingerprint) return { ok: false, reason: "tree_changed" };
  const inspection = validateCheckpointState(state, { previousState: state, focus });
  return inspection.ok ? { ok: true, reason: "unchanged" } : { ok: false, reason: "invalid_state", inspection };
}
