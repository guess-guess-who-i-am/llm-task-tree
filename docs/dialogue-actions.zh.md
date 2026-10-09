# 节点对话：停止、编辑重发、导出

## 使用入口

刷新 IDE，打开节点对话。模型运行期间，输入框下面显示「停止」。停止完成后，状态显示「本轮已停止」，可以继续发消息，也可以点任意历史用户消息右上角的「编辑重发」。修改输入框中的内容，再点「保存并重发」。对话标题栏的「导出」将记录直接保存到当前 Mac 用户的桌面，并在对话框中显示完整路径。

编辑只针对用户消息。保留所选消息之前的上下文和该消息的原附件，替换其后的对话；替换前的文字记录备份在工作目录 `.task-tree-dialogue-backups`。取消编辑会恢复原草稿；发送失败不会清空输入或附件。每个节点仍然只有一个最新持续对话。停止和编辑均不会撤销已经保存的文件修改。

导出为 UTF-8 Markdown，包含完整用户消息、模型答复和附件链接；运行期间导出包含已收到的部分输出。不导出工具日志或思考内容，不复制附件二进制。附件链接需要原 IDE 服务及对应资料仍可访问。重复导出生成不同文件，不覆盖旧文件；服务器部署在其它机器时，「桌面」指运行服务的那台机器。

## 权威接口契约

`POST /api/codex/run/:id/stop` 的请求包含 `treeId`、`nodeId`，必须与执行记录匹配。运行中的记录进入 `stopping`，响应为 202；取消模型请求、重试等待和该节点工具连接后进入 `stopped`。已经结束的重复停止返回 200。记录不存在或节点不匹配返回 404。共享工具 Worker 本身和其他节点不会被关闭。停止清理期间禁止继续、编辑及删除。

`POST /api/codex/run` 保留节点执行接口，编辑时额外传整数 `editMessageIndex` 和当前 `sourceRunId`，并提供 `progress: true`、`treeId`、`nodeId`、非空 `prompt`。索引只能指向用户消息；无效索引、模型消息、空消息返回 400。旧页面的执行标识返回 409。正常编辑先解析附件、备份旧记录，再提交新的上下文，响应 202。原文件不会回滚。

`POST /api/codex/conversation/export` 接受 `treeId`、`nodeId`，返回 `{ok: true, path}`。缺少节点定位返回 400，无记录返回 404。客户端不能指定任意导出目录。文件以独占方式创建，名称包含节点、时间与随机标识。

## 实现和验证

取消从 `server.js` 的每轮独立 AbortController 传入 `startDeepSeekTurn`，继续传递至请求、退避等待和工具执行。用户停止和内部超时分开：前者为 `stopped`，后者仍为 `failed`。停止不再运行额外树摘要维护；下一次读取摘要会依据文件指纹更新。对话文字由 IDE 状态文件保留，重启不会丢失停止前收到的输出。

源代码的模型循环 41 项、对话动作 3 项、状态恢复 8 项、进度 6 项、共享 Worker 2 项及相邻浏览器 22 项全部通过。新增端到端场景覆盖流中停止、其它节点继续、停止后恢复、重复停止、刷新保留、原附件随编辑重发、旧页面和非法索引拒绝、备份、长中文全文导出、运行中导出及桌面/手机入口。工具测试确实启动并终止子进程，不以按钮状态代替执行停止。

安装版私有 Node 22 的 60 项运行时测试和完整新浏览器场景通过；源码、kit、插件的 94 个运行时文件一致。实际 5491、5866 工作区已在无运行任务时重启，树文件和对话状态文件哈希不变。两处真实页面编辑/取消/导出入口正常，脚本错误为零，静态文件与源码一致。未调用真实模型、未执行业务节点；不对上游网关取消后的计费或推理终止作保证。

截图：`artifacts/dialogue-actions-desktop.png`、`artifacts/dialogue-actions-mobile.png`。

验证命令：

```sh
node --test server/deepseek-run.test.js server/dialogue-actions.test.js server/dialogue-state.test.js server/execution-progress.test.js server/shared-agent-worker.test.js server/subtree-workspace-ui.test.js
macos/IDE/runtime/current/bin/node --test llm-task-tree-kit/server/deepseek-run.test.js llm-task-tree-kit/server/dialogue-actions.test.js llm-task-tree-kit/server/dialogue-state.test.js llm-task-tree-kit/server/execution-progress.test.js llm-task-tree-kit/server/shared-agent-worker.test.js
macos/IDE/runtime/current/bin/node --test --test-name-pattern='node dialogue stops' server/subtree-workspace-ui.test.js
node scripts/build-plugin-runtime.mjs --check
```
