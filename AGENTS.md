# Agent Entry Rules

> [F00] `task-tree.md` is the human-agent working graph. Frozen original and sentence audit: `docs/agent-context-research/prompt-audit/`.

## Always-on invariants

- [F01] `task-tree.md` is compact current state, not history. If removing text cannot change the next action, method, constraint, risk, or completion test, move/drop it. Replace stale methods; history goes to `versions/`, evidence to `scripts/steps/`, durable decisions to documents/ADRs.
- [F05] For execution, read `Current`, `Next`, and Next's `NextIdea`; execute one node or small coherent group. `NextPlan` is a stale-prone user memo and MUST NOT be executed; this overrides older frozen wording.
- [F10] Do not change `GraphState.Current`, `Next`, `NextPlan`, or `ChainForceNext` unless the user explicitly asks, initial-tree setup was confirmed, or chain advancement is active through its API.
- [F16] After a tree restore, the current tree is authoritative. Files, chat, logs, and generated artifacts are evidence only; unrepresented artifacts are drift, not proof of completion.
- [F09] After each independently verifiable result, decision, failure, or blocker, write measured state to the smallest affected node before continuing; finish with node results and user-visible evidence, not process summaries.
- [F06] Load skills progressively: check `SelectedSkills` on Next, then Current; resolve and read only relevant skills, and record actual use when `skill-routing-log.md` exists.
- [F00] Prefer available `task_tree_*` tools: `focus` reads; `write` backs up, validates, syncs flow, and cannot move focus.
- [F13] Tree Markdown stores semantics/edges; `scripts/*.json` stores order. Saves/postflight sync status and minimal evidence; Agent resolves drift. CurrentResult-only edits need no reorder.
- [F22] Node prose defaults to concise Chinese. Keep `LLM`, `token`, `API`, necessary names/IDs/paths/URLs; move complex English terms and all code, JSON, commands, formulas, raw data, and logs to evidence. This overrides frozen inline-sample examples.
- [F23] Anchor work to ROOT and active-stage `Problem`/`Approach`/`Metrics`; derive the node's contribution from tree + latest request, never invented causality. `CurrentResult` must directly answer the user's root or stage goal: preserve that goal's wording, state the verified capability/evidence now present, the remaining gap, and whether the goal can currently be claimed reached. Numbers are optional; keep execution in `NextIdea` and evidence.
- [F24] After successful tree/subtree writes, report each persisted node/field `旧值 → 新值` only from returned `changes`; omit unchanged/protected fields.
- [F25] Active multi-Agent scope overrides [F05]: `latest user > scope > global Next`; only assigned nodes execute/write; keep GraphState global; scoped patches only.

## Mandatory routing table

Load detailed rules only when their trigger fires.

| Function | Trigger | Required source/action |
|---|---|---|
| [F02] field budgets | Writing or refining node fields | MUST read `llm-task-tree/AGENTS.task-tree.md` §0 and §3; enforce with tree validation. |
| [F03] measured big-tree compression | User asks to clean/refine a large tree | MUST read the full protocol §0 and measure before/after bytes, lines, over-budget fields, and long lines. |
| [F04] node cost/method replacement | Adding nodes, splitting parents, replacing a method | MUST read full protocol §0/§4 and preserve stable IDs/valid binary edges. |
| [F07] Edit-Tree Gate | Writing `task-tree.md` or `subtrees/*.md` | MUST read, in order: `llm-task-tree/AGENTS.task-tree.md`; `llm-task-tree/skills/task-tree-grill/SKILL.md`; `llm-task-tree/skills/task-tree-grill/references/schema-template.md`. Then back up the tree before manual edits. |
| [F08] Edit-Flow Gate | Writing `scripts/project.json`, `scripts/run.json`, or flow API state | MUST read `scripts/README.md`, current flow JSON, and valid tree/subtree node IDs; back up before overwrite. |
| [F11] field quality/examples | Writing CurrentResult, RCA, CaseStudy, I/O, Approach, Metrics | MUST follow full protocol §3 subject to [F22]; use short Chinese evidence descriptions plus paths, and keep plans/results/failures in their designated fields. |
| [F12] graph/schema semantics | Creating/repairing nodes, edges, formulas, schema | MUST follow full protocol §3–§5 and the schema reference; one node = one subproblem, one edge = exactly two endpoints. |
| [F14] skill audit log | A selected/chosen skill is used or deliberately skipped | Follow full protocol §6; do not log mandatory gate reads by themselves. |
| [F15] backups | Manual tree restore/edit or flow overwrite | Follow full protocol §7 and `scripts/README.md`; frontend autosave does not create routine backups. |
| [F17] postflight checklist | Ending a turn that changed tree/flow | Run the full protocol §9 checklist and create/update required step evidence. |
| [F18] chain run | `GraphState.Chain` is running or user invokes loop | MUST follow full protocol §10 / chain-run skill; execute only the current Next node's NextIdea and advance only through the API. |
| [F19] distribution/install stub | Packaging or installing the task-tree kit | Use `llm-task-tree-kit/templates/AGENTS.merge.md`; the short merge block is not the canonical full protocol. |
| [F21] core-state gate | Large/noisy tree or size warning | Load `llm-task-tree/skills/task-tree-core-state/SKILL.md`; classify retain/move/drop against `Next + NextIdea` and pass the total-size gate. |
| [F22] node language/code gate | Writing node prose | MUST follow `llm-task-tree/AGENTS.node-writing.md`; use concise Chinese and move code/raw samples/complex English to evidence; enforce with tree validation. |
| [F23] purpose and hallucination gate | Planning work or writing results | Read ROOT plus the active stage's `Problem`/`Approach`/`Metrics`; preserve user-stated goals, verify current capability and completion from evidence, and write the remaining gap plus whether the goal can be claimed reached. Keep goal status separate from concrete execution. |
| [F24] tree change receipt | Tree/subtree write succeeds | Report each persisted node/field old/new value from returned `changes`; grouping cannot replace actual differences. |
| [F25] multi-Agent scope | Coordinator/env/`scopeId` | Use assigned target/writable nodes only; scoped focus/write rejects cross-node writes; no scope keeps [F05]. |

## Tree and flow completion contract

- [F09] At each work-unit checkpoint, refine only the smallest relevant node/edge, report it, and do not defer maintenance to turn end.
- [F13] After a completed flow task, write `scripts/steps/<nodeId>/latest/step.json` and `report.zh.md` following `scripts/steps/README.md`.
- [F17] If Problem, Approach, structure, dependencies, or order changed, check flow drift that turn and preserve unresolved drift.
- [F17] After writing a tree/subtree, run `llm-task-tree/check-tree-compact.ps1` on changed paths. Non-zero blocks completion: rewrite semantically until it passes; never mechanically truncate facts. Codex Stop hooks enforce this.
- [F01] Keep measured facts, unresolved risks, user decisions, and active constraints; remove timestamps, abandoned alternatives, tombstones, duplicate process notes, and raw output.

## Tool calling rules

- [F20] Omit unused optional arguments/empty placeholders; match schema types exactly; pass raw paths/URLs/IDs; provide both required-pair members or neither; on validation errors fix only the reported argument; prefer the most specific tool.

## Preservation and audit

- [F00] Frozen original: `docs/agent-context-research/prompt-audit/AGENTS.original.20260710.md`.
- [F11] Every original nonblank line and every parsed statement/structure unit is labeled in `AGENTS.annotated.md` and `statement-map.tsv`.
- [F02]–[F20] Original coverage is verified by `node scripts/verify-agent-prompt-coverage.mjs`; [F21]–[F25] are later overlays.
- The detailed task-tree protocol remains `llm-task-tree/AGENTS.task-tree.md`; this short entry routes to it rather than replacing its behavior.
