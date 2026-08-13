# v2 并行试跑结果（N3 / N6 / N7）

> 2026-06-27 · 3 Worker 同时跑 · worker-v2（**允许读整棵主树**）

## 1. 折叠前后体积

| 指标 | 折叠前 | 折叠 N3/N6/N7 后 |
|------|--------|------------------|
| 主树 `task-tree.md` | ~22 609 字符 (~9 044 token) | **~14 044 字符 (~5 618 token)** |
| 折叠 stub 数 | 2 (ST-P1/P2) | **5** (+N3/N6/N7) |
| 子树详文位置 | 主树内 | `subtrees/N{3,6,7}-subtree.md` |

子树文件：N3 ~990 token，N6 ~1 020 token，N7 ~2 209 token（详文从主树移出）。

---

## 2. 并行 vs 串行（token / 效率）

### 实测：3 Worker 并行（本轮）

| Worker | 任务 | input_chars_est | 读其它 subtree | 写主树详文 | 越界冲动 |
|--------|------|-----------------|----------------|------------|----------|
| N3 | 总结 worker-v2 策略 | **17 843** | 否 | 否 | 2/10 |
| N6 | model-agents 路由 | **~42 000** | 否 | 否 | 2/10 |
| N7 | knowledge/web-search 路由 | **~38 000** | 否* | 否 | 3/10 |

\* N7 读了 `v2-N6-findings.md` 作格式参考（不是 subtree，但跨 Worker 产物）

**并行总 input（三份相加）**：~**97 800 字符 ≈ 39 000 token**  
**墙钟**：3 路同时完成（约单 Worker 最慢的一路，~5–8 min 量级）

### 估算：1 Agent 串行做同样 3 件事

| 读取物 | 字符（估） |
|--------|------------|
| task-tree.md ×1 | 14 044 |
| 3 个子树 ×1 | 9 880 |
| server.js 局部 ×1（grep 两主题） | ~12 000 |
| worker-v2.md ×1 | ~1 500 |
| **合计** | **~37 500 ≈ 15 000 token** |

| 维度 | 3 并行 | 1 串行（估） |
|------|--------|--------------|
| **墙钟** | **~1×**（最快） | **~3×** |
| **总 input token** | **~39k**（主树读 3 遍） | **~15k** |
| **总 output** | 3 份 findings ~12k 字符 | 类似 |

**结论**：

- **提效在墙钟**：3 包互不依赖时，并行约 **3 倍快**。
- **token 代价**：每个 Worker 各读一遍主树（~5.6k token ×3 ≈ **17k 冗余**）。相对折叠前（9k×3），折叠后主树已小，**冗余可接受**。
- **进一步省 token**：协调者读主树，Worker 只读 `agent-context` 的 map（~411 token）——准确度实验 B 组 7/10，需权衡。

---

## 3. 效果（交付质量）

| Worker | 产出 | 质量 |
|--------|------|------|
| N3 | `v2-N3-findings.md` | ✅ 3 条 worker-v2 要点 + 指标 |
| N6 | `v2-N6-findings.md` | ✅ 3 条 `/api/model-agents` 路由 + 行为说明 |
| N7 | `v2-N7-findings.md` | ✅ 9 条 knowledge/web-search 路由 + 要点 |
| 子树 | 3× `subtrees/Nx-subtree.md` | ✅ CurrentResult 已更新，Completion 已完成 |
| 主树 | `task-tree.md` | ✅ **无详文被 Worker 改写**（符合「只 UI 合并」） |

**边界遵守**：无读其它 `subtrees/*.md`；无写主树 Problem/Approach；越界冲动自报 2–3/10（主树 stub 能看到 N6/N7 在并行，但未去改）。

---

## 4. 发现的问题

1. **N6/N7 input 偏高（~40k）**：grep 后仍读了 server.js 大段；prompt 应强调「只读 grep 命中行 ±30 行」。
2. **N7 读了 N6 的 findings**：应禁止读其它 Worker 产出，或只允许协调者汇总。
3. **主树仍可再折叠**：N5/N4/N9/N10 仍展开；全折叠后主树可降到 ~3k token（见 `subtree-size-experiment.mjs`）。

---

## 5. 推荐你用的步骤（已验证）

1. `node scripts/v2-fold-and-run-prep.mjs` 或 UI ⊟ 折叠大包  
2. 开 3 个 Codex，各贴 `prompts/worker-v2.md`  
3. 并行跑；Worker **可读** `task-tree.md`  
4. 只写 `subtrees/Nx-subtree.md` + findings  
5. 你点 **⊞ 展开** 合并回主树  

## 6. Prompt 微调（v2.1）

在 worker-v2 加：

- server 类任务：**禁止**读整个 `server.js`；只用 `grep` + 单段 `Read`（≤120 行）
- **禁止**读 `docs/subtree-parallel/v2-*-findings.md`（其它 Worker 产出）
- 完成后可选 `sync-stub`；**不要**手改主树详文

---

## 7. 文件索引

- 折叠脚本：`scripts/v2-fold-and-run-prep.mjs`
- 体积脚本：`scripts/subtree-size-experiment.mjs`
- 产出：`v2-N3-findings.md`、`v2-N6-findings.md`、`v2-N7-findings.md`
