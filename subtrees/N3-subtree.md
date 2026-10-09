# Subtree Work Site

> 本 Agent 的唯一权威任务文件内容。只改此子树 md 及对应代码。

# LLM Task Graph Subtree

> Fold root: N3
> v2 并行试跑包

## N3 - 让 Codex 同步维护任务图
- Position: 2052,950
- Size: 400,420
- Completion: 进行中
- Problem: 允许多个 Worker 同时修改代码与任务树，冲突由对话协商合并，结果自动应用并只展示进度。
- Approach:
  - 完整上下文一次规划；就绪任务全部并发；写集仅作提示。
  - 独立工作树执行；真实冲突续接双方对话；完成自动应用。
- Input: 现有自动并行源码、任务树状态、官方工程实践和用户并发方案。
- Output: 工程入口与并行链路修复、真实六路计时及使用方法；docs/parallel-pipeline-repair.zh.md。
- Metrics: 同文件和任务树保留双方结果；超过四个任务并发；追加即时执行；无需审批、测试或审核阶段。
- Notes: 真实六路提交Hook用时49–56秒，工具连接0.09–0.21秒，Git合并单次不超过32毫秒；本轮未优化全局Hook。
- CodeLoc:
  - server/codex-run.js
  - server/codex-coordinator.js
  - server/parallel-worktree.js
  - public/app.js
- CurrentResult: 工程入口与规划、子树、并发和自动合入链路已修复；真实DeepSeek六路并发169.7秒完成，原树保留。复杂代码拆分质量与稳定提速仍未验证；证据：docs/parallel-pipeline-repair.zh.md。
- RootCauseAnalysis: 旧入口指向空工作区，Git未初始化、执行树未落盘，且来源树、隔离目录与模型失败状态未贯通。现在分支独立落盘、目录显式绑定、失败不提交，Git只合真实项目改动。
- CaseStudy:
  - 两任务改同一文件和任务树，通过双方对话合并后同时保留结果。
  - 同节点同写集追加任务，从历史对话分叉，原任务未结束也立即执行。
- NextIdea: 在工程N3提交一次真实代码改进，观察拆分质量并定位全局提交Hook耗时。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges
