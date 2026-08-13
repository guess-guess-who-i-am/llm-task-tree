---
name: task-tree-subtree-run
description: >-
  Parallel subtree Workers for Codex. Workers MAY read full task-tree.md when
  main tree is mostly folded stubs; must NOT read other subtrees or write main
  tree detail. Merge via UI unfold only.
---

# Task Tree Subtree Run (v2)

## 读树策略（修订）

**可以读 `task-tree.md` 全文**，当主树以折叠 stub 为主（通常 ~3k token）。用于：

- ROOT 总目标
- 各包 stub 的 Completion / AssignedTo
- 边关系（避免抢别包活）

**始终禁止：**

- Read 其它 `subtrees/*.md`
- Write `task-tree.md` 节点详文（Problem/Approach/CaseStudy…）
- 改全局 GraphState（Worker 只用子树内 GraphState）

**合并：** 人操作 UI **⊞ 展开**；Agent 不整包写回主树。

可选摘要：`POST /api/subtree-file/sync-stub`（4 字段）。

## API

```bash
curl "http://127.0.0.1:<port>/api/subtree-file/agent-context?path=subtrees/N6-subtree.md"
```

主树很大且未折叠时，用 `mapMarkdown` 代替读整树。

## Prompt 模板

- Worker v2：`docs/subtree-parallel/prompts/worker-v2.md`
- 步骤：`docs/subtree-parallel/WORKFLOW.md`
- 实验：`docs/subtree-parallel/EXPERIMENT.md`

## 与 chain-run

- 并行子树：读主树索引 + 写子树
- 链式 loop：仍用 `chain-step`，不读整树
