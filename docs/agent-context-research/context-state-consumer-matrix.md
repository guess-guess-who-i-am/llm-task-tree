# 上下文状态来源与消费者矩阵

上下文换代不是新的事实源。任务树、用户消息、运行状态和可核验证据是输入；`context-checkpoint.json` 是可重新生成的派生状态，Markdown 只是阅读视图。

| 信息 | 权威来源 | 编译/传递 | 消费者 | 机械门禁 |
|---|---|---|---|---|
| 根目标、当前阶段、下一动作 | `task-tree.md` 与角色树锚点 | `contextTreeFingerprint` + checkpoint compiler | 新主会话、并行 run 目标 | 树指纹变化后禁止复用旧 checkpoint；当前节点必须有 tree sourceRef |
| 用户确认与方向纠错 | 真实 `userMessage` turn | `extractRecentConversation` + `user_confirmed` fact | 新主会话、Supervisor 收到的用户消息 | turnId 必须来自本轮输入或上一代已验证 sourceRef |
| 已验证能力 | 文件、测试、任务树结果、证据文档 | `verified_fact` | 新主会话、Coordinator/Supervisor | 必须有 tree/evidence sourceRef 或 evidenceRefs |
| 模型建议 | assistant 结论 | `model_proposal` | 供用户和 Supervisor 审核 | 不得升级为 `user_confirmed` |
| 已取代结论 | 新旧事实与用户纠错 | `superseded` + `supersedes` | 新主会话 | 旧事实保留来源，状态必须是 `superseded` |
| Worker 局部状态 | 分支 handoff、写集、分支测试 | branch context JSON | 同一分支下一代 | 作用域为 branch；不得写共享树和其他写集 |
| Peer 协作 | taskId、线程链接、结构化回答 | peer message | 请求方 Worker、Coordinator | 链接仅导航；回答必须分离 conclusion、evidenceRefs、unknowns，仍需核验 |
| 运行调度 | `.task-tree-runs/` | Supervisor 事件与 run JSON | Supervisor、前端运行树 | 用户验收前不得进入长期任务树 |

## 唯一源码与分发

| 层 | 位置 | 生成方式 | 校验 |
|---|---|---|---|
| 开发源码 | `server/`、`server.js`、`public/` | 人工实现的唯一运行时源码 | Node 测试与真实 UI 测试 |
| 共享 kit | `llm-task-tree-kit/` | `scripts/build-kit.ps1` 从根源码生成 | `scripts/test-share-install.mjs`、`scripts/audit-deployment-sync.mjs` |
| 仓库插件 runtime | `marketplace/plugins/task-tree/runtime/` | `scripts/build-plugin-runtime.mjs` | `node scripts/build-plugin-runtime.mjs --check` |
| Codex 安装缓存 | Codex plugin cache | 插件安装/缓存刷新 | `scripts/audit-deployment-sync.mjs` |
| 远程 Linux kit | 显式 SSH 目标 | 本地 kit 发布 | `scripts/audit-deployment-sync.mjs --remote host:/path` |

发布完成的最低条件是根源码、共享 kit、仓库插件 runtime 一致；安装缓存和远程副本若未更新，必须明确报告为未发布，不能把仓库内部一致误报为全部消费者已更新。
