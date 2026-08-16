# N3 - 让 Codex 同步维护任务图

## 当前目标达成状态

多 Agent 已不再默认共用全局 `GraphState.Next`：每个 Agent 可获得独立执行范围，只能推进和写回被分配节点。内置 coordinator 已自动接入；手动多会话仍需用户做一次真实操作验收。

## 已落地

- 执行范围保存目标节点、可写节点、写集、任务说明和状态；全局 Current/Next 保留为人类项目主视角。
- `task_tree_focus` 有范围时返回 `assignedNodes`；`task_tree_write` 由服务端校验节点权限，范围内禁止整树覆盖。
- 节点写入改为服务器读取最新树后串行应用字段补丁，避免不同 Agent 的旧快照互相覆盖。
- coordinator 自动创建和关闭 worker/coordinator 范围，并通过环境与 Prompt 注入 `scopeId`。
- `AGENTS.md` 新增 F25 后置覆盖；冻结详细协议保持字节级不变。中英文逐轮 Prompt 已发布到本机和 `huangyu`。

## 验证

- 两个 Agent 分别领取 N1/N2，读取到不同执行目标。
- Agent A 写 N2 被服务端拒绝。
- A/B 并发写 N1/N2 后，两个结果均保留。
- 完整 MCP、协调器、多树维护、插件包、共享安装、Prompt 覆盖和 compact 门禁全部通过。

## 2026-08-16 发布链统一验收

- 根因：源码、共享 kit、平台缓存、远程 kit 与运行进程此前没有统一验收；插件版本未变时宿主会复用旧缓存。
- 插件版本改为 `0.8.0+codex.20260816062259`，移除 Codex 不接受的 `interface.websiteUrl`；清单测试与官方插件校验均通过。
- 本机 32 个有效项目、Codex 两处缓存、Cursor/Claude/Trae 分发和 `huangyu:/data/fqd/llm-task-tree-kit` 均通过 20/20 审计；远程四个服务已重启并返回正确项目根目录。
- 侧栏真实滚轮回归连续 3 次通过，内容可从 482px 可视区滚动到 1133px 底部。

## 关联

- [step.json](./step.json)
- [执行范围模块](../../../../server/execution-scope.js)
- [节点补丁模块](../../../../server/tree-node-patch.js)
- [并发回归](../../../../scripts/test-execution-scopes.mjs)
- [N3 子树](../../../../subtrees/N3-subtree.md)
