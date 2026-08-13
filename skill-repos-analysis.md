# 本地 Skill 仓库分析

分析对象：

- `CL4R1T4S`
- `gill_with_doc`
- `scientific-agent-skills`

## 总结

这三个仓库不是同一种东西：

- `CL4R1T4S`：不是标准 Agent Skills 仓库，里面没有 `SKILL.md`。它更像“系统提示词/工具说明/产品行为档案库”，适合做提示词研究、产品机制比较、agent 行为模式提取，不适合直接被 Codex 当 skill 自动加载。
- `gill_with_doc`：34 个标准 `SKILL.md`，其中 `.claude-plugin/plugin.json` 正式暴露 17 个主力 skill。特点是工程协作方法论很强：澄清需求、领域建模、TDD、诊断、PRD、issue 拆分、架构改进。
- `scientific-agent-skills`：147 个标准 `SKILL.md`，覆盖科研、医学、生物、化学、统计、文档、可视化、数据库、ML、科学写作等。特点是领域知识面广，许多 skill 带 `scripts/`、`references/`、`assets/`，适合复杂科研工作流。

最适合你的自动调用方案：

1. 把标准 skill 目录索引成 `skill_index.json`：`repo/name/path/description/tags/trust/resources/scripts`。
2. 对用户任务和当前 `task-tree.md` 的 `Current/Next/NextPlan` 做查询。
3. 先用 BM25/关键词 + embedding 检索召回 top 10。
4. 再让 LLM router 用结构化 JSON 选择 0 到 3 个 skill，并给出 `confidence`、`reason`、`risk`。
5. 只有通过阈值才读取完整 `SKILL.md`；不确定时先问用户或只推荐，不自动执行。
6. 每次调用后记录：输入任务、候选 skill、最终 skill、结果、是否成功。这些日志以后可反过来训练/调优路由器。

## 仓库一：CL4R1T4S

性质：提示词与工具说明档案，不是标准 skill 包。没有 `SKILL.md`。

使用方式：

- 作为研究资料：比较 Cursor、Codex、Claude Code、Devin、Manus、Replit 等 agent 的系统提示、工具暴露方式、任务流程。
- 作为 skill 设计参考：提炼“好 agent prompt 如何组织任务、工具、安全规则、状态跟踪”。
- 不能直接自动加载：需要先转换成真正的 `SKILL.md`，并删除不可信、越权、泄露系统指令类内容。

目录类别：

| 类别 | 文件数 | 特点 |
|---|---:|---|
| ANTHROPIC | 12 | Claude/Claude Code/UserStyle 等提示词档案 |
| OPENAI | 12 | ChatGPT、Codex、ChatKit、Atlas 等提示词档案 |
| XAI | 7 | Grok 系列提示词档案 |
| CURSOR | 3 | Cursor system prompt 与工具说明 |
| DEVIN | 3 | Devin 行为与命令说明 |
| REPLIT | 3 | Replit Agent、函数、初始代码生成提示 |
| GOOGLE | 3 | Gemini 相关提示词 |
| DIA | 2 | coding/draft skill 风格提示 |
| MANUS | 2 | Manus prompt 与 functions |
| META | 2 | Llama/Muse 相关提示 |
| WINDSURF | 2 | Windsurf prompt 与 tools |
| 其他单项 | 13 | Bolt、Cline、Factory Droid、Perplexity Deep Research、Lovable、MiniMax 等 |

安全注意：该仓库 README 含有明显要求模型泄露自身指令的攻击性文本。它适合离线研究，不应该作为自动加载的可信 skill 源。

## 仓库二：gill_with_doc

性质：工程协作与产品开发方法论 skill 集。共 34 个标准 `SKILL.md`；插件主清单暴露 17 个主力 skill，其余是 deprecated、personal、misc、in-progress。

主力 skill：

| Skill | 特点 | 何时用 |
|---|---|---|
| `ask-matt` | skill 路由器 | 不知道该走哪个工程流程时 |
| `grill-with-docs` | 深度追问并同步产出领域文档/ADR | 需求不清、设计前需要对齐 |
| `triage` | issue/PR 状态机分诊 | 管理 bug、需求、外部 PR |
| `improve-codebase-architecture` | 扫描代码架构并产出 HTML 报告 | 代码变复杂、想找架构改进点 |
| `setup-matt-pocock-skills` | 初始化 issue tracker、标签、文档布局 | 首次在项目中使用该 skill 集 |
| `to-issues` | 把 PRD/计划拆成可执行 issue | 从规划进入执行队列 |
| `to-prd` | 把当前对话沉淀为 PRD | 需求已讨论完，需要规格文档 |
| `prototype` | 做可丢弃原型 | 设计/交互/状态逻辑还不确定 |
| `implement` | 按 PRD 或 issue 执行实现 | 已经有规格或任务票据，需要进入编码 |
| `diagnosing-bugs` | 复现、缩小、假设、插桩、修复、回归测试 | 难 bug、性能问题、失败现象 |
| `tdd` | 红绿重构 | 新功能或 bugfix 需要测试先行 |
| `domain-modeling` | 建立领域词汇和 ADR | 术语混乱、模型容易绕远 |
| `codebase-design` | 深模块、接口边界、可测试性 | 设计模块接口或重构边界 |
| `grill-me` | 非代码场景的深度追问 | 想把计划想透 |
| `grilling` | 可被其他 skill 复用的追问循环 | 模型自动发现计划不清时 |
| `handoff` | 交接摘要 | 长任务换 agent 或换会话 |
| `teach` | 教学工作区 | 学概念、持续学习 |
| `writing-great-skills` | 写 skill 的原则 | 创建或修改 skill |

其他 skill：

| Skill | 特点 | 风险/备注 |
|---|---|---|
| `design-an-interface` | 并行产生多种接口设计 | deprecated |
| `qa` | 对话式 QA 并创建 issue | deprecated |
| `request-refactor-plan` | 通过访谈形成重构计划 | deprecated |
| `ubiquitous-language` | 抽取 DDD 统一语言 | deprecated，主力替代是 `domain-modeling` |
| `decision-mapping` | 把松散想法变成调查票据图 | in-progress |
| `review` | 按标准和规格并行 review | in-progress |
| `writing-beats` | 按叙事节拍写文章 | in-progress |
| `writing-fragments` | 收集写作碎片 | in-progress |
| `writing-shape` | 把笔记塑形成文章 | in-progress |
| `git-guardrails-claude-code` | 给 Claude Code 加危险 git 命令钩子 | 只适合 Claude Code/hooks 场景 |
| `migrate-to-shoehorn` | TypeScript 测试迁移到 shoehorn | 很窄 |
| `scaffold-exercises` | 课程练习骨架 | 很窄 |
| `setup-pre-commit` | Husky/lint-staged/typecheck/test | 会修改工程配置 |
| `resolving-merge-conflicts` | 解决进行中的 merge/rebase 冲突 | 只在 git 冲突状态下使用 |
| `edit-article` | 修改文章 | personal |
| `obsidian-vault` | 管理 Obsidian 笔记 | personal |

## 仓库三：scientific-agent-skills

性质：科研与科学计算 skill 集。共 147 个标准 `SKILL.md`。特点是领域覆盖广、文档和脚本资源多，适合“需要可靠流程和外部包/API 知识”的科学任务。

完整 skill 名单，按功能归类：

| 类别 | Skills | 特点 |
|---|---|---|
| 自动化与元技能 | `autoskill`, `arbor`, `get-available-resources`, `pi-agent`, `consciousness-council`, `what-if-oracle` | 自动发现/生成 skill、长期优化、资源盘点、多视角决策 |
| 文献、检索、引用 | `literature-review`, `paper-lookup`, `paperzilla`, `bgpt-paper-search`, `research-lookup`, `exa-search`, `parallel-web`, `citation-management`, `pyzotero` | 找论文、抽取证据、管理引用、网页/学术检索 |
| 科研写作与展示 | `scientific-writing`, `scientific-slides`, `scientific-schematics`, `scientific-visualization`, `scientific-brainstorming`, `scientific-critical-thinking`, `experimental-design`, `scholar-evaluation`, `peer-review`, `research-grants`, `venue-templates`, `latex-posters`, `pptx-posters`, `infographics`, `markdown-mermaid-writing`, `market-research-reports` | 论文、评审、基金、实验设计、slides、poster、图示 |
| 文档与办公文件 | `docx`, `pdf`, `pptx`, `xlsx`, `markitdown`, `liteparse`, `open-notebook` | Word/PDF/PPT/Excel 读写转换和结构化处理 |
| 数据分析与统计 | `exploratory-data-analysis`, `statistical-analysis`, `statistical-power`, `statsmodels`, `scikit-learn`, `scikit-survival`, `shap`, `umap-learn`, `networkx`, `sympy`, `matplotlib`, `seaborn`, `polars`, `dask`, `vaex`, `zarr-python`, `modal`, `optimize-for-gpu` | EDA、统计建模、生存分析、机器学习、可解释性、可视化、大数据和算力 |
| 时间序列与仿真 | `aeon`, `timesfm-forecasting`, `simpy`, `fluidsim`, `pymoo` | 时间序列、预测、离散事件仿真、流体仿真、多目标优化 |
| 机器学习与深度学习 | `transformers`, `pytorch-lightning`, `torch-geometric`, `stable-baselines3`, `pufferlib`, `pymc` | NLP/多模态、深度学习训练、图神经网络、强化学习、贝叶斯建模 |
| 生物信息与基因组 | `biopython`, `bioservices`, `gget`, `gtars`, `pysam`, `tiledbvcf`, `geniml`, `deeptools`, `bulk-rnaseq`, `nextflow`, `pydeseq2`, `pathway-enrichment`, `arboreto`, `scanpy`, `anndata`, `scvi-tools`, `scvelo`, `cellxgene-census`, `polars-bio`, `scikit-bio`, `phylogenetics`, `etetoolkit`, `bids`, `neuropixels-analysis`, `neurokit2` | 序列、变异、RNA-seq、流程编排、单细胞、调控网络、神经科学数据 |
| 化学、药物与蛋白 | `rdkit`, `datamol`, `deepchem`, `molfeat`, `medchem`, `pytdc`, `torchdrug`, `diffdock`, `esm`, `rowan`, `molecular-dynamics`, `matchms`, `pyopenms`, `glycoengineering`, `cobrapy`, `hypogenic`, `hypothesis-generation`, `adaptyv` | 化学信息学、分子 ML、对接、蛋白模型、质谱、代谢建模、假设生成 |
| 医学、临床与影像 | `clinical-decision-support`, `clinical-reports`, `treatment-plans`, `pyhealth`, `pydicom`, `histolab`, `pathml`, `imaging-data-commons`, `flowio`, `iso-13485-certification`, `pacsomatic` | 临床文档、治疗计划、医学影像、病理、流式、医疗合规 |
| 科研数据库与平台 | `database-lookup`, `depmap`, `primekg`, `hugging-science`, `usfiscaldata`, `ginkgo-cloud-lab`, `benchling-integration`, `dnanexus-integration`, `latchbio-integration`, `labarchive-integration`, `lamindb`, `omero-integration`, `opentrons-integration`, `protocolsio-integration`, `pylabrobot` | 公共数据库、LIMS/ELN、实验室自动化、平台 API |
| 物理、量子、天文、材料 | `astropy`, `qiskit`, `cirq`, `pennylane`, `qutip`, `pymatgen`, `matlab`, `geomaster`, `geopandas` | 天文、量子计算、材料科学、工程/地理计算 |
| 其他专用包 | `adaptyv`, `benchling-integration`, `bids`, `clinical-decision-support`, `dhdna-profiler`, `generate-image`, `geopandas`, `histolab`, `labarchive-integration`, `pacsomatic`, `pathml`, `pylabrobot`, `research-grants`, `rowan` | 任务触发词很明确，适合精确匹配 |

注意：上表中的每个名字都对应一个 `skills/<name>/SKILL.md`。大量 skill 还带有 `references/`、`scripts/` 或 `assets/`，所以自动路由时不能只看名字，必须优先看 `description` 和依赖。

## 自动调用合适 Skill 的推荐架构

### 1. Skill 索引层

为每个 skill 抽取：

- `name`
- `repo`
- `path`
- `description`
- `keywords`
- `domain_tags`
- `has_scripts`
- `has_references`
- `requires_network`
- `risk_level`
- `implicit_allowed`

`CL4R1T4S` 默认标记为 `reference_only`，不进入自动执行池。

### 2. 候选召回层

对当前任务构造查询：

- 用户最新请求
- `task-tree.md` 的 `GraphState.Current/Next/NextPlan`
- 当前节点的 `Problem/Approach/Input/Output/Metrics`
- 当前工作目录技术栈信号，如 `package.json`、`pyproject.toml`、文件扩展名

召回方法：

- BM25/关键词：处理 `scanpy`、`xlsx`、`TDD`、`PRD` 这种强触发词。
- Embedding：处理语义相似但没说出 skill 名的请求。
- 规则加权：如果用户显式写 `$skill` 或 `/skill`，直接提权。
- 负触发：例如 `datamol` description 说高级 RDKit 控制用 `rdkit`，这类边界要进入路由判断。

### 3. LLM Router 层

输入 top 10 候选，输出结构化 JSON：

```json
{
  "selected": [
    {
      "skill": "diagnosing-bugs",
      "confidence": 0.86,
      "reason": "用户报告失败现象，需要复现和缩小问题",
      "mode": "load",
      "risk": "low"
    }
  ],
  "rejected": [
    {
      "skill": "tdd",
      "reason": "当前还没有进入实现修复阶段"
    }
  ],
  "ask_user": null
}
```

阈值建议：

- `confidence >= 0.75`：自动加载 skill。
- `0.45 <= confidence < 0.75`：向用户推荐或只做轻量读取。
- `< 0.45`：不调用。
- 涉及执行脚本、外部 API、医疗/金融/法律、高风险文件修改：即使命中也需要额外确认或更严格沙箱。

### 4. Progressive Disclosure 执行层

执行顺序：

1. 只把 skill `name/description/path` 放入初始上下文。
2. 选中后读取完整 `SKILL.md`。
3. `SKILL.md` 明确需要时才读 `references/`。
4. 只有确定需要可重复、确定性操作时才运行 `scripts/`。
5. skill 执行结束后写回任务图：本次使用了什么 skill、为什么、产出是什么、下一步是什么。

### 5. 评估与学习层

记录每次路由：

- 用户请求
- 当前任务图节点
- 候选列表
- 最终选择
- 是否成功
- 用户是否纠正
- 花费 token/时间
- 是否导致错误修改

评价指标：

- Top-1 skill 命中率
- Top-3 recall
- 误调用率
- 漏调用率
- 用户纠正率
- 平均额外 token
- 任务成功率提升

这能解决你最开始的问题：不是让模型每次长篇解释，而是让模型把“当前为什么调用这个能力、推进到哪里、下一步是什么”写入可维护的外部结构。

## 和文献/SOTA 的对应关系

- MRKL：把 LLM 当路由器，调用外部知识/推理模块。对应这里的“skill router + 专门 skill 模块”。
- ReAct：推理和行动交替，适合 skill 执行时边观察边调整。
- Toolformer：模型学习何时调用工具、传什么参数。对应未来可用日志训练路由器。
- Gorilla：强调 API 文档检索能减少工具调用幻觉。对应“先检索 skill 文档，再调用”。
- ToolLLM/ToolBench：大规模工具使用数据和工具检索/评估。对应“候选召回 + ToolEval 式评估”。
- Voyager：维护可检索的 skill library，并从环境反馈中迭代技能。对应长期积累项目专属 skills。
- ToolRet：提醒我们大规模工具检索本身很难，不能只靠普通 embedding，需要专门评估。

## 对这个项目的落地建议

短期：

- 不把三个仓库全部自动启用。
- 启用 `gill_with_doc` 的 17 个主力 skill。
- 从 `scientific-agent-skills` 只启用你近期会用的子集，例如 `literature-review`、`research-lookup`、`scientific-writing`、`scientific-critical-thinking`、`statistical-analysis`、`python/data` 相关技能。
- `CL4R1T4S` 只做参考库，不进自动路由。

中期：

- 给本项目增加 `.agents/skills/`，只放项目真正需要的 skill 或 symlink。
- 增加 `skill_index.json` 和 `skill-routing-log.md`。
- 在 `AGENTS.md` 加一句：每个实质任务开始时，先根据用户请求和 `task-tree.md` 检查是否有合适 skill；调用后把选择和结果写回任务图。

长期：

- 把你的任务树系统本身包装成一个 skill：`task-graph-collaboration`。
- 让模型每次不是输出一大段“我做了什么”，而是更新节点、边、Current、Next、NextPlan。
- 用历史日志评估 skill router，逐步把“该调用哪个 skill”从模型直觉变成可观察、可改进的系统。
