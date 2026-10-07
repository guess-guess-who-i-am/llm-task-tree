# llm-task-tree

把项目的任务图（`task-tree.md`）变成 Agent 可直接调用的工具：读焦点、按字段写树、链式推进、检索知识库、自动排版。

## 别人怎么装

### 1. 拿到本仓库（kit）

```bash
git clone https://github.com/guess-guess-who-i-am/llm-task-tree.git
```

装了 codex CLI 的话，`codex plugin marketplace add guess-guess-who-i-am/llm-task-tree` 是等价的取法，但不是必需的。

### 2. 部署到你的项目

```powershell
powershell -File .\deploy-task-tree.ps1 -ProjectRoot <你的项目路径> -UseSharedKit
```

会写入：`task-tree.md`、`AGENTS.md`、`.cursor/mcp.json`、`.cursor/rules/`、`llm-task-tree/` stub，并在这台机器上注册 Codex（`~/.codex/config.toml`）。

### 3. 重启客户端

- **ChatGPT 桌面应用**：重启后进 Plugins，来源选「任务图（llm-task-tree）」，插件带图标和五条一键提示词，15 个工具可用。说一句「看一眼任务图」，整张图直接画在对话里。不需要敲任何 codex 命令。
- **IDE 扩展（VS Code / Cursor 里的 Codex）**：官方没给插件面板，但工具照样能调——`[mcp_servers.task_tree]` 是全局注册的。
- **Cursor**：提交仓库里的 `.cursor/mcp.json`（已用 `${workspaceFolder}`，可直接分享），重启生效。

只想注册 Codex、不装项目：`node .\scripts\install-codex-mcp.mjs --with-plugin`（可重复执行，`--remove` 撤销）。

## 需要

- Node.js 20.11+
- Windows（当前启动器与安装脚本以 PowerShell 为主）
- macOS：运行 `./install-macos.sh <项目目录>`；仓库内的独立 IDE 入口见 `../macos/IDE/`
- Linux / 其它 POSIX：运行 `./install-linux.sh <项目目录>`，再使用生成的 `llm-task-tree/open-task-tree.sh`

macOS 独立 IDE 会把 Node.js 22 LTS 放在自己的 `runtime/`，把任务图和运行状态隔离在 `macos/IDE/workspace/`，不会默认改动系统 Node 或全局 Codex 配置。

模型配置使用一个共享根 `.env`：默认是安装目录上两级的 `.env`（也可用 `TASK_TREE_GLOBAL_ENV_FILE` 指定）。新建项目只需有任务树目录；项目内 `.env` 仅用于提供非空的项目级覆盖，不需要重复保存 API key。

## 文档

- 分发说明：仓库根旁的研究仓库里有 `docs/share-with-others.zh.md`；插件用法见 `marketplace/plugins/task-tree/README.md` 与 `marketplace/plugins/task-tree/skills/task-tree/SKILL.md`
- 完整协议：`AGENTS.task-tree.md`

## License

MIT
