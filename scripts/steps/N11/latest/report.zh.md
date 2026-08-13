# N11 步骤报告：多树上下文与 Agent 维护闭环

## 本轮结果

- 精读 `Lost in the Middle`、`MemGPT`、`Reflexion`、`OPRO` 的方法、实验、局限与结论。
- 原 Prompt 冻结：555 行、36,299 bytes、SHA256 `35321A6C...A4608`。
- 400 个非空行拆成 468 个语句/结构单元，全部标注 F00-F20 功能和重构落点。
- 新根入口 5,950 bytes，减少 83.6%；21/21 功能覆盖通过，详细协议与原文逐字一致。
- `build-kit.ps1` 改为打包完整协议，避免短入口覆盖可移植 kit 的详细功能。
- 新增 `task-trees.json` 注册表和背景支撑树；方法树是唯一可绑定 flow/chain/subtree 的树。
- 前端可切换/创建独立树；Playwright 已验证 method/background 内容、GraphState 缓存和执行流不串树。
- Stop postflight 不依赖 Git：首次发现漏写树/step 时返回 `decision:block`，重入时只告警，避免无限循环。
- `NextPlan` 已降级为用户备忘：UI、SVG、Agent Prompt 均明确禁止执行；chain 不再自动覆盖它。
- 方法树保存自动同步 flow status；Stop 根据 turn-start 树快照推断真实变更节点并生成最小 step evidence，避免 stale Next 误归属。
- Node/API 8 项、Playwright 与 Prompt 21/21 覆盖通过；canonical full protocol 仍与冻结原文逐字一致。

## 产物

- `docs/agent-context-research/README.md`
- `docs/agent-context-research/AGENTS-lite.proposed.md`
- `docs/agent-context-research/sources.md`
- `docs/agent-context-research/papers/`
- `docs/agent-context-research/pdf-design-notes.md`
- `docs/agent-context-research/prompt-audit/AGENTS.annotated.md`
- `docs/agent-context-research/prompt-audit/statement-map.tsv`
- `docs/agent-context-research/prompt-audit/prompt-review.md`
- `server/tree-registry.js`、`server/maintenance.js`、`server/turn-tracker.js`
- `.codex/hooks.json`、`.codex/hooks/turn-start.mjs`、`.codex/hooks/stop-postflight.mjs`
- `task-trees.json`、`trees/background.md`
- `scripts/test-multitree-maintenance.mjs`、`scripts/test-multitree-ui.py`
- `public/graph-export.js`、`scripts/agent-postflight.mjs`

## 2026-08-06 追加结果

- 用户级中英文逐轮 Prompt 新增一一对应的 `TT01-TT07`；真实 Hook 输出为单行合法 JSON，包含 `UserPromptSubmit.additionalContext` 与全部编号。
- 项目 `turn-start` 从“只存快照”改为注入实时 `Current / Next / NextIdea`；下一步 preset 会先核对 stale 状态，每个可独立验证工作单元后立即写树。
- active method tree 从 32,498 bytes / 486 行压到 12,170 bytes / 252 行；14 个节点和全部关系边保留，稳定实现由 `trees/architecture.md` 承接。
- project flow 从含 2 个历史试点的 14 个 task 块重建为 12 个活动块；`focusId=N11`，missing/stale/status/order drift 均为空。
- 修复 flow rebuild 焦点回退：旧 focus 合法时保留，否则优先 `GraphState.Next`，并新增回归。
- 维护、MCP、插件包、manifest、share/install、21/21 Prompt 覆盖和 compact gate 均通过。

## 多 Codex 并发实现

- 新增 `server/codex-coordinator.js`：一次接受 2-4 个节点任务，校验重复节点、绝对/越界路径、共享状态路径和重叠写集。
- worker 使用 `read-only` 并发运行并返回最终 `agentMessage`；只有随后启动的 coordinator 使用 `workspace-write`，负责核验、落盘、测试和节点回写。
- `POST /api/codex/parallel` 立即返回 run id；状态持久化到 gitignored 的 `.task-tree-runs/`，并被维护扫描排除。
- 页面新增节点、任务、独占写集选择与状态轮询；桌面和 390px 视口通过 Playwright 检查。
- coordinator 并发回归连续 5 次通过；MCP 全套、plugin 6 项、manifest 6 项、share/install 12 项、maintenance 13 项和 Prompt 21/21 均通过。

## 2026-08-06 遗留项目迁移

- `E:\AgentPlatform2.1.5-8` 的 active method tree 从 `112633` B 压至 `11857` B，保留 26 个节点和二元边。
- 完整旧树归档至 `trees/method-history-20260806145902.md`，并注册为只读 evidence tree；flow rebuild 后 7 blocks，`drift=false`。
- 目标项目 hook 实测注入 `Current=N2`、`Next=N3` 和真实 `NextIdea`；compact gate 通过。
- 原因是旧节点位于 `GraphState/Edges` 后且边 Notes 携带过程历史，导致解析不可靠并超预算。

## 2026-08-06 huangyu Linux/Codex 安装

- kit 安装于 `/data/fqd/llm-task-tree-kit`，示例项目位于 `/data/fqd/task-tree-demo`。
- Codex `task-tree@llm-task-tree` 为 `installed, enabled 0.7.0`；MCP 真实握手返回 17 个工具和 1 个 UI resource。
- 项目 hook 正常注入实时 GraphState；Web API 在 `127.0.0.1:5232` 返回有效状态。
- 修复 Linux 安装器：显式传 MCP/marketplace 路径，并通过 `codex plugin add` 完成插件安装；远端重跑验证幂等。

## 下一步

在一个真实项目运行 2-4 个 worker，对比单 Codex 的墙钟时间、结果采纳率和 coordinator 修订量，再调整并发上限与任务拆分。

## 2026-08-07 项目回顾与活树精炼

- 工具栏新增“回顾”；活动方法树每天首次打开自动显示“现在要紧的”，只呈现目标、Current、Next、未完成旁支和已完成标题。
- “一页读完”在一个滚动页按树中顺序展示全部节点核心字段，节点行和“定位 Next”可返回关系图对应节点。
- 回顾内容实时从树派生，不向 Markdown 写重复摘要；starter、MCP embed 和 snapshot 不自动弹出。
- Node Playwright 验证 14/14 节点一致，1600x1000 与 390x844 均无横向溢出；截图见 `artifacts/project-overview-desktop.png`、`artifacts/project-overview-mobile.png`。
- 活动方法树保留 14 个节点和全部边，从 12,040 bytes / 249 行精炼至 8,433 bytes / 209 行，体积减少 30.0%；字段超限和长行均为 0。
- 新版 kit 已同步到 `huangyu:/data/fqd/llm-task-tree-kit`；父工作区 5633 API 正常，远端 starter 树的桌面与 390px 回顾均为 1/1 节点且无面板横向溢出。
- 远端 Codex MCP 真实握手返回 17 个 `task_tree` 工具和 1 个 `ui://task-tree/graph.html` 资源。

## 2026-08-07 节点语言与代码门禁

- 新增 `AGENTS.node-writing.md` 覆盖规则：节点默认简明中文；允许 LLM、token、API、必要名称、ID 和路径；复杂英文专业术语放入证据文件。
- 节点语义字段不再写代码、结构化数据样例、命令、公式、堆栈或日志；Input/Output 改为中文说明加可选证据路径。
- `server/tree-quality.js` 新增代码片段和英文长段检查；`scripts/test-tree-node-writing.mjs` 验证允许项与拒绝项，当前活动树写作违规为 0。
- 门禁回归确认自然语言案例标签和 `LLM`、`token`、`API` 技术缩写不会误报，代码样例仍会被拒绝。
- 全局中英文逐轮提示新增 TT08；本机 29/29 项目同步成功，huangyu 父工作区 starter 已清理并通过 compact。
- 冻结原始协议和逐句审计未改动；新规则通过根入口、独立覆盖文件、安装模板和机械门禁叠加生效。

## 2026-08-07 远端打开链路修复

- 根因确认：旧 `app-server` 早于 MCP/plugin 安装启动，且临时 shell 服务遗留失效的 `.task-tree-port=35595`。
- 已部署端口自愈和 Linux shell 入口权限恢复；远端项目安装器重跑成功，`5633/api/project` 指向 `/data1/hyf/platfrom1`。
- `test-mcp-server.mjs`、`test-linux-kit.mjs`、`test-share-install.mjs` 全部通过；本机 `15633` SSH 转发可访问远端界面。
- 重启后的远端 Codex 会话已启动新的 `mcp-server.mjs`；等待该宿主回合返回 `task_tree_open` 的内联 widget 结果。

## 2026-08-07 全局 Prompt 自动发布

- 桌面新增“编辑并发布全局 Prompt”快捷方式；打开中文唯一源后监测实际保存，稳定 3 秒即发布，关闭编辑器时再做一次漂移核验。
- Codex 以临时只读会话逐行翻译；门禁要求 Markdown 行型、规则顺序、`TT/F` 编号、URL 和反引号内容保持一致，漏译或改写结构会阻断提交。
- 首次真实发布通过 34 行、27 条规则、2 个标题检查；补齐原英文缺失的“无人工审核时采用权威替代证据”规则。
- 本机和 `huangyu` 的中英文 SHA-256 分别一致；两端用户级 Hook 均为 `ok`，覆盖各自账号下全部 Codex 项目。
- 第二次运行返回 `already-current` 且 `translated=false`，证明内容无漂移时不会重复调用模型。

## 本步产物

- `scripts/prompt-publisher/publish-global-prompt.mjs`
- `scripts/prompt-publisher/edit-global-prompt.ps1`
- `scripts/prompt-publisher/install-global-prompt-publisher.ps1`
- `scripts/prompt-publisher/README.zh.md`
- `scripts/test-prompt-publisher.mjs`
- `scripts/steps/N11/latest/step.json`

## 2026-08-07 回顾二次精简

- 回顾页从“目标、Current、Next、风险、旁支、完成清单与全部节点”改为固定两段：根本目的、当前进度。
- 删除“一页读完”标签、节点列表、风险、旁支、完成清单、下一步和定位按钮；页面节点行实测为 0。
- 当前进度优先读取 Next 节点的 `CurrentResult`，再回退 Current/ROOT，避免用户未移动 Current 时显示过期进度。
- Playwright 在 1600x1000 与 390x844 视口通过；两种视口均无横向溢出，截图已更新。
- 根目录、共享 kit 和两份插件运行时已同步；流程块顺序未变，drift 为 false。
- `huangyu:/data/fqd/llm-task-tree-kit` 的主 UI 与插件运行时已同步，3 个文件哈希与本机一致；旧版备份在 `backups/review-summary-20260807T091135Z/`。

## 2026-08-07 DeepSeek 历史参数兼容修复

- 最小复现确认：普通请求为 HTTP 200；故障会话最近 43 项加入一条数组型 `apply_patch` 历史后稳定返回 HTTP 400。
- 根因是 Responses 历史转成 Chat Completions 时原样转发数组参数，而上游要求工具参数为对象。
- 历史清洗现将 `apply_patch` 参数转为补丁对象；该转换不改变模型新生成给 Codex 执行的参数格式。
- 6 个代理代码测试通过；重启本机 4000 后，远程 4152 对未改写的 43 项和原始 120 项故障历史均返回 HTTP 200。

## 2026-08-08 全局 Prompt 保存监测修复

- 根因是编辑器保存时短暂独占文件，旧监测器的哈希读取没有重试，异常会终止保存轮询；翻译器和 SSH 发布逻辑正常。
- `Get-SourceHash` 现在最多重试 8 次，每次间隔 125 毫秒；持续不可读时跳过本轮并等待下一次轮询，最外层异常同时写入当天日志。
- 新增 `scripts/test-prompt-editor-watcher.ps1`，独占锁回归、原发布器单测和 PowerShell 语法检查均通过；已重装桌面快捷方式对应的运行副本。
- 当前中文源已真实发布。本机与 `huangyu` 中文 SHA-256 均为 `63899f03...c9c3`，英文均为 `93f51cd3...3afc`；状态记录更新时间为 2026-08-08 21:22。
- 发布后演练返回 `already-current`、`translated=false`，本机与远程 Hook 均为 `ok`。

## 2026-08-08 翻译重试与无窗口入口

- 22:03 的保存已被监测器正常捕获，但两个独立 Codex 翻译子进程均以 exit 1 结束，发布没有进入 SSH 阶段。
- 未修改中文载荷的完整对照调用随后返回 exit 0 和有效结构化翻译，排除中文结构、全局 Hook 与远程目标的确定性故障；结论为 Codex/模型瞬时失败。
- 新增通用 `retryOperation`，翻译默认最多尝试 3 次、间隔 2 秒；每次尝试清理旧输出，最终失败时汇总各次原因。
- 新增 `launch-global-prompt-editor.vbs`；桌面快捷方式目标现为 `C:\Windows\System32\wscript.exe`，由无控制台宿主隐藏启动 PowerShell 监测器。
- 重试、隐藏入口、文件锁、原发布器与语法测试均通过；项目源与本机安装副本哈希一致。
- 当前 40 行、33 条规则已发布。本机与 `huangyu` 中文 SHA-256 均为 `a2382db1...60fc`，英文均为 `476b381c...3692`；复检为 `already-current`，两端 Hook 均为 `ok`。

## 2026-08-09 项目决策总览

- 两段式“回顾”改为决策总览，默认按目标、当前局面、阻塞、推荐下一步、可选方向和节点状态组织。
- 仅 2 个未完成且有 `NextIdea` 的节点进入候选；13 个非 ROOT 节点各占一行，节点详情仍留在关系图。
- ◆ 可设置 Next；点击候选或节点行会关闭总览、切回关系图并定位节点。
- Playwright 验证桌面 `1600×1000` 与移动 `390×844` 无横向溢出，保存请求在测试中被拦截，真实 Next 保持 N11。
- 截图见 `artifacts/project-overview-desktop.png`、`artifacts/project-overview-mobile.png`。

## 2026-08-09 Agent 技术版图适配调研

- 覆盖截图全部 20 类技术，报告收录 66 个官方论文、文档或仓库链接。
- 当前优先缺口确定为：工作单元状态机、行为评测、统一运行追踪和输入/工具/执行/输出四层护栏。
- Context、Memory、RAG 与 AI Gateway 在上述闭环之后增强；现有任务树、MCP、本地检索和单写者 coordinator 保留。
- 完整 GraphRAG、独立向量库、微调、蒸馏及大型 Agent 框架暂缓，避免扩大系统却不解决维护时点与 stale 状态问题。
- 详细采用表、代码落点和分阶段架构见 `docs/agent-context-research/technology-landscape-2026.md`。

## 2026-08-09 根本目的锚定与方向性总览

- 总览主层只保留根本目的、整体方向、方向性进展、当前待解决项与下一次推进；执行入口和 13 个节点默认折叠。
- 普通 turn 与 Codex 单步提示均注入 ROOT 的目的、方向和成功标准；无法从树与用户要求推出因果时禁止补写。
- `CurrentResult` 首句只写相对 ROOT 的方向性结论；计划、文件名、截图和预期设计不能作为完成证据。
- 桌面与 390px 总览、维护 hook、单步提示和插件运行时一致性验证通过；相关截图与测试路径见 `step.json`。

## 2026-08-09 人类舒适协作条件调研

- 人的能力模型由“有限容量的信息读取”修正为借助外部表示进行识别、比较、操纵和线索恢复。
- 舒适性被定义为降低记忆、搜索、导航和恢复成本，同时保留判断、核验、纠错与控制权；少字本身不再作为目标。
- 核查外部认知、信息觅食、中断恢复、自主性和人机协作等 14 项关键研究，保存 5 篇开放论文。
- ROOT 的任意 30 秒阈值已替换为定向、恢复、纠错和信任校准的基线对照方法；详细证据见 `docs/agent-context-research/human-capability-comfort.md`。

## 2026-08-09 主流进度管理产品对照

- 核查 Jira、Linear、Asana、monday.com、Notion、GitHub Projects、Azure Boards、ClickUp 的官方资料。
- 稳定共同模式是统一工作对象配合多种情境视图，分开方向健康、项目计划、日常执行和证据详情，而不是让一张完整图承担全部任务。
- 与人类舒适研究确有交集的是稳定入口、按需展开、恢复线索和直接操纵；企业层级、敏捷术语和自动完成率不作认知解释。
- 本轮只形成研究与待验证假设，未修改界面或代码；详细证据见 `docs/agent-context-research/progress-management-products.md`。

## 2026-08-09 任务树舒适版三原型

- 用户明确纠正：任务树是产品特色和核心，不应因竞品采用多视图而退居附属页面。
- 三个并发 Agent 分别完成“方向脊柱”“局部镜头”“折叠地形”，统一读取当前真实 `/api/tree`，只改变观察、聚焦和展开方式。
- 原型通过参数或左右键切换；不写树、不调用真实修改接口，正式界面未改。
- Playwright 验证 A/B/C 在桌面和 390px 共 6 组场景均无控制台错误和页面级横向溢出，切换按钮与键盘操作通过。
- 入口为 `public/task-tree-prototype/index.html`；截图见 `artifacts/task-tree-prototype-*-desktop.png` 与移动端同名文件。

## 2026-08-09 方向脊柱正式改造

- 用户选择 A 后仅改正式任务树的观察层，没有替换现有界面或数据结构。
- 缩放低于 0.72 时节点自动切换为宏观摘要，低于 0.44 时进一步弱化旁支；标题屏幕字号不随画布继续缩小。
- ROOT 到 Next 的主干保持深绿色 7px 实线，Current 路径保留红色辅助；自动排版优先把活动路径置于兄弟层中部。
- 自动验收覆盖 14 个节点：适配缩放 0.22 时宏观摘要为 14/14、主干 4 段、标题实际约 14px；放大后 14/14 恢复细节，控制台错误为 0。
- 正式源与可安装 kit 已同步；截图见 `artifacts/task-tree-semantic-zoom-macro.png` 和 `artifacts/task-tree-semantic-zoom-detail.png`。
- 根据用户复测，宏观节点进一步改为只显示标题：移除角色和摘要文字，标题改为无衬线 800 字重，0.22 缩放下实际约 16px；节点宏观高度同步增加以容纳长标题。

## 2026-08-09 宏观边简化与全项目发布

- 宏观层隐藏边编辑卡与连接点，边仍保留底层关系数据，放大后恢复编辑。
- 普通、Current、Next 边宽由 2.2、4.5、7 提高到 3.2、6、9；14 节点自动验收通过，宏观边信息入口为 0。
- 本机注册表 34 项中刷新 29 个真实任务树项目，5 个无任务树路径跳过，失败 0；全部使用同一共享 Kit。
- huangyu 的 3 个任务树项目统一指向 `/data/fqd/llm-task-tree-kit`；本地与远程 `app.js`、`styles.css` 及插件运行时副本的 SHA-256 完全一致。

## 2026-08-12 四版 V2 任务树浏览原型

- 正式界面保持不变；新增独立只读入口，统一读取当前 `/api/tree` 的 14 个真实节点。
- A“方向主干”持续显示 ROOT 到 Next 的粗主线；B“阶段泳道”按根本目的、正在推进、已形成能力和尚未启动分组；C“焦点透镜”围绕单节点显示问题、思路、结果和上下游；D“空间地图”保留稳定位置并按缩放层级显露信息。
- 可重复浏览器脚本覆盖四版切换、节点选择、ROOT/Current/Next 定位、焦点移动、全部节点抽屉和地图缩放。
- Playwright 在 `1440×960` 与 `390×844` 共 8 组场景通过，控制台错误、页面横向溢出和可见元素碰撞均为 0。
- 入口：`http://127.0.0.1:5410/task-tree-prototype-v2/index.html?variant=a`；截图见 `artifacts/task-tree-prototype-v2/`。用户尚未实测选择，不能宣称已有最佳版本。

## 2026-08-12 正式界面三层导航

- 项目总览收敛为三项：根本目标、现在进行到了哪里、现在的问题是什么；删除执行入口、节点索引和额外方向列表，避免用户看完总览后还要重新筛选。
- 普通任务树保留原有关系图和语义缩放；在桌面继续放大超过普通细节层时，自动以滚轮所在节点、最近节点或当前焦点打开焦点透镜。
- 透镜中心固定显示“解决什么问题、思路怎么做、结果如何”，左右提供上游与下游导航；关闭或按 Escape 后回到普通树，并将焦点节点居中选中。
- 修复手机透镜的自然纵向布局，中心节点优先显示，关系卡片按上游、下游顺序排列；不会覆盖知识库、版本树或任务树数据。
- `scripts/test-project-overview-ui.mjs` 与 `scripts/test-focus-lens-integration.mjs` 均通过；覆盖桌面 `1440×960`、手机 `390×844`、自动缩放、关系切换、关闭定位、控制台错误和透镜横向溢出。
- 根目录正式源、`llm-task-tree-kit/public/` 与插件运行时三套 `index.html`、`app.js`、`styles.css` 哈希一致；活动方法树 compact 通过，flow drift 为 false。
