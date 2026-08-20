# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。
## ARCH - 任务图系统稳定架构
- Position: 40,40
- Size: 520,720
- Completion: 已完成
- Problem: 哪些稳定实现契约需要长期可查，但不应持续占用 active method tree？
- Approach:
  - 以 Markdown schema 为数据契约，Web 图编辑器为交互层。
  - 执行顺序独立落盘到 scripts，关系语义仍由任务树表达。
  - 可移植 kit 负责安装、升级和项目根隔离。
  - 本树只收稳定架构；当前问题和下一实验回到 method tree。
- Input: `task-tree.md: N1/N2/N9/N10` # 迁移来源；`scripts/steps/` # 详细证据
- Output: `trees/architecture.md` # 按需加载的稳定架构树
- Metrics: 只读本树可在 30 秒内定位 schema、UI、flow、kit 四层职责和证据入口。
- Notes:
- CodeLoc:
- CurrentResult: 已把 N1/N2/N9/N10 的稳定实现从 active method tree 分层为 A1/A2/A9/A10；本树不绑定 flow、chain 或 subtree。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## A1 - Markdown 图数据契约
- Position: 596,40
- Size: 520,720
- Completion: 已完成
- Problem: Markdown 如何同时保持人可读、Agent 可写和前端可解析？
- Approach: 节点标题保存稳定 ID；固定字段保存当前语义；关系集中在 Edges，且每条边严格连接两个节点。
- Input: `## N1 - 设计 Markdown 节点格式` # 原方法节点；`llm-task-tree/AGENTS.task-tree.md` # 字段预算与语义
- Output: `Problem/Approach/Input/Output/Metrics/CurrentResult/NextIdea` # 节点字段；`Endpoints: A, B` # 二元边
- Metrics: parser 可往返保存未知字段；手写节点无需额外数据库；compact gate 无超限字段。
- Notes:
- CodeLoc: server.js # Markdown 解析与保存；llm-task-tree/skills/task-tree-grill/references/schema-template.md # schema
- CurrentResult: schema 已覆盖 I/O 样例、SelectedSkills、GraphState、结果/根因分栏和二元关系；历史由 versions 保存，live node 只留当前状态。
- RootCauseAnalysis: 早期膨胀来自把状态、过程、结果和失败史持续追加在同一字段；固定短预算与 versions 分层解决职责混杂。
- CaseStudy:
- NextIdea:
- SelectedSkills:

## A2 - 本地图编辑器与多树交互层
- Position: 1152,40
- Size: 520,720
- Completion: 已完成
- Problem: 如何让用户一眼看清关系并直接编辑，同时保持 Markdown 为唯一数据源？
- Approach:
  - 本地 Web 应用解析并自动保存节点、边、I/O、SelectedSkills 与 GraphState。
  - 单击/拖动用于选择和布局，双击编辑；侧向浮层承载 I/O 快照与 skill 推荐。
  - 关系图支持路径高亮、紧凑排版、版本回退；SVG 从真实 DOM 截取后恢复布局。
  - 顶栏切换关系图、执行流程和独立 treeId；未知字段由服务端保护。
- Input: `task-tree.md + task-trees.json` # 数据与树注册表；`AGENTS.md -> size=32676,truncated=true` # I/O 快照样例
- Output: `关系图 | 执行流程` # 双视图；`GET/PUT /api/tree?tree=<id>` # 隔离读写；`SVG` # 真实 DOM 导出
- Metrics: 编辑自动落盘且不丢未知字段；布局无重叠；两种视图导出的 SVG 文字完整。
- Notes: 当前产品边界是本地单人使用，不处理多人冲突合并。
- CodeLoc: public/app.js # 主交互；public/graph-export.js # SVG；server.js # API
- CurrentResult: 图编辑、自动保存、版本回退、I/O 快照、skill 推荐、多树切换和双视图已上线；轮廓排版横向间距收紧到 8-18px。
- RootCauseAnalysis: 重绘式 SVG 容易偏离真实 UI；改为截取 DOM。只列 I/O 路径无法看原始数据；服务端改为返回有界文件快照。
- CaseStudy:
- NextIdea:
- SelectedSkills:

## A9 - 可移植 Kit 与项目隔离
- Position: 1708,40
- Size: 520,720
- Completion: 已完成
- Problem: 如何把同一套任务图能力复制到其它项目，又不覆盖现有 AGENTS.md？
- Approach:
  - `task-tree.config.json` 的 projectRoot 将共享 kit 与项目数据分离。
  - `install.ps1` 创建 starter、合并带标记的 AGENTS 块并追加 gitignore。
  - `one-click-update.ps1` 发现项目并同步 stub、Prompt 与共享运行时。
  - 破坏性升级前写入 `backups/snapshot_*`。
- Input: `server.js/public/AGENTS.md/task-tree-grill` # 打包源；`update-projects.txt` # 深层项目补充清单
- Output: `llm-task-tree-kit/` # 可复制包；`install.manifest.json` # 安装记录
- Metrics: 新项目复制 kit -> install -> 打开独立任务图；已有 AGENTS.md 只追加标记块、不覆盖原文。
- Notes: open-webSearch 等大依赖保持可选，不强制打包。
- CodeLoc: llm-task-tree-kit/install.ps1 # 安装；llm-task-tree-kit/one-click-update.ps1 # 更新
- CurrentResult: 一键更新实测 discovered=25、stub-refreshed=25、prompts-synced=25、failed=0；共享 kit 已包含紧凑排版与去重 skill 推荐。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## A10 - 独立执行流程与步骤证据
- Position: 40,800
- Size: 520,720
- Completion: 已完成
- Problem: 如何把执行顺序从关系图中分离，同时维持节点状态和证据可审计？
- Approach:
  - `scripts/project.json` / `run.json` 是执行顺序权威，节点 ID 连接主树与全部 subtrees。
  - flow 与折叠解耦；关系图只表达语义和依赖，不从画布位置推断执行顺序。
  - Inspector 读取 `scripts/steps/<nodeId>/latest/`；drift API 报告缺块、多块、状态和顺序差异。
  - method tree 保存只自动同步可确定的 Completion/status，结构和顺序仍由 Agent 审核。
- Input: `task-tree.md + subtrees/*.md` # 合法 nodeId；`scripts/project.json` # 项目执行脚本
- Output: `关系图 | 执行流程` # UI 入口；`GET /api/flow-script/drift` # 漂移；`scripts/steps/` # 步骤证据
- Metrics: flow block 均引用有效 nodeId；Inspector 可定位最新证据；折叠/展开不删除已保存执行块。
- Notes:
- CodeLoc: public/flow-view.js # 执行流程 UI；server/flow-script.js # 脚本与漂移；scripts/README.md # 权威协议
- CurrentResult: 正式 flow 已合并进主应用；Inspector 与 drift API 上线，project.json 为 13 blocks，12 个 task block 已有 audit 包。
- RootCauseAnalysis: localStorage 让 Agent 看不到执行脚本，折叠耦合让子节点从调色板消失；改为文件落盘并独立 catalog。
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState
- Current: ARCH
- Next: ARCH
- NextPlan: 本树只在稳定架构契约发生变化时更新。

# Edges
