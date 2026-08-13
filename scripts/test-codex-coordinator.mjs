import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCoordinatorPrompt,
  buildWorkerPrompt,
  createParallelCodexCoordinator,
  validateParallelJobs
} from "../server/codex-coordinator.js";

const jobs = [
  { nodeId: "N2", title: "UI", instruction: "review the UI", writeSet: ["public/**"] },
  { nodeId: "N3", title: "server", instruction: "review the server", writeSet: ["server/**"] }
];

assert.deepEqual(validateParallelJobs(jobs).map((job) => job.nodeId), ["N2", "N3"]);
assert.throws(() => validateParallelJobs([jobs[0]]), /至少需要 2/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], nodeId: "N2" }]), /重复领取/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["public/app.js"] }]), /写集冲突/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["task-tree.md"] }]), /共享状态/);
assert.throws(() => validateParallelJobs([jobs[0], { ...jobs[1], writeSet: ["../outside"] }]), /越出/);
assert.match(buildWorkerPrompt(validateParallelJobs(jobs)[0]), /read-only worker/i);
assert.match(buildWorkerPrompt(validateParallelJobs(jobs)[0]), /do not call task_tree_write/i);
assert.match(buildCoordinatorPrompt(validateParallelJobs(jobs).map((job) => ({ ...job, output: "evidence" }))), /only writer/i);

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-parallel-"));
let liveWorkers = 0;
let peakWorkers = 0;
const calls = [];
const startTurn = async (options) => {
  calls.push(options);
  const coordinator = options.threadName.includes("coordinator");
  if (!coordinator) {
    liveWorkers += 1;
    peakWorkers = Math.max(peakWorkers, liveWorkers);
    await new Promise((resolve) => setTimeout(resolve, 30));
    liveWorkers -= 1;
  }
  return {
    threadId: coordinator ? "coordinator-thread" : `worker-thread-${calls.length}`,
    turnId: `turn-${calls.length}`,
    output: coordinator ? "merged and verified" : "worker evidence"
  };
};

try {
  const manager = createParallelCodexCoordinator({ projectRoot, startTurn });
  const started = await manager.start(jobs);
  assert.equal(started.status, "queued");
  const finished = await manager.wait(started.id);
  assert.equal(finished.status, "completed");
  assert.equal(peakWorkers, 2, "workers must overlap in wall-clock time");
  assert.equal(calls.length, 3, "two workers are followed by one coordinator");
  assert.ok(calls.slice(0, 2).every((call) => call.sandbox === "read-only" && call.waitForCompletion));
  assert.equal(calls[2].sandbox, "workspace-write");
  assert.match(calls[2].prompt, /worker evidence/);
  assert.ok(!("output" in finished.jobs[0]), "raw reports stay out of status responses");
  assert.equal(finished.jobs[0].reportChars, "worker evidence".length);

  const stored = JSON.parse(await readFile(path.join(projectRoot, ".task-tree-runs", `${started.id}.json`), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.jobs[0].output, "worker evidence");
  console.log("PASS parallel Codex coordinator validates leases, runs workers concurrently, and merges through one writer");
} finally {
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
