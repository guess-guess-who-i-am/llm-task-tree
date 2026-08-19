# N3 - 让 Codex 同步维护任务图

## 当前目标达成状态

多 Agent 已不再默认共用全局 `GraphState.Next`，自动并行也已形成“开始审核一次、结束审核一次”的完整闭环。规划和结束审核现在同时核对 ROOT、阶段、本轮及历史目标锚点；仅方向一致、有实际推进且长期目标连续的结果可接受。真实 Git、桌面/手机和发行安装回归通过；长期真实业务的持续正确性仍不能宣称达到。

## 已落地

- 执行范围保存目标节点、可写节点、写集、任务说明和状态；全局 Current/Next 保留为人类项目主视角。
- `task_tree_focus` 有范围时返回 `assignedNodes`；`task_tree_write` 由服务端校验节点权限，范围内禁止整树覆盖。
- 节点写入改为服务器读取最新树后串行应用字段补丁，避免不同 Agent 的旧快照互相覆盖。
- coordinator 自动创建和关闭 worker/coordinator 范围，并通过环境与 Prompt 注入 `scopeId`。
- `AGENTS.md` 新增 F25 后置覆盖；冻结详细协议保持字节级不变。中英文逐轮 Prompt 已发布到本机和 `huangyu`。

## 验证

- 两个 Agent 分别领取 N1/N2，读取到不同执行目标。
- Agent A 写 N2 被服务端拒绝。
- A/B 并发写 N1/N2 后，两个结果均保留。
- 完整 MCP、协调器、多树维护、插件包、共享安装、Prompt 覆盖和 compact 门禁全部通过。

## 2026-08-16 发布链统一验收

- 根因：源码、共享 kit、平台缓存、远程 kit 与运行进程此前没有统一验收；插件版本未变时宿主会复用旧缓存。
- 插件版本改为 `0.8.0+codex.20260816062259`，移除 Codex 不接受的 `interface.websiteUrl`；清单测试与官方插件校验均通过。
- 本机 32 个有效项目、Codex 两处缓存、Cursor/Claude/Trae 分发和 `huangyu:/data/fqd/llm-task-tree-kit` 均通过 20/20 审计；远程四个服务已重启并返回正确项目根目录。
- 侧栏真实滚轮回归连续 3 次通过，内容可从 482px 可视区滚动到 1133px 底部。

## 2026-08-17 自动并行双审核闭环

- 打开“自动并行 Codex”后，后端立即返回 `planning`；planner 在后台从 ROOT 和未决节点生成 2–4 个任务、依赖、互斥写集和验收命令。真实规划生成 4 个 N3 分支，耗时约 167 秒，界面不再维持长 HTTP 请求。
- 用户只审核两次：开始时可修订草案并批准；结束时集中查看目标相对结论、变更文件、测试和 diff，选择接受或丢弃。
- 批准时把当前 dirty 工作区制成隔离 git 快照；worker 在独立 worktree 使用真实可写 Codex 会话，程序检查实际改动是否越出写集。ready frontier 完成一项即集成并解锁依赖，不再等待整批只读调查。
- coordinator 在 integration worktree 核验、修复和测试。接受前主工作区不变；接受时若同一文件被用户再次修改则拒绝覆盖。接受成功后，受 scope 限制的状态同步会话只通过任务树工具更新本次节点，不移动 GraphState。
- 状态机、dirty 快照、Codex 启动、桌面/手机界面、Linux kit、陌生项目安装和插件自足包全部通过。版本 `0.8.0+codex.20260817180406` 已同步根源码、共享 kit、两处 Codex 缓存、Cursor/Claude/Trae 清单、本机旧模板和 `huangyu:/data/fqd/llm-task-tree-kit`；远程 4 个服务按原项目根重启，20/20 审计通过。

### 关键证据

- [协调状态机回归](../../../../scripts/test-codex-coordinator.mjs)
- [真实 worktree 回归](../../../../scripts/test-parallel-worktree.mjs)
- [双审核浏览器回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [开始审核截图](../../../../artifacts/parallel-auto-start-review.png)
- [结束审核截图](../../../../artifacts/parallel-auto-end-review.png)
- [自动并行协调器](../../../../server/codex-coordinator.js)
- [git 隔离模块](../../../../server/parallel-worktree.js)

## 2026-08-17 自动并行交互收敛与真实点击验收

- 顶栏新增直接入口，正常流程从“Codex 下拉菜单 → 并行入口 → 开始审核 → 结束审核”收敛为 3 个核心点击：“自动并行 → 确认开始并行 → 接受并应用/丢弃结果”。
- 运行期间开始、接受和丢弃动作均不可操作；重新规划与协调任务入口降到“更多”。关闭弹窗后可按运行 ID 恢复同一次任务。
- Playwright 通过真实 HTTP 状态机、临时 Git 仓库和真实 worktree 连续执行两轮：接受前主目录不变，接受后两个文件写回；第二轮丢弃后主目录保持第一轮结果。
- 测试发现并修复两处真实状态缺陷：第二轮“丢弃结果”残留禁用状态；每日项目总览可能异步遮住并行结束审核。
- 版本 `0.8.0+codex.20260817223820` 已同步共享 kit、两处 Codex 缓存、本机旧模板和 `huangyu`；本地/远程发布审计 `20/20`，Linux、插件自足包与陌生项目安装通过。

### 新增证据

- [真实浏览器与真实状态机回归](../../../../scripts/test-codex-parallel-real-ui.mjs)
- [顶部直接入口截图](../../../../artifacts/parallel-direct-entry.png)
- [真实结束审核截图](../../../../artifacts/parallel-real-end-review.png)

## 2026-08-17 严格门禁与失败分支局部重跑

- 规划器现在接收可选的“本轮目标”；留空时仍从当前任务树推导，避免聊天中的临时目标完全丢失。
- 结束审核只有在所有分支完成、集成测试通过且存在实际改动时才允许接受；一个 worker 失败但集成测试全绿的反例已验证为不可接受。
- 失败或阻塞分支可在结束审核中修改任务、依赖、验收命令和独占写集，然后复用原 integration worktree 只重跑这些分支；已通过分支保持只读且不重复执行。
- 真实浏览器回归覆盖：正常接受、整批丢弃、失败态接受锁定、失败分支修订、局部重跑和最终接受；Windows/Linux kit、插件运行时和陌生项目安装回归通过。

### 本轮证据

- [协调器反例与局部重跑回归](../../../../scripts/test-codex-coordinator.mjs)
- [真实失败审核截图](../../../../artifacts/parallel-failed-review.png)
- [真实局部重跑结束审核截图](../../../../artifacts/parallel-retry-success-review.png)
- [共享 kit 同步脚本](../../../../scripts/build-kit.ps1)

## 关联

- [step.json](./step.json)
- [执行范围模块](../../../../server/execution-scope.js)
- [节点补丁模块](../../../../server/tree-node-patch.js)
- [并发回归](../../../../scripts/test-execution-scopes.mjs)
- [N3 子树](../../../../subtrees/N3-subtree.md)

## 2026-08-18 长期目标连续性与快速接受

- 目标审核新增长期连续性结论；已有历史运行时，`baseline` 不再被接受，必须判为 `stable`，漂移或无法判断均锁定接受。
- 规划器和结束协调器只携带最多六条精炼目标锚点，不把历史日志或完整改动塞进审核界面。
- 真实 Git 点击“接受并应用”后 `351ms` 进入已应用状态；任务树同步和隔离区清理在后台完成。Windows 运行记录替换增加占用重试和后台排空，避免状态卡死。
- 真实浏览器覆盖成功、拒绝、失败锁定和失败分支局部重跑；Linux kit、插件包、清单、陌生项目安装及根源码/kit/plugin 哈希一致。

### 本轮证据

- [长期目标与接受状态机回归](../../../../scripts/test-codex-coordinator.mjs)
- [真实 Git 用户点击回归](../../../../scripts/test-codex-parallel-real-ui.mjs)
- [精炼结束审核截图](../../../../artifacts/parallel-auto-end-review.png)

## 2026-08-18 规划等待与审核信息精炼

- 历史运行的模型规划耗时为 167–625 秒；修复后真实接口在 10.46 秒返回 3 个可审核分支，超时状态为可继续使用的保守草案。
- 10 秒现在覆盖连接、创建会话和模型作答全过程；超时会关闭对应 app-server。服务重启后读取遗留 `planning` 记录会自动恢复，不再无限轮询。
- `scripts/**` 等正常宽写集不再因“可能包含共享状态”而被预先拒绝；worker 真正修改 `scripts/project.json`、任务树、版本或运行元数据时仍会被实际文件检查拦截。
- 开始审核默认只显示状态、分支标题和任务；节点 ID、任务 ID、依赖、验收命令和写集收进“设置”，失败原因保持直接可见。

### 验收证据

- [规划会话超时回归](../../../../server/codex-run.test.js)
- [协调器与孤儿规划恢复回归](../../../../scripts/test-codex-coordinator.mjs)
- [实际保护路径回归](../../../../scripts/test-parallel-worktree.mjs)

## 2026-08-18 并行启动可见性与分支信息精炼

- 根因：旧快照阶段约 86 秒没有可见反馈，worker 的 `threadId` 只在完成后落盘；首屏同时展示计划摘要、完整指令、ID、依赖、命令和写集，分支名还直接暴露 planner 抽象术语。
- 处理：快照只索引当前改动路径；Codex `turn/start` 接受后立即写入任务入口；规划器与前端统一使用自然中文名称；首屏只留编号、名称、状态和一句结果，其余内容进入“详情”。服务重启时保留完成分支，并自动续跑已中断的汇总阶段。
- 实测：真实脏仓库 108 个快照路径准备从 86 秒降至 16.1 秒；真实运行完成 3 个分支、13 个变更文件、6/6 集成测试，进入可接受结束审核。运行截图：[开始审核](../../../../artifacts/parallel-auto-start-review.png)、[运行中](../../../../artifacts/parallel-current-running.png)、[结束审核](../../../../artifacts/parallel-auto-end-review.png)。
- 回归：`server/codex-run.test.js`、`scripts/test-codex-coordinator.mjs`、`scripts/test-parallel-worktree.mjs`、`scripts/test-codex-parallel-ui.mjs`、Linux kit、插件包、manifest、共享安装均通过；`5412` 已隐藏重启并恢复旧运行。
- [精炼后的开始审核截图](../../../../artifacts/parallel-auto-start-review.png)
- [真实三次点击与局部重跑回归](../../../../scripts/test-codex-parallel-real-ui.mjs)

## 2026-08-18 可扩展分支与四路并发

- 草稿顶部新增单一加号；可连续增加分支，新增项立即展开并定位到编辑区。
- “查看与修改”改为更大的明确入口；名称、节点、完整任务、写集、依赖和验收命令均可编辑，缺少任务或写集时会定位到对应字段。
- 草稿态不再后台轮询重绘；恢复草稿后等待超过原1.2秒轮询周期，新增分支、展开状态和输入内容均保留。
- 计划分支数不再复用四路并发上限；七分支调度实测峰值为四，其余自动排队。
- Playwright 在桌面和手机完成连续增加、展开、编辑和提交；真实 Git 双审核、失败重跑、Linux kit 与插件同步回归通过。

### 本轮证据

- [连续增加与编辑回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [七分支并发调度回归](../../../../scripts/test-codex-coordinator.mjs)
- [六分支开始审核截图](../../../../artifacts/parallel-auto-start-review.png)

## 2026-08-18 持续追加与 worker 对话入口

- 调度器不再冻结启动时的任务集合；运行中新增分支会进入同一执行前沿，汇总阶段新增分支会在当前汇总结束后续跑，结束审核后也能复用原 integration worktree 继续一轮。
- 顶部可直接选择任务树节点并持续点击加号；草稿阶段保留编辑，运行和审核阶段把选中节点直接加入队列。分支被 Codex 接受后立即显示明确的“进入对话”，由专用 API 打开对应 worker 任务。
- 回归覆盖运行中追加、审核后续跑、活动写集冲突拒绝、worker deep link、节点选择与真实点击；原失败分支重跑、四路并发、上下文继承和目标门禁保持通过。
- 插件版本 `0.8.0+codex.20260818050755` 已同步共享 kit、两处 Codex cache、Cursor/Claude 清单和本机旧模板；23 个有效项目共用同一 kit，部署审计 `15/15`。5412 已用新 cache 隐藏重启并保持原“面试等”项目根。
- 当前仅证明机制和交互可运行；长期真实业务中能否持续抓住根目标仍没有真实用户证据，因此 N3 目标尚未达到。

### 本轮证据

- [动态追加与对话入口回归](../../../../scripts/test-codex-coordinator.mjs)
- [节点选择和真实点击回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [真实 Git 双审核回归](../../../../scripts/test-codex-parallel-real-ui.mjs)
- [运行中追加截图](../../../../artifacts/parallel-current-running.png)
- [本机部署一致性审计](../../../../scripts/audit-deployment-sync.mjs)

## 2026-08-18 每分支独立对话与模型草案审核

- “独占写集”已从用户界面和后端错误改为“分支负责修改的文件范围”；底层仍用互不重叠的文件范围避免并行覆盖。
- 每个分支可分别新建对话或选择不同历史 Codex 对话；普通项目对话会先复制到隔离工作区，同一对话不能同时分配给多个分支。
- 依赖说明和验收提示由模型预填并允许人修改；点击加号时先选择节点，再由模型生成一个可审核草案，确认后才进入队列。
- 真实 `5410` 草案有3个分支，每行9个上下文选项，实际绑定了两个不同对话；新增分支可选13个节点。真实规划本次走保守降级，长期目标连续性仍未验证。
- 插件版本 `0.8.0+codex.20260818071456` 已同步源码、共享 kit 与两处 Codex 缓存；5410 以隐藏进程从新版 runtime 启动。

### 本轮证据

- [对话隔离与启动回归](../../../../server/codex-run.test.js)
- [协调器状态机回归](../../../../scripts/test-codex-coordinator.mjs)
- [桌面与手机点击回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [部署一致性审计](../../../../scripts/audit-deployment-sync.mjs)

## 2026-08-18 当前配置规划修复与发布收口

这次“还没有完成”的直接原因不是需要降低模型配置，而是两处真实信息流断点：`initialize` 成功后没有发送 `initialized` 通知；规划器曾用固定 45 秒上限，早于用户当前配置的真实完成时间。另一个表象原因是本机 5410 仍运行旧 cache，修复后的代码没有被实际入口加载。

- 规划器现在不传 `model` 或 `effort`，完全使用用户当前 Codex 配置；仅保留 180 秒故障保护。
- 当前配置实测：完整自动规划约 68 秒完成；指定 N3 新增分支约 100 秒完成；两者都返回可编辑的依赖提示、验收提示和文件范围。
- 真实 5410 已切换到隐藏的新 runtime，HTTP 200；桌面/手机点击、不同对话、轮询期间保留编辑、插件包、项目入口和远程 Linux kit 均通过。
- 发布审计首次发现本机旧模板兼容副本落后 4 个文件，已刷新；重新审计应以 20 项全部通过为完成标准。

当前仍未完成的只有长期目标验证：还缺少真实业务中连续两轮以上的证据，证明自动规划一直抓住根本目标，而不是仅在回归夹具中通过。该问题不能用“完成了回归”替代。

### 本轮证据

- [app-server 顺序与超时回归](../../../../server/codex-run.test.js)
- [真实 5410 桌面/手机点击回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [本机/远程发布审计](../../../../scripts/audit-deployment-sync.mjs)
- [最新步骤索引](./step.json)

## 2026-08-18 分支上下文复用与对话可见性

- 默认从已结束运行恢复分支上下文；节点相同且文件范围相容时自动沿用原 worker 对话，用户仍可逐分支改选其它项目对话或明确新建。
- 自动规划器继续复用稳定系统对话；规划、分支、汇总和同步会话按类型收纳，同时保留可直接进入的 Codex 链接。
- 真实 `5410` 桌面和手机点击、协调器、Codex 协议、Linux kit 均通过；版本 `0.8.0+codex.20260818204315` 已同步两处本机缓存、旧模板、共享 kit、远程 Codex 缓存和4个 Linux 服务。
- 本机与远程发布审计 `20/20` 通过。长期真实业务连续两轮是否始终抓住根目标仍未验证，因此 N3 不能宣称完成。

### 本轮证据

- [上下文复用界面](../../../../artifacts/parallel-context-reuse.png)
- [对话分类与入口界面](../../../../artifacts/codex-conversation-visibility.png)
- [协调器回归](../../../../scripts/test-codex-coordinator.mjs)
- [桌面与手机点击回归](../../../../scripts/test-codex-parallel-ui.mjs)
- [本机与远程发布审计](./outputs/context-reuse-release-audit.json)

## 2026-08-19 上下文代际轮换与交接可读性

- 分支上下文达到 70% 标记偏长，达到 90% 后在下一次继续时自动换代；旧 thread 归档，不删除历史。
- 换代前生成主工作区交接档案，并投送为分支 worktree 内的 `.task-tree-context/handoff.json`；新 Agent 实际读取上一代结果摘要后继续，任务结束清理只读输入。
- `node scripts/test-context-lifecycle.mjs` 验证两个分支从第一代切到第二代、交接标记被读取、旧 thread 被归档、交接输入被删除；`codex-run` 11/11、协调器、worktree、桌面/手机和真实 HTTP 浏览器回归均通过。
- 主树和 N3 子树保持精简，compact 与 flow drift 均通过；连续两轮真实业务能否持续抓住根目标仍未验证，因此 N3 保持进行中。

### 本轮证据

- [上下文生命周期回归](../../../../scripts/test-context-lifecycle.mjs)
- [Codex 运行时回归](../../../../server/codex-run.test.js)
- [协调器回归](../../../../scripts/test-codex-coordinator.mjs)
- [真实 HTTP 浏览器回归](../../../../scripts/test-codex-parallel-real-ui.mjs)
- [交接实现](../../../../server/codex-coordinator.js)
