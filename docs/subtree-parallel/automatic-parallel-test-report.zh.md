# 自动并行 IDE 修改与测试报告

日期：2026-09-22。范围：本轮自动并行流程、上下文复用、Git 合并、进度界面和 macOS 独立安装。代码是 JavaScript / Node.js，没有改写成 Go。

## 当前结果

本轮实现与列出的回归均已通过。正式浏览器调用生产 HTTP 路由、真实 Codex Planner、两个真实 Worker、真实 Git 冲突处理和自动应用的完整链路通过；没有将模型替身的结果冒充真实模型结果。Mac 独立 IDE 已运行在 http://127.0.0.1:5491 。

这不是“任意任务都无缺陷”的证明。没有应用层 Worker 数量上限，但机器与服务仍有容量；prompt 无法证明任务数量、粒度全局最优；项目外路径直接生效，不参与当前仓库的 Git 合并。

## 修改是怎样完成的

1. Planner 直接生成完整计划：目标 coverage、任务说明、任务 ID、节点 ID、依赖、可选 writeSet。自动计划硬性要求至少两个非空 Worker 且至少两个无前置依赖；模型若只返回一个 Worker 或串行链，会把失败原因回灌 Planner 重规划。few-shot 要求最大化有用 runnable frontier：6–8 个只是已验证样本，若存在 12 或 20 个独立交付物则全部返回，不为了少而合并，也不为了多而制造空任务。不生成测试命令。
2. 写集成为上下文提示，删除重叠、越界、任务树和共享文件禁止规则。只保留执行必需的 JSON、唯一 ID、已知依赖和无环结构检查。不可执行计划携带完整输出、本次和同节点历史失败自动重试；重复同一失败时明确失败，不假装完成。
3. 调度器每次启动全部就绪任务，不再限制为四个；本轮用 8、12、20 个就绪 Worker 验证并发，三种规模都保留并同时启动。追加任务主动唤醒调度；同一历史对话被多个任务使用时分叉上下文。共享 Planner 会话的多个规划请求串行续写，Worker 仍然并行。
4. Worker 在独立 Git worktree 中修改，可以写任务树、flow、项目元数据以及任务明确指定的外部路径。完整任务树、历史结果和分支上下文进入 prompt，不截断。
5. 每个 Worker 的全部变更合成提交，包含它自己已经提交的多次修改。真实 Git 冲突发生后，把所有参与者的完整 participant packet 一次性传给 source Worker，只开一个 resolver 回合处理并暂存冲突。宿主继续合并；主目录运行期间的新修改也在临时区三方合并。
6. 全部完成后自动应用。删除旧批准、审核、接受、拒绝、Supervisor 和产品测试阶段；UI 只展示规划、执行、完成、进度和对话入口。完整文本自动换行，长内容通过滚动查看。
7. Mac 独立目录建立自己的 Git 仓库和空基线，不自动提交原有用户文件。启动服务使用独立进程组、独立日志和 unref，启动终端退出后服务继续运行。

实现入口：[协调器](../../server/codex-coordinator.js)、[Git 合并](../../server/parallel-worktree.js)、[HTTP](../../server.js)、[界面](../../public/app.js)、[安装入口](../../macos/IDE/install.command)。详细说明：[工作流](WORKFLOW.md)、[实现原理](concurrent-agent-isolation-design.zh.md)。

并发调度、冲突合并和 CCF-A / 高 star 项目的定向研究见[研究记录](concurrency-conflict-research.zh.md)。

## 实际执行的开发测试

以下命令是维护代码的开发测试，不会放进用户的并行执行流水线。

- 私有 Node 运行定向协调器与集成回归：通过。覆盖单 Worker/串行前沿计划重试、8/12/20 Worker 同时启动、8 个参与者共享一个 resolver packet、50k 任务树和历史完整传递、上下文续接/分叉/轮换等。
- `scripts/test-parallel-worktree.mjs`：真实两工作树修改同一文件与 task-tree.md，冲突解决后同时保留两份结果；主工作区同位置的新修改也保留；主索引没有冲突。
- `server/codex-parallel-integration.test.js`：真实协调器 + Git；模型接口为明确标注的脚本替身。双方各自提交两次；8 个 Worker 的冲突场景只产生一个 resolver 回合；同节点、同写集追加任务在原任务仍运行时立即启动，分叉历史；双方内容和任务树全部保留。
- `scripts/test-context-lifecycle.mjs`：历史会话复用、换代、完整交接、索引与旧会话归档通过。
- `scripts/test-codex-parallel-ui.mjs`：生产页面 + HTTP 响应夹具。七个 Worker、新增第八个分支、自动完成、无审批 API、完整长目标/摘要及 390px 手机边界通过。
- `scripts/test-codex-parallel-real-ui.mjs`：生产页面 + 生产 HTTP + 真实 Codex + Git，全链路通过。详见下节。
- `macos/IDE/test.sh`：临时项目安装、真实启动器、独立进程组、重复双击复用端口、浏览器交接、项目 API、MCP、清理通过。
- `scripts/test-plugin-package.mjs`：manifest、MCP 工具面、包内运行时、项目发现全部通过。
- `scripts/build-plugin-runtime.mjs --check`：50 个运行时文件与源码一致；另逐文件确认 Kit 中所有本轮修改的运行时与根源码一致。
- 任务树检查通过；flow drift=false。未改 GraphState 焦点和项目节点执行顺序。

此前报告中的全部其他功能没有在本轮无条件重跑；本轮证据只覆盖以上范围。

## 真实模型端到端证据与耗时

运行 ID：d1ad14c2-6afa-4cf3-ada6-7efd9ea91e61。

浏览器点击“自动并行”后，真实 Planner 一次给出 alpha、beta 两任务，依赖均为空。两个 Worker 各自把 shared.txt 同一行改为自己的文字，并创建自己的文件。Git 确实产生冲突；alpha 对话给出必须保留的意图，beta 的合并对话写出两行，最后主项目含 alpha.txt、beta.txt 和同时保留 alpha、beta 的 shared.txt。最终状态 accepted，清理 completed。

完整原始证据：[运行 JSON](../../artifacts/parallel-automatic/live-run.json)、[结果和请求记录](../../artifacts/parallel-automatic/live-result.json)、[当时页面截图](../../artifacts/parallel-automatic/live-completed.png)。[当前完整文本界面](../../artifacts/parallel-automatic/current-progress.png)是将同一已完成记录在修正后的样式中重放，不是第二次模型运行。

从事件时间计算：

- Planner：122.877 秒，一次成功。
- 建立集成快照：0.118 秒。
- 两 Worker 开始时间相差 0.003 秒，真实对话接受时间相差 0.025 秒。
- Worker 执行至第二个结果进入冲突合并：205.240 秒。
- 冲突询问与解决：238.517 秒，是本次最慢的阶段。
- 冲突解决到自动应用：0.229 秒。
- 后端全程：567.023 秒；浏览器测试总时长：570.064 秒。

这个历史小样本的耗时主要来自 Codex 回合（模型与工具）及旧的逐 peer 冲突协商，Git 快照和自动应用耗时很小。不能据此推断所有任务的瓶颈，也没有同条件 Claude 基线，因此不声称提高了百分之多少或排行榜领先。

## 本轮发现并修复的问题

- 同节点同写集的追加任务可能再次拿到活动 contextKey，触发 CONTEXT_BUSY；现在按已有任务占用情况分叉会话和工作树。
- Worker 自己提交多次时，旧实现可能漏掉累计结果；现在基于初始提交和最终 tree 生成完整差异。
- 自动应用中的冲突不能留在主目录索引；现在先在新的临时区与当前主目录快照合并。
- 独立 workspace 原先继承外层源码 Git 根目录；安装器现在创建独立仓库和空提交。
- 启动器原先与终端共享进程组。新增回归先失败（pgid 14349 != pid 14387），修复后通过；已安装服务 pid=pgid=14581，并在后续独立工具调用中确认 HTTP 可用。Node 官方文档与 Stack Overflow 补充检索遇到网络超时，结论依赖本机可复现实验。
- 长目标/摘要原先受 CSS 两行截断。新增长文本回归先失败，移除 line-clamp 后桌面和手机测试通过，后端实测结果无需重跑。

## 使用和边界

双击 `macos/IDE/open.command`。先在自己的项目中写清目标，再点击“自动并行”；示例 workspace 的 ROOT 仍是待填写模板，不代表已有真实业务目标。运行时可直接添加分支，并通过“进入对话”查看 Worker 历史。

不保证文本无冲突就语义正确；按用户要求未增加测试、代码审核或目标核验阶段。运行元数据可被普通 Worker 修改，但宿主仍持续写入自己的运行状态；外部文件、外部数据库及跨独立运行的直接副作用没有跨仓库事务保护。模型和工具本身的上下文/输出容量仍存在，应用不会静默裁掉传入的分支文本。

过时的 Supervisor、状态同步模型轮及相关旧测试已删除，可从 Git 恢复。旧 N3 审计报告保存在 `scripts/steps/N3/report-before-automatic-20260922.zh.md`。任务树每字段的持久化旧值 → 新值见[回执](automatic-tree-receipt.zh.md)。
