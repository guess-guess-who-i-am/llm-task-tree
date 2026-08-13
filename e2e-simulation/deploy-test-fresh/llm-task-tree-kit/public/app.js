const nodeFields = ["problem", "approach", "input", "output", "metrics", "notes"];
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
  SelectedSkills: "selectedSkills"
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
let currentFocusId = "";
let nextFocusId = "";
let nextPlan = "";
let dirty = false;
let draftLink = null;
let saveTimer = null;
let saveInFlight = false;
let saveAgain = false;
let editNodeId = null;
let editEdgeId = null;
let lastLoadedMarkdown = "";
let lastSavedMarkdown = "";
let reloadTimer = null;
let versions = [];
let pendingSaveReason = "";
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
let modelRunResults = [];
let modelConversations = {};
let knowledgeConfig = null;
let knowledgeIndex = null;
let webSearchConfig = null;
let knowledgeResults = [];
let knowledgeAnswer = "";
let knowledgeLoading = false;
let knowledgeError = "";
let knowledgeReindexJob = null;
const floatingPanelOffsets = { io: {}, skill: {}, model: {} };
const graphView = { x: 40, y: 34, scale: 0.88 };
const card = { width: 400, height: 720, minWidth: 320, minHeight: 420 };

const els = {
  graphViewport: document.querySelector("#graphViewport"),
  graphCanvas: document.querySelector("#graphCanvas"),
  edges: document.querySelector("#edges"),
  edgeLabels: document.querySelector("#edgeLabels"),
  nodesLayer: document.querySelector("#nodesLayer"),
  nodeCount: document.querySelector("#nodeCount"),
  linkState: document.querySelector("#linkState"),
  saveState: document.querySelector("#saveState"),
  versionState: document.querySelector("#versionState"),
  versionList: document.querySelector("#versionList"),
  addChildBtn: document.querySelector("#addChildBtn"),
  layoutTreeBtn: document.querySelector("#layoutTreeBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  reloadBtn: document.querySelector("#reloadBtn"),
  shutdownBtn: document.querySelector("#shutdownBtn"),
  knowledgeState: document.querySelector("#knowledgeState"),
  kbEnvInfo: document.querySelector("#kbEnvInfo"),
  kbReindexBtn: document.querySelector("#kbReindexBtn"),
  kbQuestion: document.querySelector("#kbQuestion"),
  kbUseForModels: document.querySelector("#kbUseForModels"),
  kbUseWebSearch: document.querySelector("#kbUseWebSearch"),
  kbSearchBtn: document.querySelector("#kbSearchBtn"),
  kbAskBtn: document.querySelector("#kbAskBtn"),
  kbIndexInfo: document.querySelector("#kbIndexInfo"),
  kbAnswer: document.querySelector("#kbAnswer"),
  kbResults: document.querySelector("#kbResults")
};

function parseMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const parsedNodes = [];
  const parsedEdges = [];
  const graphState = { current: "", next: "", nextPlan: "" };
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
      const stateField = line.match(/^-\s+(Current|Next|NextPlan):\s*(.*)$/);
      if (stateField) {
        if (stateField[1] === "Current") graphState.current = sanitizeId(stateField[2]);
        if (stateField[1] === "Next") graphState.next = sanitizeId(stateField[2]);
        if (stateField[1] === "NextPlan") graphState.nextPlan = stateField[2].trim();
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
        legacyParent: ""
      };
      activeField = null;
      continue;
    }

    if (!current) continue;

    const nodeField = line.match(/^-\s+(Position|Size|Completion|Problem|Approach|Input|Output|Metrics|Notes|CurrentResult|RootCauseAnalysis|CaseStudy|NextIdea|SelectedSkills|Parent|Status):\s*(.*)$/);
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
      else current[activeField] = current[activeField] ? `${current[activeField]}\n${value}` : value;
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
    "> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；边可以连接两个或多个节点。",
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
    bulletBlock("CurrentResult", node.currentResult),
    bulletBlock("RootCauseAnalysis", node.rootCauseAnalysis),
    bulletBlock("CaseStudy", node.caseStudy),
    bulletBlock("NextIdea", node.nextIdea),
    bulletBlock("SelectedSkills", node.selectedSkills)
  ].join("\n"));

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
    bulletBlock("NextPlan", nextPlan)
  ].join("\n");

  return `${header.join("\n")}${nodeBody.join("\n\n")}\n\n${stateBody}\n\n# Edges\n\n${edgeBody.join("\n\n")}\n`;
}

function bulletBlock(label, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return `- ${label}:`;
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return `- ${label}: ${lines[0] || ""}`;
  return [`- ${label}:`, ...lines.map((line) => `  - ${line}`)].join("\n");
}

function renderTree() {
  els.nodeCount.textContent = `${nodes.length} nodes · ${edges.length} edges`;
  els.linkState.textContent = draftLink ? " · 正在拖动连接线" : "";
  const positionsChanged = ensureNodePositions();
  for (const node of nodes) ensureNodeSize(node);
  const highlights = getFocusHighlights();

  const canvasWidth = Math.max(5000, ...nodes.map((node) => (node.x || 0) + nodeWidth(node) + 420));
  const canvasHeight = Math.max(3200, ...nodes.map((node) => (node.y || 0) + nodeHeight(node) + 360));

  els.graphCanvas.style.width = `${canvasWidth}px`;
  els.graphCanvas.style.height = `${canvasHeight}px`;
  applyGraphTransform();
  els.edges.setAttribute("width", canvasWidth);
  els.edges.setAttribute("height", canvasHeight);
  els.edges.setAttribute("viewBox", `0 0 ${canvasWidth} ${canvasHeight}`);
  els.nodesLayer.innerHTML = "";

  for (const node of nodes) {
    const nodeCard = document.createElement("article");
    nodeCard.className = `graphNode${node.id === selectedId ? " selected" : ""}`;
    if (isNodeComplete(node)) nodeCard.classList.add("completed");
    if (node.id === editNodeId) nodeCard.classList.add("editing");
    if (highlights.currentNodes.has(node.id)) nodeCard.classList.add("currentPath");
    if (highlights.nextNodes.has(node.id)) nodeCard.classList.add("nextPath");
    if (node.id === currentFocusId) nodeCard.classList.add("currentFocus");
    if (node.id === nextFocusId) nodeCard.classList.add("nextFocus");
    nodeCard.style.left = `${node.x}px`;
    nodeCard.style.top = `${node.y}px`;
    nodeCard.style.width = `${nodeWidth(node)}px`;
    nodeCard.style.height = `${nodeHeight(node)}px`;
    nodeCard.dataset.nodeId = node.id;
    nodeCard.innerHTML = renderNodeCard(node);
    wireNodeCard(nodeCard, node.id);
    els.nodesLayer.appendChild(nodeCard);
  }
  renderIoPreview(highlights);
  renderSkillPanel(highlights);
  renderModelPanel(highlights);

  rerenderEdges();
  if (positionsChanged && !dirty && !saveInFlight) markDirty("将补齐节点位置避免图谱重叠");
}

function renderIoPreview(highlights) {
  const node = nodes.find((item) => item.id === selectedId);
  if (!node) return;
  const preview = document.createElement("aside");
  preview.className = "ioPreview";
  if (highlights.currentNodes.has(node.id)) preview.classList.add("currentPath");
  if (highlights.nextNodes.has(node.id)) preview.classList.add("nextPath");
  const width = 320;
  const gap = 14;
  const baseX = Math.max(0, (node.x || 0) - width - gap);
  const baseY = node.y || 0;
  const offset = floatingPanelOffsets.io[node.id] || { x: 0, y: 0 };
  preview.style.left = `${Math.max(0, baseX + offset.x)}px`;
  preview.style.top = `${Math.max(0, baseY + offset.y)}px`;
  preview.style.width = `${width}px`;
  preview.style.height = `${nodeHeight(node)}px`;
  preview.innerHTML = `
    <div class="floatingPanelHeader" data-panel-drag="io">
      <strong>输入 / 输出</strong>
      <span>拖动标题栏移动</span>
    </div>
    <section class="ioPreviewSection">
      <span class="ioPreviewLabel">输入</span>
      ${ioPreviewBody(node.input)}
    </section>
    <section class="ioPreviewSection">
      <span class="ioPreviewLabel">输出</span>
      ${ioPreviewBody(node.output)}
    </section>
  `;
  preview.querySelector("[data-panel-drag='io']").addEventListener("pointerdown", (event) => {
    startFloatingPanelDrag(event, preview, "io", node.id, baseX, baseY);
  });
  els.nodesLayer.appendChild(preview);
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
  const items = skillRecommendations.map((skill) => `
    <label class="skillOption">
      <input type="checkbox" value="${attr(skill.id)}" ${selected.has(skill.id) ? "checked" : ""}>
      <span>${escapeHtml(skill.functionText || skill.description)}</span>
    </label>
  `).join("");
  return `
    <div class="skillPanelHeader floatingPanelHeader" data-panel-drag="skill">
      <strong>可用能力</strong>
      <button type="button" data-skill-close title="关闭">×</button>
    </div>
    <div class="skillPanelList">
      ${items || `<div class="skillPanelEmpty">没有找到明显匹配的能力，可以先把下一步写得更具体。</div>`}
    </div>
    <div class="skillPanelFooter">
      ${skillApplyNotice ? `<span class="skillApplyNotice">${escapeHtml(skillApplyNotice)}</span>` : ""}
      <button type="button" data-skill-apply>使用勾选能力</button>
    </div>
  `;
}

function wireSkillPanel(panel, node, baseX, baseY) {
  panel.querySelector("[data-panel-drag='skill']")?.addEventListener("pointerdown", (event) => {
    startFloatingPanelDrag(event, panel, "skill", node.id, baseX, baseY);
  });
  panel.querySelector("[data-skill-close]")?.addEventListener("click", () => {
    skillPanelNodeId = null;
    renderTree();
  });
  panel.querySelector("[data-skill-apply]")?.addEventListener("click", () => {
    const selected = [...panel.querySelectorAll(".skillOption input:checked")].map((input) => input.value);
    node.selectedSkills = selected.join(", ");
    skillApplyNotice = selected.length
      ? `已写入任务图：${selected.length} 个能力。回到聊天框继续时 Codex 会读取。`
      : "已清空本节点选择的能力。";
    markDirty(`将修改${node.title}选择的skills`);
    renderTree();
  });
}

function modelCollabBar(node) {
  const configured = modelAgents.filter((agent) => agent.enabled && agent.model && agent.baseUrl && agent.hasApiKey).length;
  const label = configured ? `${configured} 个模型可用` : "未配置模型";
  return `
    <span class="modelCollabBar">
      <span class="modelCollabLabel">模型协作</span>
      <span class="modelCollabText">${escapeHtml(label)}</span>
      <button type="button" class="modelCollabBtn" data-action="model-panel" title="打开多模型协作面板">打开</button>
    </span>
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
  els.nodesLayer.appendChild(panel);
}

function renderModelPanelContent(node) {
  const configured = modelAgents.length ? modelAgents : [];
  const conversations = modelConversations[node.id] || {};
  const runItems = configured.map((agent) => `
    <label class="modelRunOption">
      <input type="checkbox" value="${attr(agent.id)}" ${agent.enabled !== false ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(agent.name || agent.id)}</strong>
        <small>${escapeHtml(agent.model || "未填写 model")} · ${agent.hasApiKey ? "已保存 key" : "未保存 key"}</small>
      </span>
    </label>
  `).join("");
  const resultItems = configured.map((agent) => {
    const turns = conversations[agent.id] || [];
    const result = modelRunResults.find((item) => item.id === agent.id);
    const toolSummary = result?.toolEvents?.length
      ? `<div class="modelToolSummary">${result.toolEvents.map((item) => `检索：${escapeHtml(item.query)} · ${item.resultCount || 0} 条${item.includeWeb ? " · 联网" : ""}${item.errors?.length ? ` · ${escapeHtml(item.errors.join("; "))}` : ""}`).join("<br>")}</div>`
      : "";
    const turnItems = turns.map((turn) => `
      <div class="modelTurn ${turn.role}">
        <div class="modelTurnRole">${turn.role === "user" ? "用户" : escapeHtml(agent.name || agent.id)}</div>
        <div class="modelResultBody">${turn.role === "assistant" ? renderMarkdownLite(turn.content) : escapeHtml(turn.content)}</div>
      </div>
    `).join("");
    return `
      <article class="modelResult ${result && !result.ok ? "bad" : "ok"}">
        <header>
          <strong>${escapeHtml(agent.name || agent.id)}</strong>
          <span>${escapeHtml(agent.model || "")}${result ? ` · ${Math.round((result.elapsedMs || 0) / 1000)}s` : ""}</span>
        </header>
        ${toolSummary}
        ${turnItems || `<div class="modelPanelEmpty">还没有本轮临时对话。</div>`}
        ${result && !result.ok ? `<div class="modelPanelError">${escapeHtml(result.error)}</div>` : ""}
      </article>
    `;
  }).join("");
  return `
    <div class="modelPanelHeader floatingPanelHeader" data-panel-drag="model">
      <strong>多模型协作</strong>
      <button type="button" data-model-close title="关闭">×</button>
    </div>
    <section class="modelPanelBody">
      <div class="modelPanelSection">
        <div class="modelPanelTitle">当前节点</div>
        <div class="modelPanelNode">${escapeHtml(node.id)} · ${escapeHtml(node.title)}</div>
        <textarea class="modelQuestionInput" placeholder="写给多个模型的问题">${escapeHtml(modelRunQuestion || node.nextIdea || nextPlan || node.problem || "")}</textarea>
        <div class="modelRunList">${runItems || `<div class="modelPanelEmpty">还没有模型配置。</div>`}</div>
        <div class="modelPanelActions">
          <button type="button" data-model-run ${modelPanelLoading ? "disabled" : ""}>${modelPanelLoading ? "运行中..." : "让勾选模型一起想"}</button>
          <button type="button" data-model-clear ${modelPanelLoading ? "disabled" : ""}>清空临时对话</button>
        </div>
        <div class="modelPanelEmpty">模型、key 和 agent.md 路径只从 .env / model-agents/*.md 读取；本面板对话只保存在当前页面内，不写入任务树。</div>
        ${modelPanelError ? `<div class="modelPanelError">${escapeHtml(modelPanelError)}</div>` : ""}
        ${modelPanelNotice ? `<div class="modelPanelNotice">${escapeHtml(modelPanelNotice)}</div>` : ""}
      </div>
      <details class="modelPanelSection" ${resultItems ? "open" : ""}>
        <summary>临时对话</summary>
        <div class="modelResults">${resultItems || `<div class="modelPanelEmpty">运行后会在这里看到每个模型的独立回答。</div>`}</div>
      </details>
    </section>
  `;
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
  panel.querySelector("[data-model-clear]")?.addEventListener("click", () => {
    modelConversations[node.id] = {};
    modelRunResults = [];
    modelPanelNotice = "已清空当前节点的临时模型对话。";
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
  modelRunResults = [];
  renderTree();
  try {
    const histories = {};
    const sharedHistories = {};
    const sharedContext = buildSharedModelContext(node.id);
    for (const modelId of modelIds) {
      histories[modelId] = (modelConversations[node.id]?.[modelId] || []).slice(-10);
      sharedHistories[modelId] = sharedContext.filter((item) => item.modelId !== modelId).slice(-24);
    }
    const response = await fetch("/api/model-agents/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id,
        modelIds,
        question: modelRunQuestion,
        useKnowledgeSearch: els.kbUseForModels?.checked === true,
        includeWeb: els.kbUseWebSearch?.checked === true,
        topK: 6,
        knowledgeContext: currentKnowledgeContextForModels(),
        histories,
        sharedHistories
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "模型运行失败");
    modelRunResults = Array.isArray(data.results) ? data.results : [];
    modelConversations[node.id] = modelConversations[node.id] || {};
    for (const result of modelRunResults) {
      modelConversations[node.id][result.id] = modelConversations[node.id][result.id] || [];
      modelConversations[node.id][result.id].push({ role: "user", content: modelRunQuestion });
      modelConversations[node.id][result.id].push({
        role: "assistant",
        content: result.ok ? result.answer : `运行失败：${result.error || "未知错误"}`
      });
      modelConversations[node.id][result.id] = modelConversations[node.id][result.id].slice(-12);
    }
    const toolCount = modelRunResults.reduce((sum, item) => sum + (Array.isArray(item.toolEvents) ? item.toolEvents.length : 0), 0);
    const knowledgeNote = els.kbUseForModels?.checked === true
      ? `，模型自主检索 ${toolCount} 次`
      : "";
    const snapshotNote = data.treeChangedDuringRun
      ? `。运行期间任务树发生变化；本轮模型使用的是开始时的快照 ${data.treeSnapshotHash || ""}`
      : `。树快照 ${data.treeSnapshotHash || ""}`;
    modelPanelNotice = `完成：${modelRunResults.filter((item) => item.ok).length}/${modelRunResults.length} 个模型返回${knowledgeNote}${snapshotNote}`;
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

function renderVersions() {
  if (!els.versionList) return;
  if (!versions.length) {
    els.versionList.innerHTML = `<div class="versionEmpty">还没有版本。第一次修改 task-tree.md 前会自动生成备份。</div>`;
    return;
  }
  els.versionList.innerHTML = versions.map((item) => `
    <button type="button" class="versionNode" data-version="${attr(item.name)}" title="点击回退到这个版本">
      <span class="versionReason">${escapeHtml(formatVersionReason(item.reason))}</span>
      <span class="versionTime">${escapeHtml(formatVersionTime(item.createdAt))}</span>
    </button>
  `).join("");
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

function ensureNodePositions() {
  let index = 0;
  let changed = false;
  for (const node of nodes) {
    if (hasPosition(node)) continue;
    const col = index % 4;
    const row = Math.floor(index / 4);
    node.x = 40 + col * 480;
    node.y = 40 + row * 560;
    ensureNodeSize(node);
    index += 1;
    changed = true;
  }
  return repelOverlappingNodes() || changed;
}

function repelOverlappingNodes() {
  const gapX = 90;
  const gapY = 90;
  let anyChanged = false;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = (b.x || 0) - (a.x || 0);
        const dy = (b.y || 0) - (a.y || 0);
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

function renderNodeCard(node) {
  const isEditing = node.id === editNodeId;
  if (!isEditing) {
    return `
      <span class="nodeCardHeader">
        <span class="headerFields">
          <span class="nodeTitle">${escapeHtml(node.title)}</span>
          <span class="connector" data-connector="${attr(node.id)}" title="从这里拖到另一个节点连接点"></span>
        </span>
        <span class="nodeActions">
          <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
          <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
          <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
          <button type="button" data-action="add-node" title="新增节点">＋</button>
          <button type="button" data-action="delete" title="删除节点">×</button>
        </span>
      </span>
      ${modelCollabBar(node)}
      ${readRow("问题", node.problem)}
      ${readRow("思路", node.approach)}
      ${readRow("评价", node.metrics)}
      ${readRow("批注", node.notes)}
      ${modelSummaryBlock(node)}
      ${nextIdeaBox(node)}
      ${node.id === nextFocusId ? nextPlanBox() : ""}
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
        <button type="button" data-action="toggle-complete" class="completeBtn" title="完成 / 取消完成">✓</button>
        <button type="button" data-action="set-current" title="设为当前推进节点">●</button>
        <button type="button" data-action="set-next" title="设为下一步推进节点">◆</button>
        <button type="button" data-action="add-node" title="新增节点">＋</button>
        <button type="button" data-action="delete" title="删除节点">×</button>
      </span>
    </span>
    ${modelCollabBar(node)}
    ${editRow("问题", "problem", node.problem)}
    ${editRow("思路", "approach", node.approach)}
    ${editRow("评价", "metrics", node.metrics)}
    ${editRow("批注", "notes", node.notes)}
    ${modelSummaryBlock(node)}
    ${nextIdeaBox(node)}
    ${node.id === nextFocusId ? nextPlanBox() : ""}
    ${selectedSkillsBlock(node)}
    <span class="resizeHandle" title="拖动调整节点大小"></span>
  `;
}

function isNodeComplete(node) {
  return String(node.completion || "").trim() === "已完成";
}

function nextIdeaBox(node) {
  return `
    <span class="nextIdeaBox">
      <span class="nextIdeaLabel">下一步思路</span>
      <textarea class="nextIdeaInput" placeholder="写这个节点接下来怎么推进">${escapeHtml(node.nextIdea || "")}</textarea>
    </span>
  `;
}

function modelSummaryBlock(node) {
  return `
    <section class="modelFields">
      <span class="modelField">
        <span class="modelFieldLabel">当前结果</span>
        <span class="modelFieldText">${escapeHtml(node.currentResult || "等待大模型填写")}</span>
      </span>
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

function nextPlanBox() {
  return `
    <span class="nextPlanBox">
      <span class="nextPlanLabel">下一步</span>
      <textarea class="nextPlanInput" placeholder="写下接下来要怎么做">${escapeHtml(nextPlan || "")}</textarea>
      <span></span>
      <button type="button" class="skillRecommendBtn" title="根据下一步推荐可用能力">推荐 skill</button>
    </span>
  `;
}

function selectedSkillsBlock(node) {
  const selected = parseSelectedSkills(node.selectedSkills);
  if (!selected.size) return "";
  return `
    <span class="selectedSkillsBox">
      <span class="selectedSkillsLabel">已选能力</span>
      <span class="selectedSkillsText">${selected.size} 个能力已写入任务图。回到聊天框继续时，Codex 会按 AGENTS.md 读取并记录实际使用。</span>
    </span>
  `;
}

function readRow(label, value) {
  return `
    <span class="cardRow">
      <span class="cardLabel">${label}</span>
      <span class="readText">${escapeHtml(value || "未填写")}</span>
    </span>
  `;
}

function ioPreviewBody(value) {
  const text = String(value || "").trim();
  if (!text) return `<div class="ioPreviewText muted">未填写</div>`;
  const filePath = detectFilePath(text);
  const clipped = text.length > 400 ? `${text.slice(0, 400)}...` : text;
  const link = filePath
    ? `<a class="ioPreviewLink" href="/api/file?path=${encodeURIComponent(filePath)}" target="_blank" rel="noreferrer">打开文件：${escapeHtml(filePath)}</a>`
    : "";
  return `
    <div class="ioPreviewText">${escapeHtml(clipped)}</div>
    ${text.length > 400 ? `<div class="ioPreviewHint">已截取前 400 个字符</div>` : ""}
    ${link}
  `;
}

function detectFilePath(value) {
  const text = String(value || "");
  const candidates = [];
  const markdownLink = [...text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)].map((match) => match[1]);
  candidates.push(...markdownLink);
  const quoted = [...text.matchAll(/["'`]([^"'`\r\n]+\.(?:md|txt|json|js|css|html|yaml|yml|ps1|cmd))["'`]/gi)].map((match) => match[1]);
  candidates.push(...quoted);
  const windows = text.match(/[A-Za-z]:\\[^\r\n"'`<>|?*]+?\.(?:md|txt|json|js|css|html|yaml|yml|ps1|cmd)\b/gi) || [];
  candidates.push(...windows);
  const relative = text.match(/(?:^|[\s:：])((?:\.{1,2}[\\/])?(?:[\w\u4e00-\u9fa5 .-]+[\\/])+[\w\u4e00-\u9fa5 .-]+\.(?:md|txt|json|js|css|html|yaml|yml|ps1|cmd))\b/gi) || [];
  candidates.push(...relative.map((item) => item.replace(/^[\s:：]+/, "")));
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  candidates.push(firstLine);
  const raw = candidates.find(Boolean) || "";
  const cleaned = raw
    .replace(/^path\s*[:：]\s*/i, "")
    .replace(/^file\s*[:：]\s*/i, "")
    .replace(/^路径\s*[:：]\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[，。；;、)）\]]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 260) return "";
  if (/[<>|?*]/.test(cleaned)) return "";
  if (!/[./\\]/.test(cleaned)) return "";
  return cleaned;
}

function buildSharedModelContext(nodeId) {
  const conversations = modelConversations[nodeId] || {};
  const items = [];
  for (const agent of modelAgents) {
    const turns = conversations[agent.id] || [];
    for (const turn of turns) {
      items.push({
        modelId: agent.id,
        modelName: agent.name || agent.id,
        role: turn.role,
        content: turn.content
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
    const lines = points.map((point) => {
      const midX = (point.x + hub.x) / 2;
      const classes = ["edgePath"];
      if (highlights.currentEdges.has(edge.id)) classes.push("currentPath");
      if (highlights.nextEdges.has(edge.id)) classes.push("nextPath");
      return `<path class="${classes.join(" ")}" data-edge="${attr(edge.id)}" d="M ${point.x} ${point.y} C ${midX} ${point.y}, ${midX} ${hub.y}, ${hub.x} ${hub.y}" />`;
    });
    return `${lines.join("")}<circle class="edgeHub" cx="${hub.x}" cy="${hub.y}" r="5" />`;
  }).join("");
}

function renderEdgeLabels() {
  els.edgeLabels.innerHTML = "";
  for (const edge of edges) {
    const points = edge.endpoints.map(getNodePort).filter(Boolean);
    if (points.length < 2) continue;
    migrateLegacyEdgeLabelPosition(edge, points);
    const hub = edgeHub(points, edge);
    const x = hub.x + 10;
    const y = hub.y - 28;
    const isEditing = edge.id === editEdgeId;
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
    markDirty(`将删除关系${edge?.label || edgeId}`);
    rerenderEdges();
  });
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
    selectedId = nodeId;
    for (const item of els.nodesLayer.querySelectorAll(".graphNode")) {
      item.classList.toggle("selected", item === nodeCard);
    }
    startNodeDrag(event, nodeId, nodeCard);
  });

  nodeCard.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, .connector")) return;
    editNodeId = nodeId;
    selectedId = nodeId;
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
    modelRunResults = [];
    modelPanelError = "";
    modelPanelNotice = "";
    loadModelAgents().finally(() => renderTree());
  });

  nodeCard.querySelector("[data-action='toggle-complete']").addEventListener("click", (event) => {
    event.stopPropagation();
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    node.completion = isNodeComplete(node) ? "" : "已完成";
    markDirty(`${isNodeComplete(node) ? "将标记完成" : "将取消完成"}${nodeTitle(nodeId)}`);
    renderTree();
  });

  nodeCard.querySelector("[data-action='set-current']").addEventListener("click", (event) => {
    event.stopPropagation();
    currentFocusId = nodeId;
    selectedId = nodeId;
    markDirty(`将修改当前推进节点为${nodeTitle(nodeId)}`);
    renderTree();
  });

  nodeCard.querySelector("[data-action='set-next']").addEventListener("click", (event) => {
    event.stopPropagation();
    nextFocusId = nodeId;
    selectedId = nodeId;
    markDirty(`将修改下一步推进节点为${nodeTitle(nodeId)}`);
    renderTree();
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
      markDirty(`将修改${nodeTitle(nodeId)}的下一步计划`);
    });
  }

  const skillRecommendBtn = nodeCard.querySelector(".skillRecommendBtn");
  if (skillRecommendBtn) {
    skillRecommendBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      recommendSkillsForNode(nodeId);
    });
  }

  const nextIdeaInput = nodeCard.querySelector(".nextIdeaInput");
  if (nextIdeaInput) {
    nextIdeaInput.addEventListener("input", () => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      node.nextIdea = nextIdeaInput.value.trim();
      markDirty(`将修改${nodeTitle(nodeId)}的下一步思路`);
    });
  }
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
        }
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

function startNodeDrag(event, nodeId, nodeCard) {
  if (isInteractive(event.target) || event.button !== 0) return;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return;
  event.preventDefault();
  nodeCard.setPointerCapture(event.pointerId);
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    nodeX: node.x || 0,
    nodeY: node.y || 0
  };

  function move(moveEvent) {
    const dx = (moveEvent.clientX - start.pointerX) / graphView.scale;
    const dy = (moveEvent.clientY - start.pointerY) / graphView.scale;
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
    markDirty(`将修改节点${nodeTitle(nodeId)}的位置`);
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
  selectedId = nodes[0]?.id || null;
  markDirty(`将删除节点${node.title}`);
  renderTree();
}

function layoutAsTree() {
  if (!nodes.length) return;
  const rootId = nodes.some((node) => node.id === "ROOT")
    ? "ROOT"
    : selectedId || nodes[0].id;
  const adjacency = buildTreeAdjacency(rootId);
  const subtreeWidths = new Map();
  const horizontalGap = 120;
  const verticalGap = 160;
  const rootGap = 180;
  const top = 70;
  const left = 70;

  function measure(id, stack = new Set()) {
    if (stack.has(id)) return nodeWidthById(id) + horizontalGap;
    stack.add(id);
    const children = (adjacency.get(id) || []).filter((childId) => childId !== id);
    if (!children.length) {
      const width = nodeWidthById(id) + horizontalGap;
      subtreeWidths.set(id, width);
      stack.delete(id);
      return width;
    }
    const childrenWidth = children.reduce((sum, childId) => sum + measure(childId, stack), 0);
    const width = Math.max(nodeWidthById(id) + horizontalGap, childrenWidth);
    subtreeWidths.set(id, width);
    stack.delete(id);
    return width;
  }

  function place(id, xStart, y, placing = new Set()) {
    if (placing.has(id)) return;
    placing.add(id);
    const width = subtreeWidths.get(id) || nodeWidthById(id) + horizontalGap;
    const node = nodes.find((item) => item.id === id);
    if (node) {
      node.x = xStart + width / 2 - nodeWidth(node) / 2;
      node.y = y;
    }
    let childX = xStart;
    for (const childId of adjacency.get(id) || []) {
      const childWidth = subtreeWidths.get(childId) || nodeWidthById(childId) + horizontalGap;
      place(childId, childX, y + nodeHeightById(id) + verticalGap, placing);
      childX += childWidth;
    }
    placing.delete(id);
  }

  const orderedRoots = [rootId, ...nodes.map((node) => node.id).filter((id) => id !== rootId)];
  const roots = [];
  const globallyVisited = new Set();
  for (const id of orderedRoots) {
    if (globallyVisited.has(id)) continue;
    const seen = collectReachable(id, adjacency);
    for (const seenId of seen) globallyVisited.add(seenId);
    measure(id);
    roots.push(id);
  }

  let x = left;
  for (const id of roots) {
    const width = subtreeWidths.get(id) || nodeWidthById(id) + horizontalGap;
    place(id, x, top);
    x += width + rootGap;
  }

  for (const edge of edges) {
    edge.offsetX = 0;
    edge.offsetY = 0;
    edge.labelX = null;
    edge.labelY = null;
  }

  graphView.x = 40;
  graphView.y = 34;
  graphView.scale = 0.88;
  markDirty("将修改图谱为自上而下树形排版");
  renderTree();
}

function collectReachable(rootId, adjacency) {
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const childId of adjacency.get(id) || []) stack.push(childId);
  }
  return seen;
}

function nodeWidthById(id) {
  const node = nodes.find((item) => item.id === id);
  return node ? nodeWidth(node) : card.width;
}

function nodeHeightById(id) {
  const node = nodes.find((item) => item.id === id);
  return node ? nodeHeight(node) : card.height;
}

function buildTreeAdjacency(rootId) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const seen = new Set();
  const reached = new Set([rootId]);

  for (const edge of edges) {
    const endpoints = edge.endpoints.filter((id) => adjacency.has(id));
    if (endpoints.length < 2) continue;
    const source = endpoints.find((id) => reached.has(id)) || endpoints[0];
    for (const target of endpoints) {
      if (target === source) continue;
      const key = `${source}->${target}`;
      if (seen.has(key)) continue;
      adjacency.get(source).push(target);
      reached.add(target);
      seen.add(key);
    }
  }

  for (const [id, targets] of adjacency) {
    adjacency.set(id, targets.sort((a, b) => nodeTitle(a).localeCompare(nodeTitle(b), "zh-CN")));
  }

  return adjacency;
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

function loadFromMarkdown(markdown) {
  const parsed = parseMarkdown(markdown);
  lastLoadedMarkdown = markdown;
  lastSavedMarkdown = markdown;
  nodes = parsed.nodes;
  edges = parsed.edges;
  currentFocusId = nodes.some((node) => node.id === parsed.graphState.current) ? parsed.graphState.current : "";
  nextFocusId = nodes.some((node) => node.id === parsed.graphState.next) ? parsed.graphState.next : "";
  nextPlan = parsed.graphState.nextPlan || "";
  selectedId = nodes[0]?.id || null;
  renderTree();
  dirty = false;
  setSaveState("已加载");
}

async function loadTree() {
  const response = await fetch("/api/tree");
  const data = await response.json();
  loadFromMarkdown(data.markdown);
  await loadVersions();
  await loadModelAgents();
  await loadKnowledgeConfig();
  renderTree();
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
    knowledgeError = "";
    renderKnowledgePanel();
  } catch (error) {
    knowledgeError = error.message;
    renderKnowledgePanel();
  }
}

function renderKnowledgePanel() {
  if (!els.knowledgeState) return;
  const config = knowledgeConfig || {};
  const embedding = config.embedding || {};
  if (els.kbUseWebSearch) els.kbUseWebSearch.checked = Boolean(webSearchConfig?.enabled && webSearchConfig?.provider);
  const total = knowledgeIndex?.totalChunks || 0;
  const webKeyState = !webSearchConfig?.provider
    ? "关闭"
    : webSearchConfig.requiresApiKey === false
      ? "不需要 key"
      : webSearchConfig.hasApiKey
        ? "key 已配置"
        : "缺少 key";
  els.knowledgeState.textContent = knowledgeLoading ? "处理中..." : knowledgeError ? "出错" : `${total} chunks`;
  if (els.kbEnvInfo) {
    els.kbEnvInfo.textContent = [
      `文档目录: ${config.docsDir || "knowledge"}`,
      `Embedding: ${embedding.model || "未配置"} · ${embedding.hasApiKey ? "key 已配置" : "缺少 key"}`,
      `问答模型: ${config.chat?.modelId || "未配置"}`,
      `联网搜索: ${webSearchConfig?.provider || "关闭"} · ${webKeyState}`,
      "配置来源: .env"
    ].join("\n");
  }
  if (els.kbIndexInfo) {
    const job = knowledgeReindexJob || knowledgeConfig?.reindex;
    const progress = job?.running || job?.stage === "done" || job?.stage === "error"
      ? `
        <div class="knowledgeProgress">
          <div class="knowledgeProgressTrack"><span style="width:${Math.max(0, Math.min(100, Number(job.percent) || 0))}%"></span></div>
          <div>${escapeHtml(job.error || job.message || job.stage || "")}${job.running ? ` · ${job.percent || 0}%` : ""}</div>
        </div>
      `
      : "";
    els.kbIndexInfo.innerHTML = knowledgeError
      ? escapeHtml(knowledgeError)
      : `${escapeHtml(`索引：${total} 个片段 · ${knowledgeIndex?.embeddingModel || "未建立"} · ${knowledgeIndex?.createdAt || "未建立"}`)}${progress}`;
  }
  if (els.kbAnswer) {
    els.kbAnswer.textContent = knowledgeAnswer || "";
  }
  if (els.kbResults) {
    els.kbResults.innerHTML = knowledgeResults.length
      ? knowledgeResults.map((item, index) => `
        <article class="knowledgeResult ${item.source === "web" ? "web" : ""}">
          <header>
            <strong>[${index + 1}] ${escapeHtml(item.title || item.path)}</strong>
            <span>${Number(item.score || 0).toFixed(3)}</span>
          </header>
          <small>${escapeHtml(item.source || "knowledge")} · ${escapeHtml(item.url || item.path || "")}</small>
          <div>${escapeHtml(String(item.content || "").slice(0, 520))}</div>
        </article>
      `).join("")
      : `<div class="knowledgeEmpty">检索结果会显示在这里。</div>`;
  }
}

async function reindexKnowledge() {
  knowledgeLoading = true;
  knowledgeError = "";
  renderKnowledgePanel();
  try {
    const response = await fetch("/api/knowledge/reindex", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "重建索引失败");
    knowledgeReindexJob = data.job || null;
    await pollKnowledgeReindex();
  } catch (error) {
    knowledgeError = error.message;
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
    const response = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK: 6, includeWeb: els.kbUseWebSearch?.checked === true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "检索失败");
    knowledgeResults = Array.isArray(data.results) ? data.results : [];
    knowledgeIndex = data.index || knowledgeIndex;
    return data;
  } catch (error) {
    knowledgeError = error.message;
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
  knowledgeAnswer = "";
  renderKnowledgePanel();
  try {
    const response = await fetch("/api/knowledge/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        topK: 6,
        includeWeb: els.kbUseWebSearch?.checked === true
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "知识库问答失败");
    knowledgeAnswer = data.answer || "";
    knowledgeResults = Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    knowledgeError = error.message;
  } finally {
    knowledgeLoading = false;
    renderKnowledgePanel();
  }
}

function currentKnowledgeContextForModels() {
  if (!els.kbUseForModels?.checked || !knowledgeResults.length) return "";
  return knowledgeResults.map((item, index) => [
    `[${index + 1}] ${item.title || item.path} (${item.source || "knowledge"}: ${item.url || item.path}, score=${Number(item.score || 0).toFixed(3)})`,
    String(item.content || "").slice(0, 1800)
  ].join("\n")).join("\n\n---\n\n");
}

async function pollTreeChanges() {
  if (dirty || saveInFlight || saveTimer) return;
  const response = await fetch(`/api/tree?t=${Date.now()}`);
  if (!response.ok) return;
  const data = await response.json();
  if (data.markdown === lastLoadedMarkdown || data.markdown === lastSavedMarkdown) return;
  loadFromMarkdown(data.markdown);
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
  const markdown = toMarkdown(nodes, edges);
  const reason = pendingSaveReason || "将自动保存图谱修改";
  pendingSaveReason = "";
  try {
    const response = await fetch("/api/tree", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, reason, backup: false })
    });
    if (!response.ok) throw new Error("Save failed");
    lastSavedMarkdown = markdown;
    lastLoadedMarkdown = markdown;
    dirty = false;
    setSaveState("已保存");
    await loadVersions();
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
    const response = await fetch(`/api/versions?t=${Date.now()}`);
    if (!response.ok) throw new Error("Version list failed");
    const data = await response.json();
    versions = Array.isArray(data.versions) ? data.versions : [];
    renderVersions();
    if (els.versionState) els.versionState.textContent = `${versions.length} 个版本`;
  } catch (error) {
    if (els.versionState) els.versionState.textContent = "读取失败";
  }
}

async function restoreVersion(name) {
  if (!name) return;
  setSaveState("回退中...");
  try {
    const response = await fetch("/api/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!response.ok) throw new Error("Restore failed");
    const data = await response.json();
    if (Array.isArray(data.versions)) versions = data.versions;
    loadFromMarkdown(data.markdown);
    renderVersions();
    setSaveState("已回退");
    if (els.versionState) els.versionState.textContent = `${versions.length} 个版本`;
  } catch (error) {
    setSaveState(`回退失败: ${error.message}`);
  }
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

function hasSize(node) {
  return Number.isFinite(node.width) && Number.isFinite(node.height);
}

function nodeWidth(node) {
  return Math.max(card.minWidth, Number.isFinite(node.width) ? node.width : card.width);
}

function nodeHeight(node) {
  return Math.max(card.minHeight, Number.isFinite(node.height) ? node.height : card.height);
}

function hasEdgeLabelPosition(edge) {
  return Number.isFinite(edge.labelX) && Number.isFinite(edge.labelY);
}

function hasEdgeLabelOffset(edge) {
  return Number.isFinite(edge.offsetX) && Number.isFinite(edge.offsetY) && (edge.offsetX !== 0 || edge.offsetY !== 0);
}

function applyGraphTransform() {
  els.graphCanvas.style.transform = `translate(${graphView.x}px, ${graphView.y}px) scale(${graphView.scale})`;
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
  return Boolean(target.closest("input, textarea, select, button, .connector"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdownLite(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let listOpen = false;
  let codeOpen = false;
  function closeList() {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      html.push(codeOpen ? "</code></pre>" : "<pre><code>");
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 3);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  closeList();
  if (codeOpen) html.push("</code></pre>");
  return html.join("");
}

function attr(value) {
  return escapeHtml(value || "").replaceAll("'", "&#39;");
}

els.addChildBtn.addEventListener("click", () => addNodeNear());
els.layoutTreeBtn.addEventListener("click", () => layoutAsTree());
els.saveBtn.addEventListener("click", () => {
  pendingSaveReason = pendingSaveReason || "将手动保存图谱修改";
  saveTree().catch((error) => setSaveState(error.message));
});
els.reloadBtn.addEventListener("click", () => loadTree().catch((error) => setSaveState(error.message)));
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
els.kbSearchBtn?.addEventListener("click", () => searchKnowledgeFromPanel());
els.kbAskBtn?.addEventListener("click", () => askKnowledgeFromPanel());

els.graphViewport.addEventListener("wheel", (event) => {
  if (event.target.closest(".graphNode, .edgeEditor")) return;
  event.preventDefault();
  const rect = els.graphViewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const beforeX = (mouseX - graphView.x) / graphView.scale;
  const beforeY = (mouseY - graphView.y) / graphView.scale;
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  graphView.scale = clamp(graphView.scale * factor, 0.28, 1.8);
  graphView.x = mouseX - beforeX * graphView.scale;
  graphView.y = mouseY - beforeY * graphView.scale;
  applyGraphTransform();
}, { passive: false });

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

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

loadTree().catch((error) => setSaveState(error.message));
reloadTimer = setInterval(() => {
  pollTreeChanges().catch(() => {});
}, 1400);
