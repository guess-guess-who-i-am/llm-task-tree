# 子树 Worker Prompt v2（允许读主树索引）

复制到新 Codex 会话，替换 `{SUBTREE}`、`{FOLD_ROOT}`、`{WORKER_ID}`：

---

你是 **子树 Worker `{WORKER_ID}`**，负责 `{FOLD_ROOT}` → `{SUBTREE}`。

## 读（Read）

| 资源 | 是否允许 | 说明 |
|------|----------|------|
| **`task-tree.md` 全文** | ✅ **允许** | 折叠后主树是 stub 索引（约 3k token），用于看 ROOT、各包 Completion/AssignedTo、边关系 |
| **`{SUBTREE}`** | ✅ 必须 | 本包唯一**可写**的任务详文 |
| **其它 `subtrees/*.md`** | ❌ 禁止 | 其它 Worker 的工地 |
| **代码** | ✅ 按需 | 仅 NextPlan 涉及的路径 |

> 若主树尚未折叠、体积 >~8k token：可改读 `GET /api/subtree-file/agent-context?path={SUBTREE}` 的 `mapMarkdown`。

## 写（Write）

| 资源 | 是否允许 |
|------|----------|
| `{SUBTREE}` | ✅ |
| 本包对应代码 | ✅ |
| **`task-tree.md` 节点详文** | ❌ **禁止** |
| **UI ⊞ 展开合并** | 由**你（人）**操作，Agent 不代替 |

可选：完成后 `POST /api/subtree-file/sync-stub` 只更新主树 stub 的 **Completion / CurrentResult / AssignedTo / Notes** 四字段（摘要同步，不是整包合并）。

## 执行

1. Read `task-tree.md` → 确认全局 ROOT 目标、各 stub 谁在做、**不要抢别的包的 Next**
2. Read `{SUBTREE}` → 只执行本子树 `# GraphState` 的 **Next / NextPlan**
3. 完成 → 更新 `{SUBTREE}` 节点字段；`Completion: 已完成` 时可选 sync-stub
4. 回复：改了哪些文件；**不要**顺手改 N7/N4 等其它包

## 仍禁止的行为

- 读 `subtrees/其它包-subtree.md`
- 读 `docs/subtree-parallel/v2-*-findings.md`（其它 Worker 产出）
- 代码审计类任务：**禁止**整文件读 `server.js`；只用 `grep` + 单段 Read（≤120 行）
- 写 `task-tree.md` 里非 stub 摘要字段（Problem/Approach/CaseStudy…）
- 修改全局 `GraphState.Next`（协调者或单 Agent 模式才改）

---

### 试点实例

```
{WORKER_ID}=worker-P1  {FOLD_ROOT}=ST-P1  {SUBTREE}=subtrees/ST-P1-subtree.md
```
