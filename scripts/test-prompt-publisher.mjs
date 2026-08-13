import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRuntimeSource,
  loadPublisherConfig,
  validateTranslation
} from "./prompt-publisher/publish-global-prompt.mjs";

const chinese = [
  "# 全局逐轮指令（中文审阅镜像）",
  "",
  "> 这份中文文件只供审阅，不会发送给模型。实际运行源是同目录的 `global-every-turn.en.md`。",
  "",
  "- 保留 `task-tree.md` 和 [TT01]。",
  "- 查看 https://example.com/a。",
  "",
  "## 任务树检查点",
  "",
  "- [TT02] 不要遗漏。"
].join("\n");
const runtime = buildRuntimeSource(chinese);
assert.equal(runtime, [
  "# 全局逐轮指令",
  "",
  "- 保留 `task-tree.md` 和 [TT01]。",
  "- 查看 https://example.com/a。",
  "",
  "## 任务树检查点",
  "",
  "- [TT02] 不要遗漏。",
  ""
].join("\n"));

const english = [
  "# Global per-turn instructions",
  "",
  "- Preserve `task-tree.md` and [TT01].",
  "- See https://example.com/a.",
  "",
  "## Task-tree checkpoints",
  "",
  "- [TT02] Do not omit this rule."
].join("\n");
const validation = validateTranslation(runtime, english);
assert.equal(validation.lines, 8);
assert.equal(validation.bullets, 3);
assert.equal(validation.headings, 2);
assert.ok(validation.lengthRatio > 0.45 && validation.lengthRatio < 4);
assert.throws(() => validateTranslation(runtime, english.replace("[TT02]", "[TT03]")), /ID、URL/);
assert.throws(() => validateTranslation(runtime, english.replace("- See https://example.com/a.\n", "")), /逐行完整性/);
assert.throws(() => validateTranslation(runtime, english.replace("`task-tree.md`", "task-tree.md")), /ID、URL/);

const temp = await mkdtemp(path.join(os.tmpdir(), "prompt-publisher-test-"));
try {
  const configFile = path.join(temp, "targets.json");
  await writeFile(configFile, JSON.stringify({
    sourceFile: "../prompts/source.md",
    localTargets: [{ codexHome: ".." }]
  }));
  const config = await loadPublisherConfig(configFile);
  assert.equal(config.sourceFile, path.resolve(temp, "../prompts/source.md"));
  assert.equal(config.localTargets[0].codexHome, path.resolve(temp, ".."));
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log("PASS Prompt publisher preserves runtime structure and resolves target configuration");
