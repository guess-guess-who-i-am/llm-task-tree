# LLM Task Tree 项目思路总结（论文检索用）

> 本文档总结「解决跟不上大模型思路问题」这一项目的整体设计、机制与创新点，供检索相关论文、评估是否具备发表价值。  
> 生成日期：2026-06-22

---

## 1. 一句话定位

**把大模型在长程任务中的「隐性工作记忆」外置为一份人类可读、模型可写、可视化可编辑的 Markdown 任务图（task graph），并通过协议、版本、Skill 路由和多模型协作，让人类在 30 秒内判断「现在在哪、下一步做什么、是否偏航」。**

这不是又一个 Chat UI，也不是单纯的 Project Management 工具，而是 **Human–Agent 共享的外部任务状态层（Externalized Task State Layer）**。

---

## 2. 要解决的根本问题

### 2.1 症状（用户侧）

- 长对话后，人类不知道 Agent 真正推进到了哪一步
- 模型「说做了」和磁盘「实际有」可能不一致
- 换方向、回退、并行探索时，聊天历史与真实任务状态分叉
- 本地有大量 Skill / 知识库 / 多模型，但不知道「当前节点该用哪个」
- 每轮让模型写长篇 summary 既费 token，又不可视、不可编辑、不可版本化

### 2.2 根因（设计侧归纳）

| 层 | 问题 |
|----|------|
| **状态存储** | 任务状态藏在对话上下文、隐性 memory、散落文件里，没有单一权威来源 |
| **同步** | IDE Agent、Web UI、人类三方各改各的，缺少共享 schema |
| **粒度** | 「总结整段对话」太粗；「只记 todo list」太浅，丢失问题结构与因果关系 |
| **回退** | 任务图可版本回退，文件系统不可事务回滚 → **状态–产物漂移（drift）** |
| **能力路由** | Skill 数量爆炸，全量塞上下文会误调用；需要与「当前子问题」绑定 |

---

## 3. 核心设计哲学

1. **外置，而非内嵌**  
   任务状态写入 `task-tree.md`，而不是依赖模型每轮口头汇报。

2. **图，而非树状 todo**  
   节点表示子问题；**边（含超边）** 表示依赖、支撑、分支、不确定关系。Completion 不表达焦点，**GraphState** 才表达焦点。

3. **Markdown 作为共享总线**  
   同一份文件：人类可读、Git 可 diff、Agent 可 parse、Web UI 可渲染。估算：整树 ~10k tokens，但 **只读 GraphState + Next 节点 ~943 tokens** 即可恢复执行焦点。

4. **聊天与状态分离**  
   Cursor / Codex 负责探索性对话；任务图负责 **可验证的任务状态**。刻意不做「从图内一键启动 Agent」（避免新的隐性会话边界）。

5. **协议驱动 Agent**  
   `AGENTS.md` 规定开始/结束任务时必须读树、更树、备份、写字段；不是 hoping the model remembers。

6. **渐进式披露（Progressive Disclosure）**  
   重字段（Input/Output）移出主卡片；Skill 先索引 metadata 再加载；task-tree-grill 拆成 references。

---

## 4. 系统架构（五层）

```
┌─────────────────────────────────────────────────────────────┐
│  Human（浏览器任务图 UI / 资源管理器右键 / Cursor 聊天）      │
└───────────────┬─────────────────────────────┬───────────────┘
                │ 编辑/读                     │ 探索性对话
                ▼                             ▼
┌───────────────────────────┐     ┌─────────────────────────┐
│  task-tree.md（权威状态）   │◄────│  IDE Agent（AGENTS.md）  │
│  + versions/（版本快照）    │     │  + SelectedSkills       │
│  + GraphState               │     │  + skill-routing-log    │
└───────────────┬─────────────┘     └─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Local Web App（Node server + 图谱编辑器）                   │
│  - 可视化节点/边/路径高亮                                      │
│  - 版本树回退                                                │
│  - Skill 推荐面板                                            │
│  - 知识库 RAG + 联网搜索                                     │
│  - 节点内多模型协作                                          │
└─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Project artifacts（代码、文档、索引 — 非权威，可能 drift）  │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 数据模型：Markdown Task Graph Schema

**节点（Node）** — 每个节点是一个子问题，固定字段：

| 字段 | 用途 |
|------|------|
| Problem | 要解决什么 |
| Approach | 打算怎么做 |
| Input / Output | 真实数据源与交付物（UI 侧栏预览，不进主卡片） |
| Metrics | 如何判断成功 |
| CurrentResult | 本轮 concrete 成果（1–3 句） |
| RootCauseAnalysis | 失败/设计变更的**根因**（不是现象） |
| CaseStudy | 具体案例：situation → mistake → lesson |
| Completion | 粗粒度完成态（未开始/进行中/已完成/需重做） |
| SelectedSkills | 用户/系统为该节点选中的 Skill ID |
| Notes / NextIdea | 自由备注 / 下一步建议 |

**边（Edge / Hyperedge）** — 独立 `Edges` 区，端点可 ≥2，带 Label 和 LabelOffset。

**GraphState** — 全局焦点：

- `Current`：刚完成/正在看的节点
- `Next`：下一步该推进的节点
- `NextPlan`：一句可执行指令

**设计决策**：Completion ≠ Focus。焦点由 GraphState 表达，避免节点字段承担过多语义。

### 4.2 人机协同协议（AGENTS.md）

**任务开始**：读树 → 定 Current/Next → 检查 SelectedSkills → 树不存在则先建树。

**任务结束**：版本备份 → 最小更新节点/边 → 更新 GraphState → 告诉用户哪个节点变了。

**回溯/漂移规则（Rollback & Drift）**：

- `task-tree.md` 回退后，**以树为权威**
- 磁盘残留文件 = orphan artifact，不能证明任务已完成
- Agent 必须按当前 Next 重新验证，不能凭聊天记忆跳过

这是本项目较有辨识度的 **protocol-level contribution** 之一。

### 4.3 可视化图谱编辑器

- 力导向/树形排版画布，节点拖拽、缩放、超边
- 当前路径（红）/ 下一步路径（蓝）高亮
- 自动保存 ↔ `task-tree.md` 双向同步 + 轮询外部修改
- 版本树：带「修改原因」的快照，点击回退（回退前也备份）
- I/O 预览、Skill 面板：可拖动浮层，避免图谱被长文本撑爆

### 4.4 Skill 路由（Task-grounded Skill Routing）

- 扫描全局 Skill 目录（`~/.codex/skills` 等）索引 `SKILL.md` metadata
- 根据 **当前节点 Problem/Approach + NextPlan** 推荐候选
- 用户多选写入 `SelectedSkills`
- Agent 实际使用后写入 `skill-routing-log.md`（选择 → 解析 → 使用 → 结果闭环）

**区别于**「把所有 skill 塞进 system prompt」或「纯聊天触发 skill」：路由锚定在 **任务图节点**。

### 4.5 知识库 RAG + 联网搜索

- 本地 `knowledge/` Markdown → embedding 索引 → 检索/问答
- 多 Provider 联网（Tavily、Brave、Exa、SearXNG、open-webSearch）
- **模型自主 search**：多模型协作时，每个模型可自己决定检索关键词，服务端执行后回填（非统一预检索广播）

### 4.6 节点内多模型协作

- 每个节点可配置多个 OpenAI-compatible 模型 + 独立 `agent.md`
- 并发独立回答；页面内 **临时** 多轮会话 + 跨模型临时共享上下文
- **不落盘**到 task-tree（避免新的隐性记忆）
- 运行时对 task-tree 做 **snapshot hash**，检测运行中树是否被改

角色：同一子问题上多视角辩论，而非替代 GraphState。

### 4.7 部署与传播

- 可移植 Kit：项目根 `task-tree.md` + 子目录 `llm-task-tree/`
- 安装包 `LLMTaskTree-Setup.zip`：选盘安装 + 资源管理器右键「Install / Open Task Tree」
- `task-tree-grill` Skill：一次一问（grill）建树，适合冷启动和长对话恢复

---

## 5. 工作流程（典型）

```
1. 用户有模糊目标
      ↓ task-tree-grill（一次一问）或人工建 ROOT + 子节点
2. task-tree.md 出现 3–7 节点 + GraphState.Next/NextPlan
      ↓ 用户在 UI 标记 Current/Next，或 Agent 按协议更新
3. Cursor Agent 读 GraphState + Next 节点（~943 tokens 级焦点）
      ↓ 选 Skill、写代码、更新 CurrentResult/RootCauseAnalysis
4. 人类看任务图 30 秒内判断：偏航？阻塞？要回退？
      ↓ 版本树回退 → 触发 drift 协议 → Agent 重新验证
5. 需要文献/笔记时 → 知识库 RAG / 多模型协作 / 联网
6. 换项目 → 右键 Install Task Tree → 独立 task-tree.md
```

---

## 6. 与相关工作的关系（供文献检索）

### 6.1 高度相关方向

| 方向 | 代表概念/系统 | 与本项目关系 |
|------|----------------|--------------|
| **External memory / scratchpad** | MemGPT, Generative Agents memory, Reflexion | 同样外置记忆，但本项目是 **结构化任务图 + 人机共编**，不是纯向量记忆 |
| **Planning / task decomposition** | Plan-and-Solve, ReAct, AutoGPT, LangGraph | 同样分解任务，但本项目强调 **持久可视化 + 人类编辑 + 版本回退** |
| **Human-in-the-loop AI** | HITL planning, interactive ML, cognitive forcing | 任务图是 **cognitive externalization**，让人类 oversight 低成本 |
| **Workflow / state machines** | LangGraph, Temporal, Airflow | 有状态机味道，但 schema 是 **Markdown 文档** 而非代码图 |
| **Knowledge graphs for PKM** | Obsidian, Roam, Tana, TheBrain | 同样是图，但节点是 **Agent 可执行的子问题 + 协议字段**，不是自由笔记 |
| **Agent Skills / Tool routing** | ToolGen, Gorilla, MCP, Agent Skills spec | 同样路由工具，但绑定 **GraphState.Next + SelectedSkills** |
| **Multi-agent debate** | Multi-Agent Debate, ChatEval, CAMEL | N6 多模型协作类似，但 **scoped to node + ephemeral memory** |
| **Provenance / versioning** | Git, DVC, MLflow | versions/ 针对 **任务语义状态**，不是代码 snapshot |
| **Context engineering** | Lost in the Middle, context compression, RAG | 用 GraphState 做 **结构化 context narrowing** |

### 6.2 英文检索关键词（建议组合）

**核心问题**

- `externalized task state large language model agent`
- `human agent shared memory software development`
- `visual task graph LLM coding assistant`
- `long-horizon agent task decomposition markdown`
- `human oversight LLM agent planning interface`

**机制**

- `task graph markdown schema agent protocol`
- `rollback drift filesystem agent state inconsistency`
- `skill routing task node agent workflow`
- `graph state current next plan agent focus`
- `multi-model collaboration node scoped debate`
- `progressive disclosure agent skill selection`

**HCI / SE 交叉**

- `cognitive externalization programming agents`
- `mixed-initiative AI task planning UI`
- `explainable agent progress visualization`
- `version control agent task state`

**中文检索**

- 大模型 任务分解 可视化 人机协同
- Agent 外部记忆 工作流 版本回退
- 编程助手 任务图 上下文管理
- 长程 Agent 状态漂移 一致性

### 6.3 可能的对标论文类型

1. **CHI / UIST / CSCW** — 任务图 UI、30 秒判断焦点、grill 建树交互  
2. **ICSE / FSE / ASE** — Agent 辅助开发中的外部任务状态、drift 协议  
3. **NeurIPS / ACL Workshop on Agents** — GraphState 作为 structured context、skill routing  
4. **EMNLP Industry** — Markdown schema + 协议 + 本地 RAG 集成  

---

## 7. 潜在创新点（诚实评估）

### 7.1 较强（可作为 paper contribution 候选）

1. **Markdown Task Graph 作为 Human–Agent 权威状态总线**  
   三方（人/UI/Agent）共编、Git-friendly、带 GraphState 焦点机制 — 比「对话 summary」和「纯 JSON state」更强调 **human inspectability**。

2. **Rollback–Drift 协议**  
   任务图版本回退 ≠ 文件系统回退；显式 orphan artifact 处理 — 在长程 Agent 任务中较少被形式化。

3. **Task-grounded Skill Routing 闭环**  
   节点 SelectedSkills + NextPlan → 推荐 → Agent 使用 → skill-routing-log — 把「能力选择」绑在子问题上。

4. **字段语义分层（CurrentResult / RootCauseAnalysis / CaseStudy）**  
   不是只记「done」，而是记 **成果、根因、案例** — 支持失败后审计与知识沉淀。

5. **task-tree-grill：一次一问建图**  
   介于自由聊天与自动规划之间，有明确 stop condition 和 graph quality checklist。

6. **节点 scoped 多模型 + 自主检索 +  ephemeral memory**  
   控制隐性记忆边界（不写 task-tree、不写 disk history）。

### 7.2 中等（engineering integration，需强 evaluation 才像 paper）

- 本地 RAG + 多 search provider + open-webSearch daemon 集成  
- 可移植 Kit + Windows 右键安装包  
- 版本树带「修改原因」的 semantic versioning  
- Token 成本估算（整树 vs GraphState-only）

### 7.3 较弱 / 已有大量 prior art（不宜单独作为主 claim）

- 「Agent 做任务分解」本身  
- 「RAG over Markdown notes」本身  
- 「多模型 ensemble/debate」本身  
- 「Visual graph editor」本身  

**论文若要成立，建议主打：外部化任务状态 + 人机共编协议 + drift/rollback + 用户 study**，其余作为 system implementation。

---

## 8. 可写的论文角度（标题 brainstorm）

1. **Externalized Task Graphs: Making Long-Horizon LLM Agent Progress Inspectable and Reversible**  
   强调：Markdown schema、GraphState、版本回退、drift 协议、用户 30 秒判断实验

2. **Task-Grounded Skill Routing: Binding Agent Capabilities to Problem Graph Nodes**  
   强调：SelectedSkills、推荐器、routing log、误调用对比实验

3. **Grill-before-Execute: One-Question-at-a-Time Task Graph Construction for Agent Steering**  
   强调：task-tree-grill、graph quality metrics、与直接 AutoPlan 对比

4. **Splitting Chat from State: A Mixed-Initiative Architecture for Software Agent Collaboration**  
   强调：Cursor 聊天 vs task-tree 状态分离、case studies（如删除 Agent launch 的教训）

---

## 9. 发表前通常还缺什么

| 缺口 | 说明 |
|------|------|
| **用户研究 / 定量评估** | 目前多为 case study 和 E2E trace；缺「30 秒判断」的 controlled user study |
| **Baseline 对比** | vs 纯聊天、vs todo.md、vs LangGraph、vs MemGPT-style memory |
| **Drift 发生率统计** | 回退后 drift 频率、Agent Compliance 率 |
| **Skill routing 准确率** | 推荐命中率、误调用率 |
| **Multi-model 增益** | 是否比单模型提高 CurrentResult 质量（需 blind eval） |
| **形式化** | schema 与协议的语义可单独成章，但目前是工程文档级 |
| **安全/隐私** | api_key 隔离、Skill 库中恶意 prompt（CL4R1T4S case）的处理策略 |

---

## 10. 系统边界（写 Related Work / Limitations 用）

- **单人本地优先**：无多人实时协同合并  
- **非 Agent 运行时**：不替代 Cursor/Codex 执行环境；只做状态层  
- **Windows 安装体验为主**：右键菜单、Setup.zip  
- **Markdown 解析依赖约定**：schema 非 JSON Schema 强制验证（服务端有部分字段保护）  
- **多模型协作无 judge 融合**：暂为并排展示  
- **知识库索引**：全量重建为主，增量索引仍在演进  

---

## 11. 项目文件地图（实现入口）

| 路径 | 作用 |
|------|------|
| `task-tree.md` | 权威任务图实例 |
| `AGENTS.md` | Agent 维护协议（system prompt 级） |
| `llm-task-tree/server.js` | 后端 API、版本、RAG、多模型 |
| `llm-task-tree/public/` | 图谱 UI |
| `llm-task-tree/open-task-tree.ps1` | 项目级启动器 |
| `llm-task-tree-kit/` | 可分发 Kit + Setup 安装包 |
| `skills/task-tree-grill/` | 建树 grill Skill |
| `versions/` | task-tree 语义版本快照 |
| `knowledge/` + `knowledge-index.json` | 本地 RAG |
| `model-agents/` | 多模型配置与 agent prompt |

---

## 12. 总结判断：有没有「论文味」？

**有，但定位要准。**

- 如果包装成「又一个 Agent 框架 + RAG + 多模型」，**创新性不足**，难发顶会。  
- 如果包装成 **「长程 Human–Agent 协作的外部任务状态层」**，聚焦：
  - Markdown task graph schema + GraphState
  - 三方共编与 authority rules
  - Rollback/drift 协议
  - Task-grounded skill routing
  - Grill 建图与 30 秒 human oversight 假设  

  则具备 **HCI + SE + Agent Systems 交叉** 的 workshop / 二线会议 / 行业 track 潜力；要冲 CHI/ICSE 主 track 需要 **正式 user study + baseline**。

**最像论文贡献的一句话：**  
> 我们提出一种外置式任务图机制，将 LLM Agent 的长程工作记忆从对话上下文迁移到人类可编辑、可版本回退、Agent 协议驱动的 Markdown 图结构，并给出处理状态–产物漂移的形式化协作协议。

---

## 13. 建议优先检索的论文/系统（起点）

- LangGraph / LangSmith（graph workflow state）  
- MemGPT / Letta（external memory tiers）  
- Reflexion / Voyager（episodic memory for agents）  
- Generative Agents（Park et al.，UI + memory architecture）  
- AutoGPT / BabyAGI（早期 task loop，缺 human oversight）  
- GitHub Copilot Workspace / Cursor Plan Mode（commercial，可能无公开论文）  
- SWE-agent / OpenHands / Devin 类系统（coding agent benchmark 方向）  
- ToolLLM / Gorilla / ToolGen（tool routing）  
- Human-in-the-loop ML survey（Amershi et al.）  
- Mixed-initiative interfaces（Horvitz）  
- Obsidian / Roam Research（PKM graph，非 agent-centric）  
- Chain-of-Thought / Tree-of-Thought（推理树 vs 任务图，区分：ToT 是 inference-time，本项目是 persistent task state）

---

*文档由项目 task-tree、AGENTS.md、README 及 N1–N9 节点设计归纳而成，用于内部讨论与文献检索，非正式论文稿件。*
