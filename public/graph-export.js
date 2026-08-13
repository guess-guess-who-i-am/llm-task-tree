const EXPORT_FONT_FAMILY = "Segoe UI, Microsoft YaHei, sans-serif";
const EXPORT_FONT_SIZE = 13;
const EXPORT_LABEL_FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const PAD = 12;
const LABEL_W = 44;
const HEADER_H = 36;
const MIN_EXPORT_WIDTH = 520;
const MAX_EXPORT_WIDTH = 960;

function escapeXml(value) {
  return String(value || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textAttrs({ label = false, fill } = {}) {
  const parts = [
    `font-family="${EXPORT_FONT_FAMILY}"`,
    `font-size="${label ? EXPORT_LABEL_FONT_SIZE : EXPORT_FONT_SIZE}"`,
    `fill="${fill || (label ? "#176b5b" : "#29312d")}"`
  ];
  if (label) parts.push('font-weight="700"');
  return parts.join(" ");
}
function charDisplayWidth(ch) {
  if (!ch) return 0;
  const code = ch.codePointAt(0);
  if (code <= 0x007f) return 7;
  if (code <= 0x00ff) return 8;
  if (/\s/.test(ch)) return 4;
  return 13;
}

function textDisplayWidth(text) {
  let width = 0;
  for (const ch of String(text || "")) width += charDisplayWidth(ch);
  return width;
}

function wrapLines(text, contentWidth) {
  const maxWidth = Math.max(120, contentWidth - PAD * 2 - LABEL_W);
  const result = [];
  const source = String(text || "未填写").trim() || "未填写";
  for (const para of source.split(/\r?\n/)) {
    if (!para) {
      result.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const ch of para) {
      const nextWidth = lineWidth + charDisplayWidth(ch);
      if (line && nextWidth > maxWidth) {
        result.push(line);
        line = ch;
        lineWidth = charDisplayWidth(ch);
      } else {
        line += ch;
        lineWidth = nextWidth;
      }
    }
    if (line) result.push(line);
  }
  return result.length ? result : ["未填写"];
}

function longestLineWidth(lines) {
  return lines.reduce((max, line) => Math.max(max, textDisplayWidth(line)), 0);
}

export function getExportNodeRows(node, folded, { includeNextPlan = false } = {}) {
  if (folded) {
    return [
      { label: "问题", value: node.problem },
      { label: "思路", value: node.approach },
      { label: "结果", value: node.currentResult }
    ];
  }
  const rows = [
    { label: "问题", value: node.problem },
    { label: "思路", value: node.approach },
    { label: "评价", value: node.metrics },
    { label: "批注", value: node.notes },
    { label: "结果", value: node.currentResult },
    { label: "根因", value: node.rootCauseAnalysis }
  ];
  if (node.codeLoc) rows.push({ label: "代码", value: node.codeLoc });
  if (node.caseStudy) rows.push({ label: "案例", value: node.caseStudy });
  if (node.nextIdea) rows.push({ label: "Agent执行", value: node.nextIdea });
  if (includeNextPlan && node.nextPlan) rows.push({ label: "用户备忘", value: node.nextPlan });
  if (node.selectedSkills) rows.push({ label: "Skill", value: node.selectedSkills });
  return rows;
}

export function measureExportNode(node, exportWidth, folded, options = {}) {
  const rows = getExportNodeRows(node, folded, options).map((row) => ({
    ...row,
    lines: wrapLines(row.value, exportWidth)
  }));

  let contentWidth = exportWidth;
  for (const row of rows) {
    const needed = LABEL_W + PAD * 2 + longestLineWidth(row.lines) + 16;
    contentWidth = Math.max(contentWidth, needed);
  }
  contentWidth = Math.min(MAX_EXPORT_WIDTH, Math.max(MIN_EXPORT_WIDTH, contentWidth));

  if (contentWidth !== exportWidth) {
    for (const row of rows) {
      row.lines = wrapLines(row.value, contentWidth);
    }
  }

  let height = HEADER_H + PAD;
  for (const row of rows) {
    height += 6 + row.lines.length * LINE_HEIGHT + 8;
  }
  height += PAD;
  return { width: contentWidth, height: Math.max(height, 120), rows };
}

export function measureNodeContentHeight(node, width, folded, options = {}) {
  return measureExportNode(node, width, folded, options).height;
}

export { MIN_EXPORT_WIDTH };

let cachedExportCss = null;

async function fetchExportStyles() {
  if (cachedExportCss) return cachedExportCss;
  try {
    const response = await fetch("/styles.css", { cache: "force-cache" });
    if (response.ok) cachedExportCss = await response.text();
  } catch {
    cachedExportCss = "";
  }
  return cachedExportCss || "";
}

function escapeForeignHtml(html) {
  return String(html).replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, "&amp;");
}

function serializeGraphNode(nodeEl) {
  const clone = nodeEl.cloneNode(true);
  clone.querySelector(".resizeHandle")?.remove();
  clone.style.position = "relative";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = "100%";
  clone.style.height = "100%";
  clone.style.margin = "0";
  clone.style.boxSizing = "border-box";
  return escapeForeignHtml(clone.outerHTML);
}

export async function exportLiveGraphSvg({
  edgesMarkup = "",
  nodeElements = [],
  edgeLabels = [],
  bounds,
  padding = 48
}) {
  if (!bounds || !nodeElements.length) return null;

  const css = await fetchExportStyles();
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;
  const width = Math.max(320, bounds.width + padding * 2);
  const height = Math.max(240, bounds.height + padding * 2);
  const safeCss = css.replace(/\]\]>/g, "]]\\>");

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><style type="text/css"><![CDATA[${safeCss}]]></style></defs>`,
    `<rect width="100%" height="100%" fill="#fbfbf8"/>`,
    `<g transform="translate(${offsetX}, ${offsetY})">`,
    edgesMarkup
  ];

  for (const item of edgeLabels) {
    parts.push(
      `<text x="${item.x}" y="${item.y}" text-anchor="middle" ${textAttrs({ fill: "#4f6458" })}>${escapeXml(item.text)}</text>`
    );
  }

  for (const nodeEl of nodeElements) {
    const x = parseFloat(nodeEl.style.left) || 0;
    const y = parseFloat(nodeEl.style.top) || 0;
    const w = parseFloat(nodeEl.style.width) || nodeEl.offsetWidth;
    const h = parseFloat(nodeEl.style.height) || nodeEl.offsetHeight;
    const html = serializeGraphNode(nodeEl);
    parts.push(
      `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">`,
      `<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`,
      `</foreignObject>`
    );
  }

  parts.push(`</g></svg>`);
  return parts.join("\n");
}

const CONTAINER_BLOCK_TYPES = new Set(["if", "ifElse", "repeat", "forever", "repeatUntil"]);

const FLOW_COLORS = {
  hat: "#f5a623",
  task: "#4c97ff",
  ref: "#9966ff",
  control: "#ffab19",
  cap: "#ffab19",
  default: "#59c059"
};

function flowBlockText(block) {
  switch (block.type) {
    case "hat":
      return block.title || "当项目开始";
    case "task":
      return `[${block.nodeId || "?"}] ${block.title || "任务"} · ${block.status || "active"}`;
    case "ref":
      return `[参考 ${block.nodeId || "?"}] ${block.title || "参考块"}`;
    case "wait":
      return `等待 ${block.seconds ?? 1} 秒`;
    case "waitUntil":
      return "等待直到 …";
    case "stop":
      return block.label || "停止";
    case "stopAll":
      return "停止全部";
    case "if":
      return "如果 … 那么";
    case "ifElse":
      return "如果 … 那么 … 否则";
    case "repeat":
      return `重复 ${block.times || 1} 次${block.label ? ` · ${block.label}` : ""}`;
    case "forever":
      return "一直重复";
    case "repeatUntil":
      return "重复直到 …";
    default:
      return block.type || "块";
  }
}

function flowBlockColor(block) {
  if (block.type === "hat") return FLOW_COLORS.hat;
  if (block.type === "task") return FLOW_COLORS.task;
  if (block.type === "ref") return FLOW_COLORS.ref;
  if (block.type === "stop" || block.type === "stopAll") return FLOW_COLORS.cap;
  if (CONTAINER_BLOCK_TYPES.has(block.type) || block.type === "wait" || block.type === "waitUntil") {
    return FLOW_COLORS.control;
  }
  return FLOW_COLORS.default;
}

function flattenFlowBlocks(blocks, depth = 0) {
  const rows = [];
  for (const block of blocks || []) {
    rows.push({ block, depth });
    if (block.body?.length) rows.push(...flattenFlowBlocks(block.body, depth + 1));
    if (block.elseBody?.length) rows.push(...flattenFlowBlocks(block.elseBody, depth + 1));
  }
  return rows;
}

export function buildFlowGraphSvg(blocks, { mode = "project", title = "执行流程" } = {}) {
  const flat = flattenFlowBlocks(blocks);
  if (!flat.length) return null;

  const blockWidth = 620;
  const blockHeight = 34;
  const blockGap = 8;
  const leftPad = 40;
  const topPad = 48;
  const indentStep = 28;

  let height = topPad;
  const layouts = flat.map(({ block, depth }) => {
    const y = height;
    const innerWidth = Math.max(240, blockWidth - depth * indentStep - 24);
    const text = flowBlockText(block);
    const lines = wrapLines(text, innerWidth + LABEL_W);
    const extra = Math.max(0, (lines.length - 1) * LINE_HEIGHT);
    const h = blockHeight + extra;
    height += h + blockGap;
    return { block, depth, y, lines, h, color: flowBlockColor(block), innerWidth };
  });

  height += topPad;
  const width = blockWidth + leftPad * 2;

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#eef2fb"/>`,
    `<text x="${leftPad}" y="28" ${textAttrs({ label: true, fill: "#314053" })}>${escapeXml(title)} · ${escapeXml(mode)}</text>`
  ];

  for (const item of layouts) {
    const x = leftPad + item.depth * indentStep;
    parts.push(
      `<rect x="${x}" y="${item.y}" width="${blockWidth - item.depth * indentStep}" height="${item.h}" rx="8" fill="${item.color}" opacity="0.92"/>`
    );
    item.lines.forEach((line, index) => {
      parts.push(
        `<text x="${x + 12}" y="${item.y + 22 + index * LINE_HEIGHT}" ${textAttrs({ fill: "#ffffff" })}>${escapeXml(line)}</text>`
      );
    });
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

export function downloadSvg(svg, filename) {
  if (!svg) return false;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
