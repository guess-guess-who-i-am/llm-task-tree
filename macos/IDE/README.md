# macOS 独立 IDE

这里是 macOS 的独立启动入口和隔离测试区。IDE 数据项目安装到本目录的 `workspace/`，私有 Node.js 安装到 `runtime/`；真正的运行时代码只保留一份，在仓库的 `llm-task-tree-kit/`，避免 IDE 与 Kit 版本漂移。

`open.command` 与 `open-project.command` 现在默认打开源码工程根目录及一直维护的工程树，方便用新版 IDE 改进自身；不会复制任务树或切换全局焦点。原来的 `workspace/` 数据保留，仍可双击它自己的启动入口打开。服务在独立进程组运行，关闭启动终端后仍可访问，以启动器实际输出的地址为准。

桌面的“打开IDE工程.command”和“打开并行IDE.command”都可直接使用；启动器会解析快捷方式指向的真实文件，不会把桌面目录误认成工程。并行流程修复和六路真实 DeepSeek 验证见[本轮报告](../../docs/parallel-pipeline-repair.zh.md)。

自动并行的当前流程是“规划 → 执行 → 完成”，结果自动应用。同文件与任务树可以并行修改，真实冲突由相关 Worker 对话协商；没有四 Worker 上限或人工接受步骤。全文、历史结果和界面文本不截断。详细实现及真实模型测试见[自动并行报告](../../docs/subtree-parallel/automatic-parallel-test-report.zh.md)。

## 使用

1. 双击 `install.command`。它会下载并校验一份官方 Node.js 22 LTS 到本目录的 `runtime/`，不会修改系统目录。
2. 也可自行安装 Node.js 20.11+，再运行 `llm-task-tree-kit/install-macos.sh macos/IDE/workspace`。
3. 双击 `open.command` 或 `open-project.command` 打开 IDE 工程；要打开旧独立工作区则双击 `workspace/llm-task-tree/open-task-tree.command`。
4. `open.command` 会启动/复用本地服务，并用 macOS 默认浏览器打开任务图。
5. 首次安装后打开“系统设置 → 通用 → 登录项与扩展 → 扩展 → 访达”，启用“创建并打开 LLM 任务树”和“打开 LLM 任务树”。
6. 在 Finder 里右键任意文件夹，选择“快速操作” → “创建并打开 LLM 任务树”。第一次使用会在该文件夹创建任务树并打开 HTML；已有项目也可以选择“打开 LLM 任务树”，它会复用同一项目端口。

`install-macos.sh` 会在 `workspace/` 生成项目级 `llm-task-tree/` 配置、MCP 入口、Cursor 配置和 Codex hooks；不会默认修改用户的 `~/.codex/config.toml`。需要全局 MCP 时，显式设置 `TASK_TREE_INSTALL_CODEX=1` 再安装。

Finder 服务安装在 `~/Library/Services/`，运行脚本副本和 Kit 路径记录在 `~/Library/Application Support/LLMTaskTree/`。重新运行 `install.command` 或 `llm-task-tree-kit/install-macos.sh` 会更新 Runner；当 Workflow 没有变化时会保留其身份，不会重启 Finder 或关闭已经启用的快速操作。

## 隔离测试

`test.sh` 使用临时项目目录运行安装、MCP、服务启动和 macOS launcher 流程，测试完成后会关闭临时服务并清理临时目录。测试不会改动仓库任务树或用户目录。

完整的通过项、平台边界和修复记录见 [`TEST-REPORT.md`](TEST-REPORT.md)。
