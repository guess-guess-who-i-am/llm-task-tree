/**
 * Contour-based tree layout, shared by the canvas and the MCP layout tool.
 *
 * Loaded twice on purpose: the browser pulls it in as a classic script before app.js,
 * and Node imports it for its side effect and reads globalThis.TaskTreeLayout. Keeping
 * one implementation means "auto arrange" in the UI and the agent-side layout tool can
 * never drift apart, so it must stay free of DOM and Node APIs: node sizes come in as
 * widthOf/heightOf callbacks.
 */
(function (root) {
  function compareNodeIds(a, b) {
    if (a === "ROOT") return -1;
    if (b === "ROOT") return 1;
    const ma = a.match(/^N(\d+)(.*)$/i);
    const mb = b.match(/^N(\d+)(.*)$/i);
    if (ma && mb) {
      const da = Number(ma[1]);
      const db = Number(mb[1]);
      if (da !== db) return da - db;
      return ma[2].localeCompare(mb[2], "zh-CN");
    }
    return a.localeCompare(b, "zh-CN");
  }

  function isHyperedge(edge, nodeIds) {
    const known = (edge.endpoints || []).filter((endpointId) => nodeIds.has(endpointId));
    return known.length > 2;
  }

  /** Horizontal gap between two neighbouring cards. */
  function edgeGap(widthA, widthB) {
    return Math.max(8, Math.min(18, Math.round(((widthA + widthB) / 2) * 0.025)));
  }

  /** Vertical gap below a card of this height. */
  function layerGap(height) {
    return Math.max(64, Math.min(96, Math.round(48 + height * 0.045)));
  }

  /**
   * Picks one parent per node (BFS over non-hyper edges) so the graph can be laid out
   * as a tree; nodes with no usable edge are attached to the root.
   */
  function buildSpanningTreeAdjacency({ nodeIds, edges, rootId }) {
    const ids = [...nodeIds];
    const idSet = new Set(ids);
    const adjacency = new Map(ids.map((id) => [id, []]));
    const parentOf = new Map([[rootId, null]]);
    const layoutEdges = (edges || [])
      .filter((edge) => !isHyperedge(edge, idSet))
      .sort((a, b) => {
        const aRoot = (a.endpoints || []).includes(rootId) ? 1 : 0;
        const bRoot = (b.endpoints || []).includes(rootId) ? 1 : 0;
        if (aRoot !== bRoot) return aRoot - bRoot;
        return String(a.id).localeCompare(String(b.id), "zh-CN");
      });
    const queue = [rootId];

    while (queue.length) {
      const id = queue.shift();
      for (const edge of layoutEdges) {
        const endpoints = (edge.endpoints || []).filter((endpointId) => adjacency.has(endpointId));
        if (endpoints.length !== 2 || !endpoints.includes(id)) continue;
        for (const target of endpoints) {
          if (target === id || parentOf.has(target)) continue;
          parentOf.set(target, id);
          adjacency.get(id).push(target);
          queue.push(target);
        }
      }
    }

    const orphans = ids.filter((id) => id !== rootId && !parentOf.has(id)).sort(compareNodeIds);
    for (const orphanId of orphans) {
      let attached = false;
      for (const edge of layoutEdges) {
        const endpoints = (edge.endpoints || []).filter((endpointId) => adjacency.has(endpointId));
        if (endpoints.length !== 2 || !endpoints.includes(orphanId)) continue;
        const other = endpoints.find((endpointId) => endpointId !== orphanId);
        if (other && parentOf.has(other)) {
          parentOf.set(orphanId, other);
          adjacency.get(other).push(orphanId);
          attached = true;
          break;
        }
      }
      if (!attached) {
        parentOf.set(orphanId, rootId);
        adjacency.get(rootId).push(orphanId);
      }
    }

    for (const [id, targets] of adjacency) {
      adjacency.set(id, [...new Set(targets)].sort(compareNodeIds));
    }
    return adjacency;
  }

  /**
   * Per-depth left/right contours let siblings interlock instead of reserving the
   * widest subtree's box, which is what keeps the horizontal gaps small.
   */
  function buildContourSubtree(id, adjacency, widthOf, stack) {
    const width = widthOf(id);
    if (stack.has(id) || !(adjacency.get(id) || []).length) {
      return {
        positions: new Map([[id, 0]]),
        contours: [{ left: -width / 2, right: width / 2 }]
      };
    }
    stack.add(id);
    const children = adjacency.get(id) || [];
    const placed = [];
    const childContours = [];

    for (const childId of children) {
      const layout = buildContourSubtree(childId, adjacency, widthOf, new Set(stack));
      let shift = 0;
      if (placed.length) {
        const gap = edgeGap(widthOf(placed[placed.length - 1].id), widthOf(childId));
        for (let depth = 0; depth < Math.min(childContours.length, layout.contours.length); depth += 1) {
          shift = Math.max(shift, childContours[depth].right + gap - layout.contours[depth].left);
        }
      }
      placed.push({ id: childId, layout, shift });
      for (let depth = 0; depth < layout.contours.length; depth += 1) {
        const left = layout.contours[depth].left + shift;
        const right = layout.contours[depth].right + shift;
        if (!childContours[depth]) childContours[depth] = { left, right };
        else {
          childContours[depth].left = Math.min(childContours[depth].left, left);
          childContours[depth].right = Math.max(childContours[depth].right, right);
        }
      }
    }

    const childrenCenter = childContours.length
      ? (childContours[0].left + childContours[0].right) / 2
      : 0;
    const positions = new Map([[id, 0]]);
    const contours = [{ left: -width / 2, right: width / 2 }];
    for (const child of placed) {
      const offset = child.shift - childrenCenter;
      for (const [nodeId, x] of child.layout.positions) positions.set(nodeId, x + offset);
      for (let depth = 0; depth < child.layout.contours.length; depth += 1) {
        const targetDepth = depth + 1;
        const left = child.layout.contours[depth].left + offset;
        const right = child.layout.contours[depth].right + offset;
        if (!contours[targetDepth]) contours[targetDepth] = { left, right };
        else {
          contours[targetDepth].left = Math.min(contours[targetDepth].left, left);
          contours[targetDepth].right = Math.max(contours[targetDepth].right, right);
        }
      }
    }
    stack.delete(id);
    return { positions, contours };
  }

  /** Returns top-left coordinates per node id. */
  function layoutContourTree({ rootId, adjacency, widthOf, heightOf, left = 70, top = 70, defaults = {} }) {
    const fallbackWidth = defaults.width || 520;
    const fallbackHeight = defaults.height || 720;
    const width = (id) => Number(widthOf(id)) || fallbackWidth;
    const height = (id) => Number(heightOf(id)) || fallbackHeight;

    const layout = buildContourSubtree(rootId, adjacency, width, new Set());
    const minLeft = Math.min(...layout.contours.map((item) => item.left));
    const rootCenter = left - minLeft;

    const depths = new Map([[rootId, 0]]);
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      const depth = depths.get(id) || 0;
      for (const childId of adjacency.get(id) || []) {
        if (depths.has(childId)) continue;
        depths.set(childId, depth + 1);
        queue.push(childId);
      }
    }

    const maxHeightByDepth = new Map();
    const maxGapByDepth = new Map();
    for (const [id, depth] of depths) {
      maxHeightByDepth.set(depth, Math.max(maxHeightByDepth.get(depth) || 0, height(id)));
      maxGapByDepth.set(depth, Math.max(maxGapByDepth.get(depth) || 0, layerGap(height(id))));
    }
    const yByDepth = new Map([[0, top]]);
    const maxDepth = Math.max(0, ...depths.values());
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      yByDepth.set(
        depth,
        (yByDepth.get(depth - 1) || top)
          + (maxHeightByDepth.get(depth - 1) || fallbackHeight)
          + (maxGapByDepth.get(depth - 1) || 64)
      );
    }

    const placements = new Map();
    for (const [id, x] of layout.positions) {
      placements.set(id, {
        x: rootCenter + x - width(id) / 2,
        y: yByDepth.get(depths.get(id) || 0) || top
      });
    }
    return placements;
  }

  root.TaskTreeLayout = {
    compareNodeIds,
    isHyperedge,
    edgeGap,
    layerGap,
    buildSpanningTreeAdjacency,
    layoutContourTree
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
