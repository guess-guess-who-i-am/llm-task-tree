# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。每个项目一棵独立的树。

## ROOT - <填写你的项目目标>

- Position: 120,120
- Size: 400,520
- Completion: 未开始
- Problem: 这个项目最终要达成什么？
- Approach: 整体策略（可在 Agent 帮助下细化）
- Input: 主要输入：代码库、文档、数据源
- Output: 主要交付物
- Metrics: 如何判断项目成功
- Notes: 第一次使用时，请让 Agent 用 task-tree-grill 或与你对话后拆成 3-7 个节点
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState

- Current: ROOT
- Next: ROOT
- NextPlan: 与 Agent 一起把 ROOT 拆成 3-7 个节点，设置 Current/Next/NextPlan，然后按 llm-task-tree/AGENTS.task-tree.md 逐节点推进。

# Edges

## E1 - 待建立

- Endpoints: ROOT
- LabelOffset:
- Label: 待建立子任务边
- Notes: 拆分子任务后删除或替换本边
