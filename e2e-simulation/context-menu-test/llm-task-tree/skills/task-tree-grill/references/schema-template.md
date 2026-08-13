# Schema Template

Use this when creating or updating `task-tree.md`.

## Full Markdown Skeleton

```markdown
# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。

## ROOT - <根目标标题>

- Position:
- Size:
- Completion:
- Problem: <要解决的根本问题>
- Approach: <整体策略>
- Input: <输入>
- Output: <输出>
- Metrics: <如何判断成功>
- Notes:
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N1 - <节点标题>

- Position:
- Size:
- Completion: 未开始
- Problem:
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState

- Current: <节点ID>
- Next: <节点ID>
- NextPlan: <下一步做什么>

# Edges

## E1 - <关系标签>

- Endpoints: <节点ID1>, <节点ID2>
- LabelOffset:
- Label: <边标签>
- Notes:
```

## Field Guidance

- `Position` and `Size`: leave empty for new nodes unless preserving frontend layout.
- `Completion`: use `未开始`, `进行中`, `已完成`, or `需重做`.
- `Problem`: write the unresolved question or task.
- `Approach`: write the current best plan, not a generic method.
- `Input`: list concrete files, data, user decisions, APIs, or context.
- `Output`: list the artifact, decision, code change, document, or graph state produced.
- `Metrics`: define observable success criteria.
- `Notes`: include uncertainty, assumptions, rollback drift, or edge ambiguity.
- `CurrentResult`: model-written result after work is done.
- `RootCauseAnalysis`: model-written cause when confusion, drift, or design changes occur.
- `CaseStudy`: compact examples in `case N: situation -> mistake -> lesson` form.
- `NextIdea`: optional suggestion for the node's next step.
- `SelectedSkills`: comma-separated IDs confirmed by the user or UI.

## GraphState Guidance

`Current` is the node most recently or actively worked on.

`Next` is the node the next agent turn should execute.

`NextPlan` must be a single concrete action. It should include the expected output when possible.
