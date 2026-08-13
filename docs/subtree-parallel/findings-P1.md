# P1 审计：chain-step API 信息泄露

> 审计范围：`buildChainStepContext`、`buildChainAgentPrompt`、`evaluateChainLoopStop` 及对应 HTTP 端点。对照 `skills/task-tree-chain-run/SKILL.md`「只读 stepMarkdown、不暴露后续链节点」要求。

## 结论摘要

| 通道 | 后续节点 ID | 后续节点正文 | 完整 task-tree |
|------|-------------|--------------|----------------|
| `stepMarkdown` / `.chain-run/step-context.md` | 否 | 否 | 否 |
| `GET /api/graph-state/chain-step` JSON 整体 | **是** | 否 | 否 |
| `POST /api/graph-state/chain-advance` 的 `agentPrompt` | **是** | 否 | 否 |
| `GET /api/graph-state` | **是** | 否 | 否 |
| `GET /api/tree` | 是 | 是 | **是** |

**stepMarkdown 裁剪有效**；泄露主要来自 JSON 附带字段与其它未裁剪端点，依赖 Agent 自律而非服务端强制。

---

## 已确认的安全行为

1. **`buildChainStepContext`**：`getChainVisibleNodeIds` 仅保留 ROOT + 当前 Next 及之前链上节点；`buildRedactedGraphStateBlock` 输出 `ChainPosition: k/n`，不含完整 `Chain:` 行与 Edges。
2. **`chain-step` 的 `agentPrompt`**：调用 `buildChainAgentPrompt(..., { redactFuture: true })`，文案与 stepMarkdown 一致。
3. **`evaluateChainLoopStop`**：只读 Completion/NextPlan，不向外暴露链结构。
4. **`chain-loop-gate.ps1`**：TICK 仅输出 `Next=`，未打印完整 chain。

---

## 发现项（按 severity）

### [HIGH] F1 — `chain-step` JSON 附带完整 `chain` 与 `state.chain`

- **位置**：`buildChainStepContext` 返回值含 `chain: string[]`、`state.chain: string`（如 `"ROOT, ST-P2, ST-P3"`）。
- **影响**：Agent 若 `curl` 后解析整包 JSON（非仅 `stepMarkdown`），即可获知全部后续节点 ID，违反 SKILL「不列出后续 ID」。
- **建议**：响应中删除 `chain`；`state` 改为 redacted 副本（去掉 `chain` 或替换为 `ChainPosition`）；或新增 `?fields=stepMarkdown` 仅返回白名单字段。

### [HIGH] F2 — `GET /api/tree` 始终返回完整 task-tree.md

- **位置**：`/api/tree` 无链式模式开关。
- **影响**：任意可读本地服务的 Agent 可绕过 chain-step 门禁；SKILL 禁止读全树但无技术拦截。
- **建议**：链跑期间（`ChainRunStatus=running`）对该端点返回 403 或 redacted 视图；或要求 `X-Chain-Token` 才返回全文。

### [MEDIUM] F3 — `chain-advance` 的 `agentPrompt` 未启用 `redactFuture`

- **位置**：`advanceAgentChain` 两处 `buildChainAgentPrompt(..., chain)` 缺 `{ redactFuture: true }`（约 L1170、L1212）。
- **影响**：推进后响应含 `Chain: A → B → C → …` 全序列；与 chain-step 策略不一致。
- **建议**：统一传入 `{ redactFuture: true }`；`message` 中避免重复列出尚未执行的后续 ID。

### [MEDIUM] F4 — `GET /api/graph-state` 暴露完整 chain

- **位置**：L1990–2000 返回 `chain` 数组与含 `chain` 的 `state`。
- **影响**：比 chain-step 更轻量的旁路；多模型/脚本若误用此端点即泄露。
- **建议**：与 F1 相同 redaction；文档标明链式模式禁用此端点。

### [LOW] F5 — `chainPosition.total` 与节点正文间接泄露

- **位置**：JSON 的 `chainPosition.total`；已完成节点 `Notes`/`NextIdea` 可能写「下一步 ST-P3 做…」。
- **影响**：不暴露 ID 列表，但可推断链长与意图。
- **建议**：可选隐藏 `total`；在 AGENTS/skill 中要求链上节点勿引用未执行节点 ID。

---

## 可执行修复优先级

1. **P0**：F1 + F3 — 统一 JSON/`agentPrompt` redaction（改动小、收益大）。
2. **P1**：F2 — 链跑期间限制 `/api/tree`（需定义 running 判定与 UI 兼容）。
3. **P2**：F4、F5 — 旁路端点与文档/内容规范。

---

## 审计方法

静态阅读 `llm-task-tree-kit/server.js` 链式函数与路由；对照 `task-tree-chain-run/SKILL.md` 第 1、47–52 节承诺。未改代码，未跑 live curl（本 Worker 禁读全树验证）。
