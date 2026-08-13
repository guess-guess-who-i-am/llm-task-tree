# 项目执行流程总览

> 执行顺序以 `scripts/project.json` 为准（flow-script/v1）。当前焦点 **N2**（GraphState.Current）。  
> 打开方式：双击 `打开任务图.cmd` → 顶栏 **执行流程** → 点击任务块查看右侧步骤详情。

## 主链顺序（12 步）

| 序 | 节点 | 标题 | 状态 | 审计报告 |
|----|------|------|------|----------|
| 1 | ROOT | 建立可共享的大模型任务上下文 | 进行中 | [report.zh.md](steps/ROOT/latest/report.zh.md) |
| 2 | N1 | 设计 Markdown 节点格式 | 待开始 | [report.zh.md](steps/N1/latest/report.zh.md) |
| 3 | N2 | 实现可视化图谱编辑器 | 待开始 | [report.zh.md](steps/N2/latest/report.zh.md) |
| 4 | N3 | 让 Codex 同步维护任务图 | 进行中 | [report.zh.md](steps/N3/latest/report.zh.md) |
| 5 | N4 | 分析本地 skill 仓库与自动调用机制 | 待开始 | [report.zh.md](steps/N4/latest/report.zh.md) |
| 6 | N5 | 处理任务树回溯后的文件漂移 | 已完成 | [report.zh.md](steps/N5/latest/report.zh.md) |
| 7 | N6 | 节点内多模型协作 | 进行中 | [report.zh.md](steps/N6/latest/report.zh.md) |
| 8 | N7 | 集成 Markdown 知识库检索面板 | 进行中 | [report.zh.md](steps/N7/latest/report.zh.md) |
| 9 | N9 | 可移植任务树 Kit 打包 | 已完成 | [report.zh.md](steps/N9/latest/report.zh.md) |
| 10 | N10 | 执行顺序视图（Scratch 模块流原型） | 已完成 | [report.zh.md](steps/N10/latest/report.zh.md) |
| 11 | ST-P1 | 子树试点A chain-step 审计 | 已完成 | [report.zh.md](steps/ST-P1/latest/report.zh.md) |
| 12 | ST-P2 | 子树试点B 并行冲突梳理 | 已完成 | [report.zh.md](steps/ST-P2/latest/report.zh.md) |

**块总数**：`project.json` 含 1 个帽块 + 12 个 task 块 = **13 blocks**。

## 方法结构（为何是这个顺序）

1. **ROOT → N1 → N2**：先定 Markdown schema，再做可视化编辑器——人机共享上下文的载体。
2. **N3 / N5**：Agent 写树协议与回溯漂移规则，保证图与文件系统一致。
3. **N4**：skill 推荐扩展，让节点可选能力进入执行链。
4. **N6 / N7**：在 N2 编辑器上扩展多模型协作与知识库 RAG（边 E6/E7/E8）。
5. **N9**：Kit 打包，把 N2 能力复制到其他项目。
6. **N10**：执行流程视图 + 步骤审计 + drift API——把「方法顺序」从关系图分离到 `scripts/`。
7. **ST-P1 / ST-P2**：子树并行试点审计与冲突梳理（独立参考步，挂 ROOT）。

## 维护与漂移

- 任务图变更后：`GET /api/flow-script/drift?mode=project` 或 UI **↻ 同步状态** / **⇄ 重排流程**
- Agent 协议：[scripts/README.md](README.md) · [scripts/steps/README.md](steps/README.md)
- 机器可读脚本：[project.json](project.json)（focusId=N2）

## 当前下一步

**N2**：Ctrl+F5 后验证节点 × 在九宫格右上角；关系图/流程图 ⤓ 导出 SVG 文字完整（见 task-tree GraphState.NextPlan）。

---

*生成时间：2026-07-08 · 对应 scripts/project.json rebuild*
