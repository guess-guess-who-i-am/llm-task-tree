import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createParallelCodexCoordinator } from "./codex-coordinator.js";
import { createGitWorkspaceManager } from "./parallel-worktree.js";

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const within = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("progress timed out")), 10000); timer.unref(); })
]);

test('parallel final review supports deleting a migrated subtree without losing the delivered tree', {timeout:30000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallel-tree-migration-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const markdown = '# LLM Task Graph\n## ROOT - 人物\n- Problem: 独立成树\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
  await mkdir(path.join(root, 'subtrees'));
  await writeFile(path.join(root, 'task-tree.md'), markdown);
  await writeFile(path.join(root, 'subtrees/people-tree.md'), markdown);
  let checks = 0;
  const coordinator = createParallelCodexCoordinator({projectRoot:root,startTurn:async options => {
    assert.equal(options.environment.TASK_TREE_QUALITY_MODE,'advisory','parallel Worker uses the IDE quality policy');
    await mkdir(path.join(options.cwd, 'trees'), {recursive:true});
    await writeFile(path.join(options.cwd, 'trees/people.md'), '# LLM Task Graph\n## PERSON - 人物树\n- CurrentResult: 已交付\n');
    await writeFile(path.join(options.cwd, 'task-trees.json'), JSON.stringify({trees:[{id:'people',path:'trees/people.md'}]}));
    await rm(path.join(options.cwd, 'subtrees/people-tree.md'));
    return {status:'completed',output:'已迁移人物树'};
  },reviewTurn:async options => {
    assert.equal(options.environment.TASK_TREE_QUALITY_MODE,'advisory','parallel final checker inherits the same quality policy');
    checks++;return {status:'completed',output:'{"verdict":"pass","reason":"已核对人物树迁移"}'};
  }});
  const run = await coordinator.start([{taskId:'migrate',nodeId:'ROOT',instruction:'迁移人物树'}], {nodeId:'ROOT',incremental:true,objective:'迁移人物树'});
  const finished = await coordinator.wait(run.id);
  assert.equal(finished.status, 'accepted', finished.error);
  assert.equal(checks, 1);
  assert.match(await readFile(path.join(root, 'trees/people.md'), 'utf8'), /已交付/);
  await coordinator.drain();
});

test('adaptive plan applies an early worker and releases its dependent while a sibling is still running', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'incremental-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'task-tree.md'), '# LLM Task Graph\n## ROOT - 流水执行\n- Problem: 逐项交付并释放依赖\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n');
  const slow = deferred(), dependent = deferred();
  let reviews=0;
  t.after(() => slow.resolve());
  const coordinator = createParallelCodexCoordinator({ projectRoot: root, startTurn: async options => {
    const id = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    if (id === 'slow') await slow.promise;
    if (id === 'dependent') {
      assert.equal(await readFile(path.join(root, 'early.txt'), 'utf8'), 'early');
      assert.equal(await readFile(path.join(options.cwd, 'early.txt'), 'utf8'), 'early');
      await assert.rejects(readFile(path.join(root, 'slow.txt')), { code: 'ENOENT' });
      dependent.resolve();
    }
    await writeFile(path.join(options.cwd, `${id}.txt`), id);
    return { status: 'completed', output: `${id} 实际已完成`, threadId: `deepseek-${id}` };
  }, reviewTurn: async options => {
    reviews++;
    assert.match(options.prompt, /用户目标：三项交付/);
    // Acceptance checks the actual integrated workspace, not a redundant list
    // of filenames in a prompt whose evidence is available through tools.
    for (const id of ['early', 'slow', 'dependent']) {
      assert.equal(await readFile(path.join(options.cwd, `${id}.txt`), 'utf8'), id);
    }
    return { status: 'completed', output: '{"verdict":"pass","reason":"交付完整"}' };
  } });
  const run = await coordinator.start(['early', 'slow', 'dependent'].map(taskId => ({ taskId, nodeId: 'ROOT', instruction: `交付${taskId}`,
    dependsOn: taskId === 'dependent' ? ['early'] : [] })), { nodeId: 'ROOT', incremental: true, objective: '三项交付' });
  try {
    await within(dependent.promise);
    assert.equal((await coordinator.get(run.id)).jobs.find(j => j.taskId === 'early').status, 'completed');
    slow.resolve();
    const finished = await coordinator.wait(run.id);
    assert.equal(finished.status, 'accepted', finished.error);
    assert.equal(reviews,1,'only the final whole-node checker runs');
    for (const id of ['early', 'slow', 'dependent']) assert.equal(await readFile(path.join(root, `${id}.txt`), 'utf8'), id);
  } finally { slow.resolve(); await coordinator.drain(); }
});

test("real coordinator resolves shared-file and task-tree conflicts, appends immediately and auto-applies", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-integrated-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const tree = "# LLM Task Graph\n## ROOT - 自动并行\n- Problem: 保留所有分支结果\n## N1 - 分支\n- Problem: 修改共享文件\n# GraphState\n- Current: N1\n- Next: N1\n# Edges\n";
  await writeFile(path.join(projectRoot, "task-tree.md"), tree);
  await writeFile(path.join(projectRoot, "shared.txt"), "base\n");
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.name", "Parallel Test"]);
  await git(projectRoot, ["config", "user.email", "parallel@test.local"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "base"]);

  const started = { A: deferred(), B: deferred(), C: deferred() };
  const release = deferred();
  const calls = [];
  const workerResults = [];
  const manager = createGitWorkspaceManager({ projectRoot, tempRoot: path.join(root, "worktrees") });
  const startTurn = async (options) => {
    calls.push(options);
    if (options.prompt.includes("Single Parallel Branch Planner")) {
      return { threadId: "planner", output: JSON.stringify({ job: {
        nodeId: "N1", title: "追加任务", instruction: "创建 appended.txt", writeSet: ["shared.txt", "task-tree.md"], dependsOn: []
      } }) };
    }
    if (options.prompt.includes("Merge conflict resolution")) {
      assert.match(options.prompt, /Participant packet/);
      assert.match(options.prompt, /"taskId":"A"/);
      assert.match(options.prompt, /"taskId":"B"/);
      assert.ok(options.forkThreadId, "resolver uses the source worker's context");
      await writeFile(path.join(options.cwd, "shared.txt"), "A\nB\n");
      await writeFile(path.join(options.cwd, "task-tree.md"), `${tree}\nA result\nB result\n`);
      await git(options.cwd, ["add", "shared.txt", "task-tree.md"]);
      return { threadId: "resolver", output: '{"event":"completed","evidence":"both intents retained"}' };
    }
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    assert.ok(taskId, "unexpected model invocation");
    assert.equal(options.sandbox, "danger-full-access");
    await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
    if (taskId === "A" || taskId === "B") {
      started[taskId].resolve();
      await release.promise;
      await writeFile(path.join(options.cwd, "shared.txt"), `${taskId}\n`);
      // Real model workers may commit more than once. Preserve every such commit.
      await git(options.cwd, ["add", "shared.txt"]);
      await git(options.cwd, ["commit", "-m", `${taskId} first commit`]);
      await writeFile(path.join(options.cwd, "task-tree.md"), `${tree}\n${taskId} result\n`);
      await git(options.cwd, ["add", "task-tree.md"]);
      await git(options.cwd, ["commit", "-m", `${taskId} second commit`]);
    } else {
      assert.equal(options.threadId, "", "an active conversation must not receive another simultaneous turn");
      assert.ok(options.forkThreadId, "overlapping branch inherits history through a fork");
      started.C.resolve();
      await writeFile(path.join(options.cwd, "appended.txt"), "appended before A/B completed\n");
    }
    workerResults.push(taskId);
    return { threadId: `thread-${taskId}`, output: JSON.stringify({ event: "completed", evidence: taskId, peerRequests: [] }) };
  };
  const coordinator = createParallelCodexCoordinator({ projectRoot, workspace: manager, startTurn });
  try {
    const run = await coordinator.start(["A", "B"].map((taskId) => ({
      taskId, nodeId: "N1", instruction: `实现 ${taskId}`, writeSet: ["shared.txt", "task-tree.md"], dependsOn: []
    })));
    await within(Promise.all([started.A.promise, started.B.promise]));
    const appended = await coordinator.addBranch(run.id, { nodeId: "N1" });
    assert.equal(appended.jobs.length, 3);
    await within(started.C.promise);
    assert.ok(!workerResults.includes("A") && !workerResults.includes("B"), "new work starts while earlier workers are still waiting");
    release.resolve();
    const finished = await coordinator.wait(run.id);
    await coordinator.drain();
    assert.equal(finished.status, "accepted", finished.error);
    assert.equal(finished.jobs.filter((job) => job.status === "completed").length, 3);
    assert.equal(await readFile(path.join(projectRoot, "shared.txt"), "utf8"), "A\nB\n");
    assert.equal(await readFile(path.join(projectRoot, "task-tree.md"), "utf8"), `${tree}\nA result\nB result\n`);
    assert.match(await readFile(path.join(projectRoot, "appended.txt"), "utf8"), /before A\/B completed/);
    assert.ok(finished.mergeConflicts.some((conflict) => conflict.status === "resolved"
      && conflict.consultationMode === "single-resolver"
      && conflict.consultationCount === 0
      && conflict.messages.length === 1));
    assert.ok(!calls.some((call) => call.prompt.includes("Merge conflict consultation")));
    assert.equal((await git(projectRoot, ["ls-files", "--unmerged"])).stdout, "");
  } finally {
    release.resolve();
    await coordinator.drain();
    await rm(root, { recursive: true, force: true });
  }
});

test("eight workers share one conflict resolver packet without peer-round fanout", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parallel-eight-conflict-"));
  await writeFile(path.join(root, "task-tree.md"), "# LLM Task Graph\n## ROOT - 八分支\n- Problem: 并行完成八项独立工作\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n");
  const total = 8;
  let startedCount = 0;
  let committedCount = 0;
  let maximumActive = 0;
  let active = 0;
  let resolverCalls = 0;
  let resolveStarted;
  const allStarted = new Promise((resolve) => { resolveStarted = resolve; });
  let resolveCommitted;
  const allCommitted = new Promise((resolve) => { resolveCommitted = resolve; });
  const workspace = {
    async prepare() { return { integrationPath: root, snapshotCommit: "snapshot" }; },
    async head() { return "head"; },
    async createWorker(_runId, taskId) { return path.join(root, `worker-${taskId}`); },
    async inspectChanges() { return { changedFiles: ["shared.txt"], violations: [] }; },
    async commit(_workerPath, message) {
      committedCount += 1;
      if (committedCount === total) resolveCommitted();
      return `commit-${committedCount}-${message}`;
    },
    async integrate() {
      await allCommitted;
      if (!this.conflicted) {
        this.conflicted = true;
        const error = new Error("shared conflict");
        error.code = "CHERRY_PICK_CONFLICT";
        error.files = ["shared.txt"];
        throw error;
      }
      return { conflicts: [] };
    },
    async continueIntegration() {},
    async abortIntegration() {},
    async removeWorker() {},
    async summarize() { return { changedFiles: ["shared.txt"], stat: "1 file", patchPreview: "merged", patchTruncated: false }; },
    async accept() { return { appliedFiles: ["shared.txt"] }; },
    async cleanup() {}
  };
  const startTurn = async (options) => {
    if (options.prompt.includes("Merge conflict resolution")) {
      resolverCalls += 1;
      for (let index = 1; index <= total; index += 1) assert.match(options.prompt, new RegExp(`\\"taskId\\":\\"worker-${index}\\"`));
      assert.match(options.prompt, /Do not start separate peer consultations/);
      return { threadId: "resolver", output: '{"event":"completed","evidence":"all eight intents supplied"}' };
    }
    const taskId = options.prompt.match(/^Task id: (.+)$/m)?.[1];
    assert.ok(taskId);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await options.onAccepted?.({ threadId: `thread-${taskId}`, turnId: `turn-${taskId}` });
    startedCount += 1;
    if (startedCount === total) resolveStarted();
    await allStarted;
    active -= 1;
    return { threadId: `thread-${taskId}`, turnId: `turn-${taskId}`, output: JSON.stringify({ event: "completed", evidence: taskId, peerRequests: [] }) };
  };

  try {
    const coordinator = createParallelCodexCoordinator({ projectRoot: root, workspace, startTurn });
    const run = await coordinator.start(Array.from({ length: total }, (_, index) => ({
      taskId: `worker-${index + 1}`,
      nodeId: "ROOT",
      title: `分支${index + 1}`,
      instruction: `修改 shared.txt 的第 ${index + 1} 项`,
      branchContext: `branch-${index + 1}`,
      writeSet: ["shared.txt"],
      dependsOn: []
    })));
    const finished = await coordinator.wait(run.id);
    await coordinator.drain();
    assert.equal(finished.status, "accepted", finished.error);
    assert.equal(maximumActive, total);
    assert.equal(resolverCalls, 1);
    assert.equal(finished.mergeConflicts.length, 1);
    assert.equal(finished.mergeConflicts[0].participantTaskIds.length, total);
    assert.equal(finished.mergeConflicts[0].consultationMode, "single-resolver");
    assert.equal(finished.mergeConflicts[0].consultationCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
