# 任务图（task-tree）

把项目里的 `task-tree.md` 变成 Agent 可以直接调用的工具：在对话里直接看整张图、读焦点、按字段写树、链式推进一步、跑执行流程漂移检查、检索本地知识库、自动整理画布。

不是"再教模型一遍协议"，而是让协议变成 18 个 `task_tree_*` 工具：写树自动备份到 `versions/`、自动过精炼门禁、自动同步 `scripts/project.json` 的流程状态，并且**改不动** `GraphState` 的 `Current / Next / NextPlan`——焦点永远是人来定。

说一句「打开任务图」，那个网页界面会**整个嵌进对话**：能拖节点、改字段、切执行流程视图、查知识库，和在浏览器里操作完全一样，只是不用另开窗口。这走的是 MCP Apps——工具返回一个 `ui://` 资源，宿主把它渲染成沙箱 iframe，里面装的就是本地界面本身，所以不存在"另做一套简化版"的走样问题。

只想瞄一眼不动手，就说「画一张任务图」，`task_tree_render` 给一张静态 PNG。

## 前置条件

插件**自带运行时**（包内 `runtime/`：MCP 入口 + `server.js` + `server/` + `public/`），所以目标项目里只要有一份 `task-tree.md` 就能用，不需要先装 kit，也不需要项目里的 stub。

需要 Node.js 20.11 以上——宿主用 PATH 里的 `node` 启动包内入口。

kit 仍然有用，但管的是插件以外的事：一键部署新项目、桌面启动器、Codex/Cursor 的 hooks、`.cursor/mcp.json`。项目里已经有 kit stub 时也不冲突：插件优先用自己包里的运行时，不会去牵动 kit 那一份。

## 安装

### Codex（ChatGPT 桌面应用，不需要 CLI）

**装插件本身就够了。** 清单里的 `mcpServers` 指向包内的 `.mcp.json`，宿主照它启动包内入口，17 个工具随插件一起到位——不需要再往 `config.toml` 写 `[mcp_servers.task_tree]`。

只有一件事要手动确认：嵌入式界面依赖宿主的 MCP Apps 渲染层，`~/.codex/config.toml` 里得有

```toml
[features]
enable_mcp_apps = true
```

没开的话工具照跑，但只回文字，界面不出来。改完**重启 ChatGPT 桌面应用**。

以前手工注册过全局 `[mcp_servers.task_tree]` 的话，那一条现在是多余的，而且正是"文档说有 17 个工具、实际只有 15 个"的来源——它会一直加载当初写死的那份运行时。删掉它，或者跑一次 `node <kit>/scripts/install-codex-mcp.mjs`（现在会把指错地方的那一段重写掉）。

想连 kit 一起装（要启动器和 hooks）：

```powershell
powershell -File kit\deploy-task-tree.ps1 -ProjectRoot <你的项目路径> -UseSharedKit
```

装了 CLI 的话，`codex plugin marketplace add guess-guess-who-i-am/llm-task-tree-workspace-backup` 是另一条等价的取插件路径，但不是必需的。

## 在桌面应用里怎么用

插件目录只在 **ChatGPT 桌面应用**里有（Codex 模式，或 ChatGPT 模式打开 Work 开关）：**Plugins → 选来源「任务图（llm-task-tree）」→ task-tree**。装上之后新开一个会话，输入框的 `+` 里能看到它的图标，几条一键提示词点了就跑，第一条「打开任务图，我要自己拖着看」会把可交互的界面嵌在对话里。

IDE 扩展（VS Code、Cursor 里的 Codex）**没有插件面板**——这是官方限制，不是配置问题。想在 IDE 扩展里也用上这些工具，就得走 `config.toml` 的全局注册（`node <kit>/scripts/install-codex-mcp.mjs`），因为插件声明的服务只在认插件的宿主里生效。

## 从界面反向发给 Codex

网页界面工具栏上的 **Codex** 按钮反过来走：它直接替你在桌面应用里发一轮，不用你切过去打字或按回车。

按钮右边的 `▾` 分两段。上半段是**发什么**，三条都由服务端按当前的树现算，不是写死的模板：

| 发什么 | 内容 |
|---|---|
| 打开任务图 | 一句 `调用 task_tree_open`，在桌面浏览器可靠打开；宿主支持 MCP Apps 时也嵌进对话，不动树 |
| 执行下一步 | Next 节点的 id、标题和它的 **NextIdea**，外加三条约束：只做这一步、不许读 `NextPlan`、不许改焦点，做完把结果写回该节点的 `CurrentResult` |
| 链式循环推进一步 | 服务端 `chain-step` 算出来的 `agentPrompt`（含单步上下文与停机规则） |

没有可执行依据时那一条是灰的并写明原因（Next 没有 NextIdea、或者 `Chain` 为空该停机），不会白花一轮。

下半段是**发到哪**：默认是本项目上次那条会话（id 记在项目里的 `.task-tree-thread`，新建的那条会被命名成「任务图工作台」方便在侧栏找），所以上下文是连着的，你可以就在那条里接着提要求。点列表里另一条只是**换目标，不发送**；换完再点上半段。「＋ 新开一条会话」同理，只是把下次发送改成新开。

底部执行链那一栏还有一个 **▶ 直接开跑**，等于「链式循环推进一步」那一档：点一下就发，不用再复制 loop 命令（命令文本和「复制」留着，给 Cursor 或别的 Agent 用）。

看界面本身**不需要**这个按钮，也不需要模型：双击 `打开任务图.cmd`，或直接开这个项目的固定地址（每个项目一个，按项目路径推导，重启不变）。按钮解决的只是"让可交互的图出现在对话里"这一件事。

## 在 Codex 桌面端打开某个项目的图

让会话开在那个项目的目录里，然后点插件的第一条建议「打开任务图，我要自己拖着看」（或者直接说这句）。那个项目的可交互界面就嵌在对话里。

不用进项目目录双击启动器，也不用知道端口：Codex 是**按会话**启动 MCP 服务并把会话目录交给它，所以 `~/.codex/config.toml` 里那一条全局注册对所有项目都成立。实测在一个后端（工作目录设成两个项目都不是的中立目录）里开两条会话，同一个 `task_tree_open` 分别回各自的树与各自的地址（14 节点 / `:5410`，18 节点 / `:5428`）。要复验：`node scripts/probe-mcp-cwd.mjs --tool task_tree_open <项目A> <项目B>`。

前提是 `~/.codex/config.toml` 里有 `[features] enable_mcp_apps = true`；桌面端偶尔会在重启时清掉它，那时图会退化成一句带地址的文字提示。

## 一台机器上的多个项目

每个项目是完全独立的一份：自己的树、自己的执行链、自己的固定端口、自己的 Codex 会话。所以不用担心串味，也不用记端口。

标题旁的**项目菜单**列出这台机器上装过任务图、且目录还在的项目（安装器记在 `%LOCALAPPDATA%\LLMTaskTree\projects.json`），按最近改过的排前面。点一条：那个项目的服务没在跑就先按它自己的端口拉起来，然后页面跳过去。切过去之后 Codex 按钮发的是**那个项目**的下一步，发到**那个项目**的会话里。

## 改了插件之后怎么刷新

1. 改源码或 `marketplace/plugins/task-tree/`（清单、技能、图标）。
2. **重新打包运行时**：`node scripts/build-plugin-runtime.mjs`。包里那份是拷贝，不重打就还是旧代码。
3. **提升 `.codex-plugin/plugin.json` 的 `version`**——桌面应用按 `~/.codex/plugins/cache/<市场>/<插件>/<版本>/` 装，版本不变就还是旧目录。
4. 重建 kit（`scripts/build-kit.ps1`），kit 里带着一份市场副本。
5. 重启 ChatGPT 桌面应用。

`codex plugin marketplace upgrade` 对这里没用——它只认 Git 市场，本地市场会直接报错。

改包结构时注意两个**静默失效**点（都不报错，只是插件一个工具都不提供）：清单里必须有 `mcpServers`，指向的文件必须叫 `.mcp.json`（带点；不带点是 Cursor 的写法，Codex 的能力扫描不认）。下面第一条会把这两点连同"包里到底能不能启动、提供的工具和自己的文档是否一致"一起验掉：

```bash
node scripts/test-plugin-package.mjs        # 真启动包内入口，核对工具集、ui:// 资源、运行时是否落后于源码
node scripts/build-plugin-assets.mjs        # 重新生成 360/512 图标，纯 Node，不依赖浏览器
node scripts/test-plugin-manifest.mjs       # 清单字段、资源尺寸、市场 policy 全量校验
```

### Cursor

两条路，任选：

- **随仓库分发**：项目里提交 `.cursor/mcp.json`（kit 安装时自动写好，用的是 `${workspaceFolder}`，不含任何本机绝对路径）。别人克隆仓库、信任工作区即可使用。
- **装成插件**：把本目录拷到 `~/.cursor/plugins/local/task-tree/`，然后 Developer: Reload Window。

### Claude Code

本包同时带 `.claude-plugin/plugin.json`。从仓库市场安装：

```text
/plugin marketplace add guess-guess-who-i-am/llm-task-tree-workspace-backup
/plugin install task-tree@llm-task-tree
```

### Trae

Trae 通过项目级 stdio MCP 接入，不依赖插件市场。把项目运行时部署到 `llm-task-tree/` 后，导入仓库的 `integrations/trae/mcp.json`。

## 17 个工具

| 类别 | 工具 |
|---|---|
| 界面 | `task_tree_open`（把可交互的任务图界面嵌进对话，能拖能改）、`task_tree_render`（整张图截成 PNG，`scale` 可调到 2 让字更清楚） |
| 只读 | `task_tree_focus`、`task_tree_node`、`task_tree_check_compact`、`task_tree_flow_status`、`task_tree_versions`、`task_tree_knowledge`、`task_tree_models`、`task_tree_skills` |
| 多 Agent | `task_tree_scope` 创建/读取/关闭会话执行范围；范围内只执行和写回获授权节点 |
| 写入 | `task_tree_write`、`task_tree_chain`、`task_tree_subtree`、`task_tree_flow_write`、`task_tree_layout` |
| 服务 | `task_tree_server`（按需无界面拉起 / 停止 / `open` 弹界面） |
| 内部 | `task_tree_api`（嵌进对话的界面走它调自己的后端；模型不用管这一个） |

详细用法见 `skills/task-tree/SKILL.md`——Agent 会自己读。

## 边界

- `task_tree_open` 总会在桌面浏览器打开可交互界面；支持 MCP Apps 的宿主还会同时显示对话内界面。它不会再只回一段“已经嵌入”的文字。
- `task_tree_render` 给的是**一张静态图**：能看，不能拖不能点。
- 两个都是给用户看的：模型自己读不到画面内容，要数据就调 `task_tree_focus` / `task_tree_node`。
- 截图靠机器上已有的 Chromium（Windows 自带 Edge 就行）。都没有的话设 `TASK_TREE_CHROME` 指向浏览器可执行文件，否则这一个工具不可用，其余工具不受影响。
- 写树必须给 `reason`，会写进 `versions/` 的备份文件名。
- 精炼门禁不过就拒绝写入，文件零字节改动。
