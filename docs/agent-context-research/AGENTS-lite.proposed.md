# Agent Entry Rules

## Project map

- `task-tree.md`: current active method graph and focus only.
- `graphs/registry.yaml`: optional background/architecture/experiment graphs; load on demand.
- `llm-task-tree/AGENTS.task-tree.md`: full tree-writing protocol; read only before writing a tree.
- `scripts/README.md`: execution-flow schema; read only before editing flow JSON.
- `scripts/steps/<nodeId>/latest/`: evidence for completed flow steps.

## Start

1. Read `task-tree.md` only when task focus is needed; use `GraphState.Next` and that node's `NextIdea`.
2. Read selected skills only when relevant. Do not load all skills or all background graphs.
3. Execute one node or one small coherent group, not the whole graph.

## Boundaries

- Preserve user changes and unrelated worktree edits.
- Do not change `GraphState.Current`, `Next`, or `NextPlan` unless explicitly asked or chain-advance is active.
- Do not store process logs, abandoned methods, raw tool output, or full documents in live nodes.
- Use `versions/` for history, `scripts/steps/` for evidence, and ADRs for durable decisions.

## Before writing task trees

Read, in order:

1. `llm-task-tree/AGENTS.task-tree.md`
2. `llm-task-tree/skills/task-tree-grill/SKILL.md`
3. `llm-task-tree/skills/task-tree-grill/references/schema-template.md`

Back up the tree, edit the smallest relevant node/edge, and run tree validation.

## Before writing execution flow

Read `scripts/README.md` and the current flow JSON. Back it up, keep valid node IDs, and write/update the corresponding step evidence.

## Done means

- requested artifact or change exists;
- relevant tests/checks pass;
- current node contains measured results, not a process summary;
- step evidence exists for a completed flow task;
- method/edge changes have no unresolved flow drift.

