/**
 * Copies the task graph runtime into the plugin package.
 *
 * A Codex plugin may declare MCP servers, but the host resolves those paths against the plugin
 * root and refuses anything that starts elsewhere or climbs out: "path must start with `./`",
 * "path must remain below the capability root". A plugin therefore cannot point at a kit sitting
 * somewhere else on the machine - the runtime has to travel inside the package.
 *
 * Shipping a copy means it can drift from the sources, so `--check` re-derives it and fails when
 * the two disagree. That check runs with the tests, which is what turns "the plugin is missing
 * three tools" from a bug report into a build failure.
 *
 *   node scripts/build-plugin-runtime.mjs [--check] [pluginRoot]
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything `scripts/mcp-server.mjs` and the local server it starts need, and nothing else:
 * installers, templates, tests and docs stay out so the package carries only what runs.
 */
export const RUNTIME_SOURCES = ["package.json", "server.js", "scripts/mcp-server.mjs", "server", "public"];

/** The entry the plugin's mcp.json names, relative to the plugin root. */
export const RUNTIME_ENTRY = "./runtime/scripts/mcp-server.mjs";

async function collect(root, rel, found = []) {
  const full = path.join(root, rel);
  if (!existsSync(full)) return found;
  if ((await stat(full)).isDirectory()) {
    for (const entry of (await readdir(full)).sort()) await collect(root, path.posix.join(rel, entry), found);
    return found;
  }
  found.push(rel);
  return found;
}

async function runtimeFiles(sourceRoot) {
  const found = [];
  for (const source of RUNTIME_SOURCES) await collect(sourceRoot, source, found);
  return found.sort();
}

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * @returns {Promise<{files: string[], bytes: number, stale: string[]}>} `stale` lists the files
 * whose packaged copy differs from the source, and is what `--check` reports.
 */
export async function buildPluginRuntime({ sourceRoot, pluginRoot, write = true } = {}) {
  const runtimeDir = path.join(pluginRoot, "runtime");
  const files = await runtimeFiles(sourceRoot);
  if (!files.length) throw new Error(`没有找到运行时文件：${sourceRoot}`);

  if (write) await rm(runtimeDir, { recursive: true, force: true });

  const stale = [];
  let bytes = 0;
  for (const rel of files) {
    const from = path.join(sourceRoot, rel);
    const to = path.join(runtimeDir, rel);
    const source = await readFile(from);
    bytes += source.length;
    if (write) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      continue;
    }
    if (!existsSync(to) || digest(await readFile(to)) !== digest(source)) stale.push(rel);
  }

  if (!write) {
    // A file the sources no longer have is drift too, and the noisier kind: it keeps working until
    // it silently disagrees with everything around it.
    for (const rel of await runtimeFiles(runtimeDir)) {
      if (!files.includes(rel)) stale.push(`${rel}（源里已经没有了）`);
    }
  }

  return { files, bytes, stale };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const sourceRoot = process.cwd();
  const pluginRoot = path.resolve(args.find((item) => !item.startsWith("-")) || path.join(sourceRoot, "marketplace", "plugins", "task-tree"));

  const { files, bytes, stale } = await buildPluginRuntime({ sourceRoot, pluginRoot, write: !check });
  const size = `${files.length} 个文件 / ${(bytes / 1024).toFixed(0)} KB`;

  if (check) {
    if (stale.length) {
      console.error(`插件包里的运行时和源码不一致（${stale.length} 处）：`);
      for (const rel of stale.slice(0, 20)) console.error(`  ${rel}`);
      console.error(`跑 node scripts/build-plugin-runtime.mjs 重新打包。`);
      process.exit(1);
    }
    console.log(`插件运行时与源码一致：${size}`);
  } else {
    console.log(`已打包进 ${path.relative(sourceRoot, pluginRoot).replace(/\\/g, "/")}/runtime：${size}`);
  }
}
