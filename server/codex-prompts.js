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
