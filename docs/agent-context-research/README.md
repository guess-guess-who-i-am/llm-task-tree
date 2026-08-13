# 任务树与 Agent 指令重构研究

补充研究：[人怎样舒服地理解和推进复杂项目](human-capability-comfort.md)——从外部认知、信息觅食、中断恢复、自主性和人机协作重新定义人的能力与产品设计条件。

## 结论

当前问题不是“压缩几段文字”能解决，而是把四种不同生命周期的信息塞进了同一个上下文：长期规则、稳定背景、迭代方法、执行证据。建议改成“短入口 + 多树分层 + 自动校验 + 按需装载”。

最优先的风险是 `AGENTS.md` 已达 36,299 UTF-8 bytes，而 Codex 官方文档给出的项目指令默认合并上限是 32 KiB；超过预算后，靠后的规则可能无法进入上下文。当前文件还同时包含完整协议、安装 stub 和 tool-calling 规则，存在明显重复。

## 本地审计

| 文件 | UTF-8 bytes | 行数 | >240 字符行 | 结论 |
|---|---:|---:|---:|---|
| `AGENTS.md` | 36,299 | 555 | 16 | 超过 Codex 默认 32 KiB 项目指令预算 |
| `task-tree.md` | 24,198 | 374 | 7 | 背景、产品功能、方法、实验和维护规则混在一棵树 |
| `subtrees/N3-subtree.md` | 4,099 | 46 | 1 | 仍保存已被主树压缩协议替代的长过程说明 |
| `scripts/project.json` | 2,152 | 98 | 0 | 是静态节点目录，不是每轮必走的维护闭环 |
| `scripts/run.json` | 551 | 28 | 0 | 仍停在 N9，不能代表当前运行 |

另外，`task-tree.md` 的 `GraphState` 仍指向 N2 的旧 UI 验证，而本轮真实问题是上下文架构重构。这说明“用户手动维护焦点 + Agent 自觉同步”不足以防止状态漂移。

使用当前 `server/flow-script.js` 做本地 drift 检查后，新增 N11 没有造成 missing/stale node，但仍有 5 个旧状态不一致和顺序漂移：多行 `Completion` 没被 parser 识别，且 ST-P1/ST-P2 作为 task block 存在却不进入自动执行序列。这说明 flow 目前更像可视目录，而不是可靠执行状态机。

## 研究证据如何映射到本项目

| 来源 | 可复用结论 | 对本项目的设计含义 |
|---|---|---|
| Lost in the Middle (TACL 2024) | 相关信息位于长上下文中部时，模型利用能力显著下降 | 不要把关键规则埋在 500 行 AGENTS.md 或 300 行树的中部；入口必须短，当前焦点放首尾 |
| MemGPT | 将主上下文视作稀缺内存，外部信息按需换入 | 只默认加载 active method tree；背景树、架构树、历史证据按需检索 |
| Reflexion (NeurIPS 2023) | 将长失败轨迹压缩成少量经验，并把记忆限制为最近 1-3 条 | 节点只留当前结论、根因和最多 1-3 条有效经验；完整过程进入版本或 step audit |
| OPRO (ICLR 2024) | Prompt 应围绕可测目标迭代，而不是凭感觉越写越长 | 为 AGENTS/prompt 建 A/B eval：任务成功率、同步率、上下文体积、人工定位时间 |
| Anthropic Context Engineering | compaction 应保留架构决策、未解决问题并丢弃冗余工具输出；结构化笔记应在上下文外持久化 | 建立自动压缩器和结构化外部状态，不靠“每轮记得整理” |
| GitHub 2,500+ AGENTS.md 分析 | commands first、边界明确、渐进披露；避免把整套文档复制进 AGENTS.md | AGENTS.md 只保留项目地图、命令、边界、完成条件，细节链接到技能/协议 |
| OpenAI Codex AGENTS.md 指南 | 指令按目录层级覆盖，且受 `project_doc_max_bytes` 总预算约束 | 根 AGENTS.md 保持短；在 `llm-task-tree/`、`scripts/` 下放局部 AGENTS.md |

## 推荐目标架构

### 1. `AGENTS.md` 只做路由入口

目标：2-4 KiB，最多约 80 行。只保留：

1. 项目是什么，核心目录是什么。
2. 3-6 条最常用命令与验证命令。
3. 不可违反的边界：不擅自改 GraphState、不覆盖用户改动、写树前备份。
4. 任务路由：写树时读哪个 skill；写 flow 时读哪个局部协议；做研究时读哪个树。
5. 完成定义：代码验证、step evidence、必要时写树。

字段 schema、长示例、回滚细则、tool calling 通用规则不再复制到根 `AGENTS.md`。

### 2. 多树分层，而不是无限扩张一棵树

```text
graphs/
  registry.yaml        # 树目录、用途、owner、是否默认加载
  background.md        # 稳定背景与约束，低频更新，按需读取
  architecture.md      # 当前系统结构与关键决策，方法变化时读取
  method.md            # 当前迭代方法；唯一默认加载的工作树
  experiments.md       # 实验问题、指标与冻结结论，不保存原始日志
task-tree.md            # 过渡期指向/镜像 graphs/method.md，兼容现有 UI
versions/               # 历史快照
scripts/steps/          # 每步原始证据、prompt、输出
docs/adr/               # 已接受的长期决策
```

默认上下文只含 `registry.yaml` 的一行摘要、active tree 的 Current/Next 路径、当前节点及直接依赖。其它树只有在节点声明 `ContextRefs` 或检索命中时加载。

### 3. 区分“项目执行顺序”和“Agent 生命周期”

当前 `scripts/project.json` 只是项目节点顺序，不能保证 Agent 每轮更新树。建议新增固定的 `scripts/agent-loop.json`：

```text
读取 active tree 与 NextIdea
→ 编译最小 context pack
→ 执行一个节点/小组
→ 运行验证
→ 写 step evidence
→ 更新当前节点
→ 运行 tree-lint 与 flow-drift
→ 需要时压缩/归档
→ 停止或 chain-advance
```

这条生命周期应由脚本或 hook 强制，不应继续写成几十条自然语言提醒。`project.json` 只表达领域任务依赖；`agent-loop.json` 表达每轮都必须经过的维护协议。

### 4. 自动维护代替 Prompt 自觉

建议新增三个机械化组件：

- `context-pack`：只输出 Current/Next、NextIdea、当前节点、直接依赖、命中的背景片段和 SelectedSkills。
- `tree-lint`：检查字段预算、重复/冲突方法、失效路径、空指标、超长行、节点数、GraphState 指向、边端点。
- `postflight`：若方法/边变化则检查 flow drift；若完成了 flow task 则要求 `scripts/steps/<nodeId>/latest/`；超阈值则生成 compaction 建议。

建议硬阈值：active tree 5-12 个节点、正文 <=12 KiB；节点结果 <=3 条；根 AGENTS.md <=8 KiB；任何规则文件超过预算时 CI/本地检查失败，而不是只提示。

## 推荐迁移顺序

### Phase 1：先修指令入口，不改 UI

- 用 `AGENTS-lite.proposed.md` 替换根协议的职责。
- 将完整树协议留在 `llm-task-tree/AGENTS.task-tree.md`，但进一步拆成短入口 + references。
- 新增 `tree-lint` 与 postflight 检查；把是否更新树/flow 变成可验证结果。
- 用 10-20 个真实任务做 A/B，不直接全量推广。

### Phase 2：加入多树 registry 与 UI 切换

- 引入 background / architecture / method / experiments 四类树。
- UI 默认只打开 active method tree，可切换和引用其它树。
- 节点增加 `ContextRefs`，而不是复制其它树内容。

### Phase 3：上下文编译与生命周期执行流

- Agent 开始前自动生成最小 context pack。
- Agent 完成后自动运行 postflight、step evidence、drift 与 compaction。
- 将 `run.json` 变成真实本轮快照，不再长期停留在旧节点。

## 评估方案

选择 20 个真实任务，旧协议/新协议各跑一组：

1. **任务成功率**：测试、交付物或人工验收通过数。
2. **状态同步率**：完成后正确更新节点、step evidence、必要 flow 的比例，目标 >=95%。
3. **污染率**：树中被判定为过期、重复或冲突事实的字段比例，目标 <2%。
4. **上下文成本**：默认装载字节数和 token 数，目标下降 >=60%。
5. **人工定位时间**：用户找到当前焦点、证据和下一步的中位时间，目标 <=30 秒。

## 当前建议

不要立刻重写所有文件。下一轮先实现 Phase 1 的最小切片：`AGENTS-lite`、`tree-lint`、固定 postflight、10 个回归任务。若同步率和成功率提高，再做多树 UI；否则先调整机制，不继续增加规则文本。
