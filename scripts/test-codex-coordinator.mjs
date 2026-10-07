import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "server/codex-coordinator.test.js", "server/codex-parallel-integration.test.js"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log("parallel coordinator contract: automatic plan, unlimited ready concurrency, full context and auto-apply passed");
