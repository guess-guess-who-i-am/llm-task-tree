import {
  CONTEXT_CHECKPOINT_SCHEMA_VERSION,
  CONTEXT_FACT_KINDS,
  CONTEXT_SECTIONS,
  renderCheckpointMarkdown
} from "./context-checkpoint.js";

function cleanText(value, max = 4000) {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

function itemText(item) {
  if (!item) return "";
  if (item.type === "userMessage") {
    return (item.content || []).map((part) => part?.text || "").join("\n").trim();
  }
  return item.type === "agentMessage" ? String(item.text || "").trim() : "";
}

function isSyntheticUserMessage(text) {
  const value = String(text || "").trim();
  return /^<codex_delegation>[\s\S]*<\/codex_delegation>$/i.test(value)
    || /^<in-app-browser-context[\s\S]*<\/in-app-browser-context>$/i.test(value)
    || value.startsWith("这是一次项目上下文换代。不要猜测旧聊天")
    || value.startsWith("【Project Context Checkpoint】");
}

function isContinuationOnly(text) {
  return /^(请)?继续[，。,.!！?？\s]*$/u.test(String(text || "").trim());
}

/**
 * Keeps exact recent requirements beside the generated summary. This is deliberately lossless:
 * a later user correction must still be visible if the summarizer mistakenly preserves an older
 * decision. Tool logs and reasoning are excluded because they do not define the user's intent.
 */
export function extractRecentConversation(thread, { maxTurns = 6, maxChars = 9000 } = {}) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const selected = [];
  let used = 0;

  for (let index = turns.length - 1; index >= 0 && selected.length < maxTurns; index -= 1) {
    const turn = turns[index];
    const userMessages = (turn?.items || [])
      .filter((item) => item?.type === "userMessage")
      .map(itemText);
    const meaningfulUserMessages = userMessages
      .filter((text) => text && !isSyntheticUserMessage(text) && !isContinuationOnly(text))
    if (userMessages.length && !meaningfulUserMessages.length) continue;
    const user = meaningfulUserMessages.join("\n");
    const assistants = (turn?.items || []).filter((item) => item?.type === "agentMessage" && item.phase === "final_answer").map(itemText).filter(Boolean);
    const assistant = assistants.at(-1) || "";
    if (!user && !assistant) continue;

    const entry = {
      turnId: String(turn?.id || ""),
      user: cleanText(user, 1800),
      assistantConclusion: cleanText(assistant, 2600)
    };
    const cost = entry.user.length + entry.assistantConclusion.length;
    if (selected.length && used + cost > maxChars) break;
    selected.unshift(entry);
    used += cost;
  }
  return selected;
}

function formatAnchors(anchors = []) {
  if (!anchors.length) return "- （没有额外的长期树锚点）";
  return anchors.map((anchor) => [
    `- ${cleanText(anchor.title || anchor.id, 100)}`,
    anchor.problem ? `  - 问题：${cleanText(anchor.problem, 500)}` : "",
    anchor.approach ? `  - 当前方法：${cleanText(anchor.approach, 900)}` : "",
    anchor.currentResult ? `  - 当前结论：${cleanText(anchor.currentResult, 900)}` : ""
  ].filter(Boolean).join("\n")).join("\n");
}

function formatRecent(entries = []) {
  if (!entries.length) return "（未能读取最近对话；不得据此编造用户决定）";
  return entries.map((entry, index) => [
    `### 最近对话 ${index + 1} · turnId=${entry.turnId || "unknown"}`,
    entry.user ? `用户原话：${entry.user}` : "",
    entry.assistantConclusion ? `当轮结论（仍需服从更新的用户原话）：${entry.assistantConclusion}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
}

export function buildContextCheckpointPrompt({ focus = {}, anchors = [], recent = [], previousState = null } = {}) {
  const schema = {
    facts: [{
      id: "stable-fact-id",
      section: CONTEXT_SECTIONS.map(([key]) => key).join("|"),
      text: "会改变后续行动的一条短事实",
      kind: CONTEXT_FACT_KINDS.join("|"),
      status: "active|superseded",
      scope: "project|run|branch",
      sourceRefs: [{ kind: "user_message|assistant_message|tree|evidence", threadId: "", turnId: "", treeId: "", nodeId: "", path: "" }],
      evidenceRefs: ["project-relative evidence path"],
      supersedes: ["older-fact-id"]
    }]
  };
  return [
    "【Project Context Checkpoint】",
    `你正在为一个全新的 LLM 对话编译 schema v${CONTEXT_CHECKPOINT_SCHEMA_VERSION} 的项目 checkpoint。只输出 JSON，不执行任务，不调用工具，不修改文件。`,
    "",
    "目标不是复述聊天，而是把会改变下一次行动的状态编译为可验证事实。必须遵守：",
    "1. 这是增量编译。上一代仍有效的事实必须保留原 id 和来源；最新用户要求覆盖更早计划。旧结论会误导后续时，保留为 kind=superseded、status=superseded，并用 supersedes 连接。",
    "2. 只有下面列出的真实用户 turnId 能新建 kind=user_confirmed；assistant 结论只能是 model_proposal，除非另有树或证据证明为 verified_fact。",
    "3. verified_fact 必须带 tree/evidence sourceRef 或 evidenceRefs。没有证据时写 unknown，不得仅凭模型总结声称已验证。context-checkpoint.json/md 是派生交接状态，绝不能作为事实证据或形成自证循环。",
    "4. 本段关于‘只输出 JSON、不执行任务、不调用工具’的生成器指令是 temporary_instruction，绝不能进入用户约束、产品方向、决定或任何持久 fact。",
    "5. `<codex_delegation>`、浏览器环境、自动续接、工具日志和只有‘继续’的轮次不在证据中，不得恢复成用户事实。",
    "6. 产品方向不得被当前具体节点吞掉；当前节点也不得被宏观方向替代。in_progress_state 必须引用当前任务树节点。",
    "7. 省略过程叙述、失败重试和不影响下一行动的细节。会话链接只是导航，不是事实证据。",
    "",
    "每个 section 至少一个事实。只输出一个 JSON 对象，不要 Markdown、代码围栏或额外说明。精炼由事实数量和后续行动相关性控制，不以凑字数为质量标准。结构：",
    JSON.stringify(schema),
    "",
    "上一代结构化 checkpoint（没有新证据推翻时必须继承；若为空则是首次换代）：",
    previousState ? cleanText(JSON.stringify(previousState), 24000) : "（首次换代，无上一代 checkpoint）",
    "",
    "任务树确定性锚点：",
    `- 根本目标：${cleanText(focus.rootPurpose, 700) || "未记录"}`,
    `- 根本方向：${cleanText(focus.rootDirection, 900) || "未记录"}`,
    `- 成功依据：${cleanText(focus.rootSuccess, 700) || "未记录"}`,
    `- 当前节点：${cleanText(`${focus.nodeId || ""} ${focus.title || ""}`, 160) || "未记录"}`,
    `- 当前问题：${cleanText(focus.nextProblem, 700) || "未记录"}`,
    `- 下一动作：${cleanText(focus.nextIdea, 700) || "未记录"}`,
    "",
    "按需长期树锚点：",
    formatAnchors(anchors),
    "",
    "最近对话的精确证据（越靠后越新；用户原话优先级最高）：",
    formatRecent(recent)
  ].join("\n");
}

export function buildContextResumePrompt({ checkpointState = null, checkpoint = "", focus = {}, anchors = [], recent = [], sourceThreadId = "" } = {}) {
  const view = checkpoint || renderCheckpointMarkdown(checkpointState);
  return [
    "这是一次项目上下文换代。不要猜测旧聊天；以下 checkpoint、最近用户原话和任务树是续接依据。",
    "进入项目后先用 task_tree_focus 核对 Current/Next；GraphState.NextPlan 是可能过期的用户备忘，不得执行。",
    "如果 checkpoint 与最近用户原话冲突，以最近用户原话为准；如果与当前任务树的执行状态冲突，以当前树为准并指出差异。",
    "",
    "# 结构化 checkpoint",
    cleanText(view, 16000),
    "",
    "# 当前确定性锚点",
    `- 根本目标：${cleanText(focus.rootPurpose, 700) || "未记录"}`,
    `- 当前节点：${cleanText(`${focus.nodeId || ""} ${focus.title || ""}`, 160) || "未记录"}`,
    `- 当前问题：${cleanText(focus.nextProblem, 700) || "未记录"}`,
    `- 下一动作：${cleanText(focus.nextIdea, 700) || "未记录"}`,
    formatAnchors(anchors),
    "",
    "# 最近用户原话（用于知识更新与纠错）",
    recent.map((entry) => `- ${entry.user}`).filter((line) => line !== "- ").join("\n") || "- 未读取到；不要编造",
    "",
    sourceThreadId ? `旧对话 ID：${sourceThreadId}（只作追溯，不要重新加载全部历史）` : "",
    "",
    "先用简短中文回复五项：根本目标、最新产品方向、当前进度、未决问题、下一动作。不要开始实现，等待用户确认。"
  ].filter(Boolean).join("\n");
}
