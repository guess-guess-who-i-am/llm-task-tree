const instances = new WeakMap();
let activeRoot = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeModel(model = {}) {
  const rawNodes = Array.isArray(model.nodes) ? model.nodes : [];
  const rawEdges = Array.isArray(model.edges) ? model.edges : [];
  const nodes = rawNodes.map((node) => ({
    ...node,
    id: String(node.id),
    title: node.title || String(node.id),
    completion: node.completion == null ? "" : String(node.completion).trim(),
    parentIds: unique(node.parentIds?.map(String)),
    childIds: unique(node.childIds?.map(String)),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = rawEdges
    .map((edge) => ({ ...edge, source: String(edge.source), target: String(edge.target) }))
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target));

  edges.forEach((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    source.childIds = unique([...source.childIds, target.id]);
    target.parentIds = unique([...target.parentIds, source.id]);
  });

  nodes.forEach((node) => {
    node.parentIds = node.parentIds.filter((id) => byId.has(id));
    node.childIds = node.childIds.filter((id) => byId.has(id));
  });

  const rootId = byId.has(String(model.rootId))
    ? String(model.rootId)
    : nodes.find((node) => node.parentIds.length === 0)?.id || nodes[0]?.id;
  const current = byId.has(String(model.graphState?.current)) ? String(model.graphState.current) : null;
  const next = byId.has(String(model.graphState?.next)) ? String(model.graphState.next) : null;

  return { nodes, edges, byId, rootId, current, next };
}

function hierarchyLayout(data) {
  const depth = new Map();
  const queue = [];
  if (data.rootId) {
    depth.set(data.rootId, 0);
    queue.push(data.rootId);
  }

  while (queue.length) {
    const id = queue.shift();
    const node = data.byId.get(id);
    const nextDepth = (depth.get(id) || 0) + 1;
    node?.childIds.forEach((childId) => {
      if (!depth.has(childId)) {
        depth.set(childId, nextDepth);
        queue.push(childId);
      }
    });
  }

  data.nodes.forEach((node) => {
    if (!depth.has(node.id)) depth.set(node.id, 0);
  });

  const columns = new Map();
  data.nodes.forEach((node) => {
    const level = depth.get(node.id);
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(node);
  });

  const maxDepth = Math.max(0, ...depth.values());
  const maxRows = Math.max(1, ...[...columns.values()].map((items) => items.length));
  const width = 220;
  const height = Math.max(150, maxRows * 28 + 24);
  const positions = new Map();

  [...columns.entries()].sort(([a], [b]) => a - b).forEach(([level, items]) => {
    items.forEach((node, index) => {
      positions.set(node.id, {
        x: 16 + (maxDepth ? (level / maxDepth) * (width - 32) : (width - 32) / 2),
        y: 16 + ((index + 1) / (items.length + 1)) * (height - 32),
      });
    });
  });

  return { width, height, positions };
}

function nodeStatus(id, data) {
  if (id === data.next) return "next";
  if (id === data.current) return "current";
  return "default";
}

function statusLabel(id, data) {
  if (id === data.next) return "下一步";
  if (id === data.current) return "当前";
  return "";
}

function completionState(value) {
  const label = String(value || "").trim();
  const keys = {
    "未开始": "todo",
    "进行中": "doing",
    "已完成": "done",
    "需重做": "redo",
  };
  return {
    key: keys[label] || "unknown",
    label: label || "状态未标记",
  };
}

function createMiniMap(data, focusId, onFocus) {
  const panel = element("section", "ttb-map");
  const heading = element("div", "ttb-section-heading");
  heading.append(element("span", "ttb-eyebrow", "全局位置"));
  heading.append(element("span", "ttb-map-count", `${data.nodes.length} 个节点`));
  panel.append(heading);

  const layout = hierarchyLayout(data);
  const svg = svgElement("svg", {
    class: "ttb-map-svg",
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: "img",
    "aria-label": "完整任务树小地图，选择节点可切换局部镜头",
  });

  data.edges.forEach((edge) => {
    const source = layout.positions.get(edge.source);
    const target = layout.positions.get(edge.target);
    if (!source || !target) return;
    svg.append(svgElement("path", {
      class: "ttb-map-edge",
      d: `M ${source.x} ${source.y} C ${(source.x + target.x) / 2} ${source.y}, ${(source.x + target.x) / 2} ${target.y}, ${target.x} ${target.y}`,
    }));
  });

  data.nodes.forEach((node) => {
    const position = layout.positions.get(node.id);
    if (!position) return;
    const group = svgElement("g", {
      class: `ttb-map-node is-${nodeStatus(node.id, data)}${node.id === focusId ? " is-focus" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-label": `聚焦 ${node.title}`,
      transform: `translate(${position.x} ${position.y})`,
    });
    group.append(svgElement("circle", { r: node.id === focusId ? 7 : 4.5 }));
    group.addEventListener("click", () => onFocus(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onFocus(node.id);
      }
    });
    svg.append(group);
  });

  panel.append(svg);
  panel.append(element("p", "ttb-map-hint", "点任意光点，镜头会移动到它附近。"));
  return panel;
}

function createRelationCard(node, relation, data, onFocus) {
  const button = element("button", `ttb-relative ttb-relative--${relation}`);
  button.type = "button";
  button.dataset.nodeId = node.id;
  button.setAttribute("aria-label", `${relation === "parent" ? "前往上游节点" : "前往下游节点"}：${node.title}`);

  const top = element("span", "ttb-relative-topline");
  top.append(element("span", "ttb-relative-id", node.id));
  const label = statusLabel(node.id, data);
  if (label) top.append(element("span", `ttb-state ttb-state--${nodeStatus(node.id, data)}`, label));
  button.append(top);
  button.append(element("strong", "ttb-relative-title", node.title));
  const completion = completionState(node.completion);
  button.append(element("span", `ttb-relative-completion is-${completion.key}`, completion.label));
  button.append(element("span", "ttb-relative-action", relation === "parent" ? "← 回到这里" : "进入这里 →"));
  button.addEventListener("click", () => onFocus(node.id, true));
  return button;
}

function createField(label, value, className = "") {
  const section = element("section", `ttb-field ${className}`.trim());
  section.append(element("h3", "ttb-field-label", label));
  section.append(element("p", "ttb-field-value", value || "尚未记录"));
  return section;
}

function createFocusCard(node, data) {
  const card = element("article", "ttb-focus-card");
  card.tabIndex = -1;
  card.dataset.focusCard = "true";

  const masthead = element("header", "ttb-focus-head");
  const identity = element("div", "ttb-focus-identity");
  const topline = element("div", "ttb-focus-topline");
  topline.append(element("span", "ttb-focus-id", node.id));
  const label = statusLabel(node.id, data);
  if (label) topline.append(element("span", `ttb-state ttb-state--${nodeStatus(node.id, data)}`, label));
  identity.append(topline);
  identity.append(element("h2", "ttb-focus-title", node.title));
  masthead.append(identity);

  const completion = completionState(node.completion);
  const completionBadge = element("div", `ttb-completion is-${completion.key}`);
  completionBadge.setAttribute("aria-label", `节点状态：${completion.label}`);
  completionBadge.append(element("span", "ttb-completion-dot"));
  completionBadge.append(element("strong", "ttb-completion-value", completion.label));
  masthead.append(completionBadge);
  card.append(masthead);

  const essential = element("div", "ttb-essential");
  essential.append(createField("当前结论", node.currentResult, "ttb-field--result"));
  essential.append(createField("接下来", node.nextIdea, "ttb-field--next"));
  card.append(essential);

  if (node.problem || node.approach) {
    const details = element("details", "ttb-context");
    const summary = element("summary", "ttb-context-summary");
    summary.append(element("span", "", "为什么与怎么做"));
    summary.append(element("span", "ttb-context-cue", `${[node.problem, node.approach].filter(Boolean).length} 项背景`));
    details.append(summary);
    const content = element("div", "ttb-context-content");
    if (node.problem) content.append(createField("要解决的问题", node.problem));
    if (node.approach) content.append(createField("采用的方法", node.approach));
    details.append(content);
    card.append(details);
  }

  return card;
}

function createEmptyState() {
  const empty = element("div", "ttb-empty");
  empty.append(element("span", "ttb-empty-mark", "◇"));
  empty.append(element("h2", "", "还没有可以观察的任务树"));
  empty.append(element("p", "", "传入节点后，这里会显示完整方位与当前局部关系。"));
  return empty;
}

function createLens(data, focusId, onFocus) {
  const focus = data.byId.get(focusId);
  const lens = element("main", "ttb-lens");
  if (!focus) {
    lens.append(createEmptyState());
    return lens;
  }

  const parentNodes = focus.parentIds.map((id) => data.byId.get(id)).filter(Boolean);
  const childNodes = focus.childIds.map((id) => data.byId.get(id)).filter(Boolean);

  const lensHead = element("div", "ttb-lens-head");
  const title = element("div");
  title.append(element("span", "ttb-eyebrow", "局部镜头"));
  title.append(element("p", "ttb-lens-caption", "只看当前节点与一跳关系"));
  lensHead.append(title);

  if (focus.id !== data.rootId && data.rootId) {
    const rootButton = element("button", "ttb-root-button", "回到根节点");
    rootButton.type = "button";
    rootButton.addEventListener("click", () => onFocus(data.rootId, true));
    lensHead.append(rootButton);
  }
  lens.append(lensHead);

  const stage = element("div", "ttb-stage");
  const parentRail = element("section", "ttb-rail ttb-rail--parents");
  parentRail.setAttribute("aria-label", "上游节点");
  parentRail.append(element("div", "ttb-rail-label", parentNodes.length ? `从哪里来 · ${parentNodes.length}` : "已经到根部"));
  const parentCards = element("div", "ttb-relative-stack");
  parentNodes.forEach((node) => parentCards.append(createRelationCard(node, "parent", data, onFocus)));
  parentRail.append(parentCards);

  const center = element("div", "ttb-stage-center");
  center.append(element("div", "ttb-aperture ttb-aperture--outer"));
  center.append(element("div", "ttb-aperture ttb-aperture--inner"));
  center.append(createFocusCard(focus, data));

  const childRail = element("section", "ttb-rail ttb-rail--children");
  childRail.setAttribute("aria-label", "下游节点");
  childRail.append(element("div", "ttb-rail-label", childNodes.length ? `往哪里去 · ${childNodes.length}` : "当前没有下游"));
  const childCards = element("div", "ttb-relative-stack");
  childNodes.forEach((node) => childCards.append(createRelationCard(node, "child", data, onFocus)));
  childRail.append(childCards);

  stage.append(parentRail, center, childRail);
  lens.append(stage);

  const keyboard = element("p", "ttb-keyboard-help");
  keyboard.innerHTML = "键盘：<kbd>←</kbd> 上游 · <kbd>→</kbd> 下游 · <kbd>↑</kbd><kbd>↓</kbd> 同级";
  lens.append(keyboard);
  return lens;
}

function siblingIds(node, data) {
  const ids = [];
  node.parentIds.forEach((parentId) => {
    const parent = data.byId.get(parentId);
    if (parent) ids.push(...parent.childIds);
  });
  return unique(ids).filter((id) => id !== node.id);
}

function renderVariant(root, model) {
  if (!(root instanceof Element)) throw new TypeError("Variant B render(root, model) 需要有效的 DOM 根元素");
  instances.get(root)?.destroy();
  activeRoot = root;

  const data = normalizeModel(model);
  let focusId = data.next || data.current || data.rootId;
  let siblingCursor = 0;
  const shell = element("div", "ttb-shell");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", "任务树局部镜头，只读原型");
  root.replaceChildren(shell);

  function paint(moveKeyboardFocus = false) {
    shell.replaceChildren();

    const brand = element("header", "ttb-brand");
    const brandText = element("div");
    brandText.append(element("span", "ttb-brand-kicker", "TASK TREE / B"));
    brandText.append(element("h1", "ttb-brand-title", "局部镜头"));
    brand.append(brandText);
    brand.append(element("p", "ttb-brand-note", "树不必缩成一团。保留整体方位，只把注意力放在此刻附近。"));
    shell.append(brand);

    const workspace = element("div", "ttb-workspace");
    workspace.append(createMiniMap(data, focusId, setFocus));
    workspace.append(createLens(data, focusId, setFocus));
    shell.append(workspace);

    if (moveKeyboardFocus) shell.querySelector("[data-focus-card]")?.focus({ preventScroll: true });
  }

  function setFocus(id, moveKeyboardFocus = false) {
    if (!data.byId.has(id) || id === focusId) return;
    focusId = id;
    siblingCursor = 0;
    paint(moveKeyboardFocus);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const targetTag = event.target?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(targetTag) || event.target?.closest("details")) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.stopPropagation();
    const node = data.byId.get(focusId);
    if (!node) return;

    let destination;
    if (event.key === "ArrowLeft") destination = node.parentIds[0];
    if (event.key === "ArrowRight") destination = node.childIds[0];
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const siblings = siblingIds(node, data);
      if (siblings.length) {
        siblingCursor = (siblingCursor + (event.key === "ArrowDown" ? 1 : -1) + siblings.length) % siblings.length;
        destination = siblings[siblingCursor];
      }
    }
    if (destination) {
      event.preventDefault();
      setFocus(destination, true);
    }
  }

  shell.addEventListener("keydown", onKeyDown);
  const instance = {
    destroy() {
      shell.removeEventListener("keydown", onKeyDown);
      if (shell.parentNode === root) root.replaceChildren();
      instances.delete(root);
      if (activeRoot === root) activeRoot = null;
    },
  };
  instances.set(root, instance);
  paint();
  return instance;
}

export const variantB = {
  key: "b",
  name: "局部镜头",
  render: renderVariant,
  destroy(root = activeRoot) {
    if (root) instances.get(root)?.destroy();
  },
};
