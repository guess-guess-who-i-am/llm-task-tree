import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceManager } from "../server/parallel-worktree.js";

const exec = promisify(execFile);
const projectRoot = await mkdtemp(path.join(os.tmpdir(), "parallel-worktree-project-"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "parallel-worktree-state-"));
const git = (cwd, args) => exec("git", args, { cwd });
const text = (relative) => readFile(path.join(projectRoot, relative), "utf8");

try {
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.name", "Parallel Test"]);
  await git(projectRoot, ["config", "user.email", "parallel@test.local"]);
  await writeFile(path.join(projectRoot, "shared.txt"), "base\n");
  await writeFile(path.join(projectRoot, "task-tree.md"), "# Tree\n");
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "base"]);

  const manager = createGitWorkspaceManager({ projectRoot, tempRoot });
  const run = await manager.prepare("overlap");
  const first = await manager.createWorker("overlap", "A", run.snapshotCommit);
  const second = await manager.createWorker("overlap", "B", run.snapshotCommit);

  await writeFile(path.join(first, "shared.txt"), "from A\n");
  await writeFile(path.join(first, "task-tree.md"), "# Tree from A\n");
  await writeFile(path.join(second, "shared.txt"), "from B\n");
  await writeFile(path.join(second, "task-tree.md"), "# Tree from B\n");

  const inspected = await manager.inspectChanges(first, run.snapshotCommit, []);
  assert.deepEqual(inspected.violations, []);
  assert.deepEqual(inspected.changedFiles.sort(), ["shared.txt", "task-tree.md"]);

  const commitA = await manager.commit(first, "A", run.snapshotCommit);
  const commitB = await manager.commit(second, "B", run.snapshotCommit);
  await manager.integrate(run.integrationPath, commitA, run.snapshotCommit);

  let conflict;
  try {
    await manager.integrate(run.integrationPath, commitB, run.snapshotCommit);
  } catch (error) {
    conflict = error;
  }
  assert.equal(conflict?.code, "CHERRY_PICK_CONFLICT");
  assert.deepEqual(conflict.files.sort(), ["shared.txt", "task-tree.md"]);

  await writeFile(path.join(run.integrationPath, "shared.txt"), "from A\nfrom B\n");
  await writeFile(path.join(run.integrationPath, "task-tree.md"), "# Tree from A\n# Tree from B\n");
  await git(run.integrationPath, ["add", "shared.txt", "task-tree.md"]);
  await manager.continueIntegration(run.integrationPath);
  const summary = await manager.summarize(run.integrationPath, run.snapshotCommit);
  assert.deepEqual(summary.changedFiles.sort(), ["shared.txt", "task-tree.md"]);
  assert.equal(summary.patchTruncated, false);
  assert.match(summary.patchPreview, /from A/);
  assert.match(summary.patchPreview, /from B/);

  // Simulate a live edit after the run snapshot. accept() merges it in an isolated
  // worktree, then applies a clean delta without touching the main index.
  await writeFile(path.join(projectRoot, "shared.txt"), "live user edit\n");
  let applyConflictFiles = [];
  const accepted = await manager.accept({
    integrationPath: run.integrationPath,
    snapshotCommit: run.snapshotCommit,
    changedFiles: summary.changedFiles,
    resolveConflict: async (integrationPath, files) => {
      applyConflictFiles = files;
      await writeFile(path.join(integrationPath, "shared.txt"), "live user edit\nfrom A\nfrom B\n");
      await writeFile(path.join(integrationPath, "task-tree.md"), "# Tree from A\n# Tree from B\n");
      await git(integrationPath, ["add", "shared.txt", "task-tree.md"]);
      await manager.continueIntegration(integrationPath);
    }
  });
  assert.deepEqual(applyConflictFiles.sort(), ["shared.txt"]);
  assert.deepEqual(accepted.appliedFiles.sort(), ["shared.txt", "task-tree.md"]);
  assert.equal(await text("shared.txt"), "live user edit\nfrom A\nfrom B\n");
  assert.equal(await text("task-tree.md"), "# Tree from A\n# Tree from B\n");
  assert.equal((await git(projectRoot, ["diff", "--name-only", "--diff-filter=U"])).stdout, "", "main worktree must never contain unresolved index entries");

  await manager.removeWorker(first);
  await manager.removeWorker(second);
  await manager.cleanup({ ...run, runId: "overlap" });
  console.log("parallel worktree: overlapping files, task-tree merge, isolated conflict resolution and automatic apply passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
}
