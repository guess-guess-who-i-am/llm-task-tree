# N10 — 执行顺序视图（Scratch 模块流）

## 本步做什么

将 Scratch 风格模块流并入主应用：**关系图 | 执行流程** 顶栏切换；执行顺序以 `scripts/project.json` 为准；折叠子树节点仍进 execution-catalog。

## 新增：步骤详情 Inspector

点击任务块 → 右侧 **步骤详情** 侧栏（`public/flow-view.js:435`）：

- `selectStepNode`（`:1489`）拉取 `GET /api/flow-step?nodeId=`
- `renderStepInspectorContent`（`:1510`）展示 substeps、代码行、prompt、产出链接
- 审计包路径：`scripts/steps/<nodeId>/latest/step.json` + `report.zh.md`

## 新增：漂移检测 Drift API

- `computeFlowDrift`（`server/flow-script.js:503`）比对 catalog 与 blocks：缺块、过时块、status 不一致、顺序差异
- `GET /api/flow-script/drift`（`server.js:3100`）返回 `{ drift, stepPacks }`
- 前端 `fetchFlowDrift`（`flow-view.js:518`）顶栏显示漂移横幅
- 配套：`POST /api/flow-script/sync-status`、`:rebuild`

## scripts/steps/ 审计目录

见 `scripts/steps/README.md`：每 task 块对应 `latest/step.json`（flow-step/v1）+ 中文 `report.zh.md` + `prompts/`。

## 关联

- [step.json](./step.json) · [prompts/01.zh.md](./prompts/01.zh.md)
- [scripts/README.md](../../README.md) · [scripts/project.json](../../project.json)
