import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const RUNTIME_PATHS = [".task-tree-runs/", ".task-tree-scopes/", ".task-tree-thread", ".task-tree-threads.json",
  '.task-tree-server.pid', '.task-tree-server.log', '.task-tree-port', '.task-tree-ports'];
const projectUntracked = files => files.filter(relative => {
  const name = path.posix.basename(relative);
  if (/^\.env(?:\..*)?$/.test(name) && name !== '.env.example') return false;
  return !RUNTIME_PATHS.some(reserved => relative === reserved || (reserved.endsWith('/') && relative.startsWith(reserved)));
});

const slash = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");

async function gitCommand(cwd, args, options = {}) {
  const observer = options.onTiming || null;
  const startedAt = observer ? Date.now() : 0;
  let failed = false;
  try {
    const operation = execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: options.encoding || "utf8",
      env: { ...process.env, ...(options.env || {}) }
    });
    operation.child.stdin.end();
    const result = await operation;
    return result.stdout;
  } catch (error) {
    failed = true;
    const detail = String(error.stderr || error.stdout || error.message || "git command failed").trim();
    const wrapped = new Error(`git ${args[0]} 失败：${detail}`);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    if (observer) {
      try {
        observer({ command: String(args[0] || "unknown"), args: args.map((item) => String(item)), durationMs: Date.now() - startedAt, failed });
      } catch {
        // Diagnostic observers must never change the outcome of a Git operation.
      }
    }
  }
}

function splitZero(value) {
  return String(value || "").split("\0").map(slash).filter(Boolean);
}

function safeSegment(value) {
  return String(value || "run").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function snapshotPaths(projectRoot, onTiming = null) {
  const tracked = splitZero(await gitCommand(projectRoot, ["diff", "--name-only", "-z", "HEAD", "--"], { onTiming }));
  const untracked = splitZero(await gitCommand(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"], { onTiming }));
  return [...new Set([
    ...tracked,
    ...projectUntracked(untracked)
  ])];
}

export function createGitWorkspaceManager({ projectRoot, tempRoot = os.tmpdir() } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const rootKey = createHash("sha256").update(path.resolve(projectRoot).toLowerCase()).digest("hex").slice(0, 12);
  const baseDir = path.join(tempRoot, "llm-task-tree-worktrees", rootKey);
  const contextDir = path.join(baseDir, "contexts");
  const contextLockDir = path.join(baseDir, "context-locks");
  const activeContextLocks = new Map();
  let gitTimingObserver = null;
  let bootstrap = null;
  const git = (cwd, args, options = {}) => gitCommand(cwd, args, { ...options, onTiming: gitTimingObserver });
  const identity = {
    GIT_AUTHOR_NAME: 'Task Tree', GIT_AUTHOR_EMAIL: 'task-tree@local',
    GIT_COMMITTER_NAME: 'Task Tree', GIT_COMMITTER_EMAIL: 'task-tree@local'
  };

  function ensureRepository() {
    if (!bootstrap) bootstrap = (async () => {
      try { await git(projectRoot, ['rev-parse', '--git-dir']); }
      catch { await git(projectRoot, ['init', '-q']); }
      try { await git(projectRoot, ['rev-parse', '--verify', 'HEAD']); }
      catch {
        // Create only an empty anchor commit. Actual project content is captured
        // by the separate snapshot index; never stage or commit the user's index.
        const emptyTree = String(await git(projectRoot, ['hash-object', '-t', 'tree', '--stdin', '-w'])).trim();
        const commit = String(await git(projectRoot, ['commit-tree', emptyTree, '-m', 'Initialize parallel workspace'], { env: identity })).trim();
        await git(projectRoot, ['update-ref', 'HEAD', commit, '']);
      }
    })().catch(error => { bootstrap = null; throw error; });
    return bootstrap;
  }

  const runDir = (runId) => path.join(baseDir, safeSegment(runId));
  const contextPath = (contextKey) => path.join(contextDir, safeSegment(contextKey));
  const contextLockPath = (contextKey) => path.join(contextLockDir, `${safeSegment(contextKey)}.lock`);

  async function processIsAlive(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0) return false;
    try {
      process.kill(value, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function acquireContextLock(contextKey) {
    await mkdir(contextLockDir, { recursive: true });
    const lockPath = contextLockPath(contextKey);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, contextKey, at: new Date().toISOString() })}\n`, "utf8");
        return { handle, lockPath };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let stale = false;
        try {
          const info = JSON.parse(await readFile(lockPath, "utf8"));
          stale = !(await processIsAlive(info.pid));
        } catch {
          stale = true;
        }
        if (!stale) {
          const busy = new Error(`分支上下文正在被另一个任务使用：${contextKey}`);
          busy.code = "CONTEXT_BUSY";
          throw busy;
        }
        await rm(lockPath, { force: true });
      }
    }
    throw new Error(`无法锁定分支上下文：${contextKey}`);
  }

  async function releaseContextLock(workerPath) {
    const lock = activeContextLocks.get(workerPath);
    if (!lock) return;
    activeContextLocks.delete(workerPath);
    await lock.handle.close().catch(() => {});
    await rm(lock.lockPath, { force: true }).catch(() => {});
  }

  async function preparePersistentWorker(workerPath, fromCommit) {
    if (existsSync(workerPath)) {
      try {
        await git(workerPath, ["rev-parse", "--git-dir"]);
        await git(workerPath, ["reset", "--hard", fromCommit]);
        await git(workerPath, ["clean", "-fd"]);
        return;
      } catch {
        await rm(workerPath, { recursive: true, force: true });
        await git(projectRoot, ["worktree", "prune"]).catch(() => {});
      }
    }
    await mkdir(path.dirname(workerPath), { recursive: true });
    await git(projectRoot, ["worktree", "add", "--detach", workerPath, fromCommit]);
  }

  return {
    setTimingObserver(observer) {
      gitTimingObserver = typeof observer === "function" ? observer : null;
    },

    async prepare(runId) {
      await ensureRepository();
      const directory = runDir(runId);
      const integrationPath = path.join(directory, "integration");
      const indexPath = path.join(directory, "snapshot.index");
      await mkdir(directory, { recursive: true });
      const baseCommit = String(await git(projectRoot, ["rev-parse", "HEAD"])).trim();
      const paths = await snapshotPaths(projectRoot, gitTimingObserver);
      const identity = {
        GIT_AUTHOR_NAME: "Task Tree",
        GIT_AUTHOR_EMAIL: "task-tree@local",
        GIT_COMMITTER_NAME: "Task Tree",
        GIT_COMMITTER_EMAIL: "task-tree@local"
      };
      const snapshotEnv = { ...identity, GIT_INDEX_FILE: indexPath };
      try {
        await git(projectRoot, ["read-tree", "HEAD"], { env: snapshotEnv });
        if (paths.length) await git(projectRoot, ["add", "-A", "--", ...paths], { env: snapshotEnv });
        const tree = String(await git(projectRoot, ["write-tree"], { env: snapshotEnv })).trim();
        const snapshotCommit = paths.length
          ? String(await git(projectRoot, ["commit-tree", tree, "-p", baseCommit, "-m", `task-tree snapshot ${safeSegment(runId)}`], { env: snapshotEnv })).trim()
          : baseCommit;
        await git(projectRoot, ["worktree", "add", "--detach", integrationPath, snapshotCommit]);
        return { baseCommit, snapshotCommit, integrationPath, runDir: directory, snapshotPaths: paths.length };
      } finally {
        await rm(indexPath, { force: true }).catch(() => {});
        await rm(`${indexPath}.lock`, { force: true }).catch(() => {});
      }
    },

    async head(cwd) {
      return String(await git(cwd, ["rev-parse", "HEAD"])).trim();
    },

    async createWorker(runId, taskId, fromCommit, options = {}) {
      if (options.persistentContext || options.contextKey) {
        const contextKey = safeSegment(options.contextKey || `${runId}-${taskId}`);
        const workerPath = contextPath(contextKey);
        const lock = await acquireContextLock(contextKey);
        activeContextLocks.set(workerPath, { ...lock, contextKey });
        try {
          await preparePersistentWorker(workerPath, fromCommit);
          return workerPath;
        } catch (error) {
          await releaseContextLock(workerPath);
          throw error;
        }
      }
      const workerPath = path.join(runDir(runId), `worker-${safeSegment(taskId)}`);
      await git(projectRoot, ["worktree", "add", "--detach", workerPath, fromCommit]);
      return workerPath;
    },

    async inspectChanges(workerPath, baseCommit, writeSet) {
      const tracked = splitZero(await git(workerPath, ["diff", "--name-only", "-z", baseCommit, "--"]));
      const untracked = splitZero(await git(workerPath, ["ls-files", "--others", "--exclude-standard", "-z"]));
      const changedFiles = [...new Set([...tracked, ...projectUntracked(untracked)])].sort();
      return { changedFiles, violations: [] };
    },

    async commit(cwd, message, baseCommit = "") {
      const base = baseCommit || await this.head(cwd);
      const { changedFiles } = await this.inspectChanges(cwd, base);
      if (changedFiles.length) await git(cwd, ['add', '-A', '--', ...changedFiles]);
      const tree = String(await git(cwd, ["write-tree"])).trim();
      if (tree === String(await git(cwd, ["rev-parse", `${base}^{tree}`])).trim()) return base;
      const identity = {
        GIT_AUTHOR_NAME: "Task Tree Worker",
        GIT_AUTHOR_EMAIL: "task-tree@local",
        GIT_COMMITTER_NAME: "Task Tree Worker",
        GIT_COMMITTER_EMAIL: "task-tree@local"
      };
      // Include all worker changes, including commits it made itself, as one delta.
      return String(await git(cwd, ["commit-tree", tree, "-p", base, "-m", message], { env: identity })).trim();
    },

    async integrate(integrationPath, commit, sourceCommit = "") {
      if (!commit || commit === sourceCommit) return { conflicts: [] };
      try {
        await git(integrationPath, ["cherry-pick", commit], { env: identity });
        return { conflicts: [] };
      } catch (error) {
        const conflicts = splitZero(await git(integrationPath, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => ""));
        if (conflicts.length) {
          error.code = "CHERRY_PICK_CONFLICT";
          error.files = conflicts;
          throw error;
        }
        if (existsSync(path.join(String(await git(integrationPath, ["rev-parse", "--absolute-git-dir"])).trim(), "CHERRY_PICK_HEAD"))
          && !String(await git(integrationPath, ["status", "--porcelain"])).trim()) {
          await git(integrationPath, ["cherry-pick", "--skip"]);
          return { conflicts: [] };
        }
        await git(integrationPath, ["cherry-pick", "--abort"]).catch(() => {});
        throw error;
      }
    },

    async continueIntegration(integrationPath) {
      const conflicts = splitZero(await git(integrationPath, ["diff", "--name-only", "--diff-filter=U", "-z"]));
      if (conflicts.length) throw new Error(`仍有未解决的合并冲突：${conflicts.join(", ")}`);
      await git(integrationPath, ["add", "-A"]);
      if (!String(await git(integrationPath, ["diff", "--cached", "--name-only"])).trim()) {
        await git(integrationPath, ["cherry-pick", "--skip"]);
        return;
      }
      const identity = {
        GIT_AUTHOR_NAME: "Task Tree Conflict Resolver",
        GIT_AUTHOR_EMAIL: "task-tree@local",
        GIT_COMMITTER_NAME: "Task Tree Conflict Resolver",
        GIT_COMMITTER_EMAIL: "task-tree@local"
      };
      await git(integrationPath, ["cherry-pick", "--continue"], { env: identity });
    },

    async abortIntegration(integrationPath) {
      await git(integrationPath, ["cherry-pick", "--abort"]).catch(() => {});
    },

    async removeWorker(workerPath, options = {}) {
      if (!workerPath) return;
      if (activeContextLocks.has(workerPath) || options.preserveContext) {
        await releaseContextLock(workerPath);
        return;
      }
      await git(projectRoot, ["worktree", "remove", "--force", workerPath]).catch(async () => {
        await rm(workerPath, { recursive: true, force: true });
        await git(projectRoot, ["worktree", "prune"]).catch(() => {});
      });
    },

    async summarize(integrationPath, snapshotCommit) {
      const changedFiles = splitZero(await git(integrationPath, ["diff", "--name-only", "-z", snapshotCommit, "HEAD", "--"]));
      const stat = String(await git(integrationPath, ["diff", "--stat", snapshotCommit, "HEAD", "--"])).trim();
      const patch = String(await git(integrationPath, ["diff", "--no-ext-diff", "--unified=2", snapshotCommit, "HEAD", "--"]));
      return { changedFiles, stat, patchPreview: patch, patchTruncated: false };
    },

    async accept({ integrationPath, snapshotCommit, changedFiles = [], resolveConflict } = {}) {
      if (!changedFiles.length) return { appliedFiles: [] };
      const applyId = `apply-${randomUUID()}`;
      const current = await this.prepare(applyId);
      try {
        const tree = String(await git(integrationPath, ["rev-parse", "HEAD^{tree}"])).trim();
        const commit = String(await git(integrationPath, ["commit-tree", tree, "-p", snapshotCommit, "-m", "parallel result"], {
          env: { GIT_AUTHOR_NAME: "Task Tree", GIT_AUTHOR_EMAIL: "task-tree@local", GIT_COMMITTER_NAME: "Task Tree", GIT_COMMITTER_EMAIL: "task-tree@local" }
        })).trim();
        try {
          await this.integrate(current.integrationPath, commit, snapshotCommit);
        } catch (error) {
          if (error.code !== "CHERRY_PICK_CONFLICT" || !resolveConflict) throw error;
          await resolveConflict(current.integrationPath, error.files);
        }
        const patchFile = path.join(current.runDir, "apply.patch");
        const patch = await git(current.integrationPath, ["diff", "--binary", current.snapshotCommit, "HEAD", "--"], { encoding: "buffer" });
        if (!patch.length) return { appliedFiles: [] };
        await writeFile(patchFile, patch);
        // Git checks the live files before writing. The main index is untouched;
        // even a new edit arriving during conflict resolution cannot be overwritten.
        await git(projectRoot, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
        return { appliedFiles: [...changedFiles] };
      } finally {
        await this.cleanup({ ...current, runId: applyId });
      }
    },

    async cleanup({ integrationPath, runId } = {}) {
      if (integrationPath) await this.removeWorker(integrationPath);
      await rm(runDir(runId), { recursive: true, force: true });
      await git(projectRoot, ["worktree", "prune"]).catch(() => {});
    }
  };
}
