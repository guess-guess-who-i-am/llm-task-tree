# 节点对话附件与鱼眼小图标

打开节点对话，点击输入框旁「＋ 附件」，或把文件拖入输入区、直接粘贴图片。待「上传并解析中」变成「已就绪」再发送。可以只发送附件。发送失败会保留未发送附件；发送前可点 × 移除。每个节点拥有自己的附件草稿，不会串入其它节点。

图片支持 PNG、JPEG、WebP；原图通过 OpenAI 兼容的 `image_url` 内容块发送给当前 DeepSeek。macOS Vision 同时提取图片文字：只有模型明确拒绝视觉输入时，才降级为已识别文字，并在执行记录中明确提示不能分析图形和颜色。没有可识别文字时直接报告需要视觉模型，不猜测图片内容。

文档支持 PDF、DOCX、TXT、Markdown、CSV、JSON、YAML 及常见 UTF-8 源码；macOS 还支持 DOC、RTF。PDF 用 Mozilla PDF.js，Word 用 Mammoth（禁止外部文件访问），只提取可读正文，不恢复排版、图形或内嵌图片。纯扫描 PDF 无法提取文字时明确拒绝，请上传页面图片。混合 PDF 的扫描页、文档内嵌图像仍需另行上传。

每个原文件最多 20 MiB；超限或解析失败会明确拒绝，不默默截断。文档全文进入每轮节点模型上下文，可能增加 token 和响应时间；模型本身的上下文容量限制仍然存在，大于上游限制的请求会失败，不保证任意大小文档可处理。

原文件及提取文字保存在项目 `.task-tree-attachments/`，目录和文件保留本地访问权限，资料默认纳入 Git，随项目提交/推送同步。对话只保存文字和附件引用，不保存工具记录；服务重启后可重新加载原文件及完整正文。移除未发送附件只取消发送；删除对话不擦除备份及原文件，保留恢复能力。

鱼眼的直接执行入口改为节点标题右上角 24×24 的 ▶ 图标，鼠标提示和无障碍名称仍为「直接执行此节点」。保存、续接当前节点、treeId/nodeId 和不走并行 Planner 的行为均未改变。

## 接口契约

唯一附件解析与存储入口为 `server/chat-attachments.js`。

- `POST /api/chat/attachments?treeId=…&nodeId=…&name=…`：原始文件字节；成功 201 返回 `{attachment:{id,name,kind,size,warning,url}}`。空文件、非法内容为 400，超限为 413，不支持类型为 415，文档解析失败为 422。
- `POST /api/chat/attachments/import?treeId=…&nodeId=…`：JSON `{path}` 导入本次明确指定的本地文件，返回相同附件引用。节点卡片/鱼眼「下一步」框直接接收拖放与粘贴；浏览器只提供本地路径时也会保存原文件，而不是把路径当任务文字。具体边界见 `docs/node-materials.zh.md`。
- 节点 `POST /api/codex/run` 新增 `attachments:[id,…]`；只能引用当前 treeId/nodeId 的附件。传对象代替标识数组为 400；不存在为 404；跨节点/树为 403。重复提交为 409。
- `GET /api/chat/attachments/:id?treeId=…&nodeId=…`：返回原文件；跨范围为 403，非法标识为 400，不存在为 404。图片可预览，文档作为下载；禁止 MIME 嗅探和缓存。
- 持久消息仍以字符串 `content` 表示对话，新增 `attachments` 引用字段；模型请求才转为全文/原图内容块，避免把 Base64 重复存入历史。

## 验证证据

`node --test server/subtree-workspace-ui.test.js server/dialogue-state.test.js server/deepseek-dialogue.test.js server/chat-attachments.test.js server/deepseek-run.test.js`：61 项通过。随后针对拖放、粘贴、提交失败保留草稿、非法附件以及安装预热又执行了 15 项浏览器回归和 4 项附件回归，均通过。

真实模型请求见 `docs/chat-attachments-live.json`：共享配置下文字 4.60 秒，图片 5.28 秒；模型识别蓝色背景和数字 789，颜色未出现在文字提示中。之前一次图片探测返回 502，后续成功不代表网关永不波动。

首次本机 OCR 编译约 48 秒，编译缓存后单次文字识别约 0.45 秒；安装器预热编译缓存。PDF/Word 解析运行在独立、限时、限制内存的进程中；解析超限直接拒绝。安装需 Node 20.19+，推荐私有 Node 22 LTS；共享 kit 通过锁文件安装解析器。

测试均使用临时项目和无敏感测试文件，未执行或改写用户业务树。截图 `artifacts/chat-attachments.png`。本项目没有 `scripts/verify-repository.ps1`，没有声称运行该脚本。

已部署到 5491 独立 IDE 和 5866 业务工作台：实际 Chromium 页面附件入口可见、鱼眼图标 24×24、脚本错误为零，原有两个节点对话分别保留；实际静态资源哈希与源码一致，非法附件由新接口返回 415。共享 kit 用锁文件安装 28 个依赖成功，私有 Node 22 的 4 项附件测试通过。业务主树前后 SHA256 不变，工程主树精炼通过，流程无漂移。差异审查补充了删除会话清空未发送附件草稿，以及非节点执行明确拒绝附件，针对实际上传 UI 的回归通过。
