const nodeFields = ["problem", "approach", "input", "output", "metrics", "notes"];
const KB_TOP_K = 20;
const KB_WEB_TOP_K = 8;
const KB_PREVIEW_CHARS = 520;
const KB_CONTEXT_SNIPPET_CHARS = 1600;
const KB_CONTEXT_MAX_CHARS = 36000;
const KB_HISTORY_MAX_TURNS = 12;
const IO_FILE_PREVIEW_CHARS = 3600;
const KB_HISTORY_STORAGE_KEY = "taskTree.knowledgeHistory";
const LEFT_PANE_WIDTH_STORAGE_KEY = "taskTree.leftPaneWidth";
const LEFT_PANE_COLLAPSED_STORAGE_KEY = "taskTree.leftPaneCollapsed.v2";
const RIGHT_PANE_COLLAPSED_STORAGE_KEY = "taskTree.rightPaneCollapsed.v2";
const CHAIN_DOCK_COLLAPSED_STORAGE_KEY = "taskTree.chainDockCollapsed.v1";
const LEFT_PANE_MIN_WIDTH = 260;
const LEFT_PANE_MAX_WIDTH = 960;
const USER_GRAPH_STATE_STORAGE_KEY = "taskTree.userGraphState";
/** Set by task_tree_render, which screenshots this page to show the graph inside a chat. */
const snapshotMode = new URLSearchParams(window.location.search).get("snapshot") === "1";
/** Set by task_tree_open, which embeds this page as an interactive widget inside a chat. */
const embedMode = new URLSearchParams(window.location.search).get("embed") === "1"
  || window.__taskTreeEmbed === true;

// Set before the first paint, so the chat renders the compact layout instead of reflowing into it.
if (embedMode) document.body.classList.add("embedMode");

/**
 * Resolves a lazily imported module.
 *
 * Inside the chat widget the page is inlined into a document on a foreign origin, so `/flow-view.js`
 * would resolve to a path that does not exist there. The bundle ships those sources along and they
 * are handed to `import()` as blob urls instead.
 */
const lazyModuleUrls = new Map();
function moduleUrl(publicPath) {
  const inlined = window.__taskTreeLazyModules?.[publicPath];
  if (!inlined) return publicPath;
  if (!lazyModuleUrls.has(publicPath)) {
    lazyModuleUrls.set(publicPath, URL.createObjectURL(new Blob([inlined], { type: "text/javascript" })));
  }
  return lazyModuleUrls.get(publicPath);
}

/**
 * Tells the embedding widget the frame really loaded.
 *
 * A blocked subframe and an unreachable port both look like an empty box from the outside, so
 * silence is the only signal the widget can act on.
 */
function signalEmbedHost(stage) {
  if (!embedMode || window.parent === window) return;
  window.parent.postMessage({ type: "task-tree-embed-ready", stage }, "*");
}

signalEmbedHost("loaded");

/**
 * Asks the chat for room.
 *
 * A widget is handed a card a few hundred pixels tall, which is a poor place to read a graph. The
 * host decides whether to grant the request and may ignore one that comes without a click, so the
 * toggle stays available either way.
 */
async function askChatDisplayMode(mode) {
  try {
    const answer = await window.openai?.requestDisplayMode?.({ mode });
    return answer?.mode || window.openai?.displayMode || "inline";
  } catch {
    return window.openai?.displayMode || "inline";
  }
}

function chatDisplayMode() {
  return window.openai?.displayMode || "inline";
}

async function toggleChatDisplayMode() {
  const next = chatDisplayMode() === "fullscreen" ? "inline" : "fullscreen";
  const got = await askChatDisplayMode(next);
  applyChatDisplayMode(got);
  if (got !== next) setSaveState(next === "fullscreen" ? "这个对话不给铺满，先在小窗里看" : "已请求收回");
}

/**
 * Settles the page into the chat.
 *
 * A card a few hundred pixels tall is not a place to read a graph, so it opens expanded and the
 * toggle is there to give the room back. The first fit ran while the side panes were still
 * collapsing and the bar was still wrapping, so the scale it picked is stale by now.
 */
async function enterEmbedLayout() {
  els.embedExpandBtn?.removeAttribute("hidden");
  applyChatDisplayMode(await askChatDisplayMode("fullscreen"));
  // The host resizes the widget on its own schedule; nothing else notices inside a sandbox.
  window.addEventListener("resize", () => scheduleFitGraphToViewport());
}

function applyChatDisplayMode(mode) {
  const full = mode === "fullscreen";
  document.body.classList.toggle("embedFullscreen", full);
  if (els.embedExpandBtn) {
    els.embedExpandBtn.textContent = full ? "⤡" : "⤢";
    els.embedExpandBtn.title = full ? "收回对话里的小窗" : "在对话里铺开";
    els.embedExpandBtn.setAttribute("aria-pressed", full ? "true" : "false");
  }
  // The viewport just changed size and nothing else watches for that inside a widget.
  waitNextFrame(2).then(() => fitGraphToViewport(full ? 32 : 24)).catch(() => {});
}
const nodeFieldLabels = {
  Position: "position",
  Size: "size",
  Completion: "completion",
  Problem: "problem",
  Approach: "approach",
  Input: "input",
  Output: "output",
  Metrics: "metrics",
  Notes: "notes",
  CurrentResult: "currentResult",
  RootCauseAnalysis: "rootCauseAnalysis",
  CaseStudy: "caseStudy",
  NextIdea: "nextIdea",
  SelectedSkills: "selectedSkills",
  CodeLoc: "codeLoc",
  Folded: "folded",
  SubtreeFile: "subtreeFile",
  SubtreeCount: "subtreeCount",
  ReadStatus: "readStatus",
  ReadFingerprint: "readFingerprint"
};
const edgeFieldLabels = {
  Endpoints: "endpoints",
  LabelPosition: "labelPosition",
  LabelOffset: "labelOffset",
  Label: "label",
  Notes: "notes"
};

let nodes = [];
let edges = [];
let selectedId = null;
let ioPreviewNodeId = null;
let currentFocusId = "";
let nextFocusId = "";
let nextPlan = "";
let chainText = "";
let chainAutoAdvance = false;
let chainForceNext = "";
let chainRunStatus = "";
let chainDrag = null;
let dirty = false;
let draftLink = null;
let saveTimer = null;
let saveInFlight = false;
let saveAgain = false;
let editNodeId = null;
let editEdgeId = null;
const expandedEdgeLabelIds = new Set();
let lastLoadedMarkdown = "";
let lastSavedMarkdown = "";
let reloadTimer = null;
let versions = [];
let pendingSaveReason = "";
let currentVersionTimer = null;
let skillPanelNodeId = null;
let skillRecommendations = [];
let skillPanelLoading = false;
let skillPanelError = "";
let skillApplyNotice = "";
let modelAgents = [];
let modelPanelNodeId = null;
let modelPanelLoading = false;
let modelPanelError = "";
let modelPanelNotice = "";
let modelRunQuestion = "";
let modelNodeTurns = {};
const ioFilePreviewCache = new Map();
const ioFilePreviewRequests = new Set();
let modelNodeConversationsSaveTimer = null;
let modelNodeConversationsSaveInFlight = false;
let modelNodeConversationsSaveAgain = false;
const MODEL_NODE_TURNS_MAX = 24;
const MODEL_NODE_CONVERSATIONS_STORAGE_KEY = "taskTree.modelNodeTurns";
let knowledgeConfig = null;
let knowledgeIndex = null;
let webSearchConfig = null;
let openWebSearchStatus = null;
let knowledgeHistory = [];
let knowledgeHistoryScrollTop = 0;
let knowledgeHistoryShouldStickToBottom = true;
let knowledgeHistorySaveTimer = null;
let knowledgeHistorySaveInFlight = false;
let knowledgeHistorySaveAgain = false;
let knowledgeLoading = false;
let knowledgeError = "";
let knowledgeRetrievalStatus = "";
let knowledgeReindexJob = null;
let leftPaneCollapsed = false;
let rightPaneCollapsed = false;
let chainDockCollapsed = true;
let leftPaneWidth = null;
const floatingPanelOffsets = { io: {}, skill: {}, model: {} };
const floatingPanelSizes = { io: {} };
const neighborHintOffsets = {};
const neighborGuideVisibleIds = new Set();
let edgeDimOpacity = 0.35;
const graphView = { x: 40, y: 34, scale: 0.88 };
let shouldAutoFitView = true;
let workspaceMode = "main";
let activeSubtreePath = "";
let activeSubtreeFoldRoot = "";
let mainWorkspaceSnapshot = null;
let treeRegistry = { trees: [], activeMethod: "method" };
let viewTreeId = "";
let activeMethodTreeId = "method";
let maintenanceStatus = null;
let focusLensId = "";
let focusLensOpen = false;
let codexParallelContextOptions = [];
const codexParallelPendingAppendJobs = new Map();
let codexParallelBranchPlanning = false;
const card = {
  width: 520,
  height: 720,
  minWidth: 400,
  minHeight: 420,
  compactMinWidth: 340,
  compactMaxWidth: 480,
  compactMinHeight: 150,
  compactMaxHeight: 420,
  compactFocusMaxHeight: 560
};
const NODE_CARD_COMPACT_STORAGE_KEY = "taskTree.nodeCardCompact";
const PROJECT_OVERVIEW_SEEN_KEY = "taskTree.projectOverviewSeen";
const GRAPH_MAX_SCALE = 2.4;
const nodeDetailsOpenIds = new Set();
const renderedCompactNodeSizes = new Map();
let compactNodeMeasureFrame = 0;
let nodeCardCompact = (() => {
  try {
    const saved = localStorage.getItem(NODE_CARD_COMPACT_STORAGE_KEY);
    if (saved === null) return true;
    return saved !== "0" && saved !== "false";
  } catch {
    return true;
  }
})();

const els = {
  graphPane: document.querySelector(".graphPane"),
  graphViewport: document.querySelector("#graphViewport"),
  graphCanvas: document.querySelector("#graphCanvas"),
  edges: document.querySelector("#edges"),
  edgeLabels: document.querySelector("#edgeLabels"),
  nodesLayer: document.querySelector("#nodesLayer"),
  focusLens: document.querySelector("#focusLens"),
  focusLensClose: document.querySelector("#focusLensClose"),
  focusLensTrail: document.querySelector("#focusLensTrail"),
  focusLensBody: document.querySelector("#focusLensBody"),
  nodeCount: document.querySelector("#nodeCount"),
  linkState: document.querySelector("#linkState"),
  saveState: document.querySelector("#saveState"),
  versionState: document.querySelector("#versionState"),
  versionPaneSummary: document.querySelector("#versionPaneSummary"),
  versionList: document.querySelector("#versionList"),
  addChildBtn: document.querySelector("#addChildBtn"),
  edgeDimOpacityInput: document.querySelector("#edgeDimOpacity"),
  nodeCardCompactBtn: document.querySelector("#nodeCardCompactBtn"),
  projectOverviewBtn: document.querySelector("#projectOverviewBtn"),
  focusLensOpenBtn: document.querySelector("#focusLensOpenBtn"),
  projectOverviewDialog: document.querySelector("#projectOverviewDialog"),
  projectOverviewClose: document.querySelector("#projectOverviewClose"),
  projectOverviewTitle: document.querySelector("#projectOverviewTitle"),
  projectOverviewMeta: document.querySelector("#projectOverviewMeta"),
  projectOverviewBody: document.querySelector("#projectOverviewBody"),
  layoutTreeBtn: document.querySelector("#layoutTreeBtn"),
  fitViewBtn: document.querySelector("#fitViewBtn"),
  embedExpandBtn: document.querySelector("#embedExpandBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  reloadBtn: document.querySelector("#reloadBtn"),
  openInCodexBtn: document.querySelector("#openInCodexBtn"),
  codexThreadsBtn: document.querySelector("#codexThreadsBtn"),
  codexParallelBtn: document.querySelector("#codexParallelBtn"),
  codexThreadMenu: document.querySelector("#codexThreadMenu"),
  codexParallelDialog: document.querySelector("#codexParallelDialog"),
  codexParallelClose: document.querySelector("#codexParallelClose"),
  codexParallelForm: document.querySelector("#codexParallelForm"),
  codexParallelStageRail: document.querySelector("#codexParallelStageRail"),
  codexParallelObjectiveBar: document.querySelector("#codexParallelObjectiveBar"),
  codexParallelObjective: document.querySelector("#codexParallelObjective"),
  codexParallelRows: document.querySelector("#codexParallelRows"),
  codexParallelState: document.querySelector("#codexParallelState"),
  codexParallelSummary: document.querySelector("#codexParallelSummary"),
  codexParallelSummaryText: document.querySelector("#codexParallelSummaryText"),
  codexParallelGoalReview: document.querySelector("#codexParallelGoalReview"),
  codexParallelGoalLabel: document.querySelector("#codexParallelGoalLabel"),
  codexParallelGoalText: document.querySelector("#codexParallelGoalText"),
  codexParallelGoalStatus: document.querySelector("#codexParallelGoalStatus"),
  codexParallelGoalResult: document.querySelector("#codexParallelGoalResult"),
  codexParallelContexts: document.querySelector("#codexParallelContexts"),
  codexParallelContextSummary: document.querySelector("#codexParallelContextSummary"),
  codexParallelContextAssignments: document.querySelector("#codexParallelContextAssignments"),
  codexParallelContextPool: document.querySelector("#codexParallelContextPool"),
  codexParallelPlanTools: document.querySelector("#codexParallelPlanTools"),
  codexParallelAppendNode: document.querySelector("#codexParallelAppendNode"),
  codexParallelAddBranch: document.querySelector("#codexParallelAddBranch"),
  codexParallelAppendConfirm: document.querySelector("#codexParallelAppendConfirm"),
  codexParallelTableWrap: document.querySelector("#codexParallelTableWrap"),
  codexParallelReview: document.querySelector("#codexParallelReview"),
  codexParallelFiles: document.querySelector("#codexParallelFiles"),
  codexParallelTests: document.querySelector("#codexParallelTests"),
  codexParallelPatch: document.querySelector("#codexParallelPatch"),
  codexParallelReviewWarning: document.querySelector("#codexParallelReviewWarning"),
  codexParallelMore: document.querySelector("#codexParallelMore"),
  codexParallelAudit: document.querySelector("#codexParallelAudit"),
  codexParallelRegenerate: document.querySelector("#codexParallelRegenerate"),
  codexParallelOpen: document.querySelector("#codexParallelOpen"),
  codexParallelRetry: document.querySelector("#codexParallelRetry"),
  codexParallelReject: document.querySelector("#codexParallelReject"),
  codexParallelAccept: document.querySelector("#codexParallelAccept"),
  codexParallelStart: document.querySelector("#codexParallelStart"),
  shutdownBtn: document.querySelector("#shutdownBtn"),
  knowledgeState: document.querySelector("#knowledgeState"),
  knowledgePaneSummary: document.querySelector("#knowledgePaneSummary"),
  kbEnvInfo: document.querySelector("#kbEnvInfo"),
  kbLibrarySelect: document.querySelector("#kbLibrarySelect"),
  kbSearchAllLibraries: document.querySelector("#kbSearchAllLibraries"),
  kbLibraryStats: document.querySelector("#kbLibraryStats"),
  kbRetrievalDiversify: document.querySelector("#kbRetrievalDiversify"),
  kbRetrievalMaxChunks: document.querySelector("#kbRetrievalMaxChunks"),
  kbRetrievalMaxChunksVal: document.querySelector("#kbRetrievalMaxChunksVal"),
  kbRetrievalPool: document.querySelector("#kbRetrievalPool"),
  kbRetrievalPoolVal: document.querySelector("#kbRetrievalPoolVal"),
  kbRetrievalSaveBtn: document.querySelector("#kbRetrievalSaveBtn"),
  kbRetrievalStatus: document.querySelector("#kbRetrievalStatus"),
  kbReindexBtn: document.querySelector("#kbReindexBtn"),
  kbReindexAllBtn: document.querySelector("#kbReindexAllBtn"),
  kbQuestion: document.querySelector("#kbQuestion"),
  kbUseForModels: document.querySelector("#kbUseForModels"),
  kbUseWebSearch: document.querySelector("#kbUseWebSearch"),
  kbSearchBtn: document.querySelector("#kbSearchBtn"),
  kbAskBtn: document.querySelector("#kbAskBtn"),
  kbClearHistoryBtn: document.querySelector("#kbClearHistoryBtn"),
  kbIndexInfo: document.querySelector("#kbIndexInfo"),
  kbHistorySummary: document.querySelector("#kbHistorySummary"),
  kbHistory: document.querySelector("#kbHistory"),
  filePreviewDialog: document.querySelector("#filePreviewDialog"),
  filePreviewTitle: document.querySelector("#filePreviewTitle"),
  filePreviewContent: document.querySelector("#filePreviewContent"),
  filePreviewClose: document.querySelector("#filePreviewClose"),
  layoutMain: document.querySelector(".layout"),
  chainAutoAdvanceBtn: document.querySelector("#chainAutoAdvanceBtn"),
  chainDock: document.querySelector(".chainDock"),
  chainDockSummary: document.querySelector("#chainDockSummary"),
  toggleChainDockBtn: document.querySelector("#toggleChainDockBtn"),
  chainSlot: document.querySelector("#chainSlot"),
  chainClearBtn: document.querySelector("#chainClearBtn"),
  chainLoopHelpBtn: document.querySelector("#chainLoopHelpBtn"),
  chainLoopHelpDialog: document.querySelector("#chainLoopHelpDialog"),
  chainLoopHelpClose: document.querySelector("#chainLoopHelpClose"),
  chainLoopHelpPort: document.querySelector("#chainLoopHelpPort"),
  chainLoopHelpPrompt: document.querySelector("#chainLoopHelpPrompt"),
  chainLoopHelpCopyBtn: document.querySelector("#chainLoopHelpCopyBtn"),
  chainLoopCmdBar: document.querySelector("#chainLoopCmdBar"),
  chainLoopCmdText: document.querySelector("#chainLoopCmdText"),
  chainLoopCmdCopyBtn: document.querySelector("#chainLoopCmdCopyBtn"),
  chainRunBtn: document.querySelector("#chainRunBtn"),
  projectSwitchBtn: document.querySelector("#projectSwitchBtn"),
  projectSwitchName: document.querySelector("#projectSwitchName"),
  projectMenu: document.querySelector("#projectMenu"),
  workspaceBanner: document.querySelector("#workspaceBanner"),
  workspaceBannerTitle: document.querySelector("#workspaceBannerTitle"),
  workspaceBannerExitBtn: document.querySelector("#workspaceBannerExitBtn"),
  subtitle: document.querySelector("#subtitle"),
  treeSelect: document.querySelector("#treeSelect"),
  activeMethodBadge: document.querySelector("#activeMethodBadge"),
  setActiveMethodBtn: document.querySelector("#setActiveMethodBtn"),
  createTreeBtn: document.querySelector("#createTreeBtn"),
  maintenanceState: document.querySelector("#maintenanceState"),
  toggleLeftPaneBtn: document.querySelector("#toggleLeftPaneBtn"),
  toggleRightPaneBtn: document.querySelector("#toggleRightPaneBtn"),
  leftPaneResizeHandle: document.querySelector("[data-pane-resize='left']")
};

function parseMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const parsedNodes = [];
  const parsedEdges = [];
  const graphState = { current: "", next: "", nextPlan: "", chain: "", chainAutoAdvance: false, chainForceNext: "", chainRunStatus: "" };
  let mode = "nodes";
  let current = null;
  let activeField = null;

  function commit() {
    if (!current) return;
    if (current.kind === "edge") parsedEdges.push(current);
    else parsedNodes.push(current);
  }

  for (const line of lines) {
    if (/^#\s+Edges\s*$/i.test(line.trim())) {
      commit();
      current = null;
      activeField = null;
      mode = "edges";
      continue;
    }

    if (/^#\s+GraphState\s*$/i.test(line.trim())) {
      commit();
      current = null;
      activeField = null;
      mode = "state";
      continue;
    }

    if (mode === "state") {
      const stateField = line.match(/^-\s+(Current|Next|NextPlan|Chain|ChainAutoAdvance|ChainForceNext|ChainRunStatus):\s*(.*)$/);
      if (stateField) {
        if (stateField[1] === "Current") graphState.current = sanitizeId(stateField[2]);
        if (stateField[1] === "Next") graphState.next = sanitizeId(stateField[2]);
        if (stateField[1] === "NextPlan") graphState.nextPlan = stateField[2].trim();
        if (stateField[1] === "Chain") graphState.chain = stateField[2].trim();
        if (stateField[1] === "ChainAutoAdvance") graphState.chainAutoAdvance = /^(true|yes|1|是|on)$/i.test(stateField[2].trim());
        if (stateField[1] === "ChainForceNext") graphState.chainForceNext = sanitizeId(stateField[2]);
        if (stateField[1] === "ChainRunStatus") graphState.chainRunStatus = stateField[2].trim().toLowerCase();
      }
      continue;
    }

    const edgeHeading = line.match(/^##\s+(E[A-Za-z0-9_-]*)\s*(?:-\s*(.*))?$/);
    if (mode === "edges" && edgeHeading) {
      commit();
      current = {
        kind: "edge",
        id: edgeHeading[1].trim(),
        endpoints: [],
        labelX: null,
        labelY: null,
        offsetX: 0,
        offsetY: 0,
        label: edgeHeading[2]?.trim() || "",
        notes: ""
      };
      activeField = null;
      continue;
    }

    const nodeHeading = line.match(/^##\s+([A-Za-z0-9_-]+)\s+-\s+(.+)$/);
    if (mode === "nodes" && nodeHeading) {
      commit();
      current = {
        kind: "node",
        id: nodeHeading[1].trim(),
        title: nodeHeading[2].trim(),
        x: null,
        y: null,
        width: null,
        height: null,
        completion: "",
        problem: "",
        approach: "",
        input: "",
        output: "",
        metrics: "",
        notes: "",
        currentResult: "",
        rootCauseAnalysis: "",
        caseStudy: "",
        nextIdea: "",
        selectedSkills: "",
        legacyParent: "",
        folded: false,
        subtreeFile: "",
        subtreeCount: 0,
        readStatus: "",
        readFingerprint: "",
        codeLoc: ""
      };
      activeField = null;
      continue;
    }

    if (!current) continue;

    const nodeField = line.match(/^-\s+(Position|Size|Completion|Problem|Approach|Input|Output|Metrics|Notes|CurrentResult|RootCauseAnalysis|CaseStudy|NextIdea|SelectedSkills|CodeLoc|Parent|Status|Folded|SubtreeFile|SubtreeCount|ReadStatus|ReadFingerprint):\s*(.*)$/);
    if (current.kind === "node" && nodeField) {
      activeField = nodeFieldLabels[nodeField[1]] || (nodeField[1] === "Parent" ? "legacyParent" : null);
      if (nodeField[1] === "Status") activeField = "completion";
      if (!activeField) continue;
      if (activeField === "position") {
        const [x, y] = nodeField[2].split(",").map((part) => Number(part.trim()));
        current.x = Number.isFinite(x) ? x : null;
        current.y = Number.isFinite(y) ? y : null;
      } else if (activeField === "size") {
        const [width, height] = nodeField[2].split(",").map((part) => Number(part.trim()));
        current.width = Number.isFinite(width) ? width : null;
        current.height = Number.isFinite(height) ? height : null;
      } else if (activeField === "folded") {
        current.folded = /^(true|yes|1|是|已折叠)$/i.test(nodeField[2].trim());
      } else if (activeField === "subtreeCount") {
        current.subtreeCount = Number(nodeField[2]) || 0;
      } else {
        current[activeField] = nodeField[2].trim();
      }
      continue;
    }

    const edgeField = line.match(/^-\s+(Endpoints|LabelPosition|LabelOffset|Label|Notes):\s*(.*)$/);
    if (current.kind === "edge" && edgeField) {
      activeField = edgeFieldLabels[edgeField[1]];
      if (activeField === "endpoints") current.endpoints = parseEndpointList(edgeField[2]);
      else if (activeField === "labelPosition") {
        const [x, y] = edgeField[2].split(",").map((part) => Number(part.trim()));
        current.labelX = Number.isFinite(x) ? x : null;
        current.labelY = Number.isFinite(y) ? y : null;
      }
      else if (activeField === "labelOffset") {
        const [x, y] = edgeField[2].split(",").map((part) => Number(part.trim()));
        current.offsetX = Number.isFinite(x) ? x : 0;
        current.offsetY = Number.isFinite(y) ? y : 0;
      }
      else current[activeField] = edgeField[2].trim();
      continue;
    }

    const noteItem = line.match(/^\s{2}-\s?(.*)$/);
    if (noteItem && activeField) {
      const value = noteItem[1].trim();
      if (activeField === "endpoints") current.endpoints.push(...parseEndpointList(value));
      else if (activeField === "selectedSkills") {
        current.selectedSkills = current.selectedSkills
          ? `${current.selectedSkills}, ${value}`
          : value;
      } else current[activeField] = current[activeField] ? `${current[activeField]}\n${value}` : value;
      continue;
    }

    if (line.trim() && activeField && activeField !== "position") {
      current[activeField] = current[activeField] ? `${current[activeField]}\n${line.trim()}` : line.trim();
    }
  }

  commit();

  for (const node of parsedNodes) {
    if (!node.legacyParent) continue;
    parsedEdges.push({
      kind: "edge",
      id: nextEdgeId(parsedEdges),
      endpoints: [node.legacyParent, node.id],
      label: "父子/拆分",
      notes: ""
    });
  }

  return { nodes: parsedNodes, edges: normalizeEdges(parsedEdges, parsedNodes), graphState };
}

function toMarkdown(nextNodes, nextEdges) {
  const header = [
    "# LLM Task Graph",
    "",
    "> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。",
    ""
  ];

  const nodeBody = nextNodes.map((node) => [
    `## ${node.id} - ${node.title}`,
    "",
    bulletBlock("Position", hasPosition(node) ? `${Math.round(node.x)},${Math.round(node.y)}` : ""),
    bulletBlock("Size", hasSize(node) ? `${Math.round(node.width)},${Math.round(node.height)}` : ""),
    bulletBlock("Completion", node.completion),
    bulletBlock("Problem", node.problem),
    bulletBlock("Approach", node.approach),
    bulletBlock("Input", node.input),
    bulletBlock("Output", node.output),
    bulletBlock("Metrics", node.metrics),
    bulletBlock("Notes", node.notes),
    bulletBlock("CodeLoc", node.codeLoc),
    bulletBlock("CurrentResult", node.currentResult),
    bulletBlock("RootCauseAnalysis", node.rootCauseAnalysis),
    bulletBlock("CaseStudy", node.caseStudy),
    bulletBlock("NextIdea", node.nextIdea),
    bulletBlock("SelectedSkills", formatSelectedSkillsForMarkdown(node.selectedSkills)),
    isNodeFolded(node) ? bulletBlock("Folded", "true") : "",
    isNodeFolded(node) ? bulletBlock("SubtreeFile", node.subtreeFile) : "",
    isNodeFolded(node) ? bulletBlock("SubtreeCount", String(node.subtreeCount || 0)) : "",
    isNodeReadDone(node) ? bulletBlock("ReadStatus", node.readStatus) : "",
    isNodeReadDone(node) ? bulletBlock("ReadFingerprint", node.readFingerprint) : ""
  ].filter(Boolean).join("\n"));

  const edgeBody = nextEdges.map((edge) => [
    `## ${edge.id} - ${edge.label || "未命名关系"}`,
    "",
    bulletBlock("Endpoints", edge.endpoints.join(", ")),
    bulletBlock("LabelOffset", hasEdgeLabelOffset(edge) ? `${Math.round(edge.offsetX)},${Math.round(edge.offsetY)}` : ""),
    bulletBlock("Label", edge.label),
    bulletBlock("Notes", edge.notes)
  ].join("\n"));

  const stateBody = [
    "# GraphState",
    "",
    bulletBlock("Current", currentFocusId),
    bulletBlock("Next", nextFocusId),
    bulletBlock("NextPlan", nextPlan),
    chainText ? bulletBlock("Chain", chainText) : "",
    chainAutoAdvance ? bulletBlock("ChainAutoAdvance", "true") : "",
    chainForceNext ? bulletBlock("ChainForceNext", chainForceNext) : "",
    chainRunStatus ? bulletBlock("ChainRunStatus", chainRunStatus) : ""
  ].filter(Boolean).join("\n");

  return `${header.join("\n")}${nodeBody.join("\n\n")}\n\n${stateBody}\n\n# Edges\n\n${edgeBody.join("\n\n")}\n`;
}

function bulletBlock(label, value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return `- ${label}:`;
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return `- ${label}: ${lines[0] || ""}`;
  return [`- ${label}:`, ...lines.map((line) => `  - ${line}`)].join("\n");
}

const NODE_READ_CONTENT_FIELDS = [
  "title",
  "completion",
  "problem",
  "approach",
  "input",
  "output",
  "metrics",
  "notes",
  "currentResult",
  "rootCauseAnalysis",
  "caseStudy",
  "nextIdea",
  "selectedSkills"
];

function hashNodeReadContent(node) {
  const payload = NODE_READ_CONTENT_FIELDS.map((field) => String(node?.[field] || "")).join("\x1e");
  let hash = 5381;
  for (let i = 0; i < payload.length; i += 1) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function isNodeReadDone(node) {
  return String(node?.readStatus || "").trim() === "已经读完";
}

function markNodeReadDone(node, on) {
  if (!node) return;
  if (on) {
    node.readStatus = "已经读完";
    node.readFingerprint = hashNodeReadContent(node);
  } else {
    node.readStatus = "";
    node.readFingerprint = "";
  }
}

function syncReadFingerprintIfMarked(node) {
  if (!node || !isNodeReadDone(node)) return;
  node.readFingerprint = hashNodeReadContent(node);
}

function reconcileNodeReadStatus(node) {
  if (!node || !isNodeReadDone(node)) return;
  const stored = String(node.readFingerprint || "").trim();
  const current = hashNodeReadContent(node);
  if (!stored || stored !== current) {
    node.readStatus = "";
    node.readFingerprint = "";
  }
}

function readDoneButton(node) {
  const active = isNodeReadDone(node);
  return `<button type="button" data-action="toggle-read" class="readDoneBtn${active ? " active" : ""}" title="${active ? "取消已经读完" : "标记已经读完"}">读</button>`;
}

function formatSelectedSkillsForMarkdown(value) {
  const skills = parseSelectedSkills(value);
  return skills.size ? [...skills].join(", ") : "";
}

function renderTree() {
  els.nodeCount.textContent = `${nodes.length} nodes · ${edges.length} edges`;
  els.linkState.textContent = draftLink ? " · 正在拖动连接线" : "";
  const positionsChanged = ensureNodePositions();
  for (const node of nodes) ensureNodeSize(node);
  const highlights = getFocusHighlights();
  const { canvasWidth, canvasHeight } = updateGraphCanvasSize();
  applyGraphTransform();
  els.nodesLayer.innerHTML = "";
  const chainIds = new Set(parseChainIds(chainText));

  for (const node of nodes) {
    const nodeCard = document.createElement("article");
    nodeCard.className = `graphNode${node.id === selectedId ? " selected" : ""}`;
    if (isNodeFolded(node)) nodeCard.classList.add("folded");
    if (isNodeComplete(node)) nodeCard.classList.add("completed");
    if (isNodeReadDone(node)) nodeCard.classList.add("readDone");
    if (chainIds.has(node.id)) nodeCard.classList.add("inChain");
    if (node.id === editNodeId) nodeCard.classList.add("editing");
    if (highlights.currentNodes.has(node.id)) nodeCard.classList.add("currentPath");
    if (highlights.nextNodes.has(node.id)) nodeCard.classList.add("nextPath");
    if (node.id === currentFocusId) nodeCard.classList.add("currentFocus");
    if (node.id === nextFocusId) nodeCard.classList.add("nextFocus");
    if (nodeCardCompact && node.id !== editNodeId) nodeCard.classList.add("compactCard");
    nodeCard.style.left = `${node.x}px`;
    nodeCard.style.top = `${node.y}px`;
    nodeCard.style.width = `${nodeWidth(node)}px`;
    nodeCard.style.height = `${displayNodeHeight(node)}px`;
    nodeCard.dataset.nodeId = node.id;
    nodeCard.innerHTML = `${renderMacroNodeSummary(node, highlights)}${renderNodeCard(node)}`;
    wireNodeCard(nodeCard, node.id);
    wireCodeLocLinks(nodeCard);
    els.nodesLayer.appendChild(nodeCard);
  }
  measureRenderedCompactNodes();
  updateGraphCanvasSize();
  renderIoPreview(highlights);
  renderSkillPanel(highlights);
  renderModelPanel(highlights);
  renderNeighborGuides();
  renderChainDock();
  renderWorkspaceBanner();
  syncFocusLensToolbarButton();

  rerenderEdges();
  if (focusLensOpen) renderFocusLens();
  if (positionsChanged && !dirty && !saveInFlight) markDirty("将补齐节点位置避免图谱重叠");
}

function renderMacroNodeSummary(node) {
  const title = node.title || node.id;
  return `
    <span class="nodeMacroSummary" aria-label="${attr(title)}">
      <strong class="nodeMacroTitle">${escapeHtml(title)}</strong>
    </span>
  `;
}

function renderProjectOverview() {
  if (!els.projectOverviewBody) return;
  const tree = currentTreeEntry();
  const root = nodes.find((node) => node.id === "ROOT") || nodes[0];
  const current = nodes.find((node) => node.id === currentFocusId);
  const next = nodes.find((node) => node.id === nextFocusId);
  if (els.projectOverviewTitle) els.projectOverviewTitle.textContent = tree?.title || "项目回顾";
  if (els.projectOverviewMeta) {
    els.projectOverviewMeta.textContent = "一眼看清现在";
  }

  if (!nodes.length) {
    els.projectOverviewBody.innerHTML = '<p class="overviewEmpty">当前树还没有节点。</p>';
    return;
  }

  const purpose = overviewFirstLine(root?.problem || root?.title, "尚未记录根本目的。", 56);
  const active = next || current || root;
  const progress = overviewGlanceStatus(active?.currentResult || root?.currentResult, "还没有可靠的进度结论。", 88);
  const problem = overviewFirstLine(
    String(active?.problem || root?.problem || "").replace(/^\[子树\]\s*/, ""),
    "还没有记录当前问题。",
    64
  );
  const activeLabel = active ? `${active.id} · ${active.title || "未命名节点"}` : "尚未指定当前阶段";
  els.projectOverviewBody.innerHTML = `
    <section class="overviewThreePart overviewThreePart--purpose">
      <span class="overviewLargeLabel">根本目标</span>
      <p>${escapeHtml(purpose)}</p>
    </section>
    <section class="overviewThreePart overviewThreePart--progress">
      <span class="overviewLargeLabel">当前进度</span>
      <h3>${escapeHtml(activeLabel)}</h3>
      <p>${escapeHtml(progress)}</p>
    </section>
    <section class="overviewThreePart overviewThreePart--problem">
      <span class="overviewLargeLabel">当前问题</span>
      <p>${escapeHtml(problem)}</p>
    </section>
  `;
}

function focusLensText(value, fallback, maxChars = 360) {
  const text = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  return clipCardText(text || fallback, maxChars);
}

function focusLensFullText(value, fallback = "未填写") {
  const text = String(value || "").trim();
  return escapeHtml(text || fallback);
}

function renderFocusLensDetail(label, value) {
  if (!String(value || "").trim()) return "";
  return `<section class="focusLensDetailRow">
    <h4>${escapeHtml(label)}</h4>
    <p>${focusLensFullText(value)}</p>
  </section>`;
}

function syncFocusLensToolbarButton() {
  if (!els.focusLensOpenBtn) return;
  const visible = focusLensOpen && !els.focusLens?.hidden;
  const targetId = focusLensId || selectedId || nextFocusId || currentFocusId || "ROOT";
  const target = nodes.find((node) => node.id === targetId);
  els.focusLensOpenBtn.classList.toggle("is-active", visible);
  els.focusLensOpenBtn.setAttribute("aria-pressed", String(visible));
  els.focusLensOpenBtn.disabled = nodes.length === 0;
  els.focusLensOpenBtn.title = visible
    ? "关闭焦点透镜并定位到当前节点"
    : `对${target?.title || targetId || "当前节点"}打开焦点透镜`;
}

function focusLensRelations(nodeId) {
  const rootId = nodes.some((node) => node.id === "ROOT") ? "ROOT" : nodes[0]?.id;
  if (!rootId || !nodeId) return { parents: [], children: [] };
  const adjacency = buildSpanningTreeAdjacency(rootId);
  let parent = "";
  for (const [candidate, children] of adjacency) {
    if (children.includes(nodeId)) {
      parent = candidate;
      break;
    }
  }
  return {
    parents: parent ? [parent] : [],
    children: (adjacency.get(nodeId) || []).filter((id) => id !== nodeId)
  };
}

function renderFocusLensRelation(label, ids, direction) {
  const items = ids.map((id) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return "";
    return `<button type="button" class="focusLensRelation" data-focus-lens-node="${attr(id)}" aria-label="${attr(`${node.title || id}，${node.completion || "未开始"}`)}">
      <span class="focusLensRelationId">${escapeHtml(id)}</span>
      <strong>${escapeHtml(node.title || "未命名节点")}</strong>
    </button>`;
  }).join("");
  return `<section class="focusLensRelations focusLensRelations--${direction}">
    <h3>${escapeHtml(label)}</h3>
    <div class="focusLensRelationList">${items || `<p class="focusLensRelationEmpty">${direction === "before" ? "这里是起点" : "这里暂时没有下游节点"}</p>`}</div>
  </section>`;
}

function renderFocusLens() {
  if (!els.focusLens || !els.focusLensBody || !focusLensOpen) return;
  const node = nodes.find((item) => item.id === focusLensId);
  if (!node) {
    closeFocusLens({ locate: false });
    return;
  }
  const path = getPathToNode(node.id).nodes;
  if (els.focusLensTrail) {
    els.focusLensTrail.innerHTML = path.map((id, index) => {
      const item = nodes.find((candidate) => candidate.id === id);
      const separator = index ? '<span aria-hidden="true">›</span>' : "";
      return `${separator}<button type="button" class="focusLensCrumb${id === node.id ? " is-active" : ""}" data-focus-lens-node="${attr(id)}">${escapeHtml(item?.title || id)}</button>`;
    }).join("");
  }
  const relations = focusLensRelations(node.id);
  const inChain = parseChainIds(chainText).includes(node.id);
  const activeMethod = isViewingActiveMethodTree();
  const actionsOpen = Boolean(els.focusLensBody.querySelector(".focusLensActionsMenu")?.open);
  els.focusLensBody.innerHTML = `
    ${renderFocusLensRelation("从哪里来", relations.parents, "before")}
    <article class="focusLensCenter">
      <header class="focusLensCenterHeader">
        <div class="focusLensCenterIdentity">
          <span class="focusLensNodeId">${escapeHtml(node.id)}</span>
          <h2>${escapeHtml(node.title || "未命名节点")}</h2>
        </div>
        <span class="focusLensStatus">${escapeHtml(node.completion || "未开始")}</span>
      </header>
      <details class="focusLensActionsMenu"${actionsOpen ? " open" : ""}>
        <summary>节点操作</summary>
        <div class="focusLensActionBar" aria-label="当前节点操作">
          <button type="button" class="${node.id === currentFocusId ? "is-active" : ""}" data-focus-lens-action="set-current" aria-pressed="${node.id === currentFocusId}">● 设为当前</button>
          <button type="button" class="${node.id === nextFocusId ? "is-active" : ""}" data-focus-lens-action="set-next" aria-pressed="${node.id === nextFocusId}">◆ 设为下一步</button>
          ${activeMethod ? `<button type="button" class="${inChain ? "is-active" : ""}" data-focus-lens-action="toggle-chain" aria-pressed="${inChain}">${inChain ? "⊖ 移出执行链" : "⊕ 加入执行链"}</button>` : ""}
          <button type="button" class="${isNodeComplete(node) ? "is-active" : ""}" data-focus-lens-action="toggle-complete" aria-pressed="${isNodeComplete(node)}">✓ ${isNodeComplete(node) ? "已完成" : "标记完成"}</button>
          <button type="button" data-focus-lens-action="edit-node">✎ 编辑完整节点</button>
        </div>
      </details>
      <section class="focusLensNextWork">
        <header>
          <h3>下一步</h3>
        </header>
        <textarea class="focusLensNextIdeaInput" data-focus-lens-next-idea="${attr(node.id)}" placeholder="写一句可执行的话，并说明服务的方向和完成判据">${escapeHtml(node.nextIdea || "")}</textarea>
        ${activeMethod ? `<div class="focusLensNextActions">
          <button type="button" data-focus-lens-action="run-agent">保存并让 Codex 继续</button>
        </div>` : ""}
      </section>
      <div class="focusLensFields">
        <section class="focusLensField focusLensField--problem">
          <h3>问题</h3>
          <p>${escapeHtml(focusLensText(node.problem, "尚未记录要解决的问题。", 140))}</p>
        </section>
        <section class="focusLensField focusLensField--approach">
          <h3>思路</h3>
          <p>${escapeHtml(focusLensText(node.approach, "尚未记录解决思路。", 180))}</p>
        </section>
        <section class="focusLensField focusLensField--result">
          <h3>结果</h3>
          <p>${escapeHtml(focusLensText(node.currentResult, "尚未记录验证结果。", 180))}</p>
        </section>
      </div>
      <details class="focusLensDetails">
        <summary>更多详情</summary>
        <div class="focusLensDetailsBody">
          ${renderFocusLensDetail("输入", node.input)}
          ${renderFocusLensDetail("输出", node.output)}
          ${renderFocusLensDetail("评价标准", node.metrics)}
          ${renderFocusLensDetail("备注", node.notes)}
          ${renderFocusLensDetail("根因", node.rootCauseAnalysis)}
          ${renderFocusLensDetail("案例", node.caseStudy)}
          ${renderFocusLensDetail("代码与证据", node.codeLoc)}
          ${renderFocusLensDetail("已选能力", node.selectedSkills)}
          ${![node.input, node.output, node.metrics, node.notes, node.rootCauseAnalysis, node.caseStudy, node.codeLoc, node.selectedSkills].some((value) => String(value || "").trim())
            ? '<p class="focusLensDetailsEmpty">这个节点还没有更多详情。</p>'
            : ""}
        </div>
      </details>
    </article>
    ${renderFocusLensRelation("接下来通向", relations.children, "after")}
  `;
}

function openFocusLens(nodeId, { preserveActions = false } = {}) {
  const node = nodes.find((item) => item.id === nodeId) || nodes.find((item) => item.id === selectedId) || nodes[0];
  if (!node || !els.focusLens) return;
  if (els.projectOverviewDialog?.open) els.projectOverviewDialog.close();
  if (!preserveActions && els.focusLensBody) els.focusLensBody.innerHTML = "";
  focusLensId = node.id;
  focusLensOpen = true;
  selectedId = node.id;
  ioPreviewNodeId = node.id;
  els.focusLens.hidden = false;
  els.graphPane?.classList.add("has-focus-lens");
  renderFocusLens();
  renderTree();
  syncFocusLensToolbarButton();
}

function closeFocusLens({ locate = true } = {}) {
  const nodeId = focusLensId;
  focusLensOpen = false;
  focusLensId = "";
  if (els.focusLens) els.focusLens.hidden = true;
  els.graphPane?.classList.remove("has-focus-lens");
  syncFocusLensToolbarButton();
  if (locate && nodeId && nodes.some((node) => node.id === nodeId)) focusNodeInView(nodeId);
}

function resolveLensFocus(event) {
  const cardId = event?.target?.closest?.(".graphNode")?.dataset?.nodeId;
  if (cardId && nodes.some((node) => node.id === cardId)) return cardId;
  const point = graphPoint(event.clientX, event.clientY);
  let closest = null;
  let distance = Infinity;
  for (const node of nodes) {
    const centerX = (node.x || 0) + nodeWidth(node) / 2;
    const centerY = (node.y || 0) + displayNodeHeight(node) / 2;
    const nextDistance = Math.hypot(point.x - centerX, point.y - centerY);
    if (nextDistance < distance) {
      closest = node.id;
      distance = nextDistance;
    }
  }
  return closest || selectedId || nextFocusId || "ROOT";
}

function overviewFirstLine(value, fallback, maxChars = 180) {
  const line = String(value || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return clipCardText((line || fallback).replace(/^[-*]\s+/, ""), maxChars);
}

function overviewGlanceStatus(value, fallback, maxChars = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const clauses = text.split(/[。！？；;]/).map((item) => item.trim()).filter(Boolean);
  let lead = clauses[0] || text;
  const colon = lead.indexOf("：");
  if (colon >= 6) lead = lead.slice(0, colon);
  const gap = clauses.find((item, index) => index > 0 && /(?:^|，)(仍|尚|还|待|缺|未能|未验证)/.test(item));
  return clipCardText([lead, gap].filter(Boolean).join("；") || fallback, maxChars);
}

function overviewStatus(node) {
  const status = String(node?.completion || "").trim() || "未开始";
  const focus = [node?.id === currentFocusId ? "Current" : "", node?.id === nextFocusId ? "Next" : ""].filter(Boolean);
  return [...focus, status].join(" · ") || "未开始";
}

function focusProjectOverviewNode(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  els.projectOverviewDialog?.close();
  setGraphView("tree");
  focusNodeInView(nodeId);
}

function setProjectOverviewNext(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  nextFocusId = nodeId;
  selectedId = nodeId;
  ioPreviewNodeId = nodeId;
  saveUserGraphStateFocus();
  markDirty(`将修改下一步推进节点为${nodeTitle(nodeId)}`);
  renderTree();
  renderProjectOverview();
}

function openProjectOverview() {
  if (!els.projectOverviewDialog) return;
  renderProjectOverview();
  if (!els.projectOverviewDialog.open) els.projectOverviewDialog.showModal();
}

function overviewDailyStorageKey() {
  const day = new Date().toLocaleDateString("en-CA");
  return `${PROJECT_OVERVIEW_SEEN_KEY}.${location.host}.${viewTreeId}.${day}`;
}

function maybeOpenDailyProjectOverview() {
  if (snapshotMode || embedMode || workspaceMode !== "main" || !isViewingActiveMethodTree() || nodes.length < 2) return;
  const anotherModalIsOpen = [...document.querySelectorAll("dialog[open]")]
    .some((dialog) => dialog !== els.projectOverviewDialog);
  if (anotherModalIsOpen) return;
  try {
    const key = overviewDailyStorageKey();
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    // Daily recall remains optional when storage is unavailable.
  }
  openProjectOverview();
}

function renderIoPreview(highlights) {
  if (!ioPreviewNodeId) return;
  const node = nodes.find((item) => item.id === ioPreviewNodeId);
  if (!node) return;
  const preview = document.createElement("aside");
  preview.className = "ioPreview";
  if (highlights.currentNodes.has(node.id)) preview.classList.add("currentPath");
  if (highlights.nextNodes.has(node.id)) preview.classList.add("nextPath");
  const savedSize = floatingPanelSizes.io[node.id];
  const width = savedSize?.width ?? 360;
  const height = savedSize?.height ?? nodeHeight(node);
  const gap = 14;
  const baseX = Math.max(0, (node.x || 0) - width - gap);
  const baseY = node.y || 0;
  const offset = floatingPanelOffsets.io[node.id] || { x: 0, y: 0 };
  preview.style.left = `${Math.max(0, baseX + offset.x)}px`;
  preview.style.top = `${Math.max(0, baseY + offset.y)}px`;
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  const isEditing = node.id === editNodeId;
  if (isEditing) preview.classList.add("editing");
  preview.innerHTML = isEditing ? renderIoPreviewEditor(node) : renderIoPreviewReader(node);
  preview.innerHTML += `<span class="resizeHandle ioPreviewResize" title="拖动调整大小"></span>`;
  wireIoPreviewPanel(preview, node, baseX, baseY, isEditing);
  els.nodesLayer.appendChild(preview);
}

function wireIoPreviewPanel(preview, node, baseX, baseY, isEditing) {
  preview.querySelector("[data-panel-drag='io']")?.addEventListener("pointerdown", (event) => {
    startFloatingPanelDrag(event, preview, "io", node.id, baseX, baseY);
  });
  preview.querySelector("[data-io-close]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    ioPreviewNodeId = null;
    renderTree();
  });
  preview.querySelector(".ioPreviewResize")?.addEventListener("pointerdown", (event) => {
    startFloatingPanelResize(event, preview, node.id);
  });
  if (isEditing) wireIoPreviewEditor(preview, node.id);
  else wireIoPreviewLinks(preview);
}

function renderIoPreviewReader(node) {
  return `
    <div class="floatingPanelHeader ioPreviewHeader" data-panel-drag="io">
      <div class="ioPreviewHeaderTitle">
        <strong>输入 / 输出</strong>
        <span>内联样例 · 每行带注释</span>
      </div>
      <button type="button" class="floatingPanelCloseBtn" data-io-close title="关闭">×</button>
    </div>
    <section class="ioPreviewSection">
      <span class="ioPreviewLabel">输入 · 中文说明与证据路径</span>
      ${ioPreviewBody(node.input, "input", node.id)}
    </section>
    <section class="ioPreviewSection">
      <span class="ioPreviewLabel">输出 · 中文结论与产物路径</span>
      ${ioPreviewBody(node.output, "output", node.id)}
    </section>
  `;
}

function renderIoPreviewEditor(node) {
  return `
    <div class="floatingPanelHeader ioPreviewHeader" data-panel-drag="io">
      <div class="ioPreviewHeaderTitle">
        <strong>编辑 输入 / 输出</strong>
        <span>简明中文；详细内容放文件</span>
      </div>
      <button type="button" class="floatingPanelCloseBtn" data-io-close title="关闭">×</button>
    </div>
    <section class="ioPreviewSection ioPreviewSectionEditing">
      <span class="ioPreviewLabel">输入 · 来源说明</span>
      <textarea class="ioPreviewEditor" data-field="input" placeholder="用户提供的实验记录；完整内容见 data/records.md">${escapeHtml(node.input || "")}</textarea>
    </section>
    <section class="ioPreviewSection ioPreviewSectionEditing">
      <span class="ioPreviewLabel">输出 · 产物说明</span>
      <textarea class="ioPreviewEditor" data-field="output" placeholder="已生成评估表和中文结论；详见 outputs/report.md">${escapeHtml(node.output || "")}</textarea>
    </section>
    <div class="ioPreviewHint">节点只写简明中文说明和必要路径；代码、原始数据、命令、日志及复杂英文术语放到证据文件。</div>
  `;
}

function wireIoPreviewEditor(container, nodeId) {
  container.querySelectorAll(".ioPreviewEditor").forEach((control) => {
    const field = control.dataset.field;
    const commit = () => updateNodeField(nodeId, field, control.value, false);
    control.addEventListener("input", commit);
    control.addEventListener("change", () => updateNodeField(nodeId, field, control.value, true));
  });
}

function renderSkillPanel(highlights) {
  const node = nodes.find((item) => item.id === skillPanelNodeId);
  if (!node) return;
  const panel = document.createElement("aside");
  panel.className = "skillPanel";
  if (highlights.currentNodes.has(node.id)) panel.classList.add("currentPath");
  if (highlights.nextNodes.has(node.id)) panel.classList.add("nextPath");
  const width = 360;
  const gap = 14;
  const baseX = (node.x || 0) + nodeWidth(node) + gap;
  const baseY = node.y || 0;
  const offset = floatingPanelOffsets.skill[node.id] || { x: 0, y: 0 };
  panel.style.left = `${Math.max(0, baseX + offset.x)}px`;
  panel.style.top = `${Math.max(0, baseY + offset.y)}px`;
  panel.style.width = `${width}px`;
  panel.style.height = `${nodeHeight(node)}px`;
  panel.innerHTML = renderSkillPanelContent(node);
  wireSkillPanel(panel, node, baseX, baseY);
  els.nodesLayer.appendChild(panel);
}

function renderSkillOptionItem(skill, { checked = false } = {}) {
  const name = skill.name || skillIdLabel(skill.id);
  const summary = String(skill.functionText || "").trim() || `用于 ${name} 相关任务。`;
  const highlight = String(skill.highlightText || "").trim();
  const match = String(skill.matchText || "").trim();
  return `
    <label class="skillOption${skill.pinned ? " pinned" : ""}">
      <input type="checkbox" value="${attr(skill.id)}" ${checked ? "checked" : ""}>
      <span class="skillOptionBody">
        <strong class="skillOptionName">${escapeHtml(name)}</strong>
        <span class="skillOptionSummary">${escapeHtml(summary)}</span>
        ${highlight ? `<span class="skillOptionHighlight">${escapeHtml(highlight)}</span>` : ""}
        ${match ? `<span class="skillOptionMatch">${escapeHtml(match)}</span>` : ""}
        ${skill.pinned ? `<em class="skillPinnedNote">已选</em>` : ""}
      </span>
    </label>
  `;
}

function renderSkillPanelContent(node) {
  if (skillPanelLoading) {
    return `
      <div class="skillPanelHeader floatingPanelHeader" data-panel-drag="skill">
        <strong>可用能力</strong>
        <button type="button" data-skill-close title="关闭">×</button>
      </div>
      <div class="skillPanelEmpty">正在根据下一步思路检索...</div>
    `;
  }
  if (skillPanelError) {
    return `
      <div class="skillPanelHeader floatingPanelHeader" data-panel-drag="skill">
        <strong>可用能力</strong>
        <button type="button" data-skill-close title="关闭">×</button>
      </div>
      <div class="skillPanelEmpty">${escapeHtml(skillPanelError)}</div>
    `;
  }
  const selected = parseSelectedSkills(node.selectedSkills);
  const panelSkills = buildSkillPanelSkills(node);
  const items = panelSkills.map((skill) => renderSkillOptionItem(skill, { checked: selected.has(skill.id) })).join("");
  return `
    <div class="skillPanelHeader floatingPanelHeader" data-panel-drag="skill">
      <strong>最相关能力 · 已去重筛选</strong>
      <button type="button" data-skill-close title="关闭">×</button>
    </div>
    <div class="skillPanelList">
      ${items || `<div class="skillPanelEmpty">没有找到明显匹配的能力，可以先把下一步写得更具体。</div>`}
    </div>
    <div class="skillPanelFooter">
      ${skillApplyNotice ? `<span class="skillApplyNotice">${escapeHtml(skillApplyNotice)}</span>` : ""}
      <span class="skillPanelFooterActions">
        <button type="button" data-skill-clear>清空全部</button>
        <button type="button" data-skill-apply>使用勾选能力</button>
      </span>
    </div>
  `;
}

function buildSkillPanelSkills(node) {
  const selected = parseSelectedSkills(node.selectedSkills);
  const byId = new Map();
  for (const skill of skillRecommendations) {
    if (skill?.id) byId.set(skill.id, { ...skill, pinned: false });
  }
  for (const id of selected) {
    if (byId.has(id)) {
      byId.get(id).pinned = true;
      continue;
    }
    byId.set(id, {
      id,
      name: skillIdLabel(id),
      functionText: `用于 ${skillIdLabel(id)} 相关任务。`,
      highlightText: "当前节点已选择；重新推荐后可查看更具体的用途与亮点。",
      matchText: "当前节点已选择",
      pinned: true
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(a.functionText || a.id).localeCompare(String(b.functionText || b.id));
  });
}

function skillIdLabel(id) {
  const raw = String(id || "").trim();
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function wireSkillPanel(panel, node, baseX, baseY) {
  panel.querySelector("[data-panel-drag='skill']")?.addEventListener("pointerdown", (event) => {
    startFloatingPanelDrag(event, panel, "skill", node.id, baseX, baseY);
  });
  panel.querySelector("[data-skill-close]")?.addEventListener("click", () => {
    skillPanelNodeId = null;
    renderTree();
  });
  panel.querySelector("[data-skill-clear]")?.addEventListener("click", async () => {
    panel.querySelectorAll(".skillOption input").forEach((input) => {
      input.checked = false;
    });
    node.selectedSkills = "";
    syncReadFingerprintIfMarked(node);
    skillPanelError = "";
    skillApplyNotice = "正在清空并保存…";
    renderTree();
    try {
      await persistTreeNow(`将清空${node.title}选择的skills`, { backup: false });
      skillApplyNotice = "已清空并保存到 task-tree.md";
    } catch (error) {
      skillPanelError = error.message;
      skillApplyNotice = "";
      dirty = true;
    }
    renderTree();
  });
  panel.querySelector("[data-skill-apply]")?.addEventListener("click", async () => {
    const selected = [...panel.querySelectorAll(".skillOption input:checked")].map((input) => input.value);
    node.selectedSkills = selected.join(", ");
    syncReadFingerprintIfMarked(node);
    skillPanelError = "";
    skillApplyNotice = selected.length
      ? `正在保存 ${selected.length} 个能力…`
      : "正在清空并保存…";
    renderTree();
    try {
      await persistTreeNow(`将修改${node.title}选择的skills`, { backup: false });
      skillApplyNotice = selected.length
        ? `已保存 ${selected.length} 个能力到 task-tree.md`
        : "已清空并保存到 task-tree.md";
    } catch (error) {
      skillPanelError = error.message;
      skillApplyNotice = "";
      dirty = true;
    }
    renderTree();
  });
}

function modelCollabBar(node) {
  const configured = modelAgents.filter((agent) => agent.enabled && agent.model && agent.baseUrl && agent.hasApiKey).length;
  const turnCount = (modelNodeTurns[node.id] || []).length;
  const label = configured ? `${configured} 个模型可用` : "未配置模型";
  const historyLabel = turnCount ? ` · ${turnCount} 轮对话已保存` : "";
  return `
    <span class="modelCollabBar">
      <span class="modelCollabLabel">模型协作</span>
      <span class="modelCollabText">${escapeHtml(label)}${escapeHtml(historyLabel)}</span>
      <button type="button" class="modelCollabBtn" data-action="model-panel" title="打开多模型协作面板">打开</button>
    </span>
  `;
}

function buildModelTurnSummary(turn) {
  const source = stripMarkdownPlain(turn.question || "");
  if (!source) return "模型对话";
  if (source.length <= 30) return source;
  return `${source.slice(0, 30)}…`;
}

function normalizeModelNodeTurn(turn) {
  const models = {};
  const rawModels = turn?.models && typeof turn.models === "object" ? turn.models : {};
  for (const [modelId, entry] of Object.entries(rawModels)) {
    if (!modelId || !entry || typeof entry !== "object") continue;
    models[modelId] = {
      answer: String(entry.answer || ""),
      ok: entry.ok !== false,
      error: String(entry.error || ""),
      elapsedMs: Number(entry.elapsedMs) || 0,
      toolEvents: Array.isArray(entry.toolEvents) ? entry.toolEvents : []
    };
  }
  const normalized = {
    id: String(turn?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    createdAt: String(turn?.createdAt || new Date().toISOString()),
    question: String(turn?.question || ""),
    collapsed: turn?.collapsed === true,
    includeWeb: turn?.includeWeb === true,
    useKnowledgeSearch: turn?.useKnowledgeSearch !== false,
    autoRetrieval: turn?.autoRetrieval && typeof turn.autoRetrieval === "object" ? {
      executedQuery: String(turn.autoRetrieval.executedQuery || ""),
      rewriteSource: String(turn.autoRetrieval.rewriteSource || ""),
      resultCount: Number(turn.autoRetrieval.resultCount) || 0,
      includeWeb: turn.autoRetrieval.includeWeb === true
    } : null,
    summary: String(turn?.summary || ""),
    models
  };
  if (!normalized.summary) normalized.summary = buildModelTurnSummary(normalized);
  return normalized;
}

function serializeModelNodeConversationsForStorage() {
  const nodes = {};
  for (const [nodeId, turns] of Object.entries(modelNodeTurns)) {
    if (!nodeId || !Array.isArray(turns) || !turns.length) continue;
    nodes[nodeId] = turns.slice(-MODEL_NODE_TURNS_MAX).map((turn) => ({
      id: turn.id,
      createdAt: turn.createdAt,
      question: turn.question,
      collapsed: turn.collapsed === true,
      includeWeb: turn.includeWeb === true,
      useKnowledgeSearch: turn.useKnowledgeSearch !== false,
      summary: turn.summary || buildModelTurnSummary(turn),
      autoRetrieval: turn.autoRetrieval || null,
      models: Object.fromEntries(Object.entries(turn.models || {}).map(([modelId, entry]) => [modelId, {
        answer: String(entry.answer || "").slice(0, 8000),
        ok: entry.ok !== false,
        error: String(entry.error || ""),
        elapsedMs: Number(entry.elapsedMs) || 0,
        toolEvents: Array.isArray(entry.toolEvents) ? entry.toolEvents.slice(0, 6) : []
      }]))
    }));
  }
  return nodes;
}

function persistModelNodeConversationsToLocalStorage() {
  try {
    localStorage.setItem(MODEL_NODE_CONVERSATIONS_STORAGE_KEY, JSON.stringify(serializeModelNodeConversationsForStorage()));
  } catch {
    // ignore quota errors
  }
}

async function flushModelNodeConversationsToServer() {
  if (modelNodeConversationsSaveInFlight) {
    modelNodeConversationsSaveAgain = true;
    return;
  }
  modelNodeConversationsSaveInFlight = true;
  try {
    const response = await fetch("/api/model-conversations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodes: serializeModelNodeConversationsForStorage() })
    });
    if (!response.ok) throw new Error("save failed");
  } catch {
    // localStorage still holds a copy
  } finally {
    modelNodeConversationsSaveInFlight = false;
    if (modelNodeConversationsSaveAgain) {
      modelNodeConversationsSaveAgain = false;
      flushModelNodeConversationsToServer();
    }
  }
}

function persistModelNodeConversations() {
  persistModelNodeConversationsToLocalStorage();
  clearTimeout(modelNodeConversationsSaveTimer);
  modelNodeConversationsSaveTimer = setTimeout(() => {
    modelNodeConversationsSaveTimer = null;
    flushModelNodeConversationsToServer();
  }, 350);
}

async function loadModelNodeConversations() {
  let loadedFromServer = false;
  try {
    const response = await fetch(`/api/model-conversations?t=${Date.now()}`);
    const data = await response.json();
    if (response.ok && data.nodes && typeof data.nodes === "object") {
      modelNodeTurns = {};
      for (const [nodeId, turns] of Object.entries(data.nodes)) {
        if (!Array.isArray(turns) || !turns.length) continue;
        modelNodeTurns[nodeId] = turns.slice(-MODEL_NODE_TURNS_MAX).map((turn) => normalizeModelNodeTurn(turn));
      }
      loadedFromServer = true;
    }
  } catch {
    // fall through
  }
  if (!loadedFromServer) {
    try {
      const raw = localStorage.getItem(MODEL_NODE_CONVERSATIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          modelNodeTurns = {};
          for (const [nodeId, turns] of Object.entries(parsed)) {
            if (!Array.isArray(turns) || !turns.length) continue;
            modelNodeTurns[nodeId] = turns.slice(-MODEL_NODE_TURNS_MAX).map((turn) => normalizeModelNodeTurn(turn));
          }
          await flushModelNodeConversationsToServer();
        }
      }
    } catch {
      modelNodeTurns = {};
    }
  }
  if (!modelNodeTurns || typeof modelNodeTurns !== "object") modelNodeTurns = {};
}

function appendModelNodeTurn(nodeId, turn) {
  modelNodeTurns[nodeId] = modelNodeTurns[nodeId] || [];
  modelNodeTurns[nodeId].push(normalizeModelNodeTurn(turn));
  if (modelNodeTurns[nodeId].length > MODEL_NODE_TURNS_MAX) {
    modelNodeTurns[nodeId] = modelNodeTurns[nodeId].slice(-MODEL_NODE_TURNS_MAX);
  }
  persistModelNodeConversations();
}

function buildModelConversationForApi(nodeId, modelId) {
  const messages = [];
  for (const turn of modelNodeTurns[nodeId] || []) {
    const entry = turn.models?.[modelId];
    if (!entry) continue;
    messages.push({ role: "user", content: turn.question });
    messages.push({
      role: "assistant",
      content: entry.ok ? entry.answer : `运行失败：${entry.error || "未知错误"}`
    });
  }
  return messages.slice(-12);
}

function renderModelToolSummary(toolEvents) {
  if (!Array.isArray(toolEvents) || !toolEvents.length) return "";
  return `<div class="modelToolSummary">${toolEvents.map((item) => {
    const queryLabel = item.refinedQuery && item.refinedQuery !== item.query
      ? `${escapeHtml(item.query)} → ${escapeHtml(item.refinedQuery)}`
      : escapeHtml(item.query || "");
    const weakHint = item.queryWasWeak ? " · 系统已改写弱 query" : "";
    return `追加检索：${queryLabel} · ${item.resultCount || 0} 条${item.includeWeb ? " · 联网" : ""}${weakHint}${item.errors?.length ? ` · ${escapeHtml(item.errors.join("; "))}` : ""}`;
  }).join("<br>")}</div>`;
}

function renderModelHistoryTurn(turn, turnIndex) {
  const summary = turn.summary || buildModelTurnSummary(turn);
  const collapsed = turn.collapsed === true;
  const toggleLabel = collapsed ? "展开" : "折叠";
  const autoLine = turn.autoRetrieval?.executedQuery
    ? `<div class="modelHistoryAutoQuery">自动检索：${escapeHtml(turn.autoRetrieval.executedQuery)}${turn.autoRetrieval.rewriteSource === "llm" ? " · 大模型提取" : ""} · ${turn.autoRetrieval.resultCount || 0} 条${turn.autoRetrieval.includeWeb ? " · 联网" : ""}</div>`
    : turn.useKnowledgeSearch === false
      ? `<div class="modelHistoryAutoQuery muted">未启用检索（侧栏「送入模型协作」未勾选）</div>`
      : "";
  const modelBlocks = Object.entries(turn.models || {}).map(([modelId, entry]) => {
    const agent = modelAgents.find((item) => item.id === modelId);
    const name = agent?.name || modelId;
    return `
      <article class="modelResult ${entry.ok ? "ok" : "bad"}">
        <header>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(agent?.model || "")}${entry.elapsedMs ? ` · ${Math.round(entry.elapsedMs / 1000)}s` : ""}</span>
        </header>
        ${renderModelToolSummary(entry.toolEvents)}
        <div class="modelResultBody">${entry.ok ? renderMarkdownLite(entry.answer || "") : `<span class="modelPanelError">${escapeHtml(entry.error || "运行失败")}</span>`}</div>
      </article>
    `;
  }).join("");
  return `
    <article class="modelHistoryTurn${collapsed ? " is-collapsed" : ""}" data-model-turn-id="${attr(turn.id)}">
      <header>
        <div class="modelHistoryTurnTitle">
          <strong>第 ${turnIndex + 1} 轮</strong>
          <div class="modelTurnSummary">${escapeHtml(summary)}</div>
          <div class="modelHistoryTurnMeta">${escapeHtml(new Date(turn.createdAt || Date.now()).toLocaleString())}${turn.includeWeb ? " · 联网" : ""}</div>
        </div>
        <div class="modelHistoryTurnActions">
          <button type="button" data-model-toggle-turn title="${collapsed ? "展开本轮" : "折叠后只显示摘要"}">${toggleLabel}</button>
          <button type="button" class="danger" data-model-delete-turn title="删除本轮">删除</button>
        </div>
      </header>
      <div class="modelHistoryBody">
        <div class="modelHistoryQuestion">${escapeHtml(turn.question)}</div>
        ${autoLine}
        <div class="modelResults">${modelBlocks || `<div class="modelPanelEmpty">本轮没有模型回答。</div>`}</div>
      </div>
    </article>
  `;
}

function renderModelPanel(highlights) {
  const node = nodes.find((item) => item.id === modelPanelNodeId);
  if (!node) return;
  const panel = document.createElement("aside");
  panel.className = "modelPanel";
  if (highlights.currentNodes.has(node.id)) panel.classList.add("currentPath");
  if (highlights.nextNodes.has(node.id)) panel.classList.add("nextPath");
  const width = 480;
  const gap = 14;
  const baseX = (node.x || 0) + nodeWidth(node) + gap;
  const baseY = node.y || 0;
  const offset = floatingPanelOffsets.model[node.id] || { x: 0, y: 0 };
  panel.style.left = `${Math.max(0, baseX + offset.x)}px`;
  panel.style.top = `${Math.max(0, baseY + offset.y)}px`;
  panel.style.width = `${width}px`;
  panel.style.height = `${nodeHeight(node)}px`;
  panel.innerHTML = renderModelPanelContent(node);
  wireModelPanel(panel, node, baseX, baseY);
  wireModelHistoryPanel(panel, node);
  els.nodesLayer.appendChild(panel);
}

function renderModelPanelContent(node) {
  const configured = modelAgents.length ? modelAgents : [];
  const turns = modelNodeTurns[node.id] || [];
  const runItems = configured.map((agent) => `
    <label class="modelRunOption">
      <input type="checkbox" value="${attr(agent.id)}" ${agent.enabled !== false ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(agent.name || agent.id)}</strong>
        <small>${escapeHtml(agent.model || "未填写 model")} · ${agent.hasApiKey ? "已保存 key" : "未保存 key"}</small>
      </span>
    </label>
  `).join("");
  const historyItems = turns.map((turn, turnIndex) => renderModelHistoryTurn(turn, turnIndex)).join("");
  const historySummary = turns.length
    ? `${turns.length} 轮 · 已保存到 model-node-conversations.json（不写 task-tree）`
    : "尚无对话历史；运行后会在这里累积并写入项目文件。";
  return `
    <div class="modelPanelHeader floatingPanelHeader" data-panel-drag="model">
      <strong>多模型协作</strong>
      <button type="button" data-model-close title="关闭">×</button>
    </div>
    <section class="modelPanelBody">
      <div class="modelPanelSection">
        <div class="modelPanelTitle">当前节点</div>
        <div class="modelPanelNode">${escapeHtml(node.id)} · ${escapeHtml(node.title)}</div>
        <textarea class="modelQuestionInput" placeholder="写给多个模型的问题">${escapeHtml(modelRunQuestion || node.nextIdea || node.problem || "")}</textarea>
        <div class="modelRunList">${runItems || `<div class="modelPanelEmpty">还没有模型配置。</div>`}</div>
        <div class="modelPanelActions">
          <button type="button" data-model-run ${modelPanelLoading ? "disabled" : ""}>${modelPanelLoading ? "运行中..." : "让勾选模型一起想"}</button>
          <button type="button" data-model-clear ${modelPanelLoading ? "disabled" : ""}>清空本节点历史</button>
        </div>
        <div class="modelPanelEmpty">勾选侧栏「送入模型协作」= 运行前自动检索；仍可用 search JSON 追加检索。对话保存在 model-node-conversations.json，不写入 task-tree。</div>
        ${modelPanelError ? `<div class="modelPanelError">${escapeHtml(modelPanelError)}</div>` : ""}
        ${modelPanelNotice ? `<div class="modelPanelNotice">${escapeHtml(modelPanelNotice)}</div>` : ""}
      </div>
      <div class="modelPanelSection modelNodeHistorySection">
        <div class="modelNodeHistorySummary">${escapeHtml(historySummary)}</div>
        <div class="modelNodeHistory" data-model-history-root>
          ${historyItems || `<div class="modelPanelEmpty">运行后会在这里看到每轮完整输出。折叠后只显示约 30 字摘要。</div>`}
        </div>
      </div>
    </section>
  `;
}

function wireModelHistoryPanel(panel, node) {
  const root = panel.querySelector("[data-model-history-root]");
  if (!root || root.dataset.wired === "1") return;
  root.dataset.wired = "1";
  root.addEventListener("click", (event) => {
    const toggleBtn = event.target.closest("[data-model-toggle-turn]");
    if (toggleBtn) {
      const turnId = toggleBtn.closest("[data-model-turn-id]")?.getAttribute("data-model-turn-id");
      const turn = (modelNodeTurns[node.id] || []).find((item) => item.id === turnId);
      if (!turn) return;
      turn.collapsed = !turn.collapsed;
      persistModelNodeConversations();
      renderTree();
      return;
    }
    const deleteBtn = event.target.closest("[data-model-delete-turn]");
    if (deleteBtn) {
      const turnId = deleteBtn.closest("[data-model-turn-id]")?.getAttribute("data-model-turn-id");
      modelNodeTurns[node.id] = (modelNodeTurns[node.id] || []).filter((item) => item.id !== turnId);
      if (!modelNodeTurns[node.id]?.length) delete modelNodeTurns[node.id];
      persistModelNodeConversations();
      renderTree();
    }
  });
}

function wireModelPanel(panel, node, baseX, baseY) {
  panel.querySelector("[data-panel-drag='model']")?.addEventListener("pointerdown", (event) => {
    startFloatingPanelDrag(event, panel, "model", node.id, baseX, baseY);
  });
  panel.querySelector("[data-model-close]")?.addEventListener("click", () => {
    modelPanelNodeId = null;
    renderTree();
  });
  panel.querySelector("[data-model-run]")?.addEventListener("click", async () => {
    await runModelAgentsForNode(panel, node);
  });
  panel.querySelector("[data-model-clear]")?.addEventListener("click", async () => {
    delete modelNodeTurns[node.id];
    persistModelNodeConversations();
    try {
      await fetch("/api/model-conversations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id })
      });
    } catch {
      // local copy already cleared
    }
    modelPanelNotice = "已清空当前节点的模型对话历史。";
    renderTree();
  });
}

async function runModelAgentsForNode(panel, node) {
  modelRunQuestion = panel.querySelector(".modelQuestionInput")?.value.trim() || "";
  const modelIds = [...panel.querySelectorAll(".modelRunOption input:checked")].map((input) => input.value);
  if (!modelRunQuestion || !modelIds.length) {
    modelPanelError = "需要填写问题并至少勾选一个模型。";
    renderTree();
    return;
  }
  modelPanelLoading = true;
  modelPanelError = "";
  modelPanelNotice = "";
  renderTree();
  const useKnowledgeSearch = els.kbUseForModels?.checked === true;
  const includeWeb = els.kbUseWebSearch?.checked === true;
  try {
    const histories = {};
    const sharedHistories = {};
    const sharedContext = buildSharedModelContext(node.id);
    for (const modelId of modelIds) {
      histories[modelId] = buildModelConversationForApi(node.id, modelId);
      sharedHistories[modelId] = sharedContext.filter((item) => item.modelId !== modelId).slice(-24);
    }
    const response = await fetch("/api/model-agents/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id,
        treeId: viewTreeId,
        modelIds,
        question: modelRunQuestion,
        useKnowledgeSearch,
        includeWeb,
        topK: KB_TOP_K,
        webTopK: KB_WEB_TOP_K,
        knowledgeContext: currentKnowledgeContextForModels(),
        histories,
        sharedHistories,
        ...knowledgeRetrievalScope()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "模型运行失败");
    const runResults = Array.isArray(data.results) ? data.results : [];
    const models = {};
    for (const result of runResults) {
      models[result.id] = {
        answer: result.ok ? result.answer : "",
        ok: result.ok === true,
        error: result.ok ? "" : (result.error || "未知错误"),
        elapsedMs: result.elapsedMs || 0,
        toolEvents: Array.isArray(result.toolEvents) ? result.toolEvents : []
      };
    }
    appendModelNodeTurn(node.id, {
      question: modelRunQuestion,
      includeWeb,
      useKnowledgeSearch,
      autoRetrieval: data.autoRetrieval || null,
      models
    });
    const okCount = runResults.filter((item) => item.ok).length;
    const toolCount = runResults.reduce((sum, item) => sum + (Array.isArray(item.toolEvents) ? item.toolEvents.length : 0), 0);
    const autoCount = data.autoRetrieval?.resultCount || 0;
    const knowledgeNote = useKnowledgeSearch
      ? `，自动检索 ${autoCount} 条${toolCount ? `，模型追加检索 ${toolCount} 次` : ""}`
      : "（未勾选侧栏「送入模型协作」，未自动检索）";
    if (data.apiUnreachable) {
      modelPanelError = "所选模型的 API 均不可达。请检查 .env 里 MODEL_AGENT_*_BASE_URL 对应的服务是否在线。";
    }
    const failureNote = okCount < runResults.length
      ? `失败原因：${runResults.filter((item) => !item.ok).map((item) => `${item.name || item.id}: ${item.error || "未知错误"}`).join("；")}`
      : "";
    const snapshotNote = data.treeChangedDuringRun
      ? `（运行期间 ${data.treePath || "当前任务树"} 有外部改动，不影响本轮回答；用的是开始快照 ${data.treeSnapshotHash || ""}）`
      : "";
    const parts = [`完成：${okCount}/${runResults.length} 个模型返回${knowledgeNote}`];
    if (failureNote) parts.push(failureNote);
    if (snapshotNote) parts.push(snapshotNote);
    modelPanelNotice = parts.join("。");
  } catch (error) {
    modelPanelError = error.message;
  } finally {
    modelPanelLoading = false;
    renderTree();
  }
}

function startFloatingPanelDrag(event, panel, kind, nodeId, baseX, baseY) {
  if (event.button !== 0 || event.target.closest("button, input, textarea, select, a")) return;
  event.preventDefault();
  event.stopPropagation();
  panel.setPointerCapture(event.pointerId);
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    left: Number.parseFloat(panel.style.left) || 0,
    top: Number.parseFloat(panel.style.top) || 0
  };

  function move(moveEvent) {
    const left = Math.max(0, start.left + (moveEvent.clientX - start.pointerX) / graphView.scale);
    const top = Math.max(0, start.top + (moveEvent.clientY - start.pointerY) / graphView.scale);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    floatingPanelOffsets[kind][nodeId] = { x: left - baseX, y: top - baseY };
  }

  function up() {
    panel.removeEventListener("pointermove", move);
    panel.removeEventListener("pointerup", up);
    panel.removeEventListener("pointercancel", up);
  }

  panel.addEventListener("pointermove", move);
  panel.addEventListener("pointerup", up);
  panel.addEventListener("pointercancel", up);
}

function startFloatingPanelResize(event, panel, nodeId) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  panel.setPointerCapture(event.pointerId);
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    width: Number.parseFloat(panel.style.width) || 360,
    height: Number.parseFloat(panel.style.height) || 420
  };

  function move(moveEvent) {
    const width = Math.max(280, start.width + (moveEvent.clientX - start.pointerX) / graphView.scale);
    const height = Math.max(220, start.height + (moveEvent.clientY - start.pointerY) / graphView.scale);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  function up() {
    panel.removeEventListener("pointermove", move);
    panel.removeEventListener("pointerup", up);
    panel.removeEventListener("pointercancel", up);
    floatingPanelSizes.io[nodeId] = {
      width: Number.parseFloat(panel.style.width) || start.width,
      height: Number.parseFloat(panel.style.height) || start.height
    };
  }

  panel.addEventListener("pointermove", move);
  panel.addEventListener("pointerup", up);
  panel.addEventListener("pointercancel", up);
}

function renderVersions() {
  if (!els.versionList) return;
  syncPaneSummaryBar();
  if (!versions.length) {
    els.versionList.innerHTML = `<div class="versionEmpty">还没有历史版本。编辑时会自动维护顶部的「当前版本」快照。</div>`;
    return;
  }
  els.versionList.innerHTML = versions.map((item) => {
    const isCurrent = item.isCurrent === true;
    const reason = isCurrent ? "当前版本" : formatVersionReason(item.reason);
    const time = isCurrent
      ? (item.mtimeMs ? formatVersionTimeFromMs(item.mtimeMs) : "编辑中")
      : formatVersionTime(item.createdAt);
    const title = isCurrent
      ? "恢复到当前工作版本（误点历史版本时可点这里）"
      : "点击回退到这个版本（会先保存当前版本快照）";
    return `
    <button type="button" class="versionNode${isCurrent ? " isCurrent" : ""}" data-version="${attr(item.name)}" title="${title}">
      <span class="versionReason">${escapeHtml(reason)}</span>
      <span class="versionTime">${escapeHtml(time)}</span>
    </button>
  `;
  }).join("");
  for (const button of els.versionList.querySelectorAll("[data-version]")) {
    button.addEventListener("click", () => restoreVersion(button.dataset.version));
  }
}

function formatVersionReason(reason) {
  const value = String(reason || "未命名版本");
  try {
    return decodeURIComponent(value).replace(/_/g, " ");
  } catch {
    return value.replace(/_/g, " ");
  }
}

function formatVersionTime(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function formatVersionTimeFromMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function writeCurrentVersionSnapshot(markdown) {
  const response = await fetch(treeApiUrl("/api/current-version"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown, treeId: viewTreeId })
  });
  if (!response.ok) throw new Error("Current version snapshot failed");
  const data = await response.json().catch(() => ({}));
  if (Array.isArray(data.versions)) {
    versions = data.versions;
    renderVersions();
    if (els.versionState) els.versionState.textContent = `${versions.length} 个版本`;
  }
}

function scheduleCurrentVersionSnapshot() {
  if (workspaceMode === "subtree") return;
  clearTimeout(currentVersionTimer);
  currentVersionTimer = setTimeout(() => {
    writeCurrentVersionSnapshot(toMarkdown(nodes, edges)).catch(() => {});
  }, 1200);
}

function ensureNodePositions() {
  let index = 0;
  let changed = false;
  for (const node of nodes) {
    if (hasPosition(node)) continue;
    const col = index % 4;
    const row = Math.floor(index / 4);
    node.x = 40 + col * (card.width + 36);
    node.y = 40 + row * (card.height + 40);
    ensureNodeSize(node);
    index += 1;
    changed = true;
  }
  if (changed) repelOverlappingNodes();
  return changed;
}

function repelOverlappingNodes() {
  let anyChanged = false;
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = (b.x || 0) - (a.x || 0);
        const dy = (b.y || 0) - (a.y || 0);
        const gapX = nodeLayoutEdgeGap(a, b);
        const gapY = Math.max(24, Math.min(36, Math.round((nodeHeight(a) + nodeHeight(b)) * 0.04)));
        const minX = (nodeWidth(a) + nodeWidth(b)) / 2 + gapX;
        const minY = (nodeHeight(a) + nodeHeight(b)) / 2 + gapY;
        if (Math.abs(dx) >= minX || Math.abs(dy) >= minY) continue;
        const pushX = dx >= 0 ? minX - dx : -minX - dx;
        const pushY = dy >= 0 ? minY - dy : -minY - dy;
        if (Math.abs(pushX) < Math.abs(pushY)) b.x = Math.max(0, (b.x || 0) + pushX);
        else b.y = Math.max(0, (b.y || 0) + pushY);
        changed = true;
        anyChanged = true;
      }
    }
    if (!changed) break;
  }
  return anyChanged;
}

function isNodeFolded(node) {
  return node?.folded === true || String(node?.folded || "").toLowerCase() === "true";
}

function getTreeRootId() {
  return nodes.some((node) => node.id === "ROOT") ? "ROOT" : nodes[0]?.id || "";
}

function buildTreeParentMap(rootId) {
  const parentOf = new Map([[rootId, null]]);
  const adjacency = buildSpanningTreeAdjacency(rootId);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const child of adjacency.get(id) || []) {
      if (parentOf.has(child)) continue;
      parentOf.set(child, id);
      queue.push(child);
    }
  }
  return parentOf;
}

function collectSubtreeNodeIds(foldId) {
  const rootId = getTreeRootId();
  if (!rootId || !foldId) return new Set();
  const parentOf = buildTreeParentMap(rootId);
  const ids = new Set();
  for (const node of nodes) {
    let current = node.id;
    while (current) {
      if (current === foldId) {
        ids.add(node.id);
        break;
      }
      current = parentOf.get(current);
    }
  }
  return ids;
}

function toSubtreeMarkdown(subtreeNodes, subtreeEdges, foldRootId) {
  const body = toMarkdown(subtreeNodes, subtreeEdges);
  const withoutHeader = body.replace(/^# LLM Task Graph[\s\S]*?(?=^## )/m, "");
  return [
    "# LLM Task Graph Subtree",
    "",
    `> Fold root: ${foldRootId}`,
    "> 此文件由 task-tree.md 折叠生成；Codex/Agent 默认只读 task-tree.md，不要读取本文件。",
    "",
    withoutHeader.trim()
  ].join("\n");
}

async function persistTreeNow(reason, { backup = true } = {}) {
  const markdown = toMarkdown(nodes, edges);
  const response = await fetch(treeApiUrl("/api/tree"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown, reason, backup, source: "ui", treeId: viewTreeId })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "保存 task-tree.md 失败");
  }
  const data = await response.json().catch(() => ({}));
  lastSavedMarkdown = markdown;
  lastLoadedMarkdown = markdown;
  dirty = false;
  setSaveState(data.flowSync?.changed ? `已保存 · 自动同步 ${data.flowSync.changed} 个 flow 状态` : "已保存");
}

async function saveSubtreeFile(relativePath, markdown, reason) {
  const response = await fetch("/api/subtree-file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: relativePath, markdown, reason, backup: true })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "保存子树文件失败");
  }
}

async function deleteSubtreeFile(relativePath, reason) {
  const response = await fetch(`/api/subtree-file?path=${encodeURIComponent(relativePath)}&reason=${encodeURIComponent(reason || "将展开子树")}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "删除子树文件失败");
  }
}

async function foldSubtree(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || isNodeFolded(node)) return;
  const subtreeIds = collectSubtreeNodeIds(nodeId);
  const descendantCount = [...subtreeIds].filter((id) => id !== nodeId).length;
  if (descendantCount <= 0) {
    window.alert("该节点没有可折叠的后代子树（从根节点到其它节点不必经过此节点）。");
    return;
  }
  if (!window.confirm(`折叠「${node.title}」及其 ${descendantCount} 个后代节点？\n子树将移到 subtrees/ 下的独立 md 文件，task-tree.md 只保留索引。`)) {
    return;
  }

  const subtreeNodes = nodes.filter((item) => subtreeIds.has(item.id)).map((item) => ({ ...item, folded: false }));
  const subtreeEdges = edges.filter((edge) => {
    const endpoints = edge.endpoints.filter((id) => nodes.some((n) => n.id === id));
    return endpoints.length === 2 && subtreeIds.has(endpoints[0]) && subtreeIds.has(endpoints[1]);
  });
  const subtreeFile = `subtrees/${nodeId}-subtree.md`;
  const subtreeMarkdown = toSubtreeMarkdown(subtreeNodes, subtreeEdges, nodeId);
  await saveSubtreeFile(subtreeFile, subtreeMarkdown, `将折叠子树${node.title}`);

  nodes = nodes.filter((item) => !subtreeIds.has(item.id) || item.id === nodeId);
  edges = edges.filter((edge) => {
    const endpoints = edge.endpoints.filter((id) => nodes.some((n) => n.id === id) || subtreeIds.has(id));
    if (endpoints.length !== 2) return true;
    return !(subtreeIds.has(endpoints[0]) && subtreeIds.has(endpoints[1]));
  });

  const stub = nodes.find((item) => item.id === nodeId);
  if (stub) {
    stub.folded = true;
    stub.subtreeFile = subtreeFile;
    stub.subtreeCount = subtreeIds.size;
    stub.approach = "";
    stub.input = "";
    stub.output = "";
    stub.metrics = "";
    stub.currentResult = "";
    stub.rootCauseAnalysis = "";
    stub.caseStudy = "";
    stub.nextIdea = "";
    stub.selectedSkills = "";
    stub.problem = `[子树已折叠] 共 ${subtreeIds.size} 个节点（含本节点）→ ${subtreeFile}`;
    stub.notes = `折叠索引：${subtreeFile}。Codex/Agent 只读 task-tree.md，不会读取子树文件。点击 ⊞ 可展开恢复。`;
  }

  for (const id of subtreeIds) {
    if (currentFocusId === id) currentFocusId = nodeId;
    if (nextFocusId === id) nextFocusId = nodeId;
    neighborGuideVisibleIds.delete(id);
    delete neighborHintOffsets[id];
  }

  await persistTreeNow(`将折叠子树${node.title}`);
  renderTree();
}

async function unfoldSubtree(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || !isNodeFolded(node) || !node.subtreeFile) return;
  if (!window.confirm(`展开「${node.title}」的折叠子树并写回 task-tree.md？`)) return;

  const response = await fetch(`/api/subtree-file?path=${encodeURIComponent(node.subtreeFile)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取子树文件失败");

  const parsed = parseMarkdown(data.markdown);
  const parsedIds = new Set(parsed.nodes.map((item) => item.id));

  nodes = nodes.filter((item) => item.id !== nodeId);
  nodes.push(...parsed.nodes);

  edges = edges.filter((edge) => {
    const endpoints = edge.endpoints.filter((id) => parsedIds.has(id));
    if (!endpoints.length) return true;
    if (endpoints.length === 1 && endpoints[0] === nodeId) return true;
    return false;
  });
  edges.push(...parsed.edges);
  edges = normalizeEdges(edges, nodes);

  await deleteSubtreeFile(node.subtreeFile, `将展开子树${node.title}`);
  await persistTreeNow(`将展开子树${node.title}`);
  renderTree();
}

function buildSubtreeWorkerPrompt(node) {
  const subtreePath = node.subtreeFile || `subtrees/${node.id}-subtree.md`;
  const port = getTaskTreePort();
  const editUrl = `${window.location.origin}${window.location.pathname}?subtree=${encodeURIComponent(subtreePath)}`;
  const loopCmd = buildChainLoopPromptText({ subtreePath });
  return [
    `你是 worker-${node.id}，负责 ${node.id} → ${subtreePath}。`,
    "",
    "读：task-tree.md（stub 索引）+ 本子树文件；禁止读其它 subtrees/*.md。",
    "写：只改本子树 md + 相关代码；禁止写 task-tree.md 详文；合并只用 UI ⊞ 展开。",
    "",
    `UI 编辑子树：任务图 stub 点「编辑子树」，或浏览器打开：${editUrl}`,
    "",
    "执行：只按 Next 节点的 NextIdea（下一步思路），不要读 GraphState.NextPlan。",
    "",
    "子树 loop 命令（粘贴 Codex/Cursor）：",
    loopCmd
  ].join("\n");
}

function renderWorkspaceBanner() {
  if (!els.workspaceBanner) return;
  const inSubtree = workspaceMode === "subtree" && activeSubtreePath;
  els.workspaceBanner.classList.toggle("hidden", !inSubtree);
  if (inSubtree && els.workspaceBannerTitle) {
    els.workspaceBannerTitle.textContent = `子树编辑：${activeSubtreeFoldRoot || activeSubtreePath} · ${activeSubtreePath}（版本/知识库/执行链均针对本子树；保存不写 task-tree 详文）`;
  }
  if (els.subtitle) {
    els.subtitle.textContent = inSubtree
      ? `Subtree workspace · ${activeSubtreePath}`
      : "Markdown-backed shared task memory";
  }
  if (els.versionState && inSubtree) {
    els.versionState.textContent = `${versions.length} 个子树版本`;
  }
}

async function enterSubtreeWorkspace(node) {
  if (!node?.subtreeFile || !isNodeFolded(node)) return;
  if (dirty && !window.confirm("主树有未保存修改，进入子树前是否继续？（建议先保存主树）")) return;
  if (workspaceMode === "main") {
    mainWorkspaceSnapshot = {
      markdown: toMarkdown(nodes, edges),
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
      currentFocusId,
      nextFocusId,
      nextPlan,
      chainText,
      chainAutoAdvance,
      chainForceNext,
      chainRunStatus,
      lastLoadedMarkdown,
      lastSavedMarkdown
    };
  }
  const response = await fetch(`/api/subtree-file?path=${encodeURIComponent(node.subtreeFile)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取子树失败");
  workspaceMode = "subtree";
  activeSubtreePath = node.subtreeFile;
  activeSubtreeFoldRoot = node.id;
  modelPanelNodeId = null;
  skillPanelNodeId = null;
  loadFromMarkdown(data.markdown, { skipUserGraphStateLock: true, skipRestoreSave: true, markSaved: true });
  const url = new URL(window.location.href);
  url.searchParams.set("subtree", activeSubtreePath);
  window.history.replaceState({}, "", url);
  renderWorkspaceBanner();
  await loadVersions();
  renderTree();
  setSaveState(`已进入子树：${activeSubtreePath}`);
}

async function exitSubtreeWorkspace() {
  if (workspaceMode !== "subtree") return;
  if (dirty && !window.confirm("子树有未保存修改，返回主树前是否继续？")) return;
  const snapshot = mainWorkspaceSnapshot;
  workspaceMode = "main";
  activeSubtreePath = "";
  activeSubtreeFoldRoot = "";
  const url = new URL(window.location.href);
  url.searchParams.delete("subtree");
  window.history.replaceState({}, "", url);
  if (snapshot) {
    nodes = snapshot.nodes;
    edges = snapshot.edges;
    currentFocusId = snapshot.currentFocusId;
    nextFocusId = snapshot.nextFocusId;
    nextPlan = snapshot.nextPlan;
    chainText = snapshot.chainText;
    chainAutoAdvance = snapshot.chainAutoAdvance;
    chainForceNext = snapshot.chainForceNext;
    chainRunStatus = snapshot.chainRunStatus;
    lastLoadedMarkdown = snapshot.lastLoadedMarkdown;
    lastSavedMarkdown = snapshot.lastSavedMarkdown;
    dirty = false;
  } else {
    await loadTree();
    return;
  }
  mainWorkspaceSnapshot = null;
  renderWorkspaceBanner();
  await loadVersions();
  renderTree();
  setSaveState("已返回主树");
}

async function persistSubtreeNow(reason, { backup = true } = {}) {
  const markdown = toMarkdown(nodes, edges);
  const response = await fetch("/api/subtree-file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: activeSubtreePath, markdown, reason, backup })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "保存子树失败");
  }
  lastSavedMarkdown = markdown;
  lastLoadedMarkdown = markdown;
  dirty = false;
  setSaveState("子树已保存");
}

async function persistWorkspaceNow(reason, options) {
  if (workspaceMode === "subtree") return persistSubtreeNow(reason, options);
  return persistTreeNow(reason, options);
}

function chainAddButton(node) {
  if (!isViewingActiveMethodTree()) return "";
  const inChain = parseChainIds(chainText).includes(node.id);
  return `<button type="button" data-action="add-to-chain" class="chainAddBtn${inChain ? " active" : ""}" title="加入底部执行链">⊕</button>`;
}

function coreNodeSummary(node, { compact = true } = {}) {
  const fields = [
    { label: "问题", value: node.problem, maxChars: compact ? 150 : null },
    { label: "思路", value: node.approach, maxChars: compact ? 180 : null },
    { label: "结果", value: node.currentResult, maxChars: compact ? 180 : null }
  ];
  return `
    <section class="coreNodeSummary" aria-label="节点核心摘要">
      ${fields.map(({ label, value, maxChars }) => coreSummaryRow(label, value, maxChars)).join("")}
    </section>
  `;
}

function coreSummaryRow(label, value, maxChars = null) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const text = maxChars ? clipCardText(raw, maxChars) : raw;
  const missing = !text;
  const fullTitle = raw && (text !== raw || raw.length > 75) ? ` title="${attr(raw)}"` : "";
  return `
    <span class="coreSummaryRow">
      <span class="coreSummaryLabel">${label}</span>
      <span class="coreSummaryText${missing ? " muted" : ""}"${fullTitle}>${escapeHtml(text || "未填写")}</span>
    </span>
  `;
}

function renderNodeCard(node) {
  const isEditing = node.id === editNodeId;
  const folded = isNodeFolded(node);
  const foldBtn = !isViewingActiveMethodTree() ? "" : folded
    ? `<button type="button" data-action="toggle-fold" class="foldBtn active" title="展开子树">⊞</button>`
    : `<button type="button" data-action="toggle-fold" class="foldBtn" title="折叠子树到独立 md">⊟</button>`;
  if (!isEditing && folded) {
    const workerPrompt = buildSubtreeWorkerPrompt(node);
    return `
      <span class="nodeCardHeader">
        <span class="headerFields">
          <span class="nodeTitle">${escapeHtml(node.title)}</span>
          ${completionBadge(node)}
          <span class="foldBadge">折叠 · ${Number(node.subtreeCount) || 0} 节点</span>
          <span class="connector" data-connector="${attr(node.id)}" title="从这里拖到另一个节点连接点"></span>
        </span>
        <span class="nodeActions">
          ${foldBtn}
          <button type="button" data-action="edit-subtree" class="subtreeEditBtn" title="在子树工作区编辑（不展开）">✎</button>
          ${readDoneButton(node)}
          <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
          <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
          <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
          ${chainAddButton(node)}
          <button type="button" data-action="add-node" title="新增节点">＋</button>
          <button type="button" data-action="delete" title="删除节点">×</button>
        </span>
      </span>
      ${coreNodeSummary(node, { compact: nodeCardCompact })}
      ${nodeCardCompact ? "" : readRow("说明", node.notes)}
      ${nodeCardCompact ? "" : codeLocBlock(node)}
      ${nodeCardCompact ? "" : modelSummaryBlock(node, { includeCurrentResult: false })}
      <details class="subtreeWorkerPromptBox">
        <summary>Subagent Prompt（复制给 Worker）</summary>
        <pre class="subtreeWorkerPrompt">${escapeHtml(workerPrompt)}</pre>
        <button type="button" data-action="copy-subtree-prompt">复制 Prompt</button>
      </details>
      <span class="resizeHandle" title="拖动调整节点大小"></span>
    `;
  }
  if (!isEditing) {
    if (nodeCardCompact) {
      const showFocusBoxes = node.id === nextFocusId || node.id === currentFocusId;
      return `
        <span class="nodeCardHeader">
          <span class="headerFields">
            <span class="nodeTitle">${escapeHtml(node.title)}</span>
            ${completionBadge(node)}
            <span class="connector" data-connector="${attr(node.id)}" title="从这里拖到另一个节点连接点"></span>
          </span>
          <span class="nodeActions">
            ${foldBtn}
            <button type="button" data-action="toggle-neighbor-guides" class="neighborGuideBtn${neighborGuideVisibleIds.has(node.id) ? " active" : ""}" title="显示/隐藏邻居跳转方向">↗</button>
            ${readDoneButton(node)}
            <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
            <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
            <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
            ${chainAddButton(node)}
            <button type="button" data-action="add-node" title="新增节点">＋</button>
            <button type="button" data-action="delete" title="删除节点">×</button>
          </span>
        </span>
        ${modelCollabBar(node)}
        ${coreNodeSummary(node)}
        ${compactNodeDetails(node)}
        ${showFocusBoxes ? nextIdeaBox(node) : ""}
        ${node.id === nextFocusId ? nextPlanBox(node) : ""}
        <span class="resizeHandle" title="拖动调整节点大小"></span>
      `;
    }
    return `
      <span class="nodeCardHeader">
        <span class="headerFields">
          <span class="nodeTitle">${escapeHtml(node.title)}</span>
          ${completionBadge(node)}
          <span class="connector" data-connector="${attr(node.id)}" title="从这里拖到另一个节点连接点"></span>
        </span>
        <span class="nodeActions">
          ${foldBtn}
          <button type="button" data-action="toggle-neighbor-guides" class="neighborGuideBtn${neighborGuideVisibleIds.has(node.id) ? " active" : ""}" title="显示/隐藏邻居跳转方向">↗</button>
          ${readDoneButton(node)}
          <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
          <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
          <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
          ${chainAddButton(node)}
          <button type="button" data-action="add-node" title="新增节点">＋</button>
          <button type="button" data-action="delete" title="删除节点">×</button>
        </span>
      </span>
      ${modelCollabBar(node)}
      ${coreNodeSummary(node, { compact: false })}
      ${readRow("评价", node.metrics)}
      ${readRow("批注", node.notes)}
      ${codeLocBlock(node)}
      ${modelSummaryBlock(node, { includeCurrentResult: false })}
      ${nextIdeaBox(node)}
      ${node.id === nextFocusId ? nextPlanBox(node) : ""}
      ${selectedSkillsBlock(node)}
      <span class="resizeHandle" title="拖动调整节点大小"></span>
    `;
  }

  return `
    <span class="nodeCardHeader">
      <span class="headerFields">
        <input class="inlineInput titleInput" data-field="title" value="${attr(node.title)}" aria-label="标题">
        <span class="connector" data-connector="${attr(node.id)}" title="从这里拖到另一个节点连接点"></span>
      </span>
      <span class="nodeActions">
        ${foldBtn}
        <button type="button" data-action="toggle-neighbor-guides" class="neighborGuideBtn${neighborGuideVisibleIds.has(node.id) ? " active" : ""}" title="显示/隐藏邻居跳转方向">↗</button>
        ${readDoneButton(node)}
        <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
        <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
        <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
        ${chainAddButton(node)}
        <button type="button" data-action="add-node" title="新增节点">＋</button>
        <button type="button" data-action="delete" title="删除节点">×</button>
      </span>
    </span>
    ${modelCollabBar(node)}
    ${editRow("问题", "problem", node.problem)}
    ${editRow("思路", "approach", node.approach)}
    ${editRow("评价", "metrics", node.metrics)}
    ${editRow("批注", "notes", node.notes)}
    ${editRow("代码", "codeLoc", node.codeLoc)}
    ${modelSummaryBlock(node)}
    ${nextIdeaBox(node)}
    ${node.id === nextFocusId ? nextPlanBox(node) : ""}
    ${selectedSkillsBlock(node)}
    <span class="resizeHandle" title="拖动调整节点大小"></span>
  `;
}

function isNodeComplete(node) {
  return String(node.completion || "").trim() === "已完成";
}

function toggleNodeComplete(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  node.completion = isNodeComplete(node) ? "" : "已完成";
  syncReadFingerprintIfMarked(node);
  markDirty(`${isNodeComplete(node) ? "将标记完成" : "将取消完成"}${nodeTitle(nodeId)}`);
  renderTree();
}

function setCurrentNode(nodeId) {
  if (!nodes.some((node) => node.id === nodeId)) return;
  currentFocusId = nodeId;
  selectedId = nodeId;
  ioPreviewNodeId = nodeId;
  saveUserGraphStateFocus();
  markDirty(`将修改当前推进节点为${nodeTitle(nodeId)}`);
  renderTree();
}

function setNextNode(nodeId) {
  if (!nodes.some((node) => node.id === nodeId)) return;
  nextFocusId = nodeId;
  selectedId = nodeId;
  ioPreviewNodeId = nodeId;
  saveUserGraphStateFocus();
  markDirty(`将修改下一步推进节点为${nodeTitle(nodeId)}`);
  renderTree();
}

function editFullNodeFromLens(nodeId) {
  if (!nodes.some((node) => node.id === nodeId)) return;
  editNodeId = nodeId;
  selectedId = nodeId;
  ioPreviewNodeId = nodeId;
  closeFocusLens({ locate: false });
  renderTree();
  requestAnimationFrame(() => focusNodeInView(nodeId));
}

async function runFocusLensNode(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  if (!String(node.nextIdea || "").trim()) {
    setSaveState("先写清楚让 Agent 继续做什么");
    els.focusLensBody?.querySelector(".focusLensNextIdeaInput")?.focus();
    return;
  }
  if (nextFocusId !== nodeId) setNextNode(nodeId);
  if (dirty) await saveTree();
  await runCodex({ preset: "next" });
}

function handleFocusLensAction(action, nodeId) {
  if (action === "set-current") setCurrentNode(nodeId);
  if (action === "set-next") setNextNode(nodeId);
  if (action === "toggle-complete") toggleNodeComplete(nodeId);
  if (action === "edit-node") editFullNodeFromLens(nodeId);
  if (action === "toggle-chain") {
    if (parseChainIds(chainText).includes(nodeId)) removeNodeFromChain(nodeId);
    else addNodeToChain(nodeId);
  }
  if (action === "run-agent") {
    runFocusLensNode(nodeId).catch((error) => setSaveState(`Codex 没能启动: ${error.message}`));
  }
}

function nextIdeaBox(node) {
  return `
    <span class="nextIdeaBox">
      <span class="nextIdeaLabel">Agent 下一步思路 · 唯一执行依据</span>
      <textarea class="nextIdeaInput" placeholder="写这个节点接下来怎么推进">${escapeHtml(node.nextIdea || "")}</textarea>
    </span>
  `;
}

function modelSummaryBlock(node, { includeCurrentResult = true } = {}) {
  return `
    <section class="modelFields">
      ${includeCurrentResult ? `
        <span class="modelField">
          <span class="modelFieldLabel">当前结果</span>
          ${renderModelFieldMarkdown(node.currentResult, "等待大模型填写")}
        </span>
      ` : ""}
      <span class="modelField">
        <span class="modelFieldLabel">根因分析</span>
        <span class="modelFieldText">${escapeHtml(node.rootCauseAnalysis || "等待大模型填写")}</span>
      </span>
      <details class="caseStudy">
        <summary>case_study</summary>
        <div>${escapeHtml(node.caseStudy || "等待大模型填写经典 case 和错误原因。")}</div>
      </details>
    </section>
  `;
}

function renderModelFieldMarkdown(value, placeholder) {
  const text = String(value || "").trim();
  if (!text) {
    return `<div class="modelFieldMarkdown muted">${escapeHtml(placeholder)}</div>`;
  }
  return `<div class="modelFieldMarkdown">${renderMarkdownLite(text)}</div>`;
}

function nextPlanBox(node) {
  const hasSkills = parseSelectedSkills(node?.selectedSkills).size > 0;
  const btnLabel = hasSkills ? "管理 skill" : "推荐 skill";
  return `
    <span class="nextPlanBox">
      <span class="nextPlanLabel" title="仅供你自己备忘；Agent 禁止把这里当作执行指令">用户备忘 · Agent 不执行</span>
      <textarea class="nextPlanInput" placeholder="可长期不更新；真正执行内容请写在下方「下一步思路」">${escapeHtml(nextPlan || "")}</textarea>
      <span></span>
      <button type="button" class="skillRecommendBtn" title="打开能力面板，推荐或修改 skill">${btnLabel}</button>
    </span>
  `;
}

function selectedSkillsBlock(node) {
  const selected = parseSelectedSkills(node.selectedSkills);
  if (!selected.size) return "";
  const lookup = new Map(skillRecommendations.map((skill) => [skill.id, skill]));
  const labels = [...selected].map((id) => {
    const skill = lookup.get(id);
    return skill?.name || skillIdLabel(id);
  });
  const tooltips = [...selected].map((id) => {
    const skill = lookup.get(id);
    const name = skill?.name || skillIdLabel(id);
    const summary = skill?.functionText || "";
    return summary ? `${name}：${summary}` : name;
  }).join("\n");
  return `
    <span class="selectedSkillsBox">
      <span class="selectedSkillsHeader">
        <span class="selectedSkillsLabel">已选能力 · ${selected.size}</span>
        <button type="button" class="skillOpenBtn" data-action="open-skill-panel" title="打开能力面板，查看或修改已选 skill">管理能力</button>
      </span>
      <span class="selectedSkillsText" title="${attr(tooltips)}">${escapeHtml(labels.join(" · "))}</span>
    </span>
  `;
}

function isPlausibleCodeLocPath(pathPart) {
  const p = String(pathPart || "").trim();
  if (!p || p.length > 280) return false;
  if (/^[A-Za-z]:\\/.test(p)) return true;
  if (/[\\/]/.test(p)) return true;
  if (/^\.{0,2}[\\/]/.test(p)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/i.test(p)) return true;
  return false;
}

function parseCodeLocRefs(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const stripped = line.replace(/^[-*]\s+/, "").trim();
      const hashMatch = stripped.match(/^(.+?)\s+#\s+(.+)$/);
      const comment = hashMatch ? hashMatch[2].trim() : "";
      const main = hashMatch ? hashMatch[1].trim() : stripped;
      const lineMatch = main.match(/:(\d+)(?:-(\d+))?$/);
      if (lineMatch) {
        const pathPart = main.slice(0, -lineMatch[0].length).trim();
        if (isPlausibleCodeLocPath(pathPart)) {
          return {
            path: pathPart,
            line: Number.parseInt(lineMatch[1], 10) || 1,
            lineEnd: lineMatch[2] ? Number.parseInt(lineMatch[2], 10) : null,
            comment,
            raw: stripped,
            clickable: true
          };
        }
      }
      if (isPlausibleCodeLocPath(main)) {
        return { path: main, line: 1, lineEnd: null, comment, raw: stripped, clickable: true };
      }
      return { path: "", line: 1, lineEnd: null, comment, raw: stripped, clickable: false };
    });
}

function codeLocBlock(node) {
  const text = String(node.codeLoc || "").trim();
  if (!text) return "";
  const refs = parseCodeLocRefs(text);
  const countLabel = refs.length ? `${refs.length} 处` : "…";
  const body = refs.length
    ? refs.map((ref) => renderCodeLocLine(ref)).join("")
    : `<div class="codeLocPlain">${escapeHtml(text)}</div>`;
  return `
    <details class="codeLocBox">
      <summary>代码位置 · ${countLabel}</summary>
      <div class="codeLocLines">${body}</div>
    </details>
  `;
}

function renderCodeLocLine(ref) {
  if (!ref.clickable) {
    return `<div class="codeLocPlain">${escapeHtml(ref.raw)}${ref.comment ? ` <span class="codeLocComment"># ${escapeHtml(ref.comment)}</span>` : ""}</div>`;
  }
  const label = ref.lineEnd && ref.lineEnd !== ref.line
    ? `${ref.path}:${ref.line}-${ref.lineEnd}`
    : `${ref.path}:${ref.line}`;
  return `
    <button type="button" class="codeLocLink" data-code-path="${attr(ref.path)}" data-code-line="${ref.line}" title="在 VS Code / Cursor 中打开">
      <span class="codeLocPath">${escapeHtml(label)}</span>
      ${ref.comment ? `<span class="codeLocComment"># ${escapeHtml(ref.comment)}</span>` : ""}
    </button>
  `;
}

function formatApiFetchError(error, response, action = "请求") {
  const portHint = window.location.port ? `（当前页面端口 ${window.location.port}）` : "";
  if (error?.message === "Failed to fetch" || /failed to fetch/i.test(String(error?.message || ""))) {
    return `${action}失败：任务图后台未响应${portHint}。请关闭此窗口后重新双击「打开任务图.cmd」。`;
  }
  if (response?.status === 404 && action.includes("编辑器")) {
    return "打开编辑器失败：当前后台版本过旧，请重新打开任务图（关闭窗口后再双击 打开任务图.cmd）。";
  }
  return error?.message || `${action}失败`;
}

async function probeServerFeatures() {
  try {
    const response = await fetch("/api/server-info", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function probeBackendConnection() {
  try {
    const response = await fetch("/api/project", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      setSaveState(formatApiFetchError(null, response, "后台连接"));
      return false;
    }
    const project = await response.json();
    if (els.projectSwitchName && project.name) {
      els.projectSwitchName.textContent = project.name;
      els.projectSwitchBtn?.setAttribute("title", `${project.root} · 点这里切到本机其它任务图项目`);
    }
    return true;
  } catch (error) {
    setSaveState(formatApiFetchError(error, null, "后台连接"));
    if (els.knowledgeState) {
      knowledgeError = formatApiFetchError(error, null, "知识库");
      renderKnowledgePanel();
    }
    return false;
  }
}

function wireCodeLocLinks(container) {
  container.querySelectorAll(".codeLocLink[data-code-path]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openInEditor(button.dataset.codePath, Number.parseInt(button.dataset.codeLine, 10) || 1);
    });
  });
}

async function openInEditor(filePath, line = 1) {
  if (!filePath) return;
  setSaveState(`正在打开 ${filePath}:${line}...`);
  try {
    const response = await fetch("/api/open-in-editor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, line })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState(data.error || formatApiFetchError(null, response, "打开编辑器"));
      return;
    }
    setSaveState(`已在 ${data.editor || "编辑器"} 打开 ${filePath}:${line}`);
  } catch (error) {
    setSaveState(formatApiFetchError(error, null, "打开编辑器"));
  }
}

function readRow(label, value) {
  return `
    <span class="cardRow">
      <span class="cardLabel">${label}</span>
      <span class="readText">${escapeHtml(value || "未填写")}</span>
    </span>
  `;
}

function clipCardText(value, maxChars = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function completionBadge(node) {
  const text = String(node.completion || "").trim() || "未开始";
  return `<span class="completionBadge" data-completion="${attr(text)}">${escapeHtml(text)}</span>`;
}

function resultTeaser(node) {
  const text = clipCardText(node.currentResult, 90);
  if (!text) return `<span class="resultTeaser muted">尚无结果</span>`;
  return `<span class="resultTeaser" title="${attr(String(node.currentResult || "").replace(/\s+/g, " ").trim())}">结果 · ${escapeHtml(text)}</span>`;
}

function syncNodeCardCompactButton() {
  if (!els.nodeCardCompactBtn) return;
  els.nodeCardCompactBtn.setAttribute("aria-pressed", nodeCardCompact ? "true" : "false");
  els.nodeCardCompactBtn.classList.toggle("active", nodeCardCompact);
  els.nodeCardCompactBtn.textContent = nodeCardCompact ? "摘要" : "详文";
  els.nodeCardCompactBtn.title = nodeCardCompact
    ? "当前：摘要模式（点击切回详文）"
    : "当前：详文模式（点击改为摘要）";
}

function toggleNodeCardCompact() {
  nodeCardCompact = !nodeCardCompact;
  try {
    localStorage.setItem(NODE_CARD_COMPACT_STORAGE_KEY, nodeCardCompact ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  syncNodeCardCompactButton();
  renderTree();
}

function compactNodeDetails(node) {
  const open = nodeDetailsOpenIds.has(node.id) ? " open" : "";
  return `
    <details class="nodeCardDetails"${open} data-node-details="${attr(node.id)}">
      <summary>详情 · 评价 / 备注 / 根因 / 证据</summary>
      ${readRow("评价", node.metrics)}
      ${readRow("批注", node.notes)}
      ${codeLocBlock(node)}
      ${modelSummaryBlock(node, { includeCurrentResult: false })}
      ${selectedSkillsBlock(node)}
    </details>
  `;
}

function ioPreviewBody(value, kind = "input", nodeId = "") {
  const text = String(value || "").trim();
  if (!text) {
    const emptyHint = kind === "output"
      ? "粘贴短结果片段，可补充输出文件路径"
      : "粘贴短输入样例，可补充源文件路径";
    return `<div class="ioPreviewEmpty muted">${emptyHint}</div>`;
  }

  const lines = parseIoLines(text);
  if (!lines.length) return `<div class="ioPreviewEmpty muted">未填写</div>`;
  const filePaths = unique(lines.flatMap((line) => detectIoLineFilePaths(line)));

  return `
    <div class="ioPreviewLines">
      ${lines.map((line) => renderIoLineRow(line)).join("")}
      ${filePaths.length ? `
        <div class="ioFileSnapshots" data-io-files-for="${attr(nodeId)}">
          ${filePaths.map((filePath) => renderIoFileSnapshot(filePath)).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function parseIoLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const stripped = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
      const hashMatch = stripped.match(/^(.+?)\s+#\s+(.+)$/);
      if (hashMatch) {
        return { value: hashMatch[1].trim(), comment: hashMatch[2].trim() };
      }
      const slashMatch = stripped.match(/^(.+?)\s+\/\/\s+(.+)$/);
      if (slashMatch) {
        return { value: slashMatch[1].trim(), comment: slashMatch[2].trim() };
      }
      const cnMatch = stripped.match(/^(.+?)\s+[（(]([^）)]+)[）)]\s*$/);
      if (cnMatch) {
        return { value: cnMatch[1].trim(), comment: cnMatch[2].trim() };
      }
      return { value: stripped, comment: "" };
    });
}

function renderIoLineRow(line) {
  const filePath = detectFilePaths(line.value)[0];
  const valueHtml = filePath
    ? `<button type="button" class="ioPreviewLink ioPreviewValue" data-file-path="${attr(filePath)}" title="预览文件">${escapeHtml(line.value)}</button>`
    : `<span class="ioPreviewValue">${escapeHtml(line.value)}</span>`;
  const commentHtml = line.comment
    ? `<span class="ioPreviewComment">${escapeHtml(line.comment)}</span>`
    : `<span class="ioPreviewComment muted">未写注释</span>`;
  return `<div class="ioPreviewLine">${valueHtml}${commentHtml}</div>`;
}

function detectIoLineFilePaths(line) {
  return unique([
    ...detectFilePaths(line.value),
    ...detectFilePaths(line.comment)
  ]);
}

function renderIoFileSnapshot(filePath) {
  const cached = ioFilePreviewCache.get(filePath);
  if (!cached || cached.loading) {
    return `
      <section class="ioFileSnapshot is-loading" data-file-path="${attr(filePath)}">
        <header><button type="button" class="ioFilePathBtn" data-file-path="${attr(filePath)}">${escapeHtml(filePath)}</button><span>读取中</span></header>
        <pre>正在读取文件开头...</pre>
      </section>
    `;
  }
  if (cached.error) {
    return `
      <section class="ioFileSnapshot is-error" data-file-path="${attr(filePath)}">
        <header><button type="button" class="ioFilePathBtn" data-file-path="${attr(filePath)}">${escapeHtml(filePath)}</button><span>路径无效</span></header>
        <pre>${escapeHtml(cached.error)}</pre>
      </section>
    `;
  }
  const sizeText = Number.isFinite(cached.size) ? `${cached.size} bytes` : "";
  const tail = cached.truncated ? " · 已截断" : "";
  return `
    <section class="ioFileSnapshot" data-file-path="${attr(filePath)}">
      <header><button type="button" class="ioFilePathBtn" data-file-path="${attr(filePath)}">${escapeHtml(cached.path || filePath)}</button><span>${escapeHtml(sizeText + tail)}</span></header>
      <pre>${escapeHtml(cached.content || "(空文件)")}</pre>
    </section>
  `;
}

function wireIoPreviewLinks(container) {
  container.querySelectorAll("button[data-file-path]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceFile(button.dataset.filePath);
    });
  });
  loadIoFileSnapshots(container);
}

function loadIoFileSnapshots(container) {
  const filePaths = unique([...container.querySelectorAll(".ioFileSnapshot[data-file-path]")]
    .map((item) => item.getAttribute("data-file-path"))
    .filter(Boolean));
  for (const filePath of filePaths) loadIoFilePreview(filePath);
}

async function loadIoFilePreview(filePath) {
  if (!filePath || ioFilePreviewRequests.has(filePath)) return;
  const cached = ioFilePreviewCache.get(filePath);
  if (cached && !cached.loading) return;
  ioFilePreviewRequests.add(filePath);
  ioFilePreviewCache.set(filePath, { loading: true });
  try {
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}&preview=1&maxChars=${IO_FILE_PREVIEW_CHARS}`);
    const data = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) {
      ioFilePreviewCache.set(filePath, { error: data.error || String(data || "无法读取文件") });
    } else {
      ioFilePreviewCache.set(filePath, data);
    }
  } catch (error) {
    ioFilePreviewCache.set(filePath, { error: error.message || "无法读取文件" });
  } finally {
    ioFilePreviewRequests.delete(filePath);
    if (ioPreviewNodeId) renderTree();
  }
}

async function openWorkspaceFile(filePath) {
  if (!filePath) return;
  setSaveState(`正在打开 ${filePath}...`);
  try {
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const body = await response.text();
    if (!response.ok) {
      setSaveState(`无法打开 ${filePath}`);
      if (els.filePreviewDialog) {
        els.filePreviewTitle.textContent = filePath;
        els.filePreviewContent.textContent = body || "File not found";
        els.filePreviewDialog.showModal();
      }
      return;
    }
    if (els.filePreviewDialog) {
      els.filePreviewTitle.textContent = filePath;
      els.filePreviewContent.textContent = body;
      els.filePreviewDialog.showModal();
    }
    setSaveState(`已打开 ${filePath}`);
  } catch (error) {
    setSaveState(`无法打开 ${filePath}: ${error.message}`);
  }
}

function detectFilePaths(value) {
  const text = String(value || "");
  const found = new Set();

  const add = (raw) => {
    const cleaned = cleanFilePathCandidate(raw);
    if (cleaned && isPlausibleFilePath(cleaned)) found.add(cleaned);
  };

  for (const match of text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) add(match[1]);
  for (const match of text.matchAll(/["'`]([^"'`\r\n]+?)["'`]/g)) add(match[1]);
  for (const match of text.match(/[A-Za-z]:\\[^\r\n"'`<>|?*]+?(?:\.[A-Za-z0-9]{1,8})?/g) || []) add(match);

  const chunks = text.split(/[\r\n、,，;；]+/);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    add(trimmed);
    for (const match of trimmed.match(/(?:[A-Za-z]:\\|(?:\.{1,2}[\\/])?)?[\w\u4e00-\u9fa5 ._-]+(?:[\\/][\w\u4e00-\u9fa5 ._-]+)*\.(?:md|txt|json|jsonl|csv|tsv|log|js|ts|tsx|css|html|yaml|yml|ps1|cmd|py|sh)/gi) || []) {
      add(match);
    }
  }

  return [...found];
}

function cleanFilePathCandidate(raw) {
  let cleaned = String(raw || "")
    .trim()
    .replace(/^path\s*[:：]\s*/i, "")
    .replace(/^file\s*[:：]\s*/i, "")
    .replace(/^路径\s*[:：]\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[，。；;、)）\]]+$/g, "")
    .trim();

  const fileMatch = cleaned.match(/((?:[A-Za-z]:\\|(?:\.{1,2}[\\/])?)?[\w\u4e00-\u9fa5 ._-]+(?:[\\/][\w\u4e00-\u9fa5 ._-]+)*\.[A-Za-z0-9]{1,8})/);
  if (fileMatch) cleaned = fileMatch[1];
  return cleaned.trim();
}

function isPlausibleFilePath(cleaned) {
  if (!cleaned || cleaned.length > 260) return false;
  if (/[<>|?*]/.test(cleaned)) return false;
  if (/[、，。；;]/.test(cleaned)) return false;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return false;
  if (/^[A-Za-z]:\\/.test(cleaned)) return true;
  if (/^(?:\.{1,2}[\\/])/.test(cleaned)) return true;
  if (/^[\w\u4e00-\u9fa5 ._-]+\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return true;
  return /[\\/]/.test(cleaned);
}

function detectFilePath(value) {
  return detectFilePaths(value)[0] || "";
}

function buildSharedModelContext(nodeId) {
  const items = [];
  for (const turn of modelNodeTurns[nodeId] || []) {
    items.push({
      modelId: "user",
      modelName: "用户",
      role: "user",
      content: turn.question
    });
    for (const [modelId, entry] of Object.entries(turn.models || {})) {
      const agent = modelAgents.find((item) => item.id === modelId);
      items.push({
        modelId,
        modelName: agent?.name || modelId,
        role: "assistant",
        content: entry.ok ? entry.answer : `运行失败：${entry.error || "未知错误"}`
      });
    }
  }
  return items;
}

function editRow(label, field, value, kind = "textarea") {
  const control = kind === "input"
    ? `<input class="inlineInput" data-field="${field}" value="${attr(value)}" aria-label="${label}">`
    : `<textarea class="inlineTextarea" data-field="${field}" aria-label="${label}">${escapeHtml(value || "")}</textarea>`;
  return `
    <span class="cardRow">
      <span class="cardLabel">${label}</span>
      ${control}
    </span>
  `;
}

function rerenderEdges(extraPath = "") {
  els.edges.innerHTML = `${renderEdges()}${extraPath}`;
  renderEdgeLabels();
}

function rerenderEdgePaths(extraPath = "") {
  els.edges.innerHTML = `${renderEdges()}${extraPath}`;
}

function renderEdges() {
  const highlights = getFocusHighlights();
  return edges.map((edge) => {
    const points = edge.endpoints.map(getNodePort).filter(Boolean);
    if (points.length < 2) return "";
    const hub = edgeHub(points, edge);
    const isLinked = Boolean(selectedId && edge.endpoints.includes(selectedId));
    const isDimmed = Boolean(selectedId && !isLinked && !highlights.currentEdges.has(edge.id) && !highlights.nextEdges.has(edge.id));
    const lines = points.map((point) => {
      const midX = (point.x + hub.x) / 2;
      const classes = ["edgePath"];
      if (highlights.currentEdges.has(edge.id)) classes.push("currentPath");
      if (highlights.nextEdges.has(edge.id)) classes.push("nextPath");
      if (isLinked) classes.push("linked");
      if (isDimmed) classes.push("dimmed");
      return `<path class="${classes.join(" ")}" data-edge="${attr(edge.id)}" d="M ${point.x} ${point.y} C ${midX} ${point.y}, ${midX} ${hub.y}, ${hub.x} ${hub.y}" />`;
    });
    const hubClasses = ["edgeHub"];
    if (expandedEdgeLabelIds.has(edge.id)) hubClasses.push("expanded");
    if (isLinked) hubClasses.push("linked");
    if (isDimmed) hubClasses.push("dimmed");
    return `${lines.join("")}<circle class="${hubClasses.join(" ")}" data-edge-hub="${attr(edge.id)}" cx="${hub.x}" cy="${hub.y}" r="6"><title>点击显示/隐藏关系</title></circle>`;
  }).join("");
}

function renderEdgeLabels() {
  els.edgeLabels.innerHTML = "";
  for (const edge of edges) {
    const points = edge.endpoints.map(getNodePort).filter(Boolean);
    if (points.length < 2) continue;
    const isEditing = edge.id === editEdgeId;
    const isExpanded = expandedEdgeLabelIds.has(edge.id);
    if (!isEditing && !isExpanded) continue;
    migrateLegacyEdgeLabelPosition(edge, points);
    const hub = edgeHub(points, edge);
    const x = hub.x + 10;
    const y = hub.y - 28;
    const label = document.createElement("section");
    label.className = `edgeEditor${isEditing ? " editing" : ""}`;
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
    label.dataset.edgeId = edge.id;
    label.innerHTML = isEditing ? renderEdgeEdit(edge) : renderEdgeRead(edge);
    wireEdgeEditor(label, edge.id);
    els.edgeLabels.appendChild(label);
  }
}

function renderEdgeRead(edge) {
  return `
    <div class="edgeReadLabel">${escapeHtml(edge.label || "未命名关系")}</div>
    <div class="edgeEndpointNames" title="连接的节点">${escapeHtml(edge.endpoints.map(nodeTitle).join(" / "))}</div>
    ${edge.notes ? `<div class="edgeReadNotes">${escapeHtml(edge.notes)}</div>` : ""}
    <button type="button" data-edge-action="delete">×</button>
  `;
}

function renderEdgeEdit(edge) {
  return `
    <input class="edgeInput" data-edge-field="label" value="${attr(edge.label)}" placeholder="关系">
    <div class="edgeEndpointNames" title="连接的节点">${escapeHtml(edge.endpoints.map(nodeTitle).join(" / "))}</div>
    <textarea class="edgeNotes" data-edge-field="notes" placeholder="边批注">${escapeHtml(edge.notes || "")}</textarea>
    <button type="button" data-edge-action="delete">×</button>
  `;
}

function wireEdgeEditor(label, edgeId) {
  label.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    startEdgeLabelDrag(event, edgeId, label);
  });
  label.addEventListener("dblclick", (event) => {
    if (event.target.closest("button")) return;
    editEdgeId = edgeId;
    expandedEdgeLabelIds.add(edgeId);
    rerenderEdges();
  });
  for (const control of label.querySelectorAll("[data-edge-field]")) {
    if (control.dataset.edgeField !== "endpoints") {
      control.addEventListener("input", () => updateEdgeField(edgeId, control.dataset.edgeField, control.value, false));
    }
    control.addEventListener("change", () => updateEdgeField(edgeId, control.dataset.edgeField, control.value, true));
  }
  label.querySelector("[data-edge-action='delete']").addEventListener("click", () => {
    const edge = edges.find((item) => item.id === edgeId);
    edges = edges.filter((edge) => edge.id !== edgeId);
    expandedEdgeLabelIds.delete(edgeId);
    if (editEdgeId === edgeId) editEdgeId = null;
    markDirty(`将删除关系${edge?.label || edgeId}`);
    rerenderEdges();
  });
}

function toggleEdgeLabel(edgeId) {
  if (!edgeId || !edges.some((edge) => edge.id === edgeId)) return;
  if (expandedEdgeLabelIds.has(edgeId)) {
    expandedEdgeLabelIds.delete(edgeId);
    if (editEdgeId === edgeId) editEdgeId = null;
  } else {
    expandedEdgeLabelIds.add(edgeId);
  }
  rerenderEdges();
}

function startEdgeLabelDrag(event, edgeId, label) {
  if (isInteractive(event.target) || event.button !== 0) return;
  const edge = edges.find((item) => item.id === edgeId);
  if (!edge) return;
  event.preventDefault();
  label.setPointerCapture(event.pointerId);
  const points = edge.endpoints.map(getNodePort).filter(Boolean);
  const base = edgeBaseHub(points);
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    offsetX: Number.isFinite(edge.offsetX) ? edge.offsetX : 0,
    offsetY: Number.isFinite(edge.offsetY) ? edge.offsetY : 0,
    baseX: base.x,
    baseY: base.y
  };

  function move(moveEvent) {
    edge.offsetX = start.offsetX + (moveEvent.clientX - start.pointerX) / graphView.scale;
    edge.offsetY = start.offsetY + (moveEvent.clientY - start.pointerY) / graphView.scale;
    const hub = { x: start.baseX + edge.offsetX, y: start.baseY + edge.offsetY };
    label.style.left = `${hub.x + 10}px`;
    label.style.top = `${hub.y - 28}px`;
    rerenderEdgePaths();
  }

  function up() {
    label.removeEventListener("pointermove", move);
    label.removeEventListener("pointerup", up);
    label.removeEventListener("pointercancel", up);
    markDirty("将修改边标签和边的走线位置");
  }

  label.addEventListener("pointermove", move);
  label.addEventListener("pointerup", up);
  label.addEventListener("pointercancel", up);
}

function wireNodeCard(nodeCard, nodeId) {
  nodeCard.addEventListener("pointerdown", (event) => {
    if (isInteractive(event.target)) return;
    const prevSelectedId = selectedId;
    selectedId = nodeId;
    const selectionChanged = prevSelectedId !== nodeId;
    if (selectionChanged) ioPreviewNodeId = nodeId;
    for (const item of els.nodesLayer.querySelectorAll(".graphNode")) {
      item.classList.toggle("selected", item === nodeCard);
    }
    if (selectionChanged) renderTree();
    startNodeDrag(event, nodeId, nodeCard, () => {
      if (!selectionChanged && ioPreviewNodeId !== nodeId) {
        ioPreviewNodeId = nodeId;
        renderTree();
      }
    });
  });

  nodeCard.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, .connector")) return;
    editNodeId = nodeId;
    selectedId = nodeId;
    ioPreviewNodeId = nodeId;
    renderTree();
  });

  nodeCard.querySelector("[data-action='add-node']").addEventListener("click", (event) => {
    event.stopPropagation();
    addNodeNear(nodeId);
  });

  nodeCard.querySelector("[data-action='model-panel']")?.addEventListener("click", (event) => {
    event.stopPropagation();
    modelPanelNodeId = nodeId;
    modelRunQuestion = "";
    modelPanelError = "";
    modelPanelNotice = "";
    loadModelAgents().finally(() => renderTree());
  });

  nodeCard.querySelector("[data-action='toggle-fold']")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (workspaceMode === "subtree") {
      setSaveState("子树工作区内请先「返回主树」再展开/折叠");
      return;
    }
    try {
      const target = nodes.find((item) => item.id === nodeId);
      if (isNodeFolded(target)) await unfoldSubtree(nodeId);
      else await foldSubtree(nodeId);
    } catch (error) {
      setSaveState(error.message);
    }
  });

  nodeCard.querySelector("[data-action='edit-subtree']")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const target = nodes.find((item) => item.id === nodeId);
    try {
      await enterSubtreeWorkspace(target);
    } catch (error) {
      setSaveState(error.message);
    }
  });

  nodeCard.querySelector("[data-action='copy-subtree-prompt']")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const target = nodes.find((item) => item.id === nodeId);
    const text = buildSubtreeWorkerPrompt(target);
    try {
      await navigator.clipboard.writeText(text);
      setSaveState("已复制 Subagent Prompt");
    } catch {
      window.prompt("复制 Subagent Prompt：", text);
    }
  });

  nodeCard.querySelector("[data-action='toggle-neighbor-guides']")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (neighborGuideVisibleIds.has(nodeId)) neighborGuideVisibleIds.delete(nodeId);
    else neighborGuideVisibleIds.add(nodeId);
    nodeCard.querySelector("[data-action='toggle-neighbor-guides']")?.classList.toggle("active", neighborGuideVisibleIds.has(nodeId));
    renderNeighborGuides();
  });

  nodeCard.querySelector("[data-action='toggle-read']")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const next = !isNodeReadDone(node);
    markNodeReadDone(node, next);
    markDirty(`${next ? "将标记已经读完" : "将取消已经读完"}${nodeTitle(nodeId)}`);
    renderTree();
  });

  nodeCard.querySelector("[data-action='toggle-complete']").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNodeComplete(nodeId);
  });

  nodeCard.querySelector("[data-action='set-current']").addEventListener("click", (event) => {
    event.stopPropagation();
    setCurrentNode(nodeId);
  });

  nodeCard.querySelector("[data-action='set-next']").addEventListener("click", (event) => {
    event.stopPropagation();
    setNextNode(nodeId);
  });

  nodeCard.querySelector("[data-action='add-to-chain']")?.addEventListener("click", (event) => {
    event.stopPropagation();
    addNodeToChain(nodeId);
  });

  nodeCard.querySelector("[data-action='delete']").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteNode(nodeId);
  });

  nodeCard.querySelector(".connector").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startConnectorDrag(event, nodeId, nodeCard.querySelector(".connector"));
  });

  nodeCard.querySelector(".resizeHandle").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startNodeResize(event, nodeId, nodeCard);
  });

  for (const control of nodeCard.querySelectorAll("[data-field]")) {
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    if (control.dataset.field !== "id") {
      control.addEventListener("input", () => updateNodeField(nodeId, control.dataset.field, control.value, false));
    }
    control.addEventListener("change", () => updateNodeField(nodeId, control.dataset.field, control.value, true));
    if (control.dataset.field === "id") {
      control.addEventListener("blur", () => updateNodeField(nodeId, control.dataset.field, control.value, true));
    }
  }

  const nextPlanInput = nodeCard.querySelector(".nextPlanInput");
  if (nextPlanInput) {
    nextPlanInput.addEventListener("input", () => {
      nextPlan = nextPlanInput.value.trim();
      saveUserGraphStateFocus();
      markDirty(`将修改${nodeTitle(nodeId)}的用户备忘`);
    });
  }

  const skillRecommendBtn = nodeCard.querySelector(".skillRecommendBtn");
  if (skillRecommendBtn) {
    skillRecommendBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openSkillPanelForNode(nodeId);
    });
  }

  nodeCard.querySelector("[data-action='open-skill-panel']")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSkillPanelForNode(nodeId);
  });

  const nextIdeaInput = nodeCard.querySelector(".nextIdeaInput");
  if (nextIdeaInput) {
    nextIdeaInput.addEventListener("input", () => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      node.nextIdea = nextIdeaInput.value.trim();
      syncReadFingerprintIfMarked(node);
      markDirty(`将修改${nodeTitle(nodeId)}的下一步思路`);
    });
  }
}

async function openSkillPanelForNode(nodeId) {
  await recommendSkillsForNode(nodeId);
}

async function recommendSkillsForNode(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  skillPanelNodeId = nodeId;
  skillPanelLoading = true;
  skillPanelError = "";
  skillApplyNotice = "";
  skillRecommendations = [];
  renderTree();
  try {
    const response = await fetch("/api/skills/recommend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nextPlan,
        nextIdea: node.nextIdea,
        node: {
          title: node.title,
          problem: node.problem,
          approach: node.approach,
          metrics: node.metrics,
          notes: node.notes
        },
        selectedSkills: node.selectedSkills || ""
      })
    });
    if (!response.ok) throw new Error("skill 推荐失败");
    const data = await response.json();
    skillRecommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  } catch (error) {
    skillPanelError = error.message;
  } finally {
    skillPanelLoading = false;
    renderTree();
  }
}

function startConnectorDrag(event, sourceId, connector) {
  connector.setPointerCapture(event.pointerId);
  draftLink = { sourceId, pointer: graphPoint(event.clientX, event.clientY) };
  drawDraftLink();

  function move(moveEvent) {
    draftLink.pointer = graphPoint(moveEvent.clientX, moveEvent.clientY);
    drawDraftLink();
  }

  function up(upEvent) {
    connector.removeEventListener("pointermove", move);
    connector.removeEventListener("pointerup", up);
    connector.removeEventListener("pointercancel", up);
    const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest("[data-connector]");
    const targetId = target?.dataset.connector;
    if (targetId && targetId !== sourceId) addEdge([sourceId, targetId], `将增加${nodeTitle(sourceId)}到${nodeTitle(targetId)}的关系`);
    draftLink = null;
    rerenderEdges();
    renderTree();
  }

  connector.addEventListener("pointermove", move);
  connector.addEventListener("pointerup", up);
  connector.addEventListener("pointercancel", up);
}

function drawDraftLink() {
  if (!draftLink) return;
  const start = getNodePort(draftLink.sourceId);
  const end = draftLink.pointer;
  const midX = (start.x + end.x) / 2;
  const path = `<path class="draftPath" d="M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}" />`;
  rerenderEdges(path);
}

function startNodeDrag(event, nodeId, nodeCard, onClickWithoutDrag) {
  if (isInteractive(event.target) || event.button !== 0) return;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  event.preventDefault();
  nodeCard.setPointerCapture(event.pointerId);
  let moved = false;
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    nodeX: node.x || 0,
    nodeY: node.y || 0
  };

  function move(moveEvent) {
    const dx = (moveEvent.clientX - start.pointerX) / graphView.scale;
    const dy = (moveEvent.clientY - start.pointerY) / graphView.scale;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    node.x = Math.max(0, start.nodeX + dx);
    node.y = Math.max(0, start.nodeY + dy);
    nodeCard.style.left = `${node.x}px`;
    nodeCard.style.top = `${node.y}px`;
    rerenderEdges();
  }

  function up() {
    nodeCard.removeEventListener("pointermove", move);
    nodeCard.removeEventListener("pointerup", up);
    nodeCard.removeEventListener("pointercancel", up);
    if (moved) markDirty(`将修改节点${nodeTitle(nodeId)}的位置`);
    else onClickWithoutDrag?.();
  }

  nodeCard.addEventListener("pointermove", move);
  nodeCard.addEventListener("pointerup", up);
  nodeCard.addEventListener("pointercancel", up);
}

function startNodeResize(event, nodeId, nodeCard) {
  if (event.button !== 0) return;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  ensureNodeSize(node);
  nodeCard.setPointerCapture(event.pointerId);
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    width: nodeWidth(node),
    height: nodeHeight(node)
  };

  function move(moveEvent) {
    node.width = Math.max(card.minWidth, start.width + (moveEvent.clientX - start.pointerX) / graphView.scale);
    node.height = Math.max(card.minHeight, start.height + (moveEvent.clientY - start.pointerY) / graphView.scale);
    nodeCard.style.width = `${node.width}px`;
    nodeCard.style.height = `${node.height}px`;
    rerenderEdges();
  }

  function up() {
    nodeCard.removeEventListener("pointermove", move);
    nodeCard.removeEventListener("pointerup", up);
    nodeCard.removeEventListener("pointercancel", up);
    markDirty(`将修改节点${nodeTitle(nodeId)}的大小`);
  }

  nodeCard.addEventListener("pointermove", move);
  nodeCard.addEventListener("pointerup", up);
  nodeCard.addEventListener("pointercancel", up);
}

function addNodeNear(sourceId = selectedId) {
  const source = nodes.find((node) => node.id === sourceId);
  const id = nextNodeId();
  const node = {
    kind: "node",
    id,
    title: "新节点",
    x: source ? source.x + 480 : 80,
    y: source ? source.y + 80 : 80,
    completion: "未开始",
    problem: "",
    approach: "",
    input: "",
    output: "",
    metrics: "",
    notes: "",
    currentResult: "",
    rootCauseAnalysis: "",
    caseStudy: "",
    nextIdea: "",
    selectedSkills: ""
  };
  nodes.push(node);
  selectedId = id;
  ioPreviewNodeId = id;
  markDirty(`将增加节点${node.title}`);
  renderTree();
}

function deleteNode(id) {
  const node = nodes.find((item) => item.id === id);
  if (!node) return;
  if (!window.confirm(`删除节点「${node.title}」？相关边也会删除。`)) return;
  nodes = nodes.filter((item) => item.id !== id);
  edges = edges.filter((edge) => !edge.endpoints.includes(id));
  if (currentFocusId === id) currentFocusId = "";
  if (nextFocusId === id) nextFocusId = "";
  neighborGuideVisibleIds.delete(id);
  delete neighborHintOffsets[id];
  if (ioPreviewNodeId === id) ioPreviewNodeId = null;
  selectedId = nodes[0]?.id || null;
  if (selectedId) ioPreviewNodeId = selectedId;
  markDirty(`将删除节点${node.title}`);
  renderTree();
}

function layoutAsTree(options = {}) {
  const { silent = false, skipFitView = false } = options;
  if (!nodes.length) return;
  const rootId = nodes.some((node) => node.id === "ROOT")
    ? "ROOT"
    : selectedId || nodes[0].id;
  const adjacency = buildSpanningTreeAdjacency(rootId);
  prioritizeFocusSpine(adjacency);
  const top = 70;
  const left = 70;
  const skippedHyperedges = edges.filter((edge) => isLayoutHyperedge(edge)).length;

  const placements = TaskTreeLayout.layoutContourTree({
    rootId,
    adjacency,
    widthOf: nodeWidthById,
    heightOf: layoutNodeHeightById,
    left,
    top,
    defaults: { width: card.width, height: card.height }
  });
  for (const [id, point] of placements) {
    const node = nodes.find((item) => item.id === id);
    if (!node) continue;
    node.x = point.x;
    node.y = point.y;
  }

  for (const edge of edges) {
    edge.offsetX = 0;
    edge.offsetY = 0;
    edge.labelX = null;
    edge.labelY = null;
  }

  if (!silent) markDirty("将修改图谱为自上而下树形排版");
  renderTree();
  if (!skipFitView) scheduleFitGraphToViewport();
  if (skippedHyperedges && !silent) {
    setSaveState(`树形排版忽略了 ${skippedHyperedges} 条超边（>2 个端点）；请拆成多条二元边`);
  }
}

function prioritizeFocusSpine(adjacency) {
  const nextPath = getPathToNode(nextFocusId).nodes;
  const currentPath = getPathToNode(currentFocusId).nodes;
  const preferredChild = new Map();
  for (const path of [currentPath, nextPath]) {
    for (let index = 0; index < path.length - 1; index += 1) {
      const parentId = path[index];
      const childId = path[index + 1];
      const list = preferredChild.get(parentId) || [];
      if (!list.includes(childId)) list.push(childId);
      preferredChild.set(parentId, list);
    }
  }
  for (const [parentId, children] of adjacency) {
    const preferred = (preferredChild.get(parentId) || []).filter((id) => children.includes(id));
    if (!preferred.length) continue;
    const others = children.filter((id) => !preferred.includes(id));
    const middle = Math.floor(others.length / 2);
    adjacency.set(parentId, [...others.slice(0, middle), ...preferred, ...others.slice(middle)]);
  }
}

function saveUserGraphStateFocus() {
  try {
    if (!viewTreeId) return;
    localStorage.setItem(`${USER_GRAPH_STATE_STORAGE_KEY}.${viewTreeId}`, JSON.stringify({
      current: currentFocusId || "",
      next: nextFocusId || "",
      chainForceNext: chainForceNext || ""
    }));
  } catch {
    // ignore quota errors
  }
}

function readUserGraphStateFocus() {
  try {
    if (!viewTreeId) return null;
    const key = `${USER_GRAPH_STATE_STORAGE_KEY}.${viewTreeId}`;
    let raw = localStorage.getItem(key);
    if (!raw && viewTreeId === activeMethodTreeId) {
      raw = localStorage.getItem(USER_GRAPH_STATE_STORAGE_KEY);
      if (raw) localStorage.setItem(key, raw);
    }
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function currentTreeEntry() {
  return treeRegistry.trees.find((tree) => tree.id === viewTreeId) || null;
}

function isViewingActiveMethodTree() {
  return Boolean(viewTreeId && viewTreeId === activeMethodTreeId && currentTreeEntry()?.role === "method");
}

function treeApiUrl(pathname, extra = {}) {
  const url = new URL(pathname, window.location.origin);
  if (viewTreeId) url.searchParams.set("tree", viewTreeId);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function renderTreeSwitcher() {
  const current = currentTreeEntry();
  if (els.treeSelect) {
    els.treeSelect.innerHTML = treeRegistry.trees.map((tree) => {
      const roleLabel = tree.role === "method" ? "方法" : tree.role === "background" ? "背景" : tree.role === "experiments" ? "实验" : tree.role === "architecture" ? "架构" : "参考";
      const activeMark = tree.id === activeMethodTreeId ? " · 活动" : "";
      return `<option value="${attr(tree.id)}">${escapeHtml(tree.title)}（${roleLabel}${activeMark}）</option>`;
    }).join("");
    els.treeSelect.value = viewTreeId;
  }
  if (els.activeMethodBadge) {
    const active = isViewingActiveMethodTree();
    els.activeMethodBadge.textContent = active ? "活动方法树 · 绑定执行流" : `${current?.role === "background" ? "背景支撑树" : current?.role || "独立树"} · 不进入执行流`;
    els.activeMethodBadge.classList.toggle("is-background", !active);
  }
  if (els.setActiveMethodBtn) {
    els.setActiveMethodBtn.hidden = current?.role !== "method" || current.id === activeMethodTreeId;
  }
  const flowButton = document.querySelector(".graphViewBtn[data-graph-view='flow']");
  if (flowButton) {
    flowButton.disabled = !isViewingActiveMethodTree();
    flowButton.title = isViewingActiveMethodTree() ? "查看活动方法树的执行流程" : "执行流程只绑定活动方法树";
  }
  const exportFlowButton = document.querySelector("#exportFlowSvgBtn");
  if (exportFlowButton) exportFlowButton.disabled = !isViewingActiveMethodTree();
  if (!isViewingActiveMethodTree() && document.querySelector(".graphViewBtn.is-active")?.dataset.graphView === "flow") {
    setGraphView("tree");
  }
  els.chainAutoAdvanceBtn?.classList.toggle("hidden", !isViewingActiveMethodTree());
  document.querySelector(".chainDock")?.classList.toggle("hidden", !isViewingActiveMethodTree());
  if (els.subtitle && current) els.subtitle.textContent = `${current.title} · ${current.path}`;
}

async function loadTreeRegistryState() {
  const response = await fetch(`/api/trees?t=${Date.now()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取任务树注册表失败");
  treeRegistry = data;
  activeMethodTreeId = data.activeMethod || data.trees?.find((tree) => tree.role === "method")?.id || "method";
  const requested = new URL(window.location.href).searchParams.get("tree");
  if (!viewTreeId) viewTreeId = data.trees?.some((tree) => tree.id === requested) ? requested : activeMethodTreeId;
  if (!data.trees?.some((tree) => tree.id === viewTreeId)) viewTreeId = activeMethodTreeId;
  renderTreeSwitcher();
  return data;
}

async function switchViewedTree(treeId) {
  if (!treeId || treeId === viewTreeId) return;
  if (dirty) await saveTree();
  if (workspaceMode === "subtree") await exitSubtreeWorkspace();
  viewTreeId = treeId;
  const url = new URL(window.location.href);
  url.searchParams.set("tree", treeId);
  url.searchParams.delete("subtree");
  window.history.replaceState({}, "", url);
  selectedId = null;
  ioPreviewNodeId = null;
  shouldAutoFitView = true;
  renderTreeSwitcher();
  await loadTree({ fitView: true, registryLoaded: true });
}

async function createIndependentTree() {
  const title = window.prompt("新任务树名称（例如：项目背景支撑）", "项目背景支撑");
  if (!title?.trim()) return;
  const suggestedId = title.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `tree-${Date.now().toString(36)}`;
  const id = window.prompt("树 ID（英文、数字、-、_）", suggestedId);
  if (!id?.trim()) return;
  const roleInput = window.prompt("类型：background / method / experiments / architecture / reference", "background");
  if (!roleInput?.trim()) return;
  const role = ["background", "method", "experiments", "architecture", "reference"].includes(roleInput.trim()) ? roleInput.trim() : "reference";
  const response = await fetch("/api/trees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id.trim(), title: title.trim(), role, path: `trees/${id.trim()}.md`, flowEnabled: role === "method" })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "创建任务树失败");
  await loadTreeRegistryState();
  await switchViewedTree(data.tree.id);
}

async function setViewedTreeAsActiveMethod() {
  const current = currentTreeEntry();
  if (!current || current.role !== "method") return;
  if (dirty) await saveTree();
  const response = await fetch("/api/trees/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ treeId: current.id })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "切换活动方法树失败");
  activeMethodTreeId = data.activeMethod;
  treeRegistry = { ...treeRegistry, ...data, trees: treeRegistry.trees };
  renderTreeSwitcher();
  if (flowViewApi) await flowViewApi.reload();
  await loadMaintenanceStatus();
}

async function loadMaintenanceStatus() {
  if (!els.maintenanceState) return;
  try {
    const response = await fetch(`/api/maintenance/status?t=${Date.now()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "维护检查失败");
    maintenanceStatus = data;
    const drift = data.flow?.drift || {};
    const driftCount = (drift.missingInFlow?.length || 0) + (drift.staleInFlow?.length || 0) + (drift.statusMismatch?.length || 0);
    const issueCount = (data.issues?.length || 0) + driftCount;
    const warningCount = data.warnings?.length || 0;
    els.maintenanceState.textContent = issueCount ? `维护缺口 ${issueCount}` : warningCount ? `维护警告 ${warningCount}` : "维护闭环正常";
    els.maintenanceState.classList.toggle("has-issues", issueCount > 0);
    els.maintenanceState.classList.toggle("has-warnings", issueCount === 0 && warningCount > 0);
    els.maintenanceState.title = [...(data.issues || []), ...(data.warnings || [])].map((item) => `${item.code}: ${item.message}`).join("\n") || "活动方法树、步骤证据与执行流程已闭环";
  } catch (error) {
    els.maintenanceState.textContent = "维护状态不可用";
    els.maintenanceState.classList.add("has-issues");
    els.maintenanceState.title = error.message;
  }
}

function isChainRunActive(graphState = {}) {
  return String(graphState.chainRunStatus || "").trim() === "running";
}

function nodeLayoutEdgeGap(a, b) {
  return TaskTreeLayout.edgeGap(a ? nodeWidth(a) : card.width, b ? nodeWidth(b) : card.width);
}

function isLayoutHyperedge(edge) {
  return TaskTreeLayout.isHyperedge(edge, new Set(nodes.map((node) => node.id)));
}

function buildSpanningTreeAdjacency(rootId) {
  return TaskTreeLayout.buildSpanningTreeAdjacency({
    nodeIds: nodes.map((node) => node.id),
    edges,
    rootId
  });
}


function nodeWidthById(id) {
  const node = nodes.find((item) => item.id === id);
  return node ? nodeWidth(node) : card.width;
}

function nodeHeightById(id) {
  const node = nodes.find((item) => item.id === id);
  return node ? nodeHeight(node) : card.height;
}

function layoutNodeHeightById(id) {
  const node = nodes.find((item) => item.id === id);
  if (!node) return card.height;
  if (usesContentSizedCard(node)) {
    const focus = node.id === currentFocusId || node.id === nextFocusId;
    return focus ? card.compactFocusMaxHeight : card.compactMaxHeight;
  }
  return displayNodeHeight(node);
}

function getFocusHighlights() {
  const current = getPathToNode(currentFocusId);
  const next = getPathToNode(nextFocusId);
  return {
    currentNodes: new Set(current.nodes),
    currentEdges: new Set(current.edges),
    nextNodes: new Set(next.nodes),
    nextEdges: new Set(next.edges)
  };
}

function getPathToNode(targetId) {
  if (!targetId || !nodes.some((node) => node.id === targetId)) return { nodes: [], edges: [] };
  const rootId = nodes.some((node) => node.id === "ROOT") ? "ROOT" : nodes[0]?.id;
  if (!rootId) return { nodes: [targetId], edges: [] };
  if (rootId === targetId) return { nodes: [rootId], edges: [] };

  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    const endpoints = edge.endpoints.filter((id) => adjacency.has(id));
    if (endpoints.length < 2) continue;
    for (const source of endpoints) {
      for (const target of endpoints) {
        if (target !== source) adjacency.get(source).push({ id: target, edgeId: edge.id });
      }
    }
  }

  const queue = [{ id: rootId, nodePath: [rootId], edgePath: [] }];
  const visited = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    for (const next of adjacency.get(item.id) || []) {
      if (visited.has(next.id)) continue;
      const nodePath = [...item.nodePath, next.id];
      const edgePath = [...item.edgePath, next.edgeId];
      if (next.id === targetId) return { nodes: nodePath, edges: edgePath };
      queue.push({ id: next.id, nodePath, edgePath });
    }
  }

  return { nodes: [targetId], edges: [] };
}

function parseChainIds(text) {
  return String(text || "")
    .split(/[,，\s]+/)
    .map((item) => sanitizeId(item))
    .filter(Boolean);
}

function syncNextFromChain() {
  const ids = parseChainIds(chainText);
  if (!ids.length) return;
  if (!nextFocusId || !ids.includes(nextFocusId)) {
    nextFocusId = ids[0];
  }
}

function setChainIds(ids, reason) {
  chainText = ids.join(", ");
  if (ids.length && chainRunStatus !== "done") chainRunStatus = "running";
  if (!ids.length) chainRunStatus = "";
  syncNextFromChain();
  markDirty(reason);
}

function addNodeToChain(nodeId) {
  const ids = parseChainIds(chainText);
  if (ids.includes(nodeId)) {
    setSaveState(`${nodeTitle(nodeId)} 已在执行链中`);
    return;
  }
  ids.push(nodeId);
  setChainIds(ids, `将把${nodeTitle(nodeId)}加入执行链`);
  renderTree();
  saveTree().catch((error) => setSaveState(error.message));
  setSaveState(`已加入执行链：${nodeTitle(nodeId)}`);
}

function removeNodeFromChain(nodeId) {
  const ids = parseChainIds(chainText).filter((id) => id !== nodeId);
  setChainIds(ids, `将把${nodeTitle(nodeId)}移出执行链`);
  if (nextFocusId === nodeId) {
    nextFocusId = ids[0] || "";
  }
  renderTree();
  saveTree().catch((error) => setSaveState(error.message));
}

function clearChain() {
  if (!parseChainIds(chainText).length) return;
  chainText = "";
  chainRunStatus = "";
  markDirty("将清空执行链");
  renderTree();
  saveTree().catch((error) => setSaveState(error.message));
  setSaveState("执行链已清空");
}

function getTaskTreePort() {
  const port = window.location.port || "";
  return port || "5177";
}

function buildChainLoopPromptText({ subtreePath = "" } = {}) {
  const port = getTaskTreePort();
  const scope = subtreePath ? `&subtree=${encodeURIComponent(subtreePath)}` : "";
  const scopeNote = subtreePath
    ? `【子树 loop · ${subtreePath}】`
    : "【链式单步·按 NextIdea 执行】";
  const treeHint = subtreePath
    ? `读 stepMarkdown（本子树 GraphState + Next 节点 NextIdea）；可 Read ${subtreePath}；禁止改 task-tree.md 详文`
    : "需要时可读完整 task-tree.md 或其它文件作上下文";
  const advanceBody = subtreePath
    ? `{ "subtree": "${subtreePath}" }`
    : "{}";
  const softStop = `powershell -File llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly -Reason "链式执行结束"`;
  return `/loop 3m ${scopeNote}
0) GET http://127.0.0.1:${port}/api/graph-state/chain-step${scope ? `?subtree=${encodeURIComponent(subtreePath)}` : ""} — shouldStopLoop 则 ${softStop} 并结束（不关闭 IDE）
1) 读 stepMarkdown：GraphState.Next + Next 节点卡片「下一步思路」(NextIdea)；不要读 GraphState.NextPlan（「下一步」）
2) 严格按 NextIdea 执行；${treeHint}；不要一轮做完 Chain 里多个节点
3) 更新 Next 节点 CurrentResult；完成则 Completion:已完成；保存${subtreePath || "task-tree.md"}
4) 若已开 ChainAutoAdvance 且本步完成 → POST http://127.0.0.1:${port}/api/graph-state/chain-advance body ${advanceBody}
5) 若 done 或 again shouldStopLoop → ${softStop}`;
}

function openChainLoopHelpDialog() {
  if (!els.chainLoopHelpDialog) return;
  if (els.chainLoopHelpPort) els.chainLoopHelpPort.textContent = getTaskTreePort();
  if (els.chainLoopHelpPrompt) {
    els.chainLoopHelpPrompt.textContent = buildChainLoopPromptText({
      subtreePath: workspaceMode === "subtree" ? activeSubtreePath : ""
    });
  }
  if (typeof els.chainLoopHelpDialog.showModal === "function") {
    els.chainLoopHelpDialog.showModal();
  }
}

async function copyChainLoopPrompt() {
  const text = buildChainLoopPromptText({
    subtreePath: workspaceMode === "subtree" ? activeSubtreePath : ""
  });
  try {
    await navigator.clipboard.writeText(text);
    setSaveState("已复制 loop 命令");
  } catch {
    window.prompt("复制 loop 命令：", text);
  }
}

function wireChainLoopHelp() {
  els.chainLoopHelpBtn?.addEventListener("click", () => openChainLoopHelpDialog());
  els.chainLoopHelpClose?.addEventListener("click", () => els.chainLoopHelpDialog?.close());
  if (els.chainLoopHelpCopyBtn) {
    els.chainLoopHelpCopyBtn.addEventListener("click", () => copyChainLoopPrompt());
  }
  els.chainLoopCmdCopyBtn?.addEventListener("click", () => copyChainLoopPrompt());
  els.workspaceBannerExitBtn?.addEventListener("click", () => {
    exitSubtreeWorkspace().catch((error) => setSaveState(error.message));
  });
  els.chainLoopHelpDialog?.addEventListener("click", (event) => {
    if (event.target === els.chainLoopHelpDialog) els.chainLoopHelpDialog.close();
  });
}

function renderChainLoopCmdBar() {
  if (!els.chainLoopCmdBar) return;
  const show = !chainDockCollapsed && (chainAutoAdvance || parseChainIds(chainText).length > 0 || workspaceMode === "subtree");
  els.chainLoopCmdBar.classList.toggle("hidden", !show);
  const text = buildChainLoopPromptText({
    subtreePath: workspaceMode === "subtree" ? activeSubtreePath : ""
  });
  if (els.chainLoopCmdText) els.chainLoopCmdText.textContent = text;
}

function renderChainDock() {
  if (!els.chainSlot) return;
  applyChainDockCollapseState({ persist: false });
  renderChainLoopCmdBar();
  const ids = parseChainIds(chainText);
  if (els.chainAutoAdvanceBtn) {
    els.chainAutoAdvanceBtn.classList.toggle("active", chainAutoAdvance);
    els.chainAutoAdvanceBtn.setAttribute("aria-pressed", chainAutoAdvance ? "true" : "false");
  }
  const statusHint = chainRunStatus === "done" ? " · 链已跑完" : chainRunStatus === "running" ? " · 运行中" : "";
  if (els.chainDockSummary) {
    els.chainDockSummary.textContent = `${ids.length} 个节点${statusHint}`;
  }
  if (!ids.length) {
    els.chainSlot.innerHTML = `<div class="chainSlotEmpty">从节点上的 ⊕ 添加任务${statusHint}</div>`;
    return;
  }
  els.chainSlot.innerHTML = ids.map((id, index) => {
    const node = nodes.find((item) => item.id === id);
    const title = node ? escapeHtml(node.title) : id;
    const isNext = id === nextFocusId;
    return `<div class="chainCard${isNext ? " isNext" : ""}" data-chain-id="${attr(id)}" role="button" tabindex="0" title="拖动排序；点击选中节点">
      <span class="chainCardIndex">${index + 1}</span>
      <span class="chainCardTitle">${title}</span>
      <span class="chainCardId">${escapeHtml(id)}</span>
      <button type="button" class="chainCardRemove" data-chain-remove="${attr(id)}" title="移出">×</button>
    </div>`;
  }).join("");

  for (const card of els.chainSlot.querySelectorAll(".chainCard")) {
    card.addEventListener("pointerdown", startChainCardDrag);
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-chain-remove]") || card.dataset.suppressClick) {
        delete card.dataset.suppressClick;
        return;
      }
      const nodeId = card.dataset.chainId;
      if (!nodeId) return;
      selectedId = nodeId;
      nextFocusId = nodeId;
      saveUserGraphStateFocus();
      markDirty(`将把下一步设为${nodeTitle(nodeId)}`);
      renderTree();
      saveTree().catch((error) => setSaveState(error.message));
    });
  }
  for (const button of els.chainSlot.querySelectorAll("[data-chain-remove]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      removeNodeFromChain(button.dataset.chainRemove);
    });
  }
}

function startChainCardDrag(event) {
  const card = event.currentTarget;
  const nodeId = card.dataset.chainId;
  if (!nodeId || event.button !== 0) return;
  if (event.target.closest("[data-chain-remove]")) return;
  event.preventDefault();
  event.stopPropagation();
  chainDrag = { nodeId, pointerId: event.pointerId, moved: false };
  card.classList.add("dragging");
  card.setPointerCapture(event.pointerId);
  card.addEventListener("pointermove", moveChainCardDrag);
  card.addEventListener("pointerup", endChainCardDrag);
  card.addEventListener("pointercancel", endChainCardDrag);
}

function moveChainCardDrag(event) {
  if (!chainDrag || chainDrag.pointerId !== event.pointerId || !els.chainSlot) return;
  const slot = els.chainSlot;
  const dragging = slot.querySelector(".chainCard.dragging");
  if (!dragging) return;
  const x = event.clientX;
  const cards = [...slot.querySelectorAll(".chainCard:not(.dragging)")];
  let insertBefore = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) {
      insertBefore = card;
      break;
    }
  }
  if (insertBefore) slot.insertBefore(dragging, insertBefore);
  else slot.appendChild(dragging);
  chainDrag.moved = true;
}

function endChainCardDrag(event) {
  if (!chainDrag || chainDrag.pointerId !== event.pointerId) return;
  const card = event.currentTarget;
  const moved = chainDrag.moved;
  card.classList.remove("dragging");
  card.releasePointerCapture(event.pointerId);
  card.removeEventListener("pointermove", moveChainCardDrag);
  card.removeEventListener("pointerup", endChainCardDrag);
  card.removeEventListener("pointercancel", endChainCardDrag);
  const ids = [...els.chainSlot.querySelectorAll(".chainCard")].map((item) => item.dataset.chainId).filter(Boolean);
  const previous = parseChainIds(chainText).join(",");
  const next = ids.join(",");
  chainDrag = null;
  if (moved) card.dataset.suppressClick = "1";
  if (previous === next) return;
  setChainIds(ids, "将调整执行链顺序");
  renderTree();
  saveTree().catch((error) => setSaveState(error.message));
}

function toggleChainAutoAdvance() {
  chainAutoAdvance = !chainAutoAdvance;
  markDirty(chainAutoAdvance ? "将开启 ChainAutoAdvance" : "将关闭 ChainAutoAdvance");
  renderChainDock();
  saveTree().catch((error) => setSaveState(error.message));
  setSaveState(chainAutoAdvance ? "已开启自动推进" : "已关闭自动推进");
}

function addEdge(endpoints, reason = "将增加图谱关系") {
  edges.push({
    kind: "edge",
    id: nextEdgeId(edges),
    endpoints: unique(endpoints),
    labelX: null,
    labelY: null,
    offsetX: 0,
    offsetY: 0,
    label: "",
    notes: ""
  });
  markDirty(reason);
}

function updateNodeField(nodeId, field, value, shouldRender) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const previousId = node.id;
  const normalized = field === "id" ? sanitizeId(value) : value.trim();
  node[field] = field === "title" && !normalized ? "未命名节点" : normalized;

  if (field === "id" && node.id !== previousId) {
    for (const edge of edges) {
      edge.endpoints = edge.endpoints.map((endpoint) => endpoint === previousId ? node.id : endpoint);
    }
    selectedId = node.id;
  }

  if (NODE_READ_CONTENT_FIELDS.includes(field) || field === "title") {
    syncReadFingerprintIfMarked(node);
  }

  markDirty(`将修改节点${nodeTitle(nodeId)}`);
  if (shouldRender || field === "id") renderTree();
}

function updateEdgeField(edgeId, field, value, shouldRender) {
  const edge = edges.find((item) => item.id === edgeId);
  if (!edge) return;
  if (field === "endpoints") edge.endpoints = parseEndpointList(value).filter((id) => nodes.some((node) => node.id === id));
  else edge[field] = value.trim();
  markDirty(`将修改关系${edge.label || edgeId}`);
  if (shouldRender || field === "endpoints") rerenderEdges();
}

function loadFromMarkdown(markdown, options = {}) {
  const preservedLensId = options.preserveLens && focusLensOpen ? focusLensId : "";
  closeFocusLens({ locate: false });
  const parsed = parseMarkdown(markdown);
  const incoming = parsed.graphState;
  const userFocus = readUserGraphStateFocus();
  const chainRunning = isChainRunActive(incoming);
  const chainFinished = incoming.chainRunStatus === "done";
  let focusRestored = false;

  if (!options.skipUserGraphStateLock && !chainRunning && !chainFinished && userFocus) {
    const ids = new Set(parsed.nodes.map((node) => node.id));
    const next = userFocus.next && ids.has(userFocus.next) ? userFocus.next : incoming.next;
    const current = userFocus.current && ids.has(userFocus.current) ? userFocus.current : incoming.current;
    const force = userFocus.chainForceNext || "";
    focusRestored = next !== incoming.next
      || current !== incoming.current
      || force !== (incoming.chainForceNext || "");
    incoming.next = next;
    incoming.current = current;
    incoming.chainForceNext = force;
  }

  lastLoadedMarkdown = markdown;
  if (options.markSaved || !focusRestored) lastSavedMarkdown = markdown;
  for (const node of parsed.nodes) reconcileNodeReadStatus(node);
  nodes = parsed.nodes;
  edges = parsed.edges;
  currentFocusId = nodes.some((node) => node.id === incoming.current) ? incoming.current : "";
  nextFocusId = nodes.some((node) => node.id === incoming.next) ? incoming.next : "";
  nextPlan = incoming.nextPlan || "";
  chainText = incoming.chain || "";
  chainAutoAdvance = incoming.chainAutoAdvance === true;
  chainForceNext = incoming.chainForceNext || "";
  chainRunStatus = incoming.chainRunStatus || "";
  selectedId = nodes.some((node) => node.id === preservedLensId) ? preservedLensId : nodes[0]?.id || null;
  renderTree();
  if (preservedLensId && nodes.some((node) => node.id === preservedLensId)) openFocusLens(preservedLensId, { preserveActions: true });
  if (options.fitView || shouldAutoFitView) {
    scheduleFitGraphToViewport();
    shouldAutoFitView = false;
  }
  saveUserGraphStateFocus();
  dirty = focusRestored;
  setSaveState(focusRestored ? "已恢复你指定的下一步焦点" : "已加载");
  if (focusRestored && !options.skipRestoreSave) {
    saveTree().catch((error) => setSaveState(`恢复焦点保存失败: ${error.message}`));
  }
}

async function loadTree(options = {}) {
  if (!options.registryLoaded) await loadTreeRegistryState();
  const response = await fetch(treeApiUrl("/api/tree", { t: Date.now() }));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "加载任务树失败");
  loadFromMarkdown(data.markdown, {
    fitView: Boolean(options.fitView),
    skipUserGraphStateLock: !isViewingActiveMethodTree()
  });
  writeCurrentVersionSnapshot(data.markdown).catch(() => {});
  await loadVersions();
  await loadModelAgents();
  await loadKnowledgeConfig();
  const serverInfo = await probeServerFeatures();
  if (!serverInfo?.features?.openInEditor) {
    setSaveState("后台版本过旧或未响应，请重新打开「打开任务图.cmd」后再试检索/打开代码");
  }
  renderTree();
  if (options.fitView) scheduleFitGraphToViewport();
  renderTreeSwitcher();
  loadMaintenanceStatus().catch(() => {});
  if (flowViewApi && isViewingActiveMethodTree()) flowViewApi.reload().catch(() => {});

  const subtreeParam = new URL(window.location.href).searchParams.get("subtree");
  if (subtreeParam && workspaceMode === "main") {
    const normalized = subtreeParam.replace(/\\/g, "/");
    const target = nodes.find((item) => isNodeFolded(item) && String(item.subtreeFile || "").replace(/\\/g, "/") === normalized);
    if (target) {
      await enterSubtreeWorkspace(target);
    } else {
      setSaveState(`未找到折叠 stub：${normalized}`);
    }
  }
  maybeOpenDailyProjectOverview();
}

async function loadModelAgents() {
  try {
    const response = await fetch(`/api/model-agents?t=${Date.now()}`);
    if (!response.ok) throw new Error("读取模型配置失败");
    const data = await response.json();
    modelAgents = Array.isArray(data.models) ? data.models : [];
  } catch (error) {
    modelPanelError = error.message;
  }
}

async function loadKnowledgeConfig() {
  if (!els.knowledgeState) return;
  try {
    const response = await fetch(`/api/knowledge/config?t=${Date.now()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取知识库配置失败");
    knowledgeConfig = data.config;
    knowledgeIndex = data.index;
    knowledgeReindexJob = data.reindex || knowledgeReindexJob;
    webSearchConfig = data.webSearch || null;
    openWebSearchStatus = data.openWebSearch || null;
    knowledgeError = "";
    syncRetrievalControlsFromConfig();
    syncLibraryControlsFromConfig();
    renderKnowledgePanel();
  } catch (error) {
    knowledgeError = formatApiFetchError(error, null, "读取知识库配置");
    renderKnowledgePanel();
  }
}

function syncRetrievalControlsFromConfig() {
  const retrieval = knowledgeConfig?.retrieval || {};
  const maxChunks = Math.max(1, Math.min(5, Number(retrieval.maxChunksPerDoc) || 1));
  const poolMultiplier = Math.max(2, Math.min(30, Number(retrieval.candidatePoolMultiplier) || 10));
  const diversify = retrieval.diversify !== false;
  if (els.kbRetrievalDiversify) els.kbRetrievalDiversify.checked = diversify;
  if (els.kbRetrievalMaxChunks) {
    els.kbRetrievalMaxChunks.value = String(maxChunks);
    if (els.kbRetrievalMaxChunksVal) els.kbRetrievalMaxChunksVal.textContent = String(maxChunks);
  }
  if (els.kbRetrievalPool) {
    els.kbRetrievalPool.value = String(poolMultiplier);
    if (els.kbRetrievalPoolVal) els.kbRetrievalPoolVal.textContent = String(poolMultiplier);
  }
}

function updateRetrievalSliderLabels() {
  if (els.kbRetrievalMaxChunks && els.kbRetrievalMaxChunksVal) {
    els.kbRetrievalMaxChunksVal.textContent = els.kbRetrievalMaxChunks.value;
  }
  if (els.kbRetrievalPool && els.kbRetrievalPoolVal) {
    els.kbRetrievalPoolVal.textContent = els.kbRetrievalPool.value;
  }
}

function currentRetrievalSettingsFromPanel() {
  return {
    diversify: els.kbRetrievalDiversify?.checked !== false,
    maxChunksPerDoc: Math.max(1, Math.min(5, Number(els.kbRetrievalMaxChunks?.value) || 1)),
    candidatePoolMultiplier: Math.max(2, Math.min(30, Number(els.kbRetrievalPool?.value) || 10))
  };
}

async function saveKnowledgeLibraryPreferences() {
  const activeLibraryId = els.kbLibrarySelect?.value || knowledgeConfig?.activeLibraryId || "";
  const searchAllLibraries = els.kbSearchAllLibraries?.checked === true;
  try {
    const response = await fetch("/api/knowledge/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeLibraryId, searchAllLibraries })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存知识库选择失败");
    knowledgeConfig = data.config || knowledgeConfig;
    knowledgeError = "";
    syncLibraryControlsFromConfig();
    renderKnowledgePanel();
  } catch (error) {
    knowledgeError = formatApiFetchError(error, null, "保存知识库选择");
    renderKnowledgePanel();
  }
}

function syncLibraryControlsFromConfig() {
  const libraries = knowledgeConfig?.libraries || knowledgeIndex?.libraries || [];
  const activeId = knowledgeConfig?.activeLibraryId || libraries[0]?.id || "";
  const searchAll = knowledgeConfig?.searchAllLibraries === true;
  if (els.kbLibrarySelect) {
    els.kbLibrarySelect.innerHTML = libraries.length
      ? libraries.map((item) => `<option value="${attr(item.id)}">${escapeHtml(item.label || item.id)}</option>`).join("")
      : `<option value="">（无子文件夹）</option>`;
    if (activeId) els.kbLibrarySelect.value = activeId;
    els.kbLibrarySelect.disabled = searchAll || !libraries.length;
  }
  if (els.kbSearchAllLibraries) els.kbSearchAllLibraries.checked = searchAll;
  if (els.kbLibraryStats) {
    els.kbLibraryStats.textContent = libraries.length
      ? libraries.map((item) => `${item.label || item.id}: ${item.totalChunks || 0} 段${item.indexExists ? "" : " · 未索引"}`).join("\n")
      : `在 ${knowledgeConfig?.libraryRoot || "knowledge"}/ 下创建子文件夹后刷新页面`;
  }
}

function knowledgeRetrievalScope() {
  const searchAllLibraries = els.kbSearchAllLibraries?.checked === true;
  const activeId = els.kbLibrarySelect?.value || knowledgeConfig?.activeLibraryId || "";
  return {
    searchAllLibraries,
    libraryIds: searchAllLibraries || !activeId ? undefined : [activeId]
  };
}

async function saveKnowledgeRetrievalConfig() {
  if (!els.kbRetrievalSaveBtn) return;
  const retrieval = currentRetrievalSettingsFromPanel();
  knowledgeRetrievalStatus = "保存中…";
  els.kbRetrievalSaveBtn.disabled = true;
  renderKnowledgePanel();
  try {
    const response = await fetch("/api/knowledge/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retrieval })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存检索设置失败");
    knowledgeConfig = data.config || knowledgeConfig;
    knowledgeRetrievalStatus = `已保存 · 每篇 ${retrieval.maxChunksPerDoc} 段 · 候选池 ×${retrieval.candidatePoolMultiplier}${retrieval.diversify ? "" : " · 多样性已关"}`;
    knowledgeError = "";
    syncRetrievalControlsFromConfig();
  } catch (error) {
    knowledgeRetrievalStatus = "";
    knowledgeError = formatApiFetchError(error, null, "保存检索设置");
  } finally {
    if (els.kbRetrievalSaveBtn) els.kbRetrievalSaveBtn.disabled = false;
    renderKnowledgePanel();
  }
}

function stripMarkdownPlain(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#>*_\[\]()!|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTurnSummary(turn) {
  const source = turn.kind === "ask" && turn.answer
    ? stripMarkdownPlain(turn.answer)
    : stripMarkdownPlain(turn.query);
  if (!source) return turn.kind === "ask" ? "模型问答" : "知识检索";
  if (source.length <= 30) return source;
  return `${source.slice(0, 30)}…`;
}

function isClientLowValueWebResult(item) {
  if (item?.source !== "web") return false;
  const blob = `${item.title || ""}\n${item.content || ""}\n${item.url || item.path || ""}`;
  return /北京时间|标准北京时间|time\.is|beijing-time|汉语词语|在线标准时间|几点几分/i.test(blob);
}

function normalizeKnowledgeTurn(turn) {
  const normalized = {
    id: String(turn.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    createdAt: String(turn.createdAt || new Date().toISOString()),
    kind: turn.kind === "ask" ? "ask" : "search",
    query: String(turn.query || ""),
    executedQuery: String(turn.executedQuery || ""),
    rewriteSource: String(turn.rewriteSource || ""),
    answer: String(turn.answer || ""),
    summary: String(turn.summary || ""),
    collapsed: turn.collapsed === true,
    referencesOpen: turn.referencesOpen === true,
    includeWeb: turn.includeWeb === true,
    results: Array.isArray(turn.results) ? turn.results.filter((item) => !isClientLowValueWebResult(item)) : []
  };
  if (!normalized.summary) normalized.summary = buildTurnSummary(normalized);
  return normalized;
}

function serializeKnowledgeHistoryForStorage() {
  return knowledgeHistory.slice(-KB_HISTORY_MAX_TURNS).map((turn) => ({
    id: turn.id,
    createdAt: turn.createdAt,
    kind: turn.kind,
    query: turn.query,
    executedQuery: turn.executedQuery || "",
    rewriteSource: turn.rewriteSource || "",
    answer: turn.answer || "",
    summary: turn.summary || buildTurnSummary(turn),
    collapsed: turn.collapsed === true,
    referencesOpen: turn.referencesOpen === true,
    includeWeb: turn.includeWeb === true,
    results: (turn.results || []).map((item) => ({
      id: item.id,
      path: item.path,
      title: item.title,
      url: item.url,
      source: item.source,
      score: item.score,
      content: String(item.content || "").slice(0, KB_CONTEXT_SNIPPET_CHARS)
    }))
  }));
}

function persistKnowledgeHistoryToLocalStorage() {
  try {
    localStorage.setItem(KB_HISTORY_STORAGE_KEY, JSON.stringify(serializeKnowledgeHistoryForStorage()));
  } catch {
    knowledgeHistory = knowledgeHistory.slice(-Math.max(4, Math.floor(KB_HISTORY_MAX_TURNS / 2)));
    try {
      localStorage.setItem(KB_HISTORY_STORAGE_KEY, JSON.stringify(serializeKnowledgeHistoryForStorage()));
    } catch {
      // ignore quota errors
    }
  }
}

async function flushKnowledgeHistoryToServer() {
  if (knowledgeHistorySaveInFlight) {
    knowledgeHistorySaveAgain = true;
    return;
  }
  knowledgeHistorySaveInFlight = true;
  try {
    const response = await fetch("/api/knowledge/history", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: serializeKnowledgeHistoryForStorage() })
    });
    if (!response.ok) throw new Error("save failed");
  } catch {
    // localStorage still holds a copy
  } finally {
    knowledgeHistorySaveInFlight = false;
    if (knowledgeHistorySaveAgain) {
      knowledgeHistorySaveAgain = false;
      flushKnowledgeHistoryToServer();
    }
  }
}

function persistKnowledgeHistory() {
  persistKnowledgeHistoryToLocalStorage();
  clearTimeout(knowledgeHistorySaveTimer);
  knowledgeHistorySaveTimer = setTimeout(() => {
    knowledgeHistorySaveTimer = null;
    flushKnowledgeHistoryToServer();
  }, 350);
}

async function loadKnowledgeHistory() {
  let loadedFromServer = false;
  try {
    const response = await fetch(`/api/knowledge/history?t=${Date.now()}`);
    const data = await response.json();
    if (response.ok && Array.isArray(data.history) && data.history.length) {
      knowledgeHistory = data.history.slice(-KB_HISTORY_MAX_TURNS).map((turn) => normalizeKnowledgeTurn(turn));
      loadedFromServer = true;
    }
  } catch {
    // fall through to localStorage migration
  }
  if (!loadedFromServer) {
    try {
      const raw = localStorage.getItem(KB_HISTORY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          knowledgeHistory = parsed.slice(-KB_HISTORY_MAX_TURNS).map((turn) => normalizeKnowledgeTurn(turn));
          await flushKnowledgeHistoryToServer();
        }
      }
    } catch {
      knowledgeHistory = [];
    }
  }
  if (!Array.isArray(knowledgeHistory)) knowledgeHistory = [];
}

function appendKnowledgeTurn(turn) {
  const results = (Array.isArray(turn.results) ? turn.results : []).filter((item) => !isClientLowValueWebResult(item));
  knowledgeHistory.push(normalizeKnowledgeTurn({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    kind: turn.kind === "ask" ? "ask" : "search",
    query: String(turn.query || ""),
    executedQuery: String(turn.executedQuery || ""),
    rewriteSource: String(turn.rewriteSource || ""),
    answer: String(turn.answer || ""),
    collapsed: false,
    referencesOpen: false,
    includeWeb: turn.includeWeb === true,
    results
  }));
  if (knowledgeHistory.length > KB_HISTORY_MAX_TURNS) {
    knowledgeHistory = knowledgeHistory.slice(-KB_HISTORY_MAX_TURNS);
  }
  knowledgeHistoryShouldStickToBottom = true;
  persistKnowledgeHistory();
}

function deleteKnowledgeTurn(turnId) {
  knowledgeHistory = knowledgeHistory.filter((turn) => turn.id !== turnId);
  persistKnowledgeHistory();
  renderKnowledgePanel();
}

function toggleKnowledgeTurnCollapsed(turnId) {
  const turn = knowledgeHistory.find((item) => item.id === turnId);
  if (!turn) return;
  turn.collapsed = !turn.collapsed;
  knowledgeHistoryShouldStickToBottom = false;
  persistKnowledgeHistory();
  renderKnowledgePanel();
}

function captureKnowledgeHistoryScroll() {
  if (!els.kbHistory) return;
  knowledgeHistoryScrollTop = els.kbHistory.scrollTop;
  const distanceToBottom = els.kbHistory.scrollHeight - els.kbHistory.clientHeight - els.kbHistory.scrollTop;
  knowledgeHistoryShouldStickToBottom = distanceToBottom < 48;
}

function restoreKnowledgeHistoryScroll() {
  if (!els.kbHistory) return;
  requestAnimationFrame(() => {
    if (!els.kbHistory) return;
    els.kbHistory.scrollTop = knowledgeHistoryShouldStickToBottom
      ? els.kbHistory.scrollHeight
      : knowledgeHistoryScrollTop;
  });
}

function countDistinctKnowledgeDocs(items) {
  const paths = new Set();
  for (const item of items || []) {
    if (item.source === "web") continue;
    const key = `${item.libraryId || ""}/${String(item.path || item.title || "").trim()}`;
    if (key !== "/") paths.add(key);
  }
  return paths.size;
}

function renderReferencesSummary(results) {
  const items = results || [];
  const localCount = items.filter((item) => item.source !== "web").length;
  const webCount = items.filter((item) => item.source === "web").length;
  const docCount = countDistinctKnowledgeDocs(items);
  if (!items.length) return "参考文献 · 0 条";
  if (!webCount) {
    return docCount && docCount < localCount
      ? `参考文献 · ${localCount} 段 · 覆盖 ${docCount} 篇`
      : `参考文献 · ${localCount} 段${docCount ? ` · ${docCount} 篇` : ""}`;
  }
  if (!localCount) return `参考文献 · 联网 ${webCount} 条`;
  const docPart = docCount ? ` · 本地覆盖 ${docCount} 篇` : "";
  return `参考文献 · ${items.length} 条（本地 ${localCount} · 联网 ${webCount}${docPart}）`;
}

function renderKnowledgeHistoryTurn(turn, turnIndex) {
  const summary = turn.summary || buildTurnSummary(turn);
  const collapsed = turn.collapsed === true;
  const toggleLabel = collapsed ? "展开" : "折叠";
  const results = (turn.results || []).filter((item) => !isClientLowValueWebResult(item));
  const referencesBlock = results.length
    ? `
      <details class="knowledgeReferences"${turn.referencesOpen ? " open" : ""}>
        <summary>${escapeHtml(renderReferencesSummary(results))}</summary>
        <div class="knowledgeHistoryResults">${renderKnowledgeResultItems(results)}</div>
      </details>
    `
    : "";
  return `
    <article class="knowledgeHistoryTurn${collapsed ? " is-collapsed" : ""}" data-turn-id="${attr(turn.id)}">
      <header>
        <div class="knowledgeHistoryTurnTitle">
          <strong>第 ${turnIndex + 1} 轮 · ${turn.kind === "ask" ? "问答" : "检索"}</strong>
          <div class="knowledgeTurnSummary">${escapeHtml(summary)}</div>
          <div class="knowledgeHistoryTurnMeta">${escapeHtml(new Date(turn.createdAt || Date.now()).toLocaleString())}${turn.includeWeb ? " · 联网" : ""}</div>
        </div>
        <div class="knowledgeHistoryTurnActions">
          <button type="button" data-kb-toggle-turn title="${collapsed ? "展开本轮内容" : "折叠后只显示摘要"}">${toggleLabel}</button>
          <button type="button" class="danger" data-kb-delete-turn title="删除本轮">删除</button>
        </div>
      </header>
      <div class="knowledgeHistoryBody">
        <div class="knowledgeHistoryQuery">${escapeHtml(turn.query)}</div>
        ${turn.executedQuery && turn.executedQuery !== turn.query ? `<div class="knowledgeHistoryExecutedQuery">检索词：${escapeHtml(turn.executedQuery)}${turn.rewriteSource === "llm" ? " · 大模型提取" : turn.rewriteSource ? ` · ${escapeHtml(turn.rewriteSource)}` : ""}</div>` : ""}
        ${turn.answer ? `<div class="knowledgeHistoryAnswer knowledgeAnswerMarkdown">${renderMarkdownLite(turn.answer)}</div>` : ""}
        ${referencesBlock}
      </div>
    </article>
  `;
}

function wireKnowledgeHistoryPanel() {
  if (!els.kbHistory || els.kbHistory.dataset.wired === "1") return;
  els.kbHistory.dataset.wired = "1";
  els.kbHistory.addEventListener("scroll", () => captureKnowledgeHistoryScroll());
  els.kbHistory.addEventListener("toggle", (event) => {
    const details = event.target.closest("details.knowledgeReferences");
    if (!details) return;
    const turnId = details.closest("[data-turn-id]")?.getAttribute("data-turn-id");
    const turn = knowledgeHistory.find((item) => item.id === turnId);
    if (!turn) return;
    turn.referencesOpen = details.open;
    knowledgeHistoryShouldStickToBottom = false;
    persistKnowledgeHistory();
  }, true);
  els.kbHistory.addEventListener("click", (event) => {
    const toggleBtn = event.target.closest("[data-kb-toggle-turn]");
    if (toggleBtn) {
      const turnId = toggleBtn.closest("[data-turn-id]")?.getAttribute("data-turn-id");
      if (turnId) toggleKnowledgeTurnCollapsed(turnId);
      return;
    }
    const deleteBtn = event.target.closest("[data-kb-delete-turn]");
    if (deleteBtn) {
      const turnId = deleteBtn.closest("[data-turn-id]")?.getAttribute("data-turn-id");
      if (turnId) deleteKnowledgeTurn(turnId);
    }
  });
}

async function clearKnowledgeHistory() {
  knowledgeHistory = [];
  try {
    localStorage.removeItem(KB_HISTORY_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
  try {
    await fetch("/api/knowledge/history", { method: "DELETE" });
  } catch {
    // ignore network errors
  }
  renderKnowledgePanel();
}

function renderKnowledgeResultItems(results) {
  return (results || []).map((item, index) => `
    <article class="knowledgeResult ${item.source === "web" ? "web" : ""}">
      <header>
        <strong>[${index + 1}] ${item.libraryLabel ? `[${escapeHtml(item.libraryLabel)}] ` : ""}${escapeHtml(item.title || item.path)}</strong>
        <span>${Number(item.score || 0).toFixed(3)}</span>
      </header>
      <small>${escapeHtml(item.source || "knowledge")} · ${escapeHtml(item.url || item.path || "")}</small>
      <div class="knowledgeResultBody">${renderMarkdownLite(String(item.content || "").slice(0, KB_PREVIEW_CHARS))}</div>
    </article>
  `).join("");
}

function buildKnowledgeContextFromHistory({ maxChars = KB_CONTEXT_MAX_CHARS } = {}) {
  const blocks = [];
  let used = 0;
  for (let turnIndex = 0; turnIndex < knowledgeHistory.length; turnIndex += 1) {
    const turn = knowledgeHistory[turnIndex];
    const turnHeader = `## 第${turnIndex + 1}轮 ${turn.kind === "ask" ? "问答" : "检索"}：${turn.query}`;
    if (used + turnHeader.length > maxChars) break;
    blocks.push(turnHeader);
    used += turnHeader.length + 5;
    for (let index = 0; index < (turn.results || []).length; index += 1) {
      const item = turn.results[index];
      const header = `[${index + 1}] ${item.libraryLabel ? `[${item.libraryLabel}] ` : ""}${item.title || item.path} (${item.source || "knowledge"}: ${item.url || item.path}, score=${Number(item.score || 0).toFixed(3)})`;
      const remaining = maxChars - used - header.length - 1;
      if (remaining <= 120) return blocks.join("\n\n---\n\n");
      const content = String(item.content || "").slice(0, Math.min(KB_CONTEXT_SNIPPET_CHARS, remaining));
      const block = `${header}\n${content}`;
      blocks.push(block);
      used += block.length + 5;
      if (used >= maxChars) return blocks.join("\n\n---\n\n");
    }
  }
  return blocks.join("\n\n---\n\n");
}

function buildKnowledgeRetrievalHint(currentQuery) {
  const parts = [];
  for (const turn of knowledgeHistory.slice(-6)) {
    if (turn.query) parts.push(`${turn.kind === "ask" ? "上一轮问" : "上一轮检索"}：${turn.query}`);
    if (turn.executedQuery && turn.executedQuery !== turn.query) {
      parts.push(`实际检索词：${turn.executedQuery}`);
    }
    if (turn.answer) parts.push(`上一轮答：${String(turn.answer).slice(0, 400)}`);
  }
  if (currentQuery) parts.push(`本轮问题：${currentQuery}`);
  const nodeMd = currentNodeMarkdownForKnowledge();
  if (nodeMd) parts.push(`当前节点：\n${nodeMd}`);
  return parts.filter(Boolean).join("\n\n");
}

function renderKnowledgePanel() {
  if (!els.knowledgeState) return;
  const config = knowledgeConfig || {};
  const embedding = config.embedding || {};
  if (els.kbRetrievalStatus) {
    els.kbRetrievalStatus.textContent = knowledgeRetrievalStatus || "";
  }
  if (els.kbRetrievalSaveBtn) {
    els.kbRetrievalSaveBtn.disabled = knowledgeLoading;
  }
  if (els.kbUseWebSearch) els.kbUseWebSearch.checked = Boolean(webSearchConfig?.enabled && webSearchConfig?.provider);
  const total = knowledgeIndex?.totalChunks || 0;
  const webKeyState = !webSearchConfig?.provider
    ? "关闭"
    : webSearchConfig.requiresApiKey === false
      ? "不需要 key"
      : webSearchConfig.hasApiKey
        ? "key 已配置"
        : "缺少 key";
  const webDaemonState = webSearchConfig?.provider === "openwebsearch"
    ? openWebSearchStatus?.reachable
      ? "daemon 已就绪"
      : openWebSearchStatus?.built === false
        ? "daemon 未 build"
        : "daemon 未启动（检索时会自动拉起）"
    : "";
  els.knowledgeState.textContent = knowledgeLoading ? "处理中..." : knowledgeError ? "出错" : `${total} chunks`;
  syncPaneSummaryBar();
  if (els.kbEnvInfo) {
    const libraries = config.libraries || knowledgeIndex?.libraries || [];
    const libraryRoot = config.libraryRoot || config.docsDir || "knowledge";
    const scopeLabel = config.searchAllLibraries ? "全部库" : (libraries.find((item) => item.id === config.activeLibraryId)?.label || config.activeLibraryId || "当前库");
    els.kbEnvInfo.textContent = [
      `知识库根目录: ${libraryRoot}（${libraries.length} 个子文件夹库）`,
      `当前检索范围: ${scopeLabel}`,
      `索引分块: ${config.chunk?.maxChars || 1600} 字/块 · 重叠 ${config.chunk?.overlapChars ?? 200} 字`,
      `检索送入模型: top ${KB_TOP_K} 片段 × ${KB_CONTEXT_SNIPPET_CHARS} 字（总预算 ${KB_CONTEXT_MAX_CHARS} 字）`,
      `检索多样性: 每篇最多 ${config.retrieval?.maxChunksPerDoc ?? 1} 段 · 候选池 ×${config.retrieval?.candidatePoolMultiplier ?? 10}${config.retrieval?.diversify === false ? " · 已关闭" : ""} · 可在下方滑轨调整`,
      `Embedding: ${embedding.model || "未配置"} · ${embedding.hasApiKey ? "key 已配置" : "缺少 key"}`,
      `问答模型: ${config.chat?.modelId || "未配置"}`,
      `联网搜索: ${webSearchConfig?.provider || "关闭"} · ${webKeyState}${webDaemonState ? ` · ${webDaemonState}` : ""}`,
      total ? "" : "本地索引: 空 · 点「重建当前库」或「重建全部库」",
      "配置来源: .env + knowledge-config.json"
    ].filter(Boolean).join("\n");
  }
  if (els.kbIndexInfo) {
    const job = knowledgeReindexJob || knowledgeConfig?.reindex;
    const progress = job?.running || job?.stage === "done" || job?.stage === "error"
      ? `
        <div class="knowledgeProgress">
          <div class="knowledgeProgressTrack"><span style="width:${Math.max(0, Math.min(100, Number(job.percent) || 0))}%"></span></div>
          <div>${escapeHtml(job.error || job.message || job.stage || "")}${job.running ? ` · ${job.percent || 0}%` : ""}${job.libraryLabel ? ` · ${escapeHtml(job.libraryLabel)}` : ""}</div>
        </div>
      `
      : "";
    const librarySummary = (config.libraries || []).map((item) => `${item.label}: ${item.totalChunks || 0}`).join(" · ");
    els.kbIndexInfo.innerHTML = knowledgeError
      ? escapeHtml(knowledgeError)
      : `${escapeHtml(`索引：合计 ${total} 段${librarySummary ? `（${librarySummary}）` : ""} · ${knowledgeIndex?.embeddingModel || "未建立"}`)}${progress}`;
  }
  if (els.kbHistorySummary) {
    const resultCount = knowledgeHistory.reduce((sum, turn) => sum + (turn.results?.length || 0), 0);
    els.kbHistorySummary.textContent = knowledgeHistory.length
      ? `${knowledgeHistory.length} 轮 · ${resultCount} 条片段 · 已保存到 knowledge-chat-history.json`
      : "尚无检索历史；检索或问模型后会在这里累积并写入项目文件。";
  }
  if (els.kbHistory) {
    captureKnowledgeHistoryScroll();
    els.kbHistory.innerHTML = knowledgeHistory.length
      ? knowledgeHistory.map((turn, turnIndex) => renderKnowledgeHistoryTurn(turn, turnIndex)).join("")
      : `<div class="knowledgeHistoryEmpty">在下方列表中滚动查看每轮完整输出。折叠后只显示约 30 字摘要。</div>`;
    restoreKnowledgeHistoryScroll();
  }
}

async function reindexKnowledge({ all = false } = {}) {
  knowledgeLoading = true;
  knowledgeError = "";
  renderKnowledgePanel();
  try {
    const response = await fetch("/api/knowledge/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        all,
        libraryId: els.kbLibrarySelect?.value || knowledgeConfig?.activeLibraryId || ""
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "重建索引失败");
    knowledgeReindexJob = data.job || null;
    await pollKnowledgeReindex();
  } catch (error) {
    knowledgeError = formatApiFetchError(error, null, "重建知识库索引");
  } finally {
    knowledgeLoading = false;
    renderKnowledgePanel();
  }
}

async function pollKnowledgeReindex() {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const response = await fetch("/api/knowledge/reindex-status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取索引进度失败");
    knowledgeReindexJob = data.job || null;
    renderKnowledgePanel();
    if (!knowledgeReindexJob?.running) {
      if (knowledgeReindexJob?.error) throw new Error(knowledgeReindexJob.error);
      await loadKnowledgeConfig();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  throw new Error("索引仍在运行，请稍后查看进度。");
}

function currentNodeMarkdownForKnowledge() {
  const nodeId = nextFocusId || currentFocusId;
  if (!nodeId) return "";
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return "";
  return [
    `- Problem: ${node.problem || ""}`,
    `- Approach: ${node.approach || ""}`,
    `- Metrics: ${node.metrics || ""}`,
    `- NextIdea: ${node.nextIdea || ""}`
  ].join("\n");
}

async function searchKnowledgeFromPanel() {
  const query = els.kbQuestion?.value.trim() || "";
  if (!query) {
    knowledgeError = "需要先输入问题。";
    renderKnowledgePanel();
    return null;
  }
  knowledgeLoading = true;
  knowledgeError = "";
  renderKnowledgePanel();
  try {
    const retrievalHint = buildKnowledgeRetrievalHint(query);
    const response = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        topK: KB_TOP_K,
        webTopK: KB_WEB_TOP_K,
        includeWeb: els.kbUseWebSearch?.checked === true,
        contextHint: retrievalHint,
        nodeMarkdown: currentNodeMarkdownForKnowledge(),
        ...knowledgeRetrievalScope()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "检索失败");
    appendKnowledgeTurn({
      kind: "search",
      query,
      executedQuery: data.executedQuery || data.webQuery || data.refinedQuery || query,
      rewriteSource: data.rewriteSource || "",
      includeWeb: els.kbUseWebSearch?.checked === true,
      results: Array.isArray(data.results) ? data.results : []
    });
    knowledgeIndex = data.index || knowledgeIndex;
    return data;
  } catch (error) {
    knowledgeError = formatApiFetchError(error, null, "知识库检索");
    return null;
  } finally {
    knowledgeLoading = false;
    renderKnowledgePanel();
  }
}

async function askKnowledgeFromPanel() {
  const question = els.kbQuestion?.value.trim() || "";
  if (!question) {
    knowledgeError = "需要先输入问题。";
    renderKnowledgePanel();
    return;
  }
  knowledgeLoading = true;
  knowledgeError = "";
  renderKnowledgePanel();
  const priorRetrievalContext = buildKnowledgeContextFromHistory();
  const priorAskHistory = knowledgeHistory
    .filter((turn) => turn.kind === "ask" && turn.query)
    .slice(-8)
    .map((turn) => ({ question: turn.query, answer: turn.answer || "" }));
  try {
    const retrievalHint = buildKnowledgeRetrievalHint(question);
    const response = await fetch("/api/knowledge/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        topK: KB_TOP_K,
        webTopK: KB_WEB_TOP_K,
        includeWeb: els.kbUseWebSearch?.checked === true,
        contextHint: retrievalHint,
        nodeMarkdown: currentNodeMarkdownForKnowledge(),
        priorRetrievalContext,
        history: priorAskHistory,
        ...knowledgeRetrievalScope()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "知识库问答失败");
    appendKnowledgeTurn({
      kind: "ask",
      query: question,
      executedQuery: data.executedQuery || data.webQuery || data.refinedQuery || question,
      rewriteSource: data.rewriteSource || "",
      answer: data.answer || "",
      includeWeb: els.kbUseWebSearch?.checked === true,
      results: Array.isArray(data.results) ? data.results : []
    });
  } catch (error) {
    knowledgeError = formatApiFetchError(error, null, "知识库问答");
  } finally {
    knowledgeLoading = false;
    renderKnowledgePanel();
  }
}

function currentKnowledgeContextForModels() {
  if (!els.kbUseForModels?.checked || !knowledgeHistory.length) return "";
  return buildKnowledgeContextFromHistory();
}

async function pollTreeChanges() {
  if (dirty || saveInFlight || saveTimer || modelPanelLoading) return;
  if (workspaceMode === "subtree" && activeSubtreePath) {
    const response = await fetch(`/api/subtree-file?path=${encodeURIComponent(activeSubtreePath)}&t=${Date.now()}`);
    if (!response.ok) return;
    const data = await response.json();
    if (data.markdown === lastLoadedMarkdown || data.markdown === lastSavedMarkdown) return;
    loadFromMarkdown(data.markdown, { skipUserGraphStateLock: true, skipRestoreSave: true, markSaved: true, preserveLens: true });
    setSaveState("已从子树文件刷新");
    await loadVersions();
    return;
  }
  const response = await fetch(treeApiUrl("/api/tree", { t: Date.now() }));
  if (!response.ok) return;
  const data = await response.json();
  if (data.markdown === lastLoadedMarkdown || data.markdown === lastSavedMarkdown) return;
  loadFromMarkdown(data.markdown, { skipUserGraphStateLock: !isViewingActiveMethodTree(), preserveLens: true });
  writeCurrentVersionSnapshot(data.markdown).catch(() => {});
  setSaveState("已从 Markdown 刷新");
  await loadVersions();
}

async function saveTree() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  saveInFlight = true;
  setSaveState("保存中...");
  try {
    const markdown = toMarkdown(nodes, edges);
    const reason = pendingSaveReason || (workspaceMode === "subtree" ? "将自动保存子树修改" : "将自动保存图谱修改");
    pendingSaveReason = "";
    let data = {};
    if (workspaceMode === "subtree" && activeSubtreePath) {
      const response = await fetch("/api/subtree-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: activeSubtreePath, markdown, reason, backup: false })
      });
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || `保存失败 (HTTP ${response.status})`);
    } else {
      const response = await fetch(treeApiUrl("/api/tree"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, reason, backup: false, source: "ui", treeId: viewTreeId })
      });
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || `保存失败 (HTTP ${response.status})`);
    }
    lastSavedMarkdown = markdown;
    lastLoadedMarkdown = markdown;
    dirty = false;
    setSaveState(data.flowSync?.changed ? `已保存 · 自动同步 ${data.flowSync.changed} 个 flow 状态` : "已保存");
    await loadVersions();
    if (isViewingActiveMethodTree()) loadMaintenanceStatus().catch(() => {});
  } catch (error) {
    dirty = true;
    setSaveState(`保存失败: ${error.message}`);
    throw error;
  } finally {
    saveInFlight = false;
  }
  if (saveAgain) {
    saveAgain = false;
    scheduleSave(80);
  }
}

async function loadVersions() {
  if (!els.versionList) return;
  try {
    const url = workspaceMode === "subtree" && activeSubtreePath
      ? `/api/subtree-file/versions?path=${encodeURIComponent(activeSubtreePath)}&t=${Date.now()}`
      : treeApiUrl("/api/versions", { t: Date.now() });
    const response = await fetch(url);
    if (!response.ok) throw new Error("Version list failed");
    const data = await response.json();
    versions = Array.isArray(data.versions) ? data.versions : [];
    renderVersions();
    if (els.versionState) {
      els.versionState.textContent = workspaceMode === "subtree"
        ? `${versions.length} 个子树版本`
        : `${versions.length} 个版本`;
    }
  } catch (error) {
    if (els.versionState) els.versionState.textContent = "读取失败";
    syncPaneSummaryBar();
  }
}

async function restoreVersion(name) {
  if (!name) return;
  setSaveState("回退中...");
  try {
    const inSubtree = workspaceMode === "subtree" && activeSubtreePath;
    const response = inSubtree
      ? await fetch("/api/subtree-file/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: activeSubtreePath, name })
        })
      : await fetch("/api/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            currentMarkdown: toMarkdown(nodes, edges),
            treeId: viewTreeId
          })
        });
    if (!response.ok) throw new Error("Restore failed");
    const data = await response.json();
    if (Array.isArray(data.versions)) versions = data.versions;
    loadFromMarkdown(data.markdown, {
      fitView: true,
      skipUserGraphStateLock: inSubtree || !isViewingActiveMethodTree(),
      skipRestoreSave: inSubtree,
      markSaved: inSubtree
    });
    lastSavedMarkdown = data.markdown;
    lastLoadedMarkdown = data.markdown;
    dirty = false;
    renderVersions();
    setSaveState(name === "_current.md" ? "已恢复当前版本" : "已回退");
    if (els.versionState) {
      els.versionState.textContent = inSubtree
        ? `${versions.length} 个子树版本`
        : `${versions.length} 个版本`;
    }
  } catch (error) {
    setSaveState(`回退失败: ${error.message}`);
  }
}

function getNodeCenter(node) {
  return {
    x: (node.x || 0) + nodeWidth(node) / 2,
    y: (node.y || 0) + nodeHeight(node) / 2
  };
}

function getDirectNeighbors(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const center = getNodeCenter(node);
  const byNeighbor = new Map();

  for (const edge of edges) {
    if (!edge.endpoints.includes(nodeId)) continue;
    for (const endpoint of edge.endpoints) {
      if (endpoint === nodeId) continue;
      const neighbor = nodes.find((item) => item.id === endpoint);
      if (!neighbor) continue;
      const neighborCenter = getNodeCenter(neighbor);
      const angle = Math.atan2(neighborCenter.y - center.y, neighborCenter.x - center.x);
      const distance = Math.hypot(neighborCenter.x - center.x, neighborCenter.y - center.y);
      const edgeLabel = String(edge.label || "").trim();
      const existing = byNeighbor.get(endpoint);
      if (!existing) {
        byNeighbor.set(endpoint, {
          neighborId: endpoint,
          title: neighbor.title || endpoint,
          angle,
          distance,
          edgeLabels: edgeLabel ? [edgeLabel] : []
        });
        continue;
      }
      if (edgeLabel && !existing.edgeLabels.includes(edgeLabel)) existing.edgeLabels.push(edgeLabel);
      if (distance < existing.distance) {
        existing.angle = angle;
        existing.distance = distance;
      }
    }
  }

  return [...byNeighbor.values()].sort((a, b) => a.angle - b.angle);
}

function neighborBorderPoint(width, height, angle) {
  const halfW = width / 2;
  const halfH = height / 2;
  const absCos = Math.abs(Math.cos(angle));
  const absSin = Math.abs(Math.sin(angle));
  const tx = absCos > 1e-6 ? halfW / absCos : Infinity;
  const ty = absSin > 1e-6 ? halfH / absSin : Infinity;
  const t = Math.min(tx, ty);
  return {
    x: halfW + Math.cos(angle) * t,
    y: halfH + Math.sin(angle) * t
  };
}

function getNeighborHintOffset(sourceId, neighborId) {
  return neighborHintOffsets[sourceId]?.[neighborId] || { dx: 0, dy: 0 };
}

function setNeighborHintOffset(sourceId, neighborId, dx, dy) {
  if (!neighborHintOffsets[sourceId]) neighborHintOffsets[sourceId] = {};
  neighborHintOffsets[sourceId][neighborId] = { dx, dy };
}

function applyEdgeDimOpacity() {
  document.documentElement.style.setProperty("--edge-dim-opacity", String(edgeDimOpacity));
}

function initEdgeDimOpacityControl() {
  try {
    const saved = Number(localStorage.getItem("taskTree.edgeDimOpacity"));
    if (Number.isFinite(saved) && saved >= 0.1 && saved <= 0.9) {
      edgeDimOpacity = saved;
    }
  } catch {
    // ignore storage errors
  }
  applyEdgeDimOpacity();
  if (!els.edgeDimOpacityInput) return;
  els.edgeDimOpacityInput.value = String(Math.round(edgeDimOpacity * 100));
  els.edgeDimOpacityInput.addEventListener("input", () => {
    edgeDimOpacity = Math.max(0.1, Math.min(0.9, Number(els.edgeDimOpacityInput.value) / 100));
    applyEdgeDimOpacity();
    try {
      localStorage.setItem("taskTree.edgeDimOpacity", String(edgeDimOpacity));
    } catch {
      // ignore storage errors
    }
  });
}

function renderNeighborGuides() {
  for (const layer of els.nodesLayer.querySelectorAll(".neighborGuideLayer")) {
    layer.remove();
  }
  for (const nodeId of neighborGuideVisibleIds) {
    renderNeighborGuideForNode(nodeId);
  }
}

function renderNeighborGuideForNode(sourceId) {
  const node = nodes.find((item) => item.id === sourceId);
  if (!node) return;

  const neighbors = getDirectNeighbors(sourceId);
  if (!neighbors.length) return;

  const width = nodeWidth(node);
  const height = nodeHeight(node);
  const pad = 160;
  const rayLength = 58;
  const layer = document.createElement("div");
  layer.className = "neighborGuideLayer";
  layer.style.left = `${(node.x || 0) - pad}px`;
  layer.style.top = `${(node.y || 0) - pad}px`;
  layer.style.width = `${width + pad * 2}px`;
  layer.style.height = `${height + pad * 2}px`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "neighborGuideSvg");
  svg.setAttribute("width", String(width + pad * 2));
  svg.setAttribute("height", String(height + pad * 2));
  svg.setAttribute("viewBox", `0 0 ${width + pad * 2} ${height + pad * 2}`);
  layer.appendChild(svg);

  for (const neighbor of neighbors) {
    const border = neighborBorderPoint(width, height, neighbor.angle);
    const startX = pad + border.x;
    const startY = pad + border.y;
    const offset = getNeighborHintOffset(sourceId, neighbor.neighborId);
    const endX = startX + Math.cos(neighbor.angle) * rayLength + offset.dx;
    const endY = startY + Math.sin(neighbor.angle) * rayLength + offset.dy;
    const relation = neighbor.edgeLabels.length ? neighbor.edgeLabels.join(" · ") : "直接连接";
    const displayTitle = String(neighbor.title || "").trim() || "未命名节点";
    const tip = `${displayTitle}\n${relation}\n拖动标签避免遮挡；轻点跳转到该邻居`;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "neighborGuideRay");
    line.setAttribute("data-neighbor-ray", neighbor.neighborId);
    line.setAttribute("x1", String(startX));
    line.setAttribute("y1", String(startY));
    line.setAttribute("x2", String(endX));
    line.setAttribute("y2", String(endY));
    svg.appendChild(line);

    const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    head.setAttribute("class", "neighborGuideHead");
    head.setAttribute("data-neighbor-head", neighbor.neighborId);
    head.setAttribute("points", neighborArrowHeadPoints(endX, endY, neighbor.angle));
    svg.appendChild(head);

    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "neighborGuideHint";
    hint.style.left = `${endX}px`;
    hint.style.top = `${endY}px`;
    hint.title = tip;
    hint.innerHTML = `<span class="neighborGuideHintTitle">${escapeHtml(displayTitle)}</span>`;
    startNeighborHintDrag(hint, sourceId, neighbor.neighborId, startX, startY, neighbor.angle, rayLength);
    layer.appendChild(hint);
  }

  els.nodesLayer.appendChild(layer);
}

function neighborArrowHeadPoints(x, y, angle) {
  const size = 7;
  const backAngle1 = angle + Math.PI * 0.82;
  const backAngle2 = angle - Math.PI * 0.82;
  const p1x = x + Math.cos(backAngle1) * size;
  const p1y = y + Math.sin(backAngle1) * size;
  const p2x = x + Math.cos(backAngle2) * size;
  const p2y = y + Math.sin(backAngle2) * size;
  return `${x},${y} ${p1x},${p1y} ${p2x},${p2y}`;
}

function startNeighborHintDrag(hint, sourceId, neighborId, startX, startY, angle, rayLength) {
  hint.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    hint.setPointerCapture(event.pointerId);
    hint.classList.add("dragging");
    const offset = getNeighborHintOffset(sourceId, neighborId);
    const dragStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      dx: offset.dx,
      dy: offset.dy
    };
    let moved = false;
    const layer = hint.closest(".neighborGuideLayer");
    const svg = layer?.querySelector(".neighborGuideSvg");

    function updateVisual(dx, dy) {
      const endX = startX + Math.cos(angle) * rayLength + dx;
      const endY = startY + Math.sin(angle) * rayLength + dy;
      hint.style.left = `${endX}px`;
      hint.style.top = `${endY}px`;
      const line = svg?.querySelector(`line[data-neighbor-ray="${neighborId}"]`);
      if (line) {
        line.setAttribute("x2", String(endX));
        line.setAttribute("y2", String(endY));
      }
      const head = svg?.querySelector(`polygon[data-neighbor-head="${neighborId}"]`);
      if (head) head.setAttribute("points", neighborArrowHeadPoints(endX, endY, angle));
    }

    function move(moveEvent) {
      if (Math.hypot(moveEvent.clientX - dragStart.pointerX, moveEvent.clientY - dragStart.pointerY) > 4) {
        moved = true;
      }
      const dx = dragStart.dx + (moveEvent.clientX - dragStart.pointerX) / graphView.scale;
      const dy = dragStart.dy + (moveEvent.clientY - dragStart.pointerY) / graphView.scale;
      setNeighborHintOffset(sourceId, neighborId, dx, dy);
      updateVisual(dx, dy);
    }

    function up() {
      hint.classList.remove("dragging");
      hint.removeEventListener("pointermove", move);
      hint.removeEventListener("pointerup", up);
      hint.removeEventListener("pointercancel", up);
      if (!moved) focusNeighborInView(neighborId);
    }

    hint.addEventListener("pointermove", move);
    hint.addEventListener("pointerup", up);
    hint.addEventListener("pointercancel", up);
  });
}

function focusNeighborInView(neighborId) {
  focusNodeInView(neighborId);
}

function focusNodeInView(nodeId) {
  if (!nodes.some((item) => item.id === nodeId)) return;
  selectedId = nodeId;
  ioPreviewNodeId = nodeId;
  shouldAutoFitView = false;
  // Render first because layout repair can change a node's position or height.
  // Centering against the pre-render geometry leaves the restored node off-screen.
  renderTree();
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  // Browser focus/scroll helpers can change the hidden viewport's native scroll position.
  // The graph camera uses transforms exclusively, so normalize native scrolling first.
  els.graphViewport.scrollLeft = 0;
  els.graphViewport.scrollTop = 0;
  const rect = els.graphViewport.getBoundingClientRect();
  const targetX = (node.x || 0) + nodeWidth(node) / 2;
  const targetY = (node.y || 0) + displayNodeHeight(node) / 2;
  graphView.x = rect.width * 0.5 - els.graphCanvas.offsetLeft - targetX * graphView.scale;
  graphView.y = rect.height * 0.45 - els.graphCanvas.offsetTop - targetY * graphView.scale;
  applyGraphTransform();
}

function getNodePort(id) {
  const node = nodes.find((item) => item.id === id);
  if (!node) return null;
  return { x: (node.x || 0) + nodeWidth(node) / 2, y: (node.y || 0) + 48 };
}

function edgeBaseHub(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function edgeHub(points, edge) {
  const base = edgeBaseHub(points);
  return {
    x: base.x + (Number.isFinite(edge.offsetX) ? edge.offsetX : 0),
    y: base.y + (Number.isFinite(edge.offsetY) ? edge.offsetY : 0)
  };
}

function graphPoint(clientX, clientY) {
  const rect = els.graphViewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - graphView.x) / graphView.scale,
    y: (clientY - rect.top - graphView.y) / graphView.scale
  };
}

function normalizeEdges(nextEdges, nextNodes) {
  const ids = new Set(nextNodes.map((node) => node.id));
  return nextEdges
    .map((edge) => ({ ...edge, endpoints: unique(edge.endpoints).filter((id) => ids.has(id)) }))
    .filter((edge) => edge.endpoints.length >= 2);
}

function migrateLegacyEdgeLabelPosition(edge, points) {
  if (!hasEdgeLabelPosition(edge)) return;
  const base = edgeBaseHub(points);
  edge.offsetX = edge.labelX - (base.x + 10);
  edge.offsetY = edge.labelY - (base.y - 28);
  edge.labelX = null;
  edge.labelY = null;
}

function parseEndpointList(value) {
  return unique(String(value || "").split(/[,\s]+/).map((item) => sanitizeId(item)).filter(Boolean));
}

function nextNodeId() {
  let index = nodes.length + 1;
  while (nodes.some((node) => node.id === `N${index}`)) index += 1;
  return `N${index}`;
}

function nextEdgeId(nextEdges = edges) {
  let index = nextEdges.length + 1;
  while (nextEdges.some((edge) => edge.id === `E${index}`)) index += 1;
  return `E${index}`;
}

function markDirty(reason = "将自动保存图谱修改") {
  dirty = true;
  if (!pendingSaveReason || pendingSaveReason === "将自动保存图谱修改") {
    pendingSaveReason = reason;
  }
  setSaveState("待保存");
  scheduleCurrentVersionSnapshot();
  scheduleSave();
}

function scheduleSave(delay = 450) {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTree().catch((error) => {
      dirty = true;
      setSaveState(`保存失败: ${error.message}`);
    });
  }, delay);
}

function setSaveState(text) {
  els.saveState.textContent = text;
}

function sanitizeId(value) {
  return String(value || "").trim().replace(/\s+/g, "_").replace(/[^\w-]/g, "");
}

function hasPosition(node) {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

function ensureNodeSize(node) {
  if (!Number.isFinite(node.width)) node.width = card.width;
  if (!Number.isFinite(node.height)) node.height = card.height;
}

let measureNodeContentHeightFn = null;
let graphExportSession = false;

async function loadGraphExportModule() {
  return import(moduleUrl("/graph-export.js"));
}

async function getMeasureNodeContentHeight() {
  if (!measureNodeContentHeightFn) {
    const mod = await loadGraphExportModule();
    measureNodeContentHeightFn = mod.measureNodeContentHeight;
  }
  return measureNodeContentHeightFn;
}

function displayNodeHeight(node) {
  const saved = nodeHeight(node);
  if (graphExportSession) return saved;
  if (usesContentSizedCard(node)) return saved;
  if (nodeCardCompact && node.id !== editNodeId) {
    const focus = node.id === nextFocusId || node.id === currentFocusId;
    const detailsOpen = nodeDetailsOpenIds.has(node.id);
    if (detailsOpen && measureNodeContentHeightFn) {
      try {
        const measureNode = node.id === nextFocusId ? { ...node, nextPlan } : node;
        const contentMin = measureNodeContentHeightFn(measureNode, nodeWidth(node), isNodeFolded(node), {
          includeNextPlan: focus
        });
        return Math.max(card.compactMinHeight, Math.min(saved, contentMin));
      } catch {
        // fall through to compact estimate
      }
    }
    const estimate = isNodeFolded(node)
      ? focus ? card.compactFocusMaxHeight : card.compactMaxHeight
      : focus
        ? card.compactFocusMaxHeight
        : card.compactMaxHeight;
    return Math.max(card.compactMinHeight, Math.min(saved, estimate));
  }
  if (!measureNodeContentHeightFn) return saved;
  try {
    const measureNode = node.id === nextFocusId ? { ...node, nextPlan } : node;
    const contentMin = measureNodeContentHeightFn(measureNode, nodeWidth(node), isNodeFolded(node), {
      includeNextPlan: node.id === nextFocusId || node.id === currentFocusId
    });
    return Math.max(saved, contentMin);
  } catch {
    return saved;
  }
}

getMeasureNodeContentHeight().then(() => renderTree()).catch(() => {});

function hasSize(node) {
  return Number.isFinite(node.width) && Number.isFinite(node.height);
}

function usesContentSizedCard(node) {
  return Boolean(nodeCardCompact && !graphExportSession && node?.id !== editNodeId);
}

function cardTextUnits(value) {
  let units = 0;
  for (const char of String(value || "")) {
    if (/\s/.test(char)) units += 0.35;
    else if (char.codePointAt(0) <= 0x00ff) units += 0.58;
    else units += 1;
  }
  return units;
}

function compactNodeAutoWidth(node) {
  const titleUnits = cardTextUnits(node.title || node.id);
  const fields = [
    clipCardText(node.problem, 150),
    clipCardText(node.approach, 180),
    clipCardText(node.currentResult, 180)
  ];
  const fieldUnits = fields.map(cardTextUnits);
  const longest = Math.max(0, ...fieldUnits);
  const total = fieldUnits.reduce((sum, value) => sum + value, 0);
  let width = card.compactMinWidth;
  if (titleUnits > 12 || longest > 34 || total > 85) width = 380;
  if (titleUnits > 18 || longest > 64 || total > 160) width = 420;
  if (longest > 105 || total > 260) width = 460;
  if (node.id === currentFocusId || node.id === nextFocusId) width = Math.max(width, 420);
  return clamp(Math.round(width / 20) * 20, card.compactMinWidth, card.compactMaxWidth);
}

function semanticZoomMode() {
  if (graphView.scale < 0.44) return "overview";
  if (graphView.scale < 0.72) return "macro";
  return "detail";
}

function compactNodeMeasureKey(node, width) {
  const mode = semanticZoomMode();
  const titleSize = mode === "detail" ? 15 : Math.round(clamp(16 / graphView.scale, 27, 88));
  return [
    mode,
    titleSize,
    width,
    node.title,
    node.problem,
    node.approach,
    node.currentResult,
    node.nextIdea,
    node.id === nextFocusId ? nextPlan : "",
    isNodeFolded(node) ? "folded" : "open",
    nodeDetailsOpenIds.has(node.id) ? "details" : "summary",
    node.id === currentFocusId ? "current" : "",
    node.id === nextFocusId ? "next" : ""
  ].join("\x1f");
}

function compactNodeHeightBounds(node) {
  if (semanticZoomMode() !== "detail") {
    const titleSize = clamp(16 / graphView.scale, 27, 88);
    return {
      min: Math.max(112, Math.ceil(titleSize * 1.2 + 38)),
      max: 420
    };
  }
  const focus = node.id === currentFocusId || node.id === nextFocusId;
  return {
    min: card.compactMinHeight,
    max: focus ? card.compactFocusMaxHeight : card.compactMaxHeight
  };
}

function estimateCompactNodeHeight(node, width) {
  const bounds = compactNodeHeightBounds(node);
  if (semanticZoomMode() !== "detail") {
    const titleSize = clamp(16 / graphView.scale, 27, 88);
    const available = Math.max(80, width - 44);
    const titleWidth = cardTextUnits(node.title || node.id) * titleSize * 0.94;
    const lines = Math.max(1, Math.ceil(titleWidth / available));
    return clamp(Math.ceil(38 + lines * titleSize * 1.14), bounds.min, bounds.max);
  }

  const charsPerLine = Math.max(10, Math.floor((width - 92) / 13));
  const summaryLines = [node.problem, node.approach, node.currentResult]
    .map((value) => Math.max(1, Math.min(2, Math.ceil(cardTextUnits(value || "未填写") / charsPerLine))))
    .reduce((sum, value) => sum + value, 0);
  const focus = node.id === currentFocusId || node.id === nextFocusId;
  const estimated = 178 + summaryLines * 19 + (focus ? 112 : 0) + (node.id === nextFocusId ? 72 : 0);
  return clamp(estimated, bounds.min, bounds.max);
}

function measureRenderedCompactNodes() {
  if (!nodeCardCompact || graphExportSession || !els.nodesLayer) return false;
  let changed = false;
  for (const nodeCard of els.nodesLayer.querySelectorAll(".graphNode.compactCard")) {
    const node = nodes.find((item) => item.id === nodeCard.dataset.nodeId);
    if (!node || !usesContentSizedCard(node)) continue;
    const width = nodeWidth(node);
    const key = compactNodeMeasureKey(node, width);
    const bounds = compactNodeHeightBounds(node);
    nodeCard.style.height = "auto";
    const measured = clamp(Math.ceil(nodeCard.scrollHeight + 2), bounds.min, bounds.max);
    const previous = renderedCompactNodeSizes.get(node.id);
    renderedCompactNodeSizes.set(node.id, { key, width, height: measured });
    nodeCard.style.height = `${measured}px`;
    if (!previous || previous.key !== key || previous.height !== measured || previous.width !== width) changed = true;
  }
  return changed;
}

function scheduleCompactNodeMeasure() {
  if (!nodeCardCompact || graphExportSession || compactNodeMeasureFrame) return;
  compactNodeMeasureFrame = requestAnimationFrame(() => {
    compactNodeMeasureFrame = 0;
    if (!measureRenderedCompactNodes()) return;
    updateGraphCanvasSize();
    rerenderEdges();
  });
}

function storedNodeWidth(node) {
  return Math.max(card.minWidth, Number.isFinite(node.width) ? node.width : card.width);
}

function storedNodeHeight(node) {
  return Math.max(card.minHeight, Number.isFinite(node.height) ? node.height : card.height);
}

function nodeWidth(node) {
  return usesContentSizedCard(node) ? compactNodeAutoWidth(node) : storedNodeWidth(node);
}

function nodeHeight(node) {
  if (!usesContentSizedCard(node)) return storedNodeHeight(node);
  const width = nodeWidth(node);
  const key = compactNodeMeasureKey(node, width);
  const cached = renderedCompactNodeSizes.get(node.id);
  if (cached?.key === key && cached.width === width) return cached.height;
  return estimateCompactNodeHeight(node, width);
}

function updateGraphCanvasSize() {
  const canvasWidth = Math.max(5000, ...nodes.map((node) => (node.x || 0) + nodeWidth(node) + 420));
  const canvasHeight = Math.max(3200, ...nodes.map((node) => (node.y || 0) + displayNodeHeight(node) + 360));
  els.graphCanvas.style.width = `${canvasWidth}px`;
  els.graphCanvas.style.height = `${canvasHeight}px`;
  els.edges.setAttribute("width", canvasWidth);
  els.edges.setAttribute("height", canvasHeight);
  els.edges.setAttribute("viewBox", `0 0 ${canvasWidth} ${canvasHeight}`);
  return { canvasWidth, canvasHeight };
}

function hasEdgeLabelPosition(edge) {
  return Number.isFinite(edge.labelX) && Number.isFinite(edge.labelY);
}

function hasEdgeLabelOffset(edge) {
  return Number.isFinite(edge.offsetX) && Number.isFinite(edge.offsetY) && (edge.offsetX !== 0 || edge.offsetY !== 0);
}

function getNodesBounds() {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = node.x || 0;
    const y = node.y || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + nodeWidth(node));
    maxY = Math.max(maxY, y + (graphExportSession ? nodeHeight(node) : displayNodeHeight(node)));
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function scheduleFitGraphToViewport(padding = 48) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => fitGraphToViewport(padding));
  });
}

function fitGraphToViewport(padding = 48, { minScale = 0.22 } = {}) {
  const bounds = getNodesBounds();
  if (!bounds || !els.graphViewport) return;
  const viewportW = els.graphViewport.clientWidth || 800;
  const viewportH = els.graphViewport.clientHeight || 600;
  const contentW = Math.max(bounds.width, 240);
  const contentH = Math.max(bounds.height, 180);
  const scaleX = (viewportW - padding * 2) / contentW;
  const scaleY = (viewportH - padding * 2) / contentH;
  graphView.scale = clamp(Math.min(scaleX, scaleY), minScale, 1.4);
  graphView.x = padding - bounds.minX * graphView.scale;
  graphView.y = padding - bounds.minY * graphView.scale;
  applyGraphTransform();
}

/**
 * Renders once for a screenshot: give the canvas the whole window and fit the graph into it.
 *
 * Padding is tighter than the interactive default because the capture is cropped to the viewport,
 * so every unused pixel is wasted space in the chat.
 */
async function enterSnapshotMode() {
  document.body.classList.add("snapshotMode");
  await waitNextFrame(2);
  fitGraphToViewport(28, { minScale: 0.12 });
  await waitNextFrame(2);
  document.title = "task-tree-snapshot-ready";
  window.__taskTreeSnapshotReady = true;
}

function applyGraphTransform() {
  els.graphCanvas.style.transform = `translate(${graphView.x}px, ${graphView.y}px) scale(${graphView.scale})`;
  const macro = graphView.scale < 0.72;
  const overview = graphView.scale < 0.44;
  els.graphPane?.classList.toggle("semanticZoomMacro", macro);
  els.graphPane?.classList.toggle("semanticZoomOverview", overview);
  els.graphPane?.style.setProperty("--semantic-title-size", `${clamp(16 / graphView.scale, 27, 88)}px`);
  if (els.graphPane) els.graphPane.dataset.zoomLevel = overview ? "宏观" : macro ? "结构" : "细节";
  scheduleCompactNodeMeasure();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unique(items) {
  return [...new Set(items)];
}

function parseSelectedSkills(value) {
  return new Set(String(value || "").split(/,\s*/).map((item) => item.trim()).filter(Boolean));
}

function nodeTitle(id) {
  return nodes.find((node) => node.id === id)?.title || id;
}

function isInteractive(target) {
  return Boolean(target.closest("input, textarea, select, button, .connector, .codeLocBox, .codeLocLink, details, summary, a"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineMarkdown(value) {
  const input = String(value ?? "");
  const parts = input.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g);
  return parts.map((part) => {
    if (part.startsWith("$$") && part.endsWith("$$") && part.length > 4) {
      return renderKatexExpression(part.slice(2, -2), true);
    }
    if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
      return renderKatexExpression(part.slice(1, -1), false);
    }
    return escapeHtml(part)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

function renderKatexExpression(tex, displayMode) {
  const trimmed = String(tex || "").trim();
  if (!trimmed) return "";
  const katexLib = globalThis.katex;
  if (!katexLib?.renderToString) {
    const wrap = displayMode ? "$$" : "$";
    return `<span class="mathFallback">${escapeHtml(`${wrap}${trimmed}${wrap}`)}</span>`;
  }
  try {
    return katexLib.renderToString(trimmed, {
      displayMode,
      throwOnError: false,
      strict: "ignore"
    });
  } catch {
    return `<span class="mathFallback">${escapeHtml(trimmed)}</span>`;
  }
}

function isMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  return trimmed.includes("|") && /^\|?.+\|.+$/.test(trimmed);
}

function isMarkdownTableSeparator(line) {
  const trimmed = String(line || "").trim();
  return trimmed.includes("|") && trimmed.includes("-") && /^\|?[\s:|-]+\|[\s|:-]+$/.test(trimmed);
}

function splitMarkdownTableRow(line) {
  return String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderMarkdownTableBlock(tableLines) {
  if (!tableLines.length) return "";
  const headerCells = splitMarkdownTableRow(tableLines[0]);
  let bodyLines = tableLines.slice(1);
  if (bodyLines[0] && isMarkdownTableSeparator(bodyLines[0])) bodyLines = bodyLines.slice(1);
  const head = `<thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const body = bodyLines.map((row) => {
    const cells = splitMarkdownTableRow(row);
    return `<tr>${cells.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`;
  }).join("");
  return `<table class="mdTable">${head}<tbody>${body}</tbody></table>`;
}

function renderMarkdownLite(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let listOpen = false;
  let orderedOpen = false;
  let codeOpen = false;
  let index = 0;
  function closeList() {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  }
  function closeOrderedList() {
    if (!orderedOpen) return;
    html.push("</ol>");
    orderedOpen = false;
  }
  function closeAllLists() {
    closeList();
    closeOrderedList();
  }
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      closeAllLists();
      html.push(codeOpen ? "</code></pre>" : "<pre><code>");
      codeOpen = !codeOpen;
      index += 1;
      continue;
    }
    if (codeOpen) {
      html.push(`${escapeHtml(line)}\n`);
      index += 1;
      continue;
    }
    if (isMarkdownTableRow(line)) {
      const tableLines = [];
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      closeAllLists();
      if (tableLines.length >= 2) {
        html.push(renderMarkdownTableBlock(tableLines));
      } else if (tableLines[0]) {
        html.push(`<p>${renderInlineMarkdown(tableLines[0])}</p>`);
      }
      continue;
    }
    if (!line.trim()) {
      closeAllLists();
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeAllLists();
      const level = Math.min(6, heading[1].length + 3);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      closeOrderedList();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      index += 1;
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      closeList();
      if (!orderedOpen) {
        html.push("<ol>");
        orderedOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      index += 1;
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeAllLists();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      index += 1;
      continue;
    }
    closeAllLists();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    index += 1;
  }
  closeAllLists();
  if (codeOpen) html.push("</code></pre>");
  return html.join("");
}

function clampLeftPaneWidth(value) {
  const maxByViewport = Math.max(LEFT_PANE_MIN_WIDTH, Math.floor(window.innerWidth * 0.62));
  return clamp(value, LEFT_PANE_MIN_WIDTH, Math.min(LEFT_PANE_MAX_WIDTH, maxByViewport));
}

function readStoredLeftPaneWidth() {
  try {
    const raw = Number(localStorage.getItem(LEFT_PANE_WIDTH_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampLeftPaneWidth(raw) : null;
  } catch {
    return null;
  }
}

function applyLeftPaneWidth() {
  if (!els.layoutMain) return;
  if (leftPaneCollapsed) {
    els.layoutMain.style.setProperty("--left-pane-width", "0px");
    return;
  }
  const width = leftPaneWidth ?? readStoredLeftPaneWidth();
  if (width) {
    els.layoutMain.style.setProperty("--left-pane-width", `${width}px`);
  } else {
    els.layoutMain.style.removeProperty("--left-pane-width");
  }
}

function persistLeftPaneWidth() {
  if (!leftPaneWidth) return;
  try {
    localStorage.setItem(LEFT_PANE_WIDTH_STORAGE_KEY, String(Math.round(leftPaneWidth)));
  } catch {
    // ignore storage errors
  }
}

function wireLeftPaneResize() {
  const handle = els.leftPaneResizeHandle;
  if (!handle || !els.layoutMain) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || leftPaneCollapsed) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const layoutRect = els.layoutMain.getBoundingClientRect();
    els.layoutMain.classList.add("is-resizing-panes");
    function move(moveEvent) {
      const next = clampLeftPaneWidth(moveEvent.clientX - layoutRect.left - 12);
      leftPaneWidth = next;
      applyLeftPaneWidth();
    }
    function up() {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      els.layoutMain.classList.remove("is-resizing-panes");
      persistLeftPaneWidth();
    }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function applyPaneCollapseState() {
  els.layoutMain?.classList.toggle("is-left-pane-collapsed", leftPaneCollapsed);
  els.layoutMain?.classList.toggle("is-right-pane-collapsed", rightPaneCollapsed);
  document.querySelector(".knowledgePane")?.setAttribute("aria-hidden", leftPaneCollapsed ? "true" : "false");
  document.querySelector(".versionPane")?.setAttribute("aria-hidden", rightPaneCollapsed ? "true" : "false");
  applyLeftPaneWidth();
  if (els.toggleLeftPaneBtn) {
    const chevron = els.toggleLeftPaneBtn.querySelector(".workspaceSummaryChevron");
    if (chevron) chevron.textContent = leftPaneCollapsed ? "›" : "‹";
    els.toggleLeftPaneBtn.title = leftPaneCollapsed ? "展开知识库" : "收起知识库";
    els.toggleLeftPaneBtn.setAttribute("aria-expanded", leftPaneCollapsed ? "false" : "true");
  }
  if (els.toggleRightPaneBtn) {
    const chevron = els.toggleRightPaneBtn.querySelector(".workspaceSummaryChevron");
    if (chevron) chevron.textContent = rightPaneCollapsed ? "‹" : "›";
    els.toggleRightPaneBtn.title = rightPaneCollapsed ? "展开版本树" : "收起版本树";
    els.toggleRightPaneBtn.setAttribute("aria-expanded", rightPaneCollapsed ? "false" : "true");
  }
  syncPaneSummaryBar();
  try {
    localStorage.setItem(LEFT_PANE_COLLAPSED_STORAGE_KEY, leftPaneCollapsed ? "1" : "0");
    localStorage.setItem(RIGHT_PANE_COLLAPSED_STORAGE_KEY, rightPaneCollapsed ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function syncPaneSummaryBar() {
  const knowledgeSummary = knowledgeLoading
    ? "处理中"
    : knowledgeError
      ? "出错"
      : !knowledgeConfig && !knowledgeIndex
        ? "未配置"
        : knowledgeIndex?.totalChunks
          ? `${knowledgeIndex.totalChunks} 块`
          : "索引为空";
  const versionState = String(els.versionState?.textContent || "");
  const versionSummary = /失败|出错/.test(versionState)
    ? "读取失败"
    : versions.length
      ? `${versions.length} 条`
      : "无历史";

  if (els.knowledgePaneSummary) els.knowledgePaneSummary.textContent = knowledgeSummary;
  if (els.versionPaneSummary) els.versionPaneSummary.textContent = versionSummary;
  if (els.toggleLeftPaneBtn) {
    els.toggleLeftPaneBtn.classList.toggle("is-open", !leftPaneCollapsed);
    els.toggleLeftPaneBtn.setAttribute("aria-label", `${leftPaneCollapsed ? "展开" : "收起"}知识库，${knowledgeSummary}`);
  }
  if (els.toggleRightPaneBtn) {
    els.toggleRightPaneBtn.classList.toggle("is-open", !rightPaneCollapsed);
    els.toggleRightPaneBtn.setAttribute("aria-label", `${rightPaneCollapsed ? "展开" : "收起"}版本树，${versionSummary}`);
  }
}

function initPaneCollapseState() {
  try {
    const stored = (key) => localStorage.getItem(key);
    leftPaneCollapsed = stored(LEFT_PANE_COLLAPSED_STORAGE_KEY) !== "0";
    rightPaneCollapsed = stored(RIGHT_PANE_COLLAPSED_STORAGE_KEY) !== "0";
    leftPaneWidth = readStoredLeftPaneWidth();
  } catch {
    leftPaneCollapsed = true;
    rightPaneCollapsed = true;
    leftPaneWidth = null;
  }
  applyPaneCollapseState();
  wireLeftPaneResize();
  wireKnowledgeHistoryPanel();
  loadKnowledgeHistory().then(() => renderKnowledgePanel()).catch(() => renderKnowledgePanel());
  loadModelNodeConversations().catch(() => {});
}

function toggleLeftPane() {
  leftPaneCollapsed = !leftPaneCollapsed;
  applyPaneCollapseState();
}

function toggleRightPane() {
  rightPaneCollapsed = !rightPaneCollapsed;
  applyPaneCollapseState();
}

function applyChainDockCollapseState({ persist = true } = {}) {
  els.chainDock?.classList.toggle("is-collapsed", chainDockCollapsed);
  if (els.toggleChainDockBtn) {
    els.toggleChainDockBtn.textContent = chainDockCollapsed ? "⌃" : "⌄";
    els.toggleChainDockBtn.title = chainDockCollapsed ? "展开执行链" : "收起执行链";
    els.toggleChainDockBtn.setAttribute("aria-expanded", chainDockCollapsed ? "false" : "true");
  }
  if (persist) {
    try {
      localStorage.setItem(CHAIN_DOCK_COLLAPSED_STORAGE_KEY, chainDockCollapsed ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }
  renderChainLoopCmdBar();
}

function initChainDockCollapseState() {
  try {
    chainDockCollapsed = localStorage.getItem(CHAIN_DOCK_COLLAPSED_STORAGE_KEY) !== "0";
  } catch {
    chainDockCollapsed = true;
  }
  applyChainDockCollapseState({ persist: false });
}

function toggleChainDock() {
  chainDockCollapsed = !chainDockCollapsed;
  applyChainDockCollapseState();
}

function attr(value) {
  return escapeHtml(value || "").replaceAll("'", "&#39;");
}

els.addChildBtn.addEventListener("click", () => addNodeNear());
els.nodeCardCompactBtn?.addEventListener("click", () => toggleNodeCardCompact());
els.projectOverviewBtn?.addEventListener("click", () => openProjectOverview());
els.focusLensOpenBtn?.addEventListener("click", () => {
  if (focusLensOpen && !els.focusLens?.hidden) {
    closeFocusLens({ locate: true });
    return;
  }
  const targetId = focusLensId || selectedId || nextFocusId || currentFocusId || "ROOT";
  setGraphView("tree");
  openFocusLens(targetId);
});
els.projectOverviewClose?.addEventListener("click", () => els.projectOverviewDialog?.close());
els.projectOverviewDialog?.addEventListener("click", (event) => {
  if (event.target === els.projectOverviewDialog) els.projectOverviewDialog.close();
});
els.projectOverviewBody?.addEventListener("click", (event) => {
  const setNext = event.target.closest("[data-overview-set-next]");
  if (setNext) {
    setProjectOverviewNext(setNext.getAttribute("data-overview-set-next"));
    return;
  }
  const locate = event.target.closest("[data-overview-locate]");
  if (locate) focusProjectOverviewNode(locate.getAttribute("data-overview-locate"));
});
els.layoutTreeBtn.addEventListener("click", () => layoutAsTree());
els.nodesLayer?.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("nodeCardDetails")) return;
  if (!els.nodesLayer.contains(details)) return;
  const nodeId = details.getAttribute("data-node-details");
  if (!nodeId) return;
  if (details.open) nodeDetailsOpenIds.add(nodeId);
  else nodeDetailsOpenIds.delete(nodeId);
  const node = nodes.find((item) => item.id === nodeId);
  const cardEl = details.closest(".graphNode");
  if (node && cardEl) {
    cardEl.style.height = `${displayNodeHeight(node)}px`;
    renderEdges();
  }
}, true);
els.edges?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.matches(".edgeHub")) return;
  const edgeId = target.getAttribute("data-edge-hub");
  if (!edgeId) return;
  event.stopPropagation();
  toggleEdgeLabel(edgeId);
});
els.edges?.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && event.target.matches(".edgeHub")) {
    event.stopPropagation();
  }
});
els.fitViewBtn?.addEventListener("click", () => scheduleFitGraphToViewport());
els.embedExpandBtn?.addEventListener("click", () => { toggleChatDisplayMode().catch(() => {}); });
els.saveBtn.addEventListener("click", () => {
  pendingSaveReason = pendingSaveReason || "将手动保存图谱修改";
  saveTree().catch((error) => setSaveState(error.message));
});
els.reloadBtn.addEventListener("click", () => loadTree({ fitView: true }).catch((error) => setSaveState(error.message)));
els.treeSelect?.addEventListener("change", () => {
  switchViewedTree(els.treeSelect.value).catch((error) => {
    setSaveState(error.message);
    renderTreeSwitcher();
  });
});
els.createTreeBtn?.addEventListener("click", () => createIndependentTree().catch((error) => setSaveState(error.message)));
els.setActiveMethodBtn?.addEventListener("click", () => setViewedTreeAsActiveMethod().catch((error) => setSaveState(error.message)));
els.filePreviewClose?.addEventListener("click", () => els.filePreviewDialog?.close());
els.filePreviewDialog?.addEventListener("click", (event) => {
  if (event.target === els.filePreviewDialog) els.filePreviewDialog.close();
});
let codexThreadRefreshTimer = null;

function closeCodexThreadMenu() {
  clearTimeout(codexThreadRefreshTimer);
  els.codexThreadMenu?.classList.add("hidden");
  els.codexThreadsBtn?.setAttribute("aria-expanded", "false");
}

async function runCodex(body = {}) {
  closeCodexThreadMenu();
  const buttons = [
    els.openInCodexBtn,
    els.codexThreadsBtn,
    els.codexParallelBtn,
    els.chainRunBtn,
    els.focusLensBody?.querySelector("[data-focus-lens-action='run-agent']")
  ].filter(Boolean);
  for (const button of buttons) button.disabled = true;
  setSaveState("正在发给 Codex...");
  try {
    const res = await fetch("/api/codex/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    setSaveState(payload.resumed ? "已发到原来那条会话，切过去接着做" : "已新开一条会话，切过去就能看到");
    return true;
  } catch (error) {
    setSaveState(`Codex 没能启动: ${error.message}`);
    return false;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

/** Switching the target is free; only the send section spends a model turn. */
async function pinCodexThread(threadId) {
  try {
    await fetch("/api/codex/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId })
    });
    setSaveState(threadId ? "下次发送会发到这条会话" : "下次发送会新开一条会话");
  } catch (error) {
    setSaveState(`换会话失败: ${error.message}`);
  }
  await openCodexThreadMenu();
}

function codexMenuGroup(title) {
  const label = document.createElement("p");
  label.className = "codexThreadGroup";
  label.textContent = title;
  return label;
}

/**
 * A place to tell Codex something the presets do not cover.
 *
 * The presets are built from the tree and stay correct on their own, but they can only say the
 * three things the tree knows about. This is the way to say anything else without leaving the page
 * for the chat window. The draft is kept because the menu closes on every send.
 */
function codexAskBox() {
  const wrap = document.createElement("div");
  wrap.className = "codexAsk";

  const input = document.createElement("textarea");
  input.className = "codexAskInput";
  input.rows = 3;
  input.placeholder = "直接跟 Codex 说…（Ctrl+Enter 发送）";
  try {
    input.value = localStorage.getItem("taskTree.codexDraft") || "";
  } catch {
    // a missing draft is not worth reporting
  }
  input.addEventListener("input", () => {
    try {
      localStorage.setItem("taskTree.codexDraft", input.value);
    } catch {
      // ignore storage errors
    }
  });

  const send = document.createElement("button");
  send.type = "button";
  send.className = "codexAskSend";
  send.textContent = "发送";

  const submit = async () => {
    const text = input.value.trim();
    if (!text) {
      setSaveState("先写点要 Codex 做的事");
      return;
    }
    const ok = await runCodex({ prompt: text });
    if (!ok) return;
    input.value = "";
    try {
      localStorage.removeItem("taskTree.codexDraft");
    } catch {
      // ignore storage errors
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });
  send.addEventListener("click", submit);

  wrap.append(input, send);
  return wrap;
}

let codexParallelRunId = "";
let codexParallelPollTimer = null;
let codexParallelRun = null;
const codexParallelDraftEdits = new Map();
const codexParallelStorageKey = `task-tree:codex-parallel:${location.origin}${location.pathname}`;

function parallelRunTerminal(run) {
  if (["rejected", "failed"].includes(run?.status)) return true;
  if (run?.status !== "accepted") return false;
  const treeSync = run.review?.treeSync?.status;
  const cleanup = run.review?.cleanup?.status;
  return !["queued", "running"].includes(treeSync) && !["queued", "running"].includes(cleanup);
}

function parallelRunNeedsPolling(run) {
  if (["planning", "approved", "preparing", "running", "coordinating", "auditing"].includes(run?.status)) return true;
  if (run?.status !== "accepted") return false;
  return ["queued", "running"].includes(run.review?.treeSync?.status)
    || ["queued", "running"].includes(run.review?.cleanup?.status);
}

function rememberCodexParallelRun(run) {
  if (!run?.id) return;
  try {
    if (parallelRunTerminal(run)) localStorage.removeItem(codexParallelStorageKey);
    else localStorage.setItem(codexParallelStorageKey, run.id);
  } catch {
    // Embedded and private contexts may disable localStorage; the in-memory run still works.
  }
}

function rememberedCodexParallelRunId() {
  try {
    return localStorage.getItem(codexParallelStorageKey) || "";
  } catch {
    return "";
  }
}

function forgetCodexParallelRun() {
  try { localStorage.removeItem(codexParallelStorageKey); } catch { /* optional persistence */ }
}

const parallelStatusLabels = {
  planned: "待审核",
  queued: "排队",
  preparing: "准备隔离区",
  running: "执行中",
  completed: "已集成",
  failed: "失败",
  blocked: "被依赖阻塞"
};

const parallelStageOrder = ["planning", "execution", "summary", "review", "applied"];

function parallelStageFor(run) {
  if (["approved", "preparing", "running"].includes(run?.status)) return "execution";
  if (run?.status === "coordinating") return "summary";
  if (["auditing", "review"].includes(run?.status)) return "review";
  if (run?.status === "accepted") return "applied";
  return "planning";
}

function renderParallelStageRail(run = { status: "planning" }) {
  const rail = els.codexParallelStageRail;
  if (!rail) return;
  const activeStage = parallelStageFor(run);
  const activeIndex = parallelStageOrder.indexOf(activeStage);
  rail.classList.toggle("is-error", ["failed", "rejected"].includes(run?.status));
  rail.querySelectorAll(".codexParallelStage").forEach((stage, index) => {
    stage.classList.toggle("is-complete", index < activeIndex);
    stage.classList.toggle("is-active", index === activeIndex);
    stage.setAttribute("aria-current", index === activeIndex ? "step" : "false");
  });
}

function humanizeParallelTitle(value, fallback = "并行任务") {
  return String(value || fallback)
    .replace(/业务场景代理夹具/g, "业务测试场景")
    .replace(/根目标语义回归/g, "目标一致性校验")
    .replace(/状态同步提示契约/g, "状态同步规则")
    .replace(/契约/g, "规则")
    .replace(/夹具/g, "测试场景")
    .replace(/语义回归/g, "目标校验")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function parallelTaskSummary(job) {
  const text = String(job?.summary || job?.instruction || "").replace(/\s+/g, " ").trim();
  const first = text.split(/[。！？；;]/)[0] || text;
  const colon = first.indexOf("：");
  return (colon > 8 ? first.slice(0, colon) : first).slice(0, 36) || "等待补充任务说明";
}

function parallelGoalView(run) {
  const assessment = run.review?.goalAssessment || {};
  if (run.status === "auditing" || run.review?.goalAudit?.status === "running") {
    return { status: "正在核验", result: "对照根目标、阶段目标和实际改动" };
  }
  if (assessment.continuity === "baseline" && run.goal?.history?.length) {
    return { status: "目标连续性冲突", result: "已有历史运行，必须重新核验是否仍服务同一个根本目标" };
  }
  if (assessment.continuity === "drifted") return { status: "长期目标漂移", result: assessment.remaining || "这轮结果可能只完成了局部实现，没有保持长期目标" };
  if (assessment.continuity !== "baseline" && assessment.continuity !== "stable") {
    return { status: "目标连续性待核验", result: assessment.remaining || "还不能判断这轮是否继续服务同一个根本目标" };
  }
  if (assessment.alignment === "off_target") return { status: "偏离目标", result: assessment.remaining || "当前改动没有对准本轮目标" };
  if (assessment.alignment !== "aligned") return { status: "待核验", result: "尚不能判断这些改动是否真正推进目标" };
  if (assessment.progress === "reached") return { status: "目标已达到", result: assessment.achieved || "完成判据已有充分证据" };
  if (assessment.progress === "progress") {
    const achieved = assessment.achieved ? `已推进：${assessment.achieved}` : "已有可验证推进";
    return { status: assessment.continuity === "baseline" ? "首次基线 · 方向一致" : "长期连续 · 方向一致", result: assessment.remaining ? `${achieved}；仍缺：${assessment.remaining}` : achieved };
  }
  return { status: "没有有效推进", result: assessment.remaining || "改动尚未形成可验证的目标进展" };
}

function parallelField(labelText, control, wide = false) {
  const label = document.createElement("label");
  label.className = `codexParallelField${wide ? " wide" : ""}`;
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, control);
  return label;
}

function parallelContextOptionsForRun(runOptions = []) {
  const merged = new Map();
  for (const option of [...runOptions, ...codexParallelContextOptions]) {
    if (!option?.contextKey || !option?.threadId) continue;
    const key = String(option.contextKey);
    if (!merged.has(key)) merged.set(key, option);
  }
  return [...merged.values()];
}

function parallelContextBadgeText(job, option = null) {
  if (option?.value === "new") return "新建对话";
  const threadId = option?.dataset?.contextThreadId || job.contextThreadId || "";
  const title = option?.dataset?.contextLabel || job.contextLabel || job.title || job.nodeId || "分支";
  return threadId ? `复用 · ${humanizeParallelTitle(title, job.nodeId)}` : "首次建立";
}

function parallelContextLifecycleLabel(job, fallback = "") {
  const generation = Number(job?.contextGeneration) || 1;
  const status = {
    active: "当前",
    near_limit: "偏长",
    ready_to_rotate: "待换代",
    rotating: "换代中",
    archived: "已归档"
  }[job?.contextStatus] || fallback;
  return `第${generation}代${status ? ` · ${status}` : ""}`;
}

function parallelContextLine({ title = "", state = "", threadId = "" } = {}) {
  const row = document.createElement("div");
  row.className = "codexParallelContextLine";
  const name = document.createElement("strong");
  name.textContent = title || "未命名上下文";
  const status = document.createElement("span");
  status.textContent = state;
  row.append(name, status);
  if (threadId) {
    const open = document.createElement("a");
    open.href = `codex://threads/${encodeURIComponent(threadId)}`;
    open.textContent = "↗";
    open.title = `打开${title || "上下文"}`;
    open.setAttribute("aria-label", open.title);
    row.append(open);
  }
  return row;
}

function renderParallelContextOverview(run, contextOptions = []) {
  const jobs = run?.jobs || [];
  const reused = jobs.filter((job) => job.contextThreadId).length;
  const fresh = jobs.length - reused;
  const parts = [`${reused} 个复用`];
  if (fresh) parts.push(`${fresh} 个新建`);
  parts.push(`${contextOptions.length} 个可选`);
  els.codexParallelContextSummary.textContent = parts.join(" · ");
  els.codexParallelContextAssignments.textContent = "";
  els.codexParallelContextPool.textContent = "";

  if (run?.planner?.threadId) {
    els.codexParallelContextAssignments.append(parallelContextLine({
      title: "规划上下文",
      state: run.planner.contextResumed ? "已复用" : "当前",
      threadId: run.planner.threadId
    }));
  }
  for (const job of jobs) {
    els.codexParallelContextAssignments.append(parallelContextLine({
      title: humanizeParallelTitle(job.title, job.taskId),
      state: parallelContextLifecycleLabel(job, job.contextThreadId ? "复用" : "首次建立"),
      threadId: job.threadId || job.contextThreadId || ""
    }));
  }

  const assignedThreads = new Set(jobs.map((job) => job.contextThreadId).filter(Boolean));
  for (const option of contextOptions.filter((item) => !assignedThreads.has(item.threadId))) {
    const source = option.source === "codex" ? "项目对话" : (option.nodeId || "历史分支");
    els.codexParallelContextPool.append(parallelContextLine({
      title: option.title || option.nodeId || "历史上下文",
      state: source,
      threadId: option.threadId
    }));
  }
  els.codexParallelContexts.hidden = !(jobs.length || contextOptions.length || run?.planner?.threadId);
}

function parallelContextSelect(job, contextOptions = [], onChange = null) {
  const select = document.createElement("select");
  select.className = "codexParallelContextSelect";
  select.setAttribute("aria-label", `${job.taskId} 上下文`);
  select.dataset.contextKey = job.contextKey || "";
  select.dataset.contextThreadId = job.contextThreadId || "";

  const reuse = document.createElement("option");
  reuse.value = "reuse";
  reuse.textContent = job.contextThreadId ? "沿用此分支已有对话" : "此分支上下文（首次建立，之后复用）";
  reuse.dataset.contextKey = job.contextKey || "";
  reuse.dataset.contextThreadId = job.contextThreadId || "";
    reuse.dataset.contextSource = job.contextSource || "parallel";
    reuse.dataset.contextPreview = job.contextPreview || "";
    reuse.dataset.contextLabel = job.contextLabel || job.title || job.nodeId || "";
    reuse.dataset.contextGeneration = String(job.contextGeneration || 1);
  select.append(reuse);

  const fresh = document.createElement("option");
  fresh.value = "new";
  fresh.textContent = "新建独立对话";
  fresh.dataset.contextLabel = "新建独立对话";
  select.append(fresh);

  for (const option of contextOptions) {
    if (!option?.contextKey || !option?.threadId) continue;
    const item = document.createElement("option");
    item.value = `selected:${option.contextKey}`;
    item.dataset.contextKey = option.contextKey;
    item.dataset.contextThreadId = option.threadId;
    item.dataset.contextSource = option.source || "parallel";
    item.dataset.contextPreview = option.preview || "";
    item.dataset.contextLabel = option.title || option.nodeId || "";
    item.dataset.contextGeneration = String(option.generation || 1);
    const source = option.source === "codex" ? "已有对话" : "历史分支";
    const detail = [option.nodeId, option.preview].filter(Boolean).join(" · ");
    item.textContent = `${source} · ${option.title || option.nodeId || "未命名"}${detail ? ` · ${detail}` : ""}`;
    select.append(item);
  }

  if (job.contextPolicy === "selected" && job.contextKey) select.value = `selected:${job.contextKey}`;
  else select.value = job.contextPolicy === "new" ? "new" : "reuse";
  select.addEventListener("change", () => {
    validateParallelContextChoices();
    onChange?.(select.selectedOptions?.[0] || null);
  });
  return select;
}

function parallelContextState(job) {
  const state = document.createElement("span");
  state.className = "codexParallelContextState";
  state.textContent = job.contextThreadId
    ? `对话：${job.contextResumed ? "已继承" : "已建立"} · ${parallelContextLifecycleLabel(job)}`
    : `对话：首次建立 · ${parallelContextLifecycleLabel(job)}`;
  if (Array.isArray(job.contextHistory) && job.contextHistory.length) {
    state.title = `上一代对话已归档，可在 Codex 历史中查看；交接：${job.contextHandoffPath || "已生成"}`;
  }
  return state;
}

function parallelScopeOverlaps(left, right) {
  const a = String(left || "").replace(/\\/g, "/").toLowerCase();
  const b = String(right || "").replace(/\\/g, "/").toLowerCase();
  const base = (value) => value.split(/[*!?\[]/, 1)[0].replace(/[^/]*$/, "");
  const aBase = base(a);
  const bBase = base(b);
  if (!aBase || !bBase || aBase === bBase) return true;
  const aDirectory = /[*!?\[]|\/$/.test(a);
  const bDirectory = /[*!?\[]|\/$/.test(b);
  return (aDirectory && b.startsWith(aBase)) || (bDirectory && a.startsWith(bBase));
}

function parallelNodeWriteSet(node, jobs = []) {
  const codeLoc = String(node?.codeLoc || "");
  const fromCode = codeLoc.split(/[\n,;]+/)
    .map((item) => item.trim().replace(/\\/g, "/").split(":")[0])
    .filter((item) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+$/.test(item));
  const text = `${node?.title || ""} ${node?.problem || ""}`;
  const preferred = fromCode.length
    ? fromCode.slice(0, 3)
    : /界面|前端|编辑器|可视化|UI/i.test(text)
      ? ["public/**"]
      : /测试|验证|回归/i.test(text)
        ? ["scripts/**"]
        : /文档|研究|说明/i.test(text)
          ? ["docs/**"]
          : ["server/**"];
  const occupied = jobs
    .filter((job) => job.status !== "completed")
    .flatMap((job) => job.writeSet || []);
  const free = preferred.find((scope) => !occupied.some((item) => parallelScopeOverlaps(scope, item)));
  if (free) return [free];
  const fallbacks = ["server/**", "public/**", "scripts/**", "docs/**"];
  return [fallbacks.find((scope) => !occupied.some((item) => parallelScopeOverlaps(scope, item))) || "docs/**"];
}

function parallelJobFromNode(node, taskId, jobs = []) {
  const instruction = String(node?.nextIdea || node?.problem || node?.approach || `推进${node?.title || node?.id || "当前节点"}`).trim();
  return {
    taskId,
    nodeId: node?.id || "",
    title: humanizeParallelTitle(node?.title || node?.id || "继续推进"),
    summary: parallelTaskSummary({ instruction }),
    instruction,
    writeSet: parallelNodeWriteSet(node, jobs),
    dependsOn: [],
    tests: [],
    dependencyPrompt: "开始前确认节点接口和依赖分支已满足；没有依赖时写无。",
    acceptancePrompt: "说明解决了什么问题、如何验证、还缺什么。",
    contextPolicy: "new",
    contextKey: "",
    contextThreadId: "",
    contextLabel: node?.title || node?.id || "并行分支"
  };
}

function syncParallelAppendNodeOptions(run) {
  const select = els.codexParallelAppendNode;
  if (!select) return;
  const previous = select.value;
  select.textContent = "";
  const candidates = nodes.filter((node) => node.id !== "ROOT");
  const fallbackId = run.goal?.stageNodeId || nextFocusId || currentFocusId || candidates[0]?.id || "";
  for (const node of candidates.length ? candidates : [{ id: fallbackId, title: fallbackId }]) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = `${node.id} · ${humanizeParallelTitle(node.title || node.id)}`;
    select.append(option);
  }
  select.value = candidates.some((node) => node.id === previous)
    ? previous
    : (candidates.some((node) => node.id === fallbackId) ? fallbackId : select.options[0]?.value || "");
}

function parallelJobRow(job, editable, index, contextOptions = [], initiallyOpen = false) {
  const row = document.createElement("tr");
  row.dataset.taskId = job.taskId;
  row.dataset.nodeId = job.nodeId;
  if (editable && ["failed", "blocked"].includes(job.status)) row.classList.add("codexParallelRetryableRow");

  const statusCell = document.createElement("td");
  const status = document.createElement("span");
  status.className = `codexParallelJobStatus ${job.status || "planned"}`;
  status.textContent = parallelStatusLabels[job.status] || job.status || "待审核";
  statusCell.append(status);

  const nodeCell = document.createElement("td");
  const branchHead = document.createElement("div");
  branchHead.className = "codexParallelBranchHead";
  const branchNumber = document.createElement("span");
  branchNumber.className = "codexParallelBranchNumber";
  branchNumber.textContent = String(index + 1).padStart(2, "0");
  const nodeTitle = document.createElement("strong");
  nodeTitle.className = "codexParallelBranchTitle";
  nodeTitle.textContent = humanizeParallelTitle(job.title, job.taskId);
  branchHead.append(branchNumber, nodeTitle);
  let remove = null;
  if (editable) {
    remove = document.createElement("button");
    remove.type = "button";
    remove.className = "codexParallelRemoveBranch";
    remove.textContent = "\u00d7";
    remove.title = `删除${nodeTitle.textContent}`;
    remove.setAttribute("aria-label", `删除${nodeTitle.textContent}`);
    remove.addEventListener("click", () => removeCodexParallelBranch(job.taskId));
    branchHead.append(remove);
  }
  if (job.threadId) {
    const threadLink = document.createElement("a");
    threadLink.className = "codexParallelThreadLink";
    threadLink.href = job.deepLink || `codex://threads/${encodeURIComponent(job.threadId)}`;
    threadLink.textContent = "进入对话";
    threadLink.title = "打开这个 Codex 任务";
    threadLink.setAttribute("aria-label", `打开${nodeTitle.textContent}`);
    threadLink.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const response = await fetch(`/api/codex/parallel/${encodeURIComponent(codexParallelRunId)}/thread/${encodeURIComponent(job.taskId)}/open`, { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      } catch {
        window.location.href = threadLink.href;
      }
    });
    branchHead.append(threadLink);
  }
  nodeCell.append(branchHead);
  const contextBadge = document.createElement("span");
  contextBadge.className = "codexParallelContextBadge";
  contextBadge.textContent = parallelContextBadgeText(job);
  nodeCell.append(contextBadge);

  const taskCell = document.createElement("td");
  const taskSummary = document.createElement("div");
  taskSummary.className = "codexParallelTaskText";
  taskSummary.textContent = parallelTaskSummary(job);
  taskCell.append(taskSummary);
  if (job.error) {
    const error = document.createElement("div");
    error.className = "codexParallelJobError";
    error.textContent = job.error;
    taskCell.append(error);
  }

  const settings = document.createElement("details");
  settings.className = "codexParallelJobSettings";
  settings.open = initiallyOpen;
  const settingsSummary = document.createElement("summary");
  const settingsSummaryText = document.createElement("span");
  settingsSummaryText.textContent = initiallyOpen
    ? (editable ? "收起修改" : "收起详情")
    : (editable ? "查看与修改" : "查看详情");
  settingsSummary.append(settingsSummaryText);
  settings.addEventListener("toggle", () => {
    settingsSummaryText.textContent = settings.open
      ? (editable ? "收起修改" : "收起详情")
      : (editable ? "查看与修改" : "查看详情");
  });
  const meta = document.createElement("div");
  meta.className = "codexParallelJobMeta";
  if (editable) {
    const titleInput = document.createElement("input");
    titleInput.className = "codexParallelTitleInput";
    titleInput.value = job.title || "";
    titleInput.placeholder = `分支 ${String(index + 1).padStart(2, "0")}`;
    titleInput.setAttribute("aria-label", `${job.taskId} 分支名称`);
    titleInput.addEventListener("input", () => {
      nodeTitle.textContent = humanizeParallelTitle(titleInput.value, job.taskId);
      remove.title = `删除${nodeTitle.textContent}`;
      remove.setAttribute("aria-label", remove.title);
    });
    const nodeInput = document.createElement("input");
    nodeInput.className = "codexParallelNodeId";
    nodeInput.value = job.nodeId || "";
    nodeInput.placeholder = "N3";
    nodeInput.setAttribute("aria-label", `${job.taskId} 节点 ID`);
    meta.append(parallelField("分支名称", titleInput), parallelField("节点 ID", nodeInput));
  }
  const fullTask = document.createElement(editable ? "textarea" : "div");
  fullTask.className = editable ? "codexParallelInstruction codexParallelFullTask" : "codexParallelFullTask";
  if (editable) {
    fullTask.rows = 4;
    fullTask.value = job.instruction || "";
    fullTask.setAttribute("aria-label", `${job.taskId} 任务`);
    fullTask.addEventListener("input", () => {
      taskSummary.textContent = parallelTaskSummary({ instruction: fullTask.value });
    });
  } else {
    fullTask.textContent = job.instruction || "";
  }
  const ids = document.createElement("div");
  ids.className = "codexParallelJobIds";
  ids.textContent = editable ? `任务 ${job.taskId}` : `节点 ${job.nodeId} · 任务 ${job.taskId}`;
  const dependency = document.createElement(editable ? "input" : "span");
  dependency.className = "codexParallelDependsOn";
  const dependencyText = (job.dependsOn || []).join(", ");
  if (editable) {
    dependency.value = dependencyText;
    dependency.placeholder = "依赖：无";
    dependency.setAttribute("aria-label", `${job.taskId} 依赖`);
  } else {
    dependency.textContent = `依赖：${dependencyText || "无"}`;
  }
  const dependencyPrompt = document.createElement(editable ? "textarea" : "span");
  dependencyPrompt.className = "codexParallelDependencyPrompt";
  if (editable) {
    dependencyPrompt.rows = 2;
    dependencyPrompt.value = job.dependencyPrompt || "";
    dependencyPrompt.placeholder = "开始前要确认哪些条件？没有依赖就写无。";
    dependencyPrompt.setAttribute("aria-label", `${job.taskId} 依赖说明`);
  } else {
    dependencyPrompt.textContent = `依赖说明：${job.dependencyPrompt || "未填写"}`;
  }
  const tests = document.createElement(editable ? "input" : "span");
  tests.className = "codexParallelJobTests";
  const testsText = (job.tests || []).join(" ; ");
  if (editable) {
    tests.value = testsText;
    tests.placeholder = "验收命令";
    tests.setAttribute("aria-label", `${job.taskId} 验收`);
  } else {
    tests.textContent = testsText || "未配置分支验收";
  }
  const acceptancePrompt = document.createElement(editable ? "textarea" : "span");
  acceptancePrompt.className = "codexParallelAcceptancePrompt";
  if (editable) {
    acceptancePrompt.rows = 3;
    acceptancePrompt.value = job.acceptancePrompt || "";
    acceptancePrompt.placeholder = "如何证明问题已解决？还缺什么？";
    acceptancePrompt.setAttribute("aria-label", `${job.taskId} 验收提示`);
  } else {
    acceptancePrompt.textContent = `验收提示：${job.acceptancePrompt || "未填写"}`;
  }
  if (editable) {
    const contextSelect = parallelContextSelect(job, contextOptions, (selected) => {
      contextBadge.textContent = parallelContextBadgeText(job, selected);
    });
    meta.append(
      parallelField("完整任务", fullTask, true),
      parallelField("上下文对话（每个分支独立选择）", contextSelect, true),
      parallelField("依赖说明", dependencyPrompt, true),
      parallelField("验收提示", acceptancePrompt, true)
    );
  } else {
    meta.append(fullTask, parallelContextState(job), ids, dependency, dependencyPrompt, acceptancePrompt, tests);
  }
  const scope = document.createElement(editable ? "input" : "div");
  scope.className = "codexParallelWriteSet";
  if (editable) {
    scope.type = "text";
    scope.value = (job.writeSet || []).join(", ");
    scope.placeholder = "server/**";
    scope.setAttribute("aria-label", `${job.taskId} 分支负责修改的文件范围`);
  } else {
    scope.textContent = (job.writeSet || []).join(", ");
  }
  if (editable) {
    meta.append(
      parallelField("分支负责修改的文件范围", scope, true),
      parallelField("机器依赖 taskId", dependency),
      parallelField("验收命令", tests),
      ids
    );
  } else {
    meta.append(scope);
  }
  settings.append(settingsSummary, meta);
  taskCell.append(settings);
  row.append(statusCell, nodeCell, taskCell);
  return row;
}

function validateParallelContextChoices() {
  const owners = new Map();
  let duplicate = "";
  for (const row of els.codexParallelRows.querySelectorAll("tr")) {
    const select = row.querySelector(".codexParallelContextSelect");
    const selected = select?.selectedOptions?.[0];
    const threadId = selected?.dataset.contextThreadId || "";
    if (!threadId || select?.value === "new") continue;
    const owner = owners.get(threadId);
    if (owner) duplicate = `${owner} 和 ${row.dataset.taskId} 不能选择同一个 Codex 对话`;
    else owners.set(threadId, row.dataset.taskId);
  }
  if (duplicate) els.codexParallelState.textContent = duplicate;
  return duplicate ? { message: duplicate } : null;
}

function resetParallelDialog() {
  codexParallelDraftEdits.clear();
  els.codexParallelRows.textContent = "";
  els.codexParallelGoalReview.hidden = true;
  els.codexParallelGoalLabel.textContent = "本轮目标";
  els.codexParallelGoalText.textContent = "";
  els.codexParallelGoalStatus.textContent = "";
  els.codexParallelGoalResult.textContent = "";
  els.codexParallelContexts.hidden = true;
  els.codexParallelContexts.open = false;
  els.codexParallelContextSummary.textContent = "";
  els.codexParallelContextAssignments.textContent = "";
  els.codexParallelContextPool.textContent = "";
  els.codexParallelPlanTools.hidden = true;
  els.codexParallelAddBranch.disabled = false;
  els.codexParallelTableWrap.hidden = false;
  els.codexParallelObjectiveBar.hidden = false;
  els.codexParallelSummary.hidden = true;
  els.codexParallelSummary.open = false;
  els.codexParallelSummaryText.textContent = "";
  els.codexParallelReview.hidden = true;
  els.codexParallelFiles.textContent = "";
  els.codexParallelTests.textContent = "";
  els.codexParallelPatch.textContent = "";
  els.codexParallelReviewWarning.hidden = true;
  els.codexParallelReviewWarning.textContent = "";
  els.codexParallelOpen.hidden = true;
  els.codexParallelRetry.hidden = true;
  els.codexParallelRetry.disabled = false;
  els.codexParallelReject.hidden = true;
  els.codexParallelReject.disabled = false;
  els.codexParallelAccept.hidden = true;
  els.codexParallelMore.hidden = true;
  els.codexParallelMore.open = false;
  els.codexParallelRegenerate.hidden = false;
  els.codexParallelRegenerate.disabled = false;
  els.codexParallelStart.hidden = false;
  els.codexParallelStart.disabled = true;
  els.codexParallelStart.textContent = "确认开始并行";
  els.codexParallelAudit.hidden = true;
  els.codexParallelAudit.disabled = false;
  renderParallelStageRail();
}

function parallelStatusText(run) {
  if (run.error) return run.error;
  if (run.status === "draft") return `${run.jobs.length} 个分支待确认`;
  if (["approved", "preparing"].includes(run.status)) return "正在准备隔离工作区";
  if (run.status === "running") {
    const done = run.jobs.filter((job) => job.status === "completed").length;
    const active = run.jobs.filter((job) => ["preparing", "running"].includes(job.status)).length;
    const queued = run.jobs.filter((job) => ["planned", "queued"].includes(job.status)).length;
    return `${done}/${run.jobs.length} 已完成 · ${active} 执行中${queued ? ` · ${queued} 等待` : ""}`;
  }
  if (run.status === "coordinating") return "分支已完成 · 正在汇总验证";
  if (run.status === "review") {
    const failed = run.review?.failedTasks?.length || 0;
    if (failed) return `${failed} 个分支待修复`;
    return run.review?.readyToAccept ? "目标一致 · 可应用" : "暂不可应用";
  }
  if (run.status === "auditing") return "正在核验目标";
  if (run.status === "accepted") {
    if (["queued", "running"].includes(run.review?.treeSync?.status)) return "已应用 · 正在同步任务树";
    if (run.review?.treeSync?.status === "failed") return "已应用 · 任务树同步失败";
    return "已应用";
  }
  if (run.status === "rejected") return "已丢弃，当前项目没有被修改";
  if (run.status === "failed") return `运行失败：${run.error || "请检查协调任务"}`;
  return "正在自动规划并行分支…";
}

function renderParallelRun(run, { focusTaskId = "" } = {}) {
  captureParallelDraftEdits(run);
  for (const taskId of [...codexParallelPendingAppendJobs.keys()]) {
    if ((run.jobs || []).some((job) => job.taskId === taskId && !job.pendingAppend) || ["accepted", "rejected"].includes(run.status)) {
      codexParallelPendingAppendJobs.delete(taskId);
    }
  }
  const openTaskIds = new Set([...els.codexParallelRows.querySelectorAll("tr")]
    .filter((row) => row.querySelector(".codexParallelJobSettings")?.open)
    .map((row) => row.dataset.taskId));
  if (focusTaskId) openTaskIds.add(focusTaskId);
  const scrollTop = els.codexParallelTableWrap.scrollTop;
  const scrollLeft = els.codexParallelTableWrap.scrollLeft;
  const activeRow = document.activeElement?.closest?.("tr");
  const activeClass = [...(document.activeElement?.classList || [])].find((name) => name.startsWith("codexParallel")) || "";
  const activeWasSummary = document.activeElement?.tagName === "SUMMARY";
  const mergeDraft = (job) => {
    const edits = codexParallelDraftEdits.get(job.taskId);
    if (!edits || !(run.status === "draft" || job.pendingAppend || codexParallelPendingAppendJobs.has(job.taskId))) return job;
    return { ...job, ...edits, status: job.status, pendingAppend: job.pendingAppend };
  };
  const baseJobs = (run.jobs || []).filter((job) => !job.pendingAppend).map(mergeDraft);
  const pendingJobs = run.status === "draft" ? [] : [...codexParallelPendingAppendJobs.values()]
    .filter((job) => !baseJobs.some((item) => item.taskId === job.taskId))
    .map(mergeDraft);
  const displayedRun = pendingJobs.length || baseJobs.length !== (run.jobs || []).length
    ? { ...run, jobs: [...baseJobs, ...pendingJobs] }
    : run;
  codexParallelRun = displayedRun;
  codexParallelRunId = displayedRun.id;
  renderParallelStageRail(displayedRun);
  rememberCodexParallelRun(displayedRun);
  const editable = displayedRun.status === "draft";
  const reviewing = displayedRun.status === "review";
  const failedTaskIds = new Set(displayedRun.review?.failedTasks || []);
  const displayedObjective = displayedRun.objective || displayedRun.goal?.immediate || "";
  if (displayedObjective && document.activeElement !== els.codexParallelObjective) {
    els.codexParallelObjective.value = displayedObjective;
  }
  els.codexParallelObjectiveBar.hidden = !["planning", "draft", "failed"].includes(displayedRun.status);
  els.codexParallelObjective.disabled = !["planning", "draft", "failed"].includes(displayedRun.status);
  els.codexParallelRows.textContent = "";
  const contextOptions = parallelContextOptionsForRun(displayedRun.contextOptions || []);
  renderParallelContextOverview(displayedRun, contextOptions);
  for (const [index, job] of (displayedRun.jobs || []).entries()) {
    const jobEditable = editable || (reviewing && failedTaskIds.has(job.taskId)) || codexParallelPendingAppendJobs.has(job.taskId);
    els.codexParallelRows.append(parallelJobRow(job, jobEditable, index, contextOptions, openTaskIds.has(job.taskId)));
  }
  requestAnimationFrame(() => {
    const targetTaskId = focusTaskId || activeRow?.dataset.taskId || "";
    const targetRow = targetTaskId
      ? [...els.codexParallelRows.querySelectorAll("tr")].find((row) => row.dataset.taskId === targetTaskId)
      : null;
    if (focusTaskId) targetRow?.querySelector(".codexParallelJobSettings")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    else {
      els.codexParallelTableWrap.scrollTop = scrollTop;
      els.codexParallelTableWrap.scrollLeft = scrollLeft;
    }
    const focusTarget = activeWasSummary
      ? targetRow?.querySelector(".codexParallelJobSettings summary")
      : (activeClass ? targetRow?.querySelector(`.${activeClass}`) : null);
    focusTarget?.focus?.({ preventScroll: true });
  });
  const summary = displayedRun.summary;
  els.codexParallelSummary.hidden = !summary || !editable;
  els.codexParallelSummaryText.textContent = summary || "";
  const goalVisible = Boolean(displayedRun.goal) && ["planning", "draft", "review", "auditing", "accepted"].includes(displayedRun.status);
  els.codexParallelGoalReview.hidden = !goalVisible;
  if (goalVisible) {
    if (["planning", "draft"].includes(displayedRun.status)) {
      els.codexParallelGoalLabel.textContent = "根本目标";
      els.codexParallelGoalText.textContent = displayedRun.goal.root || "尚未记录根本目标";
      els.codexParallelGoalStatus.textContent = "阶段目标";
      els.codexParallelGoalResult.textContent = displayedRun.goal.stage || "尚未记录阶段目标";
    } else {
      const goalView = parallelGoalView(displayedRun);
      els.codexParallelGoalLabel.textContent = "本轮目标";
      els.codexParallelGoalText.textContent = displayedRun.goal.immediate || "尚未记录本轮目标";
      els.codexParallelGoalStatus.textContent = goalView.status;
      els.codexParallelGoalResult.textContent = goalView.result;
    }
  }
  els.codexParallelTableWrap.hidden = ["accepted", "rejected"].includes(displayedRun.status);
  syncParallelAppendNodeOptions(displayedRun);
  const appendable = ["draft", "approved", "preparing", "running", "coordinating", "review", "failed"].includes(displayedRun.status);
  els.codexParallelPlanTools.hidden = !appendable;
  els.codexParallelAddBranch.disabled = !appendable || codexParallelBranchPlanning;
  els.codexParallelAddBranch.title = editable ? "让模型按选中节点生成一个分支草案" : "让模型按选中节点生成一个待审核分支";
  els.codexParallelState.textContent = parallelStatusText(displayedRun);
  els.codexParallelStart.hidden = !editable;
  els.codexParallelStart.disabled = !editable;
  els.codexParallelRegenerate.hidden = !["draft", "failed"].includes(displayedRun.status);
  els.codexParallelRegenerate.disabled = !["draft", "failed"].includes(displayedRun.status);
  els.codexParallelAppendConfirm.hidden = codexParallelPendingAppendJobs.size === 0;
  els.codexParallelAppendConfirm.disabled = codexParallelBranchPlanning;
  els.codexParallelAppendConfirm.textContent = codexParallelPendingAppendJobs.size
    ? `确认加入 ${codexParallelPendingAppendJobs.size} 个分支`
    : "确认加入分支";
  const requiredContinuity = displayedRun.goal?.history?.length ? "stable" : "baseline";
  const auditVisible = reviewing && (!displayedRun.review?.goalAssessment
    || displayedRun.review.goalAssessment.alignment !== "aligned"
    || displayedRun.review.goalAssessment.continuity !== requiredContinuity
    || displayedRun.review?.goalAudit?.status === "failed");
  els.codexParallelAudit.hidden = !auditVisible;
  els.codexParallelAudit.disabled = !auditVisible;
  els.codexParallelOpen.hidden = !displayedRun.coordinator?.threadId;
  els.codexParallelMore.hidden = !displayedRun.coordinator?.threadId && !auditVisible;
  els.codexParallelReview.hidden = !reviewing;
  els.codexParallelRetry.hidden = !reviewing || failedTaskIds.size === 0;
  els.codexParallelRetry.disabled = !reviewing || failedTaskIds.size === 0;
  els.codexParallelReject.hidden = !reviewing;
  els.codexParallelReject.disabled = false;
  els.codexParallelAccept.hidden = !reviewing;
  els.codexParallelAccept.disabled = !displayedRun.review?.readyToAccept;
  els.codexParallelAccept.title = displayedRun.review?.readyToAccept
    ? "接受并应用；任务树同步在后台进行"
    : (displayedRun.review?.warnings?.[0] || "实现、目标推进和长期目标连续性都通过后才能接受");
  if (reviewing) {
    const files = displayedRun.review.changedFiles || [];
    const tests = [
      ...(displayedRun.jobs || []).flatMap((job) => job.testResults || []),
      ...(displayedRun.integrationTestResults || [])
    ];
    const passed = tests.filter((test) => test.ok).length;
    els.codexParallelFiles.textContent = `${files.length} 个文件`;
    els.codexParallelFiles.title = files.join("\n");
    els.codexParallelTests.textContent = tests.length ? `${passed}/${tests.length} 通过` : "未配置命令";
    els.codexParallelTests.title = tests.map((test) => `${test.ok ? "PASS" : "FAIL"} ${test.command}`).join("\n");
    els.codexParallelPatch.textContent = displayedRun.review.patchPreview || "没有文本差异";
    const warnings = displayedRun.review.warnings || [];
    els.codexParallelReviewWarning.hidden = warnings.length === 0;
    els.codexParallelReviewWarning.textContent = warnings.join("；");
  }
}

async function pollCodexParallelRun() {
  if (!codexParallelRunId || !els.codexParallelDialog.open) return;
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    const run = payload.run;
    renderParallelRun(run);
    if (parallelRunNeedsPolling(run)) codexParallelPollTimer = setTimeout(pollCodexParallelRun, 1200);
  } catch (error) {
    els.codexParallelState.textContent = `读取状态失败: ${error.message}`;
  }
}

async function generateCodexParallelPlan() {
  const objective = els.codexParallelObjective?.value.trim() || "";
  clearTimeout(codexParallelPollTimer);
  codexParallelPendingAppendJobs.clear();
  codexParallelBranchPlanning = false;
  codexParallelRunId = "";
  codexParallelRun = null;
  forgetCodexParallelRun();
  resetParallelDialog();
  els.codexParallelRegenerate.disabled = true;
  els.codexParallelState.textContent = "正在生成并行草案；模型较慢时会自动使用保守计划…";
  try {
    const res = await fetch("/api/codex/parallel/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    renderParallelRun(payload.run);
    if (payload.run.status === "planning") codexParallelPollTimer = setTimeout(pollCodexParallelRun, 600);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
    els.codexParallelRegenerate.disabled = false;
  }
}

async function resumeCodexParallelRun() {
  const savedId = rememberedCodexParallelRunId();
  if (!savedId) return false;
  try {
    const res = await fetch(`/api/codex/parallel/${savedId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!payload.run) throw new Error("运行记录为空");
    renderParallelRun(payload.run);
    if (parallelRunNeedsPolling(payload.run)) {
      codexParallelPollTimer = setTimeout(pollCodexParallelRun, payload.run.status === "planning" ? 600 : 400);
    }
    return true;
  } catch {
    forgetCodexParallelRun();
    return false;
  }
}

async function loadParallelContextOptions() {
  try {
    const res = await fetch("/api/codex/threads");
    const payload = await res.json();
    if (!res.ok) return;
    codexParallelContextOptions = (payload.threads || []).map((thread) => ({
      contextKey: `codex-${thread.id}`,
      threadId: thread.id,
      title: thread.name || thread.preview || thread.id.slice(0, 8),
      preview: thread.name ? thread.preview : "",
      source: "codex",
      updatedAt: thread.updatedAt || 0
    }));
    if (codexParallelRun) renderParallelRun(codexParallelRun);
  } catch {
    // A missing history list must not block the user from starting new independent branches.
  }
}

async function openCodexParallelDialog() {
  closeCodexThreadMenu();
  clearTimeout(codexParallelPollTimer);
  resetParallelDialog();
  if (!els.codexParallelDialog.open) els.codexParallelDialog.showModal();
  loadParallelContextOptions();
  if (!(await resumeCodexParallelRun())) {
    els.codexParallelObjective.value = "";
    generateCodexParallelPlan();
  }
}

function editableControlValue(row, selector, fallback = "") {
  const control = row.querySelector(selector);
  return control && "value" in control ? control.value.trim() : String(fallback || "").trim();
}

function captureParallelDraftEdits(run) {
  if (!codexParallelRun || codexParallelRun.id !== run?.id) return;
  if (codexParallelRun.status !== "draft" && codexParallelPendingAppendJobs.size === 0) return;
  for (const job of collectParallelJobs()) codexParallelDraftEdits.set(job.taskId, job);
}

function collectParallelJobs() {
  return [...els.codexParallelRows.querySelectorAll("tr")].map((row) => {
    const previous = codexParallelRun?.jobs?.find((job) => job.taskId === row.dataset.taskId) || {};
    const instruction = editableControlValue(row, ".codexParallelInstruction", previous.instruction);
    const writeSet = editableControlValue(row, ".codexParallelWriteSet", (previous.writeSet || []).join(", "));
    const dependsOn = editableControlValue(row, ".codexParallelDependsOn", (previous.dependsOn || []).join(", "));
    const dependencyPrompt = editableControlValue(row, ".codexParallelDependencyPrompt", previous.dependencyPrompt);
    const acceptancePrompt = editableControlValue(row, ".codexParallelAcceptancePrompt", previous.acceptancePrompt);
    const tests = editableControlValue(row, ".codexParallelJobTests", (previous.tests || []).join(" ; "));
    const title = editableControlValue(row, ".codexParallelTitleInput", previous.title);
    const nodeId = editableControlValue(row, ".codexParallelNodeId", previous.nodeId || row.dataset.nodeId);
    const context = row.querySelector(".codexParallelContextSelect");
    const selectedContext = context?.selectedOptions?.[0];
    const contextPolicy = context?.value === "new"
      ? "new"
      : (context?.value?.startsWith("selected:") ? "selected" : (previous.contextPolicy || "reuse"));
    const contextKey = contextPolicy === "selected"
      ? (selectedContext?.dataset.contextKey || "")
      : (contextPolicy === "new" ? "" : (context?.dataset.contextKey || previous.contextKey || ""));
    const contextThreadId = contextPolicy === "selected"
      ? (selectedContext?.dataset.contextThreadId || "")
      : (contextPolicy === "new" ? "" : (context?.dataset.contextThreadId || previous.contextThreadId || ""));
    const contextSource = contextPolicy === "selected"
      ? (selectedContext?.dataset.contextSource || "codex")
      : (contextPolicy === "new" ? "parallel" : (context?.dataset.contextSource || previous.contextSource || "parallel"));
    const contextPreview = contextPolicy === "selected"
      ? (selectedContext?.dataset.contextPreview || "")
      : (context?.dataset.contextPreview || previous.contextPreview || "");
    return {
      taskId: row.dataset.taskId,
      nodeId,
      title,
      summary: previous.summary || "",
      instruction,
      dependencyPrompt,
      acceptancePrompt,
      writeSet: writeSet.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
      dependsOn: dependsOn.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
      tests: tests.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean),
      contextPolicy,
      contextKey,
      contextThreadId,
      contextSource,
      contextPreview,
      contextLabel: previous.contextLabel || title || nodeId
    };
  });
}

async function planCodexParallelBranch() {
  if (!codexParallelRunId || !codexParallelRun || codexParallelBranchPlanning) return;
  const nodeId = els.codexParallelAppendNode?.value || codexParallelRun.goal?.stageNodeId || "";
  const existingJobs = collectParallelJobs();
  codexParallelBranchPlanning = true;
  els.codexParallelAddBranch.disabled = true;
  els.codexParallelState.textContent = `正在让模型按 ${nodeId} 生成一个可审核分支…`;
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/branch-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId,
        objective: els.codexParallelObjective?.value.trim() || codexParallelRun.objective || "",
        existingJobs
      })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    const job = { ...payload.proposal.job, status: "planned", testResults: [], pendingAppend: codexParallelRun.status !== "draft" };
    if (codexParallelRun.status === "draft") {
      const jobs = collectParallelJobs();
      jobs.push(job);
      renderParallelRun({ ...codexParallelRun, jobs }, { focusTaskId: job.taskId });
    } else {
      codexParallelPendingAppendJobs.set(job.taskId, job);
      renderParallelRun(codexParallelRun, { focusTaskId: job.taskId });
    }
    els.codexParallelState.textContent = payload.proposal.summary || "已生成分支草案，请审核后确认加入";
  } catch (error) {
    els.codexParallelState.textContent = error.message;
  } finally {
    codexParallelBranchPlanning = false;
    els.codexParallelAddBranch.disabled = false;
    els.codexParallelAppendConfirm.disabled = false;
  }
}

async function appendPendingCodexParallelBranches() {
  if (!codexParallelRunId || !codexParallelPendingAppendJobs.size) return;
  const contextError = validateParallelContextChoices();
  if (contextError) return;
  const jobs = collectParallelJobs().filter((job) => codexParallelPendingAppendJobs.has(job.taskId));
  codexParallelBranchPlanning = true;
  els.codexParallelState.textContent = "正在把已审核的新增分支加入调度队列…";
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobs })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    for (const job of jobs) {
      codexParallelPendingAppendJobs.delete(job.taskId);
      codexParallelDraftEdits.delete(job.taskId);
    }
    renderParallelRun(payload.run, { focusTaskId: jobs[0]?.taskId || "" });
    if (parallelRunNeedsPolling(payload.run)) codexParallelPollTimer = setTimeout(pollCodexParallelRun, 400);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
  } finally {
    codexParallelBranchPlanning = false;
    els.codexParallelAddBranch.disabled = false;
    els.codexParallelAppendConfirm.disabled = false;
  }
}

function removeCodexParallelBranch(taskId) {
  if (codexParallelPendingAppendJobs.has(taskId)) {
    codexParallelPendingAppendJobs.delete(taskId);
    renderParallelRun(codexParallelRun);
    return;
  }
  if (codexParallelRun?.status !== "draft") return;
  const jobs = collectParallelJobs();
  if (jobs.length <= 2) {
    els.codexParallelState.textContent = "并行计划至少保留 2 个分支";
    return;
  }
  const nextJobs = jobs
    .filter((job) => job.taskId !== taskId)
    .map((job) => ({ ...job, dependsOn: job.dependsOn.filter((id) => id !== taskId) }));
  renderParallelRun({ ...codexParallelRun, jobs: nextJobs });
}

function parallelDraftError(jobs) {
  if (jobs.length < 2) return "并行计划至少需要 2 个分支";
  const contextError = validateParallelContextChoices();
  if (contextError) return contextError.message;
  for (const job of jobs) {
    if (!job.nodeId) return { taskId: job.taskId, selector: ".codexParallelNodeId", message: `${job.title || job.taskId} 需要填写节点 ID` };
    if (!job.instruction) return { taskId: job.taskId, selector: ".codexParallelInstruction", message: `${job.title || job.taskId} 需要填写完整任务` };
    if (!job.writeSet.length) return { taskId: job.taskId, selector: ".codexParallelWriteSet", message: `${job.title || job.taskId} 需要填写分支负责修改的文件范围` };
  }
  return null;
}

function showParallelDraftError(error) {
  if (typeof error === "string") {
    els.codexParallelState.textContent = error;
    return;
  }
  const row = [...els.codexParallelRows.querySelectorAll("tr")].find((item) => item.dataset.taskId === error.taskId);
  const details = row?.querySelector(".codexParallelJobSettings");
  const control = row?.querySelector(error.selector);
  if (details) details.open = true;
  if (control) {
    control.setAttribute("aria-invalid", "true");
    control.focus();
    control.scrollIntoView({ block: "center", inline: "nearest" });
  }
  els.codexParallelState.textContent = error.message;
}

async function startCodexParallel(event) {
  event.preventDefault();
  if (!codexParallelRunId || codexParallelRun?.status !== "draft") return;
  els.codexParallelRows.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute("aria-invalid"));
  const jobs = collectParallelJobs();
  const draftError = parallelDraftError(jobs);
  if (draftError) {
    showParallelDraftError(draftError);
    return;
  }
  els.codexParallelStart.disabled = true;
  els.codexParallelRegenerate.disabled = true;
  els.codexParallelState.textContent = "正在冻结审核计划和当前工作区快照…";
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: els.codexParallelObjective?.value.trim() || "",
        jobs,
        integrationTests: codexParallelRun.integrationTests || []
      })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    codexParallelDraftEdits.clear();
    renderParallelRun(payload.run);
    codexParallelPollTimer = setTimeout(pollCodexParallelRun, 400);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
    els.codexParallelStart.disabled = false;
    els.codexParallelRegenerate.disabled = false;
  }
}

async function retryFailedCodexParallel() {
  if (!codexParallelRunId || codexParallelRun?.status !== "review" || !codexParallelRun.review?.failedTasks?.length) return;
  els.codexParallelRetry.disabled = true;
  els.codexParallelReject.disabled = true;
  els.codexParallelState.textContent = "正在冻结失败分支修订，已通过分支保持不变…";
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobs: collectParallelJobs(), integrationTests: codexParallelRun.integrationTests || [] })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    renderParallelRun(payload.run);
    codexParallelPollTimer = setTimeout(pollCodexParallelRun, 400);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
    els.codexParallelRetry.disabled = false;
    els.codexParallelReject.disabled = false;
  }
}

async function finishCodexParallel(action) {
  if (!codexParallelRunId) return;
  els.codexParallelAccept.disabled = true;
  els.codexParallelRetry.disabled = true;
  els.codexParallelReject.disabled = true;
  els.codexParallelState.textContent = action === "accept" ? "正在应用已审核的差异…" : "正在丢弃隔离工作区…";
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    renderParallelRun(payload.run);
    if (!parallelRunTerminal(payload.run)) codexParallelPollTimer = setTimeout(pollCodexParallelRun, 400);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
    els.codexParallelAccept.disabled = !codexParallelRun?.review?.readyToAccept;
    els.codexParallelRetry.disabled = !codexParallelRun?.review?.failedTasks?.length;
    els.codexParallelReject.disabled = false;
  }
}

async function auditCodexParallelGoal() {
  if (!codexParallelRunId || codexParallelRun?.status !== "review") return;
  els.codexParallelAudit.disabled = true;
  els.codexParallelState.textContent = "正在核验目标";
  try {
    const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    renderParallelRun(payload.run);
    codexParallelPollTimer = setTimeout(pollCodexParallelRun, 400);
  } catch (error) {
    els.codexParallelState.textContent = error.message;
    els.codexParallelAudit.disabled = false;
  }
}

async function openParallelCoordinator() {
  if (!codexParallelRunId) return;
  const res = await fetch(`/api/codex/parallel/${codexParallelRunId}/open`, { method: "POST" });
  const payload = await res.json();
  if (!res.ok) els.codexParallelState.textContent = payload.error || `HTTP ${res.status}`;
}

function renderCodexThreadMenu({ threads = [], systemThreads = [], systemThreadCount = systemThreads.length, pinned = "", presets = [] } = {}) {
  const menu = els.codexThreadMenu;
  menu.textContent = "";
  menu.append(codexMenuGroup("发什么（发到下面选中的会话）"));
  menu.append(codexAskBox());

  for (const preset of presets) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "codexThreadItem";
    item.append(document.createTextNode(preset.label));
    if (preset.blocked || preset.hint) {
      const meta = document.createElement("span");
      meta.className = "codexThreadMeta";
      meta.textContent = preset.blocked || preset.hint;
      item.append(meta);
    }
    if (preset.blocked) {
      item.disabled = true;
      item.classList.add("blocked");
    } else {
      item.addEventListener("click", () => runCodex({ preset: preset.id }));
    }
    menu.append(item);
  }

  const parallel = document.createElement("button");
  parallel.type = "button";
  parallel.id = "codexParallelMenuItem";
  parallel.className = "codexThreadItem";
  parallel.textContent = "⇉ 并行推进多个节点";
  parallel.addEventListener("click", openCodexParallelDialog);
  menu.append(parallel);

  menu.append(document.createElement("hr"), codexMenuGroup("发到哪"));

  const fresh = document.createElement("button");
  fresh.type = "button";
  fresh.className = pinned ? "codexThreadItem" : "codexThreadItem current";
  fresh.textContent = `${pinned ? "" : "● "}＋ 新开一条会话`;
  fresh.addEventListener("click", () => pinCodexThread(""));
  menu.append(fresh);

  for (const thread of threads) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = thread.id === pinned ? "codexThreadItem current" : "codexThreadItem";

    // One line per conversation: several turns of the same prompt look like one wall of text
    // when they are allowed to wrap, and then the list is unreadable exactly when it is longest.
    const title = document.createElement("span");
    title.className = "codexThreadTitle";
    title.textContent = `${thread.id === pinned ? "● " : ""}${thread.name || thread.preview || thread.id.slice(0, 8)}`;
    item.append(title);

    const meta = document.createElement("span");
    meta.className = "codexThreadMeta";
    const when = thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : "";
    meta.textContent = [when, thread.name ? thread.preview : ""].filter(Boolean).join(" · ");
    item.append(meta);

    item.addEventListener("click", () => pinCodexThread(thread.id));
    menu.append(item);
  }

  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "codexThreadEmpty";
    empty.textContent = "这个项目还没有 Codex 会话";
    menu.append(empty);
  }

  if (systemThreads.length) {
    const details = document.createElement("details");
    details.className = "codexThreadSystemDetails";
    const summary = document.createElement("summary");
    summary.textContent = `任务图内部会话（已收纳 ${systemThreadCount} 条）`;
    details.append(summary);
    const labels = {
      planner: "自动规划",
      "branch-planner": "新增分支规划",
      worker: "并行分支",
      coordinator: "结果汇总",
      sync: "任务树同步",
      internal: "内部任务"
    };
    const grouped = new Map();
    for (const thread of systemThreads) {
      const kind = thread.kind || "internal";
      if (!grouped.has(kind)) grouped.set(kind, []);
      grouped.get(kind).push(thread);
    }
    const visibleSystemThreads = [];
    for (const [kind, group] of grouped) {
      if (kind === "worker") visibleSystemThreads.push(...group.map((thread) => ({ thread, kind, count: 1 })));
      else visibleSystemThreads.push({ thread: group[0], kind, count: group.length });
    }
    for (const { thread, kind, count } of visibleSystemThreads) {
      const item = document.createElement("a");
      item.className = "codexThreadSystemItem";
      item.href = `codex://threads/${encodeURIComponent(thread.id)}`;
      const title = document.createElement("span");
      title.className = "codexThreadTitle";
      title.textContent = kind === "worker"
        ? (thread.name || labels[kind])
        : labels[kind] || "内部任务";
      const meta = document.createElement("span");
      meta.className = "codexThreadMeta";
      const when = thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : "";
      meta.textContent = [count > 1 ? `${count} 条历史` : "", when, "打开"].filter(Boolean).join(" · ");
      item.append(title, meta);
      details.append(item);
    }
    menu.append(details);
  }

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "codexThreadItem";
  refresh.textContent = "↻ 刷新会话";
  refresh.addEventListener("click", () => loadCodexThreadMenu(0, true));
  menu.append(refresh);
}

async function loadCodexThreadMenu(attempt = 0, refresh = false) {
  try {
    const res = await fetch(refresh ? "/api/codex/threads?refresh=1" : "/api/codex/threads");
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    codexParallelContextOptions = (payload.threads || []).map((thread) => ({
      contextKey: `codex-${thread.id}`,
      threadId: thread.id,
      title: thread.name || thread.preview || thread.id.slice(0, 8),
      preview: thread.name ? thread.preview : "",
      source: "codex",
      updatedAt: thread.updatedAt || 0
    }));
    renderCodexThreadMenu(payload);
    if ((payload.cache === "warming" || payload.cache === "refreshing") && attempt < 30) {
      const loading = document.createElement("p");
      loading.className = "codexThreadEmpty";
      loading.textContent = payload.cache === "refreshing" ? "正在刷新，旧列表仍可选择" : "历史会话正在后台读取，不影响直接发送";
      els.codexThreadMenu.append(loading);
      codexThreadRefreshTimer = setTimeout(() => {
        if (!els.codexThreadMenu.classList.contains("hidden")) loadCodexThreadMenu(attempt + 1);
      }, 1000);
    }
  } catch (error) {
    els.codexThreadMenu.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "codexThreadEmpty";
    failed.textContent = `读不到会话列表: ${error.message}`;
    els.codexThreadMenu.append(failed);
  }
}

async function openCodexThreadMenu() {
  els.codexThreadMenu.classList.remove("hidden");
  els.codexThreadsBtn.setAttribute("aria-expanded", "true");
  els.codexThreadMenu.innerHTML = "";
  els.codexThreadMenu.append(codexMenuGroup("正在打开，可先直接发送"), codexAskBox());
  await loadCodexThreadMenu();
}

// The plain click runs the tree's own next step. Embedding the graph into a chat used to be the
// default, which only made sense while the chat was where the graph lived; from the full page it
// would spend a turn to show what is already on screen. It stays in the menu.
els.openInCodexBtn?.addEventListener("click", () => runCodex({ preset: "next" }));
els.codexParallelBtn?.addEventListener("click", () => openCodexParallelDialog());

// The loop used to mean "copy this command, switch to Codex, paste, press enter". Now that the
// page can start a turn itself, the chain bar spends that same turn on one click.
els.chainRunBtn?.addEventListener("click", () => runCodex({ preset: "chain" }));

function closeProjectMenu() {
  els.projectMenu?.classList.add("hidden");
  els.projectSwitchBtn?.setAttribute("aria-expanded", "false");
}

/**
 * Every project has its own server on its own fixed port, so switching means starting that one
 * (if it is asleep) and moving this window there. Its tree, its chain and its Codex conversation
 * all come with it, because they live in that project, not in this window.
 */
async function switchProject(root, name) {
  closeProjectMenu();
  setSaveState(`正在打开 ${name}...`);
  try {
    const res = await fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    window.location.href = payload.url;
  } catch (error) {
    setSaveState(`打不开 ${name}: ${error.message}`);
  }
}

function renderProjectMenu({ projects = [] } = {}) {
  const menu = els.projectMenu;
  menu.textContent = "";
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "codexThreadEmpty";
    empty.textContent = "本机还没有别的任务图项目";
    menu.append(empty);
    return;
  }

  for (const project of projects) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = project.current ? "projectItem current" : "projectItem";
    item.append(document.createTextNode(`${project.current ? "● " : ""}${project.name}`));

    const meta = document.createElement("span");
    meta.className = "codexThreadMeta";
    meta.textContent = `${project.root} · :${project.port}`;
    item.append(meta);

    if (project.current) item.disabled = true;
    else item.addEventListener("click", () => switchProject(project.root, project.name));
    menu.append(item);
  }
}

async function openProjectMenu() {
  els.projectMenu.classList.remove("hidden");
  els.projectSwitchBtn.setAttribute("aria-expanded", "true");
  els.projectMenu.innerHTML = "<p class=\"codexThreadEmpty\">正在读取项目...</p>";
  try {
    const res = await fetch("/api/projects");
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    renderProjectMenu(payload);
  } catch (error) {
    els.projectMenu.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "codexThreadEmpty";
    failed.textContent = `读不到项目列表: ${error.message}`;
    els.projectMenu.append(failed);
  }
}

els.projectSwitchBtn?.addEventListener("click", () => {
  if (els.projectMenu.classList.contains("hidden")) openProjectMenu();
  else closeProjectMenu();
});

els.codexThreadsBtn?.addEventListener("click", () => {
  if (els.codexThreadMenu.classList.contains("hidden")) openCodexThreadMenu();
  else closeCodexThreadMenu();
});
els.codexParallelClose?.addEventListener("click", () => els.codexParallelDialog.close());
els.codexParallelForm?.addEventListener("submit", startCodexParallel);
els.codexParallelRegenerate?.addEventListener("click", generateCodexParallelPlan);
els.codexParallelAddBranch?.addEventListener("click", planCodexParallelBranch);
els.codexParallelAppendConfirm?.addEventListener("click", appendPendingCodexParallelBranches);
els.codexParallelOpen?.addEventListener("click", openParallelCoordinator);
els.codexParallelAudit?.addEventListener("click", auditCodexParallelGoal);
els.codexParallelRetry?.addEventListener("click", retryFailedCodexParallel);
els.codexParallelReject?.addEventListener("click", () => finishCodexParallel("reject"));
els.codexParallelAccept?.addEventListener("click", () => finishCodexParallel("accept"));
els.codexParallelDialog?.addEventListener("close", () => clearTimeout(codexParallelPollTimer));

document.addEventListener("click", (event) => {
  if (!els.codexThreadMenu?.classList.contains("hidden") && !event.target.closest(".codexLaunch")) {
    closeCodexThreadMenu();
  }
  if (!els.projectMenu?.classList.contains("hidden") && !event.target.closest(".projectSwitch")) {
    closeProjectMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeCodexThreadMenu();
  closeProjectMenu();
});
els.shutdownBtn?.addEventListener("click", async () => {
  if (dirty) {
    setSaveState("请先保存再关闭后台");
    return;
  }
  setSaveState("正在关闭后台...");
  try {
    await fetch("/api/shutdown", { method: "POST", keepalive: true });
    setSaveState("后台已关闭");
    setTimeout(() => {
      document.body.innerHTML = "<main class=\"shutdownScreen\"><h1>后台已关闭</h1><p>重新双击“打开任务图.cmd”即可启动。</p></main>";
    }, 250);
  } catch (error) {
    setSaveState(`关闭失败: ${error.message}`);
  }
});
els.kbReindexBtn?.addEventListener("click", () => reindexKnowledge());
els.kbReindexAllBtn?.addEventListener("click", () => reindexKnowledge({ all: true }));
els.kbLibrarySelect?.addEventListener("change", () => saveKnowledgeLibraryPreferences());
els.kbSearchAllLibraries?.addEventListener("change", () => saveKnowledgeLibraryPreferences());
els.kbRetrievalMaxChunks?.addEventListener("input", () => updateRetrievalSliderLabels());
els.kbRetrievalPool?.addEventListener("input", () => updateRetrievalSliderLabels());
els.kbRetrievalSaveBtn?.addEventListener("click", () => saveKnowledgeRetrievalConfig());
els.kbSearchBtn?.addEventListener("click", () => searchKnowledgeFromPanel());
els.kbAskBtn?.addEventListener("click", () => askKnowledgeFromPanel());
els.kbClearHistoryBtn?.addEventListener("click", () => clearKnowledgeHistory());
els.toggleLeftPaneBtn?.addEventListener("click", () => toggleLeftPane());
els.toggleRightPaneBtn?.addEventListener("click", () => toggleRightPane());
els.toggleChainDockBtn?.addEventListener("click", () => toggleChainDock());
els.chainAutoAdvanceBtn?.addEventListener("click", () => toggleChainAutoAdvance());
els.chainClearBtn?.addEventListener("click", () => clearChain());
wireChainLoopHelp();

initPaneCollapseState();
initChainDockCollapseState();
initEdgeDimOpacityControl();
syncNodeCardCompactButton();

els.graphViewport.addEventListener("wheel", (event) => {
  if (event.target.closest(".focusLens, .edgeEditor, input, textarea, select")) return;
  const scrollableNode = event.target.closest(".graphNode");
  if (scrollableNode) {
    const canScrollUp = scrollableNode.scrollTop > 0;
    const canScrollDown = scrollableNode.scrollTop + scrollableNode.clientHeight < scrollableNode.scrollHeight - 1;
    if ((event.deltaY < 0 && canScrollUp) || (event.deltaY > 0 && canScrollDown)) return;
  }
  event.preventDefault();
  const rect = els.graphViewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const beforeX = (mouseX - graphView.x) / graphView.scale;
  const beforeY = (mouseY - graphView.y) / graphView.scale;
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  const nextScale = graphView.scale * factor;
  graphView.scale = clamp(nextScale, 0.28, GRAPH_MAX_SCALE);
  graphView.x = mouseX - beforeX * graphView.scale;
  graphView.y = mouseY - beforeY * graphView.scale;
  applyGraphTransform();
}, { passive: false });

els.focusLensClose?.addEventListener("click", () => closeFocusLens({ locate: true }));
els.focusLensBody?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-focus-lens-action]");
  if (action) {
    handleFocusLensAction(action.getAttribute("data-focus-lens-action"), focusLensId);
    return;
  }
  const target = event.target.closest("[data-focus-lens-node]");
  if (target) openFocusLens(target.getAttribute("data-focus-lens-node"));
});
els.focusLensBody?.addEventListener("input", (event) => {
  const input = event.target.closest("[data-focus-lens-next-idea]");
  if (!input) return;
  const nodeId = input.getAttribute("data-focus-lens-next-idea");
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  node.nextIdea = input.value.trim();
  syncReadFingerprintIfMarked(node);
  markDirty(`将修改${nodeTitle(nodeId)}的下一步思路`);
});
els.focusLensBody?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || !event.target.closest("[data-focus-lens-next-idea]")) return;
  event.preventDefault();
  runFocusLensNode(focusLensId).catch((error) => setSaveState(`Codex 没能启动: ${error.message}`));
});
els.focusLensTrail?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-focus-lens-node]");
  if (target) openFocusLens(target.getAttribute("data-focus-lens-node"));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && focusLensOpen && !els.focusLens?.hidden) closeFocusLens({ locate: true });
});

els.graphViewport.addEventListener("pointerdown", (event) => {
  if (event.target !== els.graphViewport && event.target !== els.graphCanvas && event.target !== els.edges && event.target !== els.nodesLayer) return;
  event.preventDefault();
  els.graphViewport.setPointerCapture(event.pointerId);
  const start = { x: event.clientX, y: event.clientY, viewX: graphView.x, viewY: graphView.y };

  function move(moveEvent) {
    graphView.x = start.viewX + moveEvent.clientX - start.x;
    graphView.y = start.viewY + moveEvent.clientY - start.y;
    applyGraphTransform();
  }

  function up() {
    els.graphViewport.removeEventListener("pointermove", move);
    els.graphViewport.removeEventListener("pointerup", up);
    els.graphViewport.removeEventListener("pointercancel", up);
  }

  els.graphViewport.addEventListener("pointermove", move);
  els.graphViewport.addEventListener("pointerup", up);
  els.graphViewport.addEventListener("pointercancel", up);
});

window.addEventListener("beforeunload", () => {
  if (!dirty || saveInFlight) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const markdown = toMarkdown(nodes, edges);
  const payload = JSON.stringify({
    markdown,
    reason: pendingSaveReason || "将自动保存图谱修改",
    backup: false,
    source: "ui",
    treeId: viewTreeId
  });
  fetch(treeApiUrl("/api/tree"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
});

let flowViewApi = null;

async function ensureFlowView() {
  if (flowViewApi) return flowViewApi;
  const host = document.getElementById("flowViewHost");
  if (!host) return null;
  const mod = await import(moduleUrl("/flow-view.js"));
  flowViewApi = mod.initFlowView({ rootEl: host });
  return flowViewApi;
}

function setGraphView(view) {
  if (view === "flow" && !isViewingActiveMethodTree()) {
    setSaveState("执行流程只绑定活动方法树；请先切换到活动方法树");
    view = "tree";
  }
  const pane = document.querySelector(".graphPane");
  const host = document.getElementById("flowViewHost");
  document.querySelectorAll(".graphViewBtn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.graphView === view);
  });
  if (view === "flow") {
    pane?.classList.add("is-flowView");
    if (host) {
      host.hidden = false;
      host.classList.add("is-visible");
    }
    ensureFlowView()
      .then((fv) => fv?.reload())
      .catch((error) => console.error("[flow-view]", error));
  } else {
    pane?.classList.remove("is-flowView");
    if (host) {
      host.hidden = true;
      host.classList.remove("is-visible");
    }
  }
  if (els.focusLens) els.focusLens.hidden = view !== "tree" || !focusLensOpen;
  if (view === "tree" && focusLensOpen) renderFocusLens();
  syncFocusLensToolbarButton();
}

document.querySelectorAll(".graphViewBtn").forEach((btn) => {
  btn.addEventListener("click", () => setGraphView(btn.dataset.graphView || "tree"));
});

document.getElementById("exportTreeSvgBtn")?.addEventListener("click", () => {
  exportTreeSvgFile().catch((error) => setSaveState(error.message));
});

document.getElementById("exportFlowSvgBtn")?.addEventListener("click", () => {
  exportFlowSvgFile().catch((error) => setSaveState(error.message));
});

async function exportTreeSvgFile() {
  const mod = await loadGraphExportModule();
  const snapshot = snapshotGraphLayout();
  graphExportSession = true;
  try {
    setSaveState("导出中：撑高节点并树形排版…");
    applyExportNodeSizesForLayout(mod);
    layoutAsTree({ silent: true, skipFitView: true });
    await waitNextFrame(2);

    const bounds = getExportBounds();
    if (!bounds) {
      setSaveState("没有可导出的节点");
      return;
    }

    const svg = await mod.exportLiveGraphSvg({
      edgesMarkup: els.edges.innerHTML,
      nodeElements: [...els.nodesLayer.querySelectorAll(".graphNode")],
      edgeLabels: buildEdgeLabelExportData(),
      bounds,
      padding: 48
    });
    if (!svg) {
      setSaveState("没有可导出的节点");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    mod.downloadSvg(svg, `task-tree-graph-${stamp}.svg`);
    setSaveState("已导出关系图 SVG（与界面一致）");
  } catch (error) {
    setSaveState(`导出失败: ${error.message}`);
  } finally {
    graphExportSession = false;
    restoreGraphLayout(snapshot);
    renderTree();
    scheduleFitGraphToViewport();
  }
}

function snapshotGraphLayout() {
  return nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height
  }));
}

function restoreGraphLayout(snapshot) {
  for (const item of snapshot) {
    const node = nodes.find((entry) => entry.id === item.id);
    if (!node) continue;
    node.x = item.x;
    node.y = item.y;
    node.width = item.width;
    node.height = item.height;
  }
}

function applyExportNodeSizesForLayout(mod) {
  for (const node of nodes) {
    const measureNode = node.id === nextFocusId ? { ...node, nextPlan } : node;
    const layout = mod.measureExportNode(
      measureNode,
      Math.max(nodeWidth(node), mod.MIN_EXPORT_WIDTH || 520),
      isNodeFolded(node),
      { includeNextPlan: node.id === nextFocusId || node.id === currentFocusId }
    );
    node.width = layout.width;
    node.height = layout.height;
  }
}

function buildEdgeLabelExportData() {
  return edges.map((edge) => {
    const points = edge.endpoints.map(getNodePort).filter(Boolean);
    if (points.length < 2) return null;
    const label = String(edge.label || "").trim();
    if (!label) return null;
    const hub = edgeHub(points, edge);
    return { x: hub.x, y: hub.y - 10, text: label };
  }).filter(Boolean);
}

function getExportBounds() {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = node.x || 0;
    const y = node.y || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + nodeWidth(node));
    maxY = Math.max(maxY, y + nodeHeight(node));
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function waitNextFrame(count = 1) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      if (left <= 0) {
        resolve();
        return;
      }
      left -= 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function exportFlowSvgFile() {
  try {
    const fv = await ensureFlowView();
    if (!fv?.exportFlowSvg) {
      setSaveState("执行流程模块未加载，请刷新页面后重试");
      return;
    }
    const ok = await fv.exportFlowSvg();
    setSaveState(ok ? "已导出流程图 SVG（矢量图）" : "流程图为空：请先在执行流程视图添加脚本块");
  } catch (error) {
    setSaveState(`导出失败: ${error.message}`);
  }
}

loadTreeRegistryState()
  .then(() => loadTree({ registryLoaded: true, fitView: snapshotMode || embedMode }))
  .then(() => (snapshotMode ? enterSnapshotMode() : signalEmbedHost("rendered")))
  .then(() => (embedMode && !snapshotMode ? enterEmbedLayout() : null))
  .catch((error) => setSaveState(formatApiFetchError(error, null, "加载任务图")));

// Snapshot mode renders once for a screenshot; polling would only repaint under the camera.
if (!snapshotMode) {
  // In the chat widget every request is a tool call across the host bridge, which is far more
  // expensive than a loopback GET, so the background polling backs off.
  const pace = embedMode ? 4 : 1;
  reloadTimer = setInterval(() => {
    pollTreeChanges().catch(() => {});
  }, 1400 * pace);
  setInterval(() => {
    probeBackendConnection().catch(() => {});
  }, 12000 * pace);
  setInterval(() => {
    loadMaintenanceStatus().catch(() => {});
  }, 15000 * pace);
}
