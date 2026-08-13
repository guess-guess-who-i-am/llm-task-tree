# Agent Instructions

This workspace uses `task-tree.md` as the shared task graph for human-agent collaboration. Every node in the graph is a subproblem or task. Edges represent relationships between nodes. `GraphState` tells you where to focus.

---

## 1. Start-of-Task Protocol

At the start of every substantive task:

1. Read the latest `task-tree.md` from disk (the frontend may have written to it).
2. Locate `GraphState.Current`, `GraphState.Next`, and `GraphState.NextPlan`.
3. Treat `task-tree.md` as the authoritative task state. Chat history, memory, previous tool logs, existing generated files, and `skill-routing-log.md` are evidence only; they do not prove that a task is still valid after the tree has been restored.
4. If the tree appears to have been restored or rolled back:
   - Follow the restored `task-tree.md`, even when files on disk show that later work was previously attempted.
   - Do not skip work merely because an artifact already exists. Re-evaluate or redo the work against the current `GraphState.Next` and node fields.
   - Treat artifacts that are not represented by the current tree as drift. Do not delete them automatically; inspect them only as prior drafts or candidates when useful.
   - If drift affects the current task, record it in the relevant node's `RootCauseAnalysis` or `Notes`.
5. If `task-tree.md` does not exist, create it (see §5 Schema) before doing implementation work.
6. If the task is broad or ambiguous, **first** help build or revise the overall tree with the user, then set `Current`/`Next`/`NextPlan`, then begin executing node by node.
7. **Never** try to execute the whole tree in one pass. Advance one node or a small coherent group, then update the graph.
8. If the user changes research direction, re-evaluate which node is `Current`; add a new node + edge rather than stuffing the new work into an old node.
9. Check `SelectedSkills` on `Next` first, then on `Current` if `Next` has none.
   - Resolve selected skill IDs against the project skill folder first (`./skills`), then global skill folders (`~/.codex/skills`, `~/.agents/skills`, `~/.orchestra/skills`).
   - Load and follow a selected skill only when it is relevant to the current request. If irrelevant or unavailable, note that in `skill-routing-log.md` (§6) and proceed with the best available workflow.
   - If a selected skill is actually used, record it in `skill-routing-log.md`.
   - When no skill is selected but the task clearly matches one, use normal skill trigger rules and also record the choice in `skill-routing-log.md`.

---

## 2. End-of-Task Protocol

When you complete, split, abandon, or materially reframe a task:

1. **Create a version backup** before manually editing `task-tree.md`:
   - Copy `task-tree.md` to `versions/<timestamp>_<原因>.md`.
   - The reason should be concrete: `将增加节点N5`, `将修改N4的CurrentResult`, `将回退到某版本`, etc.
2. **Edit `task-tree.md`** in the same turn. Update only the smallest relevant node/edge; do not rewrite the whole file.
3. **Update these fields** on the node(s) you worked on:

   | Field | When to update | What to write |
   |-------|---------------|---------------|
   | `CurrentResult` | After every completed round of work on this node | 1-3 sentences summarizing what was achieved. Be concrete: files changed, features added, bugs fixed, decisions made. |
   | `RootCauseAnalysis` | When something went wrong, a design changed, or confusion occurred | Why the problem happened, not just what happened. Identify the root cause, not the symptom. |
   | `CaseStudy` | When you have concrete examples that illustrate the root cause | Keep each case to 2-3 lines. Format: `case N: situation → mistake → lesson`. These are displayed collapsed in the UI. |
   | `Input` / `Output` | When the real data source or deliverable changes | Keep these current. If a task shifts from "local repo" to "global skill folder", update `Input`. If the output changes from "analysis doc" to "API endpoint", update `Output`. |
   | `NextIdea` | When you have a concrete suggestion for the next step | One sentence. Optional. |
   | `Completion` | When the node's work is clearly not started, in progress, complete, or needs redo | Use one of: `未开始`, `进行中`, `已完成`, `需重做`. Do not use it to indicate focus. |
   | `SelectedSkills` | User sets this via the UI skill panel; do not overwrite | Leave it as the user set it unless re-selecting. |
   | `Notes` | For anything that does not fit the above | Free-form. |

4. **Update `GraphState`**:
   - `Current`: set to the node you just finished working on.
   - `Next`: set to the node that should be worked on next (often the same as `Current` if continuing, or a new node if switching).
   - `NextPlan`: 1 sentence describing what to do next on `Next`. Keep it actionable.

5. **Update or add edges** as needed. If a new subproblem was discovered, add a node and connect it with an edge. If a relationship changed, update the edge. If you are uncertain about a relationship, still create the edge and put the uncertainty in `Notes`.

6. **Mention** in your final message which node or edge changed, so the user knows what to look for in the graph.

---

## 3. Field Writing Guidelines

### `CurrentResult` — be specific

```
Good: "修复了 /api/skills/recommend 超时问题：将 walkFiles 改为分批读取，超时从 22s 降到 800ms。"
Bad:  "完成了一些修复工作。"
```

### `RootCauseAnalysis` — go one level deeper

```
Good: "前端自动保存每次都触发版本备份，是因为 saveTree 无条件调用了需要备份的 PUT 端点。
      根因是 saveTree 和 manual-save 共用一个端点，缺少 backup 参数控制。"
Bad:  "版本太多了。"
```

### `CaseStudy` — compact, concrete

```
Good:
  - case 1: 用户说"删掉输入输出"→ 如果按字面删除字段，会破坏历史数据；实际意图是从卡片移出预览。
  - case 2: 定点 skill 推荐 score=2 召回 astropy，是因为分词器把中文"测试"匹配到 description 里的 "test"。
Bad:
  - 有时候用户的要求和实际意图不一致，我们需要理解真正的需求。
```

### `Input` / `Output` — keep in sync

- `Input` should list what data, files, or context this node consumes. Update it when the input source changes.
- `Output` should list what artifact, file, endpoint, or state this node produces. Update it when the output changes.

### `Approach` — keep current

When the implementation strategy shifts, update `Approach`. Do not leave outdated plans in the node.

---

## 4. Node and Edge Rules

- **Node IDs**: keep them stable. If you must rename, update all edge endpoints.
- **Edge endpoints**: can connect 2 or more nodes (hyperedge).
- **Completion is not focus**: use `Completion` only for coarse completion state. Do not use `active`, `blocked`, or similar fields to express what is being worked on; focus is expressed through `GraphState.Current`/`Next`.
- **New subproblem → new node + edge**. Do not cram unrelated work into an existing node.
- **Uncertain relationship → edge with `Notes`**. The edge label says what the relationship is; `Notes` says how certain you are.

---

## 5. Markdown Schema

When creating `task-tree.md` from scratch, use this structure:

```markdown
# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。

## ROOT - <根目标标题>

- Position:
- Size:
- Completion:
- Problem: <要解决的根本问题>
- Approach: <整体策略>
- Input: <输入>
- Output: <输出>
- Metrics: <如何判断成功>
- Notes:
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N1 - <节点标题>

- Position:
- Size:
- Completion:
- Problem:
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState

- Current: <节点ID>
- Next: <节点ID>
- NextPlan: <下一步做什么>

# Edges

## E1 - <关系标签>

- Endpoints: <节点ID1>, <节点ID2>
- LabelOffset:
- Label: <边标签>
- Notes:
```

### Node fields reference

| Markdown field | Internal key | Purpose |
|---------------|-------------|---------|
| `Position` | `x, y` on canvas | Set by frontend; leave empty if new |
| `Size` | `width, height` | Set by frontend; leave empty if new |
| `Completion` | enum text | Coarse completion state: `未开始`, `进行中`, `已完成`, `需重做` |
| `Problem` | plain text | What problem this node solves |
| `Approach` | plain text | How we plan to solve it |
| `Input` | plain text | Data/files/context consumed |
| `Output` | plain text | Artifacts produced |
| `Metrics` | plain text | How to evaluate success |
| `Notes` | plain text | Free-form notes |
| `CurrentResult` | plain text | Model-written: what was achieved |
| `RootCauseAnalysis` | plain text | Model-written: why things happened |
| `CaseStudy` | multi-line | Model-written: concrete cases |
| `NextIdea` | plain text | Model or user: suggested next step |
| `SelectedSkills` | comma-separated IDs | User-set via UI; model reads but does not overwrite |

### Edge fields reference

| Markdown field | Purpose |
|---------------|---------|
| `Endpoints` | Comma-separated node IDs |
| `LabelOffset` | Pixel offset for edge label position |
| `Label` | Human-readable relationship name |
| `Notes` | Edge-level notes, uncertainty, constraints |

### GraphState fields reference

| Field | Purpose |
|-------|---------|
| `Current` | Node ID being actively worked on |
| `Next` | Node ID to work on next (often same as Current) |
| `NextPlan` | One sentence: concrete next action on `Next` |

---

## 6. Skill Routing Log

`skill-routing-log.md` tracks whether `SelectedSkills` → actual usage → result forms a closed loop. Append a new entry whenever a skill is selected, used, or explicitly skipped:

```markdown
## <日期> - <节点> - <简述>

- SelectedSkills: `<skill_id>`
- Resolved: `<absolute path to SKILL.md>`
- Used: yes | no | partial
- Reason: <why used / why not>
- Result: <what happened>
```

Do not create this file if it does not exist; it is optional. If it exists, keep entries concise.

---

## 7. Version Backup Rules

- **When to backup**: only before manual edits to `task-tree.md` by Codex, or before a restore.
- **When NOT to backup**: the frontend autosaves without creating backups. Do not create backups for routine frontend saves.
- **Backup filename**: `versions/<YYYYMMDD-HHmmss>_<原因>.md`
- **After backup**: proceed to edit `task-tree.md` in the same turn.

---

## 8. Rollback And Drift Rules

Restoring `task-tree.md` changes the authoritative task state, but it does not automatically restore the rest of the filesystem. This creates possible drift.

- **Authoritative state**: `task-tree.md` decides what task exists, what node is current, and what should be done next.
- **Non-authoritative evidence**: existing files, logs, old versions, chat memory, and generated artifacts can inform the next implementation, but they must not override the restored tree.
- **Redo rule**: if `GraphState.NextPlan` asks for work that seems already done in files, perform a fresh verification against the current node. Reuse, rewrite, or delete artifacts only when the current task requires it.
- **Orphan artifact rule**: if a file exists but no current node records it, treat it as an orphan artifact. Mention the mismatch before relying on it.
- **No hidden rollback assumption**: never assume that rolling back the tree also rolled back code, skills, logs, server files, or generated documents.
- **When uncertain**: add a small node or note describing the drift instead of silently merging old work into the current node.

---

## 9. Quick Checklist

Before ending a turn where you changed `task-tree.md`:

- [ ] Version backup created (if manual edit)
- [ ] Node `CurrentResult` updated with concrete results
- [ ] Node `Input`/`Output` still accurate
- [ ] `GraphState.Current`/`Next`/`NextPlan` reflect reality
- [ ] Edges still valid; new edges added if needed
- [ ] Rollback/drift mismatch handled if `task-tree.md` was restored
- [ ] `skill-routing-log.md` updated (if skills were involved)
- [ ] Told the user which node/edge changed
