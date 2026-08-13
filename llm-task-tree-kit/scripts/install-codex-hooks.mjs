import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [projectRootArg, templateDirArg] = process.argv.slice(2);
if (!projectRootArg || !templateDirArg) throw new Error("usage: node install-codex-hooks.mjs <projectRoot> <templateDir>");

const projectRoot = path.resolve(projectRootArg);
const templateDir = path.resolve(templateDirArg);
const targetDir = path.join(projectRoot, ".codex");
const targetHooksDir = path.join(targetDir, "hooks");
const targetConfig = path.join(targetDir, "hooks.json");
const templateConfig = JSON.parse(await readFile(path.join(templateDir, "hooks.json"), "utf8"));

let current = { hooks: {} };
if (existsSync(targetConfig)) {
  try { current = JSON.parse(await readFile(targetConfig, "utf8")); } catch { current = { hooks: {} }; }
}
if (!current.hooks || typeof current.hooks !== "object") current.hooks = {};

for (const [event, groups] of Object.entries(templateConfig.hooks || {})) {
  const existing = Array.isArray(current.hooks[event]) ? current.hooks[event] : [];
  for (const group of groups) {
    const commands = (group.hooks || []).map((hook) => hook.commandWindows || hook.command || "").filter(Boolean);
    const alreadyInstalled = existing.some((item) => (item.hooks || []).some((hook) => commands.includes(hook.commandWindows || hook.command || "")));
    if (!alreadyInstalled) existing.push(group);
  }
  current.hooks[event] = existing;
}

await mkdir(targetHooksDir, { recursive: true });
for (const entry of await readdir(path.join(templateDir, "hooks"), { withFileTypes: true })) {
  if (entry.isFile()) await copyFile(path.join(templateDir, "hooks", entry.name), path.join(targetHooksDir, entry.name));
}
await writeFile(targetConfig, `${JSON.stringify(current, null, 2)}\n`, "utf8");
console.log(`Codex hooks installed: ${path.relative(projectRoot, targetConfig)}`);

