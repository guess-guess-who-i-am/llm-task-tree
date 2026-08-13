/**
 * Per-step audit packs under scripts/steps/<nodeId>/latest/
 * Linked from execution-flow task blocks (nodeId).
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STEP_SCHEMA = "flow-step/v1";

export function stepPackDir(scriptsDir, nodeId) {
  const safe = String(nodeId || "ROOT").replace(/[^\w.-]+/g, "_");
  return path.join(scriptsDir, "steps", safe, "latest");
}

export function stepPackPath(scriptsDir, nodeId) {
  return path.join(stepPackDir(scriptsDir, nodeId), "step.json");
}

async function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function normalizeStepPack(input, nodeId) {
  const now = new Date().toISOString();
  return {
    schema: STEP_SCHEMA,
    nodeId: String(input?.nodeId || nodeId || ""),
    blockId: String(input?.blockId || ""),
    updatedAt: input?.updatedAt || now,
    title: String(input?.title || ""),
    reportZh: String(input?.reportZh || "report.zh.md"),
    substeps: Array.isArray(input?.substeps) ? input.substeps : []
  };
}

export async function getFlowStep({ scriptsDir, nodeId }) {
  const dir = stepPackDir(scriptsDir, nodeId);
  const stepFile = path.join(dir, "step.json");
  const step = await readJson(stepFile);
  const reportZhPath = path.join(dir, step?.reportZh || "report.zh.md");
  return {
    nodeId,
    dir: path.relative(path.dirname(scriptsDir), dir).replace(/\\/g, "/") || `scripts/steps/${nodeId}/latest`,
    exists: Boolean(step),
    step,
    hasReportZh: existsSync(reportZhPath)
  };
}

export async function putFlowStep({ scriptsDir, nodeId, step, reason }) {
  const dir = stepPackDir(scriptsDir, nodeId);
  await mkdir(dir, { recursive: true });
  const normalized = normalizeStepPack(step, nodeId);
  normalized.updatedAt = new Date().toISOString();
  const stepFile = path.join(dir, "step.json");
  if (existsSync(stepFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runsDir = path.join(scriptsDir, "steps", String(nodeId).replace(/[^\w.-]+/g, "_"), "runs");
    await mkdir(runsDir, { recursive: true });
    await copyFile(stepFile, path.join(runsDir, `${stamp}_${String(reason || "backup").slice(0, 40).replace(/[^\w\u4e00-\u9fff-]+/g, "_")}.json`)).catch(() => {});
  }
  await writeFile(stepFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return { ok: true, nodeId, step: normalized };
}

export async function listStepPackIndex({ scriptsDir, nodeIds }) {
  const items = [];
  for (const nodeId of nodeIds) {
    const info = await getFlowStep({ scriptsDir, nodeId });
    items.push({
      nodeId,
      exists: info.exists,
      updatedAt: info.step?.updatedAt || "",
      substepCount: Array.isArray(info.step?.substeps) ? info.step.substeps.length : 0
    });
  }
  return items;
}
