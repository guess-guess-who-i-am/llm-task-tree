/**
 * Validates the Codex plugin package against the rules the ChatGPT desktop app enforces.
 *
 * A malformed manifest does not raise an error anywhere visible: the desktop app just skips the
 * entry, and the plugin silently never appears in the Plugins Directory. These assertions encode
 * the documented requirements so a broken package fails here instead of on somebody's machine.
 *
 * usage: node scripts/test-plugin-manifest.mjs [marketplaceRoot...]
 *
 * Each argument is a directory holding `.agents/plugins/marketplace.json`. Defaults to this repo's
 * two roots (repo root for Git-marketplace consumers, `marketplace/` for the locally registered
 * source). Pass the kit's roots to check a packaged copy.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const roots = process.argv.slice(2).filter((item) => !item.startsWith("-")).map((item) => path.resolve(item));
const marketplaceRoots = roots.length ? roots : [repoRoot, path.join(repoRoot, "marketplace")];
const failures = [];

const INSTALLATION_POLICIES = new Set(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]);
const AUTHENTICATION_POLICIES = new Set(["ON_INSTALL", "ON_USE"]);
const REQUIRED_INTERFACE = [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "defaultPrompt",
  "brandColor",
  "composerIcon",
  "logo"
];
/** Sizes the built-in OpenAI plugins ship; the desktop app scales from these. */
const ASSET_SIZES = { composerIcon: 360, logo: 512 };

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function readJson(file) {
  const raw = readFileSync(file, "utf8");
  // Codex parses these with a strict JSON reader, so a BOM is a real failure rather than a nit.
  assert.ok(!raw.startsWith("\uFEFF"), `${file} starts with a BOM`);
  return JSON.parse(raw);
}

/** Manifest paths must start with `./` and stay inside the plugin root. */
function resolveManifestPath(root, value, field) {
  assert.ok(typeof value === "string" && value.startsWith("./"), `${field} must start with "./" (got ${value})`);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${field} escapes the plugin root`);
  assert.ok(existsSync(resolved), `${field} points at a missing path: ${resolved}`);
  return resolved;
}

function pngSize(file) {
  const buffer = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.subarray(0, 8).equals(signature), `${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function checkPlugin(pluginRoot, entryName) {
  const manifestFile = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  assert.ok(existsSync(manifestFile), `missing .codex-plugin/plugin.json in ${pluginRoot}`);
  const manifest = readJson(manifestFile);

  assert.equal(manifest.name, entryName, "plugin.json name must match the marketplace entry name");
  assert.match(
    String(manifest.version || ""),
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "version must be semver-ish"
  );
  assert.ok(String(manifest.description || "").length > 10, "description is too short to be useful");
  assert.ok(manifest.license, "license is missing");
  assert.ok(manifest.author?.name, "author.name is missing");
  assert.ok(manifest.homepage && manifest.repository, "homepage/repository are missing");
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 3, "keywords need at least 3 entries");

  const skillsDir = resolveManifestPath(pluginRoot, manifest.skills, "skills");
  assert.ok(statSync(skillsDir).isDirectory(), "skills must point at a directory");

  const ui = manifest.interface;
  assert.ok(ui, "interface block is missing");
  for (const field of REQUIRED_INTERFACE) {
    assert.ok(ui[field] !== undefined && ui[field] !== "", `interface.${field} is missing`);
  }
  assert.ok(Array.isArray(ui.capabilities) && ui.capabilities.length, "interface.capabilities must be a non-empty array");
  // The host's own words: "Starter prompts for the plugin. Capped at 3 entries with a maximum
  // of 128 characters per entry." Anything past that is silently dropped.
  assert.ok(
    Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3,
    `interface.defaultPrompt holds 1-3 starter prompts, got ${ui.defaultPrompt?.length}`
  );
  for (const prompt of ui.defaultPrompt) {
    assert.ok(String(prompt).length <= 128, `starter prompt over 128 chars: ${prompt}`);
  }
  assert.ok(!("websiteURL" in ui), "the host reads websiteUrl; websiteURL is silently ignored");
  assert.match(String(ui.brandColor), /^#[0-9A-Fa-f]{6}$/, "interface.brandColor must be a hex colour");

  for (const [field, expected] of Object.entries(ASSET_SIZES)) {
    const file = resolveManifestPath(pluginRoot, ui[field], `interface.${field}`);
    const { width, height } = pngSize(file);
    assert.equal(`${width}x${height}`, `${expected}x${expected}`, `interface.${field} must be ${expected}x${expected}`);
  }

  for (const [index, shot] of (ui.screenshots || []).entries()) {
    const file = resolveManifestPath(pluginRoot, shot, `interface.screenshots[${index}]`);
    pngSize(file);
  }

  // Codex reads only `.codex-plugin/plugin.json`; keeping the sibling Cursor manifest in step
  // avoids shipping one package that claims two different versions.
  const cursorManifest = path.join(pluginRoot, ".cursor-plugin", "plugin.json");
  if (existsSync(cursorManifest)) {
    assert.equal(readJson(cursorManifest).version, manifest.version, "Cursor manifest version drifted from the Codex one");
  }

  const claudeManifest = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  assert.ok(existsSync(claudeManifest), `missing .claude-plugin/plugin.json in ${pluginRoot}`);
  const claude = readJson(claudeManifest);
  assert.equal(claude.name, manifest.name, "Claude manifest name drifted from the Codex one");
  assert.equal(claude.version, manifest.version, "Claude manifest version drifted from the Codex one");
  resolveManifestPath(pluginRoot, claude.skills, "Claude skills");
  resolveManifestPath(pluginRoot, claude.mcpServers, "Claude mcpServers");

  return manifest;
}

runCase("Claude marketplace resolves the shared plugin", () => {
  const marketplaceFile = path.join(repoRoot, ".claude-plugin", "marketplace.json");
  assert.ok(existsSync(marketplaceFile), `missing ${marketplaceFile}`);
  const marketplace = readJson(marketplaceFile);
  assert.ok(marketplace.name && marketplace.owner?.name, "Claude marketplace identity is incomplete");
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length, "Claude marketplace lists no plugins");
  for (const entry of marketplace.plugins) {
    const pluginRoot = resolveManifestPath(repoRoot, entry.source, `Claude plugins[${entry.name}].source`);
    assert.equal(readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json")).name, entry.name);
  }
});

for (const root of marketplaceRoots) {
  const label = path.basename(root);
  const marketplaceFile = path.join(root, ".agents", "plugins", "marketplace.json");

  runCase(`${label}: marketplace.json is well formed`, () => {
    assert.ok(existsSync(marketplaceFile), `missing ${marketplaceFile}`);
    const marketplace = readJson(marketplaceFile);
    assert.ok(marketplace.name, "marketplace name is missing");
    // Without this the desktop app labels the source with its raw id instead of a readable title.
    assert.ok(marketplace.interface?.displayName, "marketplace interface.displayName is missing");
    assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length, "marketplace lists no plugins");
  });

  if (!existsSync(marketplaceFile)) continue;
  const marketplace = readJson(marketplaceFile);

  for (const entry of marketplace.plugins || []) {
    runCase(`${label}: entry ${entry.name} resolves and declares its policy`, () => {
      const source = typeof entry.source === "string" ? { source: "local", path: entry.source } : entry.source;
      assert.equal(source?.source, "local", "expected a local source entry");
      const pluginRoot = resolveManifestPath(root, source.path, `plugins[${entry.name}].source.path`);
      assert.ok(statSync(pluginRoot).isDirectory(), "source.path must be a directory");

      assert.ok(INSTALLATION_POLICIES.has(entry.policy?.installation), `bad policy.installation: ${entry.policy?.installation}`);
      assert.ok(AUTHENTICATION_POLICIES.has(entry.policy?.authentication), `bad policy.authentication: ${entry.policy?.authentication}`);
      assert.ok(entry.category, "entry category is missing");
    });

    runCase(`${label}: plugin ${entry.name} manifest is install-surface ready`, () => {
      const source = typeof entry.source === "string" ? { source: "local", path: entry.source } : entry.source;
      checkPlugin(path.resolve(root, source.path), entry.name);
    });
  }
}

console.log(`\n${failures.length ? `${failures.length} failing` : "all checks passed"}`);
if (failures.length) process.exit(1);
