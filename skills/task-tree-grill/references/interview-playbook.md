# Interview Playbook

Use this when the user needs an initial tree, a revised tree, or recovery from a long unclear conversation.

## Question Discipline

Ask one question at a time. Each question must force a concrete graph decision.

Good question shape:

```text
Uncertainty: <what is unknown>
Recommendation: <your proposed answer>
Tree effect: <node/edge/field/GraphState change if accepted>
Question: <single question>
```

Avoid abstract questions such as "What else should we consider?" unless the answer changes a graph field.

## Interview Order

Walk these branches in order. Stop when the graph is actionable.

1. Root objective: what end state should the whole graph serve?
2. Human decision horizon: what must the user judge at a glance?
3. Scope boundary: what is explicitly out of scope for this tree?
4. Major subproblems: what nodes are needed before execution starts?
5. Data flow: what `Input` and `Output` belong to each node?
6. Evaluation: what `Metrics` prove each node is good enough?
7. Relationships: which nodes decompose, depend on, contradict, or provide evidence for others?
8. Skill routing: should any node start with `SelectedSkills`?
9. Execution focus: which node is `Current`, which is `Next`, and what is `NextPlan`?

If the agent is unfamiliar with the codebase area, insert a module-map question before data flow:

```text
Uncertainty: Which modules and documents define this part of the system?
Recommendation: Create a short evidence/module-map node before implementation.
Tree effect: Add a node whose Output is a module/caller/data-flow map, then make implementation depend on it.
Question: Should the next node be a module-map pass before changing code?
```

## When To Inspect Instead Of Ask

Inspect files instead of asking when the answer is likely in:

- `task-tree.md`
- `AGENTS.md`
- `README.md`
- existing docs such as `CONTEXT.md`, ADRs, specs, or issue files
- code that defines the existing workflow
- local skill folders

Then report the inference and ask only if a user decision remains.

## Common Tree-Building Cases

- Vague project: first create ROOT plus 3-5 candidate branch nodes; mark uncertain edges in `Notes`.
- Long conversation: compress the conversation into nodes, but keep only decisions, open questions, evidence, and next actions.
- User says the model drifted: add a node for the drift cause and connect it to the affected task.
- User wants a plan: build nodes for independently executable work, not a linear prose checklist.
- User wants better control: ensure `GraphState`, `CurrentResult`, `RootCauseAnalysis`, and `CaseStudy` are explicit.
