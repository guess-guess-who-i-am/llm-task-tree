# N7 — 集成 Markdown 知识库检索面板

## 最新交付：侧栏可以完整上下滚动

- 根因：知识库正文超出可视区时仍使用 `overflow: hidden`；检索/问答区又被 flex 从所需 288px 压到 20px 并裁剪。
- 修复：正文负责整体纵向滚动，检索控制区不再收缩；历史记录超过上限后单独滚动。
- 验证：在 482px 可视高度下，1133px 内容可滚动 651px 并到达底部，检索操作区可见；焦点透镜完整回归同时通过。
- 回归测试：`scripts/test-knowledge-sidebar-scroll.mjs`。

## 本步做什么

左侧知识库面板：扫描 `knowledge/` Markdown、批量 embedding、余弦检索、问答与 web search 合并；`.env` 统一配置；reindex 支持 batch 并发（默认 concurrency=40）。

## 子步骤

1. **Embedding 索引重建** — `/api/knowledge/reindex` + reindex-status 进度；9 条 knowledge/web-search 路由。
2. **并发 embedding 吞吐** — 修复串行 await；可用 `KNOWLEDGE_EMBEDDING_CONCURRENCY` 降级。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
