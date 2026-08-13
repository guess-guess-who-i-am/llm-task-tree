#!/usr/bin/env node
/**
 * Forwards to the shared kit's MCP server so a project-relative path is enough.
 * Keeps stdout clean: only the kit runtime may write protocol messages there.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stubDir = import.meta.dirname;
const configFile = path.join(stubDir, "task-tree.config.json");
if (!existsSync(configFile)) {
  process.stderr.write(`missing task-tree.config.json in ${stubDir}\n`);
  process.exit(1);
}

const config = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, ""));
const sharedKit = String(config.sharedKitDir || "");
const entry = sharedKit ? path.join(sharedKit, "scripts", "mcp-server.mjs") : "";
if (!entry || !existsSync(entry)) {
  process.stderr.write(`shared kit MCP server missing: ${entry || "(no sharedKitDir)"}\n`);
  process.exit(1);
}

const projectRoot = path.resolve(stubDir, String(config.projectRoot || ".."));
if (!process.argv.includes("--project-root")) process.argv.splice(2, 0, "--project-root", projectRoot);
await import(pathToFileURL(entry).href);