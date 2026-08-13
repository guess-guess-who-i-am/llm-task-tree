import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExecutionCatalog, computeFlowDrift, getFlowScript, parseFlowMarkdown, putFlowScript, syncFlowBlockStatuses } from "./flow-script.js";
import { getFlowStep, listStepPackIndex, putFlowStep } from "./flow-step.js";
import { findTree, loadTreeRegistry, resolveTreeFile } from "./tree-registry.js";
import { ACTIVE_METHOD_TREE_MAX_BYTES, compactViolationSummary, inspectTreeFile, inspectTreeMarkdown, isTreeMarkdownPath } from "./tree-quality.js";

const EXCLUDED_PREFIXES = [".git/", ".task-tree-maintenance/", ".task-tree-runs/", "versions/", "scripts/versions/", "scripts/maintenance/"];

function normalized(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSubstantiveFile(file) {
  const rel = normalized(file);
  if (!rel || EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  if (/\.(log|tmp)$/i.test(rel) || rel === ".task-tree-port" || rel === ".task-tree-ports") return false;
  if (/^scripts\/steps\/[^/]+\/latest\//.test(rel) || rel === "skill-routing-log.md") return false;
  return true;
}

function currentResultFromMarkdown(markdown, nodeId) {
  const escaped = String(nodeId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = markdown.match(new RegExp(`^##\\s+${escaped}\\s+-.*?(?=^##\\s+|^# GraphState)`, "ms"))?.[0] || "";
  return section.match(/^-\s+CurrentResult:\s*(.*)$/m)?.[1]?.trim() || "";
}

export function maskAdvisoryNextPlan(markdown) {
  return String(markdown || "").replace(
    /^-\s+NextPlan:\s*.*(?:\r?\n(?!-\s+(?:Current|Next|NextPlan|Chain|ChainAutoAdvance|ChainForceNext|ChainRunStatus):|#).*)*/m,
    "- NextPlan: [用户备忘；可能过期；禁止执行。唯一执行依据是 GraphState.Next 指向节点的 NextIdea。]"
  );
}

export async function syncMethodFlowStatus({ projectRoot, treeFile }) {
  const scriptsDir = path.join(projectRoot, "scripts");
  const flowFile = path.join(scriptsDir, "project.json");
  if (!existsSync(flowFile) || !existsSync(treeFile)) return { changed: 0, skipped: true };
  const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir: path.join(projectRoot, "subtrees") });
  const current = await getFlowScript({ scriptsDir, mode: "project", catalog });
  const synced = syncFlowBlockStatuses(catalog, current.script?.blocks || []);
  if (!synced.changed) return { changed: 0, skipped: false };
  await putFlowScript({
    scriptsDir,
    mode: "project",
    script: { blocks: synced.blocks, focusId: current.script?.focusId || catalog.graphState?.current || "ROOT" },
    reason: `任务树保存后自动同步 ${synced.changed} 个 flow 状态`,
    backup: true
  });
  return { changed: synced.changed, skipped: false };
}

function inferChangedNodeId(beforeMarkdown, afterMarkdown) {
  if (!beforeMarkdown || !afterMarkdown) return "";
  const sections = (markdown) => {
    const map = new Map();
    for (const match of String(markdown).matchAll(/^##\s+([A-Za-z0-9_-]+)\s+-[^\n]*\n[\s\S]*?(?=^##\s+|^# GraphState)/gm)) {
      const normalizedSection = match[0]
        .replace(/^-\s+(Position|Size|ReadStatus|ReadFingerprint):.*$/gm, "")
        .replace(/\s+$/gm, "")
        .trim();
      map.set(match[1], normalizedSection);
    }
    return map;
  };
  const beforeById = sections(beforeMarkdown);
  const afterById = sections(afterMarkdown);
  const changed = [...afterById.entries()].filter(([id, section]) => beforeById.get(id) !== section);
  if (changed.length === 1) return changed[0][0];
  const resultChanged = changed.filter(([id, section]) => {
    const prior = beforeById.get(id) || "";
    const result = (text) => text.match(/^-\s+(CurrentResult|Completion):\s*.*$/gm)?.join("\n") || "";
    return result(prior) !== result(section);
  });
  return resultChanged.length === 1 ? resultChanged[0][0] : "";
}

export async function ensureMinimalStepEvidence({ projectRoot, changedFiles = [], activeTreeId = "", previousTreeMarkdown = "" }) {
  const registryFile = path.join(projectRoot, "task-trees.json");
  const registry = await loadTreeRegistry({ projectRoot, registryFile, create: false });
  const tree = findTree(registry, activeTreeId || registry.activeMethod);
  if (!tree || tree.flowEnabled === false) return { created: false, reason: "active tree has no flow" };
  const treeFile = resolveTreeFile(projectRoot, tree);
  const treeRel = normalized(path.relative(projectRoot, treeFile));
  const changed = [...new Set(changedFiles.map(normalized).filter(Boolean))];
  const substantive = changed.filter(isSubstantiveFile).filter((file) => file !== treeRel && file !== "task-trees.json");
  if (!substantive.length) return { created: false, reason: "no substantive files" };
  if (!changed.includes(treeRel)) return { created: false, reason: "tree not updated yet" };
  if (changed.some((file) => /^scripts\/steps\/[^/]+\/latest\/(step\.json|report\.zh\.md)$/.test(file))) {
    return { created: false, reason: "step evidence already changed" };
  }

  const markdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
  const parsed = parseFlowMarkdown(markdown);
  const nodeId = inferChangedNodeId(previousTreeMarkdown, markdown);
  if (!nodeId) return { created: false, reason: "changed node is ambiguous" };
  const node = parsed.nodes.find((item) => item.id === nodeId);
  const scriptsDir = path.join(projectRoot, "scripts");
  const existing = await getFlowStep({ scriptsDir, nodeId });
  const autoSubstep = {
    title: "Stop postflight 自动记录本轮实质文件",
    autoGenerated: true,
    inputs: [{ path: treeRel, name: "active method tree" }],
    outputs: substantive.slice(0, 20).map((file) => ({ path: file }))
  };
  const priorSubsteps = Array.isArray(existing.step?.substeps)
    ? existing.step.substeps.filter((item) => item?.autoGenerated !== true)
    : [];
  await putFlowStep({
    scriptsDir,
    nodeId,
    step: {
      ...(existing.step || {}),
      nodeId,
      title: existing.step?.title || node?.title || `节点 ${nodeId}`,
      reportZh: "report.zh.md",
      substeps: [...priorSubsteps, autoSubstep]
    },
    reason: "Stop postflight 自动补充最小步骤证据"
  });

  const reportFile = path.join(scriptsDir, "steps", String(nodeId).replace(/[^\w.-]+/g, "_"), "latest", "report.zh.md");
  await mkdir(path.dirname(reportFile), { recursive: true });
  const priorReport = existsSync(reportFile) ? await readFile(reportFile, "utf8") : `# ${nodeId} 步骤报告\n`;
  const begin = "<!-- auto-postflight:begin -->";
  const end = "<!-- auto-postflight:end -->";
  const block = `${begin}\n## 自动生成的本轮文件证据\n\n> 此区由 Stop postflight 保底生成；Agent 应在 CurrentResult 中补充结论和测量。\n\n${substantive.slice(0, 20).map((file) => `- \`${file}\``).join("\n")}\n${end}`;
  const report = priorReport.includes(begin)
    ? priorReport.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block)
    : `${priorReport.trim()}\n\n${block}\n`;
  await writeFile(reportFile, report, "utf8");
  return {
    created: true,
    nodeId,
    changedFiles: [
      `scripts/steps/${nodeId}/latest/step.json`,
      `scripts/steps/${nodeId}/latest/report.zh.md`
    ]
  };
}

export async function repairTurnMaintenance({ projectRoot, changedFiles = [], activeTreeId = "", previousTreeMarkdown = "" }) {
  const registryFile = path.join(projectRoot, "task-trees.json");
  const registry = await loadTreeRegistry({ projectRoot, registryFile, create: false });
  const tree = findTree(registry, activeTreeId || registry.activeMethod);
  if (!tree) return { changedFiles, repairs: [] };
  const changed = [...new Set(changedFiles.map(normalized).filter(Boolean))];
  const repairs = [];
  const treeFile = resolveTreeFile(projectRoot, tree);
  const treeRel = normalized(path.relative(projectRoot, treeFile));

  if (tree.flowEnabled !== false && changed.includes(treeRel)) {
    const flow = await syncMethodFlowStatus({ projectRoot, treeFile });
    if (flow.changed) {
      changed.push("scripts/project.json");
      repairs.push({ code: "FLOW_STATUS_SYNCED", message: `自动同步 ${flow.changed} 个 flow 状态` });
    }
  }

  const step = await ensureMinimalStepEvidence({ projectRoot, changedFiles: changed, activeTreeId: tree.id, previousTreeMarkdown });
  if (step.created) {
    changed.push(...step.changedFiles);
    repairs.push({ code: "STEP_EVIDENCE_CREATED", message: `为 ${step.nodeId} 自动生成最小 step evidence` });
  }
  return { changedFiles: [...new Set(changed)], repairs };
}

export async function auditTurnMaintenance({ projectRoot, startedAtMs = 0, changedFiles = [], activeTreeId = "" }) {
  const registryFile = path.join(projectRoot, "task-trees.json");
  const registry = await loadTreeRegistry({ projectRoot, registryFile, create: false });
  const tree = findTree(registry, activeTreeId || registry.activeMethod);
  if (!tree) throw new Error("active method tree not found");
  const treeFile = resolveTreeFile(projectRoot, tree);
  const treeRel = normalized(path.relative(projectRoot, treeFile));
  const changed = [...new Set(changedFiles.map(normalized).filter(Boolean))];
  const substantive = changed.filter(isSubstantiveFile).filter((file) => file !== treeRel && file !== "task-trees.json");
  const changedStepFiles = changed.filter((file) => /^scripts\/steps\/[^/]+\/latest\/(step\.json|report\.zh\.md)$/.test(file));
  const issues = [];
  const warnings = [];
  const markdown = existsSync(treeFile) ? await readFile(treeFile, "utf8") : "";
  const parsed = parseFlowMarkdown(markdown);
  const focusId = parsed.graphState.next || parsed.graphState.current || "";
  const activeQuality = inspectTreeMarkdown(markdown, { file: treeRel, maxBytes: ACTIVE_METHOD_TREE_MAX_BYTES });
  const changedTreeFiles = changed.filter(isTreeMarkdownPath);
  const qualityReports = [];
  for (const file of changedTreeFiles) {
    const report = file === treeRel ? activeQuality : await inspectTreeFile(projectRoot, file);
    if (report) qualityReports.push(report);
  }

  const changedViolations = qualityReports.flatMap((report) => report.violations || []);
  const changedLongLines = qualityReports.flatMap((report) =>
    (report.longLines || []).map((item) => ({ ...item, file: report.file }))
  );
  if (changedViolations.length) {
    issues.push({
      code: "TREE_FIELDS_OVER_BUDGET",
      message: `本轮写入的树有 ${changedViolations.length} 项质量违规：${compactViolationSummary(qualityReports)}。请精炼为简明中文；历史移到 versions/，代码、原始样例和复杂英文术语移到证据文件。`
    });
  }
  if (changedLongLines.length) {
    const shown = changedLongLines.slice(0, 8).map((item) => `${item.file}:${item.line}(${item.chars})`).join("、");
    issues.push({
      code: "TREE_LONG_LINES_AFTER_WRITE",
      message: `本轮写入的树仍有 ${changedLongLines.length} 行超过 240 字符：${shown}。请拆成短 bullet 或移出原始证据。`
    });
  }
  if (!changedTreeFiles.length && activeQuality.violations.length) {
    warnings.push({
      code: "ACTIVE_TREE_FIELDS_OVER_BUDGET",
      message: `活动树已有 ${activeQuality.violations.length} 项质量违规；下次写树时必须一并精炼或中文化：${compactViolationSummary([activeQuality])}`
    });
  }

  if (substantive.length && !changed.includes(treeRel)) {
    issues.push({ code: "TREE_NOT_UPDATED", message: `本轮修改了 ${substantive.length} 个实质文件，但未更新 active method tree ${treeRel}` });
  }
  if (substantive.length && !changedStepFiles.length) {
    issues.push({ code: "STEP_EVIDENCE_MISSING", message: "本轮有实质修改，但没有更新 scripts/steps/<nodeId>/latest/step.json 或 report.zh.md" });
  }
  if (changed.includes(treeRel) && focusId && !currentResultFromMarkdown(markdown, focusId)) {
    warnings.push({ code: "FOCUS_RESULT_EMPTY", message: `焦点节点 ${focusId} 的 CurrentResult 仍为空；若本轮处理其它节点，请确认 step evidence 指向正确 nodeId` });
  }

  let flow = null;
  if (tree.flowEnabled !== false && existsSync(path.join(projectRoot, "scripts", "project.json"))) {
    const scriptsDir = path.join(projectRoot, "scripts");
    const catalog = await buildExecutionCatalog({ projectRoot, treeFile, subtreesDir: path.join(projectRoot, "subtrees") });
    const current = await getFlowScript({ scriptsDir, mode: "project", catalog });
    const drift = computeFlowDrift(catalog, current.script?.blocks || []);
    const nodeIds = (current.script?.blocks || []).filter((block) => block.type === "task" || block.type === "ref").map((block) => block.nodeId).filter(Boolean);
    const stepPacks = await listStepPackIndex({ scriptsDir, nodeIds });
    flow = { drift, stepPacks };
    if (changed.includes(treeRel) && (drift.missingInFlow.length || drift.staleInFlow.length || drift.statusMismatch.length)) {
      issues.push({ code: "FLOW_DRIFT", message: `方法树已变化，但 flow 存在 missing=${drift.missingInFlow.length}, stale=${drift.staleInFlow.length}, status=${drift.statusMismatch.length}` });
    } else if (drift.orderDiffers) {
      warnings.push({ code: "FLOW_ORDER_DIFFERS", message: "flow 顺序与自动建议顺序不同；项目顺序可能是人工设计，未自动覆盖" });
    }
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  const longLines = markdown.split(/\r?\n/).filter((line) => line.length > 240).length;
  if (bytes > 12 * 1024) warnings.push({ code: "ACTIVE_TREE_LARGE", message: `active method tree 为 ${bytes} bytes，超过 12 KiB 建议值` });
  if (longLines) warnings.push({ code: "LONG_LINES", message: `active method tree 有 ${longLines} 行超过 240 字符` });

  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    startedAtMs,
    activeTree: tree,
    changedFiles: changed,
    substantiveFiles: substantive,
    focusId,
    tree: {
      path: treeRel,
      bytes,
      nodes: parsed.nodes.length,
      longLines,
      overBudgetFields: activeQuality.budgetViolations,
      styleViolations: activeQuality.styleViolations
    },
    treeQuality: {
      active: activeQuality,
      changed: qualityReports
    },
    flow,
    issues,
    warnings
  };
}
