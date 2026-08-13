# ST-P1 — 子树试点A chain-step 审计

## 本步做什么

审计 chain-step API 是否向 Agent 泄露后续 Chain 节点或完整 task-tree；产出分级 findings 与 P0 redaction 修复序。

## 结论摘要

stepMarkdown 裁剪有效；chain-step JSON 仍附带完整 chain（HIGH）；P0 redaction 已合入 server。

## 关联

- [findings-P1.md](../../../docs/subtree-parallel/findings-P1.md)
- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
