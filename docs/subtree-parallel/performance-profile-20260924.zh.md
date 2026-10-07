# 自动并行性能剖析（2026-09-24）

## 结论

真实运行记录见 [`artifacts/parallel-automatic/live-run.json`](../../artifacts/parallel-automatic/live-run.json)，运行 ID 为 `6109d0a7-3fae-4244-a2b5-a7d9aca6239e`。本轮最终 `accepted`，两个 Worker 均完成，`shared.txt` 的真实冲突已解决，三个结果文件已应用，临时工作树清理完成。

从 `planning_started` 到 `accepted` 用时约 **526.695 秒（8 分 46.7 秒）**。

| 阶段 | 用时 | 证据与判断 |
|---|---:|---|
| Planner Codex 回合 | 136.383 秒 | `gpt-5.6-sol`、`medium`；`completionMs=136236`，连接与线程建立合计约 140ms |
| Git 快照 | 约 130ms | `snapshot_started` 到 `run_started` |
| Worker alpha | 306.220 秒 | Codex completion 306.042 秒 |
| Worker beta | 258.974 秒 | Codex completion 258.805 秒 |
| 冲突解析 | 83.536 秒 | 单次 resolver 回合，`shared.txt` 已保留双方结果 |
| 冲突后收尾到 accepted | 约 260ms | 汇总、应用和状态写入均为毫秒级 |

因此本次最慢的不是并行调度、Git 或文件检查，而是三个模型回合：alpha Worker（306.220 秒）最长，其次 beta（258.974 秒），然后 Planner（136.383 秒）。两个 Worker 的启动事件只相差约 2ms，说明 Worker 确实同时启动；总耗时由最长 Worker 加冲突 resolver 决定，而不是两个 Worker 时间相加。

## Planner 的细分

Planner 的 `startCodexTurn` 细分为：initialize 30ms、thread start 102ms、turn start 8ms、等待模型 completion 136236ms、unsubscribe 1ms，总计 136382ms。第一次 reasoning 在 103947ms，第一次 agent message 在 115875ms，最终 agent message 在 136023ms。这个证据说明当前 Planner 瓶颈在模型服务的推理/生成等待；本地会话初始化没有形成瓶颈。冲突 resolver 现在也保存同样的 `resolverTiming` 和 `merge_resolver_turn_timing` 事件。

## Worker 的细分

alpha 的 initialize/thread start/turn start/unsubscribe 为 24/127/12/1ms，completion 为 306042ms；beta 为 26/128/10/1ms，completion 为 258805ms。Worker 完成后到冲突检测的间隔约 100ms，说明 `inspectChanges`、commit 和串行 Git 集成窗口很短。冲突 resolver 的 83536ms 同样是模型 completion 等待。

## 新增的函数级计时

协调器现在会在每个运行记录 `workspaceTimings`，按函数保存 `calls`、`totalMs`、`maxMs`、`lastMs`，并发出 `workspace_timing` 事件。覆盖的函数包括：`prepare`、`head`、`createWorker`、`inspectChanges`、`commit`、`integrate`、`continueIntegration`、`abortIntegration`、`removeWorker`、`summarize`、`accept` 和 `cleanup`。同时记录 `gitCommandTimings`，按 Git 子命令保存调用次数和耗时，并发出 `git_command_timing` 事件。这些字段也通过运行 API 返回。

这套计时器已用真实 Git 工作树、2 Worker 的快速端到端回归验证：所有上述调用均产生事件，Git 子命令（包括 `worktree`、`diff`、`commit-tree`、`cherry-pick`、`apply`）均有单独记录，两个 Worker 同时执行，运行最终 `accepted`。该回归耗时约 0.52 秒，但使用假模型响应，只证明计时链路正确，不能把它当成真实模型速度。本轮保存的旧真实模型运行是在计时器加入前完成的，所以旧 JSON 中没有新的 `workspaceTimings` 字段。

## DeepSeek 边界

独立 IDE 的 DeepSeek 主模型和 critic 健康检查均返回 HTTP 200，最近一次双模型真实调用总计约 3.8 秒（两个模型约 1.5 秒和 2.3 秒）。但自动并行 Planner/Worker 路径明确使用 Codex `gpt-5.6-sol`，所以这次切换本地 DeepSeek **不会直接缩短**本运行的 Planner、Worker 或 resolver 回合。若要让并行路径使用 DeepSeek，需要另行改变 `startCodexTurn` 的后端协议；仅修改本地 IDE 的 OpenAI 兼容配置不能改变 Codex app-server 的模型。

## 对照与限制

历史同类双分支运行总耗时 567.023 秒，本轮少 40.328 秒（约 7.1%），但不是严格 A/B：历史 Planner 为 122.877 秒，本轮 Planner 反而慢 13.506 秒；主要改善来自冲突处理从 238.517 秒降到 83.536 秒。当前冲突路径已将“每个 peer 一轮串行咨询”改成“一次完整参与者信息包 + 一次 resolver 回合”，这是减少协商次数的直接原因。

目前可以精确定位 Codex turn 的阶段、顶层 Workspace 函数和 Git 子命令。旧真实记录是在计时器加入前完成的，因此其中没有 Git 子命令级耗时；下一次真实运行会逐函数留下完整证据。现有证据已经足以判断旧运行的主要瓶颈不是 Git，而是模型回合等待。

## 验证

`server/codex-coordinator.js` 语法检查通过；`server/codex-coordinator.test.js`、`server/codex-run.test.js` 与 `scripts/test-parallel-worktree.mjs` 共 22 项测试全部通过，其中包含真实 Git 函数级计时回归。真实模型运行的离线结果也已核对：状态为 `accepted`、两个 Worker 为 `completed`、冲突为 `resolved`、消息数为 1、应用文件为 `alpha.txt`、`beta.txt`、`shared.txt`、清理为 `completed`。
