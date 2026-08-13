# Rollback And Drift

Use this when the user restored `task-tree.md`, says the tree is out of sync, or files/logs mention work that is missing from the current tree.

## Rule

`task-tree.md` is authoritative. Files, logs, versions, and chat memory are evidence only.

## Procedure

1. Read the current `task-tree.md`.
2. Identify `GraphState.Current`, `GraphState.Next`, and `GraphState.NextPlan`.
3. Compare only artifacts relevant to the current node.
4. State the mismatch in one sentence.
5. Do not delete orphan artifacts automatically.
6. Reuse an orphan artifact only after verifying it satisfies the current node's fields.
7. If the mismatch matters, add or update the smallest node/edge that records the drift.
8. Set `NextPlan` to redo, verify, or clean up the next concrete node.

## Examples

- Existing skill file but no node records it: treat the skill file as a draft, not as completed work.
- Log says a previous node was done but the restored tree lacks that node: the log is audit evidence only.
- Code already contains a feature but `NextPlan` asks to implement it: verify the behavior against current metrics; do not skip.

## What To Write In The Tree

Use `RootCauseAnalysis` for why the drift happened:

```text
task-tree.md was restored, but the filesystem was not transactionally restored; the artifact persisted outside the task state.
```

Use `CaseStudy` for concrete examples:

```text
case 1: task-tree.md lacks N5 but skills/task-tree-grill exists -> treating the file as completed work would override the restored tree -> verify it as a draft.
```
