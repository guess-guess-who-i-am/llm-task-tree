import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { startCodexTurn } from "./codex-run.js";

function fakeAppServer() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0);
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const request = JSON.parse(line);
        const result = request.method === "thread/start"
          ? { thread: { id: "thread-test", cwd: "E:\\project" } }
          : request.method === "turn/start"
            ? { turn: { id: "turn-test" } }
            : {};
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
      }
      done();
    }
  });
  return child;
}

test("interactive launch returns after Codex accepts the turn", async () => {
  const startedAt = performance.now();
  const result = await startCodexTurn({
    cwd: "E:\\project",
    prompt: "test",
    spawnCodex: fakeAppServer
  });
  const elapsed = performance.now() - startedAt;

  assert.equal(result.threadId, "thread-test");
  assert.equal(result.turnId, "turn-test");
  assert.ok(elapsed < 500, `launch took ${elapsed.toFixed(1)}ms`);
});
