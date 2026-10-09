# N3：自动并行执行与任务树合并

## 取消工具轮数上限与DeepSeek摘要交接

40轮复现先失败，取消后连续55轮完成、第45轮停止通过。DeepSeek现在自动整理旧对话和已消费工具历史，保留当前请求、系统规则与最新完整工具组，全文对话另存不删；摘要带指纹，编辑旧消息后失效。真实共享Worker与本机HTTP模型替身端到端完成50次工具调用和重启复用，不保存原始工具日志。此处没有真实模型质量或提速结论，默认总期限、停止、Hook与请求重试未取消。机制与验收边界见[本轮说明](../../../../docs/deepseek-context-lifecycle.zh.md)。


本轮按用户要求移除独占写集、四 Worker 上限、审批、审核和产品测试阶段。完整实现、实际测试命令、真实模型输出、耗时和边界见[本轮报告](../../../../docs/subtree-parallel/automatic-parallel-test-report.zh.md)。

真实 Codex 双 Worker 同文件冲突并自动应用已通过；自动 Planner 已强制至少两个可立即并行 Worker，并按独立交付物最大化 runnable frontier；独立 Mac IDE、8/12/20 路调度、8 参与者单 resolver、历史复用、即时追加、完整文本及分发一致性通过。项目外副作用不在 Git 合并范围；prompt 不能证明拆分数量或粒度全局最优。

[任务树持久化回执](../../../../docs/subtree-parallel/automatic-tree-receipt.zh.md)逐字段记录旧值 → 新值，GraphState 焦点未变；flow drift=false，无需重排项目节点顺序。

此前的审核流程报告已归档至[历史报告](../report-before-automatic-20260922.zh.md)，不代表当前产品行为。
