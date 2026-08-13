# LLM Task Graph Subtree

> Fold root: N6
> v2 并行试跑包

## N6 - 节点内多模型协作
- Position: 1350,950
- Size: 520,420
- Completion: 已完成
- Problem: 希望在节点内用多个模型，基于整棵树与各自 agent.md 独立分析同一问题。
- Approach:
  - 节点「模型协作」栏 + 右侧面板；配置进 `model-agents.json`，key 不进树。
  - 多模型并发；各自临时会话；可自主 search，服务端回填检索。
  - 页面内临时共享其它模型输出；刷新清空，不写 task-tree。
- Input: `task-tree.md`、当前节点、用户问题、`model-agents/*`、OpenAI-compatible 端点。
- Output: 协作栏、配置面板、`POST /api/model-agents/run`、分模型回答。
- Metrics: 多模型可配置且 key 不进树；能独立检索；失败有明确错误。
- Notes: 先并排回答，不做 judge 融合。
- CodeLoc:
- CurrentResult: `/api/model-agents` 仅 GET/PUT/run；对话可持久化到 `model-node-conversations.json`；审计见 `docs/subtree-parallel/v2-N6-findings.md`。
- RootCauseAnalysis: 持久共享历史会形成隐性记忆；运行中重读树会被边改边干扰 → 用临时会话 + 运行时树快照。
- CaseStudy:
  - case 1: key 进树会破坏共享边界 → 只进 gitignored 配置。
  - case 2: 统一预检索广播会抹掉「自己决定查什么」→ 改为模型主动 search。
- NextIdea: 增加融合裁判模型，归纳共识/分歧/盲点后建议写回 CurrentResult。
- SelectedSkills:


# GraphState

- Current: N6
- Next: N6
- NextPlan: （v2 N6 已完成）可选 sync-stub 或推进 judge 融合设计

# Edges
