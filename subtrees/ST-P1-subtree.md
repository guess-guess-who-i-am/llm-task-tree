# LLM Task Graph Subtree

> Fold root: ST-P1
> 此文件由子树并行试点生成；Worker Agent 只改本文件。

## ST-P1 - 子树试点A chain-step 泄露审计

- Completion: 已完成
- AssignedTo: worker-P1
- Problem: 验证 chain-step API 是否仍向 Agent 暴露后续 Chain 节点或完整 task-tree。
- Approach: 阅读 llm-task-tree-kit/server.js 中 buildChainStepContext、buildChainAgentPrompt；对照 skills/task-tree-chain-run/SKILL.md 要求，列出仍可能泄露的路径。
- Input: server.js 链式相关函数；GET /api/graph-state/chain-step 响应字段说明。
- Output: docs/subtree-parallel/findings-P1.md（≤80 行）+ 本节点 CurrentResult 摘要。
- Metrics: findings 至少 3 条可执行建议；每条标注 severity。
- Notes: 不要改代码，本轮只做审计文档。
- CurrentResult: 审计确认 stepMarkdown/step-context 裁剪有效（仅 ROOT+当前及之前节点、ChainPosition 无完整 Chain）。但 chain-step JSON 仍附带完整 chain/state.chain（HIGH）；chain-advance agentPrompt 未 redactFuture（MEDIUM）；/api/tree 与 /api/graph-state 可旁路全树/全链。已写 docs/subtree-parallel/findings-P1.md，共 5 条分级发现与 P0–P2 修复序。
- NextIdea:

# GraphState

- Current: ST-P1
- Next: ST-P1
- NextPlan: 审计 buildChainStepContext/buildChainAgentPrompt，写 findings-P1.md，更新本节点 CurrentResult。

# Edges
