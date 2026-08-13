# 任务树“核心状态”定义与改造设计

## 结论

当前问题不是单纯“字数太多”，而是活树缺少**语义准入标准**。现有 Prompt 已规定字段预算和删除旧方法，但只要内容没有超过字符上限，模型仍会保留已完成功能清单、产物统计、案例、实现过程和旧验证入口。因此，需要把维护目标从“压缩文本”改为：

> **活树只保存相对于当前任务、足以保持下一次决策不变的最小状态。**

这里的“核心”不是普遍重要的信息，而是对当前 `GraphState.Next + NextIdea` 有决策价值的信息。

## 1. 可操作定义

设完整可用信息为 `S`，当前执行问题为 `q`，模型据此选择下一动作、方法和验收条件。核心状态 `C` 应尽量满足：

1. **充分性（Sufficiency）**：只读 `C + q`，仍能恢复当前问题、有效方法、关键约束、已验证结论、未解决风险和下一动作。
2. **最小性（Minimality）**：删除其中任意一项，都会改变下一动作、方法选择、风险判断或验收；否则该项不是活树核心。
3. **时效性（Freshness）**：只保留当前有效事实。已被替代、已解决或只描述过去过程的内容不留在活树。
4. **可行动性（Actionability）**：内容必须能约束 `NextIdea`、执行顺序或验收，不只用于证明“做过很多工作”。
5. **可审计性（Auditability）**：树中保留结论和证据指针，不复制完整日志、文件清单、截图统计或实验轨迹。

### 删除测试

写入或保留每一条信息前，问：

> 如果删除这条信息，下一位 Agent 是否可能选择不同方法、重复已证伪工作、违反用户约束、漏掉高风险，或无法判断完成？

- **会**：保留。
- **不会，但以后可能查证**：移到 step evidence、ADR、背景树或架构树，只留路径。
- **不会，也无复用价值**：删除；历史由 `versions/` 保留。

## 2. 活跃方法节点应保留什么

一个活跃方法节点默认只保留七类信息：

```text
Problem: 当前唯一未知或决策问题
Approach: 当前采用的方法；不列被替代方案
Constraints: 会改变方法的用户决定、接口限制或高风险
Evidence: 2–3 个能区分方法好坏的实测结论/负结果
OpenRisk: 尚未解决且会阻塞完成的风险
NextIdea: 一个可执行动作，含完成判据
EvidenceRefs: 1–3 个证据路径/提交/报告指针
```

现有 schema 不必立刻新增字段，可映射为：

| 核心语义 | 现有字段 |
|---|---|
| 当前未知 | `Problem` |
| 当前方法 | `Approach` |
| 关键约束 | `Notes`，最多 3 条 |
| 区分性证据 | `CurrentResult`，最多 3 条 |
| 未解决风险/已证伪原因 | `RootCauseAnalysis` |
| 下一动作 | `NextIdea` |
| 证据指针 | `Input` / `Output` / `CodeLoc`，不复制证据正文 |

### 默认外移的信息

- 工具调用过程、时间戳、完整失败轨迹和调试步骤；
- 已完成 UI/接口功能的全量清单；
- 文件数、包大小、截图数、文档字符数等不影响下一决策的产物统计；
- 长案例、完整公式、原始输出和逐文件说明；
- 旧 `NextPlan`、已解决 Notes、已被新方法替代的方案；
- 稳定架构说明和项目背景，它们应进入独立树或 ADR；
- 可以通过路径直接读取的 artifact 内容。

## 3. 为什么当前树仍然不够核心

2026-07-15 审计基线：`task-tree.md` 约 27.4 KB、424 行、13 个正式节点，至少 5 行超过 240 字符。N2、N5、N11、N4 约占整树 46%。主要病灶不是字段缺失，而是一个节点承担了多种寿命不同的信息。

### N2：产品架构、已完成功能和人工待验混在一起

当前保留了多轮 UI 能力、I/O 预览、launcher、SVG 导出机制、三个案例和待人工验证。对下一决策真正必要的是：

```text
Problem: 图编辑器仍需完成 SVG 导出和删除按钮的人工验收。
Approach: 保持 Markdown 单一数据源；SVG 从真实 DOM 导出。
CurrentResult: 自动保存、版本回退、I/O 快照已通过；仅剩两个 UI 验收项。
NextIdea: Ctrl+F5 后验证 × 位置及两种 SVG 的文字完整性；通过即关闭 N2。
EvidenceRefs: 对应 step report、测试脚本和实现文件。
```

已完成功能的全量列表应进入 architecture tree 或 release/step report。

### N4：产物统计被误当成方法状态

85.59 MB、3,056 个文件、文档字符数和截图数只证明打包发生过，不再影响 skill 路由方法。活树只需留下：

```text
结论: 全量加载 skill 会造成噪声；采用索引召回 → 置信度筛选 → progressive disclosure。
约束: reference-only 或注入风险 skill 不进入自动池。
证据: 241 个标准 skill 已建立描述索引；迁移包路径。
```

### N5：协议结论、重验证过程和 skill 重构历史混载

活树只需留下权威规则和未解决风险：树回溯后，树是任务状态源；未被树表示的 artifact 是漂移证据，必须重新验证。skill 拆分过程和三个案例应移入文档/step evidence。

### N11：正确方向已形成，但稳定架构详情仍在活跃方法树

N11 应只保留多树机制的当前假设、已验证结果、剩余风险和下一实验。API 清单、测试文件名和稳定架构描述进入 architecture tree。否则“建立 architecture tree”本身又会成为继续向 N11 追加内容的理由。

## 4. 论文和仓库支持的机制

| 来源 | 可以直接借鉴 | 对本项目的含义 | 局限 |
|---|---|---|---|
| [LLMLingua, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.825/) | coarse-to-fine 压缩、预算控制器、不同片段分配不同压缩率 | 不应给所有字段相同预算；先删低价值块，再压缩保留块 | 极高压缩率会损失语义，不能只追求字节下降 |
| [LongLLMLingua, ACL 2024](https://aclanthology.org/2024.acl-long.91/) | question-aware 文档/token 筛选、动态预算、相关信息重排 | “核心”必须相对于当前 `NextIdea` 判断；换 Next 后应重新投影上下文 | 隐含的跨节点关系可能在粗筛阶段丢失 |
| [MemGPT](https://arxiv.org/abs/2310.08560) / [Letta](https://github.com/letta-ai/letta) | 主上下文作为工作记忆；旧信息分页到外部存储；递归摘要 | 活树是工作集，不是长期档案；历史、证据、背景必须外置 | 解决存储层级，不自动判断任务图中的因果核心 |
| [Reflexion](https://arxiv.org/abs/2303.11366) | 将轨迹提炼为 actionable reflection；实验中长期记忆截断为最近 3 条反思 | 保存“为什么失败、以后应避免什么”，不保存完整失败轨迹 | 最近窗口是特定实验设置，不应机械套用为所有节点都保留 3 条 |
| [RAPTOR, ICLR 2024](https://github.com/parthsarthi03/raptor) | 递归聚类与多层抽象摘要 | 父节点保存跨子节点结论，叶节点/文档保存细节 | 面向检索摘要，不直接维护执行状态和时效性 |
| [Arbor / HTR](https://github.com/RUC-NLPIR/Arbor) | 节点绑定 hypothesis、result、distilled insight、artifact ref；洞见向祖先传播 | 叶节点完成后只向父节点传播一条可复用洞见，不复制叶结果 | 完整 Arbor 需要 evaluator 和多轮实验；当前项目先借 schema 与传播规则 |
| [LLMLingua](https://github.com/microsoft/LLMLingua) | 可实际运行的 query-aware Prompt 压缩实现 | 可用于生成临时 context pack，不宜直接无审计地改写权威树 | 压缩模型输出不能替代结构化准入和事实有效期管理 |
| [Graphiti](https://github.com/getzep/graphiti) | 时序知识图、事实有效期、冲突失效 | 若未来需要自动处理“旧结论何时失效”，可借鉴 validity interval | 对当前 Markdown 项目偏重，暂不应引入为基础依赖 |
| [Mem0](https://github.com/mem0ai/mem0) | 从对话中抽取长期记忆、更新/删除记忆 | 可用于跨会话用户偏好和稳定事实，不应替代方法树 | 通用记忆抽取不理解本项目节点和 flow 的严格语义 |

关键证据是一致的：**核心状态不是更短的历史，而是经过任务相关筛选和抽象传播的语义工作记忆。**

## 5. 推荐机制：Core-State Gate

### 5.1 写入前分类

每条候选信息先进入 `retain / move / drop` 三分流：

- `retain`：会改变当前或下一决策，写入活树；
- `move`：有审计或复用价值，但不影响当前决策，写入外部 artifact 并在树中留短指针；
- `drop`：重复、已解决、已过期且已有版本历史，活树删除。

可在 lint/compactor 中使用以下启发式评分，而不是要求 Agent 在树里输出分数：

```text
CoreScore =
  3 × 改变下一决策
+ 2 × 当前仍未解决
+ 2 × 有测量或可验证证据
+ 1 × 高风险或用户明确决定
- 2 × 已有 artifact 可引用
- 2 × 过程历史
- 2 × 与别处重复
- 1 × 已解决
```

- `>= 3`：候选保留；
- `0–2`：默认外移；
- `< 0`：删除。

阈值是工程启发式，需用真实任务 A/B 校准，不是论文给出的公式。

### 5.2 相对于 NextIdea 的动态投影

Agent 开始工作时，不默认读取整棵方法树，而是生成临时 context pack：

1. 当前 `Next` 节点及其 `NextIdea`；
2. 该节点到 ROOT 的祖先摘要；
3. 直接依赖节点中与 `NextIdea` 有关的约束/负结果；
4. 命中的背景树片段；
5. 必需的 flow block 和 selected skills；
6. 证据只给路径，需要核实时再读取。

换一个 `NextIdea`，应重新生成投影，而不是永久向活树追加更多“以后可能有用”的上下文。

### 5.3 叶到父的洞见传播

每个已执行叶节点结束时只产出：

```text
Result: 一个事实结果
Insight: 一个可复用的因果/边界结论
ArtifactRef: 一个证据指针
```

父节点只接收抽象后的 `Insight`。如果它只是叶节点结果的改写，不传播；如果它会约束同方向的其他子节点，才传播。父节点最多保留 2–3 条当前洞见，新的更强证据替换旧洞见。

### 5.4 按信息寿命拆树

不要按“主题看起来不同”无限建树，而应按**更新频率和读取目的**拆分：

| 存储 | 内容 | 更新频率 | 默认进入 Agent 上下文 |
|---|---|---:|---|
| Background tree | 项目目标、术语、用户长期约束、稳定证据 | 低 | 仅相关片段 |
| Architecture tree | 已落地组件、接口、稳定 ADR 和 artifact 指针 | 中低 | 需要实现/排错时 |
| Active method tree | 当前假设、方法、负结果、未解决风险、NextIdea | 高 | 是，但只读投影 |
| `scripts/*.json` | 执行顺序和状态 | 随执行变化 | 当前 flow block |
| `scripts/steps/` | 实验过程、完整结果、文件清单、报告 | 追加证据 | 按路径读取 |
| `versions/` | 被替代的历史状态 | 自动保存 | 默认不读 |

建议 active method tree 保持 5–12 个节点、目标不超过 12 KiB；超限时应触发语义压缩，而不是继续放宽预算。

## 6. Prompt、skill 和脚本如何分工

### Prompt 只保留不可违背的原则

根 `AGENTS.md` 增加一条短路由，不继续堆大量例子：

```text
写入活树前执行 Core-State Gate：仅保留会改变当前 NextIdea 的方法、约束、证据、未解决风险和完成判据；可由 artifact 复原的过程/清单外移并留指针。对每条内容做删除测试。父节点只接收抽象洞见，不复制子节点结果。
```

详细评分、示例和迁移规则放在专用 skill/reference 中，维持 progressive disclosure。

### 新增 `task-tree-core-state` skill

触发条件：

- 写入 `task-tree.md` 或 `subtrees/*.md`；
- tree-lint 超预算或检测到历史/重复；
- 完成节点并向父节点传播结果；
- 用户要求“精简、只留重点、去污染”。

skill 的固定输出应是：

```text
Retain: 活树保留的核心句
Move: 目标 artifact/树及短指针
Drop: 删除原因
Propagate: 是否向父节点传播、传播后的抽象洞见
```

### 增强 `tree-core-lint.mjs`

除字符预算外，至少检测：

- 已完成节点仍有长 `NextIdea`；
- `CurrentResult` 中出现文件数、包大小、截图数等 artifact 统计；
- 历史过程词和时间线词过多；
- 父节点复制子节点句子；
- 相同结论在多个字段/节点重复；
- `Approach` 同时出现旧方法和新方法；
- Notes/CaseStudy 已解决却仍在活树；
- 节点没有可执行 `NextIdea` 或完成判据；
- method tree 中出现稳定 architecture/background 详文。

lint 先输出建议，不直接删除；经 A/B 验证后，再让 postflight 对低风险项自动外移。

## 7. 验证方案

仅比较压缩后字节数不够。用 N2、N5、N11 三类节点做盲测：

1. 给评测 Agent 原节点或核心节点，不提供聊天历史；
2. 要求它回答：当前问题是什么、下一动作是什么、哪些约束不能违反、什么算完成、哪些方法已证伪；
3. 比较：
   - 下一动作恢复准确率；
   - 关键约束召回率；
   - 已证伪方法误重做率；
   - 人工定位时间；
   - bytes/token 数；
4. 目标：关键约束和下一动作准确率不下降，活树至少缩小 50%，人工定位中位时间不超过 30 秒。

如果压缩后字节更少但误重做率上升，说明删掉了真正核心信息；如果准确率不变但树仍很长，继续外移 artifact 和稳定背景。

## 8. 推荐实施顺序

1. 先实现 `task-tree-core-state` skill 和只读 lint，不改 schema。
2. 用 N2/N5/N11 生成候选重写并做 A/B，不立即覆盖原树。
3. 通过后把 Core-State Gate 加入完整协议与短 `AGENTS.md` 路由，保持原功能账本覆盖。
4. 建立 architecture tree，把 N1/N2/N9/N10 的稳定实现详情迁出。
5. 最后才考虑 Graphiti/Mem0 等外部记忆系统；当前 Markdown 分层与机械门禁足以先验证问题是否解决。

## 本地资料

- `papers/llmlingua.pdf` / `llmlingua.txt`
- `papers/longllmlingua.pdf` / `longllmlingua.txt`
- `../agent-context-research/papers/memgpt.pdf`
- `../agent-context-research/papers/reflexion.pdf`
- `github-repos.json` 与 `repo-*.md`

