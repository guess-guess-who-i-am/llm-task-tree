# 多 Agent 子树并行 — 自动运行与手动兜底

## 0. 推荐：两次审核的自动并行

正常情况下不需要手动开多个 Codex 会话。打开任务图右上角 Codex 菜单，选择 **自动并行 Codex**：

1. 系统读取 ROOT、当前阶段和未决节点，让 planner 生成 2–4 个分支、依赖、独占写集和验收命令；此时只生成 `draft`，不创建 worktree，也不写项目文件。
2. 人只审核这份草案，必要时改任务或写集，然后点 **批准并运行**。批准会冻结当前工作区快照。
3. 系统在隔离 git worktree 中启动真实 Codex worker。互不依赖的任务并行运行，完成一个就进入 integration 并解锁后继任务；越界写入、保留路径、写集冲突和测试失败都会被程序拦截。
4. coordinator 在 integration worktree 核验实际差异、修复兼容问题并测试。主工作区在此期间保持不变。
5. 人只做第二次审核：查看根本目标相对结论、变更文件、测试和 diff，点 **接受并应用** 或 **丢弃结果**。接受后系统才应用补丁，并用受限 scope 会话精炼受影响节点；不会自动移动全局 GraphState。

运行记录在项目 `.task-tree-runs/<runId>.json`，隔离目录在系统临时目录，接受/拒绝后会清理。规划慢时接口立即返回 `planning`，界面轮询，不会让浏览器请求一直挂住。

> 下方手动兜底流程的子树详文仍只用任务图 UI ⊞ 展开；自动流程由结束审核和受限状态同步会话完成状态落盘。

## 1. 手动兜底：把主树收成「索引」

1. 打开 `打开任务图.cmd`
2. 对每个大分支根节点（如 N6、N7、N3…）点 **⊟ 折叠**
3. 主树只剩：ROOT + N2（若在做的壳）+ 各 stub（Problem 一行 + SubtreeFile）
4. 运行 `node scripts/subtree-size-experiment.mjs` 看 `projectedTokensEst` 是否 ~3k 级

**未折叠前**（~9k token）也可并行，但 Worker 读整树更费 context；**折叠后读整树是推荐模式**。

## 2. 开 Agent（同一项目根目录）

| 会话 | 贴什么 | 作用 |
|------|--------|------|
| **协调者 ×1** | `prompts/coordinator.md` | 派活、看 stub 进度、冲突检查 |
| **Worker ×N** | `prompts/worker-v2.md`（填 SUBTREE） | 各守一个 `subtrees/Nx-subtree.md` |

## 3. Worker 首条消息示例（N6 包）

```
你是 worker-N6，负责 N6 → subtrees/N6-subtree.md。

按 docs/subtree-parallel/prompts/worker-v2.md：
- 可以读 task-tree.md 全文（看 stub 索引）
- 禁止读其它 subtrees/*.md
- 禁止写 task-tree.md 详文；合并我只用 UI ⊞

执行 subtrees/N6-subtree.md 里 GraphState.Next 的 NextPlan。
```

## 4. 并行跑

- 各 Worker **同时**跑即可（产出文件已分区）
- 每个 Worker 子树内可再开 `/loop` + `chain-step`（只链本子树 GraphState）

## 5. 收工与合并

1. 看主树 stub 的 `Completion` / `CurrentResult`（Worker 可选 sync-stub，或你手动看子树）
2. 协调者写 merge 清单（`coordinator-run-*.md`）
3. **你**在任务图对每个完成的包点 **⊞ 展开** → 整包写回 `task-tree.md`
4. 不要多个 Agent 同时 ⊞ 同一节点

## 6. 控制变量自检

| 检查 | 期望 |
|------|------|
| Worker 读了整树但没去改 N7 详文 | ✅ |
| Worker 没读 ST-P2-subtree | ✅ |
| 主树详文变更只来自 ⊞ 展开 | ✅ |
| 代码冲突 | 用 git / 不同 worktree 若改同一文件 |

实验记录：`EXPERIMENT.md`
