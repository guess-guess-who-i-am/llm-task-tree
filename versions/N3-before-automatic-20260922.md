# Subtree Work Site

> 本 Agent 的唯一权威任务文件内容。只改此子树 md 及对应代码。

# LLM Task Graph Subtree

> Fold root: N3
> v2 并行试跑包

## N3 - 让 Codex 同步维护任务图
- Position: 2052,950
- Size: 400,420
- Completion: 进行中
- Problem: 多个 Agent 如何并发修改代码和运行服务，又不互相覆盖或污染共享状态？
- Approach:
  - Supervisor 先生成任务 DAG、独占写集和资源租约；同一写集改为串行依赖。
  - Worker 使用 detached worktree 和独立端口、数据库、容器、缓存及浏览器目录。
  - 确定性队列串行集成；集成 Agent 只修复语义兼容并重跑双方验收。
  - 接受与 8898 发布分别加全局锁、基线校验、预检和失败回滚。
- Input: 现有自动并行源码、任务树状态、官方工程实践和用户并发方案。
- Output: 并发隔离设计与故障注入门禁；docs/subtree-parallel/concurrent-agent-isolation-design.zh.md。
- Metrics: 写集和共享资源零越界；并发接受最多一个成功；发布失败不影响 8898 旧版本，成功可追溯到接受提交。
- Notes: 先完成 P0 资源租约、接受锁和发布状态机；集成 Agent 冲突修复置于 P1。
- CodeLoc:
  - server/codex-run.js
  - server/codex-coordinator.js
  - server/parallel-worktree.js
  - public/app.js
- CurrentResult: 已核实现有 detached worktree、独占写集、4路调度、串行集成和接受前文件校验；本轮4组回归全通过。尚无运行资源租约、跨运行接受锁和8898发布状态机，故只能保证代码结果在接受前隔离，不能声称多 Agent 已完全互不干扰，根目标未达成。
- RootCauseAnalysis: 工作树隔离只能处理文件系统，不能隔离端口、数据库、缓存和发布环境；现有写集检查也不能替代跨运行的接受与发布锁。
- CaseStudy:
  - case 1: 两任务改同一文件 → 规划期拒绝或串行，不把可预见冲突留给集成 Agent。
  - case 2: 两任务改不同文件但共用数据库 → Git 无冲突仍会互扰，必须分配资源命名空间。
- NextIdea: 先实现资源租约注册表与 Worker 环境清单，并用双 Worker 端口、数据库及崩溃回收实验验证。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges