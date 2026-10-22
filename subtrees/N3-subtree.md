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
- Approach: 可分离且需分别分析、实现或撰写的成果默认尽早分工；微小机械修改或真实不可拆任务单人。Worker独立Git工作区、继续拆大分支，完成即整合待验收；最后一位检查者核对整体目标和接口，同会话修复复验，父执行者不续接。分支批量通信、独立压缩并共享必要输入。
- Input: 现有自动并行源码、任务树状态、官方工程实践和用户并发方案。
- Output: 超长执行修复：docs/execution-stall-20261020.zh.md；检查长尾：docs/review-critical-path-20261019/README.zh.md；194启动：docs/remote-git-inventory-20261020.zh.md；网络与验收：docs/remote-network-20261020.zh.md。
- Metrics: 双节点请求实际重叠、结果均落盘且同字段争用不丢失；多 Worker 按就绪依赖推进；安装版实测。
- Notes: 保留全局Hook和适用方法；失败保留成果但不标成功，并报告根因。流程仍为N3任务块，无需改变项目顺序。
- CodeLoc:
  - server/codex-run.js
  - server/codex-coordinator.js
  - server/parallel-worktree.js
  - public/app.js
- CurrentResult: 已修复验收依赖误扩大、直接执行范围丢失、深层节点路由及流错误空续接；760项完整回归通过，本机与194均已更新。原机构节点仅续验收，4分9秒完成并合入报告及5项节点字段，未改业务代码或实测业务权限；未知依赖仍保守检查，13轮模型往返尚有优化空间。
- RootCauseAnalysis: 未知命令依赖扩大到全项目，直接执行又未接收和保存验收范围，无关并行改动反复作废检查；深层节点路由和交付传递不一致增加重查。网关流内错误还被当成普通续接，空重试不断增长上下文。
- CaseStudy:
  - 两任务改同一文件和任务树，通过双方对话合并后同时保留结果。
  - 同节点同写集追加任务，从历史对话分叉，原任务未结束也立即执行。
- NextIdea: 根据原机构任务的13轮验收轨迹定位可减少的重复读取与模型往返，保持完整方法和验收质量；不重跑已完成业务分析或擅自启动其他节点。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges
