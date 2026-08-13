# Coordinator Run 1 — 子树并行试点首轮

> 协调者：Subtree Coordinator  
> 日期：2026-06-27  
> 依据：`task-tree.md` 中 ROOT、ST-P1、ST-P2 stub 及 GraphState（未读子树全文）

---

## 1. 本轮概况

| 项 | 值 |
|---|---|
| 全局 `GraphState.Current` | N2 |
| 全局 `GraphState.Next` | *(空)* |
| 全局 `GraphState.NextPlan` | *(空)* |
| 全局 `ChainForceNext` | ROOT |
| 活跃 stub 数 | 2（ST-P1、ST-P2） |
| 协调者职责 | 派活验收、冲突检测、合并清单；**不改** Worker 子树内节点细节 |

ROOT 目标仍为「建立可共享的大模型任务上下文」；两个折叠 stub 均 `Completion: 进行中`，已分配 Worker。

---

## 2. 派活表（Dispatch Table）

| Worker ID | Stub 节点 | SubtreeFile | AssignedTo（stub） | 子树 NextPlan（来自 agent-context / 子树头） | 预期产出 | 协调者动作 |
|---|---|---|---|---|---|---|
| worker-P1 | ST-P1 | `subtrees/ST-P1-subtree.md` | worker-P1 | 审计 `buildChainStepContext` / `buildChainAgentPrompt`，写 findings-P1，更新本节点 CurrentResult | `docs/subtree-parallel/findings-P1.md`（≤80 行）+ stub 同步 | 等 P1 完成后验收 findings 与 stub `CurrentResult` |
| worker-P2 | ST-P2 | `subtrees/ST-P2-subtree.md` | worker-P2 | 梳理并行冲突点，写 findings-P2，更新本节点 CurrentResult | `docs/subtree-parallel/findings-P2.md`（≤80 行）+ stub 同步 | 等 P2 完成后验收 findings 与 stub `CurrentResult` |

**派活约束（本轮）**

- Worker **禁止** Read 完整 `task-tree.md` 或其它 `subtrees/*.md`。
- Worker **只改** 各自 `{SUBTREE}` + `docs/subtree-parallel/findings-{Px}.md`；**禁止改代码**（两 stub Notes 均写明）。
- 完成后 Worker 须 `POST /api/subtree-file/sync-stub`，协调者再读 stub 摘要字段验收。

---

## 3. 冲突检查（Conflict Check）

### 3.1 GraphState.Next 是否撞车？

| 作用域 | Current | Next | 结论 |
|---|---|---|---|
| 全局 `task-tree.md` | N2 | *(空)* | 无 Worker 应写全局 Next |
| ST-P1 子树 | ST-P1 | ST-P1 | 与 P2 隔离 |
| ST-P2 子树 | ST-P2 | ST-P2 | 与 P1 隔离 |

**结论：无 GraphState.Next 写冲突。** 子树内 Next 各自指向本 stub；全局 Next 为空，由协调者独占维护。注意全局 `ChainForceNext: ROOT`——Worker 不得改全局 GraphState。

### 3.2 产出文件是否撞车？

| 路径 | 写者 | 冲突？ |
|---|---|---|
| `subtrees/ST-P1-subtree.md` | worker-P1 | 独占 |
| `subtrees/ST-P2-subtree.md` | worker-P2 | 独占 |
| `docs/subtree-parallel/findings-P1.md` | worker-P1 | 独占 |
| `docs/subtree-parallel/findings-P2.md` | worker-P2 | 独占 |
| `docs/subtree-parallel/coordinator-run-1.md` | 协调者 | 独占 |
| `task-tree.md`（全局） | **仅协调者**（合并/sync 后） | Worker 禁止直接写 |

**结论：无同文件并行写冲突。**

### 3.3 只读重叠（非冲突，需知会）

两 Worker 均可能只读：

- `llm-task-tree-kit/server.js`（P1：chain-step；P2：fold / sync-stub）
- `AGENTS.md`、`skills/task-tree-chain-run/SKILL.md`

只读重叠可接受；若某 Worker 越界改代码，协调者 merge 阶段应拒收。

### 3.4 其它风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| Worker 未跑 sync-stub，stub 与主树分叉 | 中 | merge 前检查 stub `CurrentResult` 是否与主树 ST-* 一致 |
| Worker 误写全局 `task-tree.md` | 高 | merge 清单对比 GraphState；发现则回滚 Worker 改动 |
| 前端自动保存与 sync-stub 交错 | 低 | 试点轮次只做文档，不改 kit 代码 |
| 两 findings 结论矛盾（如对 chain-step 泄露判断不一致） | 低 | merge 时并列收录，由人类或下一轮 ROOT 节点裁决 |

---

## 4. Worker 完成后的合并清单（Merge Checklist）

协调者在**全部** stub 达到可验收状态后逐项执行：

### 4.1 验收（Per Worker）

- [ ] **P1**：`findings-P1.md` 存在，≤80 行，≥3 条带 severity 的可执行建议
- [ ] **P1**：`subtrees/ST-P1-subtree.md` 内 ST-P1 节点 `CurrentResult` 已填（1–3 句摘要）
- [ ] **P1**：已 `POST sync-stub`；主树 stub `ST-P1` 的 `CurrentResult` / `Completion` 与 subtrees 一致
- [ ] **P2**：`findings-P2.md` 存在，≤80 行，覆盖 task-tree 写冲突、GraphState 冲突、代码 merge 三类
- [ ] **P2**：`subtrees/ST-P2-subtree.md` 内 ST-P2 节点 `CurrentResult` 已填
- [ ] **P2**：已 sync-stub；主树 stub `ST-P2` 与 subtrees 一致

### 4.2 冲突复核

- [ ] 全局 `GraphState` 未被 Worker 改动（`Current` 仍为 N2，`ChainForceNext` 仍为 ROOT，除非协调者有意调整）
- [ ] 无 Worker 修改 `llm-task-tree-kit/` 或其它非授权路径
- [ ] `findings-P1.md` 与 `findings-P2.md` 无互相覆盖的同一输出文件名

### 4.3 合并写回（协调者）

- [ ] 备份 `task-tree.md` → `versions/<timestamp>_合并ST-P1-P2试点.md`
- [ ] 将两 stub `Completion` 设为 `已完成`（若 Worker 未设）
- [ ] 在 ROOT 或新建汇总节点 `CurrentResult` 写 1–3 句：两 findings 要点 + 是否需 follow-up 节点
- [ ] 更新全局 `GraphState`：`Next` / `NextPlan` 指向试点后续（如「根据 findings 开改进节点」）
- [ ] 可选：写 `docs/subtree-parallel/coordinator-merge-checklist.md` 记录本轮 merge 结果

### 4.4 关闭条件

- [ ] 两 stub `Completion: 已完成`
- [ ] 协调者已向人类汇报：派活表、冲突结论、findings 路径、下一步建议

---

## 5. 本轮冲突结论（摘要）

| 检查项 | 结果 |
|---|---|
| 同一 `GraphState.Next` | **无冲突**（子树隔离；全局 Next 空） |
| 同一输出文件 | **无冲突**（findings 与 subtree 文件均分区） |
| 需人工关注 | 全局 `ChainForceNext: ROOT` 与空 Next 并存——合并时由协调者统一设定下一轮全局焦点 |

---

## 试点改进

以下为建议追加到 `docs/subtree-parallel/prompts/coordinator.md` 的条目（≤15 行；**本轮仅记录于此，不改模板**）：

```markdown
## 试点改进（Run 1 建议）

- 派活前显式列出：全局 GraphState（Current/Next/ChainForceNext）+ 各 stub AssignedTo/Completion。
- 冲突检查必须输出表格：全局 vs 各子树 GraphState.Next；产出文件写者矩阵。
- Worker 完成后先验 sync-stub：对比主树 stub 的 CurrentResult 与子树文件首段摘要是否一致。
- 若全局 Next 为空但 ChainForceNext 有值，协调者声明「Worker 不得写全局 GraphState」。
- merge 前 grep 仓库：Worker 是否越界修改 llm-task-tree-kit/ 或 task-tree.md。
- 两 findings 若对同一 API 结论矛盾，merge 时并列收录，不强行合并为一条。
- 每轮协调者产出 coordinator-run-N.md；全部 stub 完成后才写 coordinator-merge-checklist.md。
```
