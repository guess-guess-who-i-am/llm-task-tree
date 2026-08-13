/**
 * Path + drop simulation tests (no browser).
 */
import { readFileSync } from "fs";

function parsePath(str) {
  if (!str) return [];
  return str.split(".").map((s) => (s === "body" || s === "elseBody" ? s : parseInt(s, 10)));
}
function pathEquals(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
function listPathFromBlockPath(blockPath) {
  return blockPath.slice(0, -1);
}
function getListByPath(path, stateBlocks) {
  if (!path?.length) return stateBlocks;
  if (typeof path[path.length - 1] === "number") return null;
  let list = stateBlocks;
  let block = null;
  for (const seg of path) {
    if (seg === "body" || seg === "elseBody") {
      if (!block) return null;
      if (!block[seg]) block[seg] = [];
      list = block[seg];
    } else if (typeof seg === "number") {
      block = list?.[seg];
      if (!block) return null;
    } else return null;
  }
  return list;
}
function insertBlockAt(parentPath, index, block, moveFromPath, stateBlocks) {
  const list = getListByPath(parentPath, stateBlocks);
  if (!list || !block) return false;
  let insertIndex = Number.isFinite(index) ? index : list.length;
  if (moveFromPath?.length) {
    const idx = moveFromPath[moveFromPath.length - 1];
    if (typeof idx !== "number" || Number.isNaN(idx)) return false;
    if (moveFromPath.length > 1) {
      const slot = moveFromPath[moveFromPath.length - 2];
      if (slot !== "body" && slot !== "elseBody") return false;
    } else {
      const moving = stateBlocks[idx];
      if (!moving || moving.type === "repeat" || moving.type === "if") return false;
    }
    const moveParent = moveFromPath.slice(0, -1);
    const fromIdx = moveFromPath[moveFromPath.length - 1];
    if (typeof fromIdx !== "number") return false;
    if (pathEquals(moveParent, parentPath)) {
      if (fromIdx < 0 || fromIdx >= list.length) return false;
      if (fromIdx === insertIndex || fromIdx + 1 === insertIndex) return true;
      const [item] = list.splice(fromIdx, 1);
      let target = insertIndex;
      if (fromIdx < target) target -= 1;
      target = Math.max(0, Math.min(target, list.length));
      list.splice(target, 0, item);
      return true;
    }
    const srcList = getListByPath(moveParent, stateBlocks);
    if (!srcList || fromIdx < 0 || fromIdx >= srcList.length) return false;
    const [item] = srcList.splice(fromIdx, 1);
    insertIndex = Math.max(0, Math.min(insertIndex, list.length));
    list.splice(insertIndex, 0, item);
    return true;
  }
  list.splice(Math.max(0, Math.min(insertIndex, list.length)), 0, block);
  return true;
}

function makeScript() {
  const body = ["N2a", "N2b", "N2c", "N2d"].map((id) => ({ id, type: "task", nodeId: id }));
  return [{ type: "hat" }, { type: "task", nodeId: "ROOT" }, { type: "task", nodeId: "N1" }, { type: "repeat", body, label: "子步骤" }, { type: "task", nodeId: "N4" }];
}

function simulateWrongPath() {
  const blocks = makeScript();
  const repeatIdx = 3;
  const wrongFrom = [repeatIdx, 3]; // data-path "3.3" bug
  const slot = { parentPath: [repeatIdx, "body"], index: 1 };
  const block = blocks[repeatIdx].body[3];
  console.log("\n=== Wrong path [3,3] (missing body) ===");
  console.log("moveParent", wrongFrom.slice(0, -1), "getList", getListByPath(wrongFrom.slice(0, -1), blocks));
  const ok = insertBlockAt(slot.parentPath, slot.index, block, wrongFrom, blocks);
  console.log("ok", ok, "repeat type", blocks[repeatIdx]?.type, "body len", blocks[repeatIdx]?.body?.length);
  console.log("root idx3", blocks[3]?.type, blocks.map((b) => b.type).join(","));
}

function simulateRootRemove() {
  const blocks = makeScript();
  const repeatIdx = 3;
  const wrongFrom = [repeatIdx]; // data-path "3" on draggable — must be rejected
  const slot = { parentPath: [repeatIdx, "body"], index: 1 };
  const block = blocks[repeatIdx].body[3];
  console.log("\n=== Wrong path [3] only (should reject) ===");
  const ok = insertBlockAt(slot.parentPath, slot.index, block, wrongFrom, blocks);
  console.log("ok", ok);
  console.log("repeat still", blocks[repeatIdx]?.type, "body len", blocks[repeatIdx]?.body?.length);
}

function simulateCorrect() {
  const blocks = makeScript();
  const repeatIdx = 3;
  const from = [repeatIdx, "body", 3];
  const ok = insertBlockAt([repeatIdx, "body"], 1, blocks[repeatIdx].body[3], from, blocks);
  console.log("\n=== Correct path ===");
  console.log("ok", ok, "body", blocks[repeatIdx].body.map((b) => b.nodeId));
}

simulateWrongPath();
simulateRootRemove();
simulateCorrect();

// DOM path strings from render
function renderPath(parentPath, i) {
  return [...parentPath, i].join(".");
}
console.log("\n=== Path strings ===");
console.log("correct M3", renderPath([3, "body"], 3));
console.log("wrong M3", renderPath([3], 3));
console.log("parse wrong", parsePath("3.3"), "listPath", listPathFromBlockPath(parsePath("3.3")));
