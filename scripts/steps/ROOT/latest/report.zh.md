# ROOT — 建立可共享的大模型任务上下文

## 本步做什么

项目总目标：把大模型隐性上下文外置为可编辑、可审计的 Markdown 任务图，让人类 30 秒内判断焦点与阻塞。

## 子步骤

1. **定义共享任务图协议** — 见 `AGENTS.md` §0 精炼写树规则；输入样例 `task-tree.md` GraphState 区。
2. **维护 GraphState 焦点** — 前端 `saveTree` 自动落盘；执行流程 `focusId` 对齐 `GraphState.Current`（当前 N2）。

## 关联文件

- [step.json](./step.json)
- [prompts/01.zh.md](./prompts/01.zh.md)
