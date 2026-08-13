# N7 审计：Markdown 知识库与联网检索 API 路由

> Worker N7 · v2 并行试跑 · 范围：`/api/knowledge*` 与 `/api/web-search*` 路由（grep + 局部读 `server.js` L2220–2331 及支撑函数），对照 `subtrees/N7-subtree.md` 需求与 Metrics。

## 结论摘要

| 项 | 状态 |
|----|------|
| 知识库配置（`.env` 优先，不回显 api_key） | ✅ `GET/PUT /api/knowledge/config` |
| 索引重建 + 进度 | ✅ `POST /api/knowledge/reindex` + `GET /api/knowledge/reindex-status` |
| 本地 RAG 检索（向量 + 词法混合） | ✅ `POST /api/knowledge/search` |
| 检索 + 问答一体 | ✅ `POST /api/knowledge/ask` |
| 联网搜索独立层 | ✅ `GET/PUT /api/web-search/config` + `POST /api/web-search/search` |
| 空本地索引不阻断联网 | ✅ `searchRetrieval` 将 empty index 降为 warning |
| no-key provider（searxng / openwebsearch） | ✅ `requiresApiKey: false` + `ensureOpenWebSearchDaemon` |
| api_key 不写入 task-tree.md | ✅ 仅存 `.env` / gitignored JSON |

**共 9 条 HTTP 路由**（knowledge 6 + web-search 3）；与 N6 的 `/api/model-agents/run` 通过 `searchRetrieval` / `runModelAgentWithTools` 间接耦合。

---

## `/api/knowledge` 路由清单

| 方法 | 路径 | 一行说明 |
|------|------|----------|
| **GET** | `/api/knowledge/config` | 返回 `config`（embedding/chat/chunk，仅 `hasApiKey`）、`index` 摘要（exists/createdAt/totalChunks）、`reindex` 作业状态、`webSearch` 配置、`openWebSearch` daemon 状态、Copilot 检测提示。 |
| **PUT** | `/api/knowledge/config` | 保存 `knowledge-config.json`（docsDir/embedding/chat/chunk）；校验 docsDir 在工作区内；返回脱敏后的 `config`。 |
| **POST** | `/api/knowledge/reindex` | 异步启动 `buildKnowledgeIndex`；202 返回 `{ ok, job }`；按 chunk 内容 ID 复用旧 embedding，仅对新/变更片段请求 `/embeddings`。 |
| **GET** | `/api/knowledge/reindex-status` | 返回内存中 `knowledgeReindexJob`（stage/percent/processedFiles/totalChunks/error 等）。 |
| **POST** | `/api/knowledge/search` | 调用 `searchRetrieval(query, { topK, includeKnowledge, includeWeb })`；默认含本地、不含 web；空索引时 errors 含提示但不阻断 web。 |
| **POST** | `/api/knowledge/ask` | 先 `searchRetrieval`，再按 `modelId` 选聊天模型，把 `buildKnowledgeContext(results)` 注入 system/user messages，调用 `callOpenAICompatible` 返回答案。 |

### POST `/api/knowledge/search` 请求/响应要点

**请求体**

- `query` — 必填
- `topK` — 默认 6，上限 20（本地侧）
- `includeKnowledge` — 默认 true
- `includeWeb` — 默认 false；为 true 时合并 `searchWeb` 结果

**响应体**

- `query`, `results[]` — 每项含 `source`（knowledge/web）、`path`/`url`、`title`、`content`、`score`
- `index` — 本地索引元数据（若 knowledge 分支成功）
- `errors[]` — 非致命警告（如「本地索引为空…联网检索仍可继续」）

---

## `/api/web-search` 路由清单

| 方法 | 路径 | 一行说明 |
|------|------|----------|
| **GET** | `/api/web-search/config` | 返回 `{ config, openWebSearch }`；`config` 含 `provider`、`requiresApiKey`、`hasApiKey`、`enabled`、`maxResults`。 |
| **PUT** | `/api/web-search/config` | 保存 `web-search-config.json`；provider/apiKey/baseUrl/enabled/maxResults。 |
| **POST** | `/api/web-search/search` | 直接 `searchWeb(query, { topK })`；不经过本地 knowledge 分支。 |

### Provider 矩阵（`searchWeb` 分发）

| provider | 需 API key | 需 baseUrl | 备注 |
|----------|------------|------------|------|
| `tavily` | ✅ | 可选（默认 api.tavily.com） | POST JSON |
| `brave` | ✅ | 可选 | GET + `x-subscription-token` |
| `exa` | ✅ | 可选 | POST + `x-api-key` |
| `searxng` | ❌ | ✅ 必填 | GET `?format=json` |
| `openwebsearch` | ❌ | 默认 3210 | POST `/search`；检索前 `ensureOpenWebSearchDaemon` 自动 build/spawn |

---

## 支撑函数（路由背后，非 HTTP）

| 函数 | 作用 |
|------|------|
| `loadKnowledgeConfig` / `saveKnowledgeConfig` | 合并 `knowledge-config.json` + `.env`（`KNOWLEDGE_*` / `EMBEDDING_*`）；`includeKey` 控制 key 回显 |
| `buildKnowledgeIndex` | 扫描 `docsDir` 下 `.md` → `chunkMarkdown` → 批量 embedding → 原子写 `knowledge-index.json` |
| `startKnowledgeReindex` | 后台 job + `onProgress` 更新 percent |
| `searchKnowledge` | query embedding + 余弦相似度 ×0.82 + 词法分 ×0.18；空索引 / 模型维度不匹配抛错 |
| `loadWebSearchConfig` / `saveWebSearchConfig` | 合并 `web-search-config.json` + `.env`（`WEB_SEARCH_*`）；`requiresApiKey` 区分 no-key provider |
| `searchWeb` | provider 路由；disabled 时返回空 results |
| `searchRetrieval` | 合并 knowledge + web；收集 errors；两者皆空且有 errors 才 throw |
| `buildKnowledgeContext` | 格式化片段供 ask / model-agents 注入（每段截断 1800 字符） |
| `getOpenWebSearchStatus` / `ensureOpenWebSearchDaemon` | daemon built/reachable/logs；search 前自动拉起 |

**持久化文件**（projectRoot，gitignore 或本地配置，非 task-tree.md）：

- `.env` — 主配置源（embedding、chat model、web search、openwebsearch engines）
- `knowledge-config.json` — docsDir/chunk/非敏感 embedding 字段
- `knowledge-index.json` — 全量 chunk + embedding 向量（可很大；`writeJsonFile` 原子写入）
- `web-search-config.json` — provider 等（key 也可来自 `.env`）

---

## 对照 N7 Metrics

| Metric | 实现证据 |
|--------|----------|
| 默认 `knowledge/` 下 Markdown 可重建索引 | `walkMarkdownFiles` + POST reindex |
| 检索显示来源路径、相似度、片段 | `searchKnowledge` results 含 path/score/content |
| 问答基于检索片段，不足时说明 | `/api/knowledge/ask` system prompt + `buildKnowledgeContext` |
| 多模型可附带检索片段 | N6 `run` + `searchRetrieval` / `providedKnowledgeContext` |
| 模型/embedding/web search 只配 `.env` 一次 | `loadLocalEnv` 覆盖 JSON 默认值 |
| 联网结果含 URL/分数/片段，可与本地合并 | `searchWeb` 统一 result shape + `searchRetrieval` |
| API key 不进 task-tree | 仅存 env/json；GET config 仅 `hasApiKey` |
| 多模型运行可自主检索本地库 | N6 `useKnowledgeSearch` → `searchRetrieval` |
| searxng 无 key 但缺 baseUrl 明确报错 | `searchSearxng` throw `missing searxng base_url` |
| openwebsearch 无 key + daemon 自动 resolve | `ensureOpenWebSearchDaemon` + GET config 返回 `openWebSearch` |
| 索引可复用、重建有进度与 embedding 复用 | `reindex-status` + `reusableEmbeddings` Map |

**已知边界**（子树 RootCauseAnalysis / CaseStudy）：

- Copilot `.obsidian` 索引不混用（维度/体积）；面板自建兼容索引
- 空本地索引与 daemon 不可达是独立问题；`searchRetrieval` 已拆分 errors 文案
- 大索引文件非原子写入历史上有损坏风险；当前 `writeJsonFile` 已用 temp+rename
- PUT config 仍允许写 JSON 内 key（兼容旧路径）；生产推荐仅 `.env`

---

## 与主树 stub 的关系

主树 `task-tree.md` 中 N7 为折叠 stub（`Folded: true` → `subtrees/N7-subtree.md`），边 E7 连 ROOT→N2→N6→N7；全局 `GraphState.Next` 为空。本 Worker 仅执行子树 NextPlan，**未写主树详文**。

---

## 建议（非本 Worker 实施）

1. **文档化 PUT config 与 `.env` 优先级**：前端已移除表单时，PUT 路径主要服务迁移/测试；应在 API 注释或 `.env.example` 标明「生产只改 `.env`」。
2. **索引健康检查**：GET config 的 `index.exists` 可增 JSON parse 失败标记（CaseStudy case 12 类损坏）。
3. **与 N6 契约**：run 响应中 `knowledgeResults`/`knowledgeErrors` 当前常为空数组 — 实际检索在 `results[].toolEvents`；子树 Input 可注明字段映射避免 UI 误读。

---

## 指标

| 指标 | 值 |
|------|-----|
| files_read | 5（`task-tree.md` 全文；`subtrees/N7-subtree.md`；`docs/subtree-parallel/prompts/worker-v2.md`；`docs/subtree-parallel/v2-N6-findings.md` 格式参考；`server.js` 局部 ~450 行 via grep+read，非整文件） |
| input_chars_est | ~38000 |
| wrote_task_tree_detail | false |
| read_other_subtree | false |
| cross_work_temptation_1_10 | 3（主树 stub 见 N6 AssignedTo 与 E7 边标签，但未打开 N6-subtree） |
| routes_listed | 9（knowledge 6 + web-search 3） |
