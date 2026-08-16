# N12：公开仓库、README 视觉与插件分发

## 本轮交付

- 仓库已公开并改名为 `llm-task-tree`，正式安装入口均已切换到新地址。
- README Hero 按用户反馈改为三张完整 16:10 横屏截图并排，保留界面的真实空间关系。
- GitHub 已配置英文简介、12 个 topics、Issues、Discussions，并发布首个 `v0.8.0` Release。
- Discussions 已发布首个中英双语公告，邀请早期用户反馈安装、总览可读性和中断恢复体验。
- Release 提供脱敏安装包 `llm-task-tree-v0.8.0.zip`；README 与资产已通过匿名访问验证。

## 验证

- Hero：1920×720，380937 bytes。
- 已发布提交对应的插件 manifest 与真实 MCP 包启动测试通过；当前工作区另有两处并发运行时源码改动尚未同步到插件包，本轮未将其混入公开提交。
- 公开包：234 个文件、4.22 MiB；本机路径与疑似凭据均为 0。
- Release 安装包：2909112 bytes，已公开且非草稿；GitHub 的 1 次下载来自本轮匿名验收，尚无可归因于真实用户的传播效果数据。
- API 推送器改为上传 Git HEAD 的原始 blob，避免 Windows 工作区换行转换导致远端持续假漂移。
- `git diff --check` 通过。

## 当前工作区边界

- `scripts/mcp-server.mjs` 与 `server/codex-run.js` 是并发用户改动，插件包一致性复验准确报告这 2 个文件漂移。
- 本轮只发布仓库地址、README、插件清单、任务树和交付证据；上述两处源码保持未提交。

## 证据

- `README.md`
- `artifacts/readme-hero.png`
- `scripts/build-readme-hero.ps1`
- `scripts/build-public-repo.mjs`
- `scripts/push-public-repo.mjs`
- `dist/task-tree-public/README.md`
- https://github.com/guess-guess-who-i-am/llm-task-tree
- https://github.com/guess-guess-who-i-am/llm-task-tree/releases/tag/v0.8.0
- https://github.com/guess-guess-who-i-am/llm-task-tree/discussions/1

## Apple 参考风格重构与真实演示

- 从用户提供的 Apple 官方产品页截图提取“单一主张、真实画面主导、一段一能力、克制色彩和稳定横屏比例”五项落地原则，记录于 `docs/readme-design/apple-reference-style.md`。
- README 首屏已从徽章墙和三联缩略卡改为一句核心承诺与一张完整横屏任务图；正文按项目总览、宏观主干、焦点节点和执行流程逐层展开。
- 真实操作演示为 22.16 秒、1440×900、25 fps；录制源保存为 WebM，点击封面打开 H.264 MP4，避免 GitHub 将 WebM 误标为音频下载。封面和四张功能图均来自本机任务图页面，没有伪造产品界面。
- 公开构建含 242 个文件、9.88 MiB；本机路径和疑似凭据扫描均为 0。线上 GitHub 渲染与 MP4 播放仍需发布后复核。
