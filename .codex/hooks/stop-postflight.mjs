import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function readStdinJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

function safe(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

function locateRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (true) {
    if (existsSync(path.join(current, "task-trees.json")) || existsSync(path.join(current, "task-tree.md"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start || process.cwd());
    current = parent;
  }
}

async function loadRuntimeModule(root, name) {
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(root, "server", name),
    path.join(root, "llm-task-tree", "server", name),
    path.resolve(hookDir, "../../server", name)
  ];
  const configFile = path.join(root, "llm-task-tree", "task-tree.config.json");
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
      if (config.sharedKitDir) {
        const sharedKit = path.resolve(path.dirname(configFile), String(config.sharedKitDir));
        candidates.push(path.join(sharedKit, "server", name));
      }
    } catch {
      // A malformed project config should not hide a valid local runtime candidate.
    }
  }
  const kitPathFile = path.join(root, "llm-task-tree", "setup-task-tree.kitpath");
  if (existsSync(kitPathFile)) candidates.push(path.join(readFileSync(kitPathFile, "utf8").trim(), "server", name));
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) throw new Error(`task-tree runtime module not found: ${name}`);
  return import(pathToFileURL(target).href);
}

function reportMarkdown(status) {
  const repairLines = status.repairs?.length ? status.repairs.map((item) => `- AUTO ${item.code}: ${item.message}`) : ["- 无自动修复"];
  const issueLines = status.issues.length ? status.issues.map((item) => `- ERROR ${item.code}: ${item.message}`) : ["- 无阻塞问题"];
  const warningLines = status.warnings.length ? status.warnings.map((item) => `- WARN ${item.code}: ${item.message}`) : ["- 无警告"];
  return `# Agent postflight\n\n- checkedAt: ${status.checkedAt}\n- activeTree: ${status.activeTree.id} (${status.tree.path})\n- substantiveFiles: ${status.substantiveFiles.length}\n- ok: ${status.ok}\n\n## Automatic repairs\n\n${repairLines.join("\n")}\n\n## Issues\n\n${issueLines.join("\n")}\n\n## Warnings\n\n${warningLines.join("\n")}\n`;
}

const input = await readStdinJson();
const root = locateRoot(input.cwd || process.cwd());
const { auditTurnMaintenance, repairTurnMaintenance } = await loadRuntimeModule(root, "maintenance.js");
const { diffWorkspaceSnapshots, snapshotWorkspace } = await loadRuntimeModule(root, "turn-tracker.js");
const markerFile = path.join(root, ".task-tree-maintenance", "turns", `${safe(input.session_id)}-${safe(input.turn_id)}.json`);
const marker = existsSync(markerFile) ? JSON.parse(await readFile(markerFile, "utf8")) : { startedAtMs: Date.now() - 60_000 };
const currentSnapshot = await snapshotWorkspace(root);
const changedFiles = marker.baseline
  ? diffWorkspaceSnapshots(marker.baseline, currentSnapshot)
  : Object.entries(currentSnapshot.files).filter(([, info]) => info.mtimeMs >= Number(marker.startedAtMs || 0) - 1000).map(([file]) => file);
const repaired = await repairTurnMaintenance({ projectRoot: root, changedFiles, previousTreeMarkdown: marker.activeTreeMarkdown || "" });
const status = await auditTurnMaintenance({ projectRoot: root, startedAtMs: marker.startedAtMs, changedFiles: repaired.changedFiles });
status.repairs = repaired.repairs;
const outDir = path.join(root, ".task-tree-maintenance", "latest");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "report.zh.md"), reportMarkdown(status), "utf8");

const stopHookActive = input.stop_hook_active === true || String(input.stop_hook_active || "").toLowerCase() === "true";
if (!status.ok && !stopHookActive) {
  const details = status.issues.map((item) => `${item.code}: ${item.message}`).join("；");
  process.stdout.write(JSON.stringify({ decision: "block", reason: `任务维护未闭环：${details}。若是字段超预算，必须继续语义精炼（保留结论/数字/风险，历史和证据移出节点，禁止机械截断）；其余问题请更新 active method tree、step evidence 或 flow，然后再次结束。` }));
} else if (!status.ok) {
  process.stdout.write(JSON.stringify({ systemMessage: "postflight 第二次仍有维护债务；为避免 Stop hook 无限循环，本次不再阻塞。请查看 .task-tree-maintenance/latest/report.zh.md。" }));
} else {
  process.stdout.write("{}");
}
