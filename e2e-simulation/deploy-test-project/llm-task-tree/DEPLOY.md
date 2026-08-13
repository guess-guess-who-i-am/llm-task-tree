# 一键部署到其他项目

把下面 **3 个文件** 复制到目标项目的**根目录**：

```text
setup-task-tree.cmd
setup-task-tree.ps1
setup-task-tree.kitpath    ← 仅一行：kit 源目录的完整路径
```

`setup-task-tree.kitpath` 示例（改成本机路径，只保留一行）：

```text
E:\解决跟不上大模型思路问题\llm-task-tree-kit
```

然后 **双击 `setup-task-tree.cmd`**。

1. 从 kit 源复制 `llm-task-tree/` 到本项目  
2. 运行 `install`（`task-tree.md`、`AGENTS.md` 合并、`.gitignore`、`npm install`）  
3. 打开任务图浏览器界面  

## Kit 源从哪里找（按顺序尝试）

1. 同目录的 **`setup-task-tree.kitpath`**（一行路径，随脚本一起复制并改一次）
2. 环境变量 **`LLM_TASK_TREE_KIT_HOME`**
3. 项目根下的 **`llm-task-tree-kit/`** 文件夹

## 以后日常使用

只需双击：

```text
llm-task-tree\打开任务图.cmd
```

不必再跑 setup。

## 要求

- Windows + PowerShell  
- 已安装 Node.js  

## 已有 AGENTS.md

install 只**追加** `<!-- llm-task-tree:begin -->` 块，不覆盖原内容。
