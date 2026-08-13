/**
 * A stand-in for `codex app-server`, so the one-click launch can be tested without spending a model
 * turn. FAKE_APP_SERVER_MODE=fail replays a provider that rate-limits the turn; `gone` replays a
 * thread that can no longer be resumed (archived or deleted outside the UI).
 */

const mode = process.env.FAKE_APP_SERVER_MODE || "ok";
const threadId = "0000fake-0000-0000-0000-00000000thrd";
const turnId = "0000fake-0000-0000-0000-00000000turn";
const projectCwd = process.env.FAKE_APP_SERVER_CWD || "";

/** Echoed back so tests can assert which thread a turn actually landed in. */
let liveThreadId = threadId;
let named = "";

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32602, message } });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);

    if (message.method === "initialize") {
      reply(message.id, { userAgent: "fake", codexHome: "fake" });
      continue;
    }

    // Two pages, with this project's conversation on the second one: the real list is machine-wide
    // and ordered by recency, so a quiet project's threads are never on the first page.
    if (message.method === "thread/list") {
      const onSecondPage = Boolean(message.params?.cursor);
      reply(message.id, onSecondPage
        ? {
          data: [
            { id: threadId, cwd: projectCwd, name: named, preview: "调用 task_tree_open 打开任务图", updatedAt: 1785490443, ephemeral: false },
            { id: "0000fake-0000-0000-0000-0000000ephem", cwd: projectCwd, preview: "临时会话", updatedAt: 1785490000, ephemeral: true }
          ],
          nextCursor: null
        }
        : {
          data: [
            { id: "0000fake-0000-0000-0000-00000000othr", cwd: "C:\\somewhere\\else", preview: "别的项目", updatedAt: 1785490999, ephemeral: false }
          ],
          nextCursor: "page-2"
        });
      continue;
    }

    if (message.method === "thread/resume") {
      if (mode === "gone") {
        fail(message.id, "thread not found");
        continue;
      }
      liveThreadId = message.params?.threadId || threadId;
      // `foreign` replays a pin left over from another project: the thread resumes fine, it just
      // does not live here.
      const home = mode === "foreign" ? "C:\\somewhere\\else" : projectCwd;
      reply(message.id, { thread: { id: liveThreadId, cwd: home, status: { type: "idle" } } });
      continue;
    }

    if (message.method === "thread/start") {
      liveThreadId = threadId;
      reply(message.id, { thread: { id: liveThreadId, cwd: message.params?.cwd || null } });
      continue;
    }

    if (message.method === "thread/name/set") {
      named = message.params?.name || "";
      reply(message.id, {});
      continue;
    }

    if (message.method === "turn/start") {
      reply(message.id, { turn: { id: turnId, status: "inProgress" } });
      if (mode === "fail") {
        notify("error", {
          threadId: liveThreadId,
          turnId,
          error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
          willRetry: false
        });
        notify("turn/completed", { threadId: liveThreadId, turnId });
      } else {
        notify("item/started", { threadId: liveThreadId, item: { type: "userMessage", id: "item-1" } });
        notify("item/started", { threadId: liveThreadId, item: { type: "mcpToolCall", id: "item-2", tool: "task_tree_open" } });
        if (mode === "complete") {
          const item = { type: "agentMessage", id: "item-3", text: "worker final report", phase: "final_answer", memoryCitation: null };
          notify("item/completed", { threadId: liveThreadId, turnId, item });
          notify("turn/completed", {
            threadId: liveThreadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [item],
              itemsView: "full",
              error: null,
              startedAt: 1785490443,
              completedAt: 1785490444,
              durationMs: 1000
            }
          });
        }
      }
      continue;
    }
  }
});
