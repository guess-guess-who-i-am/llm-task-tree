/**
 * Execution flow scripts — catalog, auto-build, persistence.
 * Scripts live in scripts/project.json & scripts/run.json (authoritative execution order).
 * Folding in task-tree does NOT remove nodes from the execution catalog.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EXECUTION_SPINE = ["ROOT", "N1", "N2", "N3", "N4", "N5", "N6", "N7"];
const MAX_VERSIONS = 40;
const VALID_MODES = new Set(["project", "run"]);

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function parseFlowMarkdown(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const nodes = [];
  const edges = [];
  let graphState = { current: "", next: "" };
  let section = "meta";
  let current = null;
  let pendingNodeField = "";

  const flush = () => {
    if (current) nodes.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("# GraphState")) {
      flush();
      section = "graphState";
      continue;
    }
    if (line.startsWith("# Edges")) {
      flush();
      section = "edges";
      continue;
    }
    const nodeMatch = line.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (nodeMatch && section !== "edges") {
      flush();
      section = "nodes";
      current = {
        id: nodeMatch[1],
        title: nodeMatch[2].trim(),
        completion: "",
        subtreeFile: ""
      };
      pendingNodeField = "";
      continue;
    }
    if (section === "nodes" && current) {
      const completion = line.match(/^-\s+Completion:\s*(.*)$/);
      if (completion) {
        current.completion = completion[1].trim();
        pendingNodeField = current.completion ? "" : "completion";
      } else if (pendingNodeField === "completion") {
        const nested = line.match(/^\s+-\s+(.+)$/);
        if (nested) {
          current.completion = nested[1].trim();
          pendingNodeField = "";
        } else if (line.trim()) {
          pendingNodeField = "";
        }
      }
      const sf = line.match(/^-\s+SubtreeFile:\s*(\S+)/);
      if (sf) current.subtreeFile = sf[1].trim();
    }
    if (section === "graphState") {
      const cur = line.match(/^-\s+Current:\s*(\S+)/);
      const nxt = line.match(/^-\s+Next:\s*(\S+)/);
      if (cur) graphState.current = cur[1];
      if (nxt) graphState.next = nxt[1];
    }
    if (section === "edges") {
      const ep = line.match(/^-\s+Endpoints:\s*(.+)$/);
      if (ep) {
        const parts = ep[1].split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) edges.push([parts[0], parts[1]]);
      }
    }
  }
  flush();
  return { nodes, edges, graphState };
}

function isReferenceNode(id) {
  if (id === "ROOT") return false;
  if (id === "N3a") return true;
  if (/^N8/i.test(id)) return true;
  return false;
}

function isDetailNode(id) {
  if (isReferenceNode(id)) return false;
  return /^N\d+[a-z]/i.test(id);
}

function parentMilestoneId(id) {
  const m = id.match(/^(N\d+)[a-z]/i);
  return m ? m[1] : id;
}

function isParallelNode(id) {
  return id === "N7a";
}

function isExecutionNode(id) {
  if (id === "ROOT") return true;
  if (isReferenceNode(id) || isParallelNode(id)) return false;
  if (isDetailNode(id)) return true;
  return /^N\d+$/.test(id);
}

function nodeSortKey(id) {
  if (id === "ROOT") return [0, ""];
  const m = id.match(/^N(\d+)([a-z]?)$/i);
  if (!m) return [999, id];
  return [parseInt(m[1], 10), m[2] || ""];
}

function compareNodeId(a, b) {
  const ka = nodeSortKey(a);
  const kb = nodeSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  return String(ka[1]).localeCompare(String(kb[1]));
}

function toExecMilestone(id) {
  if (!id || id === "ROOT") return "ROOT";
  if (isReferenceNode(id) || isParallelNode(id)) return null;
  if (isDetailNode(id)) return parentMilestoneId(id);
  if (/^N\d+$/.test(id)) return id;
  return null;
}

function resolveReferenceAnchorExecId(refId, edges) {
  if (refId === "N3a") return "N3";
  if (refId === "N8") return "N3";
  const direct = [];
  for (const [a, b] of edges) {
    if (a !== refId && b !== refId) continue;
    const milestone = toExecMilestone(a === refId ? b : a);
    if (milestone) direct.push(milestone);
  }
  if (direct.length) return [...new Set(direct)].sort(compareNodeId)[0];

  const seen = new Set([refId]);
  let frontier = [refId];
  for (let hop = 0; hop < 4 && frontier.length; hop += 1) {
    const next = [];
    for (const id of frontier) {
      for (const [a, b] of edges) {
        if (a !== id && b !== id) continue;
        const other = a === id ? b : a;
        const milestone = toExecMilestone(other);
        if (milestone) return milestone;
        if (isReferenceNode(other) && !seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return null;
}

function orderedExecutionNodeIds(nodes) {
  return nodes.map((n) => n.id).filter(isExecutionNode).sort(compareNodeId);
}

function buildRunPath(parsed) {
  const nodeSet = new Set(parsed.nodes.map((n) => n.id));
  let current = parsed.graphState.current || parsed.graphState.next || "ROOT";
  if (!nodeSet.has(current)) current = "ROOT";

  const path = [];
  if (isDetailNode(current)) {
    path.push(current);
    const parent = parentMilestoneId(current);
    if (nodeSet.has(parent)) path.unshift(parent);
  } else {
    path.unshift(current);
  }

  const anchor = isDetailNode(current) ? parentMilestoneId(current) : current;
  const spineIdx = EXECUTION_SPINE.indexOf(anchor);
  if (spineIdx > 0) {
    for (let i = spineIdx - 1; i >= 0; i -= 1) {
      const id = EXECUTION_SPINE[i];
      if (nodeSet.has(id)) path.unshift(id);
    }
  } else if (!path.includes("ROOT") && nodeSet.has("ROOT")) {
    path.unshift("ROOT");
  }
  return [...new Set(path)];
}

export function completionToStatus(completion) {
  const c = String(completion || "").trim();
  if (c.includes("已完成")) return "done";
  if (c.includes("进行中")) return "active";
  if (c.includes("未开始") || c.includes("需重做")) return "pending";
  return "pending";
}

function taskBlockFromNode(node) {
  return {
    id: uid("b"),
    type: "task",
    nodeId: node.id,
    title: node.title,
    status: completionToStatus(node.completion)
  };
}

function refBlockFromNode(node) {
  return {
    id: uid("b"),
    type: "ref",
    nodeId: node.id,
    title: node.title,
    status: completionToStatus(node.completion)
  };
}

export function autoBuildFlowScript(parsed, mode) {
  const nodesById = Object.fromEntries(parsed.nodes.map((n) => [n.id, n]));
  const execIds = mode === "run" ? buildRunPath(parsed) : orderedExecutionNodeIds(parsed.nodes);
  const pathSet = new Set(execIds);

  const blocks = [
    {
      id: uid("b"),
      type: "hat",
      title: mode === "run" ? "当本次运行开始" : "当项目开始"
    }
  ];

  let i = 0;
  while (i < execIds.length) {
    const nodeId = execIds[i];
    const node = nodesById[nodeId];
    if (!node) {
      i += 1;
      continue;
    }

    if (!isDetailNode(nodeId)) {
      const detailChildren = execIds
        .slice(i + 1)
        .filter((id) => isDetailNode(id) && parentMilestoneId(id) === nodeId);
      if (detailChildren.length > 0) {
        blocks.push({
          id: uid("b"),
          type: "repeat",
          label: "依次执行子步骤",
          times: detailChildren.length,
          body: detailChildren.map((cid) => taskBlockFromNode(nodesById[cid])).filter(Boolean)
        });
        i += 1 + detailChildren.length;
        continue;
      }
    }

    blocks.push(taskBlockFromNode(node));
    i += 1;
  }

  if (mode === "project") {
    for (const node of parsed.nodes.filter((n) => isParallelNode(n.id))) {
      blocks.push(taskBlockFromNode(node));
    }
  }

  const refsByAnchor = {};
  for (const node of parsed.nodes) {
    if (!isReferenceNode(node.id)) continue;
    const anchor = resolveReferenceAnchorExecId(node.id, parsed.edges);
    if (mode === "run" && anchor && !pathSet.has(anchor) && !pathSet.has(node.id)) continue;
    const key = anchor || "_orphan";
    if (!refsByAnchor[key]) refsByAnchor[key] = [];
    refsByAnchor[key].push(refBlockFromNode(node));
  }

  for (let j = 0; j < blocks.length; j += 1) {
    const b = blocks[j];
    if (b.type !== "task") continue;
    const refs = refsByAnchor[b.nodeId];
    if (!refs?.length) continue;
    blocks.splice(j + 1, 0, ...refs);
    j += refs.length;
  }

  return {
    blocks,
    focusId: resolveRebuiltFlowFocus({ blocks, graphState: parsed.graphState })
  };
}

function mergeCatalog(main, extra) {
  const nodesById = new Map(main.nodes.map((n) => [n.id, n]));
  for (const n of extra.nodes) {
    if (!nodesById.has(n.id)) nodesById.set(n.id, n);
  }
  const edgeKeys = new Set(main.edges.map((e) => e.join("|")));
  const edges = [...main.edges];
  for (const e of extra.edges) {
    const k = e.join("|");
    if (!edgeKeys.has(k)) {
      edges.push(e);
      edgeKeys.add(k);
    }
  }
  return {
    nodes: [...nodesById.values()],
    edges,
    graphState: main.graphState
  };
}

export async function buildExecutionCatalog({ projectRoot, treeFile, subtreesDir }) {
  const mainMarkdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
  let catalog = parseFlowMarkdown(mainMarkdown);

  const subtreeFiles = new Set();
  for (const node of catalog.nodes) {
    if (node.subtreeFile) subtreeFiles.add(node.subtreeFile.replace(/\\/g, "/"));
  }
  if (existsSync(subtreesDir)) {
    const names = await readdir(subtreesDir);
    for (const name of names) {
      if (name.endsWith(".md")) subtreeFiles.add(`subtrees/${name}`);
    }
  }

  for (const rel of subtreeFiles) {
    const filePath = path.join(projectRoot, rel);
    if (!existsSync(filePath)) continue;
    const md = await readFile(filePath, "utf8");
    catalog = mergeCatalog(catalog, parseFlowMarkdown(md));
  }

  return catalog;
}

function scriptPaths(scriptsDir, mode) {
  const base = path.join(scriptsDir, `${mode}.json`);
  const versionsDir = path.join(scriptsDir, "versions", mode);
  return { base, versionsDir };
}

async function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeScriptPayload(script, mode) {
  return {
    schema: "flow-script/v1",
    mode,
    focusId: script?.focusId || "ROOT",
    updatedAt: new Date().toISOString(),
    blocks: Array.isArray(script?.blocks) ? script.blocks : []
  };
}

async function listScriptVersions(versionsDir) {
  if (!existsSync(versionsDir)) return [];
  const names = await readdir(versionsDir);
  const items = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const data = await readJson(path.join(versionsDir, name));
    if (!data) continue;
    items.push({
      id: data.id || name.replace(/\.json$/, ""),
      label: data.label || data.reason || name,
      createdAt: data.createdAt || 0,
      blocks: data.blocks,
      focusId: data.focusId
    });
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items.slice(0, MAX_VERSIONS);
}

async function pushScriptVersion(versionsDir, entry) {
  await mkdir(versionsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = String(entry.label || "snapshot").replace(/[^\w\u4e00-\u9fff-]+/g, "_").slice(0, 40);
  const fileName = `${stamp}_${safeLabel}.json`;
  await writeJson(path.join(versionsDir, fileName), entry);
  const versions = await listScriptVersions(versionsDir);
  for (const old of versions.slice(MAX_VERSIONS)) {
    /* list is sorted; prune happens on next list read */
  }
  const allNames = (await readdir(versionsDir)).filter((n) => n.endsWith(".json")).sort().reverse();
  for (const extra of allNames.slice(MAX_VERSIONS)) {
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(path.join(versionsDir, extra)).catch(() => {})
    );
  }
  return listScriptVersions(versionsDir);
}

export async function getFlowScript({ scriptsDir, mode, catalog }) {
  if (!VALID_MODES.has(mode)) throw new Error("invalid mode");
  const { base, versionsDir } = scriptPaths(scriptsDir, mode);
  const versions = await listScriptVersions(versionsDir);
  let doc = await readJson(base);
  if (!doc?.blocks?.length && catalog) {
    const built = autoBuildFlowScript(catalog, mode);
    doc = normalizeScriptPayload(built, mode);
    await writeJson(base, doc);
    versions.unshift({
      id: `v-init-${mode}`,
      label: "初始自动生成",
      createdAt: Date.now(),
      blocks: doc.blocks,
      focusId: doc.focusId
    });
    await pushScriptVersion(versionsDir, versions[0]);
  }
  return {
    script: doc ? { blocks: doc.blocks, focusId: doc.focusId } : { blocks: [], focusId: "ROOT" },
    versions: await listScriptVersions(versionsDir)
  };
}

export async function putFlowScript({ scriptsDir, mode, script, reason, backup = true }) {
  if (!VALID_MODES.has(mode)) throw new Error("invalid mode");
  const { base, versionsDir } = scriptPaths(scriptsDir, mode);
  const prev = await readJson(base);
  if (backup && prev?.blocks?.length) {
    await pushScriptVersion(versionsDir, {
      id: `v-${Date.now()}`,
      label: reason || "保存前快照",
      createdAt: Date.now(),
      blocks: prev.blocks,
      focusId: prev.focusId
    });
  }
  const doc = normalizeScriptPayload(script, mode);
  await writeJson(base, doc);
  const versions = await listScriptVersions(versionsDir);
  return {
    script: { blocks: doc.blocks, focusId: doc.focusId },
    versions
  };
}

export async function restoreFlowScript({ scriptsDir, mode, versionId }) {
  if (!VALID_MODES.has(mode)) throw new Error("invalid mode");
  const { base, versionsDir } = scriptPaths(scriptsDir, mode);
  const versions = await listScriptVersions(versionsDir);
  const entry = versions.find((v) => v.id === versionId);
  if (!entry) throw new Error("version not found");
  const prev = await readJson(base);
  if (prev?.blocks?.length) {
    await pushScriptVersion(versionsDir, {
      id: `v-${Date.now()}`,
      label: "恢复前自动备份",
      createdAt: Date.now(),
      blocks: prev.blocks,
      focusId: prev.focusId
    });
  }
  const doc = normalizeScriptPayload({ blocks: entry.blocks, focusId: entry.focusId }, mode);
  await writeJson(base, doc);
  return {
    script: { blocks: doc.blocks, focusId: doc.focusId },
    versions: await listScriptVersions(versionsDir)
  };
}

export async function backupFlowScriptBeforeTreeEdit({ scriptsDir, reason }) {
  await mkdir(scriptsDir, { recursive: true });
  for (const mode of VALID_MODES) {
    const { base, versionsDir } = scriptPaths(scriptsDir, mode);
    const prev = await readJson(base);
    if (prev?.blocks?.length) {
      await pushScriptVersion(versionsDir, {
        id: `v-${Date.now()}-${mode}`,
        label: reason || "任务树修改前",
        createdAt: Date.now(),
        blocks: prev.blocks,
        focusId: prev.focusId
      });
    }
  }
}

export function collectFlowNodeIds(blocks) {
  const ids = [];
  const visit = (items) => {
    for (const block of items || []) {
      if ((block.type === "task" || block.type === "ref") && block.nodeId) ids.push(block.nodeId);
      visit(block.body);
      visit(block.elseBody);
    }
  };
  visit(blocks);
  return ids;
}

export function resolveRebuiltFlowFocus({ previousFocusId = "", blocks = [], graphState = {} } = {}) {
  const nodeIds = collectFlowNodeIds(blocks);
  const available = new Set(nodeIds);
  for (const candidate of [previousFocusId, graphState.next, graphState.current]) {
    if (candidate && available.has(candidate)) return candidate;
  }
  return nodeIds[0] || "ROOT";
}

export function computeFlowDrift(catalog, blocks) {
  const nodes = catalog?.nodes || [];
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const execIds = orderedExecutionNodeIds(nodes);
  const flowIds = collectFlowNodeIds(blocks);
  const flowSet = new Set(flowIds);
  const catalogSet = new Set(nodes.map((n) => n.id));

  const missingInFlow = execIds.filter((id) => !flowSet.has(id));
  const staleInFlow = [...new Set(flowIds.filter((id) => !catalogSet.has(id)))];

  const statusMismatch = [];
  for (const block of blocks || []) {
    if (block.type !== "task" && block.type !== "ref") continue;
    const node = nodesById[block.nodeId];
    if (!node) continue;
    const expected = completionToStatus(node.completion);
    if (block.status !== expected) {
      statusMismatch.push({
        nodeId: block.nodeId,
        title: node.title || block.title,
        blockStatus: block.status,
        expectedStatus: expected
      });
    }
  }

  const execOrder = execIds.filter((id) => flowSet.has(id));
  const flowOrder = flowIds.filter((id) => catalogSet.has(id));
  const orderDiffers =
    execOrder.length > 0 &&
    (execOrder.length !== flowOrder.length || execOrder.some((id, i) => flowOrder[i] !== id));

  return {
    missingInFlow,
    staleInFlow,
    statusMismatch,
    orderDiffers,
    suggestedOrder: execOrder,
    currentOrder: flowOrder,
    drifted:
      missingInFlow.length > 0 ||
      staleInFlow.length > 0 ||
      statusMismatch.length > 0 ||
      orderDiffers
  };
}

export function syncFlowBlockStatuses(catalog, blocks) {
  const nodesById = Object.fromEntries((catalog?.nodes || []).map((n) => [n.id, n]));
  let changed = 0;
  const next = (blocks || []).map((block) => {
    if (block.type !== "task" && block.type !== "ref") return block;
    const node = nodesById[block.nodeId];
    if (!node) return block;
    const expected = completionToStatus(node.completion);
    if (block.status === expected) return block;
    changed += 1;
    return { ...block, status: expected };
  });
  return { blocks: next, changed };
}
