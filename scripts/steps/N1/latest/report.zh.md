# N1 — 设计 Markdown 节点格式

## 本步做什么

定义 task-tree.md 的稳定字段（Problem/Approach/Input/Output/Metrics/CurrentResult 等）与 Edges 独立区，供前端解析与 Agent 写入。

## 子步骤

1. **固定节点字段 schema** — `schema-template.md` 骨架；§3 推理图原则已写入 AGENTS。
2. **推理图质量准则** — `graph-quality.md` 30 秒可读测试；I/O 需内联样例而非仅路径。

## 关联文件

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
