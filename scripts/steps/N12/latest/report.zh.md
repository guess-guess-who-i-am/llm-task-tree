# N12：公开 README 与跨平台插件分发

## 本轮目标

让第一次打开仓库的人能迅速理解任务树解决什么问题，并能找到 Codex、Cursor、Claude Code、Trae 的真实接入方式。

## 已交付

- 重写根 `README.md`：增加项目价值、核心能力、三层阅读尺度、Agent 工作闭环、隐私边界和四平台安装说明。
- 将 `marketplace/` 纳入 Git，保留 Codex 与 Cursor manifest，并增加 Claude Code marketplace 与 plugin manifest。
- 增加 `integrations/trae/mcp.json`，仅使用 Trae 已支持的 stdio MCP，不虚构插件市场格式。
- 更新公开包构建脚本，使其包含 README 截图、Claude Code 清单和平台集成模板。
- 扩展 manifest 测试，检查 Codex、Cursor、Claude 三份插件版本及共享 MCP/Skill 路径。

## 验证结果

- `node scripts/build-plugin-runtime.mjs`：通过，运行时 41 个文件、约 943 KB。
- `node scripts/test-plugin-manifest.mjs`：全部通过。
- `node scripts/test-plugin-package.mjs`：全部通过，真实启动 MCP 并核对工具与内联界面资源。
- `node scripts/build-public-repo.mjs`：通过，公开包 233 个文件、3.85 MB；本机路径和疑似凭据均为 0。
- 当前机器未安装 `claude` CLI，因此未执行 `claude plugin validate`；已由本地静态测试覆盖清单路径和版本一致性。

## 证据入口

- `README.md`
- `.claude-plugin/marketplace.json`
- `marketplace/plugins/task-tree/`
- `integrations/trae/`
- `scripts/test-plugin-manifest.mjs`
- `scripts/test-plugin-package.mjs`
- `dist/task-tree-public/`
