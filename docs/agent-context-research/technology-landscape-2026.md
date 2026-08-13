# 2026 Agent 技术版图与 `llm-task-tree` 适配研究

> 调研范围：截图所列 20 类技术。结论优先依据官方论文、官方文档、官方仓库；“成熟度”指工程概念和可复用实现的成熟程度，不等同于宣传热度。调研日期：2026-08-09。

## 1. 执行摘要

截图把不同层次的东西并列在一起：有协议（MCP）、系统架构（Harness、Agent、Multi-Agent）、运行控制方法（Loop、Graph）、模型能力接口（Tool Use）、数据与模型技术（RAG、向量库、微调、蒸馏），也有横切工程能力（评测、护栏、可观测性、网关、成本）。不能按名词逐个“安装”；应先判断当前项目缺的控制闭环。

当前 `llm-task-tree` 已经具备：多树注册与折叠、逐轮焦点注入、`task_tree_write` 写回门禁、flow/step 同步、MCP 工具、Markdown embedding 检索、联网检索、多模型并发和只读 worker + 单写 coordinator。因此推荐顺序是：

1. **P0：评测框架 + 可观测性**。先让“Agent 是否每个工作单元及时写树、是否误执行 stale Next、是否同步 flow、是否压缩核心状态”成为可回归测量的行为，而不是只靠 Prompt。
2. **P0：Harness/Loop 的工作单元状态机**。把一次工作单元明确表示为 `读取焦点 → 执行 → 验证 → 写树 → 写 step evidence → 检查 drift → 停止/继续`，每一阶段都有事件和失败状态。
3. **P0：Guardrails**。把知识库、网页结果和 worker 报告视为不可信数据；限制写权限、工具范围、路径和 GraphState 变更，现有 coordinator 边界应扩展到所有 Agent 入口。
4. **P1：Context/Memory Layers**。正式定义“活动方法状态、背景知识、架构决策、执行证据、会话/运行记录”的分层和检索策略，避免所有内容回流到活动树。
5. **P1：RAG 管线升级**。不要采用含义不稳定的“RAG 2.0”标签；在现有本地 embedding 上加入混合检索、查询改写、来源/版本过滤、引用、检索评测。
6. **P1：AI Gateway + 成本遥测**。网关作为可选部署层，不嵌入任务树语义核心；统一记录模型、token、延迟、错误、重试、cache hit 和估算成本。
7. **P2/P3：Prompt 自动优化、合成数据、微调、蒸馏**。必须建立真实任务评测集后再做。当前直接微调或蒸馏会把尚未稳定的流程错误固化进模型。

## 2. 采用判定与推荐落点

| 技术 | 术语成熟度 | 当前适配性 | 优先级 | 推荐加入位置 | 决策 |
|---|---|---:|---:|---|---|
| Harness Engineering | 新名称，实践成熟 | 很高 | P0 | `server/turn-*`、`server/maintenance.js`、hooks、coordinator | 加入“工作单元运行时”而非新框架 |
| Context Engineering | 已形成一手方法论 | 很高 | P1 | 多树注册、焦点上下文、知识检索、Prompt 构建 | 加入上下文预算与选择策略 |
| Loop Engineering | 新名称，控制循环成熟 | 很高 | P0 | chain、flow、postflight、Agent runner | 加入显式状态机、停止条件和预算 |
| Graph Engineering | 名称不统一，图编排成熟 | 高 | P1 | `flow-script` 与树/flow 漂移检查 | 扩展验证，不引入 LangGraph 依赖 |
| MCP | 标准化中、生态成熟 | 很高 | P1 | `scripts/mcp-server.mjs`、插件 runtime | 保持并强化协议兼容测试 |
| Stateless MCP | MCP 的部署模式，不是新协议 | 中 | P2 | 可选远程 HTTP MCP 适配器 | 本地 stdio 不替换；远程服务再加 |
| Agentic AI | 架构模式成熟 | 高 | P0 | Codex runner、chain、maintenance | 用受控 Agent，不扩大无界自治 |
| Multi-Agent Systems | 框架成熟，收益依任务而变 | 高 | P1 | `server/codex-coordinator.js` | 加 planner/evaluator 角色与采纳率评测 |
| RAG 2.0 | 非标准营销词 | 高（按高级 RAG 实现） | P1 | `server.js` knowledge 模块 | 加混合检索、引用与评测；不用该版本名 |
| Memory Layers | 研究与产品均较成熟 | 很高 | P1 | `task-trees.json`、`trees/`、`knowledge/`、`scripts/steps/` | 明确分层、晋升、淘汰和 provenance |
| Tool Use / Function Calling | 成熟 API 能力 | 很高 | P0 | MCP schema、Agent 工具路由 | 收紧 schema，渐进暴露工具，加入契约测试 |
| Vector DB | 成熟基础设施 | 中低 | P2 | knowledge 存储适配层 | 先保留本地索引；以基准决定是否换 pgvector |
| Fine-tuning | 技术成熟，项目条件未成熟 | 低 | P3 | 独立实验目录，不进运行时 | 暂缓，先积累评测和高质量轨迹 |
| Evaluation Frameworks | 成熟且关键 | 很高 | P0 | `tests/evals/`、CI、step 报告 | 立即建设任务树行为评测套件 |
| Guardrails | 成熟但需分层实现 | 很高 | P0 | MCP、RAG、coordinator、文件写入、GraphState | 立即补输入/工具/输出/权限四层护栏 |
| Observability | 通用标准成熟，GenAI 约定演进中 | 很高 | P0 | 新增统一 trace/event 层 | 采用 OTel 兼容事件模型，默认本地存储 |
| Prompt Optimization | 研究和工具成熟 | 中 | P2 | Prompt 发布器旁的离线优化工具 | 仅离线、受 eval 驱动；不让线上 Agent 自改规则 |
| Synthetic Data | 方法成熟，质量风险高 | 中 | P2 | `tests/evals/datasets/` | 用于故障扩增和对抗样例，不替代真实任务 |
| Distillation | 模型训练技术成熟 | 低 | P3 | 独立研究项目 | 暂缓；规模与数据均不足以回本 |
| AI Gateways | 生产基础设施成熟 | 高 | P1 | 模型调用边界，独立可选服务 | 统一路由/重试/预算；不耦合树文件格式 |
| Cost Optimization | 成熟横切能力 | 很高 | P1 | trace、模型运行、RAG、Prompt 构建 | 先测量，再做缓存、路由和上下文削减 |

## 3. 逐项研究与项目适配

### 3.1 Harness Engineering

**定义。** Harness 是包围模型的运行系统：任务分解、上下文交接、工具、沙箱、验证器、权限、状态持久化、停止条件和恢复机制。Anthropic 的长任务实践显示，结构化交接、按小块执行、独立 evaluator、可验证 sprint contract 和上下文重置/压缩会显著改变 Agent 的长程表现；这不是单条 Prompt 能替代的能力。来源：[Anthropic Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)、[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)。

**成熟度。** 名称在 2026 年快速固定，一手工程实践强，但还没有统一标准。核心组件本身已经成熟。

**对本项目。** 极高适配。当前 hooks、turn context、maintenance、chain、coordinator 已是一个早期 harness，但组件之间缺统一 run/work-unit 标识和阶段状态。

**加入位置。** 在 `server/turn-tracker.js`、`server/turn-context.js`、`server/maintenance.js` 与 Codex runner 之间增加统一工作单元协议；每单元生成 `runId/workUnitId/nodeId`，记录开始、验证、写树、step evidence、flow 检查和终止原因。不要另引入大型 Agent 框架。

### 3.2 Context Engineering

**定义。** Anthropic 将其定义为：在推理时选择和维护最有用的一组 token，范围不仅是系统 Prompt，还包括工具定义、检索结果、消息历史、状态和运行反馈；目标是在有限上下文中最大化信息效用。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)。

**成熟度。** 方法论已较明确，具体算法仍随模型变化。

**对本项目。** 极高适配。多树设计正是上下文分区，但现在主要解决“存在哪里”，还需解决“本轮加载什么、为什么加载、加载多少”。

**加入位置。** 给 Prompt 构建层增加可解释的上下文清单：固定规则、Current/Next、Next 依赖、选中 skill、有限检索证据；记录每部分字符/token 估算与选择原因。背景树默认按需检索，不整树注入；活动树只注入焦点路径而非全文。

### 3.3 Loop Engineering

**定义。** Loop Engineering 是为 Agent 设计重复执行机制：目标、每轮动作、环境反馈、验证、预算、停止条件、恢复和升级。Claude 官方把 loop 区分为按 turn、目标、时间和主动触发等形式；Agent SDK 则把 agent loop 明确为模型调用与工具结果之间的持续循环。[Getting started with loops](https://claude.com/blog/getting-started-with-loops)、[Claude Agent SDK: agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)。

**成熟度。** 名称新，控制论式循环和工程实现成熟。

**对本项目。** 极高。当前 chain 已有循环入口，但“每工作单元写树”仍主要靠文本指令和 stop hook 兜底。

**加入位置。** 把 chain/普通 turn 共用一个有限状态机：`focused → executing → verified → tree_committed → evidence_committed → postflight_passed → stopped/advanced`。缺少任一强制阶段就不能自动继续。停止条件至少支持完成、阻塞、预算耗尽、重复失败和用户中止；阈值应由真实运行分布和 eval 校准，不预设拍脑袋数值。

### 3.4 Graph Engineering

**定义。** “Graph Engineering”并非正式标准术语；可操作的内核是用有向图表示 Agent、确定性函数、路由、检查点及允许的状态转移。LangGraph 官方把自己定位为面向长运行、有状态 Agent 的低层编排框架，核心能力包括 durable execution、human-in-the-loop、memory 和状态图。[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)。

**成熟度。** 图工作流成熟；“Graph Engineering”标签本身仍偏行业概括。

**对本项目。** 高适配，但项目已有语义树 + execution flow 双图，不应再引入第三套图运行时。

**加入位置。** 强化现有 `server/flow-script.js`：边/节点静态校验、不可达节点、循环与停止规则、树语义依赖和 flow 顺序差异解释、运行状态与设计图分离。只有未来需要动态分支、持久 checkpoint 和跨进程恢复且现有 flow 无法承担时，再评估 LangGraph。

### 3.5 MCP

**定义。** MCP 是客户端与服务器之间暴露 tools、resources、prompts 等能力的开放协议。Streamable HTTP 规范允许服务器在初始化时分配 session ID，但并不强制；本地 stdio 和远程 HTTP 是不同传输选择。[MCP specification: transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

**成熟度。** 协议和生态快速成熟，规范仍在版本演进。

**对本项目。** 已是核心能力。重点应从“有没有 MCP”转为 schema 质量、兼容性、授权和可观测性。

**加入位置。** 保留现有 stdio MCP；新增协议版本、客户端能力协商、工具契约快照、错误码和端到端握手回归。工具描述应短而明确，避免把完整协议塞入每个 tool description。

### 3.6 Stateless MCP

**定义。** Stateless MCP 通常指 Streamable HTTP 服务不依赖服务器会话状态，或者每个请求能由外部存储重建状态。它不是 MCP 之外的新协议。规范中的 session 是可选项，因此 stateless 是部署选择。[Streamable HTTP draft](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)。

**成熟度。** 可实现，但鉴权、重连、流式通知和水平扩展仍需工程设计。

**对本项目。** 本地桌面 stdio 场景收益小；远程、多 Codex 共用服务或容器扩缩容时才明显。

**加入位置。** 暂不替换当前 stdio。未来增加独立 HTTP adapter，所有状态显式带 `projectId/treeId/runId`，持久状态仍在项目文件或外部存储；不要把隐式 session 当项目状态来源。

### 3.7 Agentic AI

**定义。** Anthropic 将 Agent 概括为：模型在环境反馈中使用工具、规划并多轮行动，直到满足任务或停止条件；与固定 workflow 的区别是路径由模型动态决定。[Building effective agents](https://www.anthropic.com/research/building-effective-agents)。

**成熟度。** 模式成熟，但可靠性高度依赖任务可验证性、工具设计和 harness。

**对本项目。** 高适配。项目目标不是让 Agent 无限自治，而是让它在任务树约束下持续推进。

**加入位置。** 保持“动态选择实现动作，确定性维护共享状态”的原则：Agent 可决定如何完成 NextIdea；GraphState、flow 状态、写集、备份和 compact gate 由代码约束。不要让模型自行解释并绕过这些不变量。

### 3.8 Multi-Agent Systems

**定义。** 多 Agent 系统用角色分工、消息或共享工件协作。Anthropic 推荐的常见模式包括 routing、parallelization、orchestrator-workers 和 evaluator-optimizer；Microsoft AutoGen 提供事件驱动、多 Agent 应用框架。[Building effective agents](https://www.anthropic.com/research/building-effective-agents)、[Microsoft AutoGen](https://github.com/microsoft/autogen)。

**成熟度。** 框架成熟，但“多 Agent 一定优于单 Agent”没有普遍成立；额外通信会增加成本和错误面。

**对本项目。** 已有 2–4 个只读 worker + 单写 coordinator，方向正确。

**加入位置。** 下一步不是提高并发数，而是增加可测角色：planner 只产出工作分解，worker 取证，evaluator 按验收标准审查，coordinator 唯一写入。记录 worker 结论采纳率、冲突率、coordinator 修订量、墙钟时间、token 与最终通过率，再决定哪些节点适合多 Agent。

### 3.9 RAG 2.0

**定义。** “RAG 2.0”没有权威统一定义，通常混指混合检索、查询改写、重排、GraphRAG、Agentic RAG、多跳检索和自我校验。应使用具体能力名。Microsoft GraphRAG 用实体/关系和层次社区摘要支持全局与局部查询；NVIDIA Agentic RAG 示例增加相关性判断、web 路由、答案评估和迭代。[Microsoft GraphRAG](https://github.com/microsoft/graphrag)、[NVIDIA Agentic RAG example](https://github.com/NVIDIA/workbench-example-agentic-rag)。

**成熟度。** 各组件成熟度不一；“2.0”标签不成熟。

**对本项目。** 高。当前已有 embedding、余弦检索、文档多样性、查询改写和 web 合并，已超过朴素 RAG。

**加入位置。** 优先补：BM25/关键词 + 向量混合召回、轻量 rerank、来源树/文档角色过滤、文件版本与 hash、回答逐条引用、检索失败显式返回、离线 retrieval eval。GraphRAG 只在出现跨文档关系查询的真实失败集后试点。

### 3.10 Memory Layers

**定义。** MemGPT 借鉴操作系统分层内存，在有限上下文与外部存储之间移动信息，形成不同速度和容量的 memory tiers，并用中断管理控制流。[MemGPT paper](https://arxiv.org/abs/2310.08560)、[Letta repository](https://github.com/letta-ai/letta)。

**成熟度。** 分层思想成熟，自动记忆写入、摘要和召回质量仍是活跃问题。

**对本项目。** 极高。项目事实上已有五层：活动方法树（工作记忆）、背景/架构树（语义记忆）、`knowledge/`（检索知识）、`scripts/steps/`（情景证据）、运行记录（短期轨迹）。问题是层间迁移规则尚不够显式。

**加入位置。** 在多树注册中定义角色和默认检索策略；为证据保存 `source/hash/createdBy/runId`；规定晋升规则（重复验证且影响后续决策才进入 durable decision）和淘汰规则（过期、冲突、无下一步价值从活动树移出）。禁止把模型自由生成的“记忆”未经验证写入背景事实。

### 3.11 Tool Use / Function Calling

**定义。** Function calling 用 JSON Schema 描述外部能力，模型选择工具并生成参数，应用执行后把结果返回模型。OpenAI 建议清晰描述、严格 schema、让无效状态不可表示、减少初始暴露工具数量，并用延迟工具加载控制上下文。[OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)。

**成熟度。** 高。

**对本项目。** 极高。现有 MCP 工具数量仍可控，但随着 knowledge/models/subtree/flow 扩展，选择准确率可能下降。

**加入位置。** 为每个工具建立 schema 契约测试、正反例和权限标签；把只读/写入/焦点变更分组；尽量由代码填入已知 `projectId/treeId/nodeId`；未来工具继续增长时按任务上下文延迟暴露，而不是把全部 schema 注入每轮。

### 3.12 Vector DB

**定义。** 向量数据库或向量扩展负责存储 embedding 并执行精确/近似最近邻搜索。pgvector 在 PostgreSQL 中提供精确检索、HNSW、IVFFlat、多种距离和事务能力。[pgvector official repository](https://github.com/pgvector/pgvector)。

**成熟度。** 高。

**对本项目。** 当前中低。单项目 Markdown 索引可由本地 JSON/文件处理；引入独立数据库会增加安装、迁移、备份和远程部署负担。

**加入位置。** 先抽象 `KnowledgeIndex` 接口并保留现实现。用真实语料测索引时间、查询 P95、内存、召回质量和增量更新；只有现有实现不能满足目标时，才增加可选 pgvector/SQLite vector backend。不要先设任意文档数阈值。

### 3.13 Fine-tuning

**定义。** 微调用任务示例改变模型行为，常见方法包括监督微调、偏好优化和强化微调。OpenAI 的官方流程明确要求先建立 eval baseline，再迭代 Prompt、数据和微调。[OpenAI model optimization and fine-tuning](https://developers.openai.com/api/docs/guides/fine-tuning)。

**成熟度。** 技术成熟；服务可用性和模型支持随供应商变化。

**对本项目。** 低。项目的核心失败主要是状态维护、上下文选择和流程执行，首先属于 harness 问题；训练数据尚不足且没有稳定 eval。

**加入位置。** 暂缓。未来只考虑窄任务，如工具选择、字段压缩或检索 rerank，并使用冻结的训练/验证/测试划分。不得用同一批生成数据同时训练和验收。

### 3.14 Evaluation Frameworks

**定义。** Agent eval 应测最终任务、轨迹、工具调用、恢复行为和成本，而不只测单轮答案。英国 AI Security Institute 的 Inspect 支持工具、多轮对话、模型评分和可扩展 scorer；OpenAI 也把 eval 置于 Prompt/微调优化循环的第一步。[Inspect AI](https://inspect.aisi.org.uk/)、[Inspect AI repository](https://github.com/UKGovernmentBEIS/inspect_ai)、[OpenAI Evals guide](https://developers.openai.com/api/docs/guides/evals)。

**成熟度。** 高，是当前最应补齐的能力。

**对本项目。** 极高。

**加入位置。** 新建独立行为评测层，优先覆盖：stale Next 不重做、每工作单元及时写回、只改最小节点、GraphState 不越权、tree compact 通过、方法变化触发 flow drift、step evidence 完整、知识引用正确、worker 不写共享状态、远程 MCP 完整回合。框架可先用现有 Node tests + 统一 JSONL case schema；需要跨模型批量评测时再接 Inspect。评分以确定性断言为主，LLM judge 只评无法机械判断的语义质量，并校准一致性。

### 3.15 Guardrails

**定义。** Guardrails 是运行在输入、工具调用、输出或权限边界上的检查与阻断。OpenAI Agents SDK 区分输入、输出和 tool guardrails；NeMo Guardrails 提供可编程对话/检索/执行安全控制。[OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-python/guardrails/)、[NVIDIA NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails)。

**成熟度。** 高，但没有单一框架能覆盖所有风险。

**对本项目。** 极高。现有 focus protection、compact gate、write-set lease、只读 worker 是良好基础。

**加入位置。** 增加四层：输入层标记网页/知识/worker 内容为不可信；工具层按 read/write/admin 分类并做参数约束；执行层限制路径、命令、并发和预算；输出层验证引用、tree schema、flow drift 和敏感信息。Prompt injection 不应靠一句“忽略恶意指令”，而应保证检索文本永远不能提升权限或改变系统规则。

### 3.16 Observability

**定义。** 可观测性以 trace、span、metric、log 还原一次 Agent 运行。OpenAI Agents SDK 默认追踪模型生成、工具、handoff 和 guardrail；OpenTelemetry 正在定义 GenAI spans、events 和 metrics 的供应商中立语义约定。[OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)、[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)。

**成熟度。** 通用 OTel 高；GenAI 语义约定仍演进，但足以作为兼容方向。

**对本项目。** 极高。当前 step evidence 偏最终产物审计，缺少跨模型/工具/写树阶段的统一运行轨迹。

**加入位置。** 新增本地 append-only trace store（不要写入活动树），span 至少覆盖 turn、model call、retrieval、tool call、validation、tree write、flow sync、worker、coordinator。关联字段用 `runId/workUnitId/nodeId/modelId/toolName`；敏感输入默认不落盘，只记录 hash、大小、token、状态和错误类别。提供 OTel exporter 作为可选项。

### 3.17 Prompt Optimization

**定义。** Prompt Optimization 用评测数据自动搜索指令、示例或模块参数。DSPy 将 LM 调用表示为可组合程序，并用 optimizer 优化 prompts/weights；其研究强调在明确 metric 上编译优化，而不是凭主观反复改字。[DSPy repository](https://github.com/stanfordnlp/dspy)、[DSPy paper](https://arxiv.org/abs/2310.03714)、[GEPA](https://arxiv.org/abs/2507.19457)。

**成熟度。** 中高，效果依赖高质量数据和 metric。

**对本项目。** 中。全局 Prompt 已有逐句功能覆盖，适合离线比较压缩版和路由版，但不适合线上自我改写。

**加入位置。** 在 Prompt audit/publisher 旁建立离线 optimizer：候选 Prompt → 固定 eval 集 → 多模型运行 → Pareto 比较正确率、token、延迟 → 人工规则门禁/自动覆盖检查 → 发布。原 Prompt 和功能映射继续冻结。没有显著 eval 改善的候选不发布。

### 3.18 Synthetic Data

**定义。** 合成数据由模型生成任务、输入、输出或偏好样例，再经过过滤、去重和验证。Self-Instruct 的关键并非“自动生成”，而是生成后过滤无效或相似样本，再用于 instruction tuning。[Self-Instruct paper](https://arxiv.org/abs/2212.10560)、[official code/data](https://github.com/yizhongw/self-instruct)。

**成熟度。** 方法成熟，真实性、覆盖偏差和模型自污染风险显著。

**对本项目。** 中。适合扩增 task-tree 故障 case，不适合替代真实用户轨迹。

**加入位置。** 从真实失败种子生成变体：stale Next、冲突证据、超长节点、缺 step、恶意检索、工具 schema 边界、并发写集冲突。生成样本必须通过确定性 validator；独立保留真实 holdout，报告 synthetic-only 与 real-only 结果。

### 3.19 Distillation

**定义。** 蒸馏用大模型输出训练小模型。Google 的 Distilling Step-by-Step 把模型生成的 rationale 作为额外监督，在多任务训练中减少数据和模型规模。[Distilling Step-by-Step paper](https://arxiv.org/abs/2305.02301)、[official repository](https://github.com/google-research/distilling-step-by-step)。

**成熟度。** 模型训练层成熟，但需要数据、算力、部署规模和稳定任务。

**对本项目。** 低。当前调用量、任务稳定性和自有训练数据不足；小模型还可能在关键状态维护上放大错误。

**加入位置。** 暂不加入主项目。未来若大量重复执行“节点分类、检索 rerank、compact 判断”等窄任务，可在独立仓库评估蒸馏，并要求成本回收和质量非劣的实测证据。

### 3.20 AI Gateways 与 Cost Optimization

**定义。** AI Gateway 在应用和模型供应商之间统一鉴权、路由、fallback、rate limit、缓存、日志、预算和成本。LiteLLM 提供 OpenAI-compatible 多供应商接口、路由、重试、虚拟 key 和成本跟踪；Cloudflare AI Gateway 提供 analytics、caching、rate limiting、fallback、guardrails、DLP 和 OTel。[LiteLLM docs](https://docs.litellm.ai/docs/)、[LiteLLM budget routing](https://docs.litellm.ai/docs/proxy/provider_budget_routing)、[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)。

**成熟度。** 高。

**对本项目。** 高，尤其已有多 OpenAI-compatible 模型和远程代理故障经验。但网关不应成为 task-tree 必装依赖。

**加入位置。** 在模型配置层定义供应商无关调用接口；支持外部 LiteLLM/Cloudflare/自有代理 endpoint。项目内部只记录标准 usage、延迟、错误和 cost，不保存 key。成本优化顺序应是：测量 → 减少无关上下文/工具 schema → prompt caching → 检索裁剪 → 合理模型路由 → batch/并发；不要以降低 token 为由牺牲任务完成率。Anthropic 官方 Prompt Caching 说明可缓存重复前缀并降低延迟和成本，适合稳定系统规则、工具定义和背景上下文：[Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)。

## 4. 推荐的目标架构

```text
用户请求
  ↓
上下文选择器（活动焦点 + 依赖 + skill + 检索证据 + token 预算）
  ↓
受控 Agent Loop / Multi-Agent Harness
  ├─ 工具与 MCP 权限门禁
  ├─ 知识检索与引用门禁
  ├─ evaluator / deterministic checks
  └─ 模型网关（可选：路由、缓存、预算、fallback）
  ↓
工作单元提交器
  ├─ task_tree_write
  ├─ step evidence
  ├─ flow drift/status sync
  └─ compact/schema checks
  ↓
Trace + Eval 数据层（不进入活动树）
```

多层状态建议固定为：

| 层 | 当前载体 | 写入原则 | 读取原则 |
|---|---|---|---|
| 工作状态 | 活动方法树 | 只保留会改变下一动作的核心状态 | 每轮只读焦点、NextIdea 与必要依赖 |
| 背景/决策 | 背景树、架构树、ADR | 经过验证的稳定事实和决策 | 按任务检索，不整树注入 |
| 知识 | `knowledge/` | 带来源、hash、版本和更新时间 | 混合检索 + 引用 |
| 执行证据 | `scripts/steps/` | 结果、产物、测试和失败证据 | 验收或追溯时读取 |
| 运行轨迹 | 建议新增 trace store | append-only，脱敏 | 调试、评测和成本分析 |

## 5. 分阶段落地建议

### Phase A：先建立可测闭环（P0）

- 定义统一 `agent-run/v1` 与 `work-unit/v1` 事件模型。
- 为树维护核心行为建立固定 eval case 和确定性 scorer。
- 将普通 turn、chain、parallel coordinator 统一接入阶段状态机。
- 对知识检索、worker report、MCP 写工具加入 trust/permission 标签。
- 验收：同一故障可稳定复现；每个失败能定位到具体阶段；不同模型可在同一 case 集比较。

### Phase B：优化上下文、记忆与 RAG（P1）

- 上下文构建器输出选择清单、token 估算和裁剪原因。
- 正式配置树角色、检索范围、证据 provenance 与淘汰规则。
- 加混合检索、引用、版本过滤和 retrieval eval。
- 接入可选 gateway，采集 usage/cost/cache/retry 指标。
- 验收：活动树不因知识增长而增长；回答可追到原始文件；检索质量和成本都有基线与回归。

### Phase C：数据驱动优化（P2）

- 用真实失败扩增 synthetic adversarial cases。
- 用 DSPy/GEPA 或自建搜索离线优化 Prompt 候选。
- 基于真实规模基准决定是否接 pgvector。
- 对 planner/worker/evaluator/coordinator 做消融实验，而不是默认多 Agent。

### Phase D：训练类技术（P3）

- 只有在任务稳定、数据充分、eval 可信且调用规模能回收训练成本时，才试验微调或蒸馏。
- 训练产物保持可选，不得成为打开任务树或基础 MCP 的必要依赖。

## 6. 明确暂缓或不应采用的做法

- 不因“Graph Engineering”流行而引入第三套图运行时；先增强已有 tree + flow。
- 不把“RAG 2.0”写成产品版本承诺；只实现可测的具体检索能力。
- 不把本地 stdio MCP 强制改成 stateless HTTP；仅为远程共享部署增加 adapter。
- 不让 Agent 自动把未验证总结写入长期背景记忆。
- 不用 LLM judge 代替所有机械检查；schema、路径、focus、drift、引用存在性应确定性验证。
- 不在没有固定 eval 和真实 holdout 前做 Prompt 自动发布、微调或蒸馏。
- 不为了“多 Agent”增加更多可写 Agent；共享状态继续单写者原则。
- 不把 AI Gateway、向量数据库或训练框架设为基础安装必需项，避免破坏当前 Windows/Linux 轻量部署。

## 7. 代表性一手来源索引

- Anthropic：[Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) · [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Building effective agents](https://www.anthropic.com/research/building-effective-agents) · [Loop engineering](https://claude.com/blog/getting-started-with-loops)
- MCP：[Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Agent 图与多 Agent：[LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) · [AutoGen](https://github.com/microsoft/autogen)
- RAG：[Microsoft GraphRAG](https://github.com/microsoft/graphrag) · [NVIDIA Agentic RAG](https://github.com/NVIDIA/workbench-example-agentic-rag)
- Memory：[MemGPT](https://arxiv.org/abs/2310.08560) · [Letta](https://github.com/letta-ai/letta)
- Tool Use：[OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) · [Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)
- Vector：[pgvector](https://github.com/pgvector/pgvector)
- 评测：[Inspect AI](https://inspect.aisi.org.uk/) · [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals)
- Guardrails：[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/guardrails/) · [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails)
- Observability：[OpenAI tracing](https://openai.github.io/openai-agents-python/tracing/) · [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- Prompt optimization：[DSPy](https://github.com/stanfordnlp/dspy) · [GEPA](https://arxiv.org/abs/2507.19457)
- Synthetic data：[Self-Instruct](https://arxiv.org/abs/2212.10560)
- Distillation：[Distilling Step-by-Step](https://arxiv.org/abs/2305.02301)
- Gateway/成本：[LiteLLM](https://docs.litellm.ai/docs/) · [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) · [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

## 8. 最终判断

对当前项目最有价值的组合是：**Harness Engineering + Context Engineering + Loop Engineering + Evaluation + Observability + Guardrails**。它们共同解决“模型为何不及时维护树、为何执行 stale 状态、为何长程漂移、为何出错后难定位”的根问题。MCP、多树、RAG、多模型和 coordinator 已经是良好基础，应在其上增加可测、可追踪、可阻断的运行闭环，而不是继续扩充名词或堆积框架。

最先实施的一个工程包应是“Agent 工作单元控制与评测”：统一 run/work-unit trace，机械验证每个工作单元的树写回和 flow/step 同步，并用固定 case 集跨模型回归。这个包完成后，Prompt 优化、RAG 升级、多 Agent 扩展和成本路由才有可信的比较基线。
