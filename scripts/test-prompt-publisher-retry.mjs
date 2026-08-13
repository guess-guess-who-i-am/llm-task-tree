import assert from "node:assert/strict";
import { retryOperation } from "./prompt-publisher/publish-global-prompt.mjs";

let attempts = 0;
const result = await retryOperation(async () => {
  attempts += 1;
  if (attempts < 3) throw new Error(`transient-${attempts}`);
  return "translated";
}, { attempts: 3, delayMs: 0, label: "Codex translation" });

assert.equal(result, "translated");
assert.equal(attempts, 3);

await assert.rejects(
  retryOperation(async (attempt) => {
    throw new Error(`failure-${attempt}`);
  }, { attempts: 2, delayMs: 0, label: "Codex translation" }),
  /Codex translation重试 2 次后仍失败：第 1 次：failure-1 \| 第 2 次：failure-2/
);

console.log("PASS Prompt publisher retries transient translation failures");
