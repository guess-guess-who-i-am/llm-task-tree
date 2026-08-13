# N7 — 集成 Markdown 知识库检索面板

## 本步做什么

左侧知识库面板：扫描 `knowledge/` Markdown、批量 embedding、余弦检索、问答与 web search 合并；`.env` 统一配置；reindex 支持 batch 并发（默认 concurrency=40）。

## 子步骤

1. **Embedding 索引重建** — `/api/knowledge/reindex` + reindex-status 进度；9 条 knowledge/web-search 路由。
2. **并发 embedding 吞吐** — 修复串行 await；可用 `KNOWLEDGE_EMBEDDING_CONCURRENCY` 降级。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
