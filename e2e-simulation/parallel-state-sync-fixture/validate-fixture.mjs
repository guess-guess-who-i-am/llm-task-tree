import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownDirectory = path.dirname(fileURLToPath(import.meta.url));

function comparablePath(file) {
  return path.resolve(file).replace(/^\\\\\?\\/, "").toLowerCase();
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim(), `${label} must not be empty`);
}

function assertExactKeys(object, requiredKeys, label) {
  assert.ok(object && typeof object === "object" && !Array.isArray(object), `${label} must be an object`);
  for (const key of requiredKeys) assert.ok(Object.hasOwn(object, key), `${label}.${key} is required`);
}

function assertLocalRelativePath(relativePath, label) {
  assertNonEmptyString(relativePath, label);
  assert.equal(path.isAbsolute(relativePath), false, `${label} must be relative`);
  const normalized = relativePath.replaceAll("\\", "/");
  assert.equal(normalized.startsWith("../"), false, `${label} must stay inside the fixture`);
  assert.equal(normalized.includes("/../"), false, `${label} must stay inside the fixture`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function assertFile(root, relativePath, label) {
  assertLocalRelativePath(relativePath, label);
  assert.equal((await stat(path.join(root, relativePath))).isFile(), true, `${label} must reference a file`);
}

function parseNodes(markdown) {
  const nodes = new Map();
  const matches = [...markdown.matchAll(/^## ([A-Za-z][A-Za-z0-9-]*) - (.+)$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.indexOf("\n# GraphState", bodyStart);
    const body = markdown.slice(bodyStart, bodyEnd < 0 ? markdown.length : bodyEnd);
    const fields = Object.fromEntries(
      [...body.matchAll(/^- ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/gm)].map((field) => [field[1], field[2].trim()])
    );
    nodes.set(match[1], { id: match[1], title: match[2].trim(), fields });
  }
  return nodes;
}

function validateNode(node, expectedId, label) {
  assert.ok(node, `${label} node ${expectedId} must be locatable`);
  assertNonEmptyString(node.title, `${label}.title`);
  for (const field of ["Completion", "Problem", "Approach", "Metrics", "CurrentResult", "NextIdea"]) {
    assertNonEmptyString(node.fields[field], `${label}.${field}`);
  }
}

export async function validateFixture(fixtureRoot = ownDirectory) {
  const root = path.resolve(fixtureRoot);
  const manifest = await readJson(path.join(root, "fixture.json"));
  assertExactKeys(manifest, [
    "schemaVersion", "fixtureId", "purpose", "treeFile", "rootNodeId", "stageNodeId",
    "acceptedRunFile", "integrationEvidenceFile", "executionConstraints", "capabilityAssessment"
  ], "fixture");
  assert.equal(manifest.schemaVersion, 1, "fixture.schemaVersion must be 1");
  assertNonEmptyString(manifest.fixtureId, "fixture.fixtureId");
  assertNonEmptyString(manifest.purpose, "fixture.purpose");

  assert.deepEqual(manifest.executionConstraints, { network: false, browser: false, humanInput: false });
  assertExactKeys(manifest.capabilityAssessment, ["localAutomaticParallel", "realBusinessUsage"], "fixture.capabilityAssessment");
  assert.equal(manifest.capabilityAssessment.localAutomaticParallel.status, "verified");
  assert.equal(manifest.capabilityAssessment.localAutomaticParallel.claim, "局部自动并行能力已验证");
  const businessUse = manifest.capabilityAssessment.realBusinessUsage;
  assert.equal(businessUse.status, "evidence_missing", "real business usage must retain its evidence gap");
  assert.equal(businessUse.goalAchieved, false, "the residual business goal must not be marked complete");
  assertNonEmptyString(businessUse.gap, "fixture.capabilityAssessment.realBusinessUsage.gap");

  await assertFile(root, manifest.treeFile, "fixture.treeFile");
  const nodes = parseNodes(await readFile(path.join(root, manifest.treeFile), "utf8"));
  assert.equal(manifest.rootNodeId, "ROOT", "the goal node must be ROOT");
  assert.equal(manifest.stageNodeId, "N3", "the stage node must be N3");
  const rootNode = nodes.get(manifest.rootNodeId);
  const stageNode = nodes.get(manifest.stageNodeId);
  validateNode(rootNode, manifest.rootNodeId, "rootNode");
  validateNode(stageNode, manifest.stageNodeId, "stageNode");
  assert.notEqual(rootNode.fields.Completion, "已完成", "ROOT cannot be complete while real-business evidence is missing");
  assert.notEqual(stageNode.fields.Completion, "已完成", "N3 cannot be complete while real-business evidence is missing");
  assert.match(rootNode.fields.CurrentResult, /尚缺.+不能宣称完成/, "ROOT must state the residual gap and completion limit");
  assert.match(stageNode.fields.CurrentResult, /局部自动并行能力已验证.+真实业务使用仍缺证据.+不能宣称完成/, "N3 must distinguish verified local capability from the residual gap");

  await assertFile(root, manifest.acceptedRunFile, "fixture.acceptedRunFile");
  const run = await readJson(path.join(root, manifest.acceptedRunFile));
  assertExactKeys(run, ["schemaVersion", "id", "status", "objective", "summary", "affectedNodes", "jobs", "review", "goalAssessment"], "run");
  assert.equal(run.schemaVersion, 1);
  assertNonEmptyString(run.id, "run.id");
  assert.equal(run.status, "accepted");
  assertNonEmptyString(run.objective, "run.objective");
  assertNonEmptyString(run.summary, "run.summary");
  assert.deepEqual(run.affectedNodes, [manifest.stageNodeId]);
  assert.ok(Array.isArray(run.jobs) && run.jobs.length >= 2, "run.jobs must contain at least two parallel jobs");

  const taskIds = new Set();
  const jobChangedFiles = [];
  for (const [index, job] of run.jobs.entries()) {
    const label = `run.jobs[${index}]`;
    assertExactKeys(job, ["taskId", "nodeId", "status", "isolated", "writeSet", "changedFiles"], label);
    assertNonEmptyString(job.taskId, `${label}.taskId`);
    assert.equal(taskIds.has(job.taskId), false, `${label}.taskId must be unique`);
    taskIds.add(job.taskId);
    assert.equal(job.nodeId, manifest.stageNodeId);
    assert.equal(job.status, "completed");
    assert.equal(job.isolated, true);
    assert.ok(Array.isArray(job.writeSet) && job.writeSet.length > 0, `${label}.writeSet must not be empty`);
    assert.ok(Array.isArray(job.changedFiles) && job.changedFiles.length > 0, `${label}.changedFiles must not be empty`);
    assert.deepEqual(job.changedFiles, job.writeSet, `${label} must only change its declared write set`);
    jobChangedFiles.push(...job.changedFiles);
  }
  assert.equal(new Set(jobChangedFiles).size, jobChangedFiles.length, "parallel jobs must have disjoint changed files");

  assertExactKeys(run.review, ["readyToAccept", "changedFiles", "appliedFiles", "integrationTests", "treeSync"], "run.review");
  assert.equal(run.review.readyToAccept, true);
  assert.deepEqual(run.review.changedFiles, jobChangedFiles);
  assert.deepEqual(run.review.appliedFiles, run.review.changedFiles);
  for (const [index, changedFile] of run.review.changedFiles.entries()) {
    await assertFile(root, changedFile, `run.review.changedFiles[${index}]`);
  }
  assert.deepEqual(run.review.treeSync, { status: "completed", affectedNodes: [manifest.stageNodeId] });
  assert.ok(Array.isArray(run.review.integrationTests) && run.review.integrationTests.length > 0, "run.review.integrationTests must not be empty");

  await assertFile(root, manifest.integrationEvidenceFile, "fixture.integrationEvidenceFile");
  const evidence = await readJson(path.join(root, manifest.integrationEvidenceFile));
  assertExactKeys(evidence, [
    "schemaVersion", "kind", "command", "status", "exitCode", "assertions", "routedOrderIds",
    "networkUsed", "browserUsed", "humanInputUsed"
  ], "evidence");
  assert.equal(evidence.kind, "local-integration-test");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.exitCode, 0);
  assert.ok(Number.isInteger(evidence.assertions) && evidence.assertions > 0, "evidence.assertions must be positive");
  assert.equal(evidence.networkUsed, false);
  assert.equal(evidence.browserUsed, false);
  assert.equal(evidence.humanInputUsed, false);

  for (const [index, test] of run.review.integrationTests.entries()) {
    const label = `run.review.integrationTests[${index}]`;
    assertExactKeys(test, ["command", "status", "exitCode", "evidenceFile"], label);
    assert.equal(test.status, "passed");
    assert.equal(test.exitCode, 0);
    assert.equal(test.command, evidence.command);
    assert.equal(test.evidenceFile, manifest.integrationEvidenceFile);
    assert.match(test.command, /^node [A-Za-z0-9_./-]+\.mjs$/, `${label}.command must be a local Node command`);
  }

  assertExactKeys(run.goalAssessment, ["localCapability", "realBusinessEvidence", "goalAchieved", "residualGap"], "run.goalAssessment");
  assert.equal(run.goalAssessment.localCapability, "verified");
  assert.equal(run.goalAssessment.realBusinessEvidence, "missing");
  assert.equal(run.goalAssessment.goalAchieved, false, "accepted local work must not imply the overall goal is achieved");
  assertNonEmptyString(run.goalAssessment.residualGap, "run.goalAssessment.residualGap");

  return {
    fixtureId: manifest.fixtureId,
    goalNodeId: rootNode.id,
    stageNodeId: stageNode.id,
    jobs: run.jobs.length,
    changedFiles: run.review.changedFiles.length,
    integrationTests: run.review.integrationTests.length,
    realBusinessEvidence: run.goalAssessment.realBusinessEvidence
  };
}

if (process.argv[1] && comparablePath(process.argv[1]) === comparablePath(fileURLToPath(import.meta.url))) {
  try {
    const result = await validateFixture(process.argv[2] || ownDirectory);
    console.log(`PASS fixture structure ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`FAIL fixture structure: ${error.message}`);
    process.exitCode = 1;
  }
}
