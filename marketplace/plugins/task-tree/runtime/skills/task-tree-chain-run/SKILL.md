---
name: task-tree-chain-run
description: >-
  Run one Agent step along GraphState.Chain in Codex or Cursor. Use chain-step
  for focus; execute Next node's NextIdea (下一步思路); may read full task-tree.md
  when needed. Stop loop when shouldStopLoop=true.
---

# Task Tree Chain Run

让 **Codex / Cursor Agent** 按执行链**一次只跑一个节点**。

## 关键限制（必读）

| 问题 | 现状 |
|------|------|
| 能否看完整树？ | **可以**。Codex 在项目里能读 `task-tree.md`；链式 loop 仍建议先用 `chain-step` 拿本步 `Next`/`NextIdea`，需要全局上下文时再读整树 |
| 正确读法 | 先 `GET /api/graph-state/chain-step` 的 `stepMarkdown`（或 `.chain-run/step-context.md`），再按需读完整 `task-tree.md` |
| loop 执行依据 | **Next 节点的 `NextIdea`（页面「下一步思路」）** — **不是** `GraphState.NextPlan`（「下一步」） |
| loop 会不会自己停？ | **不会自动停**。`shouldStopLoop=true` 时必须运行 **`chain-loop-stop.ps1 -SoftOnly`**（默认不关闭 IDE） |
| 怎么知道本轮结束？ | 一轮 = Agent 从 tick 醒来到本 turn 结束；结束时更新节点 + 可选 `chain-advance` |
| 链跑完后？ | `Next` 空、`ChainRunStatus=done`、`shouldStopLoop=true` → **stop loop，不再执行** |

链式模式下 **§10 补充 AGENTS §1**：每轮先用 chain-step 确定本步；**执行内容以 Next 节点的 NextIdea 为准**；可读整树、改树、跑命令，但**一轮只完成当前 Next 的 NextIdea**。**推进 Next 只能用 `POST /api/graph-state/chain-advance`**，不要手改 markdown 里的 `GraphState.Next`（非链式时 Next 由用户在 UI 点 ◆ 决定）。

## 每轮 loop 固定流程

### 0. 第一件事 — 门禁（必须）

```bash
curl -s http://127.0.0.1:<port>/api/graph-state/chain-step
```

解析 JSON：

- **`shouldStopLoop: true`** → 运行停止脚本（**最后一动作**，默认 SoftOnly 不关 IDE）：

```powershell
powershell -ExecutionPolicy Bypass -File llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly -Reason "<stopReason>"
```

只回复 `链已停止：<stopReason>`；**不要**读 task-tree、**不要**继续 loop
- **`shouldStopLoop: false`** → 继续

也可用项目脚本（若存在）：`powershell -File llm-task-tree-kit/scripts/chain-loop-gate.ps1`

### 1. 读上下文

优先使用响应里的 **`stepMarkdown`**（或磁盘上的 `.chain-run/step-context.md`），其中包含 ROOT + 当前 Next 及之前链上节点 + **Next 的 NextIdea**。若需要，**可以**再读完整 `task-tree.md`。**不要**按 `GraphState.NextPlan` 执行。

### 2. 执行

**严格按 Next 节点的 `NextIdea`（下一步思路）执行**。可写代码、跑终端、改 `task-tree.md`；需要时可读完整任务树。不要一轮做完 Chain 里多个节点。

### 3. 结束本 turn

1. 备份并更新 **Next 节点**（`CurrentResult`；完成则 `Completion: 已完成`）
2. 若已完成且 `ChainAutoAdvance=true`：

```bash
curl -s -X POST http://127.0.0.1:<port>/api/graph-state/chain-advance -H "Content-Type: application/json" -d "{}"
```

3. 若 `chain-advance` 返回 **`done: true`** 或再次 `chain-step` 得 **`shouldStopLoop: true`** → 运行 **`chain-loop-stop.ps1 -SoftOnly`**
4. 否则结束 turn，等下一次 loop tick

## 完成判定

| 条件 | 可推进 |
|------|--------|
| `Completion: 已完成` | 是 |
| `CurrentResult` ≥ 20 字 | 是 |
| `Completion: 需重做` | 否，且 **shouldStopLoop=true** |

## UI 设链

1. 节点 **⊕** → 底部执行链
2. 拖动排序
3. 左上角 **自动推进** → `ChainAutoAdvance`
4. Next 节点卡片 **「下一步思路」** → 写入节点 `NextIdea`（loop 读这个）

## Cursor /loop 推荐命令

```
/loop 3m 【链式单步·按 NextIdea 执行】先 GET /api/graph-state/chain-step；shouldStopLoop 则 chain-loop-stop.ps1 -SoftOnly；读 Next+NextIdea，严格按 NextIdea 写代码/跑命令/改树（不要读 NextPlan）；更新 Next 节点；ChainAutoAdvance 则 chain-advance；done 或 shouldStopLoop 则 stop
```

**停止脚本**（默认 `-SoftOnly` 不关 IDE）：

`llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly`

门禁脚本 `chain-loop-gate.ps1` 在检测到 `shouldStopLoop` 时也会调用 stop（默认 SoftOnly）。

## stopReason 一览

- `ChainRunStatus=done`
- `GraphState.Next 为空（链已跑完）`
- `链已走完`
- `Chain 为空`
- `Next=… 为需重做，请人工修复后重启 loop`

## 不要做的事

- 不要一轮做完 Chain 里多个节点（即使能读完整树）
- 不要按 `GraphState.NextPlan`（「下一步」）执行
- 不要在 `shouldStopLoop=true` 后还 arm 下一个 loop tick
- 不要用多模型面板代替 Agent 链
