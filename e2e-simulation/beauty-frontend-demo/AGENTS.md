# Agent Instructions

See also the task graph protocol block below and the full rules in `llm-task-tree/AGENTS.task-tree.md`.
<!-- llm-task-tree:begin -->
## Task Graph (llm-task-tree)

This project uses **`task-tree.md`** at the repository root as shared task state for agents.

**Start of every substantive task**

1. Read the latest `task-tree.md` and locate `GraphState.Current`, `GraphState.Next`, and `GraphState.NextPlan`.
2. Treat the tree as authoritative task state. Chat history and orphan files are evidence only.
3. Read the full protocol in **`llm-task-tree/AGENTS.task-tree.md`** (backup rules, field updates, rollback/drift, skills).

**End of every substantive task**

1. Backup `task-tree.md` to `versions/` before manual edits (see protocol §7).
2. Update the smallest relevant node(s) and `GraphState`; tell the user which node changed.
3. Do not cram unrelated work into one node; add nodes and edges when the problem branches.

**No tree yet**

Create `task-tree.md` from `llm-task-tree/templates/task-tree.starter.md`, or use the **`task-tree-grill`** skill in `llm-task-tree/skills/` to interview and build the graph before large implementation work.

**UI**: double-click `llm-task-tree/打开任务图.cmd` to open the task graph editor.
<!-- llm-task-tree:end -->

