# LLM Task Graph Subtree

> Fold root: N3
> v2 并行试跑包

## N3 - 让 Codex 同步维护任务图
- Position: 2052,950
- Size: 400,420
- Completion: 进行中
- Problem: 自动并行如何复用分支上下文并持续抓住根目标？
- Approach:
  - 继承用户当前配置，兼容分支默认复用旧对话且可改选。
  - 规划、分支、汇总和同步会话可见可进入；用户可按节点持续追加。
  - worker 在独立 worktree 执行，双审核后同步任务树。
  - 长上下文生成短交接包，新代继续旧分支并归档旧thread。
- Input: 当前任务树、本轮目标、用户配置、可审核草案。
- Output: 可追踪的分支上下文、隔离并行、失败重跑和接受后同步。
- Metrics: 分支可改选；接受前主工作区不变；交接可读；连续两轮保持根目标。
- Notes: 机制和回归已通过，长期连续性待真实试跑。
- CodeLoc:
  - server/codex-run.js
  - server/codex-coordinator.js
  - server/parallel-worktree.js
  - public/app.js
- CurrentResult: 已验证90%后自动换代；新代在隔离worktree读取交接包并继续，旧thread归档、输入清理。Codex、协调器、worktree及真实浏览器回归通过；两轮真实业务待验证。
- RootCauseAnalysis: 隔离worktree读不到主目录交接路径，且档案缺少上一代结果；现已投送分支内交接包并保存摘要。
- CaseStudy:
  - case 1: 主目录相对路径 → 新代无法读取 → 投送分支内交接包。
  - case 2: 交接只有文件无结果 → 新代缺少连续性 → 保存上一代结果摘要。
- NextIdea: 用当前配置连续运行两轮真实业务，检查根目标是否保持。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges
