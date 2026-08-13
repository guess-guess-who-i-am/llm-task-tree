import { parseTreeNodeFields } from "./tree-quality.js";

function clean(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function graphStateFields(markdown) {
  const text = String(markdown || "");
  const start = text.search(/^# GraphState\b/m);
  if (start < 0) return {};
  const tail = text.slice(start);
  const end = tail.search(/^# Edges\b/m);
  const block = end >= 0 ? tail.slice(0, end) : tail;
  const fields = {};
  for (const match of block.matchAll(/^-\s+([A-Za-z][A-Za-z0-9]*):[^\S\r\n]*([^\r\n]*)$/gm)) {
    fields[match[1]] = clean(match[2]);
  }
  return fields;
}

function orderedUnion(left, right) {
  return [...new Set([...left, ...right])];
}

/**
 * Returns the semantic changes between two persisted tree snapshots. Values come from the
 * snapshots themselves, so callers never have to reconstruct a user-facing receipt from memory.
 */
export function diffTreeMarkdown(beforeMarkdown, afterMarkdown) {
  const beforeNodes = parseTreeNodeFields(beforeMarkdown);
  const afterNodes = parseTreeNodeFields(afterMarkdown);
  const beforeById = new Map(beforeNodes.map((node) => [node.id, node]));
  const afterById = new Map(afterNodes.map((node) => [node.id, node]));
  const changes = [];

  for (const nodeId of orderedUnion(beforeNodes.map((node) => node.id), afterNodes.map((node) => node.id))) {
    const before = beforeById.get(nodeId);
    const after = afterById.get(nodeId);
    if (!before || !after) {
      changes.push({
        kind: before ? "node-removed" : "node-added",
        nodeId,
        title: clean((after || before)?.title),
        field: "Node",
        before: before ? clean(before.title) : "",
        after: after ? clean(after.title) : ""
      });
      continue;
    }

    if (clean(before.title) !== clean(after.title)) {
      changes.push({
        kind: "node-title",
        nodeId,
        title: clean(after.title),
        field: "Title",
        before: clean(before.title),
        after: clean(after.title)
      });
    }

    for (const field of orderedUnion(Object.keys(before.fields || {}), Object.keys(after.fields || {}))) {
      const oldValue = clean(before.fields?.[field]);
      const newValue = clean(after.fields?.[field]);
      if (oldValue === newValue) continue;
      changes.push({
        kind: "node-field",
        nodeId,
        title: clean(after.title),
        field,
        before: oldValue,
        after: newValue
      });
    }
  }

  const beforeState = graphStateFields(beforeMarkdown);
  const afterState = graphStateFields(afterMarkdown);
  for (const field of orderedUnion(Object.keys(beforeState), Object.keys(afterState))) {
    const oldValue = clean(beforeState[field]);
    const newValue = clean(afterState[field]);
    if (oldValue === newValue) continue;
    changes.push({
      kind: "graph-state",
      nodeId: "GraphState",
      title: "GraphState",
      field,
      before: oldValue,
      after: newValue
    });
  }

  return changes;
}

export function changedNodeIds(changes = []) {
  return [...new Set(changes.filter((change) => change.nodeId !== "GraphState").map((change) => change.nodeId))];
}
