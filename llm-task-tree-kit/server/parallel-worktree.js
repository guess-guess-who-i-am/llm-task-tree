import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const PROTECTED_FILES = new Set([
  "task-tree.md",
  "task-trees.json",
  "scripts/project.json",
  "scripts/run.json"
]);
const PROTECTED_DIRECTORIES = ["versions/", ".task-tree-runs/", ".task-tree-scopes/"];

function isProtectedPath(file) {
  const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
  return PROTECTED_FILES.has(normalized)
    || PROTECTED_DIRECTORIES.some((directory) => normalized === directory.slice(0, -1) || normalized.startsWith(directory));
}

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_TEST_OUTPUT = 16000;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const RUNTIME_PATHS = [".task-tree-runs/", ".task-tree-scopes/", ".task-tree-thread", ".task-tree-threads.json"];

const slash = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");

async function git(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT,
      encoding: options.encoding || "utf8",
      env: { ...process.env, ...(options.env || {}) }
    });
    return result.stdout;
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "git command failed").trim();
    const wrapped = new Error(`git ${args[0]} 失败：${detail.slice(-1200)}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function splitZero(value) {
  return String(value || "").split("\0").map(slash).filter(Boolean);
}

function safeSegment(value) {
  return String(value || "run").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function scopeRegex(scope) {
  const normalized = slash(scope);
  if (normalized.endsWith("/")) return new RegExp(`^${normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&")}`);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

export function pathInWriteSet(file, writeSet) {
  const normalized = slash(file);
  return (writeSet || []).some((scope) => scopeRegex(scope).test(normalized));
}

export function validateTestCommand(command) {
  const value = String(command || "").trim();
  if (!value) throw new Error("测试命令不能为空");
  if (/[\r\n]/.test(value)) throw new Error(`测试命令不能换行：${value}`);
  if (/(^|\s)(rm|rmdir|del|erase|format|shutdown|reboot|git\s+(reset|clean|checkout))\b/i.test(value)) {
    throw new Error(`测试命令包含破坏性操作：${value}`);
  }
  if (!/^(node|npm(?:\.cmd)?|pnpm|yarn|bun|python(?:\.exe)?(?:\s+-m)?|pytest|pwsh|powershell)(\s|$)/i.test(value)) {
    throw new Error(`不允许自动运行此测试命令：${value}`);
  }
  return value;
}

function runCommand(cwd, command) {
  const [shell, args] = process.platform === "win32"
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-lc", command]];
  return new Promise((resolve) => {
    const child = spawn(shell, args, { cwd, windowsHide: true, env: process.env });
    let output = "";
    const append = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-MAX_TEST_OUTPUT); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill(), TEST_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, ok: false, exitCode: null, output: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, ok: code === 0, exitCode: code, signal: signal || "", output: output.trim() });
    });
  });
}

async function snapshotPaths(projectRoot) {
  const tracked = splitZero(await git(projectRoot, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = splitZero(await git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([
    ...tracked,
    ...untracked.filter((relative) => !RUNTIME_PATHS.some((reserved) => relative === reserved || relative.startsWith(reserved)))
  ])];
}

async function blobAtCommit(cwd, commit, relative) {
  try {
    return String(await git(cwd, ["rev-parse", `${commit}:${slash(relative)}`])).trim();
  } catch {
    return "";
  }
}

async function workingBlob(cwd, relative) {
  const file = path.join(cwd, relative);
  if (!existsSync(file)) return "";
  try {
    return String(await git(cwd, ["hash-object", "--", relative])).trim();
  } catch {
    return "";
  }
}

export function createGitWorkspaceManager({ projectRoot, tempRoot = os.tmpdir() } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const rootKey = createHash("sha256").update(path.resolve(projectRoot).toLowerCase()).digest("hex").slice(0, 12);
  const baseDir = path.join(tempRoot, "llm-task-tree-worktrees", rootKey);
  const contextDir = path.join(baseDir, "contexts");
  const contextLockDir = path.join(baseDir, "context-locks");
  const activeContextLocks = new Map();

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
    async prepare(runId) {
      const directory = runDir(runId);
      const integrationPath = path.join(directory, "integration");
      const indexPath = path.join(directory, "snapshot.index");
      await mkdir(directory, { recursive: true });
      const baseCommit = String(await git(projectRoot, ["rev-parse", "HEAD"])).trim();
      const paths = await snapshotPaths(projectRoot);
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
      const changedFiles = [...new Set([...tracked, ...untracked])].sort();
      const violations = changedFiles.filter((file) => isProtectedPath(file) || !pathInWriteSet(file, writeSet));
      return { changedFiles, violations };
    },

    async runTests(cwd, commands = []) {
      const results = [];
      for (const raw of commands) {
        let command;
        try {
          command = validateTestCommand(raw);
        } catch (error) {
          results.push({ command: String(raw || ""), ok: false, exitCode: null, output: error.message });
          continue;
        }
        results.push(await runCommand(cwd, command));
      }
      return results;
    },

    async commit(cwd, message, baseCommit = "") {
      await git(cwd, ["add", "-A"]);
      if (!String(await git(cwd, ["status", "--porcelain"])).trim()) return baseCommit || this.head(cwd);
      const identity = {
        GIT_AUTHOR_NAME: "Task Tree Worker",
        GIT_AUTHOR_EMAIL: "task-tree@local",
        GIT_COMMITTER_NAME: "Task Tree Worker",
        GIT_COMMITTER_EMAIL: "task-tree@local"
      };
      await git(cwd, ["commit", "-m", message], { env: identity });
      return this.head(cwd);
    },

    async integrate(integrationPath, commit, sourceCommit = "") {
      if (!commit || commit === sourceCommit) return;
      try {
        await git(integrationPath, ["cherry-pick", commit]);
      } catch (error) {
        await git(integrationPath, ["cherry-pick", "--abort"]).catch(() => {});
        throw error;
      }
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
      return { changedFiles, stat, patchPreview: patch.slice(0, 32000), patchTruncated: patch.length > 32000 };
    },

    async accept({ integrationPath, snapshotCommit, changedFiles = [] } = {}) {
      const conflicts = (await Promise.all(changedFiles.map(async (file) => {
        const [before, current] = await Promise.all([
          blobAtCommit(integrationPath, snapshotCommit, file),
          workingBlob(projectRoot, file)
        ]);
        return before === current ? "" : file;
      }))).filter(Boolean);
      if (conflicts.length) {
        const error = new Error(`并行运行期间主工作区又修改了这些文件，不能静默覆盖：${conflicts.join(", ")}`);
        error.code = "MAIN_WORKSPACE_CHANGED";
        error.files = conflicts;
        throw error;
      }
      if (!changedFiles.length) return { appliedFiles: [] };
      const patchFile = path.join(path.dirname(integrationPath), "accepted.patch");
      const patch = await git(integrationPath, ["diff", "--binary", snapshotCommit, "HEAD", "--"], { encoding: "buffer" });
      await writeFile(patchFile, patch);
      await git(projectRoot, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
      return { appliedFiles: [...changedFiles] };
    },

    async cleanup({ integrationPath, runId } = {}) {
      if (integrationPath) await this.removeWorker(integrationPath);
      await rm(runDir(runId), { recursive: true, force: true });
      await git(projectRoot, ["worktree", "prune"]).catch(() => {});
    }
  };
}
