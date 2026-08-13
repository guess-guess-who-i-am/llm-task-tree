# PDF 精读：对 Prompt 重构的直接约束

## 1. Lost in the Middle

阅读范围：摘要、长上下文位置实验、query-aware contextualization、更多上下文是否更好、结论。

- 模型对长上下文不是均匀利用：相关信息在开头或结尾表现较好，在中间显著下降。
- 仅扩大上下文窗口不能保证使用能力；部分扩展上下文模型与普通版本表现相同。
- 更多检索文档会提高 recall，但 reader accuracy 很早就饱和；继续增加材料主要增加成本、延迟和干扰。
- 实用建议是 rerank 和 truncation：让最相关内容靠前，并在边际收益下降后截断。

对本项目的约束：根 `AGENTS.md` 不能继续承载完整协议；关键 always-on 规则必须位于入口前部。详细 schema、示例和历史必须按触发条件加载。

## 2. MemGPT

阅读范围：摘要、主上下文、层级存储、队列管理、memory pressure、function executor、结论。

- 将上下文视为有限主存，而不是无限文档容器。
- 主上下文分为只读 system instructions、可读写 working context、滚动 FIFO queue。
- 外部 context 通过函数按需换入；被驱逐内容仍保留在 recall/archive storage。
- 在约 70% 容量时发出 memory pressure，在满载时递归摘要并驱逐；检索分页以避免再次溢出。
- 上下文管理与控制流是同一个系统问题，不能只靠静态 prompt 提醒。

对本项目的约束：`AGENTS.md` 是只读系统入口；`task-tree.md` 是工作上下文；`versions/`、背景树、step evidence 是外部存储。必须有 preflight/context-pack 和 postflight/compaction，而不只是自然语言规则。

## 3. Reflexion

阅读范围：摘要、Actor/Evaluator/Self-Reflection、短期/长期记忆、实验分析、局限与结论。

- 有效改进需要 Actor、Evaluator、Self-Reflection 三个角色；单纯保留轨迹不是学习。
- 失败轨迹要先经评价，再压缩成具体、可行动的语言经验。
- 短期记忆保存当前轨迹，长期记忆保存提炼后的经验；论文实际把长期经验限制在 1–3 条。
- 仅 episodic memory 不如 self-reflection；实验中反思相对只放最近轨迹有额外提升。
- 自评可能落入局部最优，必须依赖外部测试、启发式或独立评价器。

对本项目的约束：`RootCauseAnalysis` 不能保存全过程；应保存“评价结果 → 根因 → 下一轮动作”。Prompt 修改必须运行回归集，不能由修改者自己宣称功能等价。

## 4. OPRO

阅读范围：meta-prompt 设计、optimization trajectory、稳定性、过拟合分析、局限。

- Prompt 优化需要明确 objective、constraints、examples、候选方案及其 score。
- 低质量候选会显著污染后续生成；轨迹应保留高分候选，而不是完整历史。
- 同一步生成多个候选可降低单次随机性；探索与利用需要分开控制。
- 训练准确率可能比测试高 5%–20%，应使用验证集、早停和最终测试。
- 只有错误样例还不够；需要把错误原因压缩成比聚合分数更丰富的反馈。

对本项目的约束：本次不能只产出一个“看起来更短”的 Prompt。必须保留原文、建立逐句功能标签、生成候选、做功能覆盖验证，并保留回滚入口。

## 综合设计原则

1. Always-on 入口只保存高价值不变量和路由。
2. 详细功能不删除，移动到明确触发的外部协议。
3. 原始 Prompt 永久冻结；每个原始语句都有功能 ID 和新落点。
4. 新 Prompt 每个功能 ID 必须可从入口触达。
5. 用自动验证和真实任务回归评价，而不是按字节数宣布成功。

