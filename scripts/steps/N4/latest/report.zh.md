# N4 — 分析本地 skill 仓库与自动调用机制

## 本步做什么

扫描全局 skill 根目录（~/.codex、~/.agents、~/.orchestra），按节点 Problem/NextPlan 推荐 SKILL.md，前端多选写入 SelectedSkills，AGENTS 要求实际使用记入 skill-routing-log.md。

## 子步骤

1. **全局 skill 索引与推荐 API** — `POST /api/skills/recommend`；已生成 skill-repos-analysis.md。
2. **前端能力面板多选落盘** — 右侧能力面板；SelectedSkills 字段持久化。
3. **意图筛选与去重** — 过滤 `skill/skills` 等泛词，按任务意图加权；项目、kit、全局目录中的同名副本只保留一份，相同用户说明不重复展示。
4. **用户可读差异** — 每项直接展示“用途、亮点、命中原因”；`autoskill`、`skill-installer`、`skill-creator`、`ask-matt` 已给出互不混淆的说明。

## 本轮验证

- N4 查询只返回 `skill-creator`、`ask-matt`、`skill-installer`、`write-a-skill`，名称和说明均不重复。
- 建树查询中的多份 `task-tree-grill` 折叠为单个 `project:task-tree-grill`。
- `server.js` 与 `public/app.js` 通过 `node --check`。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
