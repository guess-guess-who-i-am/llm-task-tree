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
- Output: 自动并行实现说明；docs/subtree-parallel/concurrent-agent-isolation-design.zh.md。
- Metrics: 同文件和任务树保留双方结果；超过四个任务并发；追加即时执行；无需审批、测试或审核阶段。
- Notes: 全文与历史结果不截断；项目外路径是直接修改，不在 Git 合并范围内。
- CodeLoc:
  - server/codex-run.js
  - server/codex-coordinator.js
  - server/parallel-worktree.js
  - public/app.js
- CurrentResult: 真实 Git 已验证同文件与任务树合并、即时追加和自动应用；七路并发与完整上下文测试通过。真实模型浏览器全链路和 Mac 安装仍在验证，尚未全部完成。
- RootCauseAnalysis: 写集重叠不必串行；复用同一对话才会冲突，新增任务需分叉历史。项目外直接修改不受 Git 合并保护。
- CaseStudy:
  - 两任务改同一文件和任务树，通过双方对话合并后同时保留结果。
  - 同节点同写集追加任务，从历史对话分叉，原任务未结束也立即执行。
- NextIdea: 完成真实模型浏览器全链路并同步独立 IDE，记录耗时与边界。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges
