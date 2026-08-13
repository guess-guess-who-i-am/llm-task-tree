# 一键部署到其他项目

## 最省事：右键菜单（推荐，不用复制文件）

**只需在本机做一次**：双击

```text
llm-task-tree-kit\register-context-menu.cmd
```

之后在资源管理器里，对**任意文件夹**（或文件夹内空白处）右键，会出现：

| 菜单项 | 作用 |
|--------|------|
| **安装 LLM Task Tree** | 在该目录部署 `llm-task-tree/`、`task-tree.md` 等，并打开任务图 |
| **打开任务图** | 打开该目录已安装的任务图（未安装会提示先安装） |

卸载右键菜单：双击 `unregister-context-menu.cmd`。

要求：kit 文件夹保持在注册时的路径；若移动了 kit 目录，请重新运行 `register-context-menu.cmd`。

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

## 旧方式（仍可用）

也可继续复制三件套：`setup-task-tree.cmd` + `setup-task-tree.ps1` + `setup-task-tree.kitpath`。新 cmd 已内嵌 PowerShell，**不必再带 `.ps1`**。
