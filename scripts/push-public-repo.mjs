#!/usr/bin/env node
/**
 * Pushes the public distribution repo through the GitHub API instead of git-over-https.
 *
 * `github.com:443` is unreachable from this machine while `api.github.com` is fine, so a normal
 * `git push` fails. This walks the Git Data API — blobs, tree, commit, ref — which produces exactly
 * one commit on the remote rather than a pile of per-file Contents API writes.
 *
 * Authentication comes from the `gh` CLI.
 *
 * usage: node scripts/push-public-repo.mjs [--source <git-dir>] [--repo owner/name] [--branch main] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const flag = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const repoDir = path.resolve(flag("--source", path.join(projectRoot, "dist", "task-tree-public")));
const repo = flag("--repo", "guess-guess-who-i-am/llm-task-tree");
const branch = flag("--branch", "main");
const dryRun = process.argv.includes("--dry-run");

function git(args) {
  const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function gitBytes(args) {
  const result = spawnSync("git", args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString("utf8") || ""}`);
  return result.stdout;
}

function gh(args, body) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 4).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const api = (route, body) =>
  gh(body ? ["api", "--method", "POST", route, "--input", "-"] : ["api", route], body);

/**
 * Local tree: path -> blob sha, straight out of the commit that is being published.
 *
 * `-z` matters: without it git octal-escapes and quotes non-ASCII paths, and the repo ships files
 * with Chinese names, which would then look like renames and get deleted and re-added mangled.
 */
function localTree() {
  const entries = new Map();
  for (const record of git(["ls-tree", "-r", "-z", "HEAD"]).split("\0")) {
    const match = record.match(/^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/);
    if (match) entries.set(match[3], { mode: match[1], sha: match[2] });
  }
  return entries;
}

function remoteTree(treeSha) {
  const tree = gh(["api", `repos/${repo}/git/trees/${treeSha}?recursive=1`]);
  if (tree.truncated) throw new Error("remote tree was truncated; this pusher assumes a small repo");
  const entries = new Map();
  for (const item of tree.tree) {
    if (item.type === "blob") entries.set(item.path, { mode: item.mode, sha: item.sha });
  }
  return entries;
}

function main() {
  const head = gh(["api", `repos/${repo}/git/ref/heads/${branch}`]).object.sha;
  const baseTree = gh(["api", `repos/${repo}/git/commits/${head}`]).tree.sha;

  const local = localTree();
  const remote = remoteTree(baseTree);

  // Git blob SHAs are content hashes on both sides, so comparing them is enough to find the diff.
  const changed = [...local].filter(([file, entry]) => remote.get(file)?.sha !== entry.sha);
  const removed = [...remote.keys()].filter((file) => !local.has(file));

  if (!changed.length && !removed.length) {
    console.log(JSON.stringify({ ok: true, repo, branch, message: "remote already matches HEAD" }, null, 2));
    return;
  }

  const message = git(["log", "-1", "--pretty=%B"]).trim();
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, repo, branch, changed: changed.map(([f]) => f), removed, message }, null, 2));
    return;
  }

  const tree = [];
  for (const [file, entry] of changed) {
    // Upload the exact object compared above. Reading the Windows worktree here would upload CRLF
    // bytes while localTree() compares the normalized LF blob, causing permanent false drift.
    const blob = api(`repos/${repo}/git/blobs`, {
      content: gitBytes(["cat-file", "blob", entry.sha]).toString("base64"),
      encoding: "base64"
    });
    tree.push({ path: file, mode: entry.mode, type: "blob", sha: blob.sha });
  }
  for (const file of removed) tree.push({ path: file, mode: "100644", type: "blob", sha: null });

  const newTree = api(`repos/${repo}/git/trees`, { base_tree: baseTree, tree });
  const commit = api(`repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [head] });
  gh(["api", "--method", "PATCH", `repos/${repo}/git/refs/heads/${branch}`, "--input", "-"], { sha: commit.sha });

  console.log(JSON.stringify({
    ok: true,
    repo,
    branch,
    commit: commit.sha,
    uploaded: changed.length,
    removed: removed.length,
    url: `https://github.com/${repo}/commit/${commit.sha}`
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
