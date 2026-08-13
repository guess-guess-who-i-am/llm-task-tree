# 一键部署到其他项目

## 推荐：只复制 1 个文件

把 **`setup-task-tree.cmd`** 复制到目标项目**根目录**，确认文件里这一行指向本机 kit 源（通常不用改）：

```text
::KITPATH=E:\解决跟不上大模型思路问题\llm-task-tree-kit
```

然后 **双击 `setup-task-tree.cmd`**。脚本会自动：

1. 从 kit 源复制 `llm-task-tree/` 到本项目
2. 运行 install（`task-tree.md`、`AGENTS.md` 合并、`.gitignore`、`npm install`）
3. 打开任务图浏览器界面

## Kit 源从哪里找（按顺序）

1. 本 cmd 文件内的 **`::KITPATH=`** 一行（推荐）
2. 环境变量 **`LLM_TASK_TREE_KIT_HOME`**
3. 项目根下的 **`llm-task-tree-kit/`** 文件夹
4. （兼容旧方式）同目录的 **`setup-task-tree.kitpath`** 文件

若你已在 Windows 用户环境变量里设置过 `LLM_TASK_TREE_KIT_HOME`，甚至可以把 `::KITPATH=` 留空，只复制这一个 cmd 即可。

## 以后日常使用

只需双击：

```text
llm-task-tree\打开任务图.cmd
```

不必再跑 setup。

## 要求

- Windows + PowerShell
- 已安装 Node.js 18+

## 已有 AGENTS.md

install 只**追加** `<!-- llm-task-tree:begin -->` 块，不覆盖原内容。

## 旧方式（仍可用）

也可继续复制三件套：`setup-task-tree.cmd` + `setup-task-tree.ps1` + `setup-task-tree.kitpath`。新 cmd 已内嵌 PowerShell，**不必再带 `.ps1`**。
