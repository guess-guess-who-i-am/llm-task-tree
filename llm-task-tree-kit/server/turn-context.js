import { parseFlowMarkdown } from "./flow-script.js";
import { parseTreeNodeFields } from "./tree-quality.js";

function oneLine(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function extractTaskTreeTurnFocus({ activeTree = {}, markdown = "" } = {}) {
  const parsed = parseFlowMarkdown(markdown);
  const nodes = parseTreeNodeFields(markdown);
  const nextId = parsed.graphState.next || "";
  const currentId = parsed.graphState.current || "";
  const rootNode = nodes.find((node) => node.id === "ROOT") || null;
  const currentNode = nodes.find((node) => node.id === currentId) || null;
  const nextNode = nodes.find((node) => node.id === nextId) || null;

  return {
    activeTreeId: oneLine(activeTree.id || "method", 80),
    activeTreeTitle: oneLine(activeTree.title || "", 120),
    activeTreePath: oneLine(activeTree.path || "task-tree.md", 240),
    currentId: oneLine(currentId, 80),
    nextId: oneLine(nextId, 80),
    nextTitle: oneLine(nextNode?.title || "", 120),
    completion: oneLine(nextNode?.fields?.Completion || "", 80),
    nextIdea: oneLine(nextNode?.fields?.NextIdea || "", 600),
    rootPurpose: oneLine(rootNode?.fields?.Problem || rootNode?.title || "", 280),
    rootDirection: oneLine(rootNode?.fields?.Approach || "", 360),
    rootSuccess: oneLine(rootNode?.fields?.Metrics || "", 260),
    currentResult: oneLine(currentNode?.fields?.CurrentResult || "", 360),
    nextProblem: oneLine(nextNode?.fields?.Problem || "", 260),
    stageGoal: oneLine(nextNode?.fields?.Problem || nextNode?.title || "", 260),
    stageSuccess: oneLine(nextNode?.fields?.Metrics || "", 260)
  };
}

export function buildTaskTreeCheckpointContext(input = {}) {
  const focus = input.markdown !== undefined ? extractTaskTreeTurnFocus(input) : input;
  if (!focus?.nextId) return "";

  const executionScope = input.executionScope?.status === "active" ? input.executionScope : null;
  const assigned = Array.isArray(input.assignedNodes) ? input.assignedNodes : [];
  const executionTarget = executionScope && assigned.length
    ? assigned.map((node) => `${node.id}${node.title ? ` - ${node.title}` : ""}`).join(", ")
    : `${focus.nextId}${focus.nextTitle ? ` - ${focus.nextTitle}` : ""}`;

  const nextLabel = `${focus.nextId}${focus.nextTitle ? ` - ${focus.nextTitle}` : ""}`;
  const idea = focus.nextIdea || "(empty; no executable action is recorded)";
  return [
    "[PROJECT_TASK_TREE_CHECKPOINT_V1]",
    `Active method tree: ${focus.activeTreeId || "method"} (${focus.activeTreePath || "task-tree.md"})`,
    `GraphState.Current: ${focus.currentId || "(unset)"}`,
    `GraphState.Next: ${nextLabel}`,
    executionScope ? `Agent execution scope: ${executionScope.scopeId} (${executionScope.role}); assigned nodes: ${executionTarget}` : "Agent execution scope: none; use GraphState.Next as the default target.",
    `Next completion: ${focus.completion || "(unset)"}`,
    `Root purpose (highest priority): ${focus.rootPurpose || "(unset)"}`,
    `Project direction: ${focus.rootDirection || "(unset)"}`,
    `Success test: ${focus.rootSuccess || "(unset)"}`,
    `Active stage goal (preserve its meaning): ${focus.stageGoal || focus.nextProblem || "(unset)"}`,
    `Active stage success test: ${focus.stageSuccess || "(unset)"}`,
    focus.currentResult ? `Latest Current result (evidence only): ${focus.currentResult}` : "",
    focus.nextProblem ? `Next node problem: ${focus.nextProblem}` : "",
    executionScope ? `Assigned instruction: ${executionScope.instruction || "(use each assigned node's NextIdea)"}` : `NextIdea: ${idea}`,
    executionScope
      ? "Execution priority is: latest user request > this Agent execution scope > global GraphState.Next. Work only on assigned nodes; global Current/Next remains the human project view and is context, not your assignment."
      : "No Agent execution scope is active, so GraphState.Next and its NextIdea are the default execution target.",
    "Before acting, reconcile this NextIdea with the latest user request and current artifacts. If it is stale or already satisfied, do not repeat it: first use task_tree_write to record measured reconciliation and replace the affected node's NextIdea with the next unresolved action.",
    "Before acting, state internally how this work advances the Root purpose. If that link cannot be stated from the tree and the user's request, do not invent a connection: ask for clarification or record the mismatch as unresolved.",
    "Prevent hallucination: only call a result completed after reading or running evidence that verifies it. Mark assumptions and unverified claims as such; never convert a plan, filename, screenshot, or intended design into a completed result.",
    "After each coherent work unit (one independently verifiable result, decision, failure, or blocker), immediately use task_tree_write on the smallest affected live node before starting another unit. Do not wait until the turn ends.",
    "After every successful tree/subtree write, use only the write result's persisted changes to tell the user which nodes and fields actually changed, formatted as old value -> new value. Do not infer changes from memory or requested fields, and do not report unchanged or protected fields.",
    "Write semantic node fields in concise Chinese. CurrentResult must directly answer the user's Root or active-stage goal in one compact goal-relative status: preserve the stated goal, say what verified capability or evidence exists now, what remains missing, and therefore whether the goal can currently be claimed reached. Numbers are optional. Do not substitute vague phrases such as 'directional progress'; keep at most 3 decision-relevant facts and put implementation detail in evidence.",
    "Write semantic node fields in concise Chinese. LLM, token, API, exact names, IDs, paths, and URLs may remain; move complex English terminology, code, JSON, commands, formulas, raw data, and logs to evidence files.",
    "NextIdea may be concrete so the Agent can execute it, but it must name the direction it serves and its completion test. Do not mistake a concrete NextIdea for the project's current direction.",
    "Write only the smallest current state: if deleting a sentence cannot change the next action, method, constraint, unresolved blocker, or completion test, move it to evidence or drop it.",
    "GraphState.NextPlan is advisory and non-executable. Do not move GraphState focus."
  ].join("\n");
}
