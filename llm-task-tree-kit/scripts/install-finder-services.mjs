#!/usr/bin/env node
/** Install Finder Quick Actions that create/open a task tree for selected folders. */
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const [kitArg] = process.argv.slice(2);
if (!kitArg) throw new Error("usage: node scripts/install-finder-services.mjs <kit-dir>");

const kitDir = path.resolve(kitArg);
const home = os.homedir();
const serviceDir = path.join(home, "Library", "Services");
const supportDir = path.join(home, "Library", "Application Support", "LLMTaskTree");
const runner = path.join(kitDir, "finder-task-tree.sh");
const installedRunner = path.join(supportDir, "finder-task-tree.sh");
const exec = promisify(execFile);
if (!await fileExists(runner)) throw new Error(`Finder service runner missing: ${runner}`);

await mkdir(serviceDir, { recursive: true });
await mkdir(supportDir, { recursive: true });
await cp(runner, installedRunner, { force: true });
await chmod(installedRunner, 0o755);
await writeFile(path.join(supportDir, "kit.path"), `${kitDir}\n`, "utf8");

const services = [
  { name: "创建并打开 LLM 任务树", action: "create-open" },
  { name: "打开 LLM 任务树", action: "open" }
];
let workflowsChanged = false;
for (const service of services) {
  const bundle = path.join(serviceDir, `${service.name}.workflow`);
  if (!await currentWorkflowExists(bundle, service)) {
    workflowsChanged = true;
    await rm(bundle, { recursive: true, force: true });
    await mkdir(path.join(bundle, "Contents"), { recursive: true });
    await writeFile(path.join(bundle, "Contents", "Info.plist"), infoPlist(service.name), "utf8");
    await writeFile(path.join(bundle, "Contents", "document.wflow"), workflow(service.action, {
      input: randomUUID().toUpperCase(),
      output: randomUUID().toUpperCase(),
      action: randomUUID().toUpperCase()
    }), "utf8");
    const statusKey = `'(null) - ${service.name} - runWorkflowAsService'`;
    const status = "{ presentation_modes = { ContextMenu = 1; FinderPreview = 1; ServicesMenu = 1; TouchBar = 1; }; }";
    await exec("/usr/bin/defaults", ["write", "pbs", "NSServicesStatus", "-dict-add", statusKey, status]);
  }
}

if (workflowsChanged) {
  await exec("/System/Library/CoreServices/pbs", ["-flush"]).catch(() => {});
  await exec("/usr/bin/killall", ["Finder"]).catch(() => {});
}

console.log(JSON.stringify({
  ok: true,
  services: services.map((service) => path.join(serviceDir, `${service.name}.workflow`)),
  runner: installedRunner,
  instructions: "Finder 中右键文件夹 → 快速操作/服务 → 创建并打开 LLM 任务树"
}, null, 2));

async function fileExists(file) {
  try { await readFile(file); return true; } catch { return false; }
}

async function currentWorkflowExists(bundle, service) {
  try {
    const [info, document] = await Promise.all([
      readFile(path.join(bundle, "Contents", "Info.plist"), "utf8"),
      readFile(path.join(bundle, "Contents", "document.wflow"), "utf8")
    ]);
    return info.includes(`<string>${xml(service.name)}</string>`)
      && info.includes("<string>public.folder</string>")
      && document.includes("finder-task-tree.sh")
      && document.includes(`&quot;${service.action}&quot;`);
  } catch {
    return false;
  }
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function infoPlist(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>NSServices</key><array><dict>
<key>NSBackgroundColorName</key><string>background</string>
<key>NSIconName</key><string>NSActionTemplate</string>
<key>NSMenuItem</key><dict><key>default</key><string>${xml(name)}</string></dict>
<key>NSMessage</key><string>runWorkflowAsService</string>
<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
<key>NSSendFileTypes</key><array><string>public.folder</string></array>
</dict></array>
</dict></plist>
`;
}

function workflow(action, ids) {
  const command = `#!/bin/zsh
set -u
service="$HOME/Library/Application Support/LLMTaskTree/finder-task-tree.sh"
if [ ! -x "$service" ]; then
  exit 1
fi
exec "$service" "${action}" "$@"
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>AMApplicationBuild</key><string>534</string>
<key>AMApplicationVersion</key><string>2.10</string>
<key>AMDocumentVersion</key><string>2</string>
<key>actions</key><array><dict><key>action</key><dict>
<key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
<key>AMActionVersion</key><string>2.0.3</string>
<key>AMApplication</key><array><string>Automator</string></array>
<key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
<key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
<key>ActionName</key><string>运行Shell脚本</string>
<key>ActionParameters</key><dict><key>COMMAND_STRING</key><string>${xml(command)}</string><key>CheckedForUserDefaultShell</key><true/><key>inputMethod</key><integer>1</integer><key>shell</key><string>/bin/zsh</string><key>source</key><string></string></dict>
<key>BundleIdentifier</key><string>com.apple.RunShellScript</string><key>CFBundleVersion</key><string>2.0.3</string>
<key>CanShowSelectedItemsWhenRun</key><false/><key>CanShowWhenRun</key><true/><key>Category</key><array><string>AMCategoryUtilities</string></array>
<key>Class Name</key><string>RunShellScriptAction</string><key>InputUUID</key><string>${ids.input}</string>
<key>OutputUUID</key><string>${ids.output}</string><key>UUID</key><string>${ids.action}</string>
<key>UnlocalizedApplications</key><array><string>Automator</string></array>
<key>arguments</key><dict><key>0</key><dict><key>default value</key><integer>0</integer><key>name</key><string>inputMethod</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>0</string></dict><key>1</key><dict><key>default value</key><false/><key>name</key><string>CheckedForUserDefaultShell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>1</string></dict><key>2</key><dict><key>default value</key><string></string><key>name</key><string>source</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>2</string></dict><key>3</key><dict><key>default value</key><string></string><key>name</key><string>COMMAND_STRING</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>3</string></dict><key>4</key><dict><key>default value</key><string>/bin/sh</string><key>name</key><string>shell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>4</string></dict></dict>
<key>conversionLabel</key><integer>0</integer><key>isViewVisible</key><integer>1</integer><key>location</key><string>309.000000:305.000000</string><key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
</dict><key>isViewVisible</key><integer>1</integer></dict></array>
<key>connectors</key><dict/>
<key>workflowMetaData</key><dict><key>applicationBundleID</key><string>com.apple.finder</string><key>applicationBundleIDsByPath</key><dict><key>/System/Library/CoreServices/Finder.app</key><string>com.apple.finder</string></dict><key>applicationPath</key><string>/System/Library/CoreServices/Finder.app</string><key>applicationPaths</key><array><string>/System/Library/CoreServices/Finder.app</string></array><key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string><key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string><key>presentationMode</key><integer>15</integer><key>processesInput</key><false/><key>serviceApplicationBundleID</key><string>com.apple.finder</string><key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string><key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string><key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string><key>serviceProcessesInput</key><false/><key>systemImageName</key><string>NSActionTemplate</string><key>useAutomaticInputType</key><false/><key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string></dict>
</dict></plist>
`;
}
