const SVG_NS = 'http://www.w3.org/2000/svg';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function buildGraph(model) {
  const nodes = Array.isArray(model?.nodes) ? model.nodes : [];
  const edges = Array.isArray(model?.edges) ? model.edges : [];
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const children = new Map(nodes.map((node) => [String(node.id), []]));
  const parents = new Map(nodes.map((node) => [String(node.id), []]));

  edges.forEach((edge) => {
    const source = String(edge.source);
    const target = String(edge.target);
    if (!byId.has(source) || !byId.has(target)) return;
    children.get(source).push(target);
    parents.get(target).push(source);
  });

  nodes.forEach((node) => {
    const id = String(node.id);
    (node.childIds || []).map(String).forEach((child) => {
      if (byId.has(child) && !children.get(id).includes(child)) children.get(id).push(child);
      if (byId.has(child) && !parents.get(child).includes(id)) parents.get(child).push(id);
    });
    (node.parentIds || []).map(String).forEach((parent) => {
      if (byId.has(parent) && !parents.get(id).includes(parent)) parents.get(id).push(parent);
      if (byId.has(parent) && !children.get(parent).includes(id)) children.get(parent).push(id);
    });
  });

  const rootId = byId.has(String(model?.rootId))
    ? String(model.rootId)
    : String(nodes.find((node) => parents.get(String(node.id))?.length === 0)?.id || nodes[0]?.id || '');
  const nextId = byId.has(String(model?.graphState?.next)) ? String(model.graphState.next) : '';
  const currentId = byId.has(String(model?.graphState?.current)) ? String(model.graphState.current) : '';

  const depth = new Map();
  const predecessor = new Map();
  if (rootId) {
    depth.set(rootId, 0);
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      children.get(id)?.forEach((child) => {
        if (depth.has(child)) return;
        depth.set(child, depth.get(id) + 1);
        predecessor.set(child, id);
        queue.push(child);
      });
    }
  }

  const detachedDepth = Math.max(0, ...depth.values()) + 1;
  nodes.forEach((node) => {
    const id = String(node.id);
    if (!depth.has(id)) depth.set(id, detachedDepth);
  });

  const spine = [];
  if (nextId && depth.has(nextId)) {
    let cursor = nextId;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      spine.unshift(cursor);
      seen.add(cursor);
      if (cursor === rootId) break;
      cursor = predecessor.get(cursor) || parents.get(cursor)?.[0];
    }
  }
  if (!spine.length && rootId) spine.push(rootId);
  const spineSet = new Set(spine);

  return { nodes, edges, byId, children, parents, rootId, nextId, currentId, depth, spine, spineSet };
}

function computeLayout(graph) {
  const CARD_W = 198;
  const CARD_H = 78;
  const X_STEP = 244;
  const Y_STEP = 106;
  const PAD_X = 54;
  const PAD_Y = 72;
  const groups = new Map();

  graph.nodes.forEach((node) => {
    const id = String(node.id);
    const level = graph.depth.get(id) || 0;
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(id);
  });

  const maxLevelCount = Math.max(1, ...[...groups.values()].map((ids) => ids.length));
  const centerY = PAD_Y + Math.max(2, Math.ceil(maxLevelCount / 2)) * Y_STEP;
  const positions = new Map();

  [...groups.entries()].sort(([a], [b]) => a - b).forEach(([level, ids]) => {
    const branchIds = ids
      .filter((id) => !graph.spineSet.has(id))
      .sort((a, b) => String(graph.byId.get(a)?.title || a).localeCompare(String(graph.byId.get(b)?.title || b), 'zh-CN'));
    const x = PAD_X + level * X_STEP;
    const spineId = ids.find((id) => graph.spineSet.has(id));
    if (spineId) positions.set(spineId, { x, y: centerY, level });
    branchIds.forEach((id, index) => {
      const ring = Math.floor(index / 2) + 1;
      const direction = index % 2 === 0 ? -1 : 1;
      positions.set(id, { x, y: centerY + direction * ring * Y_STEP, level });
    });
  });

  const maxDepth = Math.max(0, ...graph.depth.values());
  const maxY = Math.max(centerY, ...[...positions.values()].map((position) => position.y));
  const minY = Math.min(centerY, ...[...positions.values()].map((position) => position.y));
  const shiftY = minY < PAD_Y ? PAD_Y - minY : 0;
  if (shiftY) positions.forEach((position) => { position.y += shiftY; });

  return {
    positions,
    width: PAD_X * 2 + maxDepth * X_STEP + CARD_W,
    height: Math.max(420, maxY + shiftY + CARD_H + PAD_Y),
    cardWidth: CARD_W,
    cardHeight: CARD_H,
  };
}

function pathForEdge(from, to, cardWidth, cardHeight) {
  const x1 = from.x + cardWidth;
  const y1 = from.y + cardHeight / 2;
  const x2 = to.x;
  const y2 = to.y + cardHeight / 2;
  const bend = Math.max(42, Math.min(112, (x2 - x1) * 0.48));
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function fieldBlock(label, value, tone) {
  if (!value) return null;
  const block = element('section', `tta-detail-block${tone ? ` is-${tone}` : ''}`);
  block.append(element('h3', '', label), element('p', '', value));
  return block;
}

function renderVariantA(root, model) {
  if (!root) throw new Error('Variant A requires a root element.');
  root.__variantADestroy?.();

  const graph = buildGraph(model || {});
  const layout = computeLayout(graph);
  const instanceId = `tta-${Math.random().toString(36).slice(2, 9)}`;
  const cleanups = [];
  const nodeButtons = new Map();
  let selectedId = graph.nextId || graph.currentId || graph.rootId;

  const shell = element('section', 'tta-shell');
  shell.setAttribute('aria-label', '任务树方向脊柱');

  const header = element('header', 'tta-header');
  const identity = element('div', 'tta-identity');
  identity.append(
    element('span', 'tta-eyebrow', 'TASK TREE · VARIANT A'),
    element('h1', '', '方向脊柱'),
    element('p', '', '沿着根本目的、当前方法与下一动作阅读；旁支保留为局面线索。'),
  );
  const actions = element('nav', 'tta-actions');
  actions.setAttribute('aria-label', '树定位');
  const rootButton = element('button', 'tta-jump', '回到 ROOT');
  rootButton.type = 'button';
  const nextButton = element('button', 'tta-jump is-primary', '定位 Next');
  nextButton.type = 'button';
  actions.append(rootButton, nextButton);
  header.append(identity, actions);

  const context = element('div', 'tta-context');
  const spineTitles = graph.spine.map((id) => graph.byId.get(id)?.title || id);
  const trail = element('div', 'tta-trail');
  trail.setAttribute('aria-label', '当前方向主干');
  spineTitles.forEach((title, index) => {
    if (index) trail.append(element('span', 'tta-trail-arrow', '→'));
    trail.append(element('span', index === spineTitles.length - 1 ? 'is-next' : '', title));
  });
  const legend = element('div', 'tta-legend');
  legend.append(
    element('span', 'is-spine', '方向主干'),
    element('span', 'is-branch', '可见旁支'),
  );
  context.append(trail, legend);

  const workspace = element('div', 'tta-workspace');
  const viewport = element('div', 'tta-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '可横向滚动的任务树');
  const stage = element('div', 'tta-stage');
  stage.style.width = `${layout.width}px`;
  stage.style.height = `${layout.height}px`;

  const svg = svgElement('svg', {
    class: 'tta-edges',
    width: layout.width,
    height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    'aria-hidden': 'true',
  });
  const defs = svgElement('defs');
  const marker = svgElement('marker', {
    id: `${instanceId}-arrow`,
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: 'auto',
  });
  marker.append(svgElement('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: 'tta-arrow-head' }));
  defs.append(marker);
  svg.append(defs);

  const explicitEdges = graph.edges.filter((edge) => graph.byId.has(String(edge.source)) && graph.byId.has(String(edge.target)));
  const drawn = new Set();
  const normalizedEdges = [...explicitEdges];
  graph.children.forEach((children, source) => children.forEach((target) => {
    const key = `${source}\u0000${target}`;
    if (!explicitEdges.some((edge) => `${edge.source}\u0000${edge.target}` === key)) normalizedEdges.push({ source, target, label: '' });
  }));

  normalizedEdges.forEach((edge) => {
    const source = String(edge.source);
    const target = String(edge.target);
    const edgeKey = `${source}\u0000${target}`;
    if (drawn.has(edgeKey)) return;
    drawn.add(edgeKey);
    const from = layout.positions.get(source);
    const to = layout.positions.get(target);
    if (!from || !to) return;
    const spineIndex = graph.spine.indexOf(source);
    const isSpine = spineIndex >= 0 && graph.spine[spineIndex + 1] === target;
    const path = svgElement('path', {
      d: pathForEdge(from, to, layout.cardWidth, layout.cardHeight),
      class: `tta-edge${isSpine ? ' is-spine' : ''}${target === graph.nextId ? ' is-next' : ''}`,
      'marker-end': `url(#${instanceId}-arrow)`,
    });
    svg.append(path);
    if (edge.label && isSpine) {
      const label = svgElement('text', {
        x: (from.x + layout.cardWidth + to.x) / 2,
        y: (from.y + to.y) / 2 + layout.cardHeight / 2 - 10,
        class: 'tta-edge-label',
        'text-anchor': 'middle',
      });
      label.textContent = String(edge.label);
      svg.append(label);
    }
  });
  stage.append(svg);

  const detail = element('aside', 'tta-detail');
  detail.setAttribute('aria-live', 'polite');

  function renderDetail(id) {
    const node = graph.byId.get(id);
    detail.replaceChildren();
    if (!node) {
      detail.append(element('p', 'tta-empty', '选择一个节点查看核心信息。'));
      return;
    }
    const top = element('div', 'tta-detail-top');
    const heading = element('div', '');
    heading.append(element('span', 'tta-detail-id', String(node.id)), element('h2', '', node.title || String(node.id)));
    const close = element('button', 'tta-close', '收起');
    close.type = 'button';
    close.setAttribute('aria-label', '收起节点详情');
    close.addEventListener('click', () => {
      shell.classList.remove('has-detail');
      nodeButtons.get(id)?.focus();
    });
    top.append(heading, close);
    detail.append(top);
    const blocks = [
      fieldBlock('核心问题', node.problem, 'problem'),
      fieldBlock('当前方向', node.approach, 'approach'),
      fieldBlock('目标达成状态', node.currentResult, 'result'),
      fieldBlock('下一动作', node.nextIdea, 'next'),
    ].filter(Boolean);
    if (blocks.length) detail.append(...blocks);
    else detail.append(element('p', 'tta-empty', '这个节点还没有可展示的核心说明。'));
  }

  function selectNode(id, revealDetail = true) {
    if (!graph.byId.has(id)) return;
    selectedId = id;
    nodeButtons.forEach((button, buttonId) => {
      const selected = buttonId === id;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    renderDetail(id);
    shell.classList.toggle('has-detail', revealDetail);
  }

  graph.nodes.forEach((node, order) => {
    const id = String(node.id);
    const position = layout.positions.get(id);
    if (!position) return;
    const button = element('button', 'tta-node');
    button.type = 'button';
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    button.style.setProperty('--tta-order', String(Math.min(order, 12)));
    button.dataset.nodeId = id;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `${node.title || id}${id === graph.nextId ? '，下一动作' : ''}${id === graph.currentId ? '，当前节点' : ''}`);
    if (graph.spineSet.has(id)) button.classList.add('is-spine');
    else button.classList.add('is-branch');
    if (id === graph.rootId) button.classList.add('is-root');
    if (id === graph.currentId) button.classList.add('is-current');
    if (id === graph.nextId) button.classList.add('is-next');

    const meta = element('span', 'tta-node-meta');
    const role = id === graph.rootId ? 'ROOT' : id === graph.nextId ? 'NEXT' : id === graph.currentId ? 'CURRENT' : `NODE ${id}`;
    meta.append(element('span', 'tta-node-role', role));
    const completion = clampProgress(node.completion);
    if (completion !== null) meta.append(element('span', 'tta-node-progress-text', `${Math.round(completion)}%`));
    button.append(meta, element('strong', 'tta-node-title', node.title || id));
    if (completion !== null) {
      const progress = element('span', 'tta-node-progress');
      const fill = element('span', '');
      fill.style.width = `${completion}%`;
      progress.append(fill);
      button.append(progress);
    }
    button.addEventListener('click', () => selectNode(id, true));
    nodeButtons.set(id, button);
    stage.append(button);
  });

  function focusNode(id, open = false) {
    const button = nodeButtons.get(id);
    if (!button) return;
    button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    button.focus({ preventScroll: true });
    selectNode(id, open);
  }

  function onNodeKeydown(event) {
    const id = event.target.closest?.('.tta-node')?.dataset.nodeId;
    if (!id) return;
    const currentPosition = layout.positions.get(id);
    let targetId = '';
    if (event.key === 'ArrowLeft') targetId = graph.parents.get(id)?.[0] || '';
    if (event.key === 'ArrowRight') {
      const spineIndex = graph.spine.indexOf(id);
      targetId = graph.spine[spineIndex + 1] || graph.children.get(id)?.[0] || '';
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      targetId = [...layout.positions.entries()]
        .filter(([candidate, position]) => candidate !== id && position.level === currentPosition.level && (position.y - currentPosition.y) * direction > 0)
        .sort((a, b) => Math.abs(a[1].y - currentPosition.y) - Math.abs(b[1].y - currentPosition.y))[0]?.[0] || '';
    }
    if (targetId) {
      event.preventDefault();
      focusNode(targetId, false);
    }
  }

  stage.addEventListener('keydown', onNodeKeydown);
  cleanups.push(() => stage.removeEventListener('keydown', onNodeKeydown));
  rootButton.addEventListener('click', () => focusNode(graph.rootId, false));
  nextButton.addEventListener('click', () => focusNode(graph.nextId || graph.currentId || graph.rootId, true));

  workspace.append(viewport, detail);
  viewport.append(stage);
  shell.append(header, context, workspace);
  root.replaceChildren(shell);
  root.classList.add('task-tree-variant-a-host');
  selectNode(selectedId, false);

  const destroy = () => {
    cleanups.forEach((cleanup) => cleanup());
    if (root.contains(shell)) root.replaceChildren();
    root.classList.remove('task-tree-variant-a-host');
    delete root.__variantADestroy;
  };
  root.__variantADestroy = destroy;
  return destroy;
}

export const variantA = {
  key: 'a',
  name: '方向脊柱',
  render: renderVariantA,
  destroy(root) {
    root?.__variantADestroy?.();
  },
};

export { renderVariantA };
