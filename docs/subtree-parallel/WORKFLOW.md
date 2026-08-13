# 多 Agent 子树并行 — 操作步骤（你手动开 Codex）

> 合并回主树：**只用任务图 UI ⊞ 展开**，不用 Agent 改主树详文。

## 0. 前置：把主树收成「索引」

1. 打开 `打开任务图.cmd`
2. 对每个大分支根节点（如 N6、N7、N3…）点 **⊟ 折叠**
3. 主树只剩：ROOT + N2（若在做的壳）+ 各 stub（Problem 一行 + SubtreeFile）
4. 运行 `node scripts/subtree-size-experiment.mjs` 看 `projectedTokensEst` 是否 ~3k 级

**未折叠前**（~9k token）也可并行，但 Worker 读整树更费 context；**折叠后读整树是推荐模式**。

## 1. 开 Agent（同一项目根目录）

| 会话 | 贴什么 | 作用 |
|------|--------|------|
| **协调者 ×1** | `prompts/coordinator.md` | 派活、看 stub 进度、冲突检查 |
| **Worker ×N** | `prompts/worker-v2.md`（填 SUBTREE） | 各守一个 `subtrees/Nx-subtree.md` |

## 2. Worker 首条消息示例（N6 包）

```
你是 worker-N6，负责 N6 → subtrees/N6-subtree.md。

按 docs/subtree-parallel/prompts/worker-v2.md：
- 可以读 task-tree.md 全文（看 stub 索引）
- 禁止读其它 subtrees/*.md
- 禁止写 task-tree.md 详文；合并我只用 UI ⊞

执行 subtrees/N6-subtree.md 里 GraphState.Next 的 NextPlan。
```

## 3. 并行跑

- 各 Worker **同时**跑即可（产出文件已分区）
- 每个 Worker 子树内可再开 `/loop` + `chain-step`（只链本子树 GraphState）

## 4. 收工与合并

1. 看主树 stub 的 `Completion` / `CurrentResult`（Worker 可选 sync-stub，或你手动看子树）
2. 协调者写 merge 清单（`coordinator-run-*.md`）
3. **你**在任务图对每个完成的包点 **⊞ 展开** → 整包写回 `task-tree.md`
4. 不要多个 Agent 同时 ⊞ 同一节点

## 5. 控制变量自检

| 检查 | 期望 |
|------|------|
| Worker 读了整树但没去改 N7 详文 | ✅ |
| Worker 没读 ST-P2-subtree | ✅ |
| 主树详文变更只来自 ⊞ 展开 | ✅ |
| 代码冲突 | 用 git / 不同 worktree 若改同一文件 |

实验记录：`EXPERIMENT.md`
