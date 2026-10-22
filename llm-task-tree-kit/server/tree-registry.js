import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from 'node:crypto';
import path from "node:path";
import { isDeepStrictEqual } from 'node:util';
import { assertRenderableTree } from './tree-write-safety.js';

export const TREE_REGISTRY_SCHEMA = "task-tree-registry/v1";
const registryQueues = new Map();

function queueRegistry(file, operation) {
  const key = path.resolve(file);
  const next = (registryQueues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  const tracked = next.catch(() => {}).finally(() => { if (registryQueues.get(key) === tracked) registryQueues.delete(key); });
  registryQueues.set(key, tracked);
  return next;
}

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
      title: String(candidate.title || id).trim() || id,
      role,
      path: treePath,
      description: String(candidate.description || "").trim(),
      ...(typeof candidate.planPath === 'string' && candidate.planPath ? { planPath: candidate.planPath } : {}),
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

async function readRegistryState(projectRoot, registryFile, discover = true) {
  let raw = null;
  if (existsSync(registryFile)) {
    try { raw = JSON.parse((await readFile(registryFile, "utf8")).replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`树注册表读取失败，保留原文件：${error.message}`,{cause:error}); }
  }
  const registry = normalizeTreeRegistry(projectRoot, raw);
  // Recover complete independent graphs written by agents/scripts. Folded branch
  // files belong to their parent, and ordinary Markdown is never a tree choice.
  const entries = discover ? await readdir(path.join(projectRoot, 'trees'), {withFileTypes:true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }) : [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = `trees/${entry.name}`;
    if (!entry.isFile() || !entry.name.endsWith('.md') || registry.trees.some(t => t.path === relative)) continue;
    const markdown = await readFile(path.join(projectRoot,relative),'utf8').catch(error => { if(error.code === 'ENOENT')return ''; throw error; });
    const root = markdown.match(/^## ([\w-]+) - (.+)$/m);
    if (!root || !/^# GraphState\s*$/m.test(markdown) || !/^# Edges\s*$/m.test(markdown) || /^>\s*Fold root:/mi.test(markdown)) continue;
    // Earlier installers deliberately removed these bundled IDE reference
    // registrations while keeping their files. Do not undo that migration.
    if ((entry.name === 'architecture.md' && root[1] === 'ARCH' && root[2].trim() === '任务图系统稳定架构')
      || (entry.name === 'background.md' && root[1] === 'BG' && root[2].trim() === '让人类持续看懂并控制大模型任务')) continue;
    const base = cleanId(entry.name.slice(0,-3)) || `tree-${createHash('sha256').update(relative).digest('hex').slice(0,12)}`;
    let id = base, suffix = 1;
    while (registry.trees.some(t => t.id === id)) id = `${base.slice(0,70)}-${suffix++}`;
    registry.trees.push({id,title:root[2].trim(),role:'reference',path:relative,description:'已有独立任务树',editable:true,flowEnabled:false});
  }
  return {raw,registry};
}

export async function loadTreeRegistry({ projectRoot, registryFile, create = true }) {
  const load = async () => {
    const {raw,registry} = await readRegistryState(projectRoot,registryFile);
    if (create && !isDeepStrictEqual(raw,registry)) await saveTreeRegistry({registryFile,registry});
    return registry;
  };
  return create ? queueRegistry(registryFile,load) : load();
}

export async function saveTreeRegistry({ registryFile, registry }) {
  await mkdir(path.dirname(registryFile), { recursive: true });
  const temporary = `${registryFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary,registryFile);
  } finally { await unlink(temporary).catch(error => {if(error.code!=='ENOENT')throw error;}); }
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
  return queueRegistry(registryFile, async () => {
  // Reload inside the queue: callers can carry a stale snapshot while another
  // worker registers its own tree. Never replace that worker's registration.
  const disk = await readRegistryState(projectRoot,registryFile,false);
  registry = disk.raw ? disk.registry : registry || disk.registry;
  const id = cleanId(input?.id);
  if (!id) throw new Error("tree id required");
  const existing = registry.trees.find(tree => tree.id === id);
  if (existing && !input.registerExisting) throw new Error(`tree ${id} already exists`);
  input = {...existing,...input};
  const role = ["method", "background", "architecture", "experiments", "reference"].includes(input?.role)
    ? input.role
    : "reference";
  const tree = {
    id,
    title: String(input?.title || id).trim() || id,
    role,
    path: safeRelativeMarkdownPath(projectRoot, input?.path || `trees/${id}.md`),
    description: String(input?.description || "").trim(),
    ...(typeof input?.planPath === 'string' && input.planPath ? { planPath: input.planPath } : {}),
    editable: input?.editable !== false,
    flowEnabled: role === "method" && input?.flowEnabled !== false
  };
  if (existing && existing.path !== tree.path) throw new Error(`tree ${id} already uses ${existing.path}`);
  if (registry.trees.some(t => t.path === tree.path && t.id !== id)) throw new Error(`tree path ${tree.path} already registered`);
  if (input.createFile || input.registerExisting) {
    const file = resolveTreeFile(projectRoot,tree);
    if (input.registerExisting && !existsSync(file)) throw new Error(`待接入的树文件不存在：${tree.path}`);
    const markdown = existsSync(file) ? await readFile(file,'utf8') : input.markdown || starterTreeMarkdown(tree);
    if (!/^## [\w-]+ - .+/m.test(markdown) || !/^# GraphState\s*$/m.test(markdown) || !/^# Edges\s*$/m.test(markdown)
      || /^>\s*Fold root:/mi.test(markdown)) throw new Error('独立树需要节点、GraphState 和 Edges；折叠子树请用 task_tree_subtree 链接父节点');
    assertRenderableTree(markdown);
    if (existsSync(file) && input.markdown !== undefined && input.markdown !== markdown) throw new Error('树文件已存在，创建不会覆盖正文；请用 task_tree_write(treeId,...) 修改');
    if (!existsSync(file)) {
      await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file,markdown,{encoding:'utf8',flag:'wx'});
    }
  }
  const next = { ...registry, trees: existing ? registry.trees.map(t => t.id === id ? {...t,...tree} : t) : [...registry.trees, tree] };
  await saveTreeRegistry({ registryFile, registry: next });
  return { registry: next, tree };
  });
}

export async function setActiveMethod({ registryFile, registry, treeId }) {
  return queueRegistry(registryFile,async () => {
  registry = (await readRegistryState(path.dirname(registryFile),registryFile)).registry;
  const tree = findTree(registry, treeId);
  if (!tree) throw new Error("tree not found");
  if (tree.role !== "method") throw new Error("only a method tree can become activeMethod");
  const next = { ...registry, activeMethod: tree.id };
  await saveTreeRegistry({ registryFile, registry: next });
  return next;
  });
}

export function starterTreeMarkdown(tree) {
  const rootId = tree.role === "background" ? "BG" : tree.role === "architecture" ? "ARCH" : tree.role === "experiments" ? "EXP" : "ROOT";
  return `# LLM Task Graph\n\n> ${tree.title}（${tree.role}）\n\n## ${rootId} - ${tree.title}\n- Position:\n- Size:\n- Completion: 未开始\n- Problem: 这棵树需要维护哪些当前有效信息？\n- Approach: 只保存本树职责内的当前结论；通过路径引用其它树，不复制全文。\n- Input:\n- Output:\n- Metrics: 30 秒内能找到本树的关键结论、证据入口和待解决问题。\n- Notes:\n- CurrentResult:\n- RootCauseAnalysis:\n- CaseStudy:\n- NextIdea:\n- SelectedSkills:\n\n# GraphState\n\n- Current: ${rootId}\n- Next: ${rootId}\n- NextPlan: 补充这棵树的首个可验证节点。\n\n# Edges\n`;
}
