# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。
## ROOT - 建立可共享的大模型任务上下文
- Position: 2179,70
- Size: 400,420
- Completion: 进行中
- Problem: 如何让人类快速看懂、纠正并持续维护大模型的当前工作状态？
- Approach: 把任务图作为人和模型共同使用的外部认知工作台：稳定显示目的、方向、未决问题和下一动作；细节按线索展开；用户可直接纠正、比较和撤销，模型负责维护。
- Input:
- Output:
- Metrics: 对照现有界面测定向正确性、中断恢复正确性、纠错发现成本和信任校准；先取得基线，再按任务错误代价设阈值，不预设任意秒数或节点数。
- Notes:
- CodeLoc:
- CurrentResult: 项目方向已从“压缩人要阅读的信息”修正为“降低记忆、搜索和恢复成本，同时保留人的判断、纠错与控制权”；研究证据见 docs/agent-context-research/human-capability-comfort.md。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N1 - 设计 Markdown 节点格式
- Position: 459,474
- Size: 400,720
- Completion: 已完成
- Problem: Markdown 如何同时保持人可读、Agent 可写和前端可解析？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 短字段、二元边、GraphState、I/O 样例和 versions 分层已固化；契约见 trees/architecture.md A1。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N2 - 实现可视化图谱编辑器
- Position: 869,474
- Size: 400,420
- Completion: 进行中
- Problem: 如何一眼看清关系并直接编辑，同时保持 Markdown 为唯一数据源？
- Approach:
- Input:
- Output:
- Metrics:
- Notes: 节点删除按钮与双视图 SVG 尚缺人工验收；仅在用户重新聚焦 N2 时执行。
- CodeLoc:
- CurrentResult: 图编辑、自动保存、版本回退、双视图、紧凑排版和项目回顾已上线；架构见 trees/architecture.md A2。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N4 - 分析本地 skill 仓库与自动调用机制
- Position: 3008,474
- Size: 470,750
- Completion: 已完成
- Problem: 如何从项目、kit 与全局目录自动选择相关且不重复的 skill？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 已按意图召回、来源优先级去重并过滤泛词；N4 实测重复 task-tree-grill 仅保留项目版。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills: codex:skill-creator

## N6 - 节点内多模型协作
- Position: 70,961
- Size: 400,420
- Completion: 进行中
- Problem: [子树] 节点级多模型对话、检索与持久化如何闭环？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 对话按轮持久化；run 前可自动检索，模型仍可追加 search。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea: 重启服务后跑一轮并重开浏览器，验证历史与自动检索记录仍在。
- SelectedSkills:
- Folded: true
- SubtreeFile: subtrees/N6-subtree.md
- SubtreeCount: 1

## N10 - 执行顺序视图
- Position: 1548,961
- Size: 520,640
- Completion: 已完成
- Problem: 如何把执行顺序与关系图分离并保留节点级证据？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 双视图、Inspector 与 drift API 已上线；scripts/*.json 是顺序权威，证据由 scripts/steps 保存。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N9 - 可移植任务树 Kit 打包
- Position: 1015,961
- Size: 520,640
- Completion: 已完成
- Problem: 如何把任务图能力复制到其它项目且不覆盖既有 AGENTS.md？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: kit 已完成跨项目分发，并建立 GitHub 私有备份仓库 guess-guess-who-i-am/llm-task-tree-workspace-backup。远端 main 与本地提交 f82aeea 一致，包含项目代码、任务树、子树、版本、文档和验收证据；密钥、知识索引、运行状态及外部仓库已排除。可移植与灾难恢复目标已具备。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N3 - 让 Codex 同步维护任务图
- Position: 2508,474
- Size: 488,953
- Completion: 进行中
- Problem: [子树] 如何让 Agent 主动维护核心状态，而不是追加过程历史？
- Approach:
- Input:
- Output:
- Metrics:
- Notes: 内置 coordinator 自动注入范围；手动并行会话先用 task_tree_scope 创建范围并传 scopeId。
- CodeLoc:
- CurrentResult: 已验证多 Agent 不再共用全局 Next 作为执行目标：范围分别返回分配节点，越权写被拒绝，并发写 N1/N2 后两项结果均保留。协议、插件 kit、本机和 huangyu 全局 Prompt 已同步；仍缺用户真实手动多会话试用，因此根本目标尚不能宣称完全达到。
- RootCauseAnalysis: 当前 Codex 的延迟工具桥把 MCP 结果重建为文本和图片，丢失用于挂载界面的元数据；旧测试只验证原始 JSON-RPC，未覆盖用户实际看到的宿主链路。
- CaseStudy:
- NextIdea: 在远程 Linux 与另一个本机项目调用 task_tree_open，确认共享 kit 更新后同样直接打开且不闪终端。
- SelectedSkills:
- Folded: true
- SubtreeFile: subtrees/N3-subtree.md
- SubtreeCount: 1

## N5 - 处理任务树回溯后的文件漂移
- Position: 2079,961
- Size: 523,640
- Completion: 已完成
- Problem: 树回溯但代码和产物未回滚时，如何避免误判完成或误删文件？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 恢复后的树是权威状态；未表示产物仅作 drift evidence，并按当前节点重新验证。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills: codex:skill-creator, agents:write-a-skill

## ST-P1 - 子树试点A chain-step 审计
- Position: 3489,474
- Size: 380,280
- Completion: 已完成
- Problem: [子树] chain-step 是否泄露后续 Chain？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: P0 redaction 已合入；证据见 docs/subtree-parallel/findings-P1.md。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:
- Folded: true
- SubtreeFile: subtrees/ST-P1-subtree.md
- SubtreeCount: 1

## ST-P2 - 子树试点B 并行冲突梳理
- Position: 3899,474
- Size: 380,280
- Completion: 已完成
- Problem: [子树] 多 Agent 写树和代码有哪些冲突点？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 写集冲突清单已完成；证据见 docs/subtree-parallel/findings-P2.md。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:
- Folded: true
- SubtreeFile: subtrees/ST-P2-subtree.md
- SubtreeCount: 1

## N11 - 重构多树上下文与 Agent 维护闭环
- Position: 2614,961
- Size: 0,720
- Completion: 进行中
- Problem: 如何让人借助任务图舒适地形成局面感、恢复上下文并保持对模型的控制？
- Approach:
  - 任务树保持主界面；总览只答根本目标、当前进度和问题。
  - 滚轮只缩放画布；节点按钮打开透镜查看详情和上下游，关闭后回图居中。
- Input:
- Output: 三层界面、验收脚本与截图见 llm-task-tree-kit/public/task-tree-prototype-v2/、scripts/test-task-tree-prototype-v2.mjs、artifacts/。
- Metrics: 能否快速说出项目目标、当前问题和焦点依据；缩放与切换全貌后是否保持方向感。
- Notes:
- CodeLoc:
- CurrentResult: 三层导航已验证：总览看方向，普通树缩放，透镜查看节点问题、思路、结果、上下游和详情，关闭后回图居中。桌面与手机测试通过；仍待真实使用反馈，舒适使用目标暂未达到。
- RootCauseAnalysis: 原设计把缩放与进入透镜绑定，且透镜缺少详情，导致操作中断和反复退出。
- CaseStudy:
- NextIdea: 请用户在正式界面实测总览、连续放大进入透镜、上下游切换和关闭定位，再按真实阅读与导航阻力收敛。
- SelectedSkills:

## N7 - 集成 Markdown 知识库检索面板
- Position: 482,961
- Size: 520,420
- Completion: 已完成
- Problem: 如何索引本地 Markdown、检索/问答并把证据送入节点级多模型？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 向量+词法检索、path 去重和预检索已上线；batch=64、concurrency=40、每篇默认 1 段。
- RootCauseAnalysis:
- CaseStudy:
- NextIdea:
- SelectedSkills:

## N12 - 让 Agent 直接调用任务图
- Position: 3024,961
- Size: 0,720
- Completion: 已完成
- Problem: 如何让 Agent 结构化读写任务图，并让图界面反向续接 Codex 会话？
- Approach:
- Input:
- Output:
- Metrics:
- Notes:
- CodeLoc:
- CurrentResult: 供各种人使用的公开入口已具备：仓库已公开并改名为 llm-task-tree，已配置英文简介、12 个 topics、Issues、Discussions 和 v0.8.0 Release；README 与安装包可匿名访问。脱敏包含 234 个文件、4.22 MiB，未发现本机路径或凭据泄漏；当前下载数为 0，尚无真实流量、Star 或外部市场收录数据，因此“让更多人知道”尚不能宣称达到。
- RootCauseAnalysis: 此前不适合公开传播，是因为仓库名强调备份、安装入口仍指向旧名，完整工作区又混有环境证据；现以简洁仓库名、脱敏 Release 包和 GitHub 元数据建立产品入口。公开只解决可发现性的基础条件，不等于已有传播效果。
- CaseStudy:
- NextIdea:
- SelectedSkills:

# GraphState
- ChainForceNext: 
- Current: N3
- Next: N3
- NextPlan: 重新打开任务图（Ctrl+F5）后验证：节点 × 在九宫格右上角；点 ⤓ 关系图/流程图 下载 SVG 并用 Inkscape/浏览器打开确认文字完整。

# Edges

## E1 - schema 支撑共享状态。

- Endpoints: ROOT, N1
- LabelOffset:
- Label: schema 支撑共享状态。
- Notes:

## E2 - 编辑器呈现并修改共享状态。

- Endpoints: ROOT, N2
- LabelOffset:
- Label: 编辑器呈现并修改共享状态。
- Notes:

## E3 - Agent 维护协议。

- Endpoints: ROOT, N3
- LabelOffset:
- Label: Agent 维护协议。
- Notes:

## E4 - 节点意图路由 skill。

- Endpoints: ROOT, N4
- LabelOffset:
- Label: 节点意图路由 skill。
- Notes:

## E6 - 节点级多模型交互。

- Endpoints: N2, N6
- LabelOffset:
- Label: 节点级多模型交互。
- Notes:

## E7 - 本地知识进入节点上下文。

- Endpoints: N2, N7
- LabelOffset:
- Label: 本地知识进入节点上下文。
- Notes:

## E8 - 检索结果进入多模型分析。

- Endpoints: N6, N7
- LabelOffset:
- Label: 检索结果进入多模型分析。
- Notes:

## E10 - 关系与执行顺序分离。

- Endpoints: N2, N10
- LabelOffset:
- Label: 关系与执行顺序分离。
- Notes:

## E9 - 编辑器能力可分发。

- Endpoints: N2, N9
- LabelOffset:
- Label: 编辑器能力可分发。
- Notes:

## E11 - Agent 协议随 kit 分发。

- Endpoints: N3, N9
- LabelOffset:
- Label: Agent 协议随 kit 分发。
- Notes:

## E5 - restore 后按树重新验证。

- Endpoints: N3, N5
- LabelOffset:
- Label: restore 后按树重新验证。
- Notes:

## E-ST-P1 - chain 上下文审计。

- Endpoints: ROOT, ST-P1
- LabelOffset:
- Label: chain 上下文审计。
- Notes:

## E-ST-P2 - 并行冲突试点。

- Endpoints: ROOT, ST-P2
- LabelOffset:
- Label: 并行冲突试点。
- Notes:

## E12 - 从长提示转为逐轮闭环。

- Endpoints: N3, N11
- LabelOffset:
- Label: 从长提示转为逐轮闭环。
- Notes:

## E13 - flow 与逐轮维护分层。

- Endpoints: N10, N11
- LabelOffset:
- Label: flow 与逐轮维护分层。
- Notes:

## E14 - MCP 复用备份、门禁和 flow。

- Endpoints: N11, N12
- LabelOffset:
- Label: MCP 复用备份、门禁和 flow。
- Notes:

## E15 - 提示协议由工具执行。

- Endpoints: N3, N12
- LabelOffset:
- Label: 提示协议由工具执行。
- Notes:
