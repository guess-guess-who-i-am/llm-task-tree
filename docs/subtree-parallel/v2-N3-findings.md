# v2 Worker N3 Findings — worker-v2 读树策略验证

> **Start:** 2026-06-27 · worker-N3 · FOLD_ROOT=N3 · SUBTREE=subtrees/N3-subtree.md

## worker-v2 读树策略（3 要点）

1. **主树作 stub 索引，子树作唯一详文**：Worker 可读 `task-tree.md` 全文以把握 ROOT 目标、各折叠包 `Completion`/`AssignedTo`、边关系；具体 Problem/Approach/CaseStudy 只在 `{SUBTREE}` 维护，避免多 Agent 争写同一节点详文。

2. **读写边界硬隔离**：只写 `{SUBTREE}` 与本包代码；禁止写主树详文（仅可选 `POST sync-stub` 同步 Completion/CurrentResult/AssignedTo/Notes 四字段）；禁止读其它 `subtrees/*.md`；禁止改全局 `GraphState.Next`。

3. **只执行本子树 NextPlan，不抢邻包**：先读主树确认谁在做哪包，再读 `{SUBTREE}` 的 `# GraphState` 执行 Next/NextPlan；主树折叠后约 3k token，足够协调而不需加载全量节点正文。

## 本轮执行

- 已读 `task-tree.md` 全文 + `subtrees/N3-subtree.md` + `prompts/worker-v2.md`
- 未读 N6/N7 subtree；未写 `task-tree.md` 详文
- 更新 N3 `CurrentResult` 于子树文件

## 指标

- files_read: task-tree.md, subtrees/N3-subtree.md, docs/subtree-parallel/prompts/worker-v2.md
- input_chars_est: 17843
- wrote_task_tree_detail: no
- read_other_subtree: no
- cross_work_temptation_1_10: 2
