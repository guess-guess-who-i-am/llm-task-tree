import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_STATUS = new Set(["active", "closed"]);

function cleanId(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean))];
}

function publicScope(scope) {
  if (!scope) return null;
  return {
    scopeId: scope.scopeId,
    runId: scope.runId,
    treeId: scope.treeId,
    role: scope.role,
    targetNodeIds: [...scope.targetNodeIds],
    writableNodeIds: [...scope.writableNodeIds],
    writeSet: [...scope.writeSet],
    instruction: scope.instruction,
    status: scope.status,
    createdAt: scope.createdAt,
    updatedAt: scope.updatedAt
  };
}

export function createExecutionScopeStore({ projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const dir = path.join(projectRoot, ".task-tree-scopes");
  const memory = new Map();

  async function persist(scope) {
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${scope.scopeId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(scope, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async function get(scopeId) {
    const id = cleanId(scopeId);
    if (!id) return null;
    if (memory.has(id)) return publicScope(memory.get(id));
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      const scope = JSON.parse(await readFile(file, "utf8"));
      scope.targetNodeIds = uniqueIds(scope.targetNodeIds);
      scope.writableNodeIds = uniqueIds(scope.writableNodeIds);
      scope.writeSet = Array.isArray(scope.writeSet) ? scope.writeSet.map(String) : [];
      scope.status = VALID_STATUS.has(scope.status) ? scope.status : "closed";
      memory.set(id, scope);
      return publicScope(scope);
    } catch {
      return null;
    }
  }

  return {
    async create(input = {}) {
      const targetNodeIds = uniqueIds(input.targetNodeIds);
      if (!targetNodeIds.length) throw new Error("执行范围至少需要一个 targetNodeId");
      const writableNodeIds = uniqueIds(input.writableNodeIds);
      const unknownWritable = writableNodeIds.filter((id) => !targetNodeIds.includes(id));
      if (unknownWritable.length) throw new Error(`可写节点必须属于目标节点：${unknownWritable.join(", ")}`);
      const now = new Date().toISOString();
      const scope = {
        scopeId: cleanId(input.scopeId) || randomUUID(),
        runId: cleanId(input.runId),
        treeId: cleanId(input.treeId),
        role: String(input.role || "agent").trim() || "agent",
        targetNodeIds,
        writableNodeIds,
        writeSet: [...new Set((Array.isArray(input.writeSet) ? input.writeSet : []).map(String).map((item) => item.trim()).filter(Boolean))],
        instruction: String(input.instruction || "").trim(),
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      memory.set(scope.scopeId, scope);
      await persist(scope);
      return publicScope(scope);
    },

    get,

    async close(scopeId) {
      const current = await get(scopeId);
      if (!current) return null;
      const scope = { ...current, status: "closed", updatedAt: new Date().toISOString() };
      memory.set(scope.scopeId, scope);
      await persist(scope);
      return publicScope(scope);
    },

    async assertWritable(scopeId, nodeId, { treeId = "" } = {}) {
      const scope = await get(scopeId);
      if (!scope) throw new Error(`执行范围不存在：${scopeId}`);
      if (scope.status !== "active") throw new Error(`执行范围已关闭：${scopeId}`);
      if (treeId && scope.treeId && scope.treeId !== treeId) throw new Error(`执行范围属于树 ${scope.treeId}，不能写入 ${treeId}`);
      if (!scope.writableNodeIds.includes(cleanId(nodeId))) {
        throw new Error(`节点 ${nodeId} 不在本 Agent 的可写范围；允许：${scope.writableNodeIds.join(", ") || "无"}`);
      }
      return scope;
    }
  };
}

export function executionScopeEnvironment(scope) {
  return scope?.scopeId ? { TASK_TREE_EXECUTION_SCOPE: scope.scopeId } : {};
}
