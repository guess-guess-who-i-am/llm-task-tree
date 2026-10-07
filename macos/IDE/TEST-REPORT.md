# macOS 独立 IDE 测试报告

## 2026-09-23 Finder 右键端到端验收

已在系统设置的“通用 → 登录项与扩展 → 访达”中启用“创建并打开 LLM 任务树”和“打开 LLM 任务树”。随后对全新目录 `/tmp/LLMTaskTree-Finder-Final2-20260923-134900` 进行了真实 Finder 右键操作，而不是只运行脚本：首次点击成功生成 `task-tree.md`、`task-trees.json` 和 `llm-task-tree/task-tree.config.json`，启动 `http://127.0.0.1:5288`，项目 API 返回该临时目录，Safari 显示对应的 LLM Task Tree 页面。再次右键时两个入口仍然存在；点击“打开 LLM 任务树”继续使用同一端口 `5288` 和同一 PID `21788`。

本轮定位并修复了三个只会在真实 Finder 环境出现的问题：

1. Finder 的精简环境没有系统 Node.js。Runner 虽能找到 IDE 私有 Node，却没有把 `NODE_BIN` 传给首次安装器；现在安装和启动共用同一个私有 Node。
2. Finder 的 `PATH` 不包含 `codex`。现在 macOS 会识别 ChatGPT App 内置的 Codex 二进制；子进程启动错误也会转为可处理的失败，不再导致任务树服务进程崩溃。
3. 安装器过去每次首次建树都会重写服务状态并重启 Finder，导致 macOS 再次关闭快速操作。现在已安装且内容正确的 Workflow 会保持原身份，只有真正新增或变化时才刷新 `pbs` 和 Finder。

回归证据：`llm-task-tree-kit/server/codex-run.test.js` 15/15 通过；`./macos/IDE/test.sh` 通过，并额外验证干净 Finder 环境首次安装、Workflow inode 不变、Finder PID 不变、项目 API、MCP、浏览器交接和清理。

## 2026-09-22 自动并行更新

当前自动并行已移除旧审核流程；下面 2026-09-20 的记录仅保留为历史，不代表当前界面。最新完整证据见[自动并行测试报告](../../docs/subtree-parallel/automatic-parallel-test-report.zh.md)。

本轮通过：服务端定向协调器与集成回归；自动 Planner 拒绝单 Worker 和单前沿串行计划；真实 Git 同文件和任务树冲突；8、12、20 路调度、8 参与者单 resolver、即时追加、上下文复用和分叉；长文本桌面/手机界面；真实浏览器 → HTTP → 真实 Codex 双 Worker → 冲突合并 → 自动应用全链路；插件包和源码同步；Mac 安装、启动、端口复用、独立进程组、项目 API 与 MCP。8 路只是已验证规模，不是默认并行数或代码上限。

Finder 快速操作也已接入安装器：选择任意文件夹后可直接“创建并打开 LLM 任务树”，首次自动安装项目文件并打开 HTML；已有项目可用“打开 LLM 任务树”。

真实模型端到端总耗时 570.064 秒；旧实现的逐 peer 冲突对话 238.517 秒为本例最慢阶段。本轮代码把正常冲突路径改成一个 participant packet + 单 resolver；没有重新消耗一次真实模型长跑，不把夹具耗时冒充新的生产基线。没有同条件模型横向基线，不作性能领先声明。

另修复独立 workspace 误用外层 Git 仓库、启动服务随启动进程退出的问题。当前已安装服务在 5491，项目根目录为独立 workspace，使用 Kit 最新源码；当前任务目标仍由用户填写。

## 2026-09-20 历史安装回归

测试日期：2026-09-20。本节是此前结果，未在本轮全部重跑。

## 环境

- Apple Silicon macOS
- 私有 Node.js `v22.23.2`，位置为 `macos/IDE/runtime/current/bin/node`
- Playwright Chromium headless shell
- 独立项目目录：`macos/IDE/workspace/`

## 安装与启动

`install.command` 调用 `install-node-runtime.sh` 安装并校验 Node.js 22 LTS，然后调用 `llm-task-tree-kit/install-macos.sh`。项目文件、MCP stub、Cursor 配置、Codex hooks 和启动脚本都写入 `workspace/`；不会默认修改 `~/.codex/config.toml`。

`open.command` 和生成的 `workspace/llm-task-tree/open-task-tree.command` 都会复用稳定项目端口，并优先使用独立 IDE 的 Node。`stop.command` 通过项目 API 关闭服务。

## 已通过

- `./macos/IDE/test.sh`：安装、启动器、浏览器打开、项目 API、MCP、清理
- `node --test llm-task-tree-kit/server/*.test.*`：41/41
- MCP 全量回归：所有用例通过
- Linux/POSIX Kit 回归：所有用例通过
- 插件 manifest、运行时打包、工具面和项目发现：全部通过
- 正式界面：项目总览、节点核心摘要、内容自适应节点、焦点透镜、首屏工作区、多树切换、自动上下文轮换、并行审核：全部通过
- 知识库侧栏滚动：可滚动到底部，底部操作区可见
- 任务树写作约束、执行范围、上下文生命周期、并行 worktree、Prompt 发布器：全部通过

关键 UI 回归命令使用 Chromium 路径，例如：

```bash
BROWSER_EXECUTABLE="$HOME/Library/Caches/ms-playwright/.../chrome-headless-shell" \
  ./macos/IDE/runtime/current/bin/node scripts/test-context-rotate-ui.mjs
```

## 平台边界

- `scripts/test-share-install.mjs` 和 PowerShell 启动器测试属于 Windows 专属流程，macOS 没有 `powershell`，不将其伪报为失败；macOS 安装由上面的独立 Kit E2E 覆盖。
- Python Playwright 原型测试需要额外的 Python `playwright` 包；Node/Chromium 版本的正式界面回归已覆盖运行时 UI。
- 仓库中已移除的旧 `task-tree-prototype-v2` 页面没有再作为当前产品功能宣称；仍保留的原型页面与正式页面入口互不影响。

## 发现并修复

1. 统一 `/var` 与 `/private/var` 的物理路径身份，修复项目重复识别、稳定端口和 MCP 项目探测。
2. 补齐 macOS UI 测试中的会话、侧栏展开和真实 Chromium 夹具。
3. 修复独立 IDE 生成的 command 文件在没有系统 Node 时无法双击启动的问题。
4. 修复二次双击时未复用 `.task-tree-port`、导致同一项目随机换端口的问题。
5. 修复 macOS 插件测试把逻辑等价的临时目录路径误判为不同路径的问题。
