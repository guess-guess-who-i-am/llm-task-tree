const instances = new WeakMap();

function text(value, fallback = "") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function clamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function create(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function normalizeModel(model = {}) {
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  const edges = Array.isArray(model.edges) ? model.edges : [];
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const children = new Map(nodes.map((node) => [String(node.id), []]));
  const parents = new Map(nodes.map((node) => [String(node.id), []]));
  const edgeLabels = new Map();

  const connect = (source, target, label = "") => {
    source = String(source ?? "");
    target = String(target ?? "");
    if (!source || !target || source === target || !byId.has(source) || !byId.has(target)) return;
    if (!children.get(source).includes(target)) children.get(source).push(target);
    if (!parents.get(target).includes(source)) parents.get(target).push(source);
    if (label) edgeLabels.set(`${source}\u0000${target}`, text(label));
  };

  edges.forEach((edge) => connect(edge.source, edge.target, edge.label));
  nodes.forEach((node) => {
    const id = String(node.id);
    (Array.isArray(node.childIds) ? node.childIds : []).forEach((childId) => connect(id, childId));
    (Array.isArray(node.parentIds) ? node.parentIds : []).forEach((parentId) => connect(parentId, id));
  });

  const requestedRoot = String(model.rootId ?? "");
  const rootId = byId.has(requestedRoot)
    ? requestedRoot
    : String(nodes.find((node) => !(parents.get(String(node.id)) || []).length)?.id ?? nodes[0]?.id ?? "");

  return { nodes, byId, children, parents, edgeLabels, rootId };
}

function findPath(rootId, targetId, children) {
  if (!rootId || !targetId) return [];
  const queue = [[rootId]];
  const visited = new Set();
  while (queue.length) {
    const path = queue.shift();
    const id = path[path.length - 1];
    if (id === targetId) return path;
    if (visited.has(id)) continue;
    visited.add(id);
    (children.get(id) || []).forEach((childId) => {
      if (!path.includes(childId)) queue.push([...path, childId]);
    });
  }
  return [];
}

function countDescendants(id, children) {
  const visited = new Set();
  const stack = [...(children.get(id) || [])];
  while (stack.length) {
    const next = stack.pop();
    if (visited.has(next)) continue;
    visited.add(next);
    stack.push(...(children.get(next) || []));
  }
  return visited.size;
}

function shortDirection(node) {
  return text(node.currentResult) || text(node.approach) || text(node.problem) || "尚未写入方向说明";
}

function renderEmpty(root) {
  const empty = create("section", "ttvc ttvc--empty");
  empty.innerHTML = '<div class="ttvc-empty-mark" aria-hidden="true">⌁</div><h2>还没有可绘制的任务树</h2><p>传入节点后，这里会从根目标长出当前路径与可展开分叉。</p>';
  root.replaceChildren(empty);
}

function renderVariant(root, model) {
  if (!(root instanceof Element)) throw new TypeError("variantC.render: root 必须是 DOM Element");
  instances.get(root)?.destroy();

  const graph = normalizeModel(model);
  if (!graph.nodes.length || !graph.rootId) {
    renderEmpty(root);
    const api = { destroy: () => root.replaceChildren() };
    instances.set(root, api);
    return api;
  }

  const currentId = String(model?.graphState?.current ?? "");
  const nextId = String(model?.graphState?.next ?? "");
  const currentPath = findPath(graph.rootId, currentId, graph.children);
  const nextPath = findPath(graph.rootId, nextId, graph.children);
  const activePath = new Set([graph.rootId, ...currentPath, ...nextPath]);
  const initiallyExpanded = new Set([
    graph.rootId,
    ...currentPath,
    ...nextPath,
  ]);
  const expanded = new Set(initiallyExpanded);
  const cleanup = [];

  const shell = create("section", "ttvc");
  shell.dataset.variant = "c";
  shell.setAttribute("aria-label", "折叠地形任务树");

  const topbar = create("header", "ttvc-topbar");
  const identity = create("div", "ttvc-identity");
  identity.append(create("span", "ttvc-kicker", "TASK TERRAIN / C"));
  identity.append(create("h2", "ttvc-heading", "沿当前河道，比较下一处分叉"));
  const helper = create("p", "ttvc-helper", "主路径保持可见；支流先给方向，展开后再读依据。只读原型。");
  identity.append(helper);

  const legend = create("div", "ttvc-legend");
  legend.setAttribute("aria-label", "状态图例");
  [
    ["current", "刚完成"],
    ["next", "接下来"],
    ["branch", "可探索分叉"],
  ].forEach(([kind, label]) => {
    const item = create("span", `ttvc-legend-item is-${kind}`);
    item.append(create("i", "ttvc-legend-dot"), document.createTextNode(label));
    legend.append(item);
  });
  topbar.append(identity, legend);

  const viewport = create("div", "ttvc-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", "任务树地形，可用 Tab 浏览分叉，方向键在分叉间移动");

  const terrain = create("div", "ttvc-terrain");
  terrain.setAttribute("role", "tree");
  const rootNode = graph.byId.get(graph.rootId);

  const source = create("div", "ttvc-source");
  source.setAttribute("role", "treeitem");
  source.setAttribute("aria-level", "1");
  const sourceMarker = create("div", "ttvc-source-marker");
  sourceMarker.innerHTML = '<span class="ttvc-source-ring"></span><span class="ttvc-source-core"></span>';
  const sourceCopy = create("div", "ttvc-source-copy");
  sourceCopy.append(create("span", "ttvc-source-label", "根目标 · 水源"));
  sourceCopy.append(create("h3", "ttvc-source-title", text(rootNode.title, "未命名根目标")));
  const rootProblem = text(rootNode.problem);
  if (rootProblem) sourceCopy.append(create("p", "ttvc-source-purpose", rootProblem));
  source.append(sourceMarker, sourceCopy);
  terrain.append(source);

  const branchButtons = [];

  function buildNode(id, depth, ancestry = new Set(), fromId = "") {
    const node = graph.byId.get(id);
    if (!node || ancestry.has(id)) return null;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);

    const childIds = graph.children.get(id) || [];
    const isCurrent = id === currentId;
    const isNext = id === nextId;
    const isActive = activePath.has(id);
    const isOpen = expanded.has(id);
    const descendants = countDescendants(id, graph.children);

    const branch = create("li", "ttvc-branch");
    branch.dataset.nodeId = id;
    branch.classList.toggle("is-active-route", isActive);
    branch.classList.toggle("is-current", isCurrent);
    branch.classList.toggle("is-next", isNext);
    branch.classList.toggle("is-expanded", isOpen);
    branch.setAttribute("role", "treeitem");
    branch.setAttribute("aria-level", String(depth));

    const stem = create("div", "ttvc-stem");
    const button = create("button", "ttvc-branch-trigger");
    button.type = "button";
    button.dataset.nodeId = id;
    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute("aria-label", `${isOpen ? "收起" : "展开"}${text(node.title, id)}`);
    branchButtons.push(button);

    const glyph = create("span", "ttvc-fork-glyph");
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML = '<span class="ttvc-glyph-line"></span><span class="ttvc-glyph-tip"></span>';

    const heading = create("span", "ttvc-branch-heading");
    const eyebrow = create("span", "ttvc-branch-eyebrow");
    const label = graph.edgeLabels.get(`${fromId}\u0000${id}`);
    eyebrow.textContent = isCurrent ? "CURRENT · 刚完成" : isNext ? "NEXT · 接下来" : label || "方向分叉";
    heading.append(eyebrow, create("strong", "ttvc-branch-title", text(node.title, id)));

    const meta = create("span", "ttvc-branch-meta");
    const completion = clamp(node.completion);
    if (completion > 0) meta.append(create("span", "ttvc-completion", `${Math.round(completion)}%`));
    if (descendants) meta.append(create("span", "ttvc-descendants", `下游 ${descendants}`));
    meta.append(create("span", "ttvc-toggle-word", isOpen ? "收起" : "展开"));
    button.append(glyph, heading, meta);
    stem.append(button);

    const detail = create("div", "ttvc-node-detail");
    detail.hidden = !isOpen;
    detail.id = `ttvc-${Math.random().toString(36).slice(2)}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    button.setAttribute("aria-controls", detail.id);

    const conclusion = shortDirection(node);
    const result = create("p", "ttvc-direction", conclusion);
    detail.append(result);

    const facts = [
      ["为什么停在这里", node.problem],
      ["采用的方向", node.approach],
      ["回来后的第一步", node.nextIdea],
    ].filter(([, value]) => text(value) && text(value) !== conclusion);
    if (facts.length) {
      const factList = create("dl", "ttvc-facts");
      facts.forEach(([term, value]) => {
        const row = create("div", "ttvc-fact");
        row.append(create("dt", "", term), create("dd", "", text(value)));
        factList.append(row);
      });
      detail.append(factList);
    }
    stem.append(detail);
    branch.append(stem);

    if (childIds.length) {
      const childrenList = create("ul", "ttvc-tributaries");
      childrenList.setAttribute("role", "group");
      childrenList.hidden = !isOpen;
      childIds.forEach((childId) => {
        const child = buildNode(childId, depth + 1, nextAncestry, id);
        if (child) childrenList.append(child);
      });
      branch.append(childrenList);
    }

    button.addEventListener("click", () => {
      const open = !branch.classList.contains("is-expanded");
      branch.classList.toggle("is-expanded", open);
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", `${open ? "收起" : "展开"}${text(node.title, id)}`);
      button.querySelector(".ttvc-toggle-word").textContent = open ? "收起" : "展开";
      detail.hidden = !open;
      const list = branch.querySelector(":scope > .ttvc-tributaries");
      if (list) list.hidden = !open;
      if (open) expanded.add(id); else expanded.delete(id);
    });

    return branch;
  }

  const firstBranches = create("ul", "ttvc-tributaries ttvc-first-tributaries");
  firstBranches.setAttribute("role", "group");
  (graph.children.get(graph.rootId) || []).forEach((childId) => {
    const branch = buildNode(childId, 2, new Set([graph.rootId]), graph.rootId);
    if (branch) firstBranches.append(branch);
  });
  if (firstBranches.children.length) terrain.append(firstBranches);
  else terrain.append(create("p", "ttvc-leaf-note", "根目标尚未长出分支。"));

  const onKeydown = (event) => {
    const current = event.target.closest?.(".ttvc-branch-trigger");
    if (!current) return;
    const visibleButtons = branchButtons.filter((button) => button.offsetParent !== null);
    const index = visibleButtons.indexOf(current);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      visibleButtons[(index + 1) % visibleButtons.length]?.focus();
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      visibleButtons[(index - 1 + visibleButtons.length) % visibleButtons.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      visibleButtons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      visibleButtons.at(-1)?.focus();
    }
  };
  terrain.addEventListener("keydown", onKeydown);
  cleanup.push(() => terrain.removeEventListener("keydown", onKeydown));

  viewport.append(terrain);
  shell.append(topbar, viewport);
  root.replaceChildren(shell);

  const api = {
    destroy() {
      cleanup.forEach((fn) => fn());
      if (root.contains(shell)) root.replaceChildren();
      root.classList.remove("ttvc-host");
      instances.delete(root);
    },
  };
  root.classList.add("ttvc-host");
  instances.set(root, api);
  return api;
}

export const variantC = {
  key: "c",
  name: "折叠地形",
  render: renderVariant,
  destroy(root) {
    instances.get(root)?.destroy();
  },
};
