# N6 — 节点内多模型协作

## 本步做什么

节点内配置多个 OpenAI-compatible 模型，并发独立分析当前节点；API key 不进 task-tree；对话按轮持久化；run 前 server 自动 searchRetrieval。

## 子步骤

1. **多模型配置与运行 API** — `/api/model-agents` GET/PUT/run；分模型 ok/error 响应。
2. **对话持久化与自动检索** — GET/PUT/DELETE `/api/model-conversations`；勾选协作时预检索关键词。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md) · 子树 [subtrees/N6-subtree.md](../../../subtrees/N6-subtree.md)
