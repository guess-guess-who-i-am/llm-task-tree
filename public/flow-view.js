/**
 * Block-flow view — Scratch 3 style module script editor
 * Integrates into main app via initFlowView({ rootEl, onModeChange })
 */

const EXECUTION_SPINE = ["ROOT", "N1", "N2", "N3", "N4", "N5", "N6", "N7"];

const SVG_PATHS = {
  hat: "M 16 0 L 384 0 C 396 0 400 4 400 8 L 400 32 C 400 44 384 44 368 44 L 268 44 L 260 36 L 244 36 L 236 44 L 16 44 C 0 44 0 32 0 16 L 0 8 C 0 0 8 0 16 0 Z",
  stack:
    "M 0 8 C 0 4 4 4 8 4 L 12 4 C 16 4 20 0 24 0 L 376 0 C 392 0 400 4 400 8 L 400 36 C 400 40 396 40 392 40 L 276 40 L 268 32 L 252 32 L 244 40 L 8 40 C 4 40 0 36 0 32 L 0 8 Z",
  cap: "M 0 8 C 0 4 4 4 8 4 L 12 4 C 16 4 20 0 24 0 L 376 0 C 392 0 400 4 400 8 L 400 32 C 400 36 396 40 392 40 L 16 40 C 4 40 0 36 0 32 L 0 24 C 0 12 0 8 0 8 Z",
  cTop:
    "M 0 8 C 0 4 4 4 8 4 L 12 4 C 16 4 20 0 24 0 L 376 0 C 392 0 400 4 400 8 L 400 36 L 400 40 L 24 40 C 8 40 0 36 0 28 L 0 8 Z"
};

const PALETTE = [
  {
    title: "事件",
    items: [
      { kind: "hatProject", label: "当项目开始", preview: "当项目开始" },
      { kind: "hatRun", label: "当本次运行开始", preview: "当本次运行开始" }
    ]
  },
  {
    title: "控制",
    items: [
      { kind: "wait", label: "等待", preview: "等待 1 秒" },
      { kind: "if", label: "如果…那么", preview: "如果 … 那么" },
      { kind: "ifElse", label: "如果…那么…否则", preview: "如果 … 那么 … 否则" },
      { kind: "repeat", label: "重复", preview: "重复 10 次" },
      { kind: "forever", label: "一直重复", preview: "一直重复" },
      { kind: "repeatUntil", label: "重复直到", preview: "重复直到 …" },
      { kind: "waitUntil", label: "等待直到", preview: "等待直到 …" },
      { kind: "stop", label: "停止", preview: "停止" },
      { kind: "stopAll", label: "停止全部", preview: "停止全部" }
    ]
  },
  {
    title: "运算",
    items: [
      { kind: "boolStatus", label: "状态 = …", preview: "状态 = 进行中" },
      { kind: "boolAnd", label: "与", preview: "… 与 …" },
      { kind: "boolOr", label: "或", preview: "… 或 …" },
      { kind: "boolNot", label: "不成立", preview: "不成立 …" }
    ]
  }
];

const PALETTE_DRAG_MIME = "application/x-swimlane-palette";
const SAVE_DEBOUNCE_MS = 400;

const CONTAINER_BLOCK_TYPES = new Set(["if", "ifElse", "repeat", "forever", "repeatUntil"]);

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultCondition() {
  return { type: "boolStatus", status: "active" };
}

function normalizeCatalog(data) {
  const graphState = data?.graphState || {};
  return {
    nodes: Array.isArray(data?.nodes) ? data.nodes : [],
    edges: Array.isArray(data?.edges) ? data.edges : [],
    graphState: {
      current: graphState.current || graphState.Current || "",
      next: graphState.next || graphState.Next || ""
    }
  };
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

function completionToStatus(completion) {
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

function autoBuildScript(parsed, mode) {
  const nodesById = Object.fromEntries(parsed.nodes.map((n) => [n.id, n]));
  const execIds =
    mode === "run" ? buildRunPath(parsed) : orderedExecutionNodeIds(parsed.nodes);
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
    const parallel = parsed.nodes.filter((n) => isParallelNode(n.id));
    for (const node of parallel) {
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
    scriptMode: mode,
    focusId: parsed.graphState.current || parsed.graphState.next || "ROOT",
    blocks
  };
}

function flattenBlocks(blocks, list = []) {
  for (const b of blocks) {
    list.push(b);
    if (b.body) flattenBlocks(b.body, list);
    if (b.elseBody) flattenBlocks(b.elseBody, list);
  }
  return list;
}

function createControlBlock(kind) {
  switch (kind) {
    case "hatProject":
      return { id: uid("b"), type: "hat", title: "当项目开始" };
    case "hatRun":
      return { id: uid("b"), type: "hat", title: "当本次运行开始" };
    case "wait":
      return { id: uid("b"), type: "wait", seconds: 1 };
    case "if":
      return { id: uid("b"), type: "if", condition: defaultCondition(), body: [] };
    case "ifElse":
      return {
        id: uid("b"),
        type: "ifElse",
        condition: defaultCondition(),
        body: [],
        elseBody: []
      };
    case "repeat":
      return { id: uid("b"), type: "repeat", label: "", times: 10, body: [] };
    case "forever":
      return { id: uid("b"), type: "forever", body: [] };
    case "repeatUntil":
      return {
        id: uid("b"),
        type: "repeatUntil",
        condition: { type: "boolStatus", status: "done" },
        body: []
      };
    case "waitUntil":
      return { id: uid("b"), type: "waitUntil", condition: defaultCondition() };
    case "stop":
      return { id: uid("b"), type: "stop", label: "停止这个脚本" };
    case "stopAll":
      return { id: uid("b"), type: "stopAll" };
    case "boolStatus":
      return { id: uid("b"), type: "boolStatus", status: "active" };
    case "boolAnd":
      return {
        id: uid("b"),
        type: "boolAnd",
        left: defaultCondition(),
        right: { type: "boolStatus", status: "done" }
      };
    case "boolOr":
      return {
        id: uid("b"),
        type: "boolOr",
        left: defaultCondition(),
        right: { type: "boolStatus", status: "pending" }
      };
    case "boolNot":
      return { id: uid("b"), type: "boolNot", inner: defaultCondition() };
    default:
      return { id: uid("b"), type: "repeat", times: 3, body: [] };
  }
}

function isContainerBlock(block) {
  return block && CONTAINER_BLOCK_TYPES.has(block.type);
}

function listPathFromBlockPath(blockPath) {
  return blockPath.slice(0, -1);
}

function isValidMoveFromPath(path) {
  if (!path?.length) return false;
  const idx = path[path.length - 1];
  if (typeof idx !== "number" || Number.isNaN(idx)) return false;
  if (path.length === 1) return true;
  const slot = path[path.length - 2];
  return slot === "body" || slot === "elseBody";
}

function cloneBlocks(blocks) {
  return JSON.parse(JSON.stringify(blocks));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatVersionTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildFlowViewTemplate() {
  return `
    <div class="flowViewRoot">
      <div class="flowViewToolbar">
        <div class="scriptModeToggle" role="tablist" aria-label="脚本模式">
          <button type="button" class="modeBtn is-active" data-script-mode="project">项目脚本</button>
          <button type="button" class="modeBtn" data-script-mode="run">本次运行</button>
        </div>
        <div class="flowViewActions">
          <button type="button" class="flowViewToolBtn syncStatusBtn" title="仅同步块状态，不改顺序">↻ 同步状态</button>
          <button type="button" class="flowViewGhostBtn rebuildFlowBtn" title="按任务图重排流程块">⇄ 重排流程</button>
          <button type="button" class="flowViewToolBtn exportFlowSvgBtn" title="导出当前脚本为 SVG">⤓ SVG</button>
          <button type="button" class="flowViewToolBtn autoLayoutBtn" title="从任务图重新生成脚本">↻ 重新生成</button>
          <button type="button" class="flowViewGhostBtn resetBtn" title="重置脚本">重置</button>
        </div>
      </div>
      <div class="flowDriftBanner" hidden></div>
      <div class="blocksHead">
        <div>
          <h2 class="blocksTitle">项目脚本</h2>
          <p class="blocksDesc">从上到下执行。点击任务块查看步骤审计；<button type="button" class="flowOverviewLink">流程总览</button></p>
        </div>
        <div class="scriptVersionBar">
          <button type="button" class="flowViewToolBtn saveScriptVersionBtn">保存版本</button>
          <select class="scriptVersionSelect" aria-label="脚本版本列表"></select>
          <button type="button" class="flowViewGhostBtn restoreScriptVersionBtn">恢复选中</button>
          <span class="scriptVersionMeta"></span>
        </div>
      </div>
      <div class="blocksLayout">
        <aside class="blockPalette" aria-label="块调色板"></aside>
        <div class="blocksStage">
          <div class="scriptColumn"></div>
        </div>
        <aside class="flowStepInspector" aria-label="步骤详情">
          <div class="flowStepInspectorInner">
            <h3 class="flowStepInspectorTitle">步骤详情</h3>
            <p class="flowStepInspectorHint muted">点击左侧任务块查看本步代码、prompt 与产出。</p>
          </div>
        </aside>
      </div>
    </div>`;
}

/**
 * @param {{ rootEl: HTMLElement, onModeChange?: (mode: 'project'|'run') => void }} options
 */
export function initFlowView({ rootEl, onModeChange }) {
  if (!rootEl) throw new Error("initFlowView requires rootEl");

  rootEl.innerHTML = buildFlowViewTemplate();

  let state = null;
  let scriptMode = "project";
  let dragBlockId = null;
  let dragFromPath = null;
  let dragPalettePayload = null;
  let dragSession = null;
  let activeDropSlot = null;
  let dropHandled = false;
  let saveTimer = null;
  let saveInFlight = null;
  let destroyed = false;
  let selectedStepNodeId = "";
  let driftState = null;
  let stepPackByNode = new Map();

  const scriptColumn = rootEl.querySelector(".scriptColumn");
  const blockPalette = rootEl.querySelector(".blockPalette");
  const flowDriftBanner = rootEl.querySelector(".flowDriftBanner");
  const flowStepInspector = rootEl.querySelector(".flowStepInspector");
  const flowStepInspectorInner = rootEl.querySelector(".flowStepInspectorInner");
  const blocksTitle = rootEl.querySelector(".blocksTitle");
  const blocksDesc = rootEl.querySelector(".blocksDesc");
  const saveScriptVersionBtn = rootEl.querySelector(".saveScriptVersionBtn");
  const restoreScriptVersionBtn = rootEl.querySelector(".restoreScriptVersionBtn");
  const scriptVersionSelect = rootEl.querySelector(".scriptVersionSelect");
  const scriptVersionMeta = rootEl.querySelector(".scriptVersionMeta");
  const modeButtons = rootEl.querySelectorAll(".modeBtn");
  const autoLayoutBtn = rootEl.querySelector(".autoLayoutBtn");
  const exportFlowSvgBtn = rootEl.querySelector(".exportFlowSvgBtn");
  const resetBtn = rootEl.querySelector(".resetBtn");
  const syncStatusBtn = rootEl.querySelector(".syncStatusBtn");
  const rebuildFlowBtn = rootEl.querySelector(".rebuildFlowBtn");
  const flowOverviewLink = rootEl.querySelector(".flowOverviewLink");

  async function fetchExecutionCatalog() {
    const response = await fetch(`/api/execution-catalog?t=${Date.now()}`);
    if (!response.ok) throw new Error(`execution-catalog ${response.status}`);
    return normalizeCatalog(await response.json());
  }

  async function fetchFlowScript(mode) {
    const response = await fetch(`/api/flow-script?mode=${encodeURIComponent(mode)}&t=${Date.now()}`);
    if (!response.ok) throw new Error(`flow-script GET ${response.status}`);
    return response.json();
  }

  async function putFlowScript(mode, script, reason) {
    const response = await fetch("/api/flow-script", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, script, reason })
    });
    if (!response.ok) throw new Error(`flow-script PUT ${response.status}`);
    return response.json();
  }

  async function postFlowScriptRestore(mode, versionId) {
    const response = await fetch("/api/flow-script/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, versionId })
    });
    if (!response.ok) throw new Error(`flow-script restore ${response.status}`);
    return response.json();
  }

  async function fetchFlowDrift(mode) {
    const response = await fetch(`/api/flow-script/drift?mode=${encodeURIComponent(mode)}&t=${Date.now()}`);
    if (!response.ok) throw new Error(`flow drift ${response.status}`);
    return response.json();
  }

  async function postSyncFlowStatus(mode, reason) {
    const response = await fetch("/api/flow-script/sync-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, reason })
    });
    if (!response.ok) throw new Error(`flow sync-status ${response.status}`);
    return response.json();
  }

  async function postRebuildFlow(mode, reason) {
    const response = await fetch("/api/flow-script/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, reason })
    });
    if (!response.ok) throw new Error(`flow rebuild ${response.status}`);
    return response.json();
  }

  async function fetchFlowStep(nodeId) {
    const response = await fetch(`/api/flow-step?nodeId=${encodeURIComponent(nodeId)}&t=${Date.now()}`);
    if (!response.ok) throw new Error(`flow-step ${response.status}`);
    return response.json();
  }

  async function openInEditor(filePath, line = 1) {
    const response = await fetch("/api/open-in-editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, line })
    });
    if (!response.ok) throw new Error(`open-in-editor ${response.status}`);
  }

  async function previewFileSnippet(filePath, maxChars = 4000) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}&preview=1&maxChars=${maxChars}`);
    if (!response.ok) throw new Error(`file preview ${response.status}`);
    return response.json();
  }

  async function doSaveToServer(reason = "自动保存") {
    if (!state || destroyed) return null;
    saveInFlight = putFlowScript(
      scriptMode,
      { blocks: cloneBlocks(state.blocks), focusId: state.focusId || "ROOT" },
      reason
    )
      .then((data) => {
        if (Array.isArray(data?.versions)) state.versions = data.versions;
        renderScriptVersionPanel();
        return data;
      })
      .finally(() => {
        saveInFlight = null;
      });
    return saveInFlight;
  }

  function saveScriptToServer(reason = "自动保存") {
    if (!state || destroyed) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      doSaveToServer(reason);
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSaveToServer(reason = "自动保存") {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saveInFlight) await saveInFlight;
    return doSaveToServer(reason);
  }

  async function ensureScriptForMode(parsed, mode) {
    const data = await fetchFlowScript(mode);
    const script = data?.script;
    if (script?.blocks?.length) {
      return { script, versions: data.versions || [] };
    }
    const built = autoBuildScript(parsed, mode);
    const newScript = { blocks: built.blocks, focusId: built.focusId };
    const saved = await putFlowScript(mode, newScript, "初始自动生成");
    return {
      script: saved?.script || newScript,
      versions: saved?.versions || data?.versions || []
    };
  }

  function applyScript(script) {
    if (!script?.blocks?.length) return false;
    state.blocks = cloneBlocks(script.blocks);
    state.focusId = script.focusId || "ROOT";
    return true;
  }

  async function loadScriptForMode(mode) {
    const data = await fetchFlowScript(mode);
    state.versions = data.versions || [];
    if (data.script?.blocks?.length) {
      applyScript(data.script);
      return true;
    }
    if (state.parsed) {
      const built = autoBuildScript(state.parsed, mode);
      state.blocks = built.blocks;
      state.focusId = built.focusId;
      await putFlowScript(mode, { blocks: state.blocks, focusId: state.focusId }, "初始自动生成");
      return true;
    }
    return false;
  }

  async function loadData(regenerate = false) {
    const parsed = await fetchExecutionCatalog();
    if (regenerate) {
      const built = autoBuildScript(parsed, scriptMode);
      state = {
        parsed,
        blocks: built.blocks,
        focusId: built.focusId,
        versions: state?.versions || []
      };
      await flushSaveToServer("重置脚本");
      renderAll();
      return;
    }

    const { script, versions } = await ensureScriptForMode(parsed, scriptMode);
    state = { parsed, blocks: [], focusId: "ROOT", versions };
    applyScript(script);
    await refreshDrift();
    renderAll();
  }

  async function setScriptMode(mode) {
    if (mode === scriptMode) return;
    await flushSaveToServer("切换模式前保存");
    scriptMode = mode;
    modeButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.scriptMode === mode);
    });
    await loadScriptForMode(mode);
    onModeChange?.(mode);
    renderAll();
  }

  function updateModeButtons() {
    modeButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.scriptMode === scriptMode);
    });
  }

  async function saveScriptVersion(label) {
    const reason = String(label || "手动保存").trim() || "手动保存";
    await flushSaveToServer(reason);
    renderScriptVersionPanel();
  }

  async function restoreScriptVersion(versionId) {
    if (!versionId) return false;
    await flushSaveToServer("恢复前自动备份");
    const data = await postFlowScriptRestore(scriptMode, versionId);
    if (data?.script) applyScript(data.script);
    if (Array.isArray(data?.versions)) state.versions = data.versions;
    renderAll();
    return true;
  }

  function renderScriptVersionPanel() {
    const versions = state?.versions || [];
    const modeLabel = scriptMode === "run" ? "本次运行" : "项目脚本";
    if (scriptVersionMeta) {
      scriptVersionMeta.textContent = `${modeLabel} · ${versions.length} 个版本`;
    }
    if (!versions.length) {
      scriptVersionSelect.innerHTML = `<option value="">暂无版本（点「保存版本」创建）</option>`;
      if (restoreScriptVersionBtn) restoreScriptVersionBtn.disabled = true;
      return;
    }
    scriptVersionSelect.innerHTML = versions
      .map(
        (v) =>
          `<option value="${escapeHtml(v.id)}">${escapeHtml(formatVersionTime(v.createdAt))} · ${escapeHtml(v.label || v.reason || "版本")}</option>`
      )
      .join("");
    if (restoreScriptVersionBtn) restoreScriptVersionBtn.disabled = false;
  }

  function statusLabel(status) {
    return ({ done: "已完成", active: "进行中", pending: "待执行" })[status] || status;
  }

  function wrapDeletable(html, block, path, deletable = true) {
    if (!deletable) return html;
    const pathStr = path.join(".");
    const canDrag = !isContainerBlock(block);
    const dragAttrs = canDrag
      ? `draggable="true" data-block-id="${block.id}" data-path="${pathStr}"`
      : "";
    const nodeAttr = block.nodeId ? ` data-node-id="${escapeHtml(block.nodeId)}"` : "";
    const selectedClass =
      block.nodeId && block.nodeId === selectedStepNodeId ? " is-step-selected" : "";
    return `
    <div class="blockWrap${canDrag ? " is-draggable" : ""}${selectedClass}" ${dragAttrs} data-block-path="${pathStr}"${nodeAttr}>
      ${html}
      <button type="button" class="blockDelete" data-delete-path="${pathStr}" title="删除此块" aria-label="删除">×</button>
    </div>`;
  }

  function renderSvgBlock(shape, category, labelHtml, extraClass = "", attrs = "") {
    const path = SVG_PATHS[shape];
    return `
    <div class="sb ${category} ${extraClass}" ${attrs}>
      <svg class="sb-svg" viewBox="0 0 400 44" preserveAspectRatio="none" aria-hidden="true">
        <path class="sb-path" d="${path}" />
      </svg>
      <div class="sb-label">${labelHtml}</div>
    </div>`;
  }

  function renderCondition(cond, blockId, field = "condition") {
    if (!cond || typeof cond === "string") {
      return `<span class="sb-bool">${escapeHtml(cond || "条件")}</span>`;
    }
    if (cond.type === "boolStatus") {
      return `
      <span class="sb-bool-slot">
        <span class="sb-bool">
          状态 =
          <select class="sb-select" data-edit-bool="${blockId}" data-bool-field="${field}">
            <option value="active" ${cond.status === "active" ? "selected" : ""}>进行中</option>
            <option value="done" ${cond.status === "done" ? "selected" : ""}>已完成</option>
            <option value="pending" ${cond.status === "pending" ? "selected" : ""}>待执行</option>
          </select>
        </span>
      </span>`;
    }
    if (cond.type === "boolAnd") {
      return `<span class="sb-bool-slot">${renderCondition(cond.left, blockId, `${field}.left`)} <span class="sb-bool">与</span> ${renderCondition(cond.right, blockId, `${field}.right`)}</span>`;
    }
    if (cond.type === "boolOr") {
      return `<span class="sb-bool-slot">${renderCondition(cond.left, blockId, `${field}.left`)} <span class="sb-bool">或</span> ${renderCondition(cond.right, blockId, `${field}.right`)}</span>`;
    }
    if (cond.type === "boolNot") {
      return `<span class="sb-bool-slot"><span class="sb-bool">不成立</span> ${renderCondition(cond.inner, blockId, `${field}.inner`)}</span>`;
    }
    return `<span class="sb-bool">条件</span>`;
  }

  function renderDropZone(blocks, parentPath, slot) {
    const pathStr = parentPath.join(".");
    const inner = renderBlockList(blocks || [], [...parentPath, slot]);
    return `<div class="sb-c-mouth" data-drop-path="${pathStr}" data-drop-slot="${slot}">${inner}</div>`;
  }

  function renderCBlockHead(labelHtml) {
    return `
    <div class="sb-c-head">
      <svg class="sb-svg" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">
        <path class="sb-path" d="${SVG_PATHS.cTop}" />
      </svg>
      <div class="sb-label">${labelHtml}</div>
    </div>`;
  }

  function renderBlockHTML(block, path) {
    const pathStr = path.join(".");
    const isCurrent = block.nodeId && block.nodeId === state.focusId;
    const deletable = block.type !== "hat";
    let html = "";

    if (block.type === "hat") {
      return renderSvgBlock("hat", "sb-events", escapeHtml(block.title), "", `data-path="${pathStr}"`);
    }

    if (block.type === "task") {
      const pack = stepPackByNode.get(block.nodeId);
      const packBadge = pack?.exists
        ? `<span class="stepPackBadge has-pack" title="已有步骤审计">审计</span>`
        : `<span class="stepPackBadge no-pack" title="缺少 scripts/steps/${block.nodeId}/latest/step.json">缺审计</span>`;
      html = renderSvgBlock(
        "stack",
        "sb-task",
        `<span class="blockTitle">${escapeHtml(block.title)}</span><span class="pill ${block.status}">${statusLabel(block.status)}</span>${packBadge}`,
        isCurrent ? "is-current" : ""
      );
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "ref") {
      const pack = stepPackByNode.get(block.nodeId);
      const packBadge = pack?.exists
        ? `<span class="stepPackBadge has-pack">审计</span>`
        : `<span class="stepPackBadge no-pack">缺审计</span>`;
      html = `
      <div class="sb-reporter sb-looks">
        <span class="blockTitle">${escapeHtml(block.title)}</span>
        <span class="pill ${block.status}">${statusLabel(block.status)}</span>
        ${packBadge}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "wait") {
      html = renderSvgBlock(
        "stack",
        "sb-control",
        `<span>等待</span>
       <input class="sb-input sb-input-num" type="number" min="0.1" step="0.1" value="${block.seconds ?? 1}" data-edit-wait="${block.id}" />
       <span>秒</span>`
      );
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "waitUntil") {
      html = renderSvgBlock(
        "stack",
        "sb-control",
        `<span>等待直到</span>${renderCondition(block.condition, block.id)}`
      );
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "stop") {
      html = renderSvgBlock("cap", "sb-cap", `<span>${escapeHtml(block.label || "停止")}</span>`);
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "stopAll") {
      html = renderSvgBlock("cap", "sb-cap", "<span>停止全部</span>");
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "if") {
      html = `
      <div class="sb-c sb-control" data-path="${pathStr}">
        ${renderCBlockHead(`<span>如果</span>${renderCondition(block.condition, block.id)}<span>那么</span>`)}
        ${renderDropZone(block.body, path, "body")}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "ifElse") {
      html = `
      <div class="sb-c sb-control" data-path="${pathStr}">
        ${renderCBlockHead(`<span>如果</span>${renderCondition(block.condition, block.id)}<span>那么</span>`)}
        ${renderDropZone(block.body, path, "body")}
        <div class="sb-c-else-label">否则</div>
        ${renderDropZone(block.elseBody, path, "elseBody")}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "forever") {
      html = `
      <div class="sb-c sb-control" data-path="${pathStr}">
        ${renderCBlockHead("<span>一直重复</span>")}
        ${renderDropZone(block.body, path, "body")}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "repeat") {
      html = `
      <div class="sb-c sb-control" data-path="${pathStr}">
        ${renderCBlockHead(`
          <span>重复</span>
          <input class="sb-input sb-input-num" type="number" min="1" max="999" value="${block.times || 1}" data-edit-repeat="${block.id}" />
          <span>次${block.label ? ` · ${escapeHtml(block.label)}` : ""}</span>`)}
        ${renderDropZone(block.body, path, "body")}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "repeatUntil") {
      html = `
      <div class="sb-c sb-control" data-path="${pathStr}">
        ${renderCBlockHead(`<span>重复直到</span>${renderCondition(block.condition, block.id)}`)}
        ${renderDropZone(block.body, path, "body")}
      </div>`;
      return wrapDeletable(html, block, path, deletable);
    }

    if (block.type === "boolStatus") {
      return `<span class="sb-bool">状态 = ${statusLabel(block.status)}</span>`;
    }

    return "";
  }

  function renderInsertLine(parentPath, index) {
    const hatOnly = parentPath.length === 0 && index === 0 ? ' data-hat-slot="1"' : "";
    return `<div class="insertLine${parentPath.length === 0 && index === 0 ? " insertLineHat" : ""}" data-parent-path="${parentPath.join(".")}" data-insert-at="${index}"${hatOnly} aria-label="插入位置 ${index}"></div>`;
  }

  function renderBlockList(blocks, parentPath) {
    let html = renderInsertLine(parentPath, 0);
    if (!blocks.length) {
      html += `<div class="cEmpty">拖到蓝色插入线处松手；或从左侧点击插入</div>`;
    } else {
      blocks.forEach((b, i) => {
        html += renderBlockHTML(b, [...parentPath, i]);
        html += renderInsertLine(parentPath, i + 1);
      });
    }
    return html;
  }

  function renderCapBlock() {
    return renderSvgBlock("cap", "sb-cap", "<span>结束</span>", "scriptEnd");
  }

  function renderNodePaletteButton(node) {
    const status = completionToStatus(node.completion);
    const title = truncate(node.title, 26);
    const isRef = isReferenceNode(node.id);
    const preview = isRef
      ? `<div class="sb-reporter sb-looks"><span class="blockTitle">${escapeHtml(title)}</span><span class="pill ${status}">${statusLabel(status)}</span></div>`
      : renderSvgBlock(
          "stack",
          "sb-task",
          `<span class="blockTitle">${escapeHtml(title)}</span><span class="pill ${status}">${statusLabel(status)}</span>`
        );
    return `
    <div class="paletteBlock paletteNode" tabindex="0" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(node.id)} · ${escapeHtml(node.title)}" draggable="true" aria-label="${escapeHtml(node.title)}">
      ${preview}
    </div>`;
  }

  function renderNodePaletteSection() {
    if (!state?.parsed?.nodes?.length) return "";
    const nodes = [...state.parsed.nodes].sort((a, b) => compareNodeId(a.id, b.id));
    const execNodes = nodes.filter((n) => !isReferenceNode(n.id));
    const refNodes = nodes.filter((n) => isReferenceNode(n.id));

    let items = "";
    if (execNodes.length) {
      items += `<p class="paletteSub">执行节点</p>${execNodes.map(renderNodePaletteButton).join("")}`;
    }
    if (refNodes.length) {
      items += `<p class="paletteSub">参考节点</p>${refNodes.map(renderNodePaletteButton).join("")}`;
    }

    return `
    <h3>任务图节点</h3>
    <p class="paletteHint">与关系图相同，共 ${nodes.length} 个；拖入脚本或点击插入。</p>
    ${items}`;
  }

  function renderPalette() {
    if (!blockPalette) return;
    const sections = PALETTE.map((section) => {
      const items = section.items
        .map((item) => {
          const previewKind =
            item.kind.startsWith("hat") || item.kind === "stop" || item.kind === "stopAll"
              ? item.kind.startsWith("hat")
                ? "hat"
                : "cap"
              : ["if", "ifElse", "repeat", "forever", "repeatUntil"].includes(item.kind)
                ? "c"
                : "stack";
          let preview = "";
          if (previewKind === "hat") {
            preview = renderSvgBlock("hat", "sb-events", escapeHtml(item.preview));
          } else if (previewKind === "cap") {
            preview = renderSvgBlock("cap", "sb-cap", escapeHtml(item.preview));
          } else if (previewKind === "c") {
            preview = `
            <div class="sb-c sb-control">
              ${renderCBlockHead(`<span>${escapeHtml(item.preview)}</span>`)}
            </div>`;
          } else if (item.kind.startsWith("bool")) {
            preview = `<span class="sb-bool">${escapeHtml(item.preview)}</span>`;
          } else {
            preview = renderSvgBlock("stack", "sb-control", escapeHtml(item.preview));
          }
          const draggable = !item.kind.startsWith("bool");
          return `
          <div class="paletteBlock" tabindex="0" data-add="${item.kind}" title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}" ${draggable ? 'draggable="true"' : ""}>
            ${preview}
          </div>`;
        })
        .join("");
      return `<h3>${section.title}</h3>${items}`;
    }).join("");

    blockPalette.innerHTML = `${sections}${renderNodePaletteSection()}`;
    bindPaletteEvents();
  }

  function bindPaletteEvents() {
    if (!blockPalette) return;
    blockPalette.querySelectorAll(".paletteBlock[data-add]").forEach((el) => {
      el.addEventListener("click", () => insertControlBlock(el.dataset.add));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          insertControlBlock(el.dataset.add);
        }
      });
    });
    blockPalette.querySelectorAll(".paletteBlock[data-node-id]").forEach((el) => {
      el.addEventListener("click", () => insertNodeBlock(el.dataset.nodeId));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          insertNodeBlock(el.dataset.nodeId);
        }
      });
    });
    blockPalette.querySelectorAll(".paletteBlock[draggable=true]").forEach((el) => {
      el.addEventListener("dragstart", onPaletteDragStart);
      el.addEventListener("dragend", onPaletteDragEnd);
    });
  }

  function renderScript() {
    if (blocksTitle) {
      blocksTitle.textContent = scriptMode === "run" ? "本次运行脚本" : "项目脚本";
    }
    if (blocksDesc) {
      blocksDesc.innerHTML =
        scriptMode === "run"
          ? `当前焦点 <strong>${escapeHtml(state.focusId)}</strong>：ROOT → Current 路径。左侧可拖入 Scratch 控制块。`
          : "从上到下执行。拖拽时蓝色插入线标示松手位置；左侧块可拖入或点击插入。";
    }
    renderScriptVersionPanel();

    scriptColumn.innerHTML = `
    <div class="scriptStack">${renderBlockList(state.blocks, [])}${renderCapBlock()}</div>`;
    bindBlockEvents();
  }

  function renderAll() {
    if (!state) return;
    renderPalette();
    renderScript();
  }

  function insertControlBlock(kind) {
    if (!state?.blocks) return;
    const block = createControlBlock(kind);
    if (block.type === "hat") {
      const hatIdx = state.blocks.findIndex((b) => b.type === "hat");
      if (hatIdx >= 0) state.blocks[hatIdx] = block;
      else state.blocks.unshift(block);
    } else {
      insertBlockIntoScript(block);
    }
    saveScriptToServer();
    renderAll();
  }

  function insertNodeBlock(nodeId) {
    if (!state?.blocks || !state?.parsed) return;
    const node = state.parsed.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const block = isReferenceNode(nodeId) ? refBlockFromNode(node) : taskBlockFromNode(node);
    insertBlockIntoScript(block);
    saveScriptToServer();
    renderAll();
  }

  function createBlockFromPalettePayload(payload) {
    if (!payload || !state?.parsed) return null;
    if (payload.type === "control") {
      return createControlBlock(payload.kind);
    }
    if (payload.type === "node") {
      const node = state.parsed.nodes.find((n) => n.id === payload.nodeId);
      if (!node) return null;
      return isReferenceNode(node.id) ? refBlockFromNode(node) : taskBlockFromNode(node);
    }
    return null;
  }

  function readPalettePayload(event) {
    if (event?.dataTransfer) {
      const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          /* fall through */
        }
      }
    }
    return dragPalettePayload;
  }

  function insertBlockIntoScript(block) {
    const capIdx = state.blocks.findIndex((b) => b.type === "stop" || b.type === "stopAll");
    if (capIdx >= 0) state.blocks.splice(capIdx, 0, block);
    else state.blocks.push(block);
  }

  function findBlockPathInTree(list, prefix, target) {
    for (let i = 0; i < list.length; i += 1) {
      const block = list[i];
      const path = [...prefix, i];
      if (block === target) return path;
      if (block.body) {
        const inBody = findBlockPathInTree(block.body, [...path, "body"], target);
        if (inBody) return inBody;
      }
      if (block.elseBody) {
        const inElse = findBlockPathInTree(block.elseBody, [...path, "elseBody"], target);
        if (inElse) return inElse;
      }
    }
    return null;
  }

  function resolveMoveFromPath(block) {
    if (!block) return null;
    const path = findBlockPathInTree(state.blocks, [], block);
    if (!path || !isValidMoveFromPath(path)) return null;
    if (getBlockByPath(path) !== block) return null;
    return path;
  }

  function pathEquals(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  function insertBlockAt(parentPath, index, block, moveFromPath = null) {
    const list = getListByPath(parentPath);
    if (!list || !block) return false;

    if (block.type === "hat") {
      if (parentPath.length !== 0 || index !== 0) return false;
      if (moveFromPath?.length && !removeBlockAtPath([...moveFromPath])) return false;
      const hatIdx = list.findIndex((b) => b.type === "hat");
      if (hatIdx >= 0) list[hatIdx] = block;
      else list.unshift(block);
      return true;
    }

    let insertIndex = Number.isFinite(index) ? index : list.length;
    if (parentPath.length === 0 && list[0]?.type === "hat" && insertIndex === 0) {
      insertIndex = 1;
    }

    if (moveFromPath?.length) {
      if (!isValidMoveFromPath(moveFromPath)) return false;
      const moveParent = moveFromPath.slice(0, -1);
      const fromIdx = moveFromPath[moveFromPath.length - 1];
      if (typeof fromIdx !== "number") return false;
      const movingBlock = getBlockByPath(moveFromPath);
      if (!movingBlock || movingBlock.type === "hat" || isContainerBlock(movingBlock)) return false;

      if (pathEquals(moveParent, parentPath)) {
        if (fromIdx < 0 || fromIdx >= list.length) return false;
        if (fromIdx === insertIndex || fromIdx + 1 === insertIndex) return true;
        const [item] = list.splice(fromIdx, 1);
        let target = insertIndex;
        if (fromIdx < target) target -= 1;
        target = Math.max(0, Math.min(target, list.length));
        list.splice(target, 0, item);
        return true;
      }

      const srcList = getListByPath(moveParent);
      if (!srcList || fromIdx < 0 || fromIdx >= srcList.length) return false;
      const [item] = srcList.splice(fromIdx, 1);
      if (parentPath.length === 0 && list[0]?.type === "hat" && insertIndex === 0) {
        insertIndex = 1;
      }
      insertIndex = Math.max(0, Math.min(insertIndex, list.length));
      list.splice(insertIndex, 0, item);
      return true;
    }

    insertIndex = Math.max(0, Math.min(insertIndex, list.length));
    list.splice(insertIndex, 0, block);
    return true;
  }

  function deleteBlockAtPath(pathStr) {
    const path = parsePath(pathStr);
    if (!path.length) return;
    const block = getBlockByPath(path);
    if (!block || block.type === "hat") return;
    if (!removeBlockAtPath(path)) return;
    saveScriptToServer();
    renderAll();
  }

  function getBlockByPath(path) {
    if (!path.length) return null;
    let list = state.blocks;
    let block = null;
    for (const seg of path) {
      if (seg === "body" || seg === "elseBody") {
        if (!block) return null;
        if (!block[seg]) block[seg] = [];
        list = block[seg];
      } else {
        block = list[seg];
        if (!block) return null;
      }
    }
    return block;
  }

  function getListByPath(path) {
    if (!path?.length) return state.blocks;
    if (typeof path[path.length - 1] === "number") return null;

    let list = state.blocks;
    let block = null;
    for (const seg of path) {
      if (seg === "body" || seg === "elseBody") {
        if (!block) return null;
        if (!block[seg]) block[seg] = [];
        list = block[seg];
      } else if (typeof seg === "number") {
        block = list?.[seg];
        if (!block) return null;
      } else {
        return null;
      }
    }
    return list;
  }

  function findBlockById(id) {
    return flattenBlocks(state.blocks).find((b) => b.id === id) || null;
  }

  function parsePath(str) {
    if (!str) return [];
    return str.split(".").map((s) => (s === "body" || s === "elseBody" ? s : parseInt(s, 10)));
  }

  function setNestedField(obj, fieldPath, value) {
    const parts = fieldPath.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (!cur[key] || typeof cur[key] !== "object") cur[key] = defaultCondition();
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function clearDragState() {
    dragBlockId = null;
    dragFromPath = null;
    dragPalettePayload = null;
    dragSession = null;
    activeDropSlot = null;
    scriptColumn?.classList.remove("is-dnd-active");
    scriptColumn?.querySelectorAll(".insertLine.is-active").forEach((el) => el.classList.remove("is-active"));
  }

  function setActiveInsertLine(line) {
    if (!line) return;
    scriptColumn?.querySelectorAll(".insertLine.is-active").forEach((el) => {
      if (el !== line) el.classList.remove("is-active");
    });
    line.classList.add("is-active");
    activeDropSlot = {
      parentPath: parsePath(line.dataset.parentPath),
      index: parseInt(line.dataset.insertAt, 10)
    };
  }

  function findNearestInsertLine(clientY, listPath = null) {
    const key = listPath ? listPath.join(".") : null;
    let lines;
    if (key !== null) {
      lines = scriptColumn?.querySelectorAll(
        key === "" ? '.insertLine[data-parent-path=""]' : `.insertLine[data-parent-path="${key}"]`
      );
    } else {
      lines = scriptColumn?.querySelectorAll(".insertLine");
    }
    if (!lines?.length) return null;
    let best = null;
    let bestDist = Infinity;
    lines.forEach((line) => {
      const rect = line.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = line;
      }
    });
    return best;
  }

  function startDragSession() {
    scriptColumn?.classList.add("is-dnd-active");
  }

  function isDragActive() {
    return Boolean(dragSession || dragBlockId || dragPalettePayload);
  }

  function dropEffectKind() {
    return dragSession?.type === "palette" || dragPalettePayload ? "copy" : "move";
  }

  function onPaletteDragStart(e) {
    const add = e.currentTarget.dataset.add;
    const nodeId = e.currentTarget.dataset.nodeId;
    clearDragState();
    dropHandled = false;
    if (add) {
      dragPalettePayload = { type: "control", kind: add };
      dragSession = { type: "palette", payload: { ...dragPalettePayload } };
    } else if (nodeId) {
      dragPalettePayload = { type: "node", nodeId };
      dragSession = { type: "palette", payload: { ...dragPalettePayload } };
    } else {
      e.preventDefault();
      return;
    }
    startDragSession();
    e.currentTarget.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "copy";
    const payloadJson = JSON.stringify(dragPalettePayload);
    e.dataTransfer.setData(PALETTE_DRAG_MIME, payloadJson);
    e.dataTransfer.setData("text/plain", payloadJson);
  }

  function onPaletteDragEnd(e) {
    e.currentTarget.classList.remove("is-dragging");
    if (!dropHandled) clearDragState();
  }

  function onBlockDragStart(e) {
    if (e.target.closest(".blockDelete")) {
      e.preventDefault();
      return;
    }
    dragPalettePayload = null;
    dropHandled = false;
    dragBlockId = e.currentTarget.dataset.blockId;
    const block = findBlockById(dragBlockId);
    const fromPath = resolveMoveFromPath(block) || parsePath(e.currentTarget.dataset.path);
    dragFromPath = fromPath;
    dragSession = {
      type: "move",
      blockId: dragBlockId,
      fromPath: [...fromPath],
      listPath: listPathFromBlockPath(fromPath)
    };
    startDragSession();
    e.currentTarget.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragBlockId);
  }

  function onBlockDragEnd(e) {
    e.currentTarget.classList.remove("is-dragging");
    if (!dropHandled) clearDragState();
  }

  function resolveDropBlock(event) {
    if (dragSession?.type === "move") {
      const block = findBlockById(dragSession.blockId);
      if (!block || block.type === "hat" || isContainerBlock(block)) return null;
      const moveFromPath = resolveMoveFromPath(block);
      if (!moveFromPath) return null;
      return { block, moveFromPath };
    }
    if (dragSession?.type === "palette") {
      const block = createBlockFromPalettePayload(dragSession.payload);
      if (!block) return null;
      return { block, moveFromPath: null };
    }
    if (dragFromPath?.length && dragBlockId) {
      const block = findBlockById(dragBlockId);
      if (!block || block.type === "hat" || isContainerBlock(block)) return null;
      const moveFromPath = resolveMoveFromPath(block);
      if (!moveFromPath) return null;
      return { block, moveFromPath };
    }
    const payload = readPalettePayload(event);
    const block = createBlockFromPalettePayload(payload);
    if (!block) return null;
    return { block, moveFromPath: null };
  }

  function finishDrop(event, { trustActiveSlot = false } = {}) {
    if (!trustActiveSlot && !activeDropSlot) {
      if (dragSession?.type === "move") {
        const line = findNearestInsertLine(event.clientY, dragSession.listPath);
        if (!line) return false;
        setActiveInsertLine(line);
      } else {
        const line = findNearestInsertLine(event.clientY);
        if (line) setActiveInsertLine(line);
      }
    }
    if (!activeDropSlot) return false;
    const resolved = resolveDropBlock(event);
    if (!resolved) return false;
    const { block, moveFromPath } = resolved;
    if (block.type === "hat") {
      if (activeDropSlot.parentPath.length !== 0 || activeDropSlot.index !== 0) return false;
    }
    if (dragSession?.type === "move") {
      const liveListPath = listPathFromBlockPath(moveFromPath);
      if (!pathEquals(activeDropSlot.parentPath, liveListPath)) return false;
    }
    return insertBlockAt(activeDropSlot.parentPath, activeDropSlot.index, block, moveFromPath);
  }

  function handleDropOnce(event, options = {}) {
    if (dropHandled) return;
    dropHandled = true;
    if (finishDrop(event, options)) {
      saveScriptToServer();
      renderAll();
    }
    clearDragState();
  }

  function removeBlockAtPath(path) {
    const idx = path[path.length - 1];
    if (typeof idx !== "number") return false;
    const list = getListByPath(path.slice(0, -1));
    if (!list || idx < 0 || idx >= list.length) return false;
    list.splice(idx, 1);
    return true;
  }

  async function refreshDrift() {
    try {
      driftState = await fetchFlowDrift(scriptMode);
      stepPackByNode = new Map((driftState?.stepPacks || []).map((p) => [p.nodeId, p]));
    } catch {
      driftState = null;
      stepPackByNode = new Map();
    }
    renderDriftBanner();
  }

  function renderDriftBanner() {
    if (!flowDriftBanner) return;
    const drift = driftState?.drift;
    if (!drift?.drifted) {
      flowDriftBanner.hidden = true;
      flowDriftBanner.innerHTML = "";
      return;
    }
    const parts = [];
    if (drift.missingInFlow?.length) parts.push(`缺块: ${drift.missingInFlow.join(", ")}`);
    if (drift.staleInFlow?.length) parts.push(`过时: ${drift.staleInFlow.join(", ")}`);
    if (drift.statusMismatch?.length) parts.push(`状态不一致 ${drift.statusMismatch.length} 处`);
    if (drift.orderDiffers) parts.push("顺序与任务图建议不一致");
    flowDriftBanner.hidden = false;
    flowDriftBanner.innerHTML = `<span class="flowDriftText">⚠ 流程漂移 — ${escapeHtml(parts.join(" · "))}</span>`;
  }

  async function selectStepNode(nodeId) {
    selectedStepNodeId = nodeId || "";
    renderScript();
    if (!flowStepInspectorInner) return;
    if (!nodeId) {
      flowStepInspectorInner.innerHTML =
        `<h3 class="flowStepInspectorTitle">步骤详情</h3><p class="flowStepInspectorHint muted">点击左侧任务块查看本步代码、prompt 与产出。</p>`;
      return;
    }
    const block = state?.blocks?.find((b) => b.nodeId === nodeId);
    const node = state?.parsed?.nodes?.find((n) => n.id === nodeId);
    const title = block?.title || node?.title || nodeId;
    flowStepInspectorInner.innerHTML = `<h3 class="flowStepInspectorTitle">${escapeHtml(nodeId)} · ${escapeHtml(title)}</h3><p class="muted">加载步骤审计…</p>`;
    try {
      const data = await fetchFlowStep(nodeId);
      renderStepInspectorContent(nodeId, title, data);
    } catch (error) {
      flowStepInspectorInner.innerHTML = `<h3 class="flowStepInspectorTitle">${escapeHtml(nodeId)}</h3><p class="flowStepErr">${escapeHtml(error.message)}</p>`;
    }
  }

  function renderStepInspectorContent(nodeId, title, packData) {
    const step = packData?.step;
    const packDir = `scripts/steps/${nodeId}/latest`;
    const reportPath = `${packDir}/${step?.reportZh || "report.zh.md"}`;
    let html = `<h3 class="flowStepInspectorTitle">${escapeHtml(nodeId)} · ${escapeHtml(title)}</h3>`;
    html += `<div class="flowStepMeta muted">审计目录: ${escapeHtml(packDir)}</div>`;
    if (!step) {
      html += `<p class="flowStepEmpty">尚无步骤审计包。Agent 完成本步后应写入 <code>${escapeHtml(packDir)}/step.json</code> 与中文 <code>report.zh.md</code>。</p>`;
      flowStepInspectorInner.innerHTML = html;
      wireStepInspectorActions();
      return;
    }
    html += `<div class="flowStepActions">
      <button type="button" class="flowStepLinkBtn" data-file-path="${escapeHtml(reportPath)}">📄 中文审计 report.zh.md</button>
    </div>`;
    const substeps = step.substeps || [];
    if (!substeps.length) {
      html += `<p class="muted">step.json 已存在，但 substeps 为空。</p>`;
    } else {
      html += `<ol class="flowSubstepList">${substeps
        .map((sub, index) => {
          const fnRows = (sub.functions || [])
            .map(
              (fn) =>
                `<button type="button" class="flowStepCodeBtn" data-code-path="${escapeHtml(fn.path)}" data-code-line="${fn.line || 1}">${escapeHtml(fn.path)}:${fn.line || 1}${fn.name ? ` # ${escapeHtml(fn.name)}` : ""}</button>`
            )
            .join("");
          const promptZh = sub.promptZh ? `${packDir}/${sub.promptZh}`.replace(/\/+/g, "/") : "";
          const promptEn = sub.promptEn ? `${packDir}/${sub.promptEn}`.replace(/\/+/g, "/") : "";
          const outputs = (sub.outputs || [])
            .map((o) => {
              const p = o.path || o;
              return `<button type="button" class="flowStepLinkBtn" data-file-path="${escapeHtml(p)}">${escapeHtml(p)}</button>`;
            })
            .join("");
          const inputs = (sub.inputs || [])
            .map((o) => {
              const p = o.path || o;
              const line = o.line ? `:${o.line}` : "";
              return `<button type="button" class="flowStepLinkBtn" data-file-path="${escapeHtml(p)}" data-code-line="${o.line || 1}">${escapeHtml(p)}${line}</button>`;
            })
            .join("");
          return `<li class="flowSubstepItem">
            <div class="flowSubstepTitle">${index + 1}. ${escapeHtml(sub.title || "子步骤")}</div>
            ${fnRows ? `<div class="flowSubstepRow"><span class="flowSubstepLabel">代码</span>${fnRows}</div>` : ""}
            ${promptZh ? `<div class="flowSubstepRow"><span class="flowSubstepLabel">Prompt</span><button type="button" class="flowStepLinkBtn" data-file-path="${escapeHtml(promptZh)}">中文 prompt</button>${promptEn ? `<button type="button" class="flowStepLinkBtn muted" data-file-path="${escapeHtml(promptEn)}">英文原文</button>` : ""}</div>` : ""}
            ${inputs ? `<div class="flowSubstepRow"><span class="flowSubstepLabel">输入</span>${inputs}</div>` : ""}
            ${outputs ? `<div class="flowSubstepRow"><span class="flowSubstepLabel">产出</span>${outputs}</div>` : ""}
          </li>`;
        })
        .join("")}</ol>`;
    }
    flowStepInspectorInner.innerHTML = html;
    wireStepInspectorActions();
  }

  function wireStepInspectorActions() {
    flowStepInspectorInner?.querySelectorAll("[data-code-path]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openInEditor(btn.dataset.codePath, Number.parseInt(btn.dataset.codeLine, 10) || 1).catch(console.error);
      });
    });
    flowStepInspectorInner?.querySelectorAll("[data-file-path]").forEach((btn) => {
      if (btn.dataset.codePath) return;
      btn.addEventListener("click", async () => {
        const path = btn.dataset.filePath;
        try {
          const preview = await previewFileSnippet(path);
          const pre = flowStepInspectorInner.querySelector(".flowStepFilePreview");
          if (pre) pre.remove();
          const el = document.createElement("pre");
          el.className = "flowStepFilePreview";
          el.textContent = preview.content || preview.text || JSON.stringify(preview, null, 2);
          flowStepInspectorInner.appendChild(el);
        } catch (error) {
          console.error(error);
        }
      });
    });
  }

  function bindBlockEvents() {
    scriptColumn.querySelectorAll(".blockWrap[data-node-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".blockDelete")) return;
        if (e.defaultPrevented) return;
        selectStepNode(el.dataset.nodeId);
      });
    });
    scriptColumn.querySelectorAll(".blockWrap.is-draggable").forEach((el) => {
      el.addEventListener("dragstart", onBlockDragStart);
      el.addEventListener("dragend", onBlockDragEnd);
      el.addEventListener("dragover", onBlockWrapDragOver);
      el.addEventListener("drop", onBlockWrapDrop);
    });
    scriptColumn.querySelectorAll(".insertLine").forEach((el) => {
      el.addEventListener("dragover", onInsertLineDragOver);
      el.addEventListener("drop", onInsertLineDrop);
    });
    if (scriptColumn) {
      scriptColumn.addEventListener("dragover", onScriptColumnDragOver);
      scriptColumn.addEventListener("drop", onScriptColumnDrop);
      scriptColumn.addEventListener("dragenter", (e) => {
        if (isDragActive()) e.preventDefault();
      });
    }
    scriptColumn.querySelectorAll("[data-edit-repeat]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const b = findBlockById(e.target.dataset.editRepeat);
        if (b) b.times = Math.max(1, parseInt(e.target.value, 10) || 1);
        saveScriptToServer();
      });
    });
    scriptColumn.querySelectorAll("[data-edit-wait]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const b = findBlockById(e.target.dataset.editWait);
        if (b) b.seconds = Math.max(0.1, parseFloat(e.target.value) || 1);
        saveScriptToServer();
      });
    });
    scriptColumn.querySelectorAll("[data-edit-bool]").forEach((select) => {
      select.addEventListener("change", (e) => {
        const b = findBlockById(e.target.dataset.editBool);
        if (!b) return;
        const field = e.target.dataset.boolField || "condition";
        setNestedField(b, field, { type: "boolStatus", status: e.target.value });
        saveScriptToServer();
      });
    });
    scriptColumn.querySelectorAll("[data-delete-path]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        deleteBlockAtPath(btn.dataset.deletePath);
      });
    });
  }

  function onInsertLineDragOver(e) {
    if (!isDragActive()) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragSession?.type === "move") {
      const linePath = parsePath(e.currentTarget.dataset.parentPath);
      if (!pathEquals(linePath, dragSession.listPath)) return;
    }
    setActiveInsertLine(e.currentTarget);
    e.dataTransfer.dropEffect = dropEffectKind();
  }

  function onInsertLineDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setActiveInsertLine(e.currentTarget);
    handleDropOnce(e, { trustActiveSlot: true });
  }

  function onBlockWrapDragOver(e) {
    if (!isDragActive()) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = e.currentTarget;
    const rect = wrap.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height * 0.45;
    const line = before ? wrap.previousElementSibling : wrap.nextElementSibling;
    if (line?.classList.contains("insertLine")) {
      setActiveInsertLine(line);
    } else {
      const listPath = dragSession?.type === "move" ? dragSession.listPath : null;
      setActiveInsertLine(findNearestInsertLine(e.clientY, listPath));
    }
    e.dataTransfer.dropEffect = dropEffectKind();
  }

  function onBlockWrapDrop(e) {
    if (!isDragActive()) return;
    e.preventDefault();
    e.stopPropagation();
    handleDropOnce(e, { trustActiveSlot: Boolean(activeDropSlot) });
  }

  function onScriptColumnDragOver(e) {
    if (!isDragActive()) return;
    if (e.target.closest(".insertLine")) return;
    e.preventDefault();
    const listPath = dragSession?.type === "move" ? dragSession.listPath : null;
    setActiveInsertLine(findNearestInsertLine(e.clientY, listPath));
    e.dataTransfer.dropEffect = dropEffectKind();
  }

  function onScriptColumnDrop(e) {
    if (!isDragActive()) return;
    if (e.target.closest(".blockDelete")) return;
    e.preventDefault();
    handleDropOnce(e);
  }

  flowOverviewLink?.addEventListener("click", async () => {
    selectedStepNodeId = "";
    if (!flowStepInspectorInner) return;
    flowStepInspectorInner.innerHTML = `<h3 class="flowStepInspectorTitle">项目流程总览</h3><p class="muted">加载…</p>`;
    try {
      const preview = await previewFileSnippet("scripts/flow-overview.zh.md", 12000);
      flowStepInspectorInner.innerHTML = `<h3 class="flowStepInspectorTitle">项目流程总览</h3><pre class="flowStepFilePreview">${escapeHtml(preview.content || preview.text || "")}</pre>`;
    } catch (error) {
      flowStepInspectorInner.innerHTML = `<p class="flowStepErr">未找到 scripts/flow-overview.zh.md — Agent 维护流程后应生成此文件。</p>`;
    }
  });

  syncStatusBtn?.addEventListener("click", async () => {
    try {
      const data = await postSyncFlowStatus(scriptMode, "UI 同步状态");
      if (data?.script) applyScript(data.script);
      if (Array.isArray(data?.versions)) state.versions = data.versions;
      await refreshDrift();
      renderAll();
    } catch (err) {
      console.error("[flow-view] sync status failed:", err);
    }
  });

  rebuildFlowBtn?.addEventListener("click", async () => {
    const ok = window.confirm("按当前任务图重排流程块？会先版本备份；不会删除 scripts/steps/ 审计包。");
    if (!ok) return;
    try {
      const data = await postRebuildFlow(scriptMode, "UI 重排流程");
      if (data?.script) applyScript(data.script);
      if (Array.isArray(data?.versions)) state.versions = data.versions;
      await refreshDrift();
      renderAll();
    } catch (err) {
      console.error("[flow-view] rebuild failed:", err);
    }
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setScriptMode(btn.dataset.scriptMode));
  });

  autoLayoutBtn?.addEventListener("click", async () => {
    if (!state?.parsed) return;
    await saveScriptVersion("重新生成前自动备份");
    const built = autoBuildScript(state.parsed, scriptMode);
    state.blocks = built.blocks;
    state.focusId = built.focusId;
    await flushSaveToServer("重新生成脚本");
    renderAll();
  });

  resetBtn?.addEventListener("click", async () => {
    await saveScriptVersion("重置前自动备份");
    await loadData(true);
  });

  exportFlowSvgBtn?.addEventListener("click", async () => {
    await exportCurrentFlowSvg();
  });

  async function exportCurrentFlowSvg() {
    await loadData(false);
    if (!state?.blocks?.length) return false;
    // The chat widget inlines this file, so the sibling module has no url to load from either.
    const inlined = window.__taskTreeLazyModules?.["/graph-export.js"];
    const mod = await import(inlined
      ? URL.createObjectURL(new Blob([inlined], { type: "text/javascript" }))
      : "/graph-export.js");
    const modeLabel = scriptMode === "run" ? "本次运行" : "项目脚本";
    const svg = mod.buildFlowGraphSvg(state.blocks, {
      mode: modeLabel,
      title: blocksTitle?.textContent?.trim() || "执行流程"
    });
    if (!svg) return false;
    const stamp = new Date().toISOString().slice(0, 10);
    mod.downloadSvg(svg, `task-flow-${scriptMode}-${stamp}.svg`);
    return true;
  }

  saveScriptVersionBtn?.addEventListener("click", async () => {
    const label = window.prompt("版本说明（可选）", scriptMode === "run" ? "本次运行快照" : "项目脚本快照");
    if (label === null) return;
    await saveScriptVersion(label || "手动保存");
  });

  restoreScriptVersionBtn?.addEventListener("click", async () => {
    const versionId = scriptVersionSelect?.value;
    if (!versionId) return;
    const entry = state?.versions?.find((v) => v.id === versionId);
    const ok = window.confirm(
      `恢复到「${entry?.label || entry?.reason || "选中版本"}」？\n当前脚本会先自动保存为一个版本。`
    );
    if (ok) await restoreScriptVersion(versionId);
  });

  updateModeButtons();
  loadData().catch((err) => {
    console.error("[flow-view] load failed:", err);
    rootEl.innerHTML = `<p class="flowViewError">模块流加载失败：${escapeHtml(err.message)}</p>`;
  });

  return {
    reload() {
      return loadData(false);
    },
    reset() {
      return loadData(true);
    },
    setScriptMode(mode) {
      return setScriptMode(mode);
    },
    getScriptMode() {
      return scriptMode;
    },
    async flushSave(reason) {
      return flushSaveToServer(reason || "手动刷新保存");
    },
    exportFlowSvg() {
      return exportCurrentFlowSvg();
    },
    destroy() {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
      rootEl.innerHTML = "";
    }
  };
}

export default initFlowView;
