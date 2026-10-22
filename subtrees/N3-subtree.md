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
- CurrentResult: 本机发行包与全局安装版已同步，5518和5505空闲重启后运行版本一致；源码完整回归739项、全局安装版48项及插件6项检查通过，服务升级与崩溃恢复实测通过。194医生任务仍待实际验收；模型与窗口配置未改。证据见docs/local-runtime-update-20261022.zh.md。
- RootCauseAnalysis: 检查者未继承执行者的篇幅提示模式，定点回写被既有整树超额拒绝；搜索命令又返回约3.3MB历史文字，令新会话膨胀到约209万估算token。现已统一各角色配置，并将大命令输出完整落盘供按需读取，不截断、不重复执行。
- CaseStudy:
  - 两任务改同一文件和任务树，通过双方对话合并后同时保留结果。
  - 同节点同写集追加任务，从历史对话分叉，原任务未结束也立即执行。
- NextIdea: 核对两节点恢复后的实际回写和最终验收，若失败按首个真实错误定位，不重做已完成成果。
- SelectedSkills: codex:skill-creator

# GraphState

- Current: N3
- Next: N3
- NextPlan: v2 findings 已完成；可选 sync-stub 或真实任务试跑 AGENTS 协议

# Edges
