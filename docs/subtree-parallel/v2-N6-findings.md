# N6 审计：节点内多模型协作 API 路由

> Worker N6 · v2 并行试跑 · 范围：`/api/model-agents*` 路由（grep + 局部读 `llm-task-tree-kit/server.js`），对照 `subtrees/N6-subtree.md` 需求与 Metrics。

## 结论摘要

| 项 | 状态 |
|----|------|
| 模型配置 CRUD（不含 api_key 回显） | ✅ `GET/PUT /api/model-agents` |
| 节点内并发运行 | ✅ `POST /api/model-agents/run` |
| 树快照一致性标记 | ✅ 返回 `treeSnapshotHash` / `treeChangedDuringRun` |
| 模型自主检索工具循环 | ✅ `useKnowledgeSearch` + `runModelAgentWithTools`（最多 4 步） |
| 页面内临时会话 / 跨模型共享 | ✅ 请求体 `histories` / `sharedHistories`，不落盘 |
| api_key 不写入 task-tree.md | ✅ 仅存 `model-agents.json`（gitignore）+ `.env` 覆盖 |

**`/api/model-agents` 前缀仅 3 条路由**；历史读写走独立前缀 `/api/model-agent-history`（本包 NextPlan 未要求展开）。

---

## `/api/model-agents` 路由清单

| 方法 | 路径 | 一行说明 |
|------|------|----------|
| **GET** | `/api/model-agents` | 返回全部模型配置（`hasApiKey` 布尔、不回显 key）及各自 `agentPrompt` 全文（读 `model-agents/<id>.md`）。 |
| **PUT** | `/api/model-agents` | 保存 `body.models` 到 `model-agents.json`；空 key 保留旧值；可选写 `agentPrompt` 到 agent 文件并确保目录存在。 |
| **POST** | `/api/model-agents/run` | 对 `modelIds` 并发调用 OpenAI-compatible API：注入整棵/链裁剪 task-tree、当前节点 Markdown、agent prompt、临时 history/sharedHistory；可选工具检索；返回分模型结果与树快照 hash。 |

### POST `/api/model-agents/run` 请求/响应要点

**请求体（主要字段）**

- `modelIds[]` — 必填，要运行的模型 ID
- `question` — 必填，用户问题
- `nodeId` — 当前节点 ID，用于 `extractNodeMarkdown`
- `contextNodeIds[]` — 可选，链式裁剪树（`buildChainTreeMarkdown`）
- `useKnowledgeSearch` — 为 true 时启用模型自主 search JSON 工具循环
- `includeWeb` — 检索是否含联网
- `histories` / `sharedHistories` — 页面内临时多轮与跨模型共享（对象，按 modelId 索引）
- `knowledgeContext` — 可选预填检索上下文（截断 12000 字符）

**响应体（主要字段）**

- `treeSnapshotHash` — 运行开始时 `task-tree.md` 短 hash
- `treeChangedDuringRun` — 运行结束重读磁盘，hash 是否变化
- `results[]` — 每模型 `{ id, name, model, ok, answer?, error?, toolEvents?, elapsedMs }`
- `elapsedMs` — 总耗时

**并发与失败**：`Promise.all` 并行；单模型异常捕获为 `ok: false` + `error` 字符串，不拖垮其它模型。

---

## 支撑函数（路由背后，非 HTTP）

| 函数 | 作用 |
|------|------|
| `loadModelAgents` | 合并 `model-agents.json` 与 `.env` 的 `MODEL_AGENT_*`；`includeKeys` 控制是否带 api_key |
| `saveModelAgents` | 规范化写入 JSON；创建默认 `model-agents/<id>.md` |
| `loadModelAgentDetails` | GET 处理器：配置 + 读入 agent 文件内容 |
| `readModelAgentPrompt` | 读 agent 文件，不存在则写默认 prompt |
| `runModelAgentWithTools` | 组装 messages → 最多 4 轮 LLM + `parseAgentToolRequest` → `searchRetrieval` 回填 |
| `callOpenAICompatible` | 支持 `wireApi: chat`（/chat/completions）或 `responses`（/responses） |

**持久化文件**（projectRoot，非 task-tree.md）：

- `model-agents.json` — 配置（含 api_key）
- `model-agents/<id>.md` — 每模型 agent system prompt
- `model-agent-history.json` — 由 `/api/model-agent-history` 读写；run 路径当前不写入历史（与子树 CaseStudy case 4 一致）

---

## 对照 N6 Metrics

| Metric | 实现证据 |
|--------|----------|
| 网页新增/保存多模型，api_key 不进 task-tree | PUT 写 json；GET 仅 `hasApiKey` |
| 节点内勾选多模型并发 | POST run + `Promise.all` |
| 每模型见整树、当前节点、agent.md、临时 history/shared | `buildModelAgentMessages` + run 请求体 |
| 模型自主决定检索关键词 | `enableTools` + search JSON 循环 |
| 结果分模型展示、失败有明确错误 | `results[].ok` / `error` |

**已知边界**（子树 Notes / RootCauseAnalysis）：

- 不做 judge 融合；输出不写 task-tree / 不持久化本轮对话
- 运行中用启动快照树，避免编辑中途干扰；`treeChangedDuringRun` 仅告警
- 刷新页面清空临时 histories / sharedHistories

---

## 与主树 stub 的关系

主树 `task-tree.md` 中 N6 为折叠 stub（`Folded: true` → `subtrees/N6-subtree.md`），`GraphState` 全局 Next 为空；本 Worker 仅执行子树内 NextPlan，**未写主树详文**。

---

## 建议（非本 Worker 实施）

1. **文档化相邻路由**：UI 若仍调用 `GET/DELETE /api/model-agent-history`，应在 N6 子树 Input 中注明与 run 路径的脱钩（历史 API 存在但 run 不写入）。
2. **融合裁判**：子树 `NextIdea` 已指向可选 judge 模型 — 需新路由或扩展 run 响应，当前无实现。
3. **链式裁剪**：run 支持 `contextNodeIds`，与 chain-step redaction 策略应对齐（避免多模型侧路读全树）。

---

## 指标

| 指标 | 值 |
|------|-----|
| files_read | 5（`task-tree.md` 全文；`subtrees/N6-subtree.md`；`docs/subtree-parallel/prompts/worker-v2.md`；`docs/subtree-parallel/findings-P1.md` 格式参考；`llm-task-tree-kit/server.js` 局部 ~350 行 via grep+read，非整文件） |
| input_chars_est | ~42000 |
| wrote_task_tree_detail | false |
| read_other_subtree | false |
| cross_work_temptation_1_10 | 2（仅见主树 stub 索引与其它包 AssignedTo，未打开 N3/N7 子树） |
