# Graph Quality

Use this before writing or after revising `task-tree.md`.

## Quality Criteria

A good task tree lets the user answer these in 30 seconds:

- What is the root objective?
- Where is the agent currently working?
- What will happen next?
- Which facts, files, or decisions feed the next node?
- What output should the next node produce?
- How will the user know the node is good enough?
- What is uncertain, risky, or drifted?
- Which skills, if any, should be used next?
- Which existing artifact should be opened instead of duplicated in the node text?

## Node Criteria

Each non-root node should have:

- `Problem`: one unresolved problem or task, not a bundle.
- `Approach`: the current best method, including key constraints.
- `Input`: concrete files, data, user decisions, APIs, examples, or context consumed.
- `Output`: concrete artifact, decision, code change, document, UI state, or graph update.
- `Metrics`: observable pass/fail or quality criteria.
- `Completion`: `未开始`, `进行中`, `已完成`, or `需重做`; do not use it for focus.
- `Notes`: uncertainty, assumptions, drift, or relationship ambiguity.

Leave `CurrentResult`, `RootCauseAnalysis`, and `CaseStudy` empty for new nodes unless there is known execution history.

Do not paste long documents, diffs, or conversation summaries into node fields. Reference existing artifacts by path or URL and put only the decision-relevant summary in the node.

## Edge Criteria

Use edges for:

- decomposition
- dependency
- evidence
- uncertainty
- alternatives
- conflict
- rollback/drift relationship
- skill routing relationship

If the relationship is uncertain, still create the edge and put the uncertainty in `Notes`.

## Anti-Patterns

- A node whose `Problem` contains multiple unrelated tasks.
- A graph that is only a linear checklist when dependencies are actually branching.
- A graph that hides uncertainty in chat instead of node or edge `Notes`.
- A graph that duplicates whole PRDs, handoff docs, ADRs, or source files instead of referencing them.
- `NextPlan` such as "continue" or "improve this"; it must be executable.
- Marking work as complete because files exist, when the current tree was restored and does not record that work.
- Using `Completion` to represent active focus; use `GraphState.Current` and `GraphState.Next`.

## Repair Moves

- Split an overloaded node into children and connect with a decomposition edge.
- Add an evidence node when inputs are unclear or scattered.
- Add a module-map node when the agent is unfamiliar with a code area; its output should be a map of relevant modules, callers, docs, and data flow.
- Add a drift node when files and tree disagree.
- Add a skill-routing node or `SelectedSkills` when the next step depends on specialized workflow.
- Change `GraphState.NextPlan` before editing code if the current plan is too broad.
