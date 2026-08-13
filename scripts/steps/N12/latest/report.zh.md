# N12 · 让 Agent 直接调用任务图（MCP 集成层）

## 问题

任务图和 Codex/Cursor 只有提示词耦合：Agent 靠"自觉读协议"知道焦点，项目的能力（写树、链式推进、知识库、多模型、折叠、自动整理、版本回退）在界面里全都有，但 Agent 一个都调不到。

## 做法

一个 runtime，三个前门：Web UI（server.js）、Codex hooks、stdio MCP。MCP 只做协议转换，不复制业务逻辑：

- **只读工具**直接 import `server/` 里的模块（树注册、精炼门禁、flow 漂移），不经过 HTTP。
- **动作类工具**一律代理 `server.js` 的现成端点。写树走 `PUT /api/tree`，于是自动继承备份到 `versions/`、GraphState 焦点保护、flow 状态同步；链式走 `chain-step` / `chain-advance`；折叠走 `subtree-file` + `sync-stub`。
- **服务按需拉起**：复用 kit 启动器的 env 约定（`PORT` / `TASK_TREE_STUB_DIR` / `TASK_TREE_PROJECT_ROOT`）和端口发现顺序（`.task-tree-port` → `.task-tree-ports` → 5177，用 `GET /api/project` 校验归属），无界面启动；只有 `task_tree_server open` 才在用户桌面弹出界面。
- **排版共用一份算法**：轮廓布局从 `public/app.js` 抽到 `public/tree-layout.js`，浏览器当普通脚本加载，Node 直接 import，UI 的"自动整理"和 `task_tree_layout` 不可能再各算一套。

## 14 个工具

只读：`task_tree_focus`、`task_tree_node`、`task_tree_check_compact`、`task_tree_flow_status`。

写入（都经服务端，自动备份）：`task_tree_write`、`task_tree_chain`、`task_tree_subtree`、`task_tree_layout`、`task_tree_versions`、`task_tree_flow_write`。

辅助：`task_tree_knowledge`、`task_tree_models`、`task_tree_skills`、`task_tree_server`。

## 验证

`node scripts/test-mcp-server.mjs` → 22/22 通过，stdout 只有协议消息（stderr 为空）。关键断言：

- 自动拉起：`task_tree_server start` 后服务在跑，且端口写回 `.task-tree-port`。
- 写入边界：超预算字段被门禁拒绝且 `task-tree.md` 零字节变化；`fields:{Next:...}` 被拒（焦点归用户）；缺 `reason` 被拒。
- 幂等：同值回写两次，第二次文件逐字节不变。
- 布局：dryRun 不写文件，每个节点都有坐标，同一行相邻卡片 x 不重叠。
- 只读：flow / drift 工具调用后 `scripts/project.json` 逐字节不变。

## 顺带修掉的原有 bug

`setGraphStateField` 用 `^-\s+Field:\s*.*$` 定位字段行，而 `\s*` 会跨换行。当字段值为空（`- ChainForceNext: `）时，匹配范围延伸到下一行，替换后**下一行被吞掉**。实测一次原样回写就丢了 `- NextPlan:` 整行，两次连写丢了 `Next`。

这条路径原先没暴露，是因为界面保存会带 `source:"ui"` 直接跳过合并；但 `advanceAgentChain` 也会把 `ChainForceNext` 置空，所以用户的链式推进本来就有同样的丢行风险。

修法：加 `fieldLinePattern()`，用 `[^\S\r\n]` 代替 `\s`，把匹配收窄到单行，`extractNodeFieldValue` 和 `syncStubFromSubtree` 的同款正则一起收窄。回归里加了断言：写入后 GraphState 的 `Current` / `Next` / `NextPlan` 三行必须都还在。

## 分发

原先只能自己用：注册进 `config.toml` 的入口是本仓库的绝对路径，配置里也没有可移植变量。现在按"别人的电脑"重做，三条路径：

**Cursor —— 随仓库分发。** 安装期写出 `.cursor/mcp.json`，入口用 `${workspaceFolder}/llm-task-tree/mcp-server.mjs`（官方文档确认 `command`/`args`/`env` 会解析该变量），不含任何本机绝对路径，可以直接提交。写入是合并而不是覆盖：已有的其他 MCP server 和顶层键都保留，内容不变时不重写文件。项目里新增的 `llm-task-tree/mcp-server.mjs` 是个转发 stub，读 `task-tree.config.json` 找到共享 kit 后 `import` 真正的 MCP server，并把项目根作为 `--project-root` 注入。

**Codex —— Git 市场。** 仓库根加 `.agents/plugins/marketplace.json`，条目指向 `./marketplace/plugins/task-tree`。官方文档确认市场来源可以是 `owner/repo`、HTTPS/SSH Git URL 或本地目录，所以仓库公开后别人一条 `codex plugin marketplace add <owner>/<repo>` 就能装。Git 快照的登记由该命令自己管理，注册器不伪造 Git 字段，只写已验证的 `source_type = "local"`。

**注册器可移植化。** 入口解析顺序改为 `--entry` → 共享 kit → 仓库 → 项目 stub，默认注册共享 kit 的 `scripts/mcp-server.mjs`：一台机器注册一次，所有装了 stub 的项目都能用（每个会话按 cwd 定位项目根）。新增 `--codex-home` 覆盖，`config.toml` 不存在时自动创建（新机器的常态），`--remove` 仍整块撤销。

`marketplace/plugins/task-tree/` 现在同时是 Codex 插件和 Cursor 插件：`.codex-plugin/plugin.json` + `.cursor-plugin/plugin.json` + `mcp.json` + 共用的 `skills/task-tree/SKILL.md` + `README.md`。

`templates/AGENTS.merge.md` 补了一节"优先用 `task_tree_*` 工具"，所以别人装完，AGENTS.md 里就写着这些工具存在、写树要走 `task_tree_write`、焦点改不动。

## 端到端验证

`node scripts/test-share-install.mjs` → 8/8。整个过程在临时目录里进行，用临时 `CODEX_HOME`，并对全局项目注册表做快照-恢复，真实配置零改动。

- 用共享 kit 在一个陌生项目里跑真实安装，产出 `task-tree.md`、`AGENTS.md`（含 MCP 工具段）、`scripts/`、`.cursor/rules/`、`.cursor/mcp.json`、`llm-task-tree/` stub，且 `task-tree.config.json` 无 BOM。
- `.cursor/mcp.json` 不含临时目录或 kit 绝对路径；再次执行合并保留 `other` server 与顶层键，且文件字节不变。
- 空白 `CODEX_HOME` 注册成功，入口等于共享 kit 路径，重复执行为 `none`，`--remove` 后三个块全部消失。
- 两份市场清单（kit 本地形态、仓库根 Git 形态）的相对路径都解析到真实插件目录，且插件带 SKILL.md。
- 通过项目 stub 起 MCP：14 个工具、`focus` 解析到该陌生项目根、starter 树过精炼门禁、stderr 为空。
- 写树链路：`task_tree_write` 自动拉起服务、写进该项目的 `task-tree.md`、留下 `versions/`、焦点不动，最后 `task_tree_server stop` 干净退出。

`node scripts/test-mcp-server.mjs` 仍 22/22。

## 分发结果

用户确认前端布局正常后，跑 `one-click-update.ps1 -Silent -KitTarget <kit>`：发现 26 个项目，stub 刷新 26、提示词同步 26、失败 0。

逐项核对（不看脚本摘要，直接查文件）：注册表 31 条里 26 个目录仍存在，全部有 `llm-task-tree/mcp-server.mjs` 和 `.cursor/mcp.json`，且 `args` 正好是 `${workspaceFolder}/llm-task-tree/mcp-server.mjs`。剩下 5 条指向已删除的文件夹（`F:\AgentPlatform2.1.5~8`、`E:\zongshu\code` 等），是注册表残留，没有清理——清理会动用户的机器状态。

## 公开包

工作区不适合整包公开：它装着研究树、`open-webSearch` 第三方克隆和 `node_modules`。所以 `scripts/build-public-repo.mjs` 生成一个只含可分发内容的独立仓库 `dist/task-tree-public`（108 文件 / 0.89 MB）：`kit/` 运行时 + `marketplace/plugins/task-tree/` + 根 `.agents/plugins/marketplace.json` + README/LICENSE/docs。可重复运行，已有 `.git` 会保留，所以第二次是正常 diff 而不是新历史。

构建脚本从 PowerShell 改写成 Node，是因为第一版发布的 README 在 GitHub 上是乱码：脚本本身是无 BOM 的 UTF-8，而 Windows PowerShell 5.1 会把这种 `.ps1` 当 ANSI 读，脚本里的中文 here-string 在写出之前就已经坏了。Node 读写一律 UTF-8，这类问题从根上没有了。

脱敏是必需的，扫描发现了真实泄漏：`DEPLOY.md` 和 `setup-task-tree.cmd` 里嵌着本机 kit 的绝对路径（`::KITPATH=`），`update-search-roots.txt` 带着 `E:\`/`F:\` 扫描根，`update-projects.example.txt` 列着用户的真实项目。处理方式：`::KITPATH=` 按**字节**清空（这些文件 ASCII 标记混着非 ASCII 路径，按文本改容易改坏编码），机器路径按字面量替换成占位符，且只在文件能 UTF-8 无损往返时才写回；机器配置文件直接不进包。构建最后自检，命中任何机器路径就让构建失败——泄漏一旦推上去就是公开的。

用这个包（而不是仓库里的 kit）重跑端到端：8/8 通过。也就是说别人收到的那份能独立工作。

## 发布

公开仓库：`https://github.com/guess-guess-who-i-am/tree`（public，`main`）。

第一次发布是坏的，值得记下来：仓库里只有 9 个文件——只推了 `marketplace/`，运行时 `kit/` 和根 `.agents/plugins/marketplace.json` 都没进去。也就是说 `codex plugin marketplace add` 没有清单可解析，克隆下来也没有能跑的东西，而 README 还在描述这些目录。重建后仓库是完整的四块：`kit/`、`marketplace/`、`.agents/`、`docs/`。

复验没有用本地目录，而是**从 GitHub 克隆一份**再跑同一套测试：`node scripts/test-share-install.mjs <clone>/kit` → 8/8 通过；克隆里的清单和 README 都是无 BOM 的正确 UTF-8。随后又发现克隆携带着本机的 `::KITPATH=` 值（会让新用户的 kit 发现逻辑去找一个不存在的盘符路径），已在构建期清空并补推。

补推那次 `git push` 连不上：`github.com:443` 从这台机器不通，而 `api.github.com:443` 通。改用 Contents API 上传该文件（远端内容与本地 blob 逐字节相同，`::KITPATH=` 已为空）。代价是 `dist/task-tree-public` 的本地历史与远端各有一个同内容提交，等网络恢复后 `git pull --rebase` 会直接跳过本地那条。

## 又修掉一个假成功

`task_tree_server stop` 报告"已停止"，但进程还活着占着 kit 目录，导致重建公开包时 `Remove-Item` 报"文件正被使用"。查下来是 `/api/shutdown` 的顺序问题：先回 200，然后 `await shutdownBackgroundServices()`，兜底的 `process.exit` 排在 await 之后——后台服务一挂住，进程就永远不退，而调用方已经被告知停止了。

修法：硬退出定时器改为 await **之前**武装（3 秒），正常路径走通后清掉。测试侧也补上：停止后轮询端口，直到真的连不上才继续清理，否则清理和一个还活着的服务赛跑。

## 桌面端才是默认路径

用户指出他用的是 Codex 桌面端而不是 CLI，于是重新查了一遍：桌面端和 CLI 读的是**同一个** `~/.codex/config.toml`，插件与 MCP 都由 `[mcp_servers.*]`、`[marketplaces.*]`、`[plugins."name@marketplace"]` 三类块驱动，格式和 Codex 自带的 `openai-primary-runtime` 市场完全一致。也就是说 codex CLI 从来就不是必需的。

证据是桌面端自己留下的：`~/.codex/plugins/cache/llm-task-tree/task-tree/0.2.0/` 里躺着我们的 `plugin.json`、`mcp.json` 和 `skills/task-tree/SKILL.md`——注册之后桌面端自行把插件物化了下来。

（这一段当时把"桌面端"认成了 VS Code 里的 `openai.chatgpt` 扩展，是错的；正确的宿主见下一节。）

但这里有个真缺口：`install.ps1` 只装了 Codex hooks，从来没做过 MCP/插件注册，那一步一直要人手敲命令。补法是 `kit-runtime.ps1` 新增 `Ensure-CodexRegistration`，安装末尾调用一次。三条边界：机器上没有 `~/.codex` 就直接返回、不凭空造配置；重复安装报 `none`、不重写用户配置；`-PromptsOnly`（一键更新走这条）完全不碰机器全局状态。测试里加了对应用例，并且断言真实的 `config.toml` 哈希在整轮测试后不变——9/9 通过。

文档也翻过来了：README、插件说明、分发说明现在都以桌面端为主路径，CLI 的 `marketplace add` 降为"装了 CLI 的话还可以"。

## 上架形态：插件在桌面应用里长什么样

上一节把宿主认错了。查清楚的结论是：**插件目录只在 ChatGPT 桌面应用里**（Codex 模式，或 ChatGPT 模式打开 Work 开关）。官方文档原话是插件"在 Chat、IDE 扩展和移动端不可用"。这台机器同时装着两样东西，之前混为一谈了：VS Code 里的 `openai.chatgpt` 扩展（没有插件面板），和真正在跑的 ChatGPT 桌面应用（9 个进程，程序在 `%LOCALAPPDATA%\OpenAI\Codex`，版本 26.721.81911）。顺带纠正另一处：这台机器**有** codex 可执行文件，就在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，只是没进 PATH。

区分清楚之后，"点一下就能用"落在桌面应用的插件目录和输入框里，于是要补的是上架元数据。对照 Codex 自带的 `documents` 插件，我们缺了一整块：图标、logo、品牌色、发布者、`defaultPrompt`。还有一个真缺陷——**被注册的那份市场清单没有 `interface.displayName`**：仓库根那份有，但 `config.toml` 指向的是 kit 里的 `marketplace/`，那份只有裸 `name`，所以插件目录里的来源一直显示成 `llm-task-tree` 而不是「任务图」。

图标的做法换过一次。先用系统 Edge 无头截图渲染 SVG，输出底部四分之一被裁：`--window-size` 给的是设备像素，CSS 视口被显示缩放和窗口高度改写，`--force-device-scale-factor=1` 也没救回来。改成纯 Node 光栅化：形状用有向距离场（圆角矩形 / 圆 / 胶囊线段），4×4 超采样抗锯齿，`zlib.deflateSync` 直接写 PNG。尺寸由代码保证而不是由浏览器施舍，且别人机器上没有 Chrome/Edge 也能重跑——对一个要分发的 kit 来说这点更重要。图案是产品本身：父节点、两个子节点、当前焦点带圈，360 和 512 两个尺寸同源。

刷新链路上有个不明显的坑：桌面应用按 `~/.codex/plugins/cache/<市场>/<插件>/<版本>/` 装，**版本号不变就还是加载旧目录**，改了文件重启也看不到。所以这轮把版本提到 `0.3.0`，旧的 `0.2.0` 缓存目录在重装后消失。另外 `codex plugin marketplace upgrade` 在这里帮不上忙，它只认 Git 市场，对本地市场直接报 `not configured as a Git marketplace`；本地市场的刷新路径就是提版本 + 重启。

验证没有停在"文件写对了"：用桌面应用自带的 codex 二进制跑 `plugin list`，它把我们的市场解析出来并显示 `task-tree@llm-task-tree  installed, enabled  0.3.0`；再回读安装缓存里的清单，确认中文完好、无 BOM、图标路径可解析、四条提示词都在。

审计做成了测试而不是一次性检查。`scripts/test-plugin-manifest.mjs`（6 例）按官方规则校验：清单必填字段、`interface` 十项、资源路径必须以 `./` 开头且不能逃出插件根、PNG 真实尺寸必须是 360/512、市场条目的 `policy.installation`/`policy.authentication`/`category` 必须合法、两份清单版本不许各说各话、JSON 不许带 BOM。它同时跑在仓库和打包后的 kit 上，并挂进了端到端测试（现在 10 例）——因为清单退化不会报错，只会让插件在目录里悄悄变得没名没图标。全量回归 47 例通过。

## 未做

- 官方市场收录：Codex 侧本地/Git 市场已等价于"能装"；Cursor 官方市场是策展制（公开开源 + 人工审核），提交不等于收录。
- 跨机验证：插件可见性只在本机确认过；另一台电脑上克隆 + 部署一次才算闭环。
- 嵌入式界面只在本机代码层面验证过：跨域 iframe 握手通了、宿主契约按二进制里的键名对齐了，但桌面应用里真渲染出来还没实测。
- `codex plugin marketplace add guess-guess-who-i-am/tree` 仍没真跑过，验证到的是清单形状与相对路径解析。这条路是可选的，不影响桌面应用。

## 推送：再次绕开被墙的 git

公开包已重建并推到 `main`（`0a82f49`，14 个文件）。`git push` 依旧连不上 `github.com:443`，而 `api.github.com` 通，所以这次把绕行做成了脚本 `scripts/push-public-repo.mjs`：走 Git Data API 的 blob → tree → commit → ref，产出**一个**提交而不是上次那样逐文件写 Contents API，二进制图标也能原样传。

差异靠 git blob SHA 两边对比得出（远端 tree 递归拉一次，本地 `git ls-tree -r`），只上传真正变化的文件。这里踩到一个坑：`git ls-tree` 默认会把非 ASCII 路径加引号并转义成八进制，仓库里三个中文名的 `.cmd`/`.txt` 于是同时出现在"新增"和"删除"两侧——照着推会把它们换成一堆转义文件名。加 `-z` 用 NUL 分隔的原始路径后，差异回到干净的 14 改 0 删。

复核读的是远端：`marketplace/plugins/task-tree/.codex-plugin/plugin.json` 解出 `version 0.3.0`、`displayName 任务图`、4 条提示词，`assets/` 下两张图字节数与本地一致。

代价照旧：本地仓库与远端各有一条同内容提交，等 `github.com` 通了 `git pull --rebase` 会自动跳过本地那条。

## 点一下就看到整张树

用户看完上一轮的说明，回了一句"我不想要这样"：不要记工具名、也不要读文字回答，要**点一下直接看到完整的、和网页一样的树，但不用打开网页**。

先确认唯一可行的通道。桌面应用不给第三方插件任何 UI 位（Apps SDK 那套要云端注册 + 公网 HTTP，这里既被墙也不合适），能进对话的只有 MCP 内容块——于是"看到树"只能是**工具返回一张图**。查 Codex 源码确认它认：`ContentBlock::ImageContent` 会转成 `data:image/png;base64,…` 的 `InputImage` 渲染出来。同时查到两条硬约束，都踩过就来不及了：带 `structuredContent` 时 Codex 会**丢掉整个 `content[]`**（官方回复"设计如此"），老版本只认排在**最前**的图块。所以 `task_tree_render` 只发 `content`，图在前、文字说明在后。

图从哪来，决定了它会不会和网页长得不一样。自己再写一套绘制迟早漂移，所以直接**截界面本身**：给页面加 `?snapshot=1`，进快照模式后收起顶栏、知识库、版本树和底部执行链，停掉三个轮询定时器（相机开着的时候没必要重绘），调已有的 `fitGraphToViewport` 把整棵树缩进视口，然后用机器上现成的 Chromium（Windows 自带 Edge）无头截一张。渲染路径、卡片样式、Current/Next 高亮全部复用 `public/app.js`，网页改了图跟着改。

裁剪这一步花的功夫比想象中多，因为**无头窗口尺寸不等于视口**：`--window-size=1200,800` 实测只画到 1163×709，差的是窗口边框，而边框宽度随平台和显示缩放变。与其把这个常数写死，不如让页面告诉我们——`--default-background-color=00000000` 让没画到的地方保持透明，再按 alpha 裁掉透明边，换台机器自动就对。顺手解决了第二个问题：第一版按窗口截，宽而矮的树只占上半张图，下面一大片空白；把画布背景也设成透明后，裁剪贴的是**图自身的边界**，再在 Node 侧铺回界面的底色（顺便保证图不透明，深色主题下字不会糊）。

为此写了 `server/png.js`：解码（inflate + 五种 filter 还原）、透明边裁剪、alpha 合成、编码。图标生成器里原本有一份重复的编码实现，一并合到这里，现在截图和图标共用一套，输出字节数不变。

结果：14 节点的整树出图 2507×1130，热服务 9.2 秒（冷启动约 25 秒，多的是拉起本地服务）。测试加了两例——一例真实截图（无 Chromium 时自动跳过），断言图块在最前、`structuredContent` 不存在、图片完全不透明；一例 PNG 编解码的往返、裁剪与合成，用 4×3 的构造像素跑，不依赖浏览器。全量回归 49 例通过。

插件升到 `0.4.0`（提版本才会装进新的缓存目录），一键提示词第一条换成"看一眼任务图现在长什么样"。技能文档里同时写清边界：图是给人看的，Agent 要数据仍然调 `task_tree_focus`/`task_tree_node`；要拖拽编辑才 `task_tree_server open`。

## 把网页本身搬进对话

上一节有个错判，代价是白做了一轮：「桌面应用不给第三方插件任何 UI 位」。这句话是从"没查到"推出来的，不是从证据推出来的。用户看到静态图后说得很直白——不要让我"说"看一眼，要**和以前的 html 一样，在桌面端里打开，一样能操作，原封不动搬上去**。

这次先翻二进制再动手。本机那个 353 MB 的 `codex.exe` 里，`enable_mcp_apps` 命中 7 次（`[features]` 下的开关，和 `multi_agent_v2` 并列），`mcp_app_resource_uri` 命中 14 次（`McpToolCallEndEvent` 的字段）。最有用的是这串连着的键名：`resource_uri` `ui` `resourceUri` `ui/resourceUri` `openai/outputTemplate`——内核在工具 `_meta` 里的查找顺序，找到就把资源 URI 交给界面层渲染。走的是通用 `McpToolCall` 路径，说明**本地 stdio 服务也吃这一套**，不需要注册成远程 connector。详见 `docs/agent-context-research/codex-mcp-apps-probe.zh.md`。

于是「原封不动」是字面意义上的：`task_tree_open` 的 `_meta` 指向 `ui://task-tree/graph.html`，`resources/read` 返回一段 HTML，里面就一个 iframe 指着 `http://127.0.0.1:<port>/?embed=1`。宿主把它渲成沙箱 iframe，用户看到的就是那张网页本身——拖节点、改字段、切执行流程、翻知识库、看版本树，全都是原来的实现。不另做一套简化版，也就没有走样的可能。

三个前提缺一不可，少一个都是静默失败：桥只对 `text/html;profile=mcp-app` 打开；**子 iframe 默认被拦**，资源必须自报 `_meta.ui.csp.frameDomains`；宿主要开 `features.enable_mcp_apps`。端口每次可能不同，所以 CSP 声明成 `http://127.0.0.1:*`。宿主还会按 URI 缓存模板，缓存下来的端口可能已经死了——widget 因此不盲等：页面在 `?embed=1` 下会 `postMessage` 回来两段握手（`loaded` 和 `rendered`），6 秒收不到就通过桥 `callTool("task_tree_server")` 问当前端口再试一次，还不行就摊开说是被拦还是服务没起，不装作成功。

开关那行不能按现有的"整块追加"逻辑写：用户的 `config.toml` 里已经有 `[features]`，再追加一个同名表会让 TOML 直接失效。所以单独写了 `setFeatureFlag`，往已有表里插一行；已有的值不改写（谁手动关过是谁的决定），`--remove` 也只撤掉自己加的那行 `= true`，表被清空了才顺手删表头。临时 CODEX_HOME 上验过：装→加一行、重跑→无操作、卸载→逐字节回到原样。

宿主那半要等实测，我方这半可以先隔离验证：一个探针页 iframe 到本地界面，听 `postMessage`，拿到 `HANDSHAKE OK: loaded,rendered`，截图确认知识库面板、关系图、版本树、工具栏全在。所以万一桌面端不出界面，变量只剩宿主一个。

测试加了两例：一例把 `initialize` 的 resources 能力、工具 `_meta` 的两种键、资源 MIME、`frameDomains`、HTML 里的 iframe 地址一起断言（这些正是"少一个就静默失败"的项）；一例确认未知 `ui://` 返回 `-32602`。顺带修了一个旧断言——它拿 `resources/read` 当"不支持的方法"举例，现在这个方法支持了，改用 `prompts/get`。分享安装测试跟着断言 16 个工具、`server/graph-widget.js` 随 kit 分发、注册后 `[features]` 里有那行开关、卸载后没有。全量回归 42 例通过。

插件升到 `0.5.0`，一键提示词第一条换成"打开任务图，我要自己拖着看"，第二条才是出静态图。

## 一个项目一个固定地址

用户问了两件事：开界面是不是每次都要跑一次模型，以及是不是还得记住端口。第一件是误会——模型只跟"把界面嵌进对话"这一件事有关，双击 `打开任务图.cmd` 本来就不过模型。第二件是真问题，而且比"记不住"更糟。

现场一查就露馅了：`打开任务图.cmd` 把服务开在 **64340**，一个随机高位端口。上一节为固定地址加的 `stablePort()`（按项目根路径哈希，本项目恒为 5410）只写在 `scripts/mcp-server.mjs` 里，PowerShell 启动器那半仍然是 `TcpListener(port 0)` 要一个随机口。同一个项目两个入口两套端口策略，于是上一节"端口每次可能不同"这句话，与其说是事实，不如说是这个疏漏的产物。

修法是让启动器用同一套推导，而不是让它去问 Node（多一次进程启动，还得处理 Node 不在 PATH 的情况）：`Get-StableProjectPort` 逐字符重算同一个哈希，`Get-FreePort` 先试这个口、占用了才回退随机，`Get-CandidateProjectPorts` 也把它加进探活列表——这样服务已经在跑时会被复用，而不是再起一个然后把旧的杀掉。两边实测都是 5410，重启启动器后服务落在 5410，64340 那个已停。

哈希得逐字符对齐才有意义，所以回归测试不是抄一遍算术，而是**把启动器里那个函数抠出来真跑一遍**（正则取函数体 → 临时 `.ps1` → 与 `task_tree_server start` 返回的端口比对）。第一版红了：PowerShell 报 5359，Node 报 5410。原因是临时脚本写成了无 BOM 的 UTF-8，Windows PowerShell 5.1 会按 ANSI 读，路径里的中文在参与哈希之前就已经坏了——和当初 README 乱码是同一个坑，只是这次坏在测试脚手架里而不是产物里。加上 BOM 后两边一致。启动器本身从来没这个问题：它的 `$ProjectRoot` 是运行时解析出来的，不是脚本里的字面量。

于是现在的答案是三条路，只有第三条过模型：双击 `打开任务图.cmd`；或直接开 `http://127.0.0.1:5410`（这台机器上这个项目永远是它，可以收藏、可以贴进桌面端的浏览器面板）；要它作为可交互组件出现在对话里，才需要跑一轮 `task_tree_open`。全量回归 46 例（mcp 30 + share-install 10 + manifest 6）。

## 按钮发到哪条会话

接着的问题是那个 Codex 按钮：发过去的是哪一段、有没有上下文、能不能固定发到某一条，以后在那条里接着做或者换一条。前两问当时的答案是"一句固定提示词"和"没有上下文"——每次 `thread/start` 都是全新会话，用完就成了列表里的一条孤儿。这不是设计，只是当初只需要证明"能自动发出去"。

app-server 里其实有现成的东西（用一个不存在的方法名换回完整枚举是最省事的查法）：`thread/resume`、`thread/list`、`thread/fork`、`thread/name/set`。实测 `thread/resume` 拿回的是带历史的会话（`status: idle`、`canAcceptDirectInput: true`），在它上面 `turn/start`，turns 从 1 变 2，而且上一轮的 `mcpToolCall: task_tree_open` 还在历史里——续接是真的续接，不是同名新开。`thread/name/set {threadId, name}` 也生效并持久化，所以新开的那条会被命名成「任务图工作台」，在侧栏认得出来。顺带记一笔：二进制里能搜到 `thread/name`，但 app-server 只认 `thread/name/set`，字符串命中不等于方法存在。

于是按钮改成：默认发到本项目上次那条（会话 id 写在项目根的 `.task-tree-thread`，已进 gitignore 和 kit 的模板），右边 `▾` 列出这个项目的历史会话可以换一条，或者新开一条。列表按 `thread/list` 返回的 `cwd` 过滤，别的项目的会话不会混进来，临时会话（`ephemeral`）也排除。id 存在项目里而不是应用里，是因为同一个桌面应用会开着好几个项目，存一份会互相抢。

一个边界要单独处理：用户可能在桌面端把那条会话归档或删掉。这时 resume 会失败，但按钮不该因此报错——失败就落到新开一条并把新的钉住。测试用 `FAKE_APP_SERVER_MODE=gone` 复现这条路径。

id 校验也调整过。第一版写成十六进制 UUID 形状，结果假服务器的假 id 过不了。真实 id 确实是 UUID，但把校验绑死在格式上，将来格式一变就是"固定会话静默失效"这种最难查的故障；而一个 Codex 不认识的 id 本来就会 resume 失败然后安全回退。所以校验只挡明显的垃圾（空白、多行、带空格的残文），不管格式。

全量回归 49 例（mcp 33 + share-install 10 + manifest 6）。

## 按钮发什么

下一问是内容本身：发过去的是不是"当前节点的下一步"。不是——是一句写死的"调用 task_tree_open"。它只够把界面弄进对话，对推进任务毫无帮助。而链式循环、多模型、知识库这些项目已有的能力，按钮一个都没接上。

改成三档，都由服务端读**当前的树**现算，不是模板：

- **打开任务图**：原来那句，不动树。
- **执行下一步**：Next 节点的 id、标题和它的 `NextIdea`，再加三条约束——只做这一步、不许读 `NextPlan`、不许改焦点，做完把结果写回该节点的 `CurrentResult`。这三条正是 AGENTS 协议里最容易在新上下文里被忘掉的。
- **链式循环推进一步**：直接用 `chain-step` 已经算好的 `agentPrompt`（含单步上下文和停机规则），不另写一套措辞，免得两边漂移。

关键是**没依据时不发**。Next 没写 NextIdea，或者 `Chain` 为空该停机，对应那条在菜单里是灰的并写明原因，点不动。协议禁止从 `NextPlan` 猜执行依据，那么"猜一个发出去"和"报告没有依据"之间，只有后者是诚实的。实测当前树：`执行下一步` 拿到的是 N11 和它真实的 NextIdea，`链式循环` 返回 409「Chain 为空」，一轮模型都没花。

菜单顺带理顺了两个维度。上半段"发什么"（花一轮），下半段"发到哪"（不花）。之前点会话列表里的一条会直接发出去，现在只是换目标，换完再点上半段——切换是免费的，发送才要钱，这件事不该混在一起。另外加了 `dryRun`，能看到将要发出去的原文而不真发，测试也靠它。

## 多模型和知识库能不能用

能，而且早就能，只是之前没验过。这两个工具的能力比它们在测试用例名里显得的要宽：`task_tree_knowledge` 有 search / ask / web / status / reindex，`task_tree_models` 有 list / health / run。

实测（都走 MCP，不经界面）：知识库 1552 个 chunk、`text-embedding-3-large`，`search` 返回真实 chunk 且带向量与词法两个分数；两个模型 `health` 都是 200，`run` 让 Kimi-K2.5 和 Qwen3.5-122B-A10B 基于 N12 的上下文各答一句，14.6 秒回来，带树快照哈希以便判断运行期间树有没有被外部改动。

也就是说 Codex 里的 Agent 要检索知识库或者发起一轮多模型讨论，都是一个工具调用的事。它和 Codex 自己的模型是两条独立的路：Codex 用它自己的模型跑这一轮，多模型协作打的是 `model-agents.json` 里配置的那些 OpenAI 兼容端点，互不影响。`run` 需要显式给 `modelIds[]`，不给会报「run 需要 modelIds[] 与 question」。

全量回归 52 例（mcp 36 + share-install 10 + manifest 6）。

## 一台机器上的另外 25 个项目

固定地址是按项目根算的，所以"固定"这件事本来就是每个项目一份。但界面上没有任何地方能到达另一个项目：你得知道那个项目在哪、进去双击它的启动器。装过的项目有 26 个，这个门槛不合理。

安装器一直在 `%LOCALAPPDATA%\LLMTaskTree\projects.json` 里记录它动过的每个项目，这就是现成的清单。标题旁加了一个项目菜单：列出这份清单，每行是项目名加它自己的路径和端口，点一下就切过去。切换要做的事只有两件——目标项目的服务没醒就按它自己的固定端口拉起来（`env` 里带 `TASK_TREE_PROJECT_ROOT`/`TASK_TREE_STUB_DIR`，进程 detached，因为本窗口马上要跳走），然后跳到那个地址。

清单要过滤。注册表里有目录已经不在的条目，也有同一路径的重复拼写，还有旧 PowerShell 控制台留下的乱码路径——这三类都表现为"这个目录不存在"，所以按"目录还在且里面还有树"过滤，乱码条目自己就消失了，不用专门认它。列表按树文件的修改时间排，最近动过的在上面，当前项目置顶并标点。

实测切到 `F:\OPSD`：起在 5428（本项目是 5410），`/api/project` 回的 root 是 `F:\OPSD`，`/api/codex/threads` 回的是它自己的会话（1 条，cwd 匹配）、它自己的空固定会话、以及按**它的**树算出来的 preset（`执行下一步` 可跑、`链式循环` 因 Chain 为空而灰）。项目之间没有共享状态，因为这些状态本来就存在各自的项目目录里。

## 循环不用再复制命令

底栏那条 loop 命令是给"人切到 Agent 里粘贴"设计的，可现在页面已经能自己发一轮了，复制这一步就是多余的。底栏加了「▶ 直接开跑」，点它等于发 `preset: "chain"`——服务端拿 `chain-step` 算好的 `agentPrompt` 发出去，和菜单里那一档同一条路。命令文本和「复制」按钮留着，给 Cursor 或别的 Agent 用。

实测点击：Chain 当前为空，页面当场显示「Codex 没能启动: 链式循环现在该停：Chain 为空。」——该停的时候不会白花一轮，理由直接摆在按钮旁边。

## 菜单为什么长成一列竖字

用户截图里会话菜单每一项都被压成宽约 25px 的竖排单字。原因是 `.toolbar button { width: 38px; height: 38px }`（特指度 0,1,1）盖过了 `.codexThreadItem { width: 100% }`（0,1,0）——菜单在 DOM 上是工具栏按钮的兄弟节点，于是每个菜单项都被当成工具栏图标按钮定了尺寸。同一段里的 `<p>` 分组标题不是 button，所以它显示正常，这正是当时最明显的线索。

改法是把菜单项选择器写成 `.codexThreadMenu .codexThreadItem`（0,2,0）并显式还原 `height: auto`。顺带把每条会话压成单行（标题 `nowrap` + 省略号），因为测试期间连开了十几条内容相近的会话，允许换行时整份列表就是一堵字墙——恰好在列表最长的时候最难读。会话预览里的换行也在服务端折成空格。

顺带修掉一个测试端的泄漏：`startCodexTurn` 故意让 app-server 活过请求（真实场景里杀掉它会中断正在跑的 turn），但假服务器的 turn 永远不结束，于是回归跑完最后一例、打完 PASS 之后进程挂着不退。测试改成记住这些子进程并在末尾统一收掉，套件从"跑完不退"变成 91 秒退出。

全量回归 63 例（mcp 38 + share-install 10 + 多树 9 + manifest 6）。

## 一个注册够不够所有项目用

`~/.codex/config.toml` 里 `mcp_servers.task_tree` 只有 `command` 和 `args`，没有任何项目路径；服务端在启动时用 `--project-root` 或 `process.cwd()` 定位项目，一次定死。所以关键问题是：Codex 用什么目录启动这个进程？如果用应用自己的工作目录，那么一个全局注册就只能服务一个项目，"在哪个项目就开哪个项目的图"根本不成立。

不用猜也不用花模型。`codex.exe` 里有 `mcpServer/tool/call`，是宿主直接调用 MCP 工具的方法；第一次试它报 `missing field threadId`——这个报错本身就是答案的一半：**MCP 工具调用是挂在会话上的**。

于是把 app-server 起在一个中立目录（`E:\`，两个项目都不是），在同一个后端里开两条会话，cwd 分别是 `E:\解决跟不上大模型思路问题` 和 `F:\OPSD`，然后对两条会话调同一个工具：

- `task_tree_focus`：分别回 `projectRoot=E:\解决跟不上大模型思路问题`（Current N4 / Next N11）和 `projectRoot=F:\OPSD`（ROOT / ROOT）。
- `task_tree_open`：分别回 14 个节点 + `http://127.0.0.1:5410/` 和 18 个节点 + `http://127.0.0.1:5428/`，两条都带 `ui://task-tree/graph.html`。

也就是说 Codex 是**按会话**起 MCP 服务并把会话目录交给它。全局注册一次，所有项目都对；用户在桌面端要做的只是让会话开在那个项目里，不需要进项目目录双击启动器，也不需要知道端口——端口只在"宿主没开 MCP Apps"的兜底提示里出现一次。

探针留在 `scripts/probe-mcp-cwd.mjs`，以后 Codex 改了宿主行为可以一条命令复验。

## 嵌入框是空的，锅在谁那边

第一次在桌面端真跑起来，widget 外壳渲染出来了（我们的样式、右上角「全屏 / 刷新」都在），但框里是我们自己写的兜底文案——里层那个 `http://127.0.0.1:5428/?embed=1` 两次都没握手。兜底文案当时写的是"多半是宿主不允许嵌入本地页面"，这是猜的，而且猜的正好是最难改的那一种。

先把我方这一侧撇清。`scripts/probe-widget-embed.mjs` 在 5399 起一个服务，供的就是 `widgetHtml()` 原样的产物，只补一个最小的 `window.openai.callTool` 桩，去套 5428。浏览器里打开：OPSD 那 18 个节点整张画出来，顶栏显示"握手到了：loaded"。跨源套框、`?embed=1` 的握手、本地服务的响应头（既没有 `X-Frame-Options` 也没有 `frame-ancestors`）全部正常。所以问题只可能在宿主套在 widget 外面的那层策略。

宿主那层没法翻源码：`ChatGPT.exe` 是 Chromium 外壳，界面从远端加载，本地只有 `chrome.dll` 和 pak，没有拼 CSP 的那段 JS。于是改成两手：

1. **把最可疑的一处直接改掉。** `frameDomains` 原来只声明了 `http://127.0.0.1:*`。端口通配符在 CSP 里合法，但宿主只要不认这种写法就会整条丢掉，子框随即被拦。而端口其实是知道的——`resources/read` 就是在服务起好之后返回的，`resources/list` 也能纯算出本项目的固定端口。现在两处都把实际源（`http://127.0.0.1:5428`）排在通配符前面，宿主认哪种都行。
2. **让沙箱自己报回来。** 子框被 CSP 拦时，事件是发给**外层**文档的，而外层文档正是我们的 widget。加了 `securitypolicyviolation` 监听，把 `violatedDirective`、`blockedURI` 和宿主实际下发的 `originalPolicy` 收起来，失败时一并显示，并通过 `window.openai.callTool("task_tree_server", {action:"report"})` 写进项目里的 `llm-task-tree/widget-report.json`。沙箱里唯一能出来的通道就是这个桥，而它已经被证明可用——之前的重试正是靠它拿到了当前端口。

兜底面板也顺手改成能干活的：不再让用户去敲 `task_tree_server open`，直接给一个「在桌面上打开完整界面」按钮。

复验要开**新会话**：MCP 服务是按会话起的进程，旧会话里那个进程加载的还是改之前的模块。OPSD 走的是共享 kit（`E:\...\llm-task-tree-kit`），所以 `scripts/build-kit.ps1` 已经同步过去，实测 kit 里的 `widgetMeta(5428)` 回的是 `["http://127.0.0.1:5428","http://localhost:5428","http://127.0.0.1:*","http://localhost:*"]`。

全量回归 64 例（mcp 39 + share-install 10 + 多树 9 + manifest 6）。

## 插件包为什么一个工具都不提供

用户在另一台机器上报的现象是：插件装好了、项目也绑对了，但只有 15 个工具，`task_tree_open` / `task_tree_render` / `task_tree_api` 都没有——而同一个包里的 SKILL.md 和 README.md 正让模型去调它们。文档和运行包互相矛盾。

先别信"重启没生效"这类解释。本机 `~/.codex/plugins/cache/llm-task-tree/task-tree/0.6.0/` 里装着的东西是：`.codex-plugin/`、`.cursor-plugin/`、`assets/`、`skills/`、`mcp.json`、`README.md`。没有任何运行时代码。也就是说这个包从来就没能提供工具，那 15 个是 `config.toml` 里那条独立的全局注册给的，它指向共享 kit，而那台机器上的 kit 是旧的。

两处都是静默失效，而且都在"看起来很对"的地方：

1. `.codex-plugin/plugin.json` 里没有 `mcpServers` 键。宿主因此根本不知道这个包想起一个服务。
2. 配置文件叫 `mcp.json`，不带点。那是 Cursor 的写法。

第二点不是猜的。`codex.exe` 里嵌着官方的插件脚手架 `plugin-creator/scripts/create_basic_plugin.py`，其中 `build_plugin_json` 写得很直白：`if with_mcp: payload["mcpServers"] = "./.mcp.json"`。同一个二进制里的能力扫描字符串也只列了 `.mcp.json` 和 `agents/openai.yaml` 两个名字。顺带还查掉一个一直没验证过的假设：`${workspaceFolder}` 在整个宿主包里出现 **0 次**，它唯一认的 `${...}` 形式是 `/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/`，即整值环境变量引用。所以那个占位符是 Cursor 的东西，Codex 侧写它等于写死一个不存在的路径。

修法是让包自足，而不是继续依赖外部 kit：`scripts/build-plugin-runtime.mjs` 把 25 个文件 / 754 KB（MCP 入口 + `server.js` + `server/` + `public/`）拷进包内 `runtime/`，`.mcp.json` 指 `./runtime/scripts/mcp-server.mjs`，清单补上 `mcpServers`，版本提到 0.7.0（桌面端按版本号选缓存目录，不升就还是旧的）。运行时本来就允许住在包里——`kitDir()` 第一顺位就是"和入口同包的那份"，所以工具和它渲染的界面必定同源。

包自足带来一个副作用值得写进 README：目标项目**只要有一份 `task-tree.md`** 就能用，不再要求对方先装 kit、先有 stub。测试里就是这么验的——临时目录里只放一个最小的 `task-tree.md`，`task_tree_focus` 回的 `projectRoot` 正是那个临时目录。

## 让这类事故变成构建失败

字段审计验不出"包能不能启动"。所以新增 `scripts/test-plugin-package.mjs`：按宿主的方式解析清单 → 找到 `mcpServers` → 校验文件名必须是 `.mcp.json` → 启动它声明的入口 → 问它 `tools/list` 和 `resources/list`。最关键的一例是**和自己的文档对账**：把包里 README 与所有 SKILL.md 提到的每个 `task_tree_*` 收集起来，逐个要求实际提供。用户发现的那种矛盾（文档要求调、包里没有）从此是红的。

故障注入验证它真会失败，在副本上做，不动真包：

| 注入 | 结果 |
|---|---|
| 删掉清单里的 `mcpServers` | FAIL：the manifest declares no mcpServers, so the host contributes no tools at all |
| 把 `.mcp.json` 改回 `mcp.json` | FAIL：the host's capability scan reads .mcp.json |
| 删掉 `runtime/server/widget-bundle.js` | FAIL：packaged runtime drifted from the sources |

第三条来自 `buildPluginRuntime({ write: false })`：包里那份是拷贝，会落后于源码，所以"重新打包"是可断言的，不是纪律问题。

同一类"拷贝悄悄落后"的坑在 kit 上也存在，而且当场就咬了一次：改完 `install-codex-mcp.mjs` 后端到端测试失败，因为它跑的是 kit 里那份，而 `build-kit.ps1` 是在改之前跑的。于是补一例 `shared kit is a current copy of the sources`，对 build-kit 逐字节复制的那批路径（`server.js`、`server/`、`public/`、`marketplace/`、几个 scripts）做摘要比对。

## 注册为什么会永久停在旧路径

`install-codex-mcp.mjs` 原来是纯追加：`[mcp_servers.task_tree]` 只要存在就跳过。听起来保守，实际后果是注册在第一次安装时被冻住——运行时换了位置，配置还指着老地方，工具面于是停在当年那一版，而文档一路往前。用户看到的"15 个工具"就是这么来的。

现在给每个由路径决定的块配一条 `identity`（`args = '<入口>'`、`source = '<市场目录>'`）：块在但那一行不在，就整块重写，报 `action: "refreshed"`。带用户决定的块不给 `identity`——`[plugins."task-tree@llm-task-tree"]` 里的 `enabled = false` 是人关掉的，不该被安装器悄悄扳回来。测试里把已注册的入口改成一个不存在的路径，重跑后要求：入口被改回、旧路径彻底消失、块没被复制成两份、旁边的市场块没被牵动。

## 还没验的一件事

本机 `config.toml` 里那条全局 `[mcp_servers.task_tree]` 和插件现在声明的服务同名。两者并存时谁赢、会不会互相盖掉，宿主二进制里查不到命名规则，也就没有猜的价值——换机器装 0.7.0 重启后看工具数就知道。README 里已经写明：插件自足之后那条全局注册是多余的，删掉或重跑一次注册器（现在会自愈）都行；只有 IDE 扩展（没有插件面板）还需要它。

全量回归 73 例 0 失败（mcp 40 + share-install 12 + 多树 9 + manifest 6 + 包体 6）。
