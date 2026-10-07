# 并行调度与冲突处理的定向研究

日期：2026-09-23。本文记录本轮为高并发 Worker 和 Git 冲突耗时问题查到的证据，以及哪些结论已经迁移到本项目。6–8 只是历史验证规模，不是产品目标。论文引用数是 Semantic Scholar 在本日返回的值，GitHub star 是 GitHub API 在本日返回的值；它们会随时间变化。

## 论文证据

### ICSE 2012：Improving early detection of software merge conflicts

来源：[DOI 10.1109/ICSE.2012.6227180](https://doi.org/10.1109/ICSE.2012.6227180)、[开放论文 PDF](http://www.cs.washington.edu/education/courses/cse590n/12sp/mario.pdf)、[Semantic Scholar](https://www.semanticscholar.org/paper/cb13ddf2e0c45da2b34c52a59b1083d22b20e848)。论文发表于 ICSE；ICSE 在中国计算机学会推荐目录中属于软件工程 A 类会议。本日 Semantic Scholar 返回 126 次引用。

这项工作研究如何更早发现协作分支之间的合并冲突。对本项目最有用的不是照搬它的预测模型，而是它把“冲突发生后才处理”前移为“在并行工作期间收集冲突信号”。因此我们继续保留每个 Worker 的 changedFiles、任务说明、分支上下文和会话链接，并在冲突发生时把这些已有信息一次性送给 resolver；不再为每个 peer 逐一开启串行模型回合。

### ASE 2022：Detecting Build Conflicts in Software Merge for Java Programs via Static Analysis

来源：[DOI 10.1145/3551349.3556950](https://doi.org/10.1145/3551349.3556950)、[Semantic Scholar](https://www.semanticscholar.org/paper/2878a634d36c022f4ec4034fdc84d79d42e6a424)。论文发表于 ASE；ASE 在中国计算机学会推荐目录中属于软件工程 A 类会议。本日 Semantic Scholar 返回 10 次引用。

摘要给出的 Bucond 方法把 base、left、right 三个版本建成图，比较两边对相关实体的编辑，并用 57 种模式定位构建冲突；论文报告实验覆盖 97% 的构建冲突，精度 100%，召回率 88%–100%。对本项目的可迁移原则是：文本冲突和语义/构建冲突是两种不同层次，Git 能处理前者时仍要把两边意图和实际文件交给一个语义 resolver。我们没有把 Bucond 的 Java 静态分析误装成通用验证，也没有声称当前系统能保证语义正确。

## 高 star 实现的可核对做法

- [git/git](https://github.com/git/git)：本日 63,274 stars。官方 [git-merge-tree 文档](https://git-scm.com/docs/git-merge-tree)说明可以在不直接改工作树的情况下计算合并结果和冲突；这支持把机械合并留给 Git，把需要判断的冲突集中到一个明确的 resolver 阶段。
- [bazelbuild/bazel](https://github.com/bazelbuild/bazel)：本日 25,876 stars。[官方首页](https://bazel.build/)明确写出“只构建必要部分”、缓存、依赖分析和并行执行。我们迁移的是“依赖满足就启动、不要按固定小批次串行等待”；本项目尚未实现 Bazel 级别的内容寻址缓存，所以不宣称有同等缓存收益。
- [nrwl/nx](https://github.com/nrwl/nx)：本日 29,365 stars。[README](https://github.com/nrwl/nx#readme)写明 affected-only、任务图和缓存；其核心启发是先缩小受影响图，再在图的可运行前沿并行。本项目当前使用 Planner 给出的 dependsOn 和全部 ready 任务，尚未实现源码图级 affected 分析。
- [vercel/turborepo](https://github.com/vercel/turborepo)：本日 31,127 stars。[任务配置文档](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks)明确说明能并行的任务会并行，`dependsOn` 只阻塞真正需要前置输出的任务。我们的调度循环采用相同原则，并且不设应用层 Worker 数量上限；6 或 8 只是历史验证样本，Planner 会按实际独立目标扩展到 12、20 或更多。

这些项目都没有把“越多越好”实现成固定的无限线程数：并行度由可运行图、机器资源和任务本身决定。这里的“无上限”是没有 4 个 Worker 的硬编码上限，不是声称 CPU、内存、Codex 配额或网络容量无限。

## 本轮迁移和结果

1. Planner prompt 改成最大化有用 runnable frontier：独立领域应拆开，不能为了减少数量把 API、UI、数据模型、迁移、文档、配置、适配器和脚本塞进一个 Worker；也不能为了凑数量制造空任务。6–8 只作为示例，12、20 个独立结果也必须全部返回。
2. 自动计划仍保留至少两个非空 Worker、至少两个无前置依赖的最低并行门禁，但这不是目标数量。单 Worker 或单前沿串行计划会自动回灌失败原因重规划。调度器对所有依赖满足的任务启动 `runWorker`，没有 `MAX_WORKERS`；本轮夹具验证 8、12、20 个同时活跃。
3. 旧冲突路径是“每个 peer 一个串行 consultation，再一个 resolver”，参与者为 N 时最多 N+1 个模型回合，且 consultation 时间线性叠加。现在同一冲突只开启一个 source resolver，把每个参与者的完整任务、branchContext、output、changedFiles、writeSet、依赖和会话链接组成无截断 participant packet；正常路径从 N+1 回合降为 1 回合。
4. 冲突记录写入 `consultationMode=single-resolver`、`consultationCount=0`、解析耗时和参与者列表，便于从真实运行元数据验证瓶颈，而不是只看 Git 命令耗时。

## 边界和未知

任务数量和粒度没有已知的全局最优多项式求解；Planner 的拆分仍是模型决策。一次 resolver 减少了模型往返，但不等于语义合并必然正确；复杂冲突仍可能需要人工检查。我们没有同条件 Claude 基线，因此不声称公开排行榜领先，也没有把论文指标外推为本项目的准确率。
