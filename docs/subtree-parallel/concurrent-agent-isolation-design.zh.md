# 自动并行 IDE 实现说明

## 结论

当前运行时代码是 JavaScript，运行于 Node.js，不是 Go。并发由 Promise 调度、多个 Codex 进程和多个 Git worktree 实现；这是 I/O 和多进程并发，不依赖 Go goroutine。

应用层不再设置 4 个 Worker 的上限。某一时刻所有依赖已满足的任务都会启动。实际并发仍受 CPU、内存、文件描述符、Git 和 Codex 服务容量限制，所以“没有代码上限”不等于物理上无限。

## 端到端数据流

    完整任务树 + 本轮目标 + 全部历史运行
                      |
                      v
                Planner 对话
            目标覆盖 + 任务 DAG + 完整上下文
                      |
                      v
          依赖无环检查并立即自动执行
                      |
           +----------+----------+
           v          v          v
       Worker A    Worker B    Worker N
       worktree    worktree    worktree
           \          |          /
            \---- integration ---/
                 Git 冲突才协商
                      |
                      v
           与最新主工作区在临时区合并
                      |
                      v
                  自动应用

## 关键模块

server/codex-coordinator.js 负责计划、历史复用、DAG 调度、Worker 会话、同文件冲突协商和自动应用状态机。

server/parallel-worktree.js 负责冻结含 staged、unstaged、untracked 和删除文件的当前快照，创建 Worker/integration worktree，把每个 Worker 的完整树差异变成提交，并在隔离区合并。

server.js 只公开当前契约：创建自动运行、读取进度、直接新增分支、打开 Worker 对话。旧的 approve、audit、accept、reject 和 supervisor 路由已删除。

public/app.js 和 public/index.html 只呈现规划、执行、完成和 Worker 当前进度。

## Planner 输出

Planner 一次返回 summary、coverage 和 jobs。coverage 把每个显式目标或完成条件映射到 taskId；jobs 包含 Worker ID、节点、完整任务说明、依赖说明、完成含义、可选文件提示和依赖列表。

Planner 不只是返回任务字符串，因为调度器必须知道哪些任务可以同时启动，依赖完成后应解锁谁，并且 Worker 需要完整上下文才能复用旧会话。writeSet 已降级为提示，不参与授权或排他判断。

如果 Planner 返回无效 JSON、重复 ID、未知依赖或环，系统把错误和 Planner 的完整原始输出放回同一 Planner 对话重试。若同一个错误和同一输出重复出现，运行失败，避免无限空转。coverage 只作为模型说明，不另设审核步骤。

## 调度算法

对任务集合 V 和依赖边 E，任务 v 可运行的条件是：

    ready(v) = queued(v) AND 对每个 u in deps(v)，completed(u)

queued(v) 表示任务仍在队列，deps(v) 是它声明的前置任务。所有满足 ready(v) 的任务在同一轮全部启动，不再取前 4 个。

Worker 结束后，调度器重新计算就绪前沿。新增任务会主动唤醒调度器，不需要等现有 Worker 结束。若依赖任务失败，后继任务标记为依赖失败；若队列非空但没有任何可运行或活动任务，则说明结构无法继续。

依赖图使用深度优先搜索检查环。访问任务时暂时放入 visiting；若沿依赖边再次遇到 visiting 中的任务，就存在回边，也就是环。此检查保留是因为有环时没有合法的首个任务。

## 同文件合并

每个 Worker 从自己的 sourceCommit 开始。Worker 可以自己提交，也可以只改工作区；协调器最后读取完整 Git tree，生成一个以 sourceCommit 为父的提交，因此不会漏掉 Worker 自己做过的提交。

integration 按完成顺序 cherry-pick。Git 可自动三方合并时直接继续；有未合并文件时记录真实冲突文件，根据 changedFiles 找到相关 Worker，把各分支的完整上下文组成 participant packet，再 fork 当前 Worker 对话到 integration worktree 用一个 resolver 回合解决并暂存。宿主最后执行 cherry-pick --continue。这样避免 N 个 peer consultation 串行叠加延迟。

任务树和普通项目文件走同一套机制，没有特殊禁止规则。

## 自动应用与主工作区保护

运行开始时的快照包含用户未提交改动。自动应用不会直接在主目录做 git apply --3way，因为失败可能把主索引留下冲突 stage。

系统重新冻结应用时刻的主工作区到一个临时提交，把 integration 结果 cherry-pick 到临时 worktree。若用户在运行期间修改了同一位置，冲突也只出现在临时区并进入相同的 Worker 协商。成功后生成相对于“应用时刻主工作区”的补丁，用普通 git apply 写回。这样主目录要么收到完整结果，要么保持原状。

## 上下文复用

.task-tree-runs 保存每次运行的目标、Worker、完整输出、失败和 thread ID。Planner 系统对话单独索引并持续复用。

新任务通过节点、上下文键和文件提示匹配历史 Worker。一个历史 thread 同时匹配多个新任务时，第一个可以续写，其他任务从该 thread fork，避免并发写同一 Codex 对话。Worker prompt 不截断任务树、历史结果、分支上下文或失败输出。

## 已知边界

- Prompt 可以要求完整覆盖和合适粒度，但不能证明任务数量是全局数学最优。
- 应用层无 Worker 上限，但操作系统和 Codex 服务一定存在资源上限。
- 项目外写入不经过 Git，无法提供项目内文件相同的隔离、合并和回滚保证。
- 取消产品测试和审核会提高速度，也会失去自动发现“Git 能合并但语义不兼容”的门禁；这是当前明确选择，不应描述为已经验证语义正确。
- 两个独立自动并行运行同时向同一仓库应用时，当前没有跨进程仓库锁，应避免同时启动两轮。

## 开发回归证据

仓库测试覆盖：单 Worker、同写集、任务树路径和项目外路径可规划；重复 ID、未知依赖和环被拒绝；8 个无依赖 Worker 同时进入模型调用；8 个参与者的同文件冲突只开启一个 resolver packet；50,000 字符任务树和完整失败输出不截断；Planner 无效输出回灌；真实同文件与任务树冲突合并；运行期间主工作区同位置变更在临时区解决；浏览器只显示三个阶段并直接追加分支。
