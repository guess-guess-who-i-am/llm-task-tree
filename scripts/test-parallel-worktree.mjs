import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceManager } from "../server/parallel-worktree.js";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "task-tree-git-workspace-"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "task-tree-git-worktrees-"));
const git = (args, cwd = root) => exec("git", args, { cwd, windowsHide: true });
const text = async (file) => (await readFile(file, "utf8")).replace(/\r\n/g, "\n");

try {
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "server"), { recursive: true });
  await writeFile(path.join(root, "public", "app.js"), "base\n");
  await writeFile(path.join(root, "public", "removed.txt"), "remove me\n");
  await writeFile(path.join(root, "server", "api.js"), "base api\n");
  await git(["init"]);
  await git(["config", "user.name", "Workspace Test"]);
  await git(["config", "user.email", "workspace@test.local"]);
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);

  // The snapshot must include dirty tracked and untracked user work without committing the main worktree.
  await writeFile(path.join(root, "public", "app.js"), "dirty user baseline\n");
  await writeFile(path.join(root, "public", "draft.txt"), "untracked baseline\n");
  await writeFile(path.join(root, "public", "staged.txt"), "staged baseline\n");
  await git(["add", "public/staged.txt"]);
  await unlink(path.join(root, "public", "removed.txt"));
  const cachedBefore = (await git(["diff", "--cached", "--binary"])).stdout;
  const workspace = createGitWorkspaceManager({ projectRoot: root, tempRoot });
  const prepared = await workspace.prepare("run-one");
  assert.equal(await text(path.join(prepared.integrationPath, "public", "app.js")), "dirty user baseline\n");
  assert.equal(await text(path.join(prepared.integrationPath, "public", "draft.txt")), "untracked baseline\n");
  assert.equal(await text(path.join(prepared.integrationPath, "public", "staged.txt")), "staged baseline\n");
  await assert.rejects(() => readFile(path.join(prepared.integrationPath, "public", "removed.txt"), "utf8"), /ENOENT/);
  assert.equal((await git(["diff", "--cached", "--binary"])).stdout, cachedBefore, "snapshot cannot change the main index");
  assert.match((await git(["status", "--porcelain"])).stdout, /public\/app\.js/);

  const worker = await workspace.createWorker("run-one", "ui", prepared.snapshotCommit);
  await writeFile(path.join(worker, "public", "app.js"), "worker result\n");
  await writeFile(path.join(worker, "server", "api.js"), "outside lease\n");
  let inspected = await workspace.inspectChanges(worker, prepared.snapshotCommit, ["public/**"]);
  assert.deepEqual(inspected.violations, ["server/api.js"]);
  await writeFile(path.join(worker, "server", "api.js"), "base api\n");
  inspected = await workspace.inspectChanges(worker, prepared.snapshotCommit, ["public/**"]);
  assert.deepEqual(inspected.violations, []);
  await mkdir(path.join(worker, "scripts"), { recursive: true });
  await writeFile(path.join(worker, "scripts", "project.json"), "{}\n");
  inspected = await workspace.inspectChanges(worker, prepared.snapshotCommit, ["public/**", "scripts/**"]);
  assert.deepEqual(inspected.violations, ["scripts/project.json"]);
  await unlink(path.join(worker, "scripts", "project.json"));
  const workerCommit = await workspace.commit(worker, "worker ui", prepared.snapshotCommit);
  await workspace.integrate(prepared.integrationPath, workerCommit, prepared.snapshotCommit);
  await workspace.removeWorker(worker);
  const review = await workspace.summarize(prepared.integrationPath, prepared.snapshotCommit);
  assert.deepEqual(review.changedFiles, ["public/app.js"]);
  assert.equal(await text(path.join(root, "public", "app.js")), "dirty user baseline\n", "review cannot mutate the main worktree");

  const accepted = await workspace.accept({ ...prepared, changedFiles: review.changedFiles });
  assert.deepEqual(accepted.appliedFiles, ["public/app.js"]);
  assert.equal(await text(path.join(root, "public", "app.js")), "worker result\n");
  assert.equal(await text(path.join(root, "server", "api.js")), "base api\n");

  // A named branch context keeps one stable cwd for Codex thread/resume and rejects concurrent use.
  const persistent = await workspace.createWorker("run-context-one", "ui", prepared.snapshotCommit, {
    contextKey: "n2-ui-context",
    persistentContext: true
  });
  await assert.rejects(
    () => workspace.createWorker("run-context-two", "other", prepared.snapshotCommit, {
      contextKey: "n2-ui-context",
      persistentContext: true
    }),
    (error) => error.code === "CONTEXT_BUSY"
  );
  await writeFile(path.join(persistent, "public", "app.js"), "temporary context edit\n");
  await workspace.removeWorker(persistent, { preserveContext: true });
  const persistentAgain = await workspace.createWorker("run-context-three", "ui", prepared.snapshotCommit, {
    contextKey: "n2-ui-context",
    persistentContext: true
  });
  assert.equal(persistentAgain, persistent, "the same context must retain one stable cwd");
  assert.equal(await text(path.join(persistentAgain, "public", "app.js")), "dirty user baseline\n", "context reuse resets to the new baseline");
  await workspace.removeWorker(persistentAgain, { preserveContext: true });
  await workspace.cleanup({ ...prepared, runId: "run-one" });

  // A same-file edit after approval is a conflict, never something the accept action may overwrite.
  const conflictPrepared = await workspace.prepare("run-conflict");
  const conflictWorker = await workspace.createWorker("run-conflict", "ui", conflictPrepared.snapshotCommit);
  await writeFile(path.join(conflictWorker, "public", "app.js"), "parallel change\n");
  const conflictCommit = await workspace.commit(conflictWorker, "parallel ui", conflictPrepared.snapshotCommit);
  await workspace.integrate(conflictPrepared.integrationPath, conflictCommit, conflictPrepared.snapshotCommit);
  await workspace.removeWorker(conflictWorker);
  await writeFile(path.join(root, "public", "app.js"), "new user edit\n");
  const conflictReview = await workspace.summarize(conflictPrepared.integrationPath, conflictPrepared.snapshotCommit);
  await assert.rejects(
    () => workspace.accept({ ...conflictPrepared, changedFiles: conflictReview.changedFiles }),
    (error) => error.code === "MAIN_WORKSPACE_CHANGED" && error.files.includes("public/app.js")
  );
  await workspace.cleanup({ ...conflictPrepared, runId: "run-conflict" });
  await unlink(path.join(root, "public", "draft.txt"));

  console.log("PASS git worktrees preserve dirty baselines, enforce leases, integrate safely, and reject concurrent overwrite");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
