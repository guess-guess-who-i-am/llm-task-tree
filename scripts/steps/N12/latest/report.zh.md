# N12：README 视觉重构与产品 Hero

## 本轮交付

- README 首屏改为品牌 Logo、单句价值、快速入口、真实产品 Hero 和少量平台徽章。
- 新 Hero 将项目总览、宏观任务树和焦点节点按真实阅读顺序合成，来源均为产品截图。
- 快速开始提前；平台安装、核心能力、工作闭环与深入文档分层展示。
- 新增可重复构建脚本 `scripts/build-readme-hero.ps1`，并把 Hero 纳入公开分发构建。

## 验证

- Hero：1920×1080，397040 bytes。
- 插件 manifest 和真实 MCP 包启动测试全部通过。
- 公开包：234 个文件、4.23 MB；本机路径与疑似凭据均为 0。
- `git diff --check` 通过。

## 证据

- `README.md`
- `artifacts/readme-hero.png`
- `scripts/build-readme-hero.ps1`
- `scripts/build-public-repo.mjs`
- `dist/task-tree-public/README.md`
