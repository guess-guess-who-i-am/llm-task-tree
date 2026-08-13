import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const TREE_REGISTRY_SCHEMA = "task-tree-registry/v1";

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function safeRelativeMarkdownPath(projectRoot, value) {
  const relative = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relative || !relative.toLowerCase().endsWith(".md")) throw new Error("tree path must be a relative .md file");
  const resolved = path.resolve(projectRoot, relative);
  const root = path.resolve(projectRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("tree path escapes project root");
  return path.relative(root, resolved).replace(/\\/g, "/");
}

export function defaultTreeRegistry() {
  return {
    schema: TREE_REGISTRY_SCHEMA,
    activeMethod: "method",
    trees: [{
      id: "method",
      title: "方法迭代",
      role: "method",
      path: "task-tree.md",
      description: "当前默认加载和持续迭代的方法任务树",
      editable: true,
      flowEnabled: true
    }]
  };
}

export function normalizeTreeRegistry(projectRoot, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const trees = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.trees) ? source.trees : []) {
    const id = cleanId(candidate?.id);
    if (!id || seen.has(id)) continue;
    let treePath;
    try { treePath = safeRelativeMarkdownPath(projectRoot, candidate.path); } catch { continue; }
    seen.add(id);
    const role = ["method", "background", "architecture", "experiments", "reference"].includes(candidate.role)
      ? candidate.role
      : "reference";
    trees.push({
      id,
      title: String(candidate.title || id).trim().slice(0, 120) || id,
      role,
      path: treePath,
      description: String(candidate.description || "").trim().slice(0, 500),
      editable: candidate.editable !== false,
      flowEnabled: role === "method" && candidate.flowEnabled !== false
    });
  }
  if (!trees.length) return defaultTreeRegistry();
  const requestedActive = cleanId(source.activeMethod);
  const active = trees.find((tree) => tree.id === requestedActive && tree.role === "method")
    || trees.find((tree) => tree.role === "method")
    || trees[0];
  if (active.role !== "method") {
    active.role = "method";
    active.flowEnabled = true;
  }
  return { schema: TREE_REGISTRY_SCHEMA, activeMethod: active.id, trees };
}

export async function loadTreeRegistry({ projectRoot, registryFile, create = true }) {
  let raw = null;
  if (existsSync(registryFile)) {
    try { raw = JSON.parse(await readFile(registryFile, "utf8")); } catch { raw = null; }
  }
  const registry = normalizeTreeRegistry(projectRoot, raw);
  if (create && (!existsSync(registryFile) || JSON.stringify(raw) !== JSON.stringify(registry))) {
    await saveTreeRegistry({ registryFile, registry });
  }
  return registry;
}

export async function saveTreeRegistry({ registryFile, registry }) {
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

export function findTree(registry, id) {
  const requested = cleanId(id) || registry.activeMethod;
  return registry.trees.find((tree) => tree.id === requested) || null;
}

export function resolveTreeFile(projectRoot, tree) {
  if (!tree) throw new Error("tree not found");
  return path.resolve(projectRoot, tree.path);
}

export async function addTree({ projectRoot, registryFile, registry, input }) {
  const id = cleanId(input?.id);
  if (!id) throw new Error("tree id required");
  if (registry.trees.some((tree) => tree.id === id)) throw new Error(`tree ${id} already exists`);
  const role = ["method", "background", "architecture", "experiments", "reference"].includes(input?.role)
    ? input.role
    : "reference";
  const tree = {
    id,
    title: String(input?.title || id).trim().slice(0, 120) || id,
    role,
    path: safeRelativeMarkdownPath(projectRoot, input?.path || `trees/${id}.md`),
    description: String(input?.description || "").trim().slice(0, 500),
    editable: input?.editable !== false,
    flowEnabled: role === "method" && input?.flowEnabled !== false
  };
  const next = { ...registry, trees: [...registry.trees, tree] };
  await saveTreeRegistry({ registryFile, registry: next });
  return { registry: next, tree };
}

export async function setActiveMethod({ registryFile, registry, treeId }) {
  const tree = findTree(registry, treeId);
  if (!tree) throw new Error("tree not found");
  if (tree.role !== "method") throw new Error("only a method tree can become activeMethod");
  const next = { ...registry, activeMethod: tree.id };
  await saveTreeRegistry({ registryFile, registry: next });
  return next;
}

export function starterTreeMarkdown(tree) {
  const rootId = tree.role === "background" ? "BG" : tree.role === "architecture" ? "ARCH" : tree.role === "experiments" ? "EXP" : "ROOT";
  return `# LLM Task Graph\n\n> ${tree.title}（${tree.role}）\n\n## ${rootId} - ${tree.title}\n- Position:\n- Size:\n- Completion: 未开始\n- Problem: 这棵树需要维护哪些当前有效信息？\n- Approach: 只保存本树职责内的当前结论；通过路径引用其它树，不复制全文。\n- Input:\n- Output:\n- Metrics: 30 秒内能找到本树的关键结论、证据入口和待解决问题。\n- Notes:\n- CurrentResult:\n- RootCauseAnalysis:\n- CaseStudy:\n- NextIdea:\n- SelectedSkills:\n\n# GraphState\n\n- Current: ${rootId}\n- Next: ${rootId}\n- NextPlan: 补充这棵树的首个可验证节点。\n\n# Edges\n`;
}
