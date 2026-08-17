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
- 公开构建含 242 个文件、9.88 MiB；本机路径和疑似凭据扫描均为 0。GitHub 页面已显示新标题、主视觉和 MP4 链接；jsDelivr 返回 `video/mp4`，Edge 实测播放器 `readyState=4`、时长 22.16 秒、分辨率 1440×900。

## 单主张视频重绘

- 复盘对话 `019fd550-6533-7103-9891-d1df8fbb693f`，将可复用方法整理到 `docs/readme-video-production.md`：单一主张、真实界面取景、逐帧后期、状态门控、关键帧与解码验收。
- 演示主线从“依次展示四项功能”改为“让 Agent 的下一步始终扣住根本目标”；20 秒只展示根本目标、当前进度、当前问题、主干和节点的问题/思路/结果/下一步。
- `scripts/capture-readme-media.mjs` 现在从本机任务图抓取真实总览、关系图和 N11 节点卡，再按固定时间轴渲染 MP4、WebM 与封面。
- 最终 MP4 为 20.01 秒、1600×900、30fps、H.264/AAC；FFmpeg 完整解码通过，Edge 通过 HTTP 加载后 `readyState=4`，音量均值 `-22.6 dB`、峰值 `-9.0 dB`。
- 真实用户是否因此更愿意观看和采用仍未验证，本轮只证明视频主线、可读性和播放链达到可测试状态。

## 真实界面与状态动画同步

- 左侧标签和右侧真实截图不再使用两套时间判断：总览 3 项、主干 3 段和节点 4 字段共享连续状态与语义色。
- 抓图阶段从真实 DOM 读取归一化区域；总览按字段、关系图按 `ROOT→N3→N12`、焦点卡按问题/思路/结果/下一步同步提亮、描边和轻微聚焦。
- 焦点卡取景临时解除滚动容器裁剪，修复“结果如何”高亮到空白区；该样式只作用于素材抓取，不修改产品前端。
- 已核对 10 个稳定状态、3 个切换中间帧和最终封面；中间帧标签对比度已调整，画面无文字叠压或空白高亮。
- 最终 MP4/WebM 完整解码通过；Edge 经 HTTP 播放为 `readyState=4`、1600×900、20 秒，音量均值 `-22.6 dB`、峰值 `-9.0 dB`。

## 01 与 03 叙事去重

- 旧版 01 和 03 都是左侧列表切换、右侧卡片字段高亮，虽然讲的层级不同，观看体验仍是重复说明；根因是按界面字段分段，而不是按用户任务分工。
- 新版 01 只回答“项目现在是什么局面”，固定根本目标、当前进度和当前问题；02 回答“方向在哪里”，展示 `ROOT→N3→N12`；03 回答“下一步怎样发生”，展示 `NextIdea→Codex→CurrentResult`。
- 03 使用真实“保存并让 Codex 继续”按钮，按“写清下一步、交给 Codex、结果回到树”推进；结果字段只在执行动作之后出现，封面也改用该动作场景。
- 已核对 13.2、14.1、15.0、15.8、16.8 秒五个关键帧：下一步、按钮脉冲和结果回写的先后关系清楚，未发现文字叠压。
- MP4/WebM 完整解码通过；Edge 经 HTTP 播放为 `readyState=4`、1600×900、20 秒，并在约 15.1 秒保持播放。

## GitHub 发布与线上验收

- 新版 README、生成脚本、制作说明、MP4、WebM、封面和四张横屏场景图已推送到公开仓库 `main`，提交为 `9f6e7b1dce8a024a2cebf56aed684fcb4fb7eaaf`。
- GitHub API 返回 MP4 blob `704bfcbbd3d9ad3abe795ee8de2e1057158d49fd`、2,113,213 bytes，与发布工作区的 Git blob 完全一致。
- jsDelivr 下载文件的 SHA-256 为 `3231F4E491379F5CAD43949B67B59D049A61BF0D80E3BD1FC28F5A0126FAB99B`，与本地新版 MP4 相同。
- Edge 直接加载 README 使用的线上地址，实测 `readyState=4`、1600×900、20 秒，约 1.79 秒时仍在播放且无媒体错误。
- 发布从远端 `main` 建立独立 worktree，只提交 10 个视频相关文件；本地并行运行时源码和焦点透镜截图未进入该提交。
