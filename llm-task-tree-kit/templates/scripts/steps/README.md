# 执行步骤审计包（flow-step）

每个 **执行流程 task 块**（`nodeId`）对应一个审计目录：

```
scripts/steps/<nodeId>/latest/
  step.json          # 机器可读索引（flow-step/v1）
  report.zh.md       # 中文审计报告（人类主入口）
  prompts/
    01.en.md         # 原始 prompt（不改写）
    01.zh.md         # 中文备份
  outputs/           # 本步产出文件
```

## 何时写入（Agent）

**同一轮完成某 flow 步骤后**（改代码、跑命令、链式推进）：

1. 更新 `scripts/steps/<nodeId>/latest/step.json`
2. 写/更新 `report.zh.md`（中文索引，链到 prompt 与产出）
3. 英文 prompt 单独放 `prompts/*.en.md`；中文放 `*.zh.md`
4. 同步该块 `status`（`PUT /api/flow-script/sync-status` 或手动改 `project.json`）

**方法/顺序变更时**（Problem、Approach、增删步骤）：

1. `GET /api/flow-script/drift`
2. 更新 `scripts/project.json` 的 `blocks` 或 `POST /api/flow-script/rebuild`
3. 为新增 nodeId 创建空 `step.json` 骨架

## step.json 最小示例

```json
{
  "schema": "flow-step/v1",
  "nodeId": "N2",
  "title": "实现可视化图谱编辑器",
  "reportZh": "report.zh.md",
  "substeps": [
    {
      "title": "实现步骤详情侧栏",
      "functions": [
        { "path": "public/flow-view.js", "line": 1460, "name": "selectStepNode" }
      ],
      "promptEn": "prompts/01.en.md",
      "promptZh": "prompts/01.zh.md",
      "inputs": [{ "path": "task-tree.md", "line": 38 }],
      "outputs": [{ "path": "outputs/01-flow-inspector.txt" }]
    }
  ]
}
```

## UI

**关系图 | 执行流程** → 点击任务块 → 右侧 **步骤详情**（代码行、prompt、产出可点）。

顶栏 **↻ 同步状态** = 只对齐 `status`；**⇄ 重排流程** = 按任务图重排 blocks（保留 `scripts/steps/`）。

## API

| 方法 | 路径 |
|------|------|
| GET | `/api/flow-script/drift?mode=project` |
| POST | `/api/flow-script/sync-status` |
| POST | `/api/flow-script/rebuild` |
| GET | `/api/flow-step?nodeId=N2` |
| PUT | `/api/flow-step` body: `{ nodeId, step, reason }` |
