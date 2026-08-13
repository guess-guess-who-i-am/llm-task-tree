# 一键部署到其他项目

## 安装包（推荐给其他人试用）

1. 打包：在项目根目录运行 `powershell -File scripts\build-dist.ps1`
2. 分发：`dist\LLMTaskTree-Setup.zip`
3. 使用者：解压 → 双击 **`Setup.cmd`** → 选择安装目录（任意盘符）
4. 安装完成后在资源管理器右键即可使用（无需再复制文件）

卸载：安装目录里的 **`Uninstall.cmd`**

详细说明见 `安装说明.txt` / `README-INSTALL.md`

---

## 最省事：右键菜单（开发机已装 kit 时）

**只需在本机做一次**：双击

```text
llm-task-tree-kit\register-context-menu.cmd
```

注册完成后会**自动重启资源管理器**。之后在 **Windows 文件资源管理器**（不是 Cursor 侧边栏）里：

| 操作位置 | 菜单项 |
|----------|--------|
| 右键文件夹图标 | Install LLM Task Tree / Open Task Tree |
| 右键文件夹内空白处 | 同上 |

若菜单很长，请向下滚动；它们与 Cursor、Codex 等第三方项在同一层。

**注意**：只注册在 `Directory` / `Directory\Background` 下，**不要**注册 `Folder` 类，否则会覆盖双击打开行为。

- **看不到菜单**：请确认是在 Windows 资源管理器里右键，不是在 Cursor/VS Code 文件树里。
- **只在空白处右键才需要 Background 项**：旧版注册脚本漏注册了 `Directory\Background`；请重新运行 `register-context-menu.cmd`。
- **卸载**：双击 `unregister-context-menu.cmd`。

---

## 备选：只复制 1 个文件

把 **`setup-task-tree.cmd`** 复制到目标项目**根目录**，确认文件里这一行指向本机 kit 源（通常不用改）：

```text
::KITPATH=E:\解决跟不上大模型思路问题\llm-task-tree-kit
```

然后 **双击 `setup-task-tree.cmd`**。脚本会自动：

1. 从 kit 源复制 `llm-task-tree/` 到本项目
2. 运行 install（`task-tree.md`、`AGENTS.md` 合并、`.gitignore`、`npm install`）
3. 打开任务图浏览器界面

## Kit 源从哪里找（按顺序）

1. 右键菜单：注册时记录的 kit 目录（`deploy-task-tree.ps1` 同目录）
2. 本 cmd 文件内的 **`::KITPATH=`** 一行
3. 环境变量 **`LLM_TASK_TREE_KIT_HOME`**
4. 项目根下的 **`llm-task-tree-kit/`** 文件夹
5. （兼容旧方式）同目录的 **`setup-task-tree.kitpath`** 文件

## 以后日常使用

任选其一：

- 资源管理器右键 → **打开任务图**
- 双击 `llm-task-tree\打开任务图.cmd`

## 要求

- Windows + PowerShell
- 已安装 Node.js 18+

## 已有 AGENTS.md

install 只**追加** `<!-- llm-task-tree:begin -->` 块，不覆盖原内容。

## 更新已安装的项目（不丢 task-tree.md）

### 推荐：共用一份 kit（更新一次，全部生效）

**新默认**：安装时各项目只保留很小的 `llm-task-tree/` stub（配置 + 启动器），**程序代码共用一份**（`register-context-menu.cmd` 注册的全局 kit，或 `Setup.cmd` 安装目录）。

| 位置 | 内容 | 更新时 |
|------|------|--------|
| 项目根 | `task-tree.md`、`versions/`、`knowledge/`、`.env` | **保留** |
| 项目 `llm-task-tree/` | stub（`task-tree.config.json` + 启动脚本） | 几乎不变 |
| **全局 kit** | `server.js`、`public/`、`node_modules/` 等 | **只更新这一份** |

**日常更新（所有已迁移项目一次生效）**：

```powershell
# 在开发仓库的 llm-task-tree-kit 目录下
powershell -File update-shared-kit.ps1 -SyncFrom .
```

或双击 **`update-shared-kit.cmd`**。

**把现有「每项目一整份拷贝」全部改成共用 kit**：

```powershell
# 方式 A：项目列表文件（UTF-8，每行一个项目根目录）
powershell -File update-all-projects.ps1 -ProjectsFile my-projects.txt

# 方式 B：已安装过的项目会自动登记到注册表
powershell -File update-all-projects.ps1 -UseRegistry
```

上述命令会：把仍是完整拷贝的项目 **迁移为 stub** → **更新全局 kit 一次**。

**单个项目迁移**：

```powershell
powershell -File migrate-to-shared-kit.ps1 -ProjectRoot "F:\empty-window"
```

---

### 一键更新（任意路径、任意电脑）

把 **整个 kit 文件夹**（或解压后的 Setup zip）拷到任意位置，双击：

- **`一键更新.cmd`** 或 **`Update.cmd`**

脚本会用 **当前文件夹作为新版代码**，更新 **本机** 的全局安装目录（`kit.path` 记录的位置）：

1. 同步程序文件到本机 install 目录  
2. `npm install`  
3. 重新注册右键菜单  
4. 更新本机已登记的所有项目 stub（`task-tree.md` 等数据不动）

**首次在这台电脑更新**：会弹出文件夹选择框，选原来的 Setup 安装目录即可。  
**可选**：在 cmd 同目录放 `update-projects.txt`（UTF-8，每行一个项目根），补充未登记项目。

发给其他电脑：同样发 zip / 文件夹，对方解压后双击 `一键更新.cmd` 即可。

---

### 旧模式：每项目独立一份代码

若坚持用完整拷贝（`-FullCopy` 安装），仍需逐个项目更新：

```powershell
powershell -File update-kit.ps1 -ProjectRoot "D:\your-project"
```

---

### 数据安全说明

install / migrate **不会覆盖** `task-tree.md`、`versions/`、`knowledge/`、已有 `.env`；`AGENTS.md` 只更新标记块。

## 旧方式（仍可用）

也可继续复制三件套：`setup-task-tree.cmd` + `setup-task-tree.ps1` + `setup-task-tree.kitpath`。新 cmd 已内嵌 PowerShell，**不必再带 `.ps1`**。
