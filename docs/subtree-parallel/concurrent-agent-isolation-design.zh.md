# 多 Agent 并发研发隔离方案

## 结论

用户提出的主流程是正确的：每个 Agent 使用独立 worktree，在隔离环境中测试，变更进入集成队列，完整回归后再串行发布。但 `Git worktree + 集成 Agent` 只解决代码工作区隔离，不能单独保证 Agent 互不干扰。

可靠方案需要同时隔离六类状态：

1. 代码文件与 Git 引用。
2. 任务图节点和其他共享控制状态。
3. 端口、进程、临时目录、缓存和浏览器配置。
4. 数据库、消息队列、对象存储和容器资源。
5. 集成分支与测试结果。
6. 主工作区和 8898 发布环境。

因此推荐模型是“独立执行舱 + 声明式资源租约 + 串行集成队列 + 串行发布锁”。Git 是其中一层，不是整个并发控制系统。

## 外部依据

- Git 官方说明一个仓库可以挂接多个 working tree，并推荐用 detached HEAD 做不打扰现有开发的实验；worktree 仍共享仓库管理数据。https://git-scm.com/docs/git-worktree.html
- OpenAI Docs 把 worktree 定义为同项目多对话并行的隔离方式，同时明确同一分支不能在多个 worktree 同时检出。https://learn.chatgpt.com/docs/environments/git-worktrees
- OpenAI Docs 建议先把并行 Agent 用于读多写少的任务；写密集并行会增加冲突和协调成本。https://learn.chatgpt.com/docs/agent-configuration/subagents
- GitHub merge queue 会把变更与最新目标分支及队列前序变更组成临时 merge group，重新跑必需检查后才进入目标分支。https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- GitHub Actions 的 concurrency group 用同一键保证同一时刻最多一个发布任务运行，说明发布环境应按资源键串行化。https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- Docker Compose 支持用项目名为容器、网络和卷建立独立命名空间，可作为本地执行舱的实现基础。https://docs.docker.com/compose/how-tos/project-name/

Stack Overflow 检索到的主要是 worktree 与多 clone 的操作问题，没有提供比上述官方资料更完整的 Agent 并发契约，因此不把问答帖作为设计权威。

## 对原方案的修正

### 保留

- 每个 Worker 使用独立 worktree。
- 每个 Worker 独立自测。
- 一个集成工作区按队列接收结果。
- 集成完成后跑完整回归。
- 8898 串行发布。
- 合并失败不修改其他 Worker、主工作区或线上实例。

### 修正

1. 不应把“同文件冲突交给集成 Agent”作为常规流程。规划阶段先给文件级独占写集；确实必须修改同一文件时，改为串行依赖，或先合入共享契约再让后继 Agent 工作。
2. 集成 Agent 不直接管理锁、Git 状态或发布。确定性协调器负责租约、队列、版本校验和原子应用；LLM 集成 Agent只负责理解目标、修复语义不兼容和补测试。
3. 每个 Worker 不只是独立端口，还要有完整资源命名空间。端口、数据库、Compose project、临时目录、缓存、浏览器用户目录都从运行清单注入。
4. “测试通过”必须绑定准确的源码提交、环境清单和测试命令。旧测试结果不能沿用到新的集成头。
5. 发布锁之前增加乐观并发校验：主工作区版本或目标文件摘要必须仍等于运行开始时的基线；否则拒绝覆盖并重新集成。

## 推荐架构

```text
用户 / Supervisor
       │ 生成任务 DAG、写集、资源需求、验收契约
       ▼
确定性调度器 ── 租约注册表
       │
       ├── Worker A 执行舱：worktree A + env A + DB A
       ├── Worker B 执行舱：worktree B + env B + DB B
       └── Worker C 执行舱：worktree C + env C + DB C
                    │
                    ▼
             串行集成队列
                    │ 每次基于最新 integration HEAD 重放并验证
                    ▼
          集成 Agent + 全量集成测试
                    │
                    ▼
          人类接受 / 目标一致性门禁
                    │
                    ▼
        发布服务获取 project:8898 锁
                    │ 再校验基线，原子应用，冒烟，失败回滚
                    ▼
                   8898
```

### 1. 规划契约

每个任务必须声明：

- `taskId`、关联任务树节点和依赖任务。
- `baseCommit`：Worker 的不可变代码基线。
- `writeSet`：允许改动的项目相对路径。
- `resourceClaims`：端口数量、数据库类型、容器、缓存和外部服务需求。
- `tests`：分支测试。
- `integrationTests`：进入最新集成头后必须重跑的测试。
- `acceptance`：对根目标产生了什么可验证能力，还剩什么缺口。

计划器生成草案，确定性验证器检查路径重叠、循环依赖、保留路径和资源可分配性。模型不能自行解释并绕过验证器。

### 2. 文件冲突策略

采用“预防优先、隔离修复兜底”：

- 不同文件：允许并行。
- 同一文件：默认不允许并行；改为依赖边或重新拆模块。
- 公共契约、数据库 schema、API 类型：先由一个契约任务合入，消费者从新基线继续。
- `package-lock`、迁移序号、生成文件：设置单一 Owner，由依赖/集成阶段统一生成。
- 只有计划时无法发现的 Git 冲突才进入集成 Agent；需求矛盾或无法由测试判定的冲突退回 Supervisor/用户。

文件写集是安全的第一版。符号级写集虽然并行度更高，但跨重命名、格式化和生成代码时很难可靠执行，不适合作为首版边界。

### 3. 运行环境隔离

调度器为每个 Worker 生成不可编辑的环境清单：

| 资源 | 隔离键 | 约束 |
|---|---|---|
| 工作目录 | `runId/taskId` | detached worktree；禁止 Git gc、prune、push、分支重置 |
| 端口 | 租约注册表分配 | Worker 不得固定使用 8898；退出后释放 |
| 数据库 | 独立数据库、schema 或容器 | 禁止连接共享开发库和生产库 |
| Compose | 唯一 project name | 网络、容器、卷按 Worker 命名 |
| 临时目录 | Worker 专属目录 | 不共享系统固定文件名 |
| 缓存 | 默认独立；只读内容寻址缓存可共享 | 禁止多个 Worker 写同一可变缓存 |
| 浏览器 | 独立 user-data-dir | 避免 cookie、锁文件和 session 串扰 |
| 外部 API | 沙箱账号或幂等键 | 禁止产生不可撤销的真实副作用 |

仅设置不同端口还不够：两个进程仍可能写同一个数据库、缓存、截图目录或浏览器配置。

### 4. Worker 交付物

Worker 不把“工作目录”直接交给下游，而是交付不可变 change bundle：

- 基线提交与结果提交。
- 实际变更文件、越界检查结果和补丁摘要。
- 环境清单摘要。
- 分支测试命令、退出码和结果。
- 目标相对结论。

Worker 测试失败、越出写集或资源租约失效时，结果不得进入集成队列。

### 5. 串行集成

每个 change bundle 到达后：

1. 在当前 `integration HEAD` 上重放该提交，而不是假设所有 Worker 仍基于最新代码。
2. Git 无冲突时仍运行受影响测试，捕获语义冲突。
3. Git 有冲突时保留双方目标、diff 和验收契约，交给集成 Agent 在隔离集成 worktree 修复。
4. 修复后重新生成提交并跑双方分支测试、集成测试。
5. 失败只标记当前 bundle，不污染已验收的 Worker 提交和主工作区。

集成 Agent 不能用“保留我的/保留对方的”作为成功条件。成功的唯一依据是双方验收契约仍成立，且集成测试在新的 `integration HEAD` 通过。

### 6. 接受与发布

接受代码与发布服务是两个独立状态转换：

1. 获取仓库接受锁。
2. 比较当前主工作区/目标分支与本轮基线；发现变化就拒绝静默覆盖。
3. 原子应用已审核补丁并记录接受提交。
4. 释放接受锁。
5. 获取 `project:8898` 发布锁。
6. 从已接受提交构建新实例，在临时端口健康检查。
7. 切换 8898，运行真实入口冒烟测试。
8. 失败则恢复上一个可运行版本；成功后释放发布锁。

发布锁必须由服务端持有并带租期、Owner、心跳和崩溃恢复，不能只靠提示词要求 Agent“不要同时发布”。

## 当前项目已经具备的能力

源码核对和本轮回归表明：

- `server/parallel-worktree.js` 已冻结含未提交用户改动的基线快照，并用 detached worktree 隔离 Worker 与 integration。
- `server/codex-coordinator.js` 已验证非重叠 `writeSet`、限制最多 4 个 Worker、按依赖调度，并用 Promise 队列串行 cherry-pick。
- Worker 完成后会检查越界文件、跑分支测试；coordinator 在 integration worktree 修复并跑集成测试。
- 接受前已逐文件比较主工作区当前 blob 与快照 blob，发现用户并发修改会拒绝覆盖。
- 任务树执行 scope、持久分支上下文锁、暂停/继续、动态追加任务和用户向 Supervisor 发消息均已存在。
- 本轮验证：worktree/写集测试通过；execution scope 测试通过；Supervisor/Coordinator 6 项通过；Codex run 15 项通过。

## 当前缺口

| 缺口 | 当前影响 | 建议优先级 |
|---|---|---|
| 没有统一 `resourceClaims` 和资源租约注册表 | Worker 仍可能争抢端口、DB、缓存、容器和浏览器状态 | P0 |
| `writeSet` 主要在结束时检查 | 能防止错误进入 integration，但不能阻止 Worker 对外部共享资源产生副作用 | P0 |
| 多个并行运行之间没有仓库级接受锁 | 两次 `accept` 可能在校验与应用之间竞态 | P0 |
| 没有 8898 发布状态机和全局发布锁 | 当前“接受补丁”不等于安全构建、切换和回滚 | P0 |
| cherry-pick 冲突直接使 Worker 失败 | 专门集成 Agent无法接管可修复的文本冲突 | P1 |
| 集成测试可为空且未自动做影响分析 | 无 Git 冲突的语义不兼容可能漏过 | P1 |
| 崩溃后的租约回收和队列恢复覆盖不足 | 进程中止后可能残留资源或不确定状态 | P1 |

## 研发顺序

### P0：先封住真实互扰面

1. 增加统一资源租约注册表和 Worker 环境清单。
2. 给端口、数据库/Compose、临时目录和浏览器目录做命名空间分配。
3. 增加仓库接受锁、基线二次校验和幂等接受。
4. 增加 8898 发布队列、发布锁、临时端口预检和回滚记录。

### P1：让集成真正理解双方目标

1. 把 Worker 输出固化为 change bundle 和验收契约。
2. 增加冲突分类：路径租约冲突、Git 文本冲突、公共契约冲突、语义测试冲突。
3. 让集成 Agent只在 integration worktree 内处理后两类可修复冲突。
4. 根据变更文件选择最低必需测试，并保留项目规定的完整回归门禁。

### P2：恢复与观测

1. 状态机和租约持久化，服务重启后恢复运行、回收孤儿资源。
2. UI 展示每个 Agent 的基线、写集、资源租约、当前提交和集成位置。
3. 用户消息进入 Supervisor 事件流，支持暂停、取消和重新规划，但不能跳过确定性门禁。

## 完成门禁

这些是零容忍安全不变量，不设任意百分比阈值：

1. 两个并行 Worker 实际修改同一文件时，规划阶段拒绝或建立串行依赖。
2. 两个 Worker 同时启动服务时获得不同端口、数据库和浏览器目录，互相不可见。
3. Worker 请求 8898、共享开发数据库或保留路径时被确定性拒绝。
4. 两次并发接受同一仓库时最多一个成功；另一个必须检测到基线变化并重新集成。
5. 强制制造 Git 冲突时，主工作区和其他 Worker 不变；只有通过双方验收测试的集成修复可继续。
6. 制造“Git 可自动合并但 API 契约不兼容”的语义冲突时，集成测试必须失败。
7. 在 Worker、集成和发布阶段分别强杀进程后，重启能识别状态并回收或续租资源。
8. 发布失败时 8898 仍提供上一已验证版本；成功时真实入口冒烟通过并可追溯到接受提交。
9. 主工作区带 staged、unstaged、untracked 和删除文件时，并行运行不得改写用户索引或静默丢失改动。
10. 所有 Agent 完成后，任务树只同步已核验结论，临时任务、日志和运行资源不污染长期方法树。

当前项目已经证明第 9 项和部分写集、scope、调度能力；其余尤其是资源隔离、并发接受和发布故障注入尚未验证，因此现在不能声称“多 Agent 已完全互不干扰”。
