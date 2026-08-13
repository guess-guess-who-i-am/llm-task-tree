<!-- L0001 | F00 | 项目入口与任务树权威 -->
﻿# Agent Instructions

<!-- L0003 | F00 | 项目入口与任务树权威 -->
This workspace uses `task-tree.md` as the shared task graph for human-agent collaboration. Every node in the graph is a subproblem or task. Edges represent relationships between nodes. `GraphState` tells you where to focus.

<!-- L0005 | F00 | 项目入口与任务树权威 -->
---

<!-- L0007 | F01 | compact live state -->
## 0. Compact Current-State Rule

<!-- L0009 | F01 | compact live state -->
`task-tree.md` is a compact **current working state**, not an append-only history log. History already lives in `versions/`; do not preserve obsolete methods inside live nodes unless the user explicitly asks for an audit narrative.

<!-- L0011 | F01 | compact live state -->
When writing the task tree:

<!-- L0013 | F01 | compact live state -->
1. **Replace or delete stale content instead of appending tombstones.**
<!-- L0014 | F01 | compact live state -->
   - Good: rewrite `Approach` to the currently valid method and keep one short reason in `RootCauseAnalysis`.
<!-- L0015 | F01 | compact live state -->
   - Bad: leave the old method in place and add "2026-07-02 deleted/abandoned..." below it.
<!-- L0016 | F01 | compact live state -->
2. **Refine before expanding.** Before adding text, remove duplicated, superseded, or process-only notes from the same node/edge. Keep the live graph readable in 30 seconds.
<!-- L0017 | F02 | 字段硬预算 -->
3. **Use hard field budgets unless the user asks for an audit narrative:**
<!-- L0018 | F02 | 字段硬预算 -->
   - `Problem`: 1 concrete question or unknown, <= 140 chars.
<!-- L0019 | F02 | 字段硬预算 -->
   - `Approach`: current method only, <= 4 bullets or <= 450 chars.
<!-- L0020 | F02 | 字段硬预算 -->
   - `Metrics`: 1-3 checks with how to measure them, <= 300 chars.
<!-- L0021 | F02 | 字段硬预算 -->
   - `CurrentResult`: <= 3 measured facts or conclusions, <= 500 chars total.
<!-- L0022 | F02 | 字段硬预算 -->
   - `RootCauseAnalysis`: <= 2 sentences, <= 350 chars; do not store full old plans.
<!-- L0023 | F02 | 字段硬预算 -->
   - `CaseStudy`: <= 2 cases, each 1 line.
<!-- L0024 | F02 | 字段硬预算 -->
   - `Input` / `Output`: 1-5 representative lines plus optional previewable paths, <= 700 chars each.
<!-- L0025 | F02 | 字段硬预算 -->
   - `Notes`: <= 3 live notes; delete resolved or obsolete notes.
<!-- L0026 | F02 | 字段硬预算 -->
   - `NextIdea`: 1 executable sentence, <= 160 chars.
<!-- L0027 | F03 | 大树测量压缩 -->
4. **Big-tree refinement requires measured compression.** When the user asks to refine, clean noise, shrink, or reconcile old/new methods in a large tree:
<!-- L0028 | F03 | 大树测量压缩 -->
   - Measure before/after: bytes, line count, nodes touched, over-budget fields, and long lines (>240 chars).
<!-- L0029 | F03 | 大树测量压缩 -->
   - Prioritize `GraphState.Current`, `GraphState.Next`, their dependency path, and the top 8-15 over-budget nodes by text length/noise score. Do not stop after 3-5 nodes if the tree is still unreadable.
<!-- L0030 | F03 | 大树测量压缩 -->
   - Target at least 25% text reduction in touched nodes and at least 30% reduction in long lines for the pass. If preserving facts prevents this, say which facts block compression.
<!-- L0031 | F03 | 大树测量压缩 -->
   - Do not change `GraphState`, execution flow, node IDs, or edges unless the user's actual method changed.
<!-- L0032 | F04 | 节点成本与方法替换 -->
5. **Parent nodes are indexes, not storage bins.** If a node has children or formula subnodes, the parent keeps only the current conclusion, 2-3 key numbers, and links/child IDs. Move formulas, derivations, failed variants, examples, and raw evidence to child nodes or files with previewable paths.
<!-- L0033 | F04 | 节点成本与方法替换 -->
6. **New nodes are expensive.** Add a node only for a new independent subproblem with distinct input/output/metrics, a real branch that needs separate evaluation, or a node that cannot stay readable after refinement. Otherwise edit the existing node.
<!-- L0034 | F04 | 节点成本与方法替换 -->
7. **Method replacement means live-state replacement.** If the user overturns a previous method, update the original node/edge to the new method and remove invalid old details. Version backups preserve the old state.
<!-- L0035 | F04 | 节点成本与方法替换 -->
8. **Do not over-refine.** Preserve concrete measured results, unresolved risks, user decisions, and currently needed constraints. Do not rewrite the whole tree just to make it neat.
<!-- L0036 | F13 | 方法变化同步 flow -->
9. **Execution flow must track method changes.** If `Problem`, `Approach`, node structure, edge dependencies, or execution order changes, check whether `scripts/project.json` or `scripts/run.json` must be updated. CurrentResult-only edits usually do not require flow changes.

<!-- L0038 | F01 | 冲突与噪声清理 -->
Noise and contradiction handling:

<!-- L0040 | F01 | 冲突与噪声清理 -->
- If old text conflicts with the current method, the current method wins. Rewrite the field to the current method and delete the conflicting old text; do not keep both.
<!-- L0041 | F01 | 冲突与噪声清理 -->
- If a fact is uncertain, label it as uncertain in one short note. If later evidence resolves it, replace the note with the conclusion.
<!-- L0042 | F01 | 冲突与噪声清理 -->
- If a node contains process history, timestamps, abandoned alternatives, or "deleted/obsolete" annotations, remove them during the next touch unless the user explicitly asks for an audit record.
<!-- L0043 | F01 | 冲突与噪声清理 -->
- If the live tree needs to cite old context, cite a version filename or artifact path in one line; do not paste the old content back into the node.
<!-- L0044 | F01 | 冲突与噪声清理 -->
- Prefer moving bulky evidence to real files or `Input`/`Output` file references. The node should hold the conclusion and a small sample; the UI can preview referenced files.
<!-- L0045 | F01 | 冲突与噪声清理 -->
- When a field is over budget, rewrite the whole field to the compact current state. Do not append a "summary" below the long field.

<!-- L0047 | F01 | 冲突与噪声清理 -->
---

<!-- L0049 | F05 | 任务开始与焦点读取 -->
## 1. Start-of-Task Protocol

<!-- L0051 | F05 | 任务开始与焦点读取 -->
At the start of every substantive task:

<!-- L0053 | F05 | 任务开始与焦点读取 -->
1. Read the latest `task-tree.md` from disk when you need execution focus (locate `GraphState.Current`, `GraphState.Next`, and the **Next node's `NextIdea`**).
<!-- L0054 | F05 | 任务开始与焦点读取 -->
2. Treat `task-tree.md` as the authoritative task state. Chat history, memory, previous tool logs, existing generated files, and `skill-routing-log.md` are evidence only; they do not prove that a task is still valid after the tree has been restored.
<!-- L0055 | F05 | 任务开始与焦点读取 -->
3. **Do not** load this full protocol file, `task-tree-grill`, or `scripts/README.md` on every turn. Load them **only when this turn will write** to `task-tree.md` / `subtrees/*.md` (§1b) or to `scripts/*.json` (§1c) — see `.cursor/rules/llm-task-tree-edit.mdc` and `.cursor/rules/llm-task-tree-flow-edit.mdc`.
<!-- L0056 | F16 | 恢复/回滚起始处理 -->
4. If the tree appears to have been restored or rolled back:
<!-- L0057 | F16 | 恢复/回滚起始处理 -->
   - Follow the restored `task-tree.md`, even when files on disk show that later work was previously attempted.
<!-- L0058 | F16 | 恢复/回滚起始处理 -->
   - Do not skip work merely because an artifact already exists. Re-evaluate or redo the work against the current `GraphState.Next` and node fields.
<!-- L0059 | F16 | 恢复/回滚起始处理 -->
   - Treat artifacts that are not represented by the current tree as drift. Do not delete them automatically; inspect them only as prior drafts or candidates when useful.
<!-- L0060 | F16 | 恢复/回滚起始处理 -->
   - If drift affects the current task, record it in the relevant node's `RootCauseAnalysis` or `Notes`.
<!-- L0061 | F05 | 建树、逐节点与方向变化 -->
5. If `task-tree.md` does not exist, create it (see §5 Schema) before doing implementation work.
<!-- L0062 | F05 | 建树、逐节点与方向变化 -->
6. If the task is broad or ambiguous, **first** help build or revise the overall tree with the user, then set `Current`/`Next`/`NextPlan`, then begin executing node by node.
<!-- L0063 | F05 | 建树、逐节点与方向变化 -->
7. **Never** try to execute the whole tree in one pass. Advance one node or a small coherent group, then update the graph.
<!-- L0064 | F05 | 建树、逐节点与方向变化 -->
8. If the user changes research direction, first decide whether this replaces the old method or creates a genuinely new independent subproblem. If it replaces the old method, rewrite/delete the obsolete live content in place; add a new node + edge only for a separate branch that needs its own input/output/metrics.
<!-- L0065 | F06 | skill 路由 -->
9. Check `SelectedSkills` on `Next` first, then on `Current` if `Next` has none.
<!-- L0066 | F06 | skill 路由 -->
   - Resolve selected skill IDs against **`llm-task-tree/skills/`**, then `./skills`, then `~/.codex/skills`, `~/.agents/skills`, `~/.orchestra/skills`.
<!-- L0067 | F06 | skill 路由 -->
   - Load and follow a selected skill only when it is relevant to the current request. If irrelevant or unavailable, note that in `skill-routing-log.md` (§6) and proceed with the best available workflow.
<!-- L0068 | F06 | skill 路由 -->
   - If a selected skill is actually used, record it in `skill-routing-log.md`.
<!-- L0069 | F06 | skill 路由 -->
   - When no skill is selected but the task clearly matches one, use normal skill trigger rules and also record the choice in `skill-routing-log.md`.

<!-- L0071 | F06 | skill 路由 -->
---

<!-- L0073 | F07 | Edit-Tree Gate -->
## 1b. Edit-Tree Gate (mandatory reads before writing)

<!-- L0075 | F07 | Edit-Tree Gate -->
**Applies when this turn will write** to `task-tree.md` or `subtrees/*.md` (create/repair nodes, edges, GraphState, fold stubs, chain-advance writeback).

<!-- L0077 | F07 | Edit-Tree Gate -->
**Before the first write**, Read in order:

<!-- L0079 | F07 | Edit-Tree Gate -->
1. `llm-task-tree/AGENTS.task-tree.md` (this file in the project stub)
<!-- L0080 | F07 | Edit-Tree Gate -->
2. `llm-task-tree/skills/task-tree-grill/SKILL.md`
<!-- L0081 | F07 | Edit-Tree Gate -->
3. `llm-task-tree/skills/task-tree-grill/references/schema-template.md`

<!-- L0083 | F07 | Edit-Tree Gate -->
These mandatory gate reads are protocol reads, not skill routing. Do **not** append to `skill-routing-log.md` merely because the gate required reading `task-tree-grill`; log only when a selected or deliberately chosen skill actually shaped the task work.

<!-- L0085 | F07 | Edit-Tree Gate -->
Then create a version backup under `versions/` (§7) unless the UI already saved with backup in the same minute for the same edit.

<!-- L0087 | F07 | Edit-Tree Gate -->
**Does not apply** when you only read the tree for context, execute code/tests, or update non-tree files. In those cases, reading `task-tree.md` GraphState alone is enough.

<!-- L0089 | F07 | Edit-Tree Gate -->
**Structure reminder:** all `##` node sections first, then `# GraphState`, then `# Edges`. Never insert `# GraphState` between ROOT and child nodes.

<!-- L0091 | F07 | Edit-Tree Gate -->
---

<!-- L0093 | F08 | Edit-Flow Gate -->
## 1c. Edit-Flow Gate (mandatory reads before writing execution flow)

<!-- L0095 | F08 | Edit-Flow Gate -->
**Applies when this turn will write** to `scripts/project.json`, `scripts/run.json`, or call `PUT /api/flow-script` (create/reorder flow blocks, sync method to execution order).

<!-- L0097 | F08 | Edit-Flow Gate -->
**Before the first write**, Read in order:

<!-- L0099 | F08 | Edit-Flow Gate -->
1. **`scripts/README.md`** at the project root — **authoritative** schema (`flow-script/v1`), block types, when to edit, backup, and API
<!-- L0100 | F08 | Edit-Flow Gate -->
2. Current **`scripts/project.json`** (and **`scripts/run.json`** if editing run mode)
<!-- L0101 | F08 | Edit-Flow Gate -->
3. Skim **`task-tree.md`** (+ relevant **`subtrees/*.md`**) for valid **`nodeId`** values that `task` / `ref` blocks must reference

<!-- L0103 | F08 | Edit-Flow Gate -->
Then backup under `scripts/versions/project/` or `scripts/versions/run/` before overwrite, or use `PUT /api/flow-script` with default backup.

<!-- L0105 | F08 | Edit-Flow Gate -->
**After completing a flow step** (code run, chain advance, user-visible deliverable for that `nodeId`): write or update **`scripts/steps/<nodeId>/latest/step.json`** + **`report.zh.md`** (see `scripts/steps/README.md`). Call `GET /api/flow-script/drift` when `Approach` / `Problem` / edges change; sync `blocks` in the same turn.

<!-- L0107 | F08 | Edit-Flow Gate -->
**Does not apply** when you only read the flow for context, only update node `CurrentResult`/`Notes`, or only change graph layout in the UI.

<!-- L0109 | F08 | Edit-Flow Gate -->
**Reminder:** `task-tree.md` = semantics and **relationship edges**; `scripts/*.json` = **execution order** (hat → task → if/repeat → ref). Do not infer execution order from node ID sort or canvas position.

<!-- L0111 | F08 | Edit-Flow Gate -->
Cursor rule: `.cursor/rules/llm-task-tree-flow-edit.mdc`

<!-- L0113 | F08 | Edit-Flow Gate -->
---

<!-- L0115 | F09 | 结束写回与字段时机 -->
## 2. End-of-Task Protocol

<!-- L0117 | F09 | 结束写回与字段时机 -->
When you complete, split, abandon, or materially reframe a task:

<!-- L0119 | F09 | 结束写回与字段时机 -->
1. **Create a version backup** before manually editing `task-tree.md`:
<!-- L0120 | F09 | 结束写回与字段时机 -->
   - Copy `task-tree.md` to `versions/<timestamp>_<原因>.md`.
<!-- L0121 | F09 | 结束写回与字段时机 -->
   - The reason should be concrete: `将增加节点N5`, `将修改N4的CurrentResult`, `将回退到某版本`, etc.
<!-- L0122 | F09 | 结束写回与字段时机 -->
2. **Edit `task-tree.md`** in the same turn. Update only the smallest relevant node/edge; do not rewrite the whole file. Before adding new text, locally refine the touched node/edge: delete obsolete method fragments, duplicate notes, and process-only history that is already preserved in `versions/`.
<!-- L0123 | F09 | 结束写回与字段时机 -->
3. **Update these fields** on the node(s) you worked on:

<!-- L0125 | F09 | 结束写回与字段时机 -->
   | Field | When to update | What to write |
<!-- L0126 | F09 | 结束写回与字段时机 -->
   |-------|---------------|---------------|
<!-- L0127 | F09 | 结束写回与字段时机 -->
   | `CurrentResult` | After every completed round of work on this node | **Measured results**: numbers, sample rows, pass/fail counts, conclusions — not「已完成分析」. Plans stay in `Approach`/`NextIdea`; failures in `RootCauseAnalysis`. Label exploratory vs frozen. Keep at most 3 live facts / 500 chars; replace older less-relevant facts if needed. |
<!-- L0128 | F09 | 结束写回与字段时机 -->
   | `RootCauseAnalysis` | When something went wrong, a design changed, or confusion occurred | Why the problem happened, not just what happened. Identify the root cause, not the symptom. If a method was replaced, keep one compact reason and delete the obsolete method text. Keep <=2 sentences / 350 chars. |
<!-- L0129 | F09 | 结束写回与字段时机 -->
   | `CaseStudy` | When you have concrete examples that illustrate the root cause | Keep at most 2 cases, each 1 line. Format: `case N: situation → mistake → lesson`. These are displayed collapsed in the UI. |
<!-- L0130 | F09 | 结束写回与字段时机 -->
   | `Input` / `Output` | When the real data source or deliverable changes | Keep these current with 1-5 inline representative lines plus optional file paths, <=700 chars each. Use paths to real source/output files when bulky evidence exists, but include a short sample so the node remains readable. If the output changes from "analysis doc" to "API endpoint", update `Output`. |
<!-- L0131 | F09 | 结束写回与字段时机 -->
   | `NextIdea` | When you have a concrete suggestion for the next step | One sentence; optional. Prefer executable detail (what to run/build), not direction-only. |
<!-- L0132 | F09 | 结束写回与字段时机 -->
   | `Completion` | When the node's work is clearly not started, in progress, complete, or needs redo | Use one of: `未开始`, `进行中`, `已完成`, `需重做`. Do not use it to indicate focus. |
<!-- L0133 | F09 | 结束写回与字段时机 -->
   | `SelectedSkills` | User sets this via the UI skill panel; do not overwrite | Leave it as the user set it unless re-selecting. |
<!-- L0134 | F09 | 结束写回与字段时机 -->
   | `Notes` | For anything that does not fit the above | Free-form but live-only. Keep at most 3 useful notes; remove resolved, superseded, or duplicate notes. |

<!-- L0136 | F10 | GraphState 所有权 -->
4. **Update `GraphState`** — **默认由用户在任务图 UI 指定**（◆ 下一步 / ● 当前 /「下一步」输入框），Agent **不得**擅自改 `Current` / `Next` / `NextPlan` / `ChainForceNext`：
<!-- L0137 | F10 | GraphState 所有权 -->
   - **非链式循环**：只更新你本轮动过的**节点字段**（`CurrentResult`、`RootCauseAnalysis` 等）；**不要**写 `# GraphState` 里的 `Current`/`Next`/`NextPlan`/`ChainForceNext`。
<!-- L0138 | F10 | GraphState 所有权 -->
   - **链式循环**（用户已设 `GraphState.Chain` 且 `ChainRunStatus=running`，或用户明确跑 `/loop`）：**仅**通过 `POST /api/graph-state/chain-advance` 推进 `Next`；不要手改 markdown 里的 `Next` 来「帮用户决定下一步」。
<!-- L0139 | F10 | GraphState 所有权 -->
   - 若需建议下一节点，写在对应节点的 `NextIdea`，或聊天里说明；等用户点 ◆ 或写入 NextPlan。
<!-- L0140 | F10 | GraphState 所有权 -->
   - **例外**：用户明确要求你改焦点，或你在帮用户**初次建树**时与用户确认后写入。

<!-- L0142 | F12 | 边更新 -->
5. **Update or add edges** as needed. If a relationship changed, update the existing edge and remove stale edge notes. If a new independent subproblem was discovered, add a node and connect it with an edge. If the new direction replaces an old branch, delete or rewrite the obsolete branch instead of leaving both live.

<!-- L0144 | F13 | 方法变化同步 flow -->
6. **Synchronize execution flow when the method changes.** If this edit changes `Problem`, `Approach`, node/edge structure, dependencies, or execution order, follow §1c and update `scripts/project.json` / `scripts/run.json` as needed. Do not edit flow for CurrentResult-only updates.

<!-- L0146 | F09 | 最终告知 -->
7. **Mention** in your final message which node/edge and flow script changed, so the user knows what to look for.

<!-- L0148 | F09 | 最终告知 -->
---

<!-- L0150 | F11 | 字段写法、样例与推理图质量 -->
## 3. Field Writing Guidelines

<!-- L0152 | F11 | 字段写法、样例与推理图质量 -->
### `CurrentResult` — be specific

<!-- L0154 | F11 | 字段写法、样例与推理图质量 -->
```
<!-- L0155 | F11 | 字段写法、样例与推理图质量 -->
Good: "修复了 /api/skills/recommend 超时问题：将 walkFiles 改为分批读取，超时从 22s 降到 800ms。"
<!-- L0156 | F11 | 字段写法、样例与推理图质量 -->
Bad:  "完成了一些修复工作。"
<!-- L0157 | F11 | 字段写法、样例与推理图质量 -->
```

<!-- L0159 | F11 | 字段写法、样例与推理图质量 -->
If there are already more than 3 result facts, replace weaker or obsolete facts with the new measured conclusion instead of appending indefinitely.

<!-- L0161 | F11 | 字段写法、样例与推理图质量 -->
### `RootCauseAnalysis` — go one level deeper

<!-- L0163 | F11 | 字段写法、样例与推理图质量 -->
```
<!-- L0164 | F11 | 字段写法、样例与推理图质量 -->
Good: "前端自动保存每次都触发版本备份，是因为 saveTree 无条件调用了需要备份的 PUT 端点。
<!-- L0165 | F11 | 字段写法、样例与推理图质量 -->
      根因是 saveTree 和 manual-save 共用一个端点，缺少 backup 参数控制。"
<!-- L0166 | F11 | 字段写法、样例与推理图质量 -->
Bad:  "版本太多了。"
<!-- L0167 | F11 | 字段写法、样例与推理图质量 -->
```

<!-- L0169 | F11 | 字段写法、样例与推理图质量 -->
### `CaseStudy` — compact, concrete

<!-- L0171 | F11 | 字段写法、样例与推理图质量 -->
```
<!-- L0172 | F11 | 字段写法、样例与推理图质量 -->
Good:
<!-- L0173 | F11 | 字段写法、样例与推理图质量 -->
  - case 1: 用户说"删掉输入输出"→ 如果按字面删除字段，会破坏历史数据；实际意图是从卡片移出预览。
<!-- L0174 | F11 | 字段写法、样例与推理图质量 -->
  - case 2: 定点 skill 推荐 score=2 召回 astropy，是因为分词器把中文"测试"匹配到 description 里的 "test"。
<!-- L0175 | F11 | 字段写法、样例与推理图质量 -->
Bad:
<!-- L0176 | F11 | 字段写法、样例与推理图质量 -->
  - 有时候用户的要求和实际意图不一致，我们需要理解真正的需求。
<!-- L0177 | F11 | 字段写法、样例与推理图质量 -->
```

<!-- L0179 | F11 | 字段写法、样例与推理图质量 -->
### Live-State Edits — replace, do not annotate deletion

<!-- L0181 | F11 | 字段写法、样例与推理图质量 -->
```
<!-- L0182 | F11 | 字段写法、样例与推理图质量 -->
Good: Approach: 当前采用精炼写树协议：写入前修剪节点，只保留当前有效方案；历史由 versions/ 保存。
<!-- L0183 | F11 | 字段写法、样例与推理图质量 -->
Bad:  Approach: 旧方案 A ...（7月2日删除，不再采用）当前采用精炼写树协议...
<!-- L0184 | F11 | 字段写法、样例与推理图质量 -->
```

<!-- L0186 | F11 | 字段写法、样例与推理图质量 -->
When the user rejects a method, remove the rejected method from the live field. Record only the reason needed to understand the current state.

<!-- L0188 | F11 | 字段写法、样例与推理图质量 -->
### `Input` / `Output` — 短样例 + 可预览文件

<!-- L0190 | F11 | 字段写法、样例与推理图质量 -->
- **不要**写概括句（如「主要输入：代码库、文档」）或只写一个路径让人猜。
<!-- L0191 | F11 | 字段写法、样例与推理图质量 -->
- **要**写 1-5 行代表性真实内容：JSON/CSV 行、SQL 片段、API 请求与响应、终端输出、配置键值、UI 文案、指标数值等。
<!-- L0192 | F11 | 字段写法、样例与推理图质量 -->
- **可以**补充真实文件路径（如 `data/dev.jsonl # 完整输入文件，UI 会预览开头`），尤其是原始输入/输出很大时。路径不是替代样例，而是证据入口。
<!-- L0193 | F11 | 字段写法、样例与推理图质量 -->
- **每行一条**，行末用 `# 注释`（或 `// 注释`、`（中文注释）`）说明这一行是什么。
<!-- L0194 | F11 | 字段写法、样例与推理图质量 -->
- `Input`：这个节点实际吃进去的数据/上下文长什么样（短样例 + 可选源文件路径）。
<!-- L0195 | F11 | 字段写法、样例与推理图质量 -->
- `Output`：这个节点实际产出的结果长什么样（短结果片段 + 可选输出文件路径）。
<!-- L0196 | F11 | 字段写法、样例与推理图质量 -->
- 单行过长时截取最有代表性的几行，注释里说明「截断」或总量；不要把整篇文档贴进节点。
<!-- L0197 | F11 | 字段写法、样例与推理图质量 -->
- 若某行是工作区路径，前端会预览文件开头；如果路径失效，下次触碰节点时修正路径或删除它。

<!-- L0199 | F11 | 字段写法、样例与推理图质量 -->
```
<!-- L0200 | F11 | 字段写法、样例与推理图质量 -->
Good Input:
<!-- L0201 | F11 | 字段写法、样例与推理图质量 -->
  - {"paper_id":"1701.001","title":"Attention Is All You Need","year":2017}  # 训练集单条 JSON
<!-- L0202 | F11 | 字段写法、样例与推理图质量 -->
  - pool_layers: [title, abstract, refs, fulltext]  # graph_v2 四层前作池配置
<!-- L0203 | F11 | 字段写法、样例与推理图质量 -->
  - data/dev.jsonl  # 完整输入文件；上面两行是代表性样例
<!-- L0204 | F11 | 字段写法、样例与推理图质量 -->
  - 用户原话：「我不想去找对应的路径，直接在 I/O 里看到例子」  # 需求约束

<!-- L0206 | F11 | 字段写法、样例与推理图质量 -->
Bad Input:
<!-- L0207 | F11 | 字段写法、样例与推理图质量 -->
  - data/dev.jsonl  # 开发集（缺少代表性内容样例）
<!-- L0208 | F11 | 字段写法、样例与推理图质量 -->
  - AGENTS.md、task-tree.md  # 项目文档
<!-- L0209 | F11 | 字段写法、样例与推理图质量 -->
  - 主要输入：语料、配置、代码库

<!-- L0211 | F11 | 字段写法、样例与推理图质量 -->
Good Output:
<!-- L0212 | F11 | 字段写法、样例与推理图质量 -->
  - paper_id,layer,residual\nP001,title,0.12\nP001,abstract,0.31  # residuals.csv 前两行
<!-- L0213 | F11 | 字段写法、样例与推理图质量 -->
  - outputs/run_042/residuals.csv  # 完整输出文件；上面一行是代表性样例
<!-- L0214 | F11 | 字段写法、样例与推理图质量 -->
  - stub-refreshed: 2, prompts-synced: 3  # 一键更新终端摘要
<!-- L0215 | F11 | 字段写法、样例与推理图质量 -->
  - GraphState.Next=N2; NextPlan=实现 I/O 内联样例编辑  # 改树后的焦点

<!-- L0217 | F11 | 字段写法、样例与推理图质量 -->
Bad Output:
<!-- L0218 | F11 | 字段写法、样例与推理图质量 -->
  - outputs/run_042/residuals.csv  # 结果表（缺少代表性结果片段）
<!-- L0219 | F11 | 字段写法、样例与推理图质量 -->
  - 交付分析报告与评估结果
<!-- L0220 | F11 | 字段写法、样例与推理图质量 -->
```

<!-- L0222 | F11 | 字段写法、样例与推理图质量 -->
### `Approach` — keep current

<!-- L0224 | F11 | 字段写法、样例与推理图质量 -->
When the implementation strategy shifts, update `Approach`. Do not leave outdated plans in the node. State **why** this method and what is **out of scope** for the final method (diagnostic-only vs shippable).

<!-- L0226 | F11 | 字段写法、样例与推理图质量 -->
### 推理图原则 — 节点不是清单

<!-- L0228 | F11 | 字段写法、样例与推理图质量 -->
树 = **可审计的方法推理图**（问题→证据→结论→下一步），不是项目目录或 checklist。

<!-- L0230 | F11 | 字段写法、样例与推理图质量 -->
| 字段 | 写什么 |
<!-- L0231 | F11 | 字段写法、样例与推理图质量 -->
|------|--------|
<!-- L0232 | F11 | 字段写法、样例与推理图质量 -->
| `Problem` | **一个子问题**（问句/明确未知），不是脚本名、阶段名 |
<!-- L0233 | F11 | 字段写法、样例与推理图质量 -->
| `Approach` | **为什么**这做法；诊断/评估 vs 可进最终方法的边界 |
<!-- L0234 | F11 | 字段写法、样例与推理图质量 -->
| `Metrics` | 每个指标：**衡量什么** + **怎么测**（不只列名） |
<!-- L0235 | F11 | 字段写法、样例与推理图质量 -->
| `CurrentResult` | **已跑出**的数字、样例、负结果；标注探索/冻结 |
<!-- L0236 | F11 | 字段写法、样例与推理图质量 -->
| `RootCauseAnalysis` | **根因链**（为什么卡住），不只症状 |
<!-- L0237 | F11 | 字段写法、样例与推理图质量 -->
| `NextPlan` | **可直接开工**（如「生成 30 篇 ids-file，跑 v1_4 pilot」） |

<!-- L0239 | F11 | 字段写法、样例与推理图质量 -->
- **分工**：规划→`Approach`/`NextIdea`；实验数字→`CurrentResult`；失败→`RootCauseAnalysis`。
<!-- L0240 | F11 | 字段写法、样例与推理图质量 -->
- **拆分**：一节点一问题；公式/变量按依赖链拆（总式→直接变量→子变量→数据）。
<!-- L0241 | F11 | 字段写法、样例与推理图质量 -->
- **边**：`Label`/`Notes` 写依赖含义——说明什么、错了影响什么、当前结论。
<!-- L0242 | F11 | 字段写法、样例与推理图质量 -->
- **诚实**：负结果必留；探索性/in-sample 明确标注；proxy 指标不能当构念本身；ROOT 保全局，不把当前 bug 分支写成整棵树。
<!-- L0243 | F11 | 字段写法、样例与推理图质量 -->
- **精简**：`Position`/`Size` 不必 Agent 填；不重复整段背景（总览简写、子节点展开）。

<!-- L0245 | F11 | 字段写法、样例与推理图质量 -->
Building or repairing graphs: use skill **`task-tree-grill`** and `skills/task-tree-grill/references/graph-quality.md`.

<!-- L0247 | F12 | 节点和二元边规则 -->
## 4. Node and Edge Rules

<!-- L0249 | F12 | 节点和二元边规则 -->
- **Node IDs**: keep them stable. If you must rename, update all edge endpoints.
<!-- L0250 | F12 | 节点和二元边规则 -->
- **Edge endpoints**: **exactly 2 nodes per edge** (binary edge). Do not create hyperedges with 3+ endpoints. If ROOT relates to many nodes, add one edge per pair or chain dependencies.
<!-- L0251 | F12 | 节点和二元边规则 -->
- **Layout (⇲)**: tree layout uses binary edges only; hyperedges are ignored. Keep the graph compact — avoid ROOT star hyperedges that spread nodes far apart.
<!-- L0252 | F12 | 节点和二元边规则 -->
- **Completion is not focus**: use `Completion` only for coarse completion state. Do not use `active`, `blocked`, or similar fields to express what is being worked on; focus is expressed through `GraphState.Current`/`Next`.
<!-- L0253 | F12 | 节点和二元边规则 -->
- **New subproblem → new node + edge**. Do not cram unrelated work into an existing node.
<!-- L0254 | F12 | 节点和二元边规则 -->
- **Uncertain relationship → edge with `Notes`**. The edge label says what the relationship is; `Notes` says how certain you are, **what breaks if wrong**, and the **current conclusion**.
<!-- L0255 | F12 | 节点和二元边规则 -->
- **Formula / variable chains**: decompose top-down (final formula → direct variables → sub-variables → data/audit). Do not star-link ROOT to every leaf.

<!-- L0257 | F13 | 执行流程分工与审计 -->
### Execution flow scripts (`scripts/`)

<!-- L0259 | F13 | 执行流程分工与审计 -->
- **Authority**: **Execution order** comes from `scripts/project.json` and `scripts/run.json`, not from node ID sort or graph layout.
<!-- L0260 | F13 | 执行流程分工与审计 -->
- **Before writing flow**: follow **§1c Edit-Flow Gate** — Read **`scripts/README.md`** first (mandatory).
<!-- L0261 | F13 | 执行流程分工与审计 -->
- **Relationship vs execution**: `task-tree.md` = node semantics, dependencies, GraphState. `scripts/*.json` = Scratch-style block sequence (hat / task / if / repeat / ref).
<!-- L0262 | F13 | 执行流程分工与审计 -->
- **Folding**: Collapsing a subtree in the graph **does not** change flow scripts.
<!-- L0263 | F13 | 执行流程分工与审计 -->
- **When to edit scripts**: (1) user asks to change the flowchart / execution order; (2) method/design change (`Problem`, `Approach`, node/edge structure, add/remove execution steps, dependency order) requires sync. If you replace an old method with a new method, check the flow in the same turn. **Do not** edit scripts for CurrentResult-only updates, fold/unfold, or canvas layout changes.
<!-- L0264 | F13 | 执行流程分工与审计 -->
- **How to edit**: See **`scripts/README.md`** → modify `blocks` (stable `nodeId` on task blocks) → `PUT /api/flow-script` or write JSON with version backup.
<!-- L0265 | F13 | 执行流程分工与审计 -->
- **Step audit**: Per-task evidence in **`scripts/steps/<nodeId>/latest/`** — UI flow panel Step Inspector; Agent writes after each step (see `scripts/steps/README.md`).
<!-- L0266 | F13 | 执行流程分工与审计 -->
- **Drift check**: `GET /api/flow-script/drift`; sync status via `POST /api/flow-script/sync-status`; reorder via `POST /api/flow-script/rebuild`.

<!-- L0268 | F12 | Markdown schema 与字段语义 -->
## 5. Markdown Schema

<!-- L0270 | F12 | Markdown schema 与字段语义 -->
When creating `task-tree.md` from scratch, use this structure:

<!-- L0272 | F12 | Markdown schema 与字段语义 -->
```markdown
<!-- L0273 | F12 | Markdown schema 与字段语义 -->
# LLM Task Graph

<!-- L0275 | F12 | Markdown schema 与字段语义 -->
> 这个文件是大模型和前端共同维护的任务图。

<!-- L0277 | F12 | Markdown schema 与字段语义 -->
## ROOT - <根目标标题>

<!-- L0279 | F12 | Markdown schema 与字段语义 -->
- Position:
<!-- L0280 | F12 | Markdown schema 与字段语义 -->
- Size:
<!-- L0281 | F12 | Markdown schema 与字段语义 -->
- Completion:
<!-- L0282 | F12 | Markdown schema 与字段语义 -->
- Problem: <要解决的根本问题>
<!-- L0283 | F12 | Markdown schema 与字段语义 -->
- Approach: <整体策略>
<!-- L0284 | F12 | Markdown schema 与字段语义 -->
- Input: <输入>
<!-- L0285 | F12 | Markdown schema 与字段语义 -->
- Output: <输出>
<!-- L0286 | F12 | Markdown schema 与字段语义 -->
- Metrics: <如何判断成功>
<!-- L0287 | F12 | Markdown schema 与字段语义 -->
- Notes:
<!-- L0288 | F12 | Markdown schema 与字段语义 -->
- CurrentResult:
<!-- L0289 | F12 | Markdown schema 与字段语义 -->
- RootCauseAnalysis:
<!-- L0290 | F12 | Markdown schema 与字段语义 -->
- CaseStudy:
<!-- L0291 | F12 | Markdown schema 与字段语义 -->
- NextIdea:
<!-- L0292 | F12 | Markdown schema 与字段语义 -->
- SelectedSkills:

<!-- L0294 | F12 | Markdown schema 与字段语义 -->
## N1 - <节点标题>

<!-- L0296 | F12 | Markdown schema 与字段语义 -->
- Position:
<!-- L0297 | F12 | Markdown schema 与字段语义 -->
- Size:
<!-- L0298 | F12 | Markdown schema 与字段语义 -->
- Completion:
<!-- L0299 | F12 | Markdown schema 与字段语义 -->
- Problem:
<!-- L0300 | F12 | Markdown schema 与字段语义 -->
- Approach:
<!-- L0301 | F12 | Markdown schema 与字段语义 -->
- Input:
<!-- L0302 | F12 | Markdown schema 与字段语义 -->
- Output:
<!-- L0303 | F12 | Markdown schema 与字段语义 -->
- Metrics:
<!-- L0304 | F12 | Markdown schema 与字段语义 -->
- Notes:
<!-- L0305 | F12 | Markdown schema 与字段语义 -->
- CurrentResult:
<!-- L0306 | F12 | Markdown schema 与字段语义 -->
- RootCauseAnalysis:
<!-- L0307 | F12 | Markdown schema 与字段语义 -->
- CaseStudy:
<!-- L0308 | F12 | Markdown schema 与字段语义 -->
- NextIdea:
<!-- L0309 | F12 | Markdown schema 与字段语义 -->
- SelectedSkills:

<!-- L0311 | F12 | Markdown schema 与字段语义 -->
# GraphState

<!-- L0313 | F12 | Markdown schema 与字段语义 -->
- Current: <节点ID>
<!-- L0314 | F12 | Markdown schema 与字段语义 -->
- Next: <节点ID>
<!-- L0315 | F12 | Markdown schema 与字段语义 -->
- NextPlan: <下一步做什么>
<!-- L0316 | F12 | Markdown schema 与字段语义 -->
- Chain: <可选，逗号分隔的节点 ID 执行链>
<!-- L0317 | F12 | Markdown schema 与字段语义 -->
- ChainAutoAdvance: <可选，true 时 Next 完成后自动沿 Chain 推进>
<!-- L0318 | F12 | Markdown schema 与字段语义 -->
- ChainForceNext: <可选，用户强制指定的下一节点>

<!-- L0320 | F12 | Markdown schema 与字段语义 -->
# Edges

<!-- L0322 | F12 | Markdown schema 与字段语义 -->
## E1 - <关系标签>

<!-- L0324 | F12 | Markdown schema 与字段语义 -->
- Endpoints: <节点ID1>, <节点ID2>
<!-- L0325 | F12 | Markdown schema 与字段语义 -->
- LabelOffset:
<!-- L0326 | F12 | Markdown schema 与字段语义 -->
- Label: <边标签>
<!-- L0327 | F12 | Markdown schema 与字段语义 -->
- Notes:
<!-- L0328 | F12 | Markdown schema 与字段语义 -->
```

<!-- L0330 | F12 | Markdown schema 与字段语义 -->
### Node fields reference

<!-- L0332 | F12 | Markdown schema 与字段语义 -->
| Markdown field | Internal key | Purpose |
<!-- L0333 | F12 | Markdown schema 与字段语义 -->
|---------------|-------------|---------|
<!-- L0334 | F12 | Markdown schema 与字段语义 -->
| `Position` | `x, y` on canvas | Set by frontend; leave empty if new |
<!-- L0335 | F12 | Markdown schema 与字段语义 -->
| `Size` | `width, height` | Set by frontend; leave empty if new |
<!-- L0336 | F12 | Markdown schema 与字段语义 -->
| `Completion` | enum text | Coarse completion state: `未开始`, `进行中`, `已完成`, `需重做` |
<!-- L0337 | F12 | Markdown schema 与字段语义 -->
| `Problem` | plain text | What problem this node solves |
<!-- L0338 | F12 | Markdown schema 与字段语义 -->
| `Approach` | plain text | How we plan to solve it |
<!-- L0339 | F12 | Markdown schema 与字段语义 -->
| `Input` | plain text | Data/files/context consumed |
<!-- L0340 | F12 | Markdown schema 与字段语义 -->
| `Output` | plain text | Artifacts produced |
<!-- L0341 | F12 | Markdown schema 与字段语义 -->
| `Metrics` | plain text | How to evaluate success |
<!-- L0342 | F12 | Markdown schema 与字段语义 -->
| `Notes` | plain text | Free-form notes |
<!-- L0343 | F12 | Markdown schema 与字段语义 -->
| `CurrentResult` | plain text | Model-written: what was achieved |
<!-- L0344 | F12 | Markdown schema 与字段语义 -->
| `RootCauseAnalysis` | plain text | Model-written: why things happened |
<!-- L0345 | F12 | Markdown schema 与字段语义 -->
| `CaseStudy` | multi-line | Model-written: concrete cases |
<!-- L0346 | F12 | Markdown schema 与字段语义 -->
| `NextIdea` | plain text | Model or user: suggested next step |
<!-- L0347 | F12 | Markdown schema 与字段语义 -->
| `CodeLoc` | multi-line | Code locations: `path/to/file.js:123 # 说明` per line; UI opens in Cursor/VS Code on click |
<!-- L0348 | F12 | Markdown schema 与字段语义 -->
| `SelectedSkills` | comma-separated IDs | User-set via UI; model reads but does not overwrite |

<!-- L0350 | F12 | Markdown schema 与字段语义 -->
### Edge fields reference

<!-- L0352 | F12 | Markdown schema 与字段语义 -->
| Markdown field | Purpose |
<!-- L0353 | F12 | Markdown schema 与字段语义 -->
|---------------|---------|
<!-- L0354 | F12 | Markdown schema 与字段语义 -->
| `Endpoints` | Comma-separated node IDs |
<!-- L0355 | F12 | Markdown schema 与字段语义 -->
| `LabelOffset` | Pixel offset for edge label position |
<!-- L0356 | F12 | Markdown schema 与字段语义 -->
| `Label` | Human-readable relationship name |
<!-- L0357 | F12 | Markdown schema 与字段语义 -->
| `Notes` | Edge-level notes, uncertainty, constraints |

<!-- L0359 | F12 | Markdown schema 与字段语义 -->
### GraphState fields reference

<!-- L0361 | F12 | Markdown schema 与字段语义 -->
| Field | Purpose |
<!-- L0362 | F12 | Markdown schema 与字段语义 -->
|-------|---------|
<!-- L0363 | F12 | Markdown schema 与字段语义 -->
| `Current` | Node ID being actively worked on |
<!-- L0364 | F12 | Markdown schema 与字段语义 -->
| `Next` | Node ID to work on next (often same as Current) |
<!-- L0365 | F12 | Markdown schema 与字段语义 -->
| `NextPlan` | One sentence: concrete next action on `Next` |
<!-- L0366 | F12 | Markdown schema 与字段语义 -->
| `Chain` | Optional ordered node IDs for Codex/Cursor single-step chain execution |
<!-- L0367 | F12 | Markdown schema 与字段语义 -->
| `ChainAutoAdvance` | When true, advance along `Chain` after `Next` is complete |
<!-- L0368 | F12 | Markdown schema 与字段语义 -->
| `ChainForceNext` | User-forced next node; Agent must apply on next turn then clear |

<!-- L0370 | F12 | Markdown schema 与字段语义 -->
---

<!-- L0372 | F14 | skill routing log -->
## 6. Skill Routing Log

<!-- L0374 | F14 | skill routing log -->
`skill-routing-log.md` tracks whether `SelectedSkills` → actual usage → result forms a closed loop. Append a new entry whenever a skill is selected, used, or explicitly skipped:

<!-- L0376 | F14 | skill routing log -->
Do not log mandatory protocol reads from §1b/§1c by themselves. Reading `task-tree-grill` only because the edit-tree gate requires it is not a skill-routing event.

<!-- L0378 | F14 | skill routing log -->
```markdown
<!-- L0379 | F14 | skill routing log -->
## <日期> - <节点> - <简述>

<!-- L0381 | F14 | skill routing log -->
- SelectedSkills: `<skill_id>`
<!-- L0382 | F14 | skill routing log -->
- Resolved: `<absolute path to SKILL.md>`
<!-- L0383 | F14 | skill routing log -->
- Used: yes | no | partial
<!-- L0384 | F14 | skill routing log -->
- Reason: <why used / why not>
<!-- L0385 | F14 | skill routing log -->
- Result: <what happened>
<!-- L0386 | F14 | skill routing log -->
```

<!-- L0388 | F14 | skill routing log -->
Do not create this file if it does not exist; it is optional. If it exists, keep entries concise.

<!-- L0390 | F14 | skill routing log -->
---

<!-- L0392 | F15 | 版本备份 -->
## 7. Version Backup Rules

<!-- L0394 | F15 | 版本备份 -->
- **When to backup**: only before manual edits to `task-tree.md` by Codex, or before a restore.
<!-- L0395 | F15 | 版本备份 -->
- **When NOT to backup**: the frontend autosaves without creating backups. Do not create backups for routine frontend saves.
<!-- L0396 | F15 | 版本备份 -->
- **Backup filename**: `versions/<YYYYMMDD-HHmmss>_<原因>.md`
<!-- L0397 | F15 | 版本备份 -->
- **After backup**: proceed to edit `task-tree.md` in the same turn.

<!-- L0399 | F15 | 版本备份 -->
---

<!-- L0401 | F16 | 回滚与文件漂移 -->
## 8. Rollback And Drift Rules

<!-- L0403 | F16 | 回滚与文件漂移 -->
Restoring `task-tree.md` changes the authoritative task state, but it does not automatically restore the rest of the filesystem. This creates possible drift.

<!-- L0405 | F16 | 回滚与文件漂移 -->
- **Authoritative state**: `task-tree.md` decides what task exists, what node is current, and what should be done next.
<!-- L0406 | F16 | 回滚与文件漂移 -->
- **Non-authoritative evidence**: existing files, logs, old versions, chat memory, and generated artifacts can inform the next implementation, but they must not override the restored tree.
<!-- L0407 | F16 | 回滚与文件漂移 -->
- **Redo rule**: if `GraphState.NextPlan` asks for work that seems already done in files, perform a fresh verification against the current node. Reuse, rewrite, or delete artifacts only when the current task requires it.
<!-- L0408 | F16 | 回滚与文件漂移 -->
- **Orphan artifact rule**: if a file exists but no current node records it, treat it as an orphan artifact. Mention the mismatch before relying on it.
<!-- L0409 | F16 | 回滚与文件漂移 -->
- **No hidden rollback assumption**: never assume that rolling back the tree also rolled back code, skills, logs, server files, or generated documents.
<!-- L0410 | F16 | 回滚与文件漂移 -->
- **When uncertain**: add a small node or note describing the drift instead of silently merging old work into the current node.

<!-- L0412 | F16 | 回滚与文件漂移 -->
---

<!-- L0414 | F17 | 结束检查清单 -->
## 9. Quick Checklist

<!-- L0416 | F17 | 结束检查清单 -->
Before ending a turn where you changed `task-tree.md`:

<!-- L0418 | F17 | 结束检查清单 -->
- [ ] Version backup created (if manual edit)
<!-- L0419 | F17 | 结束检查清单 -->
- [ ] Touched nodes/edges were refined first; obsolete live content was replaced/deleted, not tombstoned
<!-- L0420 | F17 | 结束检查清单 -->
- [ ] Field budgets are respected, or the reason for exceeding them is explicit
<!-- L0421 | F17 | 结束检查清单 -->
- [ ] Node `CurrentResult` updated with concrete results (numbers, not vague summaries)
<!-- L0422 | F17 | 结束检查清单 -->
- [ ] Node fields follow §3 reasoning-graph rules (why, numbers, field split)
<!-- L0423 | F17 | 结束检查清单 -->
- [ ] Node `Input`/`Output` still accurate
<!-- L0424 | F17 | 结束检查清单 -->
- [ ] `GraphState.Current`/`Next`/`NextPlan` 未被擅自修改（非链式循环时保持用户 UI 设定；链式仅 chain-advance）
<!-- L0425 | F17 | 结束检查清单 -->
- [ ] Edges still valid; new edges added if needed
<!-- L0426 | F17 | 结束检查清单 -->
- [ ] If method/order changed, execution flow was checked and updated or explicitly left unchanged with a reason
<!-- L0427 | F17 | 结束检查清单 -->
- [ ] Rollback/drift mismatch handled if `task-tree.md` was restored
<!-- L0428 | F17 | 结束检查清单 -->
- [ ] `skill-routing-log.md` updated only if a selected/chosen skill was actually involved; mandatory gate reads alone were not logged
<!-- L0429 | F17 | 结束检查清单 -->
- [ ] Told the user which node/edge changed

<!-- L0431 | F17 | 结束检查清单 -->
---

<!-- L0433 | F18 | Agent chain run -->
## 10. Agent Chain Run (Codex / Cursor)

<!-- L0435 | F18 | Agent chain run -->
For **Codex or Cursor Agent** — not the web multi-model panel — run one node per turn along `GraphState.Chain`. Full workflow: skill `skills/task-tree-chain-run/SKILL.md`.

<!-- L0437 | F18 | Agent chain run -->
**Setup:** 节点 **⊕** 加入底部执行链；Next 节点卡片 **「下一步思路」** = 节点 `NextIdea`（每轮 Codex 的执行依据）；左上角 **自动推进** = `ChainAutoAdvance`。`GraphState.NextPlan`（「下一步」）loop **不读**。

<!-- L0439 | F18 | Agent chain run -->
**Each loop tick — mandatory gate**

<!-- L0441 | F18 | Agent chain run -->
1. `GET /api/graph-state/chain-step`
<!-- L0442 | F18 | Agent chain run -->
2. If `shouldStopLoop: true` → run `scripts/chain-loop-stop.ps1 -SoftOnly` (default: do not close IDE)
<!-- L0443 | F18 | Agent chain run -->
3. Else read `stepMarkdown` for `Next` + **Next node's NextIdea**; execute **NextIdea only** (code, shell, edit task-tree). May read full `task-tree.md` when needed. Do not complete multiple Chain nodes in one turn.

<!-- L0445 | F18 | Agent chain run -->
**Hard stop when chain finished:** `llm-task-tree-kit/scripts/chain-loop-stop.ps1 -SoftOnly` (add `-Hard` only if you must kill IDE)

<!-- L0447 | F18 | Agent chain run -->
**APIs:** `GET /api/graph-state/chain-step`, `POST /api/graph-state/chain-advance`

<!-- L0449 | F19 | 跨项目安装 stub -->
<!-- llm-task-tree:begin -->
<!-- L0450 | F19 | 跨项目安装 stub -->
## Task Graph (llm-task-tree)

<!-- L0452 | F19 | 跨项目安装 stub -->
This project uses **`task-tree.md`** at the repository root as shared task state for agents.

<!-- L0454 | F19 | 跨项目安装 stub -->
**Compact current-state rule**

<!-- L0456 | F19 | 跨项目安装 stub -->
`task-tree.md` is the current working graph, not an append-only history log. History lives in `versions/`.

<!-- L0458 | F19 | 跨项目安装 stub -->
- Replace or delete stale content instead of adding tombstones like "deleted on ...".
<!-- L0459 | F19 | 跨项目安装 stub -->
- Before adding text, refine the touched node/edge: remove duplicated, superseded, or process-only notes.
<!-- L0460 | F19 | 跨项目安装 stub -->
- Keep hard budgets: one `Problem`; current-only `Approach` <=4 bullets; `CurrentResult` <=3 facts / 500 chars; `RootCauseAnalysis` <=2 sentences / 350 chars; at most 2 cases; one executable `NextIdea`.
<!-- L0461 | F19 | 跨项目安装 stub -->
- For big-tree cleanup, measure before/after bytes, lines, over-budget fields, and long lines (>240 chars). Touch the current path plus the top 8-15 over-budget nodes; target >=25% reduction in touched-node text and >=30% fewer long lines, unless preserved facts block that.
<!-- L0462 | F19 | 跨项目安装 stub -->
- Parent nodes are indexes, not storage bins: if a node has child/formula nodes, keep only the current conclusion, 2-3 key numbers, and child/file references.
<!-- L0463 | F19 | 跨项目安装 stub -->
- If old text conflicts with the current method, rewrite/delete the old text; do not keep both old and new methods live.
<!-- L0464 | F19 | 跨项目安装 stub -->
- `Input`/`Output` should use 1-5 representative inline sample lines plus optional real file paths; bulky evidence belongs in files that the UI can preview.
<!-- L0465 | F19 | 跨项目安装 stub -->
- Add a new node only for a genuinely separate subproblem with distinct input/output/metrics.
<!-- L0466 | F19 | 跨项目安装 stub -->
- If a method/order change affects execution order, also update `scripts/project.json` or `scripts/run.json`; CurrentResult-only edits usually do not.
<!-- L0467 | F19 | 跨项目安装 stub -->
- Do not over-refine: preserve current measured facts, unresolved risks, user decisions, and active constraints.

<!-- L0469 | F19 | 跨项目安装 stub -->
**Every task — read-only tree context (default)**

<!-- L0471 | F19 | 跨项目安装 stub -->
1. If you need execution focus, read `task-tree.md` and use `GraphState.Current`, `GraphState.Next`, and the **Next node's `NextIdea`** (not only `NextPlan`).
<!-- L0472 | F19 | 跨项目安装 stub -->
2. Treat the tree as authoritative; chat history and orphan files are evidence only.
<!-- L0473 | F19 | 跨项目安装 stub -->
3. **Do not** Read `llm-task-tree/AGENTS.task-tree.md`, tree skills, or `scripts/README.md` unless this turn will **edit** the tree or **edit execution flow** (below).

<!-- L0475 | F19 | 跨项目安装 stub -->
**When you WILL edit the task tree** (write/create/repair `task-tree.md`, `subtrees/*.md`, nodes, edges, or GraphState)

<!-- L0477 | F19 | 跨项目安装 stub -->
Before any write, **must Read in order** (same turn, before editing):

<!-- L0479 | F19 | 跨项目安装 stub -->
1. `llm-task-tree/AGENTS.task-tree.md`
<!-- L0480 | F19 | 跨项目安装 stub -->
2. `llm-task-tree/skills/task-tree-grill/SKILL.md`
<!-- L0481 | F19 | 跨项目安装 stub -->
3. `llm-task-tree/skills/task-tree-grill/references/schema-template.md`

<!-- L0483 | F19 | 跨项目安装 stub -->
Then backup `task-tree.md` to `versions/<timestamp>_<原因>.md` before manual edits (see protocol §7). Follow **all nodes → `# GraphState` → `# Edges`** order.

<!-- L0485 | F19 | 跨项目安装 stub -->
Cursor: `.cursor/rules/llm-task-tree-edit.mdc`

<!-- L0487 | F19 | 跨项目安装 stub -->
**When you WILL edit execution flow** (write `scripts/project.json`, `scripts/run.json`, or `PUT /api/flow-script`)

<!-- L0489 | F19 | 跨项目安装 stub -->
Before any write, **must Read in order** (same turn, before editing):

<!-- L0491 | F19 | 跨项目安装 stub -->
1. **`scripts/README.md`** — schema、块类型、何时改/不改、保存与备份（**执行流程的权威写法**）
<!-- L0492 | F19 | 跨项目安装 stub -->
2. Current **`scripts/project.json`** (and **`scripts/run.json`** if editing run mode)
<!-- L0493 | F19 | 跨项目安装 stub -->
3. Skim **`task-tree.md`** (+ relevant `subtrees/*.md`) for valid **`nodeId`** values

<!-- L0495 | F19 | 跨项目安装 stub -->
Then backup to `scripts/versions/project/` or `scripts/versions/run/` (or use API with default backup). **Execution order lives in scripts, not in node ID sort or graph layout.**

<!-- L0497 | F19 | 跨项目安装 stub -->
Cursor: `.cursor/rules/llm-task-tree-flow-edit.mdc` · Full gate: `llm-task-tree/AGENTS.task-tree.md` §1c

<!-- L0499 | F19 | 跨项目安装 stub -->
**End of task — only if you edited the tree or flow this turn**

<!-- L0501 | F19 | 跨项目安装 stub -->
1. Update the smallest relevant node(s) and/or `blocks`; tell the user what changed.
<!-- L0502 | F19 | 跨项目安装 stub -->
2. For node `Input`/`Output`, paste **inline real content** with `# comment` per line — not bare paths.
<!-- L0503 | F19 | 跨项目安装 stub -->
3. If flow changed, note it in the affected node's `Notes`.

<!-- L0505 | F19 | 跨项目安装 stub -->
**No tree yet**

<!-- L0507 | F19 | 跨项目安装 stub -->
Create from `llm-task-tree/templates/task-tree.starter.md`, or run **task-tree-grill** (Read tree paths above first).

<!-- L0509 | F19 | 跨项目安装 stub -->
**UI**: `llm-task-tree/打开任务图.cmd` → **关系图 | 执行流程** for `scripts/project.json` / `scripts/run.json`.
<!-- L0510 | F19 | 跨项目安装 stub -->
<!-- llm-task-tree:end -->

<!-- L0512 | F20 | 工具调用规则 -->
<!-- llm-task-tree:tool-calling:begin -->
<!-- L0513 | F20 | 工具调用规则 -->
# Tool Calling Rules

<!-- L0515 | F20 | 工具调用规则 -->
When calling tools, follow these rules strictly. They override any conflicting habits from chat training.

<!-- L0517 | F20 | 工具调用规则 -->
## Argument formatting

<!-- L0519 | F20 | 工具调用规则 -->
1. **Omit optional fields you don't need.** Do not send `null`, `""`, `{}`, or `[]` as a placeholder. If a field is optional and you have no value, leave it out of the JSON entirely.

<!-- L0521 | F20 | 工具调用规则 -->
2. **Match the container type exactly.**
<!-- L0522 | F20 | 工具调用规则 -->
- Array fields take JSON arrays: `["a", "b"]`, never `"[\"a\",\"b\"]"` (string), never `{}` (object), never `"foo"` (bare string).
<!-- L0523 | F20 | 工具调用规则 -->
- Single-element arrays still need brackets: `["foo"]`, not `"foo"`.
<!-- L0524 | F20 | 工具调用规则 -->
- Object fields take JSON objects, not arrays or strings.

<!-- L0526 | F20 | 工具调用规则 -->
3. **Strings are raw strings.** Do not wrap values in extra quotes, code fences, or markdown.

<!-- L0528 | F20 | 工具调用规则 -->
4. **Numbers and booleans are unquoted.** `30`, not `"30"`. `true`, not `"true"`.

<!-- L0530 | F20 | 工具调用规则 -->
## Paths and identifiers

<!-- L0532 | F20 | 工具调用规则 -->
5. **File paths, URLs, IDs, and similar fields go to system functions, not chat output.** Never format them as markdown links, never wrap them in backticks, never add explanatory parentheses.

<!-- L0534 | F20 | 工具调用规则 -->
Correct: `"/Users/me/notes.md"`
<!-- L0535 | F20 | 工具调用规则 -->
Wrong: `"[notes.md](notes.md)"`
<!-- L0536 | F20 | 工具调用规则 -->
Wrong: `` "`/Users/me/notes.md`" ``
<!-- L0537 | F20 | 工具调用规则 -->
Wrong: `"/Users/me/notes.md (the notes file)"`

<!-- L0539 | F20 | 工具调用规则 -->
6. **If a tool description says "path", treat it as input to a filesystem call.** No formatting, no decoration.

<!-- L0541 | F20 | 工具调用规则 -->
## Related parameters

<!-- L0543 | F20 | 工具调用规则 -->
7. **When a tool has paired parameters (e.g., offset + limit, start + end, from + to), provide both or neither.** Read the description — if two fields work together, half the pair often produces an error.

<!-- L0545 | F20 | 工具调用规则 -->
## Recovery

<!-- L0547 | F20 | 工具调用规则 -->
8. **If a tool returns a validation error, read the error message carefully and fix only what it complains about.** Do not rewrite the whole call. Do not retry the same arguments.

<!-- L0549 | F20 | 工具调用规则 -->
9. **If a tool returns a "Note:" with a defaulted value, that's informational, not an error.** Continue the task. If the default is wrong, retry with the correct explicit value.

<!-- L0551 | F20 | 工具调用规则 -->
## Tool selection

<!-- L0553 | F20 | 工具调用规则 -->
10. **Use the tool whose description matches your intent most specifically.** Don't reach for `shellCommand` if a dedicated tool exists. Don't reach for `execute_code` for things a single tool call can handle.
<!-- L0554 | F20 | 工具调用规则 -->
<!-- llm-task-tree:tool-calling:end -->
