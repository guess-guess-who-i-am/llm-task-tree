# N9 — 可移植任务树 Kit 打包

## 本步做什么

导出 `llm-task-tree-kit/` 子目录安装包：projectRoot 指向项目根、install 合并 AGENTS 标记块、不覆盖已有 AGENTS；一键更新 17 项目 stub+prompts。

## 子步骤

1. **Kit 同步 build-kit** — `scripts/build-kit.ps1` 从仓库根同步到 kit。
2. **一键更新 17 项目** — stub-refreshed=17, prompts-synced=17, failed=0。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
