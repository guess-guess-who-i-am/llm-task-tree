import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(process.argv[2] || "");
if (!projectRoot) throw new Error("usage: node scripts/migrate-legacy-method-tree.mjs <project-root>");
const treeFile = path.join(projectRoot, "task-tree.md");
const stubEntry = path.join(projectRoot, "llm-task-tree", "mcp-server.mjs");
assert(existsSync(treeFile), `missing active tree: ${treeFile}`);
assert(existsSync(stubEntry), `missing project MCP stub: ${stubEntry}`);

const original = await readFile(treeFile, "utf8");
const now = new Date();
const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const historyRelative = `trees/method-history-${stamp}.md`;
const historyFile = path.join(projectRoot, historyRelative);
const backupFile = path.join(projectRoot, "versions", `${stamp}_before-method-tree-core-state.md`);
await mkdir(path.join(projectRoot, "trees"), { recursive: true });
await mkdir(path.join(projectRoot, "versions"), { recursive: true });
await writeFile(historyFile, original, "utf8");
await writeFile(backupFile, original, "utf8");

const nodeMatches = [...original.matchAll(/^## ((?:ROOT|N\d+(?:_\d+)*)) - ([^\r\n]+)$/gm)];
assert(nodeMatches.length >= 3, `expected legacy nodes, found ${nodeMatches.length}`);
const sections = new Map();
for (let i = 0; i < nodeMatches.length; i += 1) {
  const start = nodeMatches[i].index;
  const graphBoundary = original.indexOf("\n# GraphState", start);
  const endCandidate = nodeMatches[i + 1]?.index ?? graphBoundary;
  const end = endCandidate > start ? endCandidate : original.length;
  sections.set(nodeMatches[i][1], { id: nodeMatches[i][1], title: nodeMatches[i][2].trim(), text: original.slice(start, end) });
}

function field(section, name) {
  const match = section.text.match(new RegExp(`^- ${name}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function positionLine(section, name) {
  const value = field(section, name);
  return value ? `- ${name}: ${value}` : `- ${name}:`;
}

const completionOf = (section) => {
  const value = field(section, "Completion");
  if (/已完成|核心完成/.test(value)) return "已完成";
  if (/未开始/.test(value)) return "未开始";
  if (/需重做|失败|阻塞/.test(value)) return "需重做";
  return "进行中";
};

const archiveNote = (id) => `详细方法、结果、证据和历史版本见 ${historyRelative}#${id}。`;
const active = new Map([
  ["ROOT", {
    completion: "进行中",
    Problem: "如何在 AgentPlatform 上交付并验收 2.1.5-2.1.8 四个精神专科能力域？",
    Approach: "按模板融合 -> 临床支持 -> 资源管理 -> 问答助手 -> 前端验收推进；当前只处理 N3 资源管理验收。",
    Metrics: "验收脚本 PASS；UI 可点验；未解决依赖可复现。",
    CurrentResult: "acceptance_verify PASS=16/16；2.1.5 Linux install+seed 完成，run_demo/UI 仍待验。",
    RootCauseAnalysis: "历史任务把 API、文件、测试和过程全放入活树，并把节点追加到 GraphState/Edges 后；完整历史已归档。"
  }],
  ["N2", {
    completion: "已完成",
    Problem: "临床支持 7 个工具是否已完成可追溯、可运行验收？",
    Approach: "保留 35 路由、7 个前端 Tab 和 24 条 evidence registry；回归失败才返修。",
    Metrics: "e2e 23/23；integration 16/16；extended 8/8；acceptance 16/16；pytest 39 passed/2 skipped。",
    CurrentResult: "24 条依据含 DOI/PMID/NICE/OHDSI 与限制；临床风险明确为 decision-support-only。",
    RootCauseAnalysis: "原缺陷是证据字段、低频路由参数和 numpy.bool_ 序列化漂移；已修复并加入回归。"
  }],
  ["N3", {
    completion: "进行中",
    Problem: "资源管理 22 路由和 3 个 Tab 还缺哪些真实环境验收？",
    Approach: "先确认依赖与后端启动环境，再跑 filespace/dataset/model acceptance；不重复已完成实现。",
    Input: "file_space_service.py、dataset_service.py、model_registry_service.py；resource_management.py。",
    Output: "22 条资源管理路由；文件空间、数据集、模型库 3 个 Tab。",
    Metrics: "22 路由返回合法 JSON；nibabel/PyPDF2 可导入；真实模型配置下 acceptance 可复现。",
    Notes: "P0/P1 已完成；P2 与真实模型配置仍待验收。",
    CurrentResult: "3 个 service、3 个 Tab 和 22 条路由已实现；NIfTI/PDF 依赖与真实模型配置仍是风险。",
    RootCauseAnalysis: "剩余问题是运行环境和依赖验证，不是资源管理路由缺失。",
    NextIdea: "检查 nibabel/PyPDF2 与 DB 模式，运行资源管理 acceptance，记录失败路由和 UI 缺口。"
  }]
]);

function compactNode(section) {
  const override = active.get(section.id);
  const values = override || {
    completion: completionOf(section),
    Problem: `当前节点“${section.title}”的可验证状态是什么？`,
    Notes: archiveNote(section.id)
  };
  const lines = [
    `## ${section.id} - ${section.title}`,
    positionLine(section, "Position"),
    positionLine(section, "Size"),
    `- Completion: ${values.completion}`,
    `- Problem: ${values.Problem}`
  ];
  for (const name of ["Approach", "Input", "Output", "Metrics", "Notes", "CurrentResult", "RootCauseAnalysis", "NextIdea"]) {
    if (values[name]) lines.push(`- ${name}: ${values[name]}`);
  }
  const selectedSkills = field(section, "SelectedSkills");
  if (selectedSkills) lines.push(`- SelectedSkills: ${selectedSkills}`);
  return lines.join("\n");
}

const graphStart = original.indexOf("# GraphState");
const edgesStart = original.indexOf("# Edges");
assert(graphStart >= 0 && edgesStart > graphStart, "legacy GraphState/Edges sections missing");
const graphLines = original.slice(graphStart, edgesStart).match(/^- [^\r\n]*$/gm) || [];
const edgeMatches = [...original.matchAll(/^## (E_[^\r\n]+) - ([^\r\n]+)$/gm)];
const edges = edgeMatches.map((match, index) => {
  const end = edgeMatches[index + 1]?.index ?? original.length;
  const text = original.slice(match.index, end);
  const endpoints = field({ text }, "Endpoints");
  const label = field({ text }, "Label") || match[2].trim();
  return [`## ${match[1]} - ${match[2].trim()}`, `- Endpoints: ${endpoints}`, `- Label: ${label}`].join("\n");
});

const compact = [
  "# LLM Task Graph",
  "",
  `> active method tree；完整旧树归档于 ${historyRelative}。活树只保存影响下一动作的状态。`,
  "",
  [...sections.values()].map(compactNode).join("\n\n"),
  "",
  "# GraphState",
  graphLines.join("\n"),
  "",
  "# Edges",
  edges.join("\n\n"),
  ""
].join("\n");

async function callTool(name, argumentsValue = {}) {
  const child = spawn(process.execPath, [stubEntry], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-tree-migrator", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: argumentsValue } }
  ];
  let buffer = "";
  let stderr = "";
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out: ${stderr}`)); }, 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (parsed.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(parsed);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
  if (response.error) throw new Error(JSON.stringify(response.error));
  const result = response.result;
  const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result;
  if (result?.isError) throw new Error(JSON.stringify(payload));
  return payload;
}

const written = await callTool("task_tree_write", { markdown: compact, reason: "修复旧树结构并压缩 active method tree" });
assert.equal(written.ok, true, JSON.stringify(written));
const registryFile = path.join(projectRoot, "task-trees.json");
const registry = JSON.parse((await readFile(registryFile, "utf8")).replace(/^\uFEFF/, ""));
const historyId = `method-history-${stamp}`;
if (!(registry.trees || []).some((tree) => tree.id === historyId)) {
  registry.trees = [...(registry.trees || []), {
    id: historyId,
    title: "方法树历史归档",
    role: "evidence",
    path: historyRelative,
    description: "压缩前的完整方法树，只读证据，不进入执行流程",
    editable: false,
    flowEnabled: false
  }];
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
const rebuilt = await callTool("task_tree_flow_write", { action: "rebuild", reason: "active method tree 结构修复后重建执行流程" });
const compactResult = await callTool("task_tree_check_compact");
const flow = await callTool("task_tree_flow_status");
await callTool("task_tree_server", { action: "stop" }).catch(() => {});
console.log(JSON.stringify({ historyFile: historyRelative, backupFile: path.relative(projectRoot, backupFile), bytes: compactResult.checked?.[0]?.bytes, nodes: compactResult.checked?.[0]?.nodes, flowBlocks: rebuilt.blocks?.length || rebuilt.script?.blocks?.length, drift: flow.drift }, null, 2));
