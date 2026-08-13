# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。
## BG - 让人类持续看懂并控制大模型任务
- Position: 40,40
- Size: 0,720
- Completion: 进行中
- Problem: 如何把模型隐性上下文变成人类可快速理解、可修正且不会随迭代失控的共享状态？
- Approach:
  - 背景树只保存稳定问题、用户决策、长期约束和证据入口。
  - 方法方案、实验结果和执行状态分别进入方法树、实验树和 scripts。
  - 其它树通过路径引用背景节点，不复制背景全文。
- Input:
  - `用户痛点：跟不上模型思路；不知道当前焦点、偏航和卡点。`  # 根问题
  - `task-tree.md`  # 当前方法迭代树
- Output: `30 秒内理解：为什么做、约束是什么、哪些事实长期有效。`  # 背景树职责
- Metrics: 新参与者只读本树，30 秒内能说出根问题、3 个约束和方法树入口。
- Notes: 本树不进入 `scripts/project.json`，也不保存代码执行日志。
- CodeLoc:
- CurrentResult: 已确认任务树的根价值是外置模型上下文；单树膨胀会反过来破坏“30 秒可读”目标。
- RootCauseAnalysis: 背景、方法、产品实现和执行证据混在一棵树时，不同生命周期的信息会相互污染；稳定背景应低频维护并按需加载。
- CaseStudy:
- NextIdea: 只在根问题、用户长期决策或稳定约束变化时更新本树。
- SelectedSkills:

## B1 - 人类可见性问题
- Position: 597,54
- Size: 541,495
- Completion: 已完成
- Problem: 用户为什么会跟不上大模型的工作思路？
- Approach: 记录可观察症状和稳定需求，不记录某次 UI 或 Prompt 的临时实现。
- Input: `症状：长对话后不知道做到哪里、为什么改方向、哪些结论已失效。`  # 用户体验
- Output: `需要可见的 Current / Next / 根因 / 证据 / 风险。`  # 稳定需求
- Metrics: 用户无需重读聊天即可判断焦点、阻塞和下一步。
- Notes:
- CodeLoc:
- CurrentResult: 核心需求不是“保存更多内容”，而是让当前有效状态可见并允许用户纠偏。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## B2 - 上下文容量约束
- Position: 1152,40
- Size: 0,720
- Completion: 已完成
- Problem: 为什么不能把全部历史、规则和证据始终放入模型上下文？
- Approach: 采用有限工作上下文、按需检索和外部归档；关键规则前置。
- Input:
  - `Lost in the Middle：长上下文中部信息利用下降。`  # 位置偏差证据
  - `MemGPT：主上下文与外部存储分层换入。`  # 分层记忆证据
  - `Reflexion：长期经验限制为少量提炼反思。`  # 经验压缩证据
- Output: `短入口 + active method tree + 按需背景树 + versions/step evidence`  # 上下文结构约束
- Metrics: 默认上下文下降 >=60%，同时关键功能覆盖率保持 100%。
- Notes: 论文与精读位于 `docs/agent-context-research/`。
- CodeLoc:
- CurrentResult: 原 AGENTS 36,299 bytes 已改为 5,950 bytes 路由入口；完整协议和逐句功能账本仍保留。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## B3 - 控制权与审计约束
- Position: 1708,40
- Size: 0,720
- Completion: 已完成
- Problem: 哪些状态必须由用户控制，哪些维护可以自动化？
- Approach: 用户控制 GraphState 焦点和方法决策；系统自动检查版本、字段预算、flow drift 与 step evidence。
- Input:
  - `GraphState.Current/Next/NextPlan 由任务图 UI 指定。`  # 人类控制面
  - `scripts/project.json + scripts/steps/`  # 执行与证据面
- Output: `用户决定做什么；postflight 检查是否完整写回。`  # 权责边界
- Metrics: 自动化不得擅改用户焦点；实质任务树/step 写回率目标 >=95%。
- Notes:
- CodeLoc:
- CurrentResult: 确认“不擅改 GraphState”不是不更新树的根因；缺少任务结束 hook 才是维护失效点。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState
- Current: BG
- Next: BG
- NextPlan: 背景树保持低频维护；方法变化请切换到 method 树。

# Edges


