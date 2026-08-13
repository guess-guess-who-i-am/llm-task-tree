import { variantA } from "./variant-a.js";
import { variantB } from "./variant-b.js";
import { variantC } from "./variant-c.js";

const variants = [variantA, variantB, variantC];
const root = document.querySelector("#prototypeRoot");
const errorBox = document.querySelector("#prototypeError");
const label = document.querySelector("#variantLabel");
const hint = document.querySelector("#variantHint");
let activeVariant = null;
let model = null;

function readField(section, name) {
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`- ${name}:`));
  if (start < 0) return "";
  const values = [lines[start].slice(`- ${name}:`.length).trim()];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^- [A-Za-z][A-Za-z0-9]*:/.test(line)) break;
    if (/^\s+-\s+/.test(line)) values.push(line.replace(/^\s+-\s+/, "").trim());
    else if (line.trim()) values.push(line.trim());
  }
  return values.filter(Boolean).join("\n");
}

function parseTree(markdown) {
  const graphIndex = markdown.indexOf("\n# GraphState");
  const edgeIndex = markdown.indexOf("\n# Edges");
  const nodeText = graphIndex >= 0 ? markdown.slice(0, graphIndex) : markdown;
  const stateText = graphIndex >= 0 ? markdown.slice(graphIndex, edgeIndex >= 0 ? edgeIndex : undefined) : "";
  const edgeText = edgeIndex >= 0 ? markdown.slice(edgeIndex) : "";
  const nodeMatches = [...nodeText.matchAll(/^##\s+([^\s]+)\s+-\s+(.+)$/gm)];
  const nodes = nodeMatches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < nodeMatches.length ? nodeMatches[index + 1].index : nodeText.length;
    const section = nodeText.slice(start, end);
    return {
      id: match[1].trim(),
      title: match[2].trim(),
      completion: readField(section, "Completion"),
      problem: readField(section, "Problem"),
      approach: readField(section, "Approach"),
      currentResult: readField(section, "CurrentResult"),
      nextIdea: readField(section, "NextIdea"),
      parentIds: [],
      childIds: []
    };
  });
  const graphState = {};
  for (const key of ["Current", "Next"]) {
    graphState[key.toLowerCase()] = stateText.match(new RegExp(`^- ${key}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
  }
  const edges = edgeText.split(/\r?\n(?=##\s+)/).map((section) => {
    const endpoints = section.match(/^- Endpoints:\s*([^,\n]+),\s*([^\n]+)$/m);
    if (!endpoints) return null;
    return {
      source: endpoints[1].trim(),
      target: endpoints[2].trim(),
      label: section.match(/^- Label:\s*(.*)$/m)?.[1]?.trim() || ""
    };
  }).filter(Boolean);
  const rootId = nodes.some((node) => node.id === "ROOT") ? "ROOT" : nodes[0]?.id || "";
  orientEdges(nodes, edges, rootId);
  return { nodes, edges, graphState, rootId };
}

function orientEdges(nodes, edges, rootId) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacent = new Map(nodes.map((node) => [node.id, []]));
  edges.forEach((edge) => {
    adjacent.get(edge.source)?.push(edge.target);
    adjacent.get(edge.target)?.push(edge.source);
  });
  const distance = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const nextId of adjacent.get(id) || []) {
      if (!distance.has(nextId)) {
        distance.set(nextId, distance.get(id) + 1);
        queue.push(nextId);
      }
    }
  }
  edges.forEach((edge) => {
    const sourceDistance = distance.get(edge.source) ?? Number.MAX_SAFE_INTEGER;
    const targetDistance = distance.get(edge.target) ?? Number.MAX_SAFE_INTEGER;
    const parentId = sourceDistance <= targetDistance ? edge.source : edge.target;
    const childId = parentId === edge.source ? edge.target : edge.source;
    const parent = nodeMap.get(parentId);
    const child = nodeMap.get(childId);
    if (parent && child && !parent.childIds.includes(childId)) parent.childIds.push(childId);
    if (parent && child && !child.parentIds.includes(parentId)) child.parentIds.push(parentId);
  });
}

function currentKey() {
  const raw = new URLSearchParams(location.search).get("variant")?.toLowerCase();
  return variants.some((variant) => variant.key === raw) ? raw : variants[0].key;
}

function setVariant(key, replace = false) {
  const variant = variants.find((item) => item.key === key) || variants[0];
  activeVariant?.destroy?.();
  root.replaceChildren();
  root.className = `prototypeRoot prototypeRoot--${variant.key}`;
  variant.render(root, model);
  activeVariant = variant;
  label.textContent = variant.key.toUpperCase();
  hint.textContent = variant.name;
  const url = new URL(location.href);
  url.searchParams.set("variant", variant.key);
  history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function cycle(delta) {
  const index = variants.findIndex((variant) => variant.key === activeVariant?.key);
  setVariant(variants[(index + delta + variants.length) % variants.length].key);
}

document.querySelector("#variantPrev").addEventListener("click", () => cycle(-1));
document.querySelector("#variantNext").addEventListener("click", () => cycle(1));
window.addEventListener("popstate", () => setVariant(currentKey(), true));
window.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  if (event.target.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
  cycle(event.key === "ArrowLeft" ? -1 : 1);
});

try {
  const response = await fetch(`/api/tree?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取任务树失败：HTTP ${response.status}`);
  const payload = await response.json();
  model = parseTree(payload.markdown || "");
  setVariant(currentKey(), true);
} catch (error) {
  errorBox.hidden = false;
  errorBox.textContent = `${error.message}。请从当前项目的任务树服务打开本原型。`;
}
