# LLM Task Tree

一个本地任务图工具，用 Markdown 保存大模型的外部工作记忆，并用 Web 前端可视化、编辑节点和关系。

主界面是知识图谱式画布：节点卡片显示问题、当前方法、评价指标和结论，可拖动、缩放并直接编辑。单击节点会打开输入/输出预览，其中只写简明中文说明和必要路径；代码、原始数据与复杂英文术语保存在证据文件，工作区路径可以点击打开。节点连接形成关系边，工具栏的 `⇲` 可自动整理布局。

节点右上角的 `●` 会把该节点设为当前推进节点，并用红色高亮从根节点到它的路径；`◆` 会把该节点设为下一步推进节点，并用蓝色高亮从根节点到它的路径。

图谱中的节点、边、位置和批注会自动保存回 `task-tree.md`。Codex 在这个目录中完成或推进任务时，也应该更新同一个文件；具体规则见 `AGENTS.md`。

页面右侧是版本树，占据约五分之一宽度。每次图谱内容被保存前，服务端会把当前 `task-tree.md` 复制到 `versions/`，文件名包含“将增加/将修改/将删除/将回退……”这类原因。右侧每个版本节点显示这个原因和时间，点击版本节点会把 `task-tree.md` 回退到该版本；回退前同样会先备份当前状态，因此不会删除任何旧版本。

## 启动

推荐直接双击：

```text
打开任务图.cmd
```

它会自动为当前项目找可用端口、启动本项目的任务图服务并打开浏览器；如果这个项目的服务已经在运行，会直接复用原来的端口。

也可以手动启动：

```powershell
npm start
```

打开：

```text
http://127.0.0.1:5177
```

数据文件是：

```text
task-tree.md
```

版本快照保存在：

```text
versions/
```

## 复制到其他项目

将 **`llm-task-tree-kit/`** 整文件夹复制到目标项目（建议命名为 `llm-task-tree/`），运行其中的 **`install.cmd`**，然后双击 **`打开任务图.cmd`**。详见 `llm-task-tree-kit/README.md`。

本仓库完整备份：`backups/snapshot_20260621-195906/`。

## Markdown 节点格式

每个节点必须使用二级标题：

```markdown
## N1 - 节点标题

- Position: 120,240
- Size: 400,720
- Problem: 这个节点要解决的问题
- Approach: 当前解决思路
- Input: 需要投入的数据或上下文长什么样
- Output: 这个节点完成后应该产出什么
- Metrics: 怎么评价这个节点是否解决
- Notes:
  - 批注 1
  - 批注 2
- CurrentResult: 大模型总结执行到这里的当前结果
- RootCauseAnalysis: 大模型总结为什么会犯错或偏航
- CaseStudy:
  - 经典 case 或具体例子，前端会折叠显示
- NextIdea: 用户填写这个节点接下来怎么推进
```

节点不保存状态，也不保存父子关系。关系放在独立的 `# Edges` 区域。
`Input` 和 `Output` 仍然保存在 Markdown 中，但不直接挤在节点卡片里；前端会在选中节点左侧显示它们的预览。
`CurrentResult`、`RootCauseAnalysis`、`CaseStudy` 是大模型维护字段，不是用户手填字段。`NextIdea` 是用户可编辑字段。

## Markdown 边格式

```markdown
# Edges

## E1 - 关系名称

- Endpoints: N1, N2, N3
- LabelOffset: 0,0
- Label: 依赖 / 反驳 / 展开 / 证据 / 待判断
- Notes:
  - 这条边的批注
```

`Endpoints` 里有两个节点就是普通边；有三个或更多节点就是超边。

## 进度状态

```markdown
# GraphState

- Current: N2
- Next: N3
- NextPlan: 接下来要怎么做
```

`Current` 是当前正在推进的终端节点，`Next` 是下一步候选推进节点。前端会分别高亮它们到根节点的路径。`NextPlan` 会显示在下一步节点下方，可直接编辑。

## 给大模型的维护规则

可以把下面这段放进长任务提示词里：

```text
请维护当前目录中的 task-tree.md 作为任务树。

规则：
1. 每个节点代表父节点拆出来的子任务或子问题。
2. 每个节点必须包含 Problem、Approach、Input、Output、Metrics、Notes、CurrentResult、RootCauseAnalysis、CaseStudy、NextIdea。
3. 不要把所有上下文塞进一个节点；当问题分叉、卡住、依赖新信息、或需要人类判断时，新增子节点。
4. 更新时只改相关节点和边，避免重复改写整张图。
5. 不要使用 active、done、blocked 之类的节点状态；用节点内容和边关系表达当前局面。
6. Notes 用来保存批注、判断、证据、风险和人类反馈。
7. 如果发现当前路径偏离原始目标，在相关节点或相关边的 Notes 中明确写出偏航原因和建议回到哪个节点。
8. 手动修改 task-tree.md 前，先在 versions/ 中备份，并用“将增加/将修改/将回退……”说明原因。
```
