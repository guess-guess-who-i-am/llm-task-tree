# 把任务图分发给别人

三条路径，按"对方要做多少事"从少到多排列。全部经 `node scripts/test-share-install.mjs` 端到端验证（临时项目 + 临时 `CODEX_HOME`，不碰真实配置）。

## 前提：别人拿到的是什么

真正干活的运行时是 **kit**（`llm-task-tree-kit/`：`server.js`、`server/`、`public/`、`scripts/mcp-server.mjs`）。插件只带技能文档和 MCP 定义，不含运行时。

所以对方的最小动作永远是两步：拿到 kit → 在自己项目里部署一次 stub。

```powershell
powershell -File <kit>\deploy-task-tree.ps1 -ProjectRoot <项目路径> -UseSharedKit
```

这一步会写好：`task-tree.md`、`AGENTS.md`（含任务图协议块 + MCP 工具优先规则）、`scripts/`、`.cursor/rules/*.mdc`、`.cursor/mcp.json`、`llm-task-tree/` stub（含 `mcp-server.mjs`）。

`task_tree_open`（把可交互界面嵌进对话）要求宿主支持 MCP Apps：目前只有 ChatGPT 桌面应用有这个渲染层，且 `[features]` 里要开 `enable_mcp_apps`。IDE 扩展和 CLI 没有界面层，这个工具会退回给一个本地地址。

`task_tree_render`（把整张图截进对话）多一个前提：机器上要有 Chromium 内核浏览器。Windows 自带 Edge 就够，macOS / Linux 装了 Chrome 或 Chromium 也行，都没有就设环境变量 `TASK_TREE_CHROME` 指向可执行文件。缺了只影响这一个工具，其余工具照常。

## 路径 1：Cursor —— 随仓库分发，对方零配置

`.cursor/mcp.json` 用 `${workspaceFolder}` 写死相对入口，不含任何本机绝对路径，可以直接提交进仓库：

```json
{
  "mcpServers": {
    "task_tree": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/llm-task-tree/mcp-server.mjs"]
    }
  }
}
```

对方克隆仓库、信任工作区，重启 Cursor 即可用上 16 个工具。前提是仓库里带着 `llm-task-tree/` stub 和一份可达的 kit。

## 路径 2：Codex 桌面端 —— 装 kit 时自动注册（不需要 CLI）

ChatGPT 桌面应用、IDE 扩展（VS Code / Cursor 里的 Codex）和 CLI 读的是同一个 `~/.codex/config.toml`，插件与 MCP 都由这份配置驱动。所以对方只要克隆仓库、跑一次部署：

```powershell
powershell -File kit\deploy-task-tree.ps1 -ProjectRoot <项目路径> -UseSharedKit
```

安装末尾会调 `Ensure-CodexRegistration`，往 `config.toml` 写三个块：`[mcp_servers.task_tree]`、`[marketplaces.llm-task-tree]`、`[plugins."task-tree@llm-task-tree"]`，另外在 `[features]` 里补一行 `enable_mcp_apps = true`。**重启 ChatGPT 桌面应用**后，它会把插件物化到 `~/.codex/plugins/cache/llm-task-tree/task-tree/<版本>/`，Plugins 目录里选来源「任务图（llm-task-tree）」就能看到，16 个工具可用。

那行 `enable_mcp_apps` 是嵌入式界面的开关：`task_tree_open` 返回一个 `ui://` 资源，宿主打开这个特性才会把它渲染成沙箱 iframe，里面直接跑本地任务图界面（能拖能改，不是截图）。已有的值不会被改写——如果谁手动关过，得自己改回来。卸载（`--remove`）只会撤掉我们加的那行 `= true`，不动别人的设置。

**分清两个界面**：插件目录只存在于 ChatGPT 桌面应用（Codex 模式，或 ChatGPT 模式打开 Work 开关）。IDE 扩展按官方说明没有插件面板——但 `[mcp_servers.task_tree]` 是全局的，工具在 IDE 扩展和 CLI 里照常可用，只是不出现在"插件列表"这个 UI 里。

改了插件要让桌面应用看到新版本，必须**提升 `.codex-plugin/plugin.json` 的 `version`** 再重启：安装缓存按版本号分目录，版本不变就还是加载旧目录。`codex plugin marketplace upgrade` 帮不上忙，它只认 Git 市场，对本地市场会直接报错。

只想注册不装项目：`node <kit>/scripts/install-codex-mcp.mjs --with-plugin`。

注册的是**共享 kit** 的入口而不是某个仓库路径，所以一台机器注册一次，所有装了 stub 的项目都能用；每个会话按自己的 cwd 定位项目根。写入前自动备份 `config.toml`，重复执行是空操作，`--remove` 整块撤销；机器上没有 `~/.codex` 时安装脚本直接跳过，不会凭空造配置。

装了 codex CLI 的人还可以 `codex plugin marketplace add guess-guess-who-i-am/tree` 从 Git 市场取插件（仓库根的 `.agents/plugins/marketplace.json` 指向 `./marketplace/plugins/task-tree`）。Git 快照登记由该命令自己管理，安装脚本只写已验证的本地市场形态（`source_type = "local"`），不伪造 Git 字段。

## 路径 3：本地市场 / 本地插件（不发布也能用）

- Codex：`node <kit>/scripts/install-codex-mcp.mjs --with-plugin` 会把 kit 里的 `marketplace/` 注册成 `[marketplaces.llm-task-tree]`，插件即刻可见。
- Cursor：把 `marketplace/plugins/task-tree/` 拷到 `~/.cursor/plugins/local/task-tree/`，Developer: Reload Window。

## 官方市场收录

- **Codex**：本地/Git 市场已经等价于"能装"，进 OpenAI 官方目录是另一套流程。
- **Cursor**：官方市场是策展制——必须公开开源仓库 + 人工审核，提交不等于收录。团队版可以用 Team Marketplace 从仓库导入，绕开审核。

## 一个包，两个宿主

`marketplace/plugins/task-tree/` 同时是 Codex 插件和 Cursor 插件：

```
.codex-plugin/plugin.json   # Codex 清单（含上架元数据 + mcpServers 指向下面那个文件）
.cursor-plugin/plugin.json  # Cursor 清单
.mcp.json                   # 两边共用的 MCP 定义，指向包内 runtime/scripts/mcp-server.mjs
runtime/                    # 包自带的运行时：MCP 入口 + server.js + server/ + public/
assets/icon.png             # 360×360，桌面应用输入框里的图标
assets/logo.png             # 512×512，插件目录里的 logo
skills/task-tree/SKILL.md   # 两边共用的技能文档
README.md
```

`runtime/` 是 `node scripts/build-plugin-runtime.mjs` 从源码拷进去的，所以包是自足的：装了插件、项目里有 `task-tree.md`，工具就齐了，不再要求对方先装 kit。文件名 `.mcp.json` 必须带点——Codex 的能力扫描只认这个名字，不带点是 Cursor 的写法，Codex 会当它不存在，插件于是一个工具都不提供且不报错。

图标由 `node scripts/build-plugin-assets.mjs` 生成：纯 Node 光栅化（SDF + 超采样 + zlib 写 PNG），不依赖浏览器或图形库，别人机器上重跑结果一致。

## 验证

```bash
node scripts/test-share-install.mjs     # 12 例：装到陌生项目、注册到空白 CODEX_HOME、跑通 17 个工具、审计打包后的插件、kit 是否落后于源码
node scripts/test-plugin-package.mjs    # 6 例：真启动包内入口，核对工具集与 ui:// 资源，并和自己的文档对账
node scripts/test-mcp-server.mjs        # 26 例：工具行为回归，含真实截图与 PNG 编解码
node scripts/test-plugin-manifest.mjs   # 6 例：清单字段、资源尺寸、市场 policy
```
