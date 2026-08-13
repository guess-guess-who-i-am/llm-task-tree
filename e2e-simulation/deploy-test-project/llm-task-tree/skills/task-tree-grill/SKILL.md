---
name: task-tree-grill
description: Build or revise a Markdown-backed task graph through one-question-at-a-time clarification. Use when the user wants to start a new task tree, recover clarity after a long conversation, clarify a vague project before execution, turn discussion into task-tree.md nodes and edges, decide Current/Next/NextPlan, select skills for the next node, or handle task-tree.md rollback/drift before continuing work.
---

# Task Tree Grill

Use this skill to establish or repair `task-tree.md` before execution. The output is not a prose summary; it is a visible task graph that a human can inspect, edit, and use to steer the next agent turn.

`task-tree.md` is the authority. If chat history, existing files, logs, or generated artifacts disagree with the current tree, treat them as evidence only. Do not skip a node because an artifact already exists.

## Core Loop

Interview the user one question at a time. Do not ask a batch of questions.

For every question:

1. State the concrete uncertainty.
2. Give your recommended answer.
3. Explain what changes in the tree if the user accepts it.
4. Wait for the user before moving to the next unresolved branch.

If the answer can be discovered from files, inspect the files instead of asking. Use questions only for decisions that change a node, edge, field, `GraphState`, or skill selection.

## Workflow

1. Read `task-tree.md` at the project root if it exists, then read `AGENTS.md` and `llm-task-tree/AGENTS.task-tree.md` when present.
2. If the tree was restored or conflicts with files, follow [rollback-drift.md](references/rollback-drift.md).
3. If the user is starting or reframing a broad task, follow [interview-playbook.md](references/interview-playbook.md).
4. Write or update the smallest useful graph using [schema-template.md](references/schema-template.md).
5. Check the result against [graph-quality.md](references/graph-quality.md).
6. Set `GraphState.Current`, `GraphState.Next`, and an executable one-sentence `GraphState.NextPlan`.
7. Tell the user which node or edge changed.

## Default Tree Shape

Prefer 3-7 nodes for an initial tree:

- `ROOT`: the user's actual end state.
- 1-3 decomposition nodes for major subproblems.
- 1 node for evidence/data/inputs when that is nontrivial.
- 1 node for execution protocol or evaluation when the user is mainly worried about drift, correctness, or control.

Add more nodes only when the user's problem already has clear branches. Do not execute the whole tree while building it.

## Stop Condition

Stop interviewing and write/update the graph when:

- the root objective is clear
- at least one execution path exists
- `Current`, `Next`, and `NextPlan` are set
- the next node has enough `Input`, `Output`, and `Metrics` to execute
- unresolved uncertainty is visible in `Notes` or an edge, not hidden in chat

Then update `task-tree.md` with a version backup if editing manually.
