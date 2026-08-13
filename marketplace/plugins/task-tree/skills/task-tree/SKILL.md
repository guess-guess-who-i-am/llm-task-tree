---
name: task-tree
description: 用 task_tree_* 工具读写项目任务图：把整张图画进对话、读焦点、按字段写树（自动备份+精炼门禁）、链式推进一步、检索本地知识库、多模型协作、自动整理画布。当用户提到任务图/任务树/节点/焦点/下一步/链式/自动整理，或想看图、让你画出来时使用。
---

# 任务图（task-tree）

任务图是人和 Agent 共享的外置记忆，不是文档：

- `task-tree.md` 的每个节点保存**当前有效结论**（Problem / Approach / Input / Output / Metrics / CurrentResult / RootCauseAnalysis / NextIdea…），历史进 `versions/`。
- 节点语义字段默认写简明中文；`LLM`、`token`、`API`、必要名称、ID 和路径可以保留。节点里不粘贴代码、JSON、命令、公式、原始数据、日志或复杂英文专业术语，精确内容放证据文件。
- `# GraphState` 指定人类/项目主视角。单 Agent 时执行 `Next` 节点的 `NextIdea`；多 Agent 有执行范围时，优先级是“用户最新要求 > 本 Agent 范围 > 全局 Next”，全局 Next 只作背景。`NextPlan` 是用户备忘，禁止执行。
- 执行顺序看 `scripts/project.json`，不要用节点 ID 或画布位置推断。

## 每轮怎么走

1. `task_tree_focus` —— 先读焦点；有执行范围时看 `assignedNodes`，没有才用全局 Next。
2. `task_tree_node {nodeId}` —— 读该节点全部字段（会自动在 `subtrees/`、`trees/` 里找）。
3. 干活。需要证据就 `task_tree_knowledge`（本地 Markdown 知识库 / 联网）或 `task_tree_models`（多模型并行回答）。
4. `task_tree_write {nodeId, fields, reason}` —— 把结论写回节点。**不要手改 markdown**：这个工具会自动备份到 `versions/`、跑精炼门禁、同步流程状态，并且写不动 GraphState 焦点（焦点归用户）。
5. `task_tree_check_compact` —— 写完自查；`ok=false` 就继续语义精炼（保留结论/数字/风险，别机械截断）。
6. 结构或顺序变了：`task_tree_flow_write {action:"sync_status"}`；漂移详情用 `task_tree_flow_status`。

## 工具清单

只读：

- `task_tree_focus`：活动树、`Current`/`Next`、Next 节点的 `NextIdea` 与完成度。
- `task_tree_scope`：为手动并行会话创建/读取/关闭执行范围；内置 coordinator 会自动创建并注入。
- `task_tree_node`：按 ID 读节点全字段。
- `task_tree_open`：把**可交互的任务图界面**嵌进对话——就是那个网页本身，用户能拖节点、改字段、切执行流程、查知识库。用户说"打开任务图 / 我要自己操作 / 在这里编辑"时用它。
- `task_tree_render`：把整张图截成图片返回。用户只想看一眼不动手时用它（"画出来 / 现在长什么样"），别改用文字罗列节点。树很大字太小就把 `scale` 调到 2。
- `task_tree_check_compact`：字段预算、长行、节点代码和英文长段门禁。
- `task_tree_flow_status`：`scripts/project.json` 的块顺序、状态与漂移。

写入（都走本地服务，自动备份）：

- `task_tree_write`：改节点字段，或整树覆盖。`reason` 必填；有执行范围时只允许字段补丁并校验节点权限。
- `task_tree_chain`：`step` 取当前该做的一步；`advance` 沿 `Chain` 推进一步；`force_next` 强制下一节点。**每轮只推进一步。**
- `task_tree_subtree`：`read` / `context` / `write` / `sync_stub` / `unfold`。折叠一个节点 = 先 `write` 子树文件，再 `sync_stub` 把摘要同步回主树。
- `task_tree_layout`：用界面同一份轮廓算法重排 `Position`（`dryRun` 只算不写）。写完提醒用户刷新界面。
- `task_tree_versions`：`list` / `restore` 版本回退。
- `task_tree_flow_write`：`sync_status` / `rebuild` / `write_step` / `drift`。

辅助：

- `task_tree_knowledge`：`search` / `ask` / `web` / `status` / `reindex`。
- `task_tree_models`：`list` / `health` / `run`（节点级多模型协作）。
- `task_tree_skills`：按节点意图推荐本地 skill（只给候选，不写回 `SelectedSkills`）。
- `task_tree_server`：`status` / `start` / `open` / `stop`。需要服务的工具会自动拉起，一般不用手动调；`open` 会在**用户桌面**打开界面——模型看不到画面，数据请用上面的工具读。

## 边界

- 焦点（`Current` / `Next` / `NextPlan`）只由用户在界面里定；Agent 写树不会改动它。
- `task_tree_open` 和 `task_tree_render` 都是给**用户的眼睛**用的：不管界面还是图片，你自己要读数据还是得调 `task_tree_focus` / `task_tree_node`。
- `task_tree_open` 依赖宿主支持 MCP Apps（Codex 桌面端需要 `features.enable_mcp_apps = true`）。界面没出来就退回 `task_tree_render` 出图，或 `task_tree_server action=open` 在桌面打开。
- 除了这两个，不要自己想办法截图或解析页面：需要什么信息就调对应工具。
- 门禁不过就不能收工：按报告继续压缩、中文化，或把代码与原始证据移出节点。
