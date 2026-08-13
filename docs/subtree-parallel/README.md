# 子树多 Agent 并行试点 — 总结

> 2026-06-27：1 协调者 + 2 Worker subagent 试跑；已实现 agent-context / sync-stub API。

## 是否提效？

| 维度 | 单 Agent | 2 Worker 并行（本轮） |
|------|----------|------------------------|
| 墙钟时间 | 串行审计+分析 ~15min | **并行 ~5min**（两路同时完成） |
| 上下文 token | 读整树 + 全 repo | 各 Worker ~3 个文件，**明显更小** |
| 协调成本 | 无 | 协调者 1 轮 + sync-stub / merge |
| 冲突风险 | 低 | 产出文件分区后 **无硬冲突**（见 coordinator-run-1） |

**结论**：可提效，前提是 **子树 GraphState 独立 + 产出路径分区 + 协调者只碰 stub**。

## 有效 prompt 约束（v2 — 允许读主树）

**以前禁止读整树**：未折叠时主树 ~9k token，且含其它包完整 Approach → 易抢活。  
**折叠后**：主树 ~3k token，只剩 stub → **Worker 可以读完整 `task-tree.md`**。

| 读 | 写 |
|----|-----|
| ✅ `task-tree.md`（stub 索引） | ✅ 自己的 `subtrees/X-subtree.md` + 代码 |
| ✅ 自己的 subtree | ❌ `task-tree.md` 详文 |
| ❌ 其它 `subtrees/*.md` | 合并：**仅 UI ⊞ 展开**（人操作） |

模板：`prompts/worker-v2.md` · 步骤：`WORKFLOW.md` · 实验：`EXPERIMENT.md`

### 协调者

1. **只读** ROOT + ST-* stub + 全局 GraphState
2. **不写** 子树内细节、不改 Worker 的 findings
3. 输出：派活表 + 冲突矩阵 + merge 清单

模板：`docs/subtree-parallel/prompts/coordinator.md`

## 推荐开 Agent 方式（Codex）

1. **同一项目根目录**开 3 个会话
2. 会话 A：贴 `coordinator.md` +「读 task-tree 仅 ROOT/ST-P1/ST-P2/GraphState」
3. 会话 B/C：贴 `worker.md`，替换 `{SUBTREE}` 为 ST-P1 / ST-P2
4. 可选：Worker 先 `curl .../agent-context?path=subtrees/ST-P1-subtree.md`

## 已落地工程

| 项 | 路径 |
|----|------|
| 子树上下文 API | `GET /api/subtree-file/agent-context?path=...` |
| stub 摘要回写 | `POST /api/subtree-file/sync-stub` |
| Skill | `skills/task-tree-subtree-run/SKILL.md` |
| 试点子树 | `subtrees/ST-P1-subtree.md`, `ST-P2-subtree.md` |
| 落盘 context | `.subtree-run/*-context.md` |

## 仍须改进（来自 findings-P1/P2）

1. **P0 已修**：chain-step JSON 去掉完整 `chain[]`；chain-advance agentPrompt redactFuture
2. **P1**：`ChainRunStatus=running` 时限制 `GET /api/tree` 或返回 redacted
3. **P2**：AssignedTo 进 schema；UI 一键 sync-stub；git worktree 脚本 per Worker

## 子树改动能回主树吗？

- **轻量**：`sync-stub` → 只更新 stub 的 Completion / CurrentResult / Notes / AssignedTo
- **完整**：UI ⊞ 展开 → 整包合并进 `task-tree.md`

Worker 本轮只改了子树文件；协调者下一步应对两 stub 跑 sync-stub 或手动更新主树 stub CurrentResult。
