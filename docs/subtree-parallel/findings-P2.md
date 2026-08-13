# 并行多 Agent 冲突点梳理（P2）

> 依据：`foldSubtree` / `unfoldSubtree` / `persistTreeNow`、`syncStubFromSubtree` / `buildSubtreeAgentContext`、AGENTS.md §1 / §10。

## 1. task-tree.md 写冲突

| 冲突点 | 表现 | 缓解手段 |
|--------|------|----------|
| 多 Agent 直写主树 | 无锁、后写覆盖；节点/边/GraphState 整段丢失 | 子树 Worker **只改** `subtrees/*-subtree.md`；摘要经 `POST /api/subtree-file/sync-stub` 回写 |
| 前端自动保存 | `persistTreeNow` → `PUT /api/tree`，默认 `backup: true` | 协调者改主树前先读最新盘文件（§1）；Agent 手动改前先 `versions/` 备份 |
| 折叠/展开 | `foldSubtree` 删后代并 stub 化；`unfoldSubtree` 合并回主树并删子树文件 | 并行期间禁止对同一 fold root 做 fold/unfold；展开前确认 Worker 已停 |
| sync-stub 与主树并发 | `syncStubFromSubtree` 只同步 4 字段，仍可能覆盖协调者刚写的 stub | sync 前备份；协调者不动 stub 的 `Completion/CurrentResult/AssignedTo/Notes` |
| PUT 合并策略 | `mergePreservedNodeFields` 保留部分字段，非 CRDT | 缩小写入面：主树只留 ROOT + stub + 全局 GraphState |

**原则**：主树 = 索引 + 全局焦点；细节在子树文件，降低争用面。

## 2. GraphState 冲突

| 冲突点 | 表现 | 缓解手段 |
|--------|------|----------|
| 主树 vs 子树 GraphState | 各子树自有 `Current/Next/NextPlan`，与主树可能不一致 | Worker 以**本子树** GraphState 为权威；主树 GraphState 由协调者维护 |
| 链式执行 vs 并行子树 | §10 要求 `chain-step`、一次一节点；并行 Worker 不受链约束 | 链跑与并行子树**分区**：链管主树节点，子树内各自 NextPlan |
| 折叠时焦点漂移 | `foldSubtree` 将 `currentFocusId/nextFocusId` 从后代 remap 到 fold root | 折叠前清空或迁移执行链；避免 Worker 仍指向已移出主树的节点 |
| 上下文泄露 | Worker 若读完整主树，可能误执行他树 NextPlan | `buildSubtreeAgentContext` 硬规则：禁读完整 task-tree、禁读其它 subtrees |
| step 脱敏 | chain-step 隐藏未来链节点 ID | 并行 Worker 不应依赖主树 Chain；各自读 agent-context |

**原则**：焦点隔离——每个 Worker 只执行本子树 `Next` / `NextPlan`。

## 3. 代码 / 工作区 merge 冲突

| 冲突点 | 表现 | 缓解手段 |
|--------|------|----------|
| 同文件双写 | 两 Worker 改同一 `.js/.ts`，git/磁盘后写覆盖 | 任务拆分到** disjoint 路径**；节点标注 `AssignedTo` |
| 子树产物 vs 主树代码 | Worker 改 kit 代码 + 协调者改主树 UI | 本轮 P2 仅分析不改代码；实现期用分支或文件所有权表 |
| unfold 合并边 | `unfoldSubtree` 用 `normalizeEdges` 重算，可能与子树内边不一致 | 展开前 sync 子树 Completion；单人操作 unfold |
| 版本目录膨胀 | 每次 PUT/sync 可触发 `backupTree` | 前端 routine save 可 `backup: false`（协调者手动 save 再备份） |
| orphan 漂移 | 主树 rollback 后子树/代码仍留旧态（§1 item 4 / §8） | 以当前树为准重做验证；漂移写入 `Notes/RootCauseAnalysis` |

**原则**：文件所有权 > 事后 merge；子树折叠提供天然写隔离边界。

## 4. 推荐并行编排（摘要）

1. 协调者：维护主树 ROOT、stub、全局 GraphState；禁止 Worker 直写主树正文。
2. Worker：经 `GET /api/subtree-file/agent-context` 取上下文；结束更新子树 + `sync-stub`。
3. 合并窗口：全部 Worker `Completion: 已完成` 后，协调者 unfold 或汇总，再统一 git commit。
