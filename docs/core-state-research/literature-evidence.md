# 任务树只保留核心信息：文献证据复核

## 证据边界与核心定义

本文依据仓库已有 PDF/TXT、论文官方页面和作者官方 GitHub 仓库复核。下文以 **[论文事实]** 标记论文或官方仓库直接陈述，以 **[设计推论]** 标记迁移到本项目任务树后的判断。现有论文没有给出统一的“Markdown 任务树核心信息”定义。

**[设计推论] 核心信息是：相对于当前问题、执行焦点和下一次决策，仍然有效且不可再删的最小充分工作状态。** 一条内容只有在删除后会改变以下至少一项时才留在 live tree：下一动作或优先级；当前方法或关键约束；完成/验收判断；未解决风险；核验这些结论所需的最短证据指针。

操作上使用“删除测试”：删掉后若不改变下一动作、方法、约束、验收或风险判断，就不是 live tree 的核心。树内保留当前问题、方法、约束、2–3 个决定验收的测量结果、未解决风险、下一动作和证据路径；完整日志、工具过程、长案例、产物清单、旧方案和已解决 Notes 外移到 step evidence、文档或版本历史。

## 各工作的支持机制与局限

### LLMLingua / LongLLMLingua

**[论文事实]** LLMLingua 采用 coarse-to-fine 压缩：budget controller 先在 instruction、demonstrations、question 等组件间动态分配预算，再做迭代 token 级压缩。论文指出 instruction/question 应获得更多预算，而重复 demonstrations 可压得更多；报告最高约 20× 压缩且损失较小，但约 25×–30× 时性能明显下降，安全上限依任务而变。

**[设计推论]** 任务树不能只设总字符预算，应先按块执行“保留/外移/删除”，并给目标、约束、验收和下一动作高预算，给过程历史低预算。

**[论文事实]** LongLLMLingua 将重要性改为 question-aware：按当前问题筛文档，以 contrastive perplexity 评估 token 关联，动态分配压缩率并重排高相关内容。NaturalQuestions 特定设置中，论文报告约四分之一 token、性能最高提高 21.4%。局限是更换问题需重新压缩、计算约为 LLMLingua 两倍，复杂或隐含关系可能在粗筛中受损。

**[设计推论]** “核心”必须相对于当前 `NextIdea` 计算；执行焦点变化后应重新筛选。不能只靠词面相关性删除跨节点依赖、否定结果和用户硬约束。两项工作优化 Prompt token，并不解决事实时效、图状态或冲突替换。

来源：[LLMLingua（EMNLP 2023）](https://aclanthology.org/2023.emnlp-main.825/)；[LongLLMLingua（ACL 2024）](https://aclanthology.org/2024.acl-long.91/)；[官方仓库](https://github.com/microsoft/LLMLingua)。本地：`docs/core-state-research/papers/`。

### MemGPT

**[论文事实]** MemGPT 把有限 context window 视为主存，区分 main context 与 external context，通过函数分页移入/移出信息；被逐出的消息进入 recall storage，队列保存 recursive summary，并在 memory pressure/flush 阈值触发整理。

**[设计推论]** `task-tree.md` 应是工作记忆而非完整档案：树中只放当前状态与证据指针，详情外移；字段超预算、节点完成和 postflight 应强制触发整理，不能期待模型自发维护。

局限：**[论文事实]** 论文验证的是分层存储与检索，不是任务树语义正确性。**[设计推论]** 递归摘要仍会累积过期或错误信息，必须另设冲突替换、有效性和验收规则。

来源：[论文](https://arxiv.org/abs/2310.08560)；[历史仓库（现重定向 Letta）](https://github.com/cpacker/MemGPT)；[当前仓库](https://github.com/letta-ai/letta)。本地：`docs/agent-context-research/papers/memgpt.pdf` 及对应 TXT。

### Reflexion

**[论文事实]** Reflexion 把反馈和轨迹提炼成 verbal self-reflection，存入 episodic memory；轨迹是短期记忆，提炼后的经验是长期记忆。实践中 memory 通常限制为 1–3 条，AlfWorld 只保留最近 3 条反思。HotPotQA 消融中，自反思相对仅加入最近原始 trajectory 的方案提高 8 个百分点。

**[设计推论]** 完成或失败后应保存“触发条件—错误机制—下次动作”的可复用洞见，而非复制完整轨迹；重复洞见应合并。

局限：**[论文事实]** 方法依赖模型自评/启发式反馈，无成功保证，可能陷入局部最优；有限滑动窗口也是论文承认的限制。**[设计推论]** “最近三条”不能机械照搬，长期用户约束和高风险失败应按语义有效性保留。

来源：[论文](https://arxiv.org/abs/2303.11366)；[官方仓库](https://github.com/noahshinn024/reflexion)。本地：`docs/agent-context-research/papers/reflexion.pdf` 及对应 TXT。

### RAPTOR

**[论文事实]** RAPTOR 对文本块递归执行 embedding、clustering 和 abstractive summarization，自底向上形成不同抽象层级的树，并按查询从多层节点检索。它解决的是短片段检索缺乏整体文档语义的问题。

**[设计推论]** 父节点只应保存跨子节点成立的抽象结论、关键约束和指针，细节留在叶节点或 artifact；背景、方法、执行可分树管理。但 abstractive summary 可能隐藏关键例外，硬约束、否定结果和风险应受保护。

局限：**[论文事实]** RAPTOR 面向文档检索问答。**[设计推论]** 它未解决持续变化的执行状态、stale fact、完成字段清理或流程同步。

来源：[论文（ICLR 2024）](https://arxiv.org/abs/2401.18059)；[官方仓库](https://github.com/parthsarthi03/raptor)。

### Arbor / Hypothesis Tree Refinement

**[论文事实]** Arbor 的 HTR 树关联 hypothesis、artifact、evidence 和 distilled insight；叶节点结果被抽象为可复用 lesson 并向祖先传播。MLE-Bench Lite 消融中，完整 Arbor 的 Any Medal 为 81.82%，去掉树为 63.64%，保留树但去掉 insight feedback 为 54.54%，而三者 valid submission 均为 100%。这支持“树结构本身不够，必须传播提炼后的证据与洞见”。

**[设计推论]** 每个执行叶节点只绑定假设、测得结果、可复用洞见和证据指针；postflight 只向父节点传播可泛化 insight，不复制叶节点全文。建立多棵树若没有洞见提炼、合并和旧信息清除，仍会继续膨胀。

局限：**[论文事实]** 该工作截至复核时是 2026 年 arXiv 预印本，任务范围有限，主要依赖固定标量 evaluator，并承认真实研究的多目标性与 idea generation 局限。**[设计推论]** 它不能直接证明本项目应采用固定 CoreScore 或字段字数，这些需用下一动作恢复率、约束召回率、过期事实残留率和人工定位时间做 A/B 验证。

来源：[论文](https://arxiv.org/abs/2606.11926)；[官方仓库](https://github.com/RUC-NLPIR/Arbor)；[项目页](https://RUC-NLPIR.github.io/Arbor/)。

## 结论

证据最支持的不是“一次性通用摘要”，而是组合机制：live tree 只作工作记忆；以当前 `NextIdea` 做相关性筛选；完成叶节点只留测量结论、风险、洞见和路径；只把跨子节点成立的洞见向上传播；用删除测试与任务恢复测试验证压缩。字符数只能证明更短，不能证明信息仍然核心且充分。
