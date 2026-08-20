# 项目上下文换代：什么叫“好的 checkpoint”

## 结论

好的 checkpoint 不是聊天摘要，也不是当前节点摘要，而是一次可追溯的项目状态编译。换到全新对话后，模型应同时恢复：根本目标、最新产品方向、用户约束、已验证进度、决定及其来源、被取代的旧结论、当前问题、下一动作和证据入口；同时不把工具日志、推理过程和系统转发误认成用户决定。

## 证据如何影响设计

- Codex 的开源 compaction prompt 要求保留进度、关键决策、用户偏好、剩余工作和关键引用，说明“续接所需状态”比普通叙事摘要重要。
- Pi 使用固定的 `Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context`，重复压缩时把上一代摘要再次输入，并累计文件操作。由此采用“上一代 checkpoint + 新增对话”的增量编译，而不是每次从最近若干轮重新总结。
- LongMemEval 专门测信息抽取、跨会话推理、时间推理、知识更新和拒答。由此必须测试最新纠错是否取代旧结论，以及模型是否会把建议错认成用户决定。
- LoCoMo 同时测问答、事件总结和长程时间/因果一致性。由此不能只做关键词命中测试，还要问“为什么这样决定、现在是否仍有效”。
- Lost in the Middle 表明把长历史全部塞回上下文并不能保证可靠检索。由此保留结构化状态和少量精确纠错，而不是恢复全部聊天。
- MemGPT、A-MEM 与 Zep 都支持分层或演化记忆、关联和时间有效性。由此将任务树锚点、持久 checkpoint、最近用户纠错和证据路径分层处理。

## 质量门禁

1. 定向完整：能说明根本目标和最新产品方向，二者不能被当前节点替代。
2. 状态可续接：区分“已验证”和“正在进行”，能给出一个可执行下一动作。
3. 知识更新正确：最新用户纠错覆盖旧计划；必要的旧结论标为“已取代”。
4. 来源归因正确：用户确认、模型建议、已验证事实和未知项分开；系统转发和 assistant 结论不能充当用户确认。
5. 可追溯：关键结论有任务树节点、文件、测试或 thread ID 入口。
6. 压缩有效：不携带推理、工具日志、重复原话和无关过程；长度只作为成本指标，不单独代表质量。
7. 多代稳定：在没有新真实用户要求时，第二次换代仍应恢复同一产品方向，不能依赖上一会话恰好还在最近窗口。
8. 失败安全：摘要服务异常时，有合格上一代 checkpoint 就沿用，并附加最新真实用户原话；没有合格旧状态时拒绝静默丢信息。

## 本项目实验

| 实验 | 输入 | 结果 |
|---|---|---|
| A：ROOT + N3 | 根目标和当前节点 | 失败；不知道 Agent IDE、Supervisor 与当前产品缺口。 |
| B：结构化 checkpoint | 全旧对话、树锚点、最近 6 轮 | 通过；新会话恢复 Agent IDE，并分清四项缺口顺序是模型建议。checkpoint 2013 字，续接提示 3443 字。 |
| C：归因与知识更新 | B 的新会话 | 通过；明确“ROOT+N3 足够”已失效，四项顺序未获用户确认。 |
| D：第二代换代 | 上一代持久 checkpoint，无真实新用户消息 | 通过；未重新依赖旧聊天，仍恢复 Agent IDE、Supervisor、当前进度和下一动作。续接提示 2946 字，首答约 12 秒。 |
| E：第三代真实换代 | 完成跨对话评审后的 6 条真实用户消息、当前树和上一代状态 | 通过；15 条结构化事实的栏目、临时指令、用户归因、证据、自证循环和当前节点门禁均无错误。新会话首次 `task_tree_focus` 用时 7ms，36.1 秒完成五项恢复。 |
| 故障注入 | 增量摘要遭遇上游 502 | 检出；实现改为有上一代合格状态时安全复用，没有时失败显式返回。 |

第二代会话：`01a01de8-d37c-72e0-b50c-6046bbf340b8`；第三代会话：`01a01e83-b455-7ae3-b90e-7d184b206fcf`。持久派生状态：`.task-tree-maintenance/context-checkpoint.json`；Markdown 仅为阅读视图。

## 跨对话评审融合

对话 `01a00f9d-4a74-7d53-a374-8f181d5fe284` 与本项目共同定位的首个断点是“混合输入被 LLM 自由摘要后，经弱格式检查进入持久记忆”。采纳其来源分型、消费者矩阵、硬负例、Worker 作用域隔离和 peer 证据协议；不搬运其完整 Hook/Prompt 文本、不让各角色共享一份大摘要，也不把对话链接或 peer prose 自动升级为事实。

主会话、Worker 和 Supervisor 共享根目标、用户确认、项目约束、证据索引与验收标准；Worker 的局部假设、工具输出、写集和未验收结论按 scope 隔离。会话链接只负责导航，接收方必须核查 `evidenceRefs`。

## 实现契约

- 从 `thread/read(includeTurns=true)` 读取真实可见 turns，只保留可核对的真实用户消息及其 `turnId`。
- 排除 `<codex_delegation>`、浏览器环境块、自动续接 prompt、checkpoint prompt 和只有“继续”的轮次。
- LLM 只提出结构化事实；系统规范化并验证 `kind/status/scope/sourceRefs/evidenceRefs/supersedes`，再确定性生成 Markdown 视图和恢复 prompt。
- `user_confirmed` 必须引用真实用户 turn；`verified_fact` 必须引用任务树或外部证据；派生 checkpoint 不得自证，临时生成指令不得持久化。
- 每次编译读取上一代 checkpoint；只有没有新用户消息且任务树指纹未变化时才能复用。树变化而编译失败时拒绝用旧状态静默兜底。
- 主会话 successor 不覆盖 `sandbox` 或 `approvalPolicy`，继承用户当前有效配置；内部 Planner、Worker、Coordinator 仍显式使用各自最小权限。

## 一手来源

- [Codex compaction prompt](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md)
- [Pi compaction and branch summarization](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)
- [LongMemEval](https://arxiv.org/abs/2410.10813)
- [LoCoMo](https://arxiv.org/abs/2402.17753)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- [MemGPT](https://arxiv.org/abs/2310.08560)
- [A-MEM](https://arxiv.org/abs/2502.12110)
- [Zep](https://arxiv.org/abs/2501.13956)

PDF 已保存到 `docs/agent-context-research/papers/context-handoff/`。
