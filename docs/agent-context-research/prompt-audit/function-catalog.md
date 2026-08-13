# AGENTS.md 功能目录

> 原文冻结文件：`AGENTS.original.20260710.md`。逐行带标签版本和逐语句 TSV 由 `scripts/audit-agent-prompt.mjs` 生成。

| ID | 功能 | 风险 | 重构后落点 |
|---|---|---|---|
| F00 | 项目入口、任务树用途与权威声明 | critical | 根 `AGENTS.md` |
| F01 | 活树只保留 compact current state，清除陈旧/冲突内容 | critical | 根入口摘要 + 完整树协议 §0 |
| F02 | 各字段硬预算与内容上限 | high | 完整树协议 §0/§3 + tree-lint |
| F03 | 大树精炼的测量、范围和压缩目标 | high | 完整树协议 §0 + tree-lint |
| F04 | 父节点索引化、新节点成本、方法替换和不过度精炼 | high | 完整树协议 §0/§4 |
| F05 | 任务开始时读取焦点、逐节点执行和方向变化处理 | critical | 根 `AGENTS.md` + 完整树协议 §1 |
| F06 | SelectedSkills 解析、按需加载与 routing log | high | 根路由 + 完整树协议 §1/§6 |
| F07 | 写 task-tree/subtree 前的强制读取与备份门禁 | critical | 根路由 + 完整树协议 §1b |
| F08 | 写 flow 前的 schema、备份、nodeId 与 drift 门禁 | critical | 根路由 + `scripts/README.md` |
| F09 | 任务结束后的最小写回、字段更新和用户告知 | critical | 根完成定义 + 完整树协议 §2 |
| F10 | GraphState 由用户控制，链式推进只能走 API | critical | 根不可违反规则 + 完整树协议 §2 |
| F11 | CurrentResult/RCA/CaseStudy/I/O/Approach 的写法与示例 | high | 完整树协议 §3 + skill references |
| F12 | 推理图、节点、二元边、schema 与字段语义 | high | 完整树协议 §3–§5 + schema reference |
| F13 | 关系图与执行流程分工、step evidence、drift 同步 | critical | 根路由 + `scripts/README.md` |
| F14 | skill-routing-log 的触发、格式和不应记录的情况 | medium | 完整树协议 §6 |
| F15 | task-tree 与 flow 的版本备份规则 | high | 完整树协议 §7 + `scripts/README.md` |
| F16 | 回滚后权威状态、orphan artifact 与重做规则 | critical | 根不可违反规则 + 完整树协议 §8 |
| F17 | 写树结束前的完整检查清单 | high | 完整树协议 §9 + postflight |
| F18 | Agent chain 每 tick 的读取、停止和推进协议 | critical | 根路由 + chain-run skill/完整协议 §10 |
| F19 | 安装到其它项目时的短 stub、merge 标记和 UI 入口 | medium | `llm-task-tree-kit/templates/AGENTS.merge.md` |
| F20 | 工具参数、路径、恢复和专用工具选择规则 | high | 根 `AGENTS.md` always-on |

## 后续用户批准的覆盖规则

| ID | 功能 | 风险 | 重构后落点 |
|---|---|---|---|
| F21 | 活树核心状态删除测试和总大小门禁 | high | 根入口 + `task-tree-core-state` |
| F22 | 节点默认简明中文、复杂英文术语移出、语义字段禁止代码和原始样例 | critical | 根入口 + `AGENTS.node-writing.md` + tree-quality gate |

F21–F22 不属于冻结原文的 F00–F20 映射；它们是用户批准的新覆盖规则，不修改冻结原文或逐句标注。

## 功能等价标准

- 原文每个非空行至少映射到一个功能 ID。
- 原文每个语句/结构单元出现在 `statement-map.tsv`。
- F00–F20 必须全部出现在新根入口或其强制路由表中。
- critical 功能必须在根入口中出现明确规则或明确的 `MUST read` 触发，不允许只靠隐含链接。
- 完整树协议、schema、flow、chain、merge stub 的目标文件必须真实存在。
