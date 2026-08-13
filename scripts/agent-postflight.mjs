import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditTurnMaintenance, repairTurnMaintenance } from "../server/maintenance.js";
import { locateProjectRoot, snapshotWorkspace } from "../server/turn-tracker.js";

const root = locateProjectRoot({ cwd: process.cwd(), fallbackDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
const sinceArg = process.argv.indexOf("--since");
const startedAtMs = sinceArg >= 0 ? Number(process.argv[sinceArg + 1] || 0) : Date.now() - 4 * 60 * 60 * 1000;

const snapshot = await snapshotWorkspace(root);
const changedFiles = Object.entries(snapshot.files)
  .filter(([, info]) => info.mtimeMs >= startedAtMs - 1000)
  .map(([file]) => file);

const repaired = await repairTurnMaintenance({ projectRoot: root, changedFiles });
const status = await auditTurnMaintenance({ projectRoot: root, startedAtMs, changedFiles: repaired.changedFiles });
status.repairs = repaired.repairs;
const outDir = path.join(root, ".task-tree-maintenance", "latest");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
console.log(JSON.stringify(status, null, 2));
if (!status.ok) process.exitCode = 1;
