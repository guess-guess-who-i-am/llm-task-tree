/**
 * Registers the task-graph front doors in Codex's config.toml.
 *
 * Codex resolves mcp_servers from $CODEX_HOME/config.toml only, so this registration is
 * user-global: the tools show up in every Codex session, and each session resolves its own
 * project root from cwd. Only our own blocks are touched; the rest of the file (providers,
 * projects, other plugins) is left exactly as it was.
 *
 * A block that already exists is normally left alone, with one exception: if it points at an entry
 * or marketplace that has since moved, it is rewritten. Append-only was worse than it sounds - the
 * registration froze at whatever the first install wrote, so a machine kept loading an old runtime
 * while the docs described a newer one, and the only symptom was tools quietly missing.
 *
 * With --with-plugin it also registers a local plugin marketplace, using the same shape as
 * the runtime marketplace Codex ships with: a directory holding .agents/plugins/marketplace.json.
 * That is what makes the task graph show up as an installable plugin instead of a bare tool list.
 * For Git-hosted marketplaces use `codex plugin marketplace add <owner/repo>` instead — that
 * command owns the Git snapshot bookkeeping, which this script deliberately does not fake.
 *
 * The entry point defaults to the shared kit's copy, so one registration serves every project
 * on the machine: the server resolves its project root from each session's cwd.
 *
 * usage: node scripts/install-codex-mcp.mjs [--server-name task_tree] [--with-plugin]
 *          [--entry <mcp-server.mjs>] [--marketplace <dir>] [--codex-home <dir>] [--dry-run] [--remove]
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locateProjectRoot } from "../server/turn-tracker.js";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || "") : fallback;
};
const serverName = flag("--server-name", "task_tree");
const marketplaceName = flag("--marketplace-name", "llm-task-tree");
const pluginName = flag("--plugin-name", "task-tree");
const withPlugin = args.includes("--with-plugin");
const dryRun = args.includes("--dry-run");
const remove = args.includes("--remove");

const projectRoot = locateProjectRoot({ cwd: process.cwd() });
const codexHome = flag("--codex-home") || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configFile = path.join(codexHome, "config.toml");

/** The stub config is written by PowerShell, so it can carry a UTF-8 BOM. */
async function readSharedKitDir() {
  const configPath = path.join(projectRoot, "llm-task-tree", "task-tree.config.json");
  if (!existsSync(configPath)) return "";
  try {
    return String(JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")).sharedKitDir || "");
  } catch {
    return "";
  }
}

const sharedKitDir = await readSharedKitDir();

/**
 * Machine-stable first: the shared kit is not tied to one repo, so a single registration
 * covers every installed project. The project stub is the last resort for embedded copies.
 */
function resolveEntryScript() {
  const explicit = flag("--entry");
  const candidates = [
    explicit,
    sharedKitDir ? path.join(sharedKitDir, "scripts", "mcp-server.mjs") : "",
    path.join(projectRoot, "scripts", "mcp-server.mjs"),
    path.join(projectRoot, "llm-task-tree", "mcp-server.mjs")
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`MCP entry not found; tried:\n  ${candidates.join("\n  ")}`);
  return path.resolve(found);
}

const entryScript = resolveEntryScript();

/** Prefers the shared kit copy so every installed project registers the same marketplace. */
function resolveMarketplaceDir() {
  const candidates = [
    flag("--marketplace"),
    sharedKitDir ? path.join(sharedKitDir, "marketplace") : "",
    path.join(projectRoot, "marketplace")
  ].filter(Boolean);
  const found = candidates.find((dir) => existsSync(path.join(dir, ".agents", "plugins", "marketplace.json")));
  return found ? path.resolve(found) : "";
}

// A fresh machine may have no config.toml at all; --remove must not create one.
if (!existsSync(configFile) && !remove) {
  if (!dryRun) {
    await mkdir(codexHome, { recursive: true });
    await writeFile(configFile, "", "utf8");
  }
} else if (!existsSync(configFile)) {
  throw new Error(`Codex config not found: ${configFile}`);
}

/**
 * `identity` is the one line that proves a block still points where it should. Blocks without one
 * carry a user decision instead of a path - `enabled = false` means somebody switched the plugin
 * off - so they are never rewritten.
 */
const blocks = [
  {
    header: `[mcp_servers.${serverName}]`,
    lines: [
      `command = '${process.execPath}'`,
      `args = ['${entryScript}']`,
      "startup_timeout_sec = 30"
    ],
    identity: `args = ['${entryScript}']`
  }
];

if (withPlugin) {
  const marketplaceDir = resolveMarketplaceDir();
  if (!marketplaceDir) throw new Error("marketplace/.agents/plugins/marketplace.json not found; run scripts/build-kit.ps1 first");
  blocks.push({
    header: `[marketplaces.${marketplaceName}]`,
    lines: [
      `last_updated = "${new Date().toISOString().replace(/\.\d+Z$/, "Z")}"`,
      'source_type = "local"',
      `source = '${marketplaceDir}'`
    ],
    identity: `source = '${marketplaceDir}'`
  });
  blocks.push({
    header: `[plugins."${pluginName}@${marketplaceName}"]`,
    lines: ["enabled = true"]
  });
}

const original = existsSync(configFile) ? await readFile(configFile, "utf8") : "";
const hasHeader = (text, header) => text.split(/\r?\n/).some((line) => line.trim() === header);

/** A block runs from its header to the next one, so its extent is found the same way every time. */
function findBlock(text, header) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return { lines, start, end };
}

function stripBlock(text, header) {
  const found = findBlock(text, header);
  if (!found) return { text, removed: false };
  found.lines.splice(found.start, found.end - found.start);
  const cleaned = found.lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  return { text: cleaned, removed: true };
}

/** Swaps a block's body in place, keeping the blank lines that separated it from what follows. */
function replaceBlock(text, header, body) {
  const found = findBlock(text, header);
  if (!found) return text;
  const old = found.lines.slice(found.start, found.end);
  let blanks = 0;
  while (blanks < old.length && !old[old.length - 1 - blanks].trim()) blanks += 1;
  found.lines.splice(found.start, old.length, header, ...body, ...Array(blanks).fill(""));
  return found.lines.join("\n");
}

/** True when the block is there but no longer points where this run resolved. */
function pointsElsewhere(text, item) {
  const found = item.identity ? findBlock(text, item.header) : null;
  if (!found) return false;
  return !found.lines.slice(found.start, found.end).some((line) => line.trim() === item.identity);
}

const FEATURE_FLAG = "enable_mcp_apps";

/**
 * Turns on the host feature that renders `task_tree_open`'s ui:// resource as an interactive panel.
 * Without it the tool still runs, but the host shows only its text and the graph never appears.
 *
 * This is a key inside a table other things also live in, so it cannot use the append-a-block path:
 * a second `[features]` header would make the whole config invalid. An existing value is left
 * alone — if someone turned it off deliberately, that is their call to reverse.
 */
function setFeatureFlag(text, enable) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const header = lines.findIndex((line) => line.trim() === "[features]");

  if (header < 0) {
    if (!enable) return { text, changed: false, reason: "[features] not present" };
    const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${text}${separator}[features]\n${FEATURE_FLAG} = true\n`, changed: true, reason: "created [features]" };
  }

  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const at = lines.findIndex((line, index) => index > header && index < end && new RegExp(`^\\s*${FEATURE_FLAG}\\s*=`).test(line));

  if (enable) {
    if (at >= 0) return { text, changed: false, reason: `${FEATURE_FLAG} already set to: ${lines[at].trim()}` };
    lines.splice(header + 1, 0, `${FEATURE_FLAG} = true`);
    return { text: lines.join("\n"), changed: true, reason: `added ${FEATURE_FLAG} to [features]` };
  }

  if (at < 0 || lines[at].replace(/\s/g, "") !== `${FEATURE_FLAG}=true`) {
    return { text, changed: false, reason: "flag absent or hand-edited; left alone" };
  }
  lines.splice(at, 1);
  // Drop a table we emptied out; an empty [features] carries no meaning.
  if (lines.slice(header + 1, end - 1).every((line) => !line.trim())) lines.splice(header, end - 1 - header);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), changed: true, reason: `removed ${FEATURE_FLAG}` };
}

async function backup() {
  if (!existsSync(configFile)) return "";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = `${configFile}.bak-mcp-${stamp}`;
  if (!dryRun) await copyFile(configFile, target);
  return target;
}

if (remove) {
  let text = original;
  const removed = [];
  for (const item of blocks) {
    const result = stripBlock(text, item.header);
    text = result.text;
    if (result.removed) removed.push(item.header);
  }
  const feature = setFeatureFlag(text, false);
  text = feature.text;
  if (!removed.length && !feature.changed) {
    console.log(JSON.stringify({ ok: true, action: "none", reason: "nothing registered", configFile }, null, 2));
  } else {
    const backupFile = await backup();
    if (!dryRun) await writeFile(configFile, text, "utf8");
    console.log(JSON.stringify({
      ok: true,
      action: dryRun ? "would-remove" : "removed",
      removed,
      feature: feature.reason,
      configFile,
      backupFile
    }, null, 2));
  }
} else {
  const missing = blocks.filter((item) => !hasHeader(original, item.header));
  const stale = blocks.filter((item) => pointsElsewhere(original, item));
  const appended = missing.map((item) => [item.header, ...item.lines, ""].join("\n")).join("\n");
  const separator = !appended ? "" : original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";

  let text = `${original}${separator}${appended}`;
  for (const item of stale) text = replaceBlock(text, item.header, item.lines);
  const feature = setFeatureFlag(text, true);

  if (!missing.length && !stale.length && !feature.changed) {
    console.log(JSON.stringify({
      ok: true,
      action: "none",
      reason: `${blocks.map((item) => item.header).join(", ")} already registered and pointing here`,
      feature: feature.reason,
      configFile
    }, null, 2));
  } else {
    const [verb, past] = missing.length
      ? ["append", "appended"]
      : stale.length ? ["refresh", "refreshed"] : ["update", "updated"];
    const backupFile = await backup();
    if (!dryRun) await writeFile(configFile, feature.text, "utf8");
    console.log(JSON.stringify({
      ok: true,
      action: dryRun ? `would-${verb}` : past,
      headers: missing.map((item) => item.header),
      refreshed: stale.map((item) => item.header),
      feature: feature.reason,
      configFile,
      backupFile,
      entryScript,
      block: appended.trimEnd().split("\n").filter(Boolean),
      next: "重启 Codex 后生效；移除用同一命令加 --remove。Git 市场分发改用 codex plugin marketplace add <owner/repo>"
    }, null, 2));
  }
}
