# Linux 服务器部署指南

任务图核心（`server.js` + Web UI + 执行流程 + 知识库 API）**可在 Linux 上运行**。Windows 专用的右键菜单、`.cmd`、部分 PowerShell loop 脚本需改用本文的 bash 命令。

## 能用什么 / 不能用什么

| 功能 | Linux |
|------|--------|
| 任务树 Web 编辑器（节点/边/版本/知识库） | ✅ 浏览器访问 |
| 执行流程图（Scratch 模块流） | ✅ |
| 多模型协作 / embedding 检索 | ✅（`.env` 配好 API） |
| Agent 读写 `task-tree.md` | ✅（SSH + Cursor/Codex 打开项目目录） |
| CodeLoc 跳转编辑器 | ✅（服务器上安装 `cursor` 或 `code` CLI 并加入 PATH） |
| 资源管理器右键「打开任务图」 | ❌ Windows 专用 |
| `chain-loop-stop.ps1` 结束 IDE 进程 | ❌ 用 Cursor 里手动停 loop，或见下文 bash 门禁 |

---

## 1. 打包：要带什么上服务器

**不需要** Windows 的 `Setup.cmd` / `LLMTaskTree-Setup.zip`。

在开发机（Windows）先同步 kit，再打包：

```powershell
# 在仓库根目录
powershell -File scripts\build-kit.ps1
```

上传到 Linux 的内容（任选一种布局）：

**布局 A（推荐）— 项目 + kit 子目录**

```text
/srv/my-project/
  task-tree.md          # 可安装时从模板生成
  .env
  versions/
  knowledge/
  llm-task-tree/        # stub（安装脚本生成）
    task-tree.config.json
  llm-task-tree-kit/    # 整文件夹（含 server.js、public/、skills/）
```

**布局 B — 共用一份 kit，多个项目**

```text
/opt/llm-task-tree-kit/     # 全局 kit（只 npm install 一次）
/srv/project-a/             # 各项目只有 task-tree.md + llm-task-tree stub
/srv/project-b/
```

打包示例（在 Linux 或 WSL 上）：

```bash
tar czf my-project.tar.gz my-project/
# 或只打包 kit
tar czf llm-task-tree-kit.tar.gz llm-task-tree-kit/
```

---

## 2. 服务器要求

- **Node.js 18+**（`node -v`）
- 可选：**nginx** 反代 + HTTPS
- 防火墙放行你用的端口（示例 `8080`）

---

## 3. 安装（首次）

安装脚本接受一个项目根目录参数。项目和 kit 分开放置时，直接传入项目路径；省略参数时，默认使用 kit 的上级目录：

```bash
chmod +x /opt/llm-task-tree-kit/install-linux.sh /opt/llm-task-tree-kit/start-task-tree.sh
/opt/llm-task-tree-kit/install-linux.sh /srv/my-project
```

脚本会：

1. 创建项目专属的 `llm-task-tree/` stub 与 `task-tree.config.json`，运行时仍共享 kit
2. 从模板生成 `task-tree.md`（若不存在）
3. 合并/创建 `AGENTS.md` 标记块，并安装项目级 Codex hooks
4. 合并 `.cursor/mcp.json`，保留既有 server，并复制任务树 Cursor rules
5. 创建 `versions/`、`knowledge/`、`scripts/`、背景树注册表和 flow README
6. 复制 `.env.example` → `.env`（若不存在）
7. 在 kit 目录执行 `npm install`
8. 若检测到 Codex CLI，注册共享 MCP server 和 task-tree plugin；没有 Codex CLI 时只跳过全局注册，不阻断项目安装

然后编辑 `.env`（模型 API、embedding、联网搜索等）。

---

## 4. 启动 / 打开任务图

```bash
cd /srv/my-project
./llm-task-tree/open-task-tree.sh
# 或直接用 kit 启动指定项目
PORT=8080 HOST=0.0.0.0 /opt/llm-task-tree-kit/start-task-tree.sh /srv/my-project/llm-task-tree
```

推荐使用项目生成的 `llm-task-tree/open-task-tree.sh`：它会读取项目配置，计算稳定端口，并把项目根目录传给服务。多个项目共用同一 kit 时，每个项目仍有独立端口标记和数据目录。

浏览器打开：`http://<服务器IP>:8080`

**仅本机调试**（默认 `HOST=127.0.0.1`）：

```bash
./llm-task-tree/open-task-tree.sh
# 本机浏览器 http://127.0.0.1:5177
```

**从笔记本访问服务器上的服务**（二选一）：

```bash
# A. 服务器监听 0.0.0.0:8080，直接访问 http://server:8080

# B. SSH 隧道（服务器仍只监听 127.0.0.1）
ssh -L 8080:127.0.0.1:5177 user@your-server
# 本机浏览器 http://127.0.0.1:8080
```

### 手动启动（不用脚本）

```bash
export HOST=0.0.0.0
export PORT=8080
export TASK_TREE_PROJECT_ROOT=/srv/my-project
export TASK_TREE_STUB_DIR=/srv/my-project/llm-task-tree
cd /srv/my-project/llm-task-tree-kit
node server.js
```

---

## 5. 多树职责

安装后会有一个注册表 `task-trees.json`：

- `task-tree.md` 是唯一进入执行流程的 active method tree，保存当前方法和下一动作。
- `trees/background.md` 保存稳定背景、长期约束和用户决策，不进入 `scripts/project.json`。
- `trees/architecture.md` 保存任务图系统实现契约，按需读取，不复制进方法树。

需要迭代方法时只读/修改 `task-tree.md`；只有稳定背景或系统架构发生变化时才维护对应的辅助树。

## 6. 创建一棵新任务树

**方式 1 — 安装脚本**（空目录运行 `install-linux.sh`，会生成 starter 树）

**方式 2 — 手动**

```bash
cp llm-task-tree-kit/templates/task-tree.starter.md task-tree.md
mkdir -p versions knowledge scripts subtrees
```

**方式 3 — 让 Agent 建树**

在 Cursor/Codex 中打开项目，使用 skill `task-tree-grill` 或按 `AGENTS.md` / `llm-task-tree/AGENTS.task-tree.md` 与用户对话后写入 `task-tree.md`。

---

## 7. 执行链 Loop（Agent 自动按链推进）

Loop **不依赖 Windows**；依赖：

1. 任务图服务在跑（`start-task-tree.sh`）
2. Cursor Agent 能访问该服务的 HTTP API
3. 你在 UI 里用 **⊕** 设好执行链，在 Next 节点写 **「下一步思路」(NextIdea)**

### 6.1 在 Cursor 里 loop（本机连远程服务）

把下面 URL 里的 host/port 换成你的（或 SSH 隧道后的 `127.0.0.1:8080`）：

```text
/loop 3m 【链式单步·按 NextIdea 执行】
0) GET http://127.0.0.1:8080/api/graph-state/chain-step — 若 shouldStopLoop 则停止 loop
1) 读 stepMarkdown 里的 Next + NextIdea（不要读 NextPlan）
2) 严格按 NextIdea 写代码/改 task-tree.md
3) 更新 Next 节点 CurrentResult；完成则 Completion:已完成
4) 若 ChainAutoAdvance 开启 → POST http://127.0.0.1:8080/api/graph-state/chain-advance Content-Type: application/json body {}
5) 若 done 或 again shouldStopLoop → 停止 loop
```

页面底部 **「循环说明」** 按钮会生成带当前端口的同款命令（复制即可）。

### 6.2 命令行检查链状态

```bash
PORT=8080
curl -s "http://127.0.0.1:${PORT}/api/graph-state/chain-step" | jq .
curl -s -X POST "http://127.0.0.1:${PORT}/api/graph-state/chain-advance" \
  -H "Content-Type: application/json" -d '{}'
```

### 6.3 bash 门禁（替代 chain-loop-gate.ps1）

```bash
chmod +x llm-task-tree-kit/scripts/chain-loop-gate.sh
PORT=8080 ./llm-task-tree-kit/scripts/chain-loop-gate.sh
# 输出 AGENT_LOOP_STOP → 应停止 loop
# 输出 AGENT_LOOP_TICK → 继续
```

Linux 上**没有** `chain-loop-stop.ps1`（不关 Cursor 进程）；`shouldStopLoop=true` 时在 Cursor 里结束 `/loop` 即可。

---

## 8. 后台常驻（systemd 示例）

```ini
# /etc/systemd/system/task-tree.service
[Unit]
Description=LLM Task Tree
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/my-project/llm-task-tree-kit
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=TASK_TREE_PROJECT_ROOT=/srv/my-project
Environment=TASK_TREE_STUB_DIR=/srv/my-project/llm-task-tree
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now task-tree
```

前面加 nginx 反代到 `127.0.0.1:8080` 即可对外提供 HTTPS。

---

## 9. 更新 kit（不丢 task-tree.md）

在开发机改完代码后：

```powershell
powershell -File scripts\build-kit.ps1
```

把新的 `llm-task-tree-kit/` 同步到服务器（**不要覆盖**项目根的 `task-tree.md`、`versions/`、`.env`），然后：

```bash
cd /srv/my-project/llm-task-tree-kit
npm install
sudo systemctl restart task-tree   # 若用 systemd
```

---

## 10. 常见问题

**Q: 打开页面空白 / API 失败**  
确认 `node server.js` 在跑，且浏览器端口与 `PORT` 一致。

**Q: 知识库 / 多模型报错**  
检查项目根 `.env` 里 API 地址；Linux 服务器要能访问该地址（内网或公网）。

**Q: 流程图保存失败**  
确认项目根有 `scripts/` 目录（install 会创建），且服务对项目目录有写权限。

**Q: 还要 Windows 那套一键更新吗**  
Linux 上不用 `一键更新.cmd`；用 git/rsync 更新 kit + `npm install` 即可。
