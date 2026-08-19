import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const projectRoot = process.cwd();
const fixtureRoot = path.join(projectRoot, "e2e-simulation", "parallel-state-sync-fixture");
const validator = path.join(fixtureRoot, "validate-fixture.mjs");

async function runNode(script, args = [], cwd = projectRoot) {
  const absoluteScript = path.resolve(script);
  const executableScript = process.platform === "win32" ? `\\\\?\\${absoluteScript}` : absoluteScript;
  return exec(process.execPath, [executableScript, ...args], { cwd, windowsHide: true });
}

async function expectInvalid(mutator, expectedMessage) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "parallel-state-sync-invalid-"));
  try {
    await cp(fixtureRoot, temporaryRoot, { recursive: true });
    await mutator(temporaryRoot);
    await assert.rejects(
      () => runNode(validator, [temporaryRoot]),
      (error) => {
        const output = `${error.stdout || ""}\n${error.stderr || ""}`;
        assert.match(output, expectedMessage);
        return true;
      }
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const validated = await runNode(validator);
assert.match(validated.stdout, /^PASS fixture structure /);

const integration = await runNode(path.join(fixtureRoot, "tests", "order-routing.integration.mjs"), [], fixtureRoot);
const liveEvidence = JSON.parse(integration.stdout.trim());
const recordedEvidence = JSON.parse(await readFile(path.join(fixtureRoot, "evidence", "integration-test.json"), "utf8"));
assert.deepEqual(liveEvidence, {
  status: recordedEvidence.status,
  assertions: recordedEvidence.assertions,
  routedOrderIds: recordedEvidence.routedOrderIds,
  networkUsed: recordedEvidence.networkUsed,
  browserUsed: recordedEvidence.browserUsed,
  humanInputUsed: recordedEvidence.humanInputUsed
});

await expectInvalid(async (root) => {
  const manifestFile = path.join(root, "fixture.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.capabilityAssessment.realBusinessUsage.gap;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}, /realBusinessUsage\.gap/);

await expectInvalid(async (root) => {
  const treeFile = path.join(root, "task-tree.md");
  const tree = await readFile(treeFile, "utf8");
  await writeFile(treeFile, tree.replace("## N3 -", "## STAGE -"), "utf8");
}, /stageNode node N3 must be locatable/);

await expectInvalid(async (root) => {
  const runFile = path.join(root, "accepted-parallel-run.json");
  const run = JSON.parse(await readFile(runFile, "utf8"));
  run.goalAssessment.goalAchieved = true;
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}, /overall goal is achieved/);

await expectInvalid(async (root) => {
  const treeFile = path.join(root, "task-tree.md");
  const tree = await readFile(treeFile, "utf8");
  await writeFile(treeFile, tree.replace("- Completion: 进行中", "- Completion: 已完成"), "utf8");
}, /ROOT cannot be complete/);

console.log("PASS business fixture is offline and repeatable, preserves the accepted parallel result, and rejects false completion");
