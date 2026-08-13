# E2E 真实模拟 — 完整痕迹记录

> 供人工复查。测试项目：`e2e-simulation/beauty-frontend-demo/`

## 1. 场景与角色

| 角色 | 职责 |
|------|------|
| 主 Agent | 创建 E2E 文件夹、运行 install、启动服务、API/浏览器验收、记录缺陷 |
| Subagent `b2d4534e-f341-4795-bf86-e86c6afc1c79` | 读 AGENTS.md + task-tree-grill，按预录 grill 决策建树，实现美女护肤 landing page |

**用户预录决策（模拟 grill，不逐问等待）：**

- 目标：中文护肤单页 landing，优雅女性风，移动友好
- 技术：Plain HTML/CSS/JS，`src/index.html` + `src/styles.css`
- 区块：Hero、3 产品卡、testimonials、newsletter、footer
- 配色：soft rose + cream + gold
- 验收：浏览器 polished + task-tree 更新

---

## 2. 时间线

| 时间 (UTC+8 约) | 事件 | 证据 |
|-----------------|------|------|
| 00:34 | 创建 `e2e-simulation/beauty-frontend-demo/`，复制 `llm-task-tree-kit` | 目录存在 |
| 00:35 | 运行 `llm-task-tree/install.ps1` | 创建 AGENTS.md、task-tree.md、versions/、.env |
| 00:36–00:39 | Subagent 读 AGENTS + grill skill，备份并写入 6 节点树 | `versions/20260622-003610_*.md` |
| 00:37–00:38 | 创建 `src/index.html`、`src/styles.css` | 10KB + 14KB |
| 00:39 | 更新各节点 CurrentResult，GraphState → N3 | `task-tree.md` |
| 01:04 | **发现 BUG**：缺 `task-tree.config.json` → `/api/tree` 500 | 见 §5 |
| 01:05 | 补 config 并重启服务 | `llm-task-tree/task-tree.config.json` |
| 01:06–01:08 | API + 浏览器 E2E 验收 | 见 §4 |
| 01:08 | 版本回退测试 → 恢复最新版 | tree 638→4295 bytes |

---

## 3. Subagent 交付物（可复查）

```
e2e-simulation/beauty-frontend-demo/
├── AGENTS.md                    # install 创建，含 llm-task-tree 块
├── task-tree.md                 # 6 节点完整树（ROOT,N0–N4）
├── versions/                    # 2 个 agent 备份
├── e2e-agent-log.md             # subagent 逐步日志
├── src/index.html               # 柔光·护肤 landing
├── src/styles.css
└── llm-task-tree/               # kit + task-tree.config.json（后补）
```

**Subagent 日志：** `beauty-frontend-demo/e2e-agent-log.md`

---

## 4. E2E 功能验收矩阵

| 功能 | 方法 | 结果 | 说明 |
|------|------|------|------|
| **install.ps1** | 真实执行 | ✅ PASS | 创建 AGENTS/task-tree/versions/.env |
| **AGENTS.md 合并** | 读文件 | ✅ PASS | 新项目创建 AGENTS.md + llm-task-tree 块，未覆盖（无旧文件） |
| **读 AGENTS 建树** | subagent | ✅ PASS | 读 `AGENTS.md` + `AGENTS.task-tree.md` + grill skill |
| **task-tree-grill 流程** | subagent | ✅ PASS（预录模式） | 5 项决策写入 N0，非交互逐问 |
| **versions 备份** | 磁盘 + API | ✅ PASS | 2 个版本；agent 按协议备份 |
| **GET /api/project** | HTTP | ✅ PASS（fix 后） | `name=beauty-frontend-demo`，root=项目根 |
| **GET /api/tree** | HTTP | ❌→✅ | 缺 config 时 500；补 config 后 4295 bytes |
| **GET /api/versions** | HTTP | ✅ PASS | 返回 2 条 |
| **POST /api/skills/recommend** | HTTP | ✅ PASS | 返回 grill-with-docs 等 |
| **GET /api/file?path=src/index.html** | HTTP | ✅ PASS | 9137 bytes |
| **GET /api/knowledge/config** | HTTP | ⚠️ PARTIAL | 0 chunks；`.env` 无 embedding key，预期 |
| **GET /api/model-agents** | HTTP | ⚠️ PARTIAL | 0 models；`.env` 未配 MODEL_AGENT，预期 |
| **任务图 UI 加载** | 浏览器 :5299 | ✅ PASS | 6 节点 6 边，截图见下 |
| **树形排版 ⇲** | 浏览器点击 | ✅ PASS | 节点展开可交互 |
| **I/O 预览 + 打开文件** | 浏览器 | ✅ PASS | 显示 `src/index.html` 链接 |
| **NextPlan + 推荐 skill** | 浏览器/API | ✅ PASS | NextPlan 显示；API 有推荐（UI 点击被版本栏遮挡） |
| **版本树回退** | 浏览器点击旧版本 | ✅ PASS | tree 4295→638 bytes，无 N1 |
| **版本恢复最新** | POST /api/restore | ✅ PASS | 恢复后 len=4295 |
| **落地页渲染** | http://127.0.0.1:5300 | ✅ PASS | Hero/产品/评价/newsletter/footer 齐全，rose/cream/gold |
| **多模型协作** | — | ⏭ SKIP | 未配 API key，非本场景阻塞项 |
| **知识库重建** | — | ⏭ SKIP | 无 embedding key |

### 浏览器截图（主 Agent 实拍）

- 任务图界面：6 节点、版本树 2 条、I/O 预览 — `page-2026-06-21T17-06-05-551Z.png`（Cursor screenshots 目录）
- 落地页：柔光·护肤 — `page-2026-06-21T17-08-00-996Z.png`

---

## 5. 发现的缺陷与修复

### BUG-1：复制 kit 后缺少 `task-tree.config.json`（严重）

- **现象**：服务启动后 `/api/tree` → 500 ENOENT `llm-task-tree/task-tree.md`；`/api/project.root` 指向 kit 目录而非项目根
- **根因**：`llm-task-tree-kit` 复制时未带上 config，或 install 未校验创建
- **修复**：
  - E2E 手补 `llm-task-tree/task-tree.config.json` `{ "projectRoot": ".." }`
  - 已改 `llm-task-tree-kit/install.ps1`：若缺 config 则自动创建
- **建议**：`build-kit.ps1` 同步时强制包含 `task-tree.config.json`

### UX-1：「推荐 skill」按钮易被版本树遮挡

- **现象**：点击 Next 节点「推荐 skill」时，版本栏 intercept click
- **严重性**：低；API 层正常

### NOTE-1：skill 推荐未命中 kit 内 `task-tree-grill`

- **现象**：推荐结果为 `grill-with-docs` 而非 kit 内 grill
- **原因**：推荐器扫全局 ~/.agents/skills；kit 内 skill 需项目 `./skills` 或更高分匹配
- **建议**：install 时可选复制 `task-tree-grill` → `../skills/`

---

## 6. AGENTS.md 链路验证

1. `install.ps1` 创建根 `AGENTS.md`，指针 → `llm-task-tree/AGENTS.task-tree.md` ✅
2. Subagent 读取根 `AGENTS.md` + 完整协议 ✅
3. Subagent 使用 `llm-task-tree/skills/task-tree-grill/SKILL.md` ✅
4. 每次改树前写入 `versions/` ✅（2 个备份文件）

---

## 7. 如何复现本测试

```powershell
cd E:\解决跟不上大模型思路问题\e2e-simulation\beauty-frontend-demo\llm-task-tree
# 确保 task-tree.config.json 存在且 projectRoot 为 ".."
$env:PORT=5299; node server.js

# 任务图 http://127.0.0.1:5299
# 落地页 cd ..\src; python -m http.server 5300 → http://127.0.0.1:5300
```

---

## 8. 结论

- **Kit 核心流程可用**：install → AGENTS → grill 建树 → 逐节点实现 → task-tree 更新 → 任务图 UI → 版本回退
- **必须先有 `task-tree.config.json`**，否则子目录部署会失败（已修 install）
- **Subagent 交付的 landing page 真实可渲染**，非 smoke
- **待你决定**：是否将 install 增加「复制 task-tree-grill 到项目 skills/」、是否修版本栏遮挡

---

## Subagent 执行摘要

（Subagent 返回）建树 6 节点；实现 index.html + styles.css；GraphState 终态 Current=N3；无阻塞错误。详见 `beauty-frontend-demo/e2e-agent-log.md`。
