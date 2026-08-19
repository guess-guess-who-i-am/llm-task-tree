/**
 * What the task graph's Codex button actually sends.
 *
 * The prompts are built from the live tree instead of being typed by the user, because the two
 * things that make a turn useful — which node is Next and what its NextIdea says — are exactly the
 * things that go stale in a hand-written prompt. Keeping them pure keeps them testable: the server
 * reads the tree, these functions decide the wording.
 */

/** Asks the model for the widget and nothing else, so the turn stays as small as it can be. */
export const OPEN_GRAPH_PROMPT = "调用 task_tree_open 打开任务图。只做这一件事，不要解释，不要调用其它工具。";

export const PRESETS = ["open", "next", "chain"];

/** Keep accepted-run state sync inside the nodes that the parallel jobs actually owned. */
export function resolveAcceptedParallelNodeIds({ sourceNodeIds = [], reportedNodeIds } = {}) {
  const unique = (values) => [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  const source = unique(sourceNodeIds);
  const reported = unique(reportedNodeIds);
  const scoped = reported.filter((nodeId) => source.includes(nodeId));
  return scoped.length ? scoped : source;
}

/**
 * Reconciles an accepted parallel run with the scoped task-tree nodes. The inputs are evidence
 * leads, not completion claims; the state-sync turn must verify them against the tree's goals.
 */
export function buildAcceptedParallelStateSyncPrompt({
  scopeId,
  nodeIds = [],
  summary,
  appliedFiles = [],
  integrationTests,
  coordinatorEvidence
} = {}) {
  const writableNodes = [...new Set(nodeIds.map((nodeId) => String(nodeId || "").trim()).filter(Boolean))];
  const nodeList = writableNodes.join(", ") || "none";

  return [
    "【Task Tree · Accepted Parallel Run State Sync】",
    `Execution scope: ${String(scopeId || "(missing)").trim()}; writable nodes: ${nodeList}`,
    `Accepted result: ${String(summary || "(not provided)").trim()}`,
    `Applied files: ${appliedFiles.join(", ") || "none"}`,
    `Integration tests: ${String(integrationTests || "未配置集成命令").trim()}`,
    coordinatorEvidence ? `Coordinator evidence: ${String(coordinatorEvidence).trim()}` : "",
    "",
    `先用 task_tree_focus 读取 ROOT 的 Problem / Approach / Metrics，再读取受限节点 ${nodeList} 的 Problem / Approach / Metrics；ROOT 定义根目标，受限节点定义当前阶段目标与完成判据。ROOT 只读。`,
    "把 Accepted result、Applied files、Integration tests 和 Coordinator evidence 仅作为待核验线索；对照实际产物、测试输出、根目标和阶段目标判断证据是否充分，不得把摘要、文件名、worker 报告或测试通过本身当成目标已达到的证明。",
    `只允许用 task_tree_write 写受限节点 ${nodeList}，不得写 ROOT、未列出的节点、flow 顺序或任何 GraphState 字段，也不得移动 GraphState.Current / Next / NextPlan / ChainForceNext。`,
    "每个受限节点的 CurrentResult 必须直接回答根目标和该节点的阶段目标：写明已由证据验证的能力、仍未解决的缺口，以及据此现在是否可以宣称达到目标。不要用计划、实现描述或空泛进展代替结论。",
    "Completion 只有在证据同时满足该节点阶段目标及其 Metrics 时才能置为已完成；局部单元测试或集成测试通过只证明对应检查，不得仅凭局部测试通过就把 Completion 置为已完成，也不得由接受并行结果推断根目标已经达到。",
    "NextIdea 必须替换为下一条可执行的未决动作，并明确它要关闭的剩余缺口；若已无未决动作，必须以达到阶段目标的充分证据为依据，不能编造后续动作。",
    "节点中只保留精炼结论和短证据引用；禁止复制过程叙述、原始日志、完整测试输出或 worker 报告。",
    "写入成功后，只报告工具返回的 persisted changes，逐项给出 old -> new；不报告未落盘或未变化的字段。"
  ].filter(Boolean).join("\n");
}

/**
 * One step on the Next node. Repeats the two rules that are easy to break from a fresh context:
 * NextPlan is the user's memo and must not be executed, and focus is the user's to move.
 */
export function buildNextStepPrompt({
  nodeId,
  title,
  nextIdea,
  rootPurpose,
  rootDirection,
  rootSuccess,
  nextProblem,
  stageSuccess
} = {}) {
  const idea = (nextIdea || "").trim();
  if (!nodeId) return { prompt: "", blocked: "任务图里没有 Next 节点，先在界面上把 Next 指到一个节点。" };
  if (!idea) return { prompt: "", blocked: `Next 节点 ${nodeId} 没写 NextIdea（下一步思路），没有可执行的依据。` };

  return {
    prompt: [
      "【任务图 · 执行下一步】",
      `Next: ${nodeId}${title ? ` - ${title}` : ""}`,
      `Root purpose: ${String(rootPurpose || "(not recorded)").trim()}`,
      `Project direction: ${String(rootDirection || "(not recorded)").trim()}`,
      `Success test: ${String(rootSuccess || "(not recorded)").trim()}`,
      nextProblem ? `Active stage goal: ${String(nextProblem).trim()}` : "",
      stageSuccess ? `Active stage success test: ${String(stageSuccess).trim()}` : "",
      `NextIdea: ${idea}`,
      "",
      "先用最新用户要求和当前项目产物核对这条 NextIdea。若它已完成或过期，不要重做；先用 task_tree_write 写入测量后的统一结果，并把该节点的 NextIdea 替换为下一个未解决动作。",
      "先确认本轮动作如何推进 Root purpose；若无法说明关系，不要为了让局部任务显得合理而编造因果，先记录不匹配并请求澄清。",
      "核对后本轮只做一个未解决的连贯工作单元。执行依据是有效的 NextIdea，不要去读 GraphState.NextPlan（那是用户备忘，可能过期）。",
      "不要改 GraphState 的 Current / Next / NextPlan。",
      "只把已读取或已运行证据验证过的事实写成完成；计划、文件名、截图或预期设计都不能单独证明完成。",
      "节点语义字段只写简明中文结论；可保留 LLM、token、API、必要名称、ID 和路径。代码、JSON、命令、公式、原始数据、日志和复杂英文术语放进证据文件，不要写进节点。",
      "CurrentResult 必须直接回答用户的根本目标或当前阶段目标：保留用户目标原意，说明现已具备的能力或证据、仍缺的部分，以及因此现在能否宣称达到目标。数字可选；不能只写“已有方向性进展”等空泛判断，最多保留 3 个影响决策的事实，具体实现放证据。",
      "NextIdea 可以具体，但必须说明它服务的方向和完成判据；不要把具体执行动作当成项目方向。",
      `每得到一个可独立验证的结果、决策、失败或阻塞，立即用 task_tree_write 写进 ${nodeId} 的相应字段，再开始另一个单元；不要等到整轮结束。`,
      "每次任务树或子树写入成功后，只根据写入结果中的 changes 向用户逐项报告实际变化，格式为“节点 / 字段：旧值 → 新值”；不要凭记忆或请求参数推断，也不要报告未变化或被保护的字段。"
    ].join("\n"),
    blocked: ""
  };
}

/**
 * One step of the chain loop. The server already computes the loop's own prompt and its stop
 * condition, so this only decides whether sending is honest: a chain that should stop gets the
 * reason handed back instead of a turn that would spin on nothing.
 */
export function buildChainPrompt({ agentPrompt, shouldStopLoop, stopReason } = {}) {
  if (shouldStopLoop) return { prompt: "", blocked: `链式循环现在该停：${stopReason || "未说明原因"}。` };
  const body = (agentPrompt || "").trim();
  if (!body) return { prompt: "", blocked: "拿不到链式单步的上下文。" };
  return { prompt: `【任务图 · 链式循环】\n${body}`, blocked: "" };
}

/**
 * @param {"open"|"next"|"chain"} preset
 * @param {{focus?: object, chain?: object}} live state read from the tree
 */
export function buildPresetPrompt(preset, { focus = {}, chain = {} } = {}) {
  if (preset === "next") {
    return buildNextStepPrompt({
      nodeId: focus.nodeId,
      title: focus.title,
      nextIdea: focus.nextIdea,
      rootPurpose: focus.rootPurpose,
      rootDirection: focus.rootDirection,
      rootSuccess: focus.rootSuccess,
      nextProblem: focus.nextProblem,
      stageSuccess: focus.stageSuccess
    });
  }
  if (preset === "chain") {
    return buildChainPrompt(chain);
  }
  return { prompt: OPEN_GRAPH_PROMPT, blocked: "" };
}

/** Menu entries, with the reason a disabled one is disabled, so the UI never guesses. */
export function describePresets({ focus = {}, chain = {} } = {}) {
  const next = buildNextStepPrompt({
    nodeId: focus.nodeId,
    title: focus.title,
    nextIdea: focus.nextIdea,
    rootPurpose: focus.rootPurpose,
    rootDirection: focus.rootDirection,
    rootSuccess: focus.rootSuccess,
    nextProblem: focus.nextProblem,
    stageSuccess: focus.stageSuccess
  });
  const loop = buildChainPrompt(chain);
  return [
    { id: "open", label: "打开任务图", hint: "只把可交互界面放进对话，不动树", blocked: "" },
    {
      id: "next",
      label: focus.nodeId ? `执行下一步：${focus.nodeId}` : "执行下一步",
      hint: focus.title || "",
      blocked: next.blocked
    },
    { id: "chain", label: "链式循环推进一步", hint: chain.position || "", blocked: loop.blocked }
  ];
}
