# Agent Instructions

This workspace uses `task-tree.md` as the shared task graph for human-agent collaboration. Every node in the graph is a subproblem or task. Edges represent relationships between nodes. `GraphState` tells you where to focus.

---

## 0. Compact Current-State Rule

`task-tree.md` is a compact **current working state**, not an append-only history log. History already lives in `versions/`; do not preserve obsolete methods inside live nodes unless the user explicitly asks for an audit narrative.

When writing the task tree:

1. **Replace or delete stale content instead of appending tombstones.**
   - Good: rewrite `Approach` to the currently valid method and keep one short reason in `RootCauseAnalysis`.
   - Bad: leave the old method in place and add "2026-07-02 deleted/abandoned..." below it.
2. **Refine before expanding.** Before adding text, remove duplicated, superseded, or process-only notes from the same node/edge. Keep the live graph readable in 30 seconds.
3. **Use hard field budgets unless the user asks for an audit narrative:**
   - `Problem`: 1 concrete question or unknown, <= 140 chars.
   - `Approach`: current method only, <= 4 bullets or <= 450 chars.
   - `Metrics`: 1-3 checks with how to measure them, <= 300 chars.
   - `CurrentResult`: <= 3 measured facts or conclusions, <= 500 chars total.
   - `RootCauseAnalysis`: <= 2 sentences, <= 350 chars; do not store full old plans.
   - `CaseStudy`: <= 2 cases, each 1 line.
   - `Input` / `Output`: 1-5 representative lines plus optional previewable paths, <= 700 chars each.
   - `Notes`: <= 3 live notes; delete resolved or obsolete notes.
   - `NextIdea`: 1 executable sentence, <= 160 chars.
4. **Big-tree refinement requires measured compression.** When the user asks to refine, clean noise, shrink, or reconcile old/new methods in a large tree:
   - Measure before/after: bytes, line count, nodes touched, over-budget fields, and long lines (>240 chars).
   - Prioritize `GraphState.Current`, `GraphState.Next`, their dependency path, and the top 8-15 over-budget nodes by text length/noise score. Do not stop after 3-5 nodes if the tree is still unreadable.
   - Target at least 25% text reduction in touched nodes and at least 30% reduction in long lines for the pass. If preserving facts prevents this, say which facts block compression.
   - Do not change `GraphState`, execution flow, node IDs, or edges unless the user's actual method changed.
5. **Parent nodes are indexes, not storage bins.** If a node has children or formula subnodes, the parent keeps only the current conclusion, 2-3 key numbers, and links/child IDs. Move formulas, derivations, failed variants, examples, and raw evidence to child nodes or files with previewable paths.
6. **New nodes are expensive.** Add a node only for a new independent subproblem with distinct input/output/metrics, a real branch that needs separate evaluation, or a node that cannot stay readable after refinement. Otherwise edit the existing node.
7. **Method replacement means live-state replacement.** If the user overturns a previous method, update the original node/edge to the new method and remove invalid old details. Version backups preserve the old state.
8. **Do not over-refine.** Preserve concrete measured results, unresolved risks, user decisions, and currently needed constraints. Do not rewrite the whole tree just to make it neat.
9. **Execution flow must track method changes.** If `Problem`, `Approach`, node structure, edge dependencies, or execution order changes, check whether `scripts/project.json` or `scripts/run.json` must be updated. CurrentResult-only edits usually do not require flow changes.

Noise and contradiction handling:

- If old text conflicts with the current method, the current method wins. Rewrite the field to the current method and delete the conflicting old text; do not keep both.
- If a fact is uncertain, label it as uncertain in one short note. If later evidence resolves it, replace the note with the conclusion.
- If a node contains process history, timestamps, abandoned alternatives, or "deleted/obsolete" annotations, remove them during the next touch unless the user explicitly asks for an audit record.
- If the live tree needs to cite old context, cite a version filename or artifact path in one line; do not paste the old content back into the node.
- Prefer moving bulky evidence to real files or `Input`/`Output` file references. The node should hold the conclusion and a small sample; the UI can preview referenced files.
- When a field is over budget, rewrite the whole field to the compact current state. Do not append a "summary" below the long field.

---

## 1. Start-of-Task Protocol

At the start of every substantive task:

1. Read the latest `task-tree.md` from disk when you need execution focus (locate `GraphState.Current`, `GraphState.Next`, and the **Next node's `NextIdea`**).
2. Treat `task-tree.md` as the authoritative task state. Chat history, memory, previous tool logs, existing generated files, and `skill-routing-log.md` are evidence only; they do not prove that a task is still valid after the tree has been restored.
3. **Do not** load this full protocol file, `task-tree-grill`, or `scripts/README.md` on every turn. Load them **only when this turn will write** to `task-tree.md` / `subtrees/*.md` (§1b) or to `scripts/*.json` (§1c) — see `.cursor/rules/llm-task-tree-edit.mdc` and `.cursor/rules/llm-task-tree-flow-edit.mdc`.
4. If the tree appears to have been restored or rolled back:
   - Follow the restored `task-tree.md`, even when files on disk show that later work was previously attempted.
   - Do not skip work merely because an artifact already exists. Re-evaluate or redo the work against the current `GraphState.Next` and node fields.
   - Treat artifacts that are not represented by the current tree as drift. Do not delete them automatically; inspect them only as prior drafts or candidates when useful.
   - If drift affects the current task, record it in the relevant node's `RootCauseAnalysis` or `Notes`.
5. If `task-tree.md` does not exist, create it (see §5 Schema) before doing implementation work.
6. If the task is broad or ambiguous, **first** help build or revise the overall tree with the user, then set `Current`/`Next`/`NextPlan`, then begin executing node by node.
7. **Never** try to execute the whole tree in one pass. Advance one node or a small coherent group, then update the graph.
8. If the user changes research direction, first decide whether this replaces the old method or creates a genuinely new independent subproblem. If it replaces the old method, rewrite/delete the obsolete live content in place; add a new node + edge only for a separate branch that needs its own input/output/metrics.
9. Check `SelectedSkills` on `Next` first, then on `Current` if `Next` has none.
   - Resolve selected skill IDs against **`llm-task-tree/skills/`**, then `./skills`, then `~/.codex/skills`, `~/.agents/skills`, `~/.orchestra/skills`.
   - Load and follow a selected skill only when it is relevant to the current request. If irrelevant or unavailable, note that in `skill-routing-log.md` (§6) and proceed with the best available workflow.
   - If a selected skill is actually used, record it in `skill-routing-log.md`.
   - When no skill is selected but the task clearly matches one, use normal skill trigger rules and also record the choice in `skill-routing-log.md`.

---

## 1b. Edit-Tree Gate (mandatory reads before writing)

**Applies when this turn will write** to `task-tree.md` or `subtrees/*.md` (create/repair nodes, edges, GraphState, fold stubs, chain-advance writeback).

**Before the first write**, Read in order:

1. `llm-task-tree/AGENTS.task-tree.md` (this file in the project stub)
2. `llm-task-tree/skills/task-tree-grill/SKILL.md`
3. `llm-task-tree/skills/task-tree-grill/references/schema-template.md`

These mandatory gate reads are protocol reads, not skill routing. Do **not** append to `skill-routing-log.md` merely because the gate required reading `task-tree-grill`; log only when a selected or deliberately chosen skill actually shaped the task work.

Then create a version backup under `versions/` (§7) unless the UI already saved with backup in the same minute for the same edit.

**Does not apply** when you only read the tree for context, execute code/tests, or update non-tree files. In those cases, reading `task-tree.md` GraphState alone is enough.

**Structure reminder:** all `##` node sections first, then `# GraphState`, then `# Edges`. Never insert `# GraphState` between ROOT and child nodes.

---

## 1c. Edit-Flow Gate (mandatory reads before writing execution flow)

**Applies when this turn will write** to `scripts/project.json`, `scripts/run.json`, or call `PUT /api/flow-script` (create/reorder flow blocks, sync method to execution order).

**Before the first write**, Read in order:

1. **`scripts/README.md`** at the project root — **authoritative** schema (`flow-script/v1`), block types, when to edit, backup, and API
2. Current **`scripts/project.json`** (and **`scripts/run.json`** if editing run mode)
3. Skim **`task-tree.md`** (+ relevant **`subtrees/*.md`**) for valid **`nodeId`** values that `task` / `ref` blocks must reference

Then backup under `scripts/versions/project/` or `scripts/versions/run/` before overwrite, or use `PUT /api/flow-script` with default backup.

**After completing a flow step** (code run, chain advance, user-visible deliverable for that `nodeId`): write or update **`scripts/steps/<nodeId>/latest/step.json`** + **`report.zh.md`** (see `scripts/steps/README.md`). Call `GET /api/flow-script/drift` when `Approach` / `Problem` / edges change; sync `blocks` in the same turn.

**Does not apply** when you only read the flow for context, only update node `CurrentResult`/`Notes`, or only change graph layout in the UI.

**Reminder:** `task-tree.md` = semantics and **relationship edges**; `scripts/*.json` = **execution order** (hat → task → if/repeat → ref). Do not infer execution order from node ID sort or canvas position.

Cursor rule: `.cursor/rules/llm-task-tree-flow-edit.mdc`

---

## 2. End-of-Task Protocol

When you complete, split, abandon, or materially reframe a task:

1. **Create a version backup** before manually editing `task-tree.md`:
   - Copy `task-tree.md` to `versions/<timestamp>_<原因>.md`.
   - The reason should be concrete: `将增加节点N5`, `将修改N4的CurrentResult`, `将回退到某版本`, etc.
2. **Edit `task-tree.md`** in the same turn. Update only the smallest relevant node/edge; do not rewrite the whole file. Before adding new text, locally refine the touched node/edge: delete obsolete method fragments, duplicate notes, and process-only history that is already preserved in `versions/`.
3. **Update these fields** on the node(s) you worked on:

   | Field | When to update | What to write |
   |-------|---------------|---------------|
   | `CurrentResult` | After every completed round of work on this node | **Measured results**: numbers, sample rows, pass/fail counts, conclusions — not「已完成分析」. Plans stay in `Approach`/`NextIdea`; failures in `RootCauseAnalysis`. Label exploratory vs frozen. Keep at most 3 live facts / 500 chars; replace older less-relevant facts if needed. |
   | `RootCauseAnalysis` | When something went wrong, a design changed, or confusion occurred | Why the problem happened, not just what happened. Identify the root cause, not the symptom. If a method was replaced, keep one compact reason and delete the obsolete method text. Keep <=2 sentences / 350 chars. |
   | `CaseStudy` | When you have concrete examples that illustrate the root cause | Keep at most 2 cases, each 1 line. Format: `case N: situation → mistake → lesson`. These are displayed collapsed in the UI. |
   | `Input` / `Output` | When the real data source or deliverable changes | Keep these current with 1-5 inline representative lines plus optional file paths, <=700 chars each. Use paths to real source/output files when bulky evidence exists, but include a short sample so the node remains readable. If the output changes from "analysis doc" to "API endpoint", update `Output`. |
   | `NextIdea` | When you have a concrete suggestion for the next step | One sentence; optional. Prefer executable detail (what to run/build), not direction-only. |
   | `Completion` | When the node's work is clearly not started, in progress, complete, or needs redo | Use one of: `未开始`, `进行中`, `已完成`, `需重做`. Do not use it to indicate focus. |
   | `SelectedSkills` | User sets this via the UI skill panel; do not overwrite | Leave it as the user set it unless re-selecting. |
   | `Notes` | For anything that does not fit the above | Free-form but live-only. Keep at most 3 useful notes; remove resolved, superseded, or duplicate notes. |

4. **Update `GraphState`** — **默认由用户在任务图 UI 指定**（◆ 下一步 / ● 当前 /「下一步」输入框），Agent **不得**擅自改 `Current` / `Next` / `NextPlan` / `ChainForceNext`：
   - **非链式循环**：只更新你本轮动过的**节点字段**（`CurrentResult`、`RootCauseAnalysis` 等）；**不要**写 `# GraphState` 里的 `Current`/`Next`/`NextPlan`/`ChainForceNext`。
   - **链式循环**（用户已设 `GraphState.Chain` 且 `ChainRunStatus=running`，或用户明确跑 `/loop`）：**仅**通过 `POST /api/graph-state/chain-advance` 推进 `Next`；不要手改 markdown 里的 `Next` 来「帮用户决定下一步」。
   - 若需建议下一节点，写在对应节点的 `NextIdea`，或聊天里说明；等用户点 ◆ 或写入 NextPlan。
   - **例外**：用户明确要求你改焦点，或你在帮用户**初次建树**时与用户确认后写入。

5. **Update or add edges** as needed. If a relationship changed, update the existing edge and remove stale edge notes. If a new independent subproblem was discovered, add a node and connect it with an edge. If the new direction replaces an old branch, delete or rewrite the obsolete branch instead of leaving both live.

6. **Synchronize execution flow when the method changes.** If this edit changes `Problem`, `Approach`, node/edge structure, dependencies, or execution order, follow §1c and update `scripts/project.json` / `scripts/run.json` as needed. Do not edit flow for CurrentResult-only updates.

7. **Mention** in your final message which node/edge and flow script changed, so the user knows what to look for.

---

## 3. Field Writing Guidelines

### `CurrentResult` — be specific

```
Good: "修复了 /api/skills/recommend 超时问题：将 walkFiles 改为分批读取，超时从 22s 降到 800ms。"
Bad:  "完成了一些修复工作。"
```

If there are already more than 3 result facts, replace weaker or obsolete facts with the new measured conclusion instead of appending indefinitely.

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

### Live-State Edits — replace, do not annotate deletion

```
Good: Approach: 当前采用精炼写树协议：写入前修剪节点，只保留当前有效方案；历史由 versions/ 保存。
Bad:  Approach: 旧方案 A ...（7月2日删除，不再采用）当前采用精炼写树协议...
```

When the user rejects a method, remove the rejected method from the live field. Record only the reason needed to understand the current state.

### `Input` / `Output` — 短样例 + 可预览文件

- **不要**写概括句（如「主要输入：代码库、文档」）或只写一个路径让人猜。
- **要**写 1-5 行代表性真实内容：JSON/CSV 行、SQL 片段、API 请求与响应、终端输出、配置键值、UI 文案、指标数值等。
- **可以**补充真实文件路径（如 `data/dev.jsonl # 完整输入文件，UI 会预览开头`），尤其是原始输入/输出很大时。路径不是替代样例，而是证据入口。
- **每行一条**，行末用 `# 注释`（或 `// 注释`、`（中文注释）`）说明这一行是什么。
- `Input`：这个节点实际吃进去的数据/上下文长什么样（短样例 + 可选源文件路径）。
- `Output`：这个节点实际产出的结果长什么样（短结果片段 + 可选输出文件路径）。
- 单行过长时截取最有代表性的几行，注释里说明「截断」或总量；不要把整篇文档贴进节点。
- 若某行是工作区路径，前端会预览文件开头；如果路径失效，下次触碰节点时修正路径或删除它。

```
Good Input:
  - {"paper_id":"1701.001","title":"Attention Is All You Need","year":2017}  # 训练集单条 JSON
  - pool_layers: [title, abstract, refs, fulltext]  # graph_v2 四层前作池配置
  - data/dev.jsonl  # 完整输入文件；上面两行是代表性样例
  - 用户原话：「我不想去找对应的路径，直接在 I/O 里看到例子」  # 需求约束

Bad Input:
  - data/dev.jsonl  # 开发集（缺少代表性内容样例）
  - AGENTS.md、task-tree.md  # 项目文档
  - 主要输入：语料、配置、代码库

Good Output:
  - paper_id,layer,residual\nP001,title,0.12\nP001,abstract,0.31  # residuals.csv 前两行
  - outputs/run_042/residuals.csv  # 完整输出文件；上面一行是代表性样例
  - stub-refreshed: 2, prompts-synced: 3  # 一键更新终端摘要
  - GraphState.Next=N2; NextPlan=实现 I/O 内联样例编辑  # 改树后的焦点

Bad Output:
  - outputs/run_042/residuals.csv  # 结果表（缺少代表性结果片段）
  - 交付分析报告与评估结果
```

### `Approach` — keep current

When the implementation strategy shifts, update `Approach`. Do not leave outdated plans in the node. State **why** this method and what is **out of scope** for the final method (diagnostic-only vs shippable).

### 推理图原则 — 节点不是清单

树 = **可审计的方法推理图**（问题→证据→结论→下一步），不是项目目录或 checklist。

| 字段 | 写什么 |
|------|--------|
| `Problem` | **一个子问题**（问句/明确未知），不是脚本名、阶段名 |
| `Approach` | **为什么**这做法；诊断/评估 vs 可进最终方法的边界 |
| `Metrics` | 每个指标：**衡量什么** + **怎么测**（不只列名） |
| `CurrentResult` | **已跑出**的数字、样例、负结果；标注探索/冻结 |
| `RootCauseAnalysis` | **根因链**（为什么卡住），不只症状 |
| `NextPlan` | **可直接开工**（如「生成 30 篇 ids-file，跑 v1_4 pilot」） |

- **分工**：规划→`Approach`/`NextIdea`；实验数字→`CurrentResult`；失败→`RootCauseAnalysis`。
- **拆分**：一节点一问题；公式/变量按依赖链拆（总式→直接变量→子变量→数据）。
- **边**：`Label`/`Notes` 写依赖含义——说明什么、错了影响什么、当前结论。
- **诚实**：负结果必留；探索性/in-sample 明确标注；proxy 指标不能当构念本身；ROOT 保全局，不把当前 bug 分支写成整棵树。
- **精简**：`Position`/`Size` 不必 Agent 填；不重复整段背景（总览简写、子节点展开）。

Building or repairing graphs: use skill **`task-tree-grill`** and `skills/task-tree-grill/references/graph-quality.md`.

## 4. Node and Edge Rules

- **Node IDs**: keep them stable. If you must rename, update all edge endpoints.
- **Edge endpoints**: **exactly 2 nodes per edge** (binary edge). Do not create hyperedges with 3+ endpoints. If ROOT relates to many nodes, add one edge per pair or chain dependencies.
- **Layout (⇲)**: tree layout uses binary edges only; hyperedges are ignored. Keep the graph compact — avoid ROOT star hyperedges that spread nodes far apart.
- **Completion is not focus**: use `Completion` only for coarse completion state. Do not use `active`, `blocked`, or similar fields to express what is being worked on; focus is expressed through `GraphState.Current`/`Next`.
- **New subproblem → new node + edge**. Do not cram unrelated work into an existing node.
- **Uncertain relationship → edge with `Notes`**. The edge label says what the relationship is; `Notes` says how certain you are, **what breaks if wrong**, and the **current conclusion**.
- **Formula / variable chains**: decompose top-down (final formula → direct variables → sub-variables → data/audit). Do not star-link ROOT to every leaf.

### Execution flow scripts (`scripts/`)

- **Authority**: **Execution order** comes from `scripts/project.json` and `scripts/run.json`, not from node ID sort or graph layout.
- **Before writing flow**: follow **§1c Edit-Flow Gate** — Read **`scripts/README.md`** first (mandatory).
- **Relationship vs execution**: `task-tree.md` = node semantics, dependencies, GraphState. `scripts/*.json` = Scratch-style block sequence (hat / task / if / repeat / ref).
- **Folding**: Collapsing a subtree in the graph **does not** change flow scripts.
- **When to edit scripts**: (1) user asks to change the flowchart / execution order; (2) method/design change (`Problem`, `Approach`, node/edge structure, add/remove execution steps, dependency order) requires sync. If you replace an old method with a new method, check the flow in the same turn. **Do not** edit scripts for CurrentResult-only updates, fold/unfold, or canvas layout changes.
- **How to edit**: See **`scripts/README.md`** → modify `blocks` (stable `nodeId` on task blocks) → `PUT /api/flow-script` or write JSON with version backup.
- **Step audit**: Per-task evidence in **`scripts/steps/<nodeId>/latest/`** — UI flow panel Step Inspector; Agent writes after each step (see `scripts/steps/README.md`).
- **Drift check**: `GET /api/flow-script/drift`; sync status via `POST /api/flow-script/sync-status`; reorder via `POST /api/flow-script/rebuild`.

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
- Chain: <可选，逗号分隔的节点 ID 执行链>
- ChainAutoAdvance: <可选，true 时 Next 完成后自动沿 Chain 推进>
- ChainForceNext: <可选，用户强制指定的下一节点>

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
| `CodeLoc` | multi-line | Code locations: `path/to/file.js:123 # 说明` per line; UI opens in Cursor/VS Code on click |
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
| `Chain` | Optional ordered node IDs for Codex/Cursor single-step chain execution |
| `ChainAutoAdvance` | When true, advance along `Chain` after `Next` is complete |
| `ChainForceNext` | User-forced next node; Agent must apply on next turn then clear |

---

## 6. Skill Routing Log

`skill-routing-log.md` tracks whether `SelectedSkills` → actual usage → result forms a closed loop. Append a new entry whenever a skill is selected, used, or explicitly skipped:

Do not log mandatory protocol reads from §1b/§1c by themselves. Reading `task-tree-grill` only because the edit-tree gate requires it is not a skill-routing event.

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
- [ ] Touched nodes/edges were refined first; obsolete live content was replaced/deleted, not tombstoned
- [ ] Field budgets are respected, or the reason for exceeding them is explicit
- [ ] Node `CurrentResult` updated with concrete results (numbers, not vague summaries)
- [ ] Node fields follow §3 reasoning-graph rules (why, numbers, field split)
- [ ] Node `Input`/`Output` still accurate
- [ ] `GraphState.Current`/`Next`/`NextPlan` 未被擅自修改（非链式循环时保持用户 UI 设定；链式仅 chain-advance）
- [ ] Edges still valid; new edges added if needed
- [ ] If method/order changed, execution flow was checked and updated or explicitly left unchanged with a reason
- [ ] Rollback/drift mismatch handled if `task-tree.md` was restored
- [ ] `skill-routing-log.md` updated only if a selected/chosen skill was actually involved; mandatory gate reads alone were not logged
- [ ] Told the user which node/edge changed

---

## 10. Agent Chain Run (Codex / Cursor)

For **Codex or Cursor Agent** — not the web multi-model panel — run one node per turn along `GraphState.Chain`. Full workflow: skill `skills/task-tree-chain-run/SKILL.md`.

**Setup:** 节点 **⊕** 加入底部执行链；Next 节点卡片 **「下一步思路」** = 节点 `NextIdea`（每轮 Codex 的执行依据）；左上角 **自动推进** = `ChainAutoAdvance`。`GraphState.NextPlan`（「下一步」）loop **不读**。

**Each loop tick — mandatory gate**

1. `GET /api/graph-state/chain-step`
2. If `shouldStopLoop: true` → run `scripts/chain-loop-stop.ps1 -SoftOnly` (default: do not close IDE)
3. Else read `stepMarkdown` for `Next` + **Next node's NextIdea**; execute **NextIdea only** (code, shell, edit task-tree). May read full `task-tree.md` when needed. Do not complete multiple Chain nodes in one turn.

**Hard stop when chain finished:** `llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly` (add `-Hard` only if you must kill IDE)

**APIs:** `GET /api/graph-state/chain-step`, `POST /api/graph-state/chain-advance`

<!-- llm-task-tree:begin -->
## Task Graph (llm-task-tree)

This project uses **`task-tree.md`** at the repository root as shared task state for agents.

**Compact current-state rule**

`task-tree.md` is the current working graph, not an append-only history log. History lives in `versions/`.

- Replace or delete stale content instead of adding tombstones like "deleted on ...".
- Before adding text, refine the touched node/edge: remove duplicated, superseded, or process-only notes.
- Keep hard budgets: one `Problem`; current-only `Approach` <=4 bullets; `CurrentResult` <=3 facts / 500 chars; `RootCauseAnalysis` <=2 sentences / 350 chars; at most 2 cases; one executable `NextIdea`.
- For big-tree cleanup, measure before/after bytes, lines, over-budget fields, and long lines (>240 chars). Touch the current path plus the top 8-15 over-budget nodes; target >=25% reduction in touched-node text and >=30% fewer long lines, unless preserved facts block that.
- Parent nodes are indexes, not storage bins: if a node has child/formula nodes, keep only the current conclusion, 2-3 key numbers, and child/file references.
- If old text conflicts with the current method, rewrite/delete the old text; do not keep both old and new methods live.
- `Input`/`Output` should use 1-5 representative inline sample lines plus optional real file paths; bulky evidence belongs in files that the UI can preview.
- Add a new node only for a genuinely separate subproblem with distinct input/output/metrics.
- If a method/order change affects execution order, also update `scripts/project.json` or `scripts/run.json`; CurrentResult-only edits usually do not.
- Do not over-refine: preserve current measured facts, unresolved risks, user decisions, and active constraints.

**Every task — read-only tree context (default)**

1. If you need execution focus, read `task-tree.md` and use `GraphState.Current`, `GraphState.Next`, and the **Next node's `NextIdea`** (not only `NextPlan`).
2. Treat the tree as authoritative; chat history and orphan files are evidence only.
3. **Do not** Read `llm-task-tree/AGENTS.task-tree.md`, tree skills, or `scripts/README.md` unless this turn will **edit** the tree or **edit execution flow** (below).

**When you WILL edit the task tree** (write/create/repair `task-tree.md`, `subtrees/*.md`, nodes, edges, or GraphState)

Before any write, **must Read in order** (same turn, before editing):

1. `llm-task-tree/AGENTS.task-tree.md`
2. `llm-task-tree/skills/task-tree-grill/SKILL.md`
3. `llm-task-tree/skills/task-tree-grill/references/schema-template.md`

Then backup `task-tree.md` to `versions/<timestamp>_<原因>.md` before manual edits (see protocol §7). Follow **all nodes → `# GraphState` → `# Edges`** order.

Cursor: `.cursor/rules/llm-task-tree-edit.mdc`

**When you WILL edit execution flow** (write `scripts/project.json`, `scripts/run.json`, or `PUT /api/flow-script`)

Before any write, **must Read in order** (same turn, before editing):

1. **`scripts/README.md`** — schema、块类型、何时改/不改、保存与备份（**执行流程的权威写法**）
2. Current **`scripts/project.json`** (and **`scripts/run.json`** if editing run mode)
3. Skim **`task-tree.md`** (+ relevant `subtrees/*.md`) for valid **`nodeId`** values

Then backup to `scripts/versions/project/` or `scripts/versions/run/` (or use API with default backup). **Execution order lives in scripts, not in node ID sort or graph layout.**

Cursor: `.cursor/rules/llm-task-tree-flow-edit.mdc` · Full gate: `llm-task-tree/AGENTS.task-tree.md` §1c

**End of task — only if you edited the tree or flow this turn**

1. Update the smallest relevant node(s) and/or `blocks`; tell the user what changed.
2. For node `Input`/`Output`, paste **inline real content** with `# comment` per line — not bare paths.
3. If flow changed, note it in the affected node's `Notes`.

**No tree yet**

Create from `llm-task-tree/templates/task-tree.starter.md`, or run **task-tree-grill** (Read tree paths above first).

**UI**: `llm-task-tree/打开任务图.cmd` → **关系图 | 执行流程** for `scripts/project.json` / `scripts/run.json`.
<!-- llm-task-tree:end -->

<!-- llm-task-tree:tool-calling:begin -->
# Tool Calling Rules

When calling tools, follow these rules strictly. They override any conflicting habits from chat training.

## Argument formatting

1. **Omit optional fields you don't need.** Do not send `null`, `""`, `{}`, or `[]` as a placeholder. If a field is optional and you have no value, leave it out of the JSON entirely.

2. **Match the container type exactly.**
- Array fields take JSON arrays: `["a", "b"]`, never `"[\"a\",\"b\"]"` (string), never `{}` (object), never `"foo"` (bare string).
- Single-element arrays still need brackets: `["foo"]`, not `"foo"`.
- Object fields take JSON objects, not arrays or strings.

3. **Strings are raw strings.** Do not wrap values in extra quotes, code fences, or markdown.

4. **Numbers and booleans are unquoted.** `30`, not `"30"`. `true`, not `"true"`.

## Paths and identifiers

5. **File paths, URLs, IDs, and similar fields go to system functions, not chat output.** Never format them as markdown links, never wrap them in backticks, never add explanatory parentheses.

Correct: `"/Users/me/notes.md"`
Wrong: `"[notes.md](notes.md)"`
Wrong: `` "`/Users/me/notes.md`" ``
Wrong: `"/Users/me/notes.md (the notes file)"`

6. **If a tool description says "path", treat it as input to a filesystem call.** No formatting, no decoration.

## Related parameters

7. **When a tool has paired parameters (e.g., offset + limit, start + end, from + to), provide both or neither.** Read the description — if two fields work together, half the pair often produces an error.

## Recovery

8. **If a tool returns a validation error, read the error message carefully and fix only what it complains about.** Do not rewrite the whole call. Do not retry the same arguments.

9. **If a tool returns a "Note:" with a defaulted value, that's informational, not an error.** Continue the task. If the default is wrong, retry with the correct explicit value.

## Tool selection

10. **Use the tool whose description matches your intent most specifically.** Don't reach for `shellCommand` if a dedicated tool exists. Don't reach for `execute_code` for things a single tool call can handle.
<!-- llm-task-tree:tool-calling:end -->
