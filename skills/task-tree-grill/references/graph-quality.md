# Graph Quality

Use before writing or after revising `task-tree.md`. Full field rules: `AGENTS.task-tree.md` §3.

## 30-second test

Can the reader answer: root objective, current focus, **why** we're doing it, **evidence/numbers** so far, **executable** next step, what's uncertain, and what's diagnostic-only vs shippable?

## Node = one subproblem

| Field | Must answer |
|-------|-------------|
| `Problem` | One **question or unknown** — not a script, phase, or file task |
| `Approach` | **Why** this method; boundary (diagnostic vs final method) |
| `Input`/`Output` | **Inline** samples, numbers, conclusion snippets + `# comment`; paths supplement only |
| `Metrics` | **What reality** each metric measures + **how to test** |
| `CurrentResult` | **Goal-relative status**: user goal, verified present capability/evidence, remaining gap, and whether the goal can be claimed reached; numbers are optional — not「已有方向性进展」 |
| `RootCauseAnalysis` | **Root-cause chain** when stuck or design changed |
| `NextPlan` | **Directly executable** (counts, command, pilot) — not「继续优化」 |

**Field split:** plan → `Approach`/`NextIdea`; measured facts → `CurrentResult`; failure → `RootCauseAnalysis`.

**Split when:** multiple unrelated problems, long formula blocks, or N2a-sized bundles → child nodes.

**Formula nodes:** chain dependencies (final → direct vars → sub-vars → data). Each symbol: real meaning, source, failure mode.

## Edges

Binary only. `Label`/`Notes`: **dependency meaning** — what this link asserts, what breaks if wrong, current conclusion. Not just「支撑/实现」.

Types: decomposition, dependency, evidence, uncertainty, alternatives, conflict, drift, skill routing.

## Anti-patterns

- Path-only I/O; vague CurrentResult; empty Metrics names without test meaning
- Proxy metric treated as the construct (e.g. clarity/coverage for novelty)
- Exploratory/in-sample wins written as method success
- ROOT star to all leaves; hyperedges; checklist when graph should branch
- Duplicating whole PRDs/diffs in nodes (use inline **excerpt**, not full doc)
- Hiding uncertainty in chat instead of `Notes`/edge
- `Completion` for focus (use `GraphState.Current`/`Next`)
- Current bug branch written as the whole project

## Repair moves

- Split overloaded node → children + decomposition edge
- Add evidence node when inputs scattered
- Add drift node when files ≠ tree
- Narrow `NextPlan` before coding if too broad
- Touch stale path-only I/O when editing a node (rewrite inline per §3)
