---
name: task-tree-core-state
description: Keep a Markdown task tree focused on decision-relevant current state. Use when writing or refining task-tree.md/subtrees, when a tree is too large or polluted by history or artifact details, when completed work must be distilled into parent insights, or when compact/postflight gates report size or stale-state problems.
---

# Task Tree Core State

Treat the live tree as working memory, not an audit log. Preserve enough state to choose and verify the next action; move recoverable detail to evidence files.

## Core-State Gate

Use `GraphState.Next` and that node's `NextIdea` as the query. For every candidate statement, apply this deletion test:

> If removed, could the next Agent choose a different method, repeat a disproved action, violate a live constraint, miss an unresolved risk, or lose the completion test?

Classify privately; do not write these labels into the tree:

- **Retain**: current problem/method, user decision, active constraint, unresolved risk, up to three decision-changing results, one executable `NextIdea`, and short evidence pointers.
- **Move**: useful but recoverable process, stable architecture/background, raw output, file inventories, cases, and implementation detail. Put these in the appropriate tree, ADR, or `scripts/steps/`; keep one pointer only when needed.
- **Drop**: duplicate, superseded, resolved, timestamped, or process-only text already recoverable from `versions/`.

Retained prose defaults to concise Chinese. Familiar terms such as `LLM`, `token`, `API`, exact names, IDs, paths, and URLs may remain. Move code, JSON, commands, formulas, raw data, logs, and complex English domain terminology to evidence files.

## Workflow

1. Read focus with `task_tree_focus`; read the Next node and only the dependencies needed for its `NextIdea`.
2. Measure the affected tree with `task_tree_check_compact`. For a large cleanup, record bytes, lines, over-budget fields, and long lines before editing.
3. Refine the current/Next path and the largest noisy nodes. Rewrite fields as current state; never append a summary under stale text.
4. For a completed leaf, retain `Result + reusable Insight + ArtifactRef`. Propagate only an insight that constrains sibling/future work; never copy the leaf result into its parent.
5. Write through `task_tree_write` so backup, focus protection, compact checks, and deterministic flow status sync stay active.
6. Re-run `task_tree_check_compact`. An active method tree must remain within 12 KiB; semantic recovery matters more than maximal compression.

Do not change GraphState focus, node IDs, edges, or execution order merely to reduce size. If structure or order truly changes, follow the repository's tree/flow gates.
