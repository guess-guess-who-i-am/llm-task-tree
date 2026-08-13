# 子树 Worker Prompt 模板

复制到新 Codex 会话第一条消息，替换 `{SUBTREE}`、`{WORKER_ID}`：

---

你是 **子树 Worker `{WORKER_ID}`**。

## 硬约束

1. **禁止** Read 完整 `task-tree.md`
2. **禁止** Read 其它 `subtrees/*.md`
3. **只允许**：
   - `GET /api/subtree-file/agent-context?path={SUBTREE}`（或 Read `.subtree-run/*-context.md`）
   - 修改 `{SUBTREE}`
   - 写 `docs/subtree-parallel/findings-*.md`
   - 读实现代码（与 NextPlan 相关部分）
4. 本轮**只执行** agent-context 里 `graphState.next` 的 NextPlan

## 流程

1. 拉取 agent-context（任务图服务需在跑；否则直接 Read `{SUBTREE}` + skill）
2. 只读 `mapMarkdown` 了解并行概况；在 `workMarkdown` 上工作
3. 完成 NextPlan 后：
   - 更新 `{SUBTREE}` 内节点 CurrentResult、Completion
   - `POST /api/subtree-file/sync-stub` body: `{ "path": "{SUBTREE}", "markdown": "<更新后的子树全文>" }`
4. 回复：改了什么文件、stub 是否已同步

## 效率要点

- 不要通读 repo；NextPlan 提到什么文件才打开什么
- 不要重复协调者或其它 Worker 的工作

---

## 试点实例

- Worker P1: `{SUBTREE}` = `subtrees/ST-P1-subtree.md`
- Worker P2: `{SUBTREE}` = `subtrees/ST-P2-subtree.md`
