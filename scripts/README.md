# 执行流程脚本（Agent 协议）

本目录存放 **Scratch 风格模块流**。  
**执行顺序以本目录为准**，高于 task-tree 节点 ID 排序或关系图布局。

> Agent：**仅在将要写入** `project.json` / `run.json` 时 Read 本文；平时不必读。  
> Cursor 规则：`.cursor/rules/llm-task-tree-flow-edit.mdc`  
> 总协议：`llm-task-tree/AGENTS.task-tree.md` §1c Edit-Flow Gate

## 文件

| 文件 | 含义 |
|------|------|
| `project.json` | **项目脚本**：完整主链 + 控制块（if / repeat 等） |
| `run.json` | **本次运行**：按 GraphState 裁切后的执行路径 |
| `versions/project/*.json` | 项目脚本历史版本 |
| `versions/run/*.json` | 本次运行脚本历史版本 |

## 与 task-tree 的分工

| 来源 | 作用 |
|------|------|
| `task-tree.md` | 节点语义、Problem/Approach、GraphState、**关系边** |
| `scripts/*.json` | **执行顺序**、条件/循环结构 |
| `subtrees/*.md` | 折叠子树内节点仍进 execution-catalog；**折叠不删已保存脚本块** |

## 何时修改（Agent）

**应当修改**：

1. 用户明确要求改流程图 / 执行顺序 / 模块流
2. **方法变更**（Approach、Problem 结构、新增/删除执行步骤）且需同步顺序

**不要修改**：

- 仅更新 CurrentResult、Notes、RootCauseAnalysis
- 折叠/展开子树
- 仅改 GraphState.Current/Next（除非用户要求同步 `run.json`）
- 关系图拖位置、改边标签

## 如何修改（Agent 步骤）

1. Read 本文 + 当前 `project.json`（改 run 时再读 `run.json`）
2. Read `task-tree.md`（+ 相关 `subtrees/*.md`）列出合法 `nodeId`
3. 编辑 `blocks`（见下 Schema）
4. 保存：
   - **推荐** `PUT /api/flow-script`  
     Body: `{ "mode": "project"|"run", "script": { "blocks": [...], "focusId": "Nx" }, "reason": "将调整N2在N3之前" }`
   - 或直接写 JSON 文件（改前手动备份到 `versions/`）
5. 在相关节点 `Notes` 写一句：已同步执行流程（改了什么）

## 步骤审计包 `scripts/steps/<nodeId>/`

每个 **task 块**的执行证据不在树节点里，而在：

| 路径 | 含义 |
|------|------|
| `scripts/steps/<nodeId>/latest/step.json` | 子步骤、代码行、prompt/产出路径 |
| `scripts/steps/<nodeId>/latest/report.zh.md` | **中文审计主入口**（UI 步骤详情可点） |
| `prompts/*.en.md` / `*.zh.md` | 英文原文 + 中文备份 |

完成某步或方法变更后：`GET /api/flow-script/drift` → 更新 blocks → `PUT /api/flow-step`。详见 **`scripts/steps/README.md`**。

## Schema：`flow-script/v1`

顶层字段：

```json
{
  "schema": "flow-script/v1",
  "mode": "project",
  "focusId": "N2",
  "updatedAt": "2026-06-30T12:00:00.000Z",
  "blocks": []
}
```

- `mode`: `"project"` 或 `"run"`
- `focusId`: 当前关注节点 ID（通常 GraphState.Current 或 Next）
- `blocks`: 有序块列表；**第一个通常是帽块**

### 块类型

| type | 用途 | 必填字段 |
|------|------|----------|
| `hat` | 脚本起点 | `title`: `"当项目开始"` 或 `"当本次运行开始"` |
| `task` | 执行一个树节点 | `nodeId`, `title`, `status` |
| `ref` | 参考/并行节点（不阻塞主链） | `nodeId`, `title`, `status` |
| `if` | 条件分支 | `condition`, `body`[] |
| `ifElse` | 条件分支 + else | `condition`, `body`[], `elseBody`[] |
| `repeat` | 固定次数循环 | `times`, `body`[]；可选 `label` |
| `repeatUntil` | 直到条件 | `condition`, `body`[] |
| `forever` | 无限循环 | `body`[] |
| `wait` | 等待 | `seconds` |
| `waitUntil` | 等到条件 | `condition` |
| `stop` / `stopAll` | 停止 | 见 UI 生成 |

- 每块有唯一 `id`（如 `b-kxmw7hf`）
- **`task` / `ref` 的 `nodeId` 必须存在于 task-tree**（含 subtrees 编入 catalog 的节点）
- **`status`**: `"pending"` | `"active"` | `"done"`（与节点 Completion 对应）

### 最小示例（project）

```json
{
  "schema": "flow-script/v1",
  "mode": "project",
  "focusId": "ROOT",
  "blocks": [
    { "id": "b-hat1", "type": "hat", "title": "当项目开始" },
    { "id": "b-t1", "type": "task", "nodeId": "ROOT", "title": "项目总目标", "status": "active" },
    { "id": "b-t2", "type": "task", "nodeId": "N1", "title": "第一个子问题", "status": "pending" },
    { "id": "b-t3", "type": "task", "nodeId": "N2", "title": "第二个子问题", "status": "pending" }
  ]
}
```

### 带 repeat 的示例

```json
{
  "id": "b-r1",
  "type": "repeat",
  "label": "依次执行子步骤",
  "times": 2,
  "body": [
    { "id": "b-t4", "type": "task", "nodeId": "N1_1", "title": "子步骤 A", "status": "pending" },
    { "id": "b-t5", "type": "task", "nodeId": "N1_2", "title": "子步骤 B", "status": "pending" }
  ]
}
```

### 条件块（condition 简例）

```json
{
  "type": "boolStatus",
  "status": "done"
}
```

复杂条件可用 `boolAnd` / `boolOr` / `boolNot` 嵌套（与 UI 调色板一致）。

## 从零生成

- UI：**关系图 | 执行流程** → **↻ 重新生成**（从 execution-catalog 覆盖当前模式，会先版本备份）
- Agent：一般 **Read 现有 JSON 再改**；仅当 `blocks` 为空且用户要求初始化时，可 GET `/api/flow-script?mode=project` 参考 auto-build 结果后再 PUT

## 人类 UI

主应用 **关系图 | 执行流程** 切换；拖块会自动 debounce 保存。

## API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/flow-script?mode=project` | 读脚本 + execution-catalog |
| PUT | `/api/flow-script` | 保存；body 含 `mode`, `script`, `reason` |
| POST | `/api/flow-script/restore` | 从 `scripts/versions/` 恢复 |
