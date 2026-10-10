# IDE 页面加载失败：诊断与修复

## 结论与边界

用户截图是 HTML 外壳显示、所有样式缺失、应用未初始化，不是树数据已经丢失，也不能仅凭截图归因于 Safari。截图没有对应的网络日志，无法还原当时究竟哪一个资源请求先失败。本轮找到了可实测、可复现的三条故障路径并分别修复；不承诺任何浏览器、磁盘故障或系统休眠下都永不失败。

## 实测的根因链

1. 检查时 Mac 运行时间约 6 分钟；工程端口 5518 的 CSS 和应用脚本请求都被拒绝，原 PID 已不存在。旧启动器仅创建脱离终端的进程，没有登录恢复或崩溃恢复机制。重启后，浏览器旧标签仍在，但后台已经不在；缓存的 HTML 可以呈现外壳，无法保证余下资源可用。重新通过桌面入口启动后，本地 CSS/JS 均返回 200。
2. 原页面同步加载 jsDelivr 的 KaTeX 脚本，然后才加载布局和应用脚本。按照 HTML 脚本执行规则，前面的同步外部脚本会挡住后面的脚本；这可解释应用不启动，**不能单独解释本地 CSS 全部丢失**。因此修复 CDN 依赖与后台生命周期，而没有把截图全部归给 CDN。
3. 浏览器拦截本地 CSS、布局脚本、应用脚本的首次请求，旧实现超过 7 秒仍无节点，也没有清晰的资源恢复入口。这条资源失败路径能产生截图所示的无样式、无树状态。

依据：MDN 的 script 说明，以及 Stack Overflow 48173424 的接受答案（48173705）；macOS launchd.plist 的 RunAtLoad、KeepAlive/SuccessfulExit 规则。

## 改动的边界

- `scripts/project-service-macos.mjs`：由项目级 LaunchAgent 运行服务，登录启动、异常退出自动恢复。正常退出不重启，因此页面关闭按钮保持有效，桌面入口可以再次启动。保存到用户 LaunchAgents 的配置只含路径与常规 PATH，不复制继承的 API key。代理仍通过原来的 `localNetworkEnvironment` 获取，共享根 `.env` 路径沿用。
- `macos/IDE/stop.command`：停止当前工程服务，而不是旧 workspace；本地请求绕开代理。
- `public/page-boot.js`：启动诊断直接嵌进 HTML，核心资源加载失败时自动重试；持续失败明确显示资源/异常和重新连接入口。脚本先完整下载，再执行，避免超时后的旧脚本与重试脚本重复初始化。资源就绪前隐藏未完成的外壳。
- `public/index.html`、`public/vendor/katex`：启动不再访问 CDN，数学脚本、样式、字体及许可证随代码分发。KaTeX 固定为 0.18.2，新增依赖没有本次 npm audit 所列的 KaTeX 漏洞；仓库原有文档解析依赖的 4 项告警未在本轮强制升级。
- `public/app.js`：启动阶段树接口短暂失败可重试；失败有诊断和重连。对话恢复不阻塞树显示，截图等待布局完成。
- `server.js`：入口内嵌启动诊断；本地资源要求缓存重新验证，避免旧页面和新脚本无校验混用；补数学字体 MIME 类型。
- `server/widget-bundle.js`：聊天内嵌版本也包含数学脚本、样式和字体，不把故障转移到 CDN。

没有改变任务拆分、模型选择、工具轮数、对话内容或执行流程。源码、共享 Kit 和两份生成的插件运行时已同步。

## 验证

命令使用私有 Node：`macos/IDE/runtime/current/bin/node`。

1. `scripts/test-page-loading-ui.mjs`：Chrome、WebKit 各 8 项加载回归通过。覆盖断外网、首次资源失败、持续 CSS 失败后的用户重试、慢脚本超时且不重复执行、树接口失败恢复、脚本异常诊断、缓存策略、内嵌页面零外部网络依赖；数学公式和本地字体也验证。最后版本的小树离线加载约 257 毫秒（Chrome）、294 毫秒（WebKit）。WebKit 的 blob 模块读取是本地内存操作，测试允许它，而不把它算成外部请求。
2. `scripts/test-project-service-macos.mjs`：真实 macOS LaunchAgent 的隔离项目测试通过。终止测试服务后两次测量约 1227/2284 毫秒恢复；主动关闭后不重启；桌面入口重新启动；登录配置及无密钥落盘检查通过。没有为测试重启用户的电脑，所以登录恢复依据是实际安装的 RunAtLoad 配置，不是一次真实整机重启实验。
3. `scripts/test-ide-launchers.mjs`：两个桌面链式快捷方式均打开真实源码工程。
4. `server/subtree-workspace-ui.test.js`：22 项实际浏览器功能回归全部通过，含停止/编辑/导出对话、资料拖放、主子树切换、鱼眼与子树保存。
5. `server/network-environment.test.js`：2 项通过，确认本地访问绕开代理、显式外部代理配置不被覆盖。
6. `scripts/test-deployed-page-loading.mjs`：实际 5518 部署的主树和 N3 子树，在 Chrome/WebKit 都显示成功、无脚本异常和失败请求。Chrome 主树 259 毫秒、子树 521 毫秒；WebKit 主树 461 毫秒、子树 626 毫秒。原主树、子树及对话状态文件逐字节不变。截图在 `artifacts/page-loading-{chromium,webkit}-{main,subtree}.png`。
7. 数学资源构建检查、源码/插件运行时一致性检查、树精炼检查通过。

原有 `scripts/test-mcp-server.mjs` 另有 4 项失败，未混入上述通过数字：工具列表没跟上已有 read/summary 工具、错误文本仍按旧 JSON 包装断言、旧 Codex 链接断言未改为现有 DeepSeek 链接，以及截图进程清理报 ENOTEMPTY。该脚本的内嵌资源打包相关检查通过。这些失败不是“全套测试通过”，截图工具清理也不是用户截图里的页面 CSS 故障；本轮没有扩展为旧测试/截图后端的重写。

## 使用与剩余风险

实际工程地址：`http://127.0.0.1:5518/`，桌面“打开IDE工程.command”或“打开并行IDE.command”均可打开。已安装的工程 LaunchAgent 正在运行。

浏览器如果还停在修复前的缓存页面，应重新打开桌面入口或刷新一次。未来短暂资源故障会自动恢复，持续故障会显示原因；若项目被移动、磁盘不可读、用户禁用登录项、JavaScript 被禁用，仍需按提示处理。WebKit 自动化验证覆盖 Safari 同类引擎，但不是对用户 Safari 扩展、个人代理与缓存的完整复刻。
