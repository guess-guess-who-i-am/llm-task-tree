# 在 Trae 中接入任务树

Trae 支持标准 MCP 服务。本仓库暂不假设 Trae 存在与 Codex、Claude Code 相同的 Git 插件市场格式，而是使用稳定的 stdio MCP 接入。

1. 先把 `llm-task-tree/` 部署到目标项目根目录。
2. 在 Trae 的 MCP 设置中导入本目录的 `mcp.json`，或复制其中的 `task_tree` 配置。
3. 确认命令的工作目录是项目根目录，并且 `node --version` 不低于 20.11。
4. 重启或刷新 MCP 服务，然后让 Agent 调用 `task_tree_focus`；需要界面时调用 `task_tree_open`。

如果你的项目把运行时放在别处，只需把 `args` 中的相对路径改成实际的 `mcp-server.mjs` 路径。
