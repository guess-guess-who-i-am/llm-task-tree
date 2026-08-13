# LLM Task Graph

> 这个文件是大模型和前端共同维护的任务图。节点保存问题空间，边保存节点之间的关系；每条边只连接两个节点。
## ROOT - 可解释结构化论文新颖性测量系统

- Position: 6685,58
- Size: 546,834
- Completion: 进行中
- Problem: 构建一个可解释、可审计的结构化论文新颖性测量系统：论文新颖性定义为“目标论文想法图中，无法被可信前作池联合解释的、带权结构残差”，用来替代黑盒 LLM 直接打分。
- Approach: 按 FINAL-PLAN 的系统分层推进：四层想法图抽取 → 四棵分面本体树映射 → 四层前作池组装 → 角色级对齐/覆盖/组合成本 → 分面残差剖面与解释报告 → Track A/B 评估。LLM 只做文本到结构和单节点到树坐标；novelty/相似性由确定性规则、坐标、树距离、引用关系和审计表计算。开发集 PeerRead 2017 可迭代；确认集冻结后只跑一次。
- Input:
  - 根定义 = 新颖性是“无法被可信前作池联合解释的带权结构残差” # 系统目标
  - 当前完成度 = M0-M3 底座已完成，forest v0.9.0 # 可继续做公式/效度诊断
  - 当前瓶颈 = M4/M5 残差和 typed-edge 都有负结果 # 不能直接冻结
  - 红线 = LLM 不判 novelty；embedding 不参与判断；确认集只跑一次 # 方法边界
- Output:
  - 当前系统状态 = 可解释审计链已搭好，但最终公式未冻结 # 不能进入确认实验
  - 当前主候选 = N_final，其中 β=0 时退回 N_struct # 需要继续校对
  - 当前旁支 = typed-edge C(x)，理论有方向但全 dev LOO 为负 # 不能冻结
  - 最终交付目标 = PROTOCOL_V2 + M6/M7 + M8 + FINAL_REPORT # 后续阶段
- Metrics: 每个分数必须能展开到 target 零件/边、facet、坐标、前作池来源、覆盖前作、树距离或组合罕见度；区分效度必须同时报告 originality、clarity、substance 与偏相关；确认集只跑一次；负结果也算有效项目结果。
- Notes: 当前不是从零开始。M0-M3 已基本完成；M4/M5 的旧残差路线和多轮 typed-graph 路线已有大量探索性负结果。typed-edge 是一个重要探索分支，不是项目总定义；FINAL-PLAN 的结构残差、四层前作池、组合成本、Track A/B 仍是总框架。
- CurrentResult: 权威任务树已建立并补入 FINAL-PLAN 的公式、图层、评估轨道；现在需要让后续实验回到总系统视角，而不是只围绕某个失败/半成功分支打转。
- RootCauseAnalysis: 前期实验密集推进后，任务状态容易被最近一次瓶颈绑架：例如把“typed-edge 可观测性不足”误写成整个项目唯一缺口。正确表述应区分：系统目标、已完成底座、被证伪公式、当前探索分支、下一步最小验证。
- CaseStudy:
  - case 1: residual.py 宽覆盖让 N 近常数 → 不能把技术性覆盖率高当作新颖性有效。
  - case 2: atom_mode=True unknown 低但坐标塌缩 → 低 unknown 不等于高分辨率。
  - case 3: typed-edge 理论方向有信号但 LOO 负 → in-sample 正相关不能当可泛化结论。
- NextIdea: 保持总系统定义不变；当前只把 typed-edge/unknown 补坐标作为一个小规模诊断分支推进，同时继续把结果回填到“残差是否可审计、是否有区分效度、是否值得冻结”的总判断里。
- SelectedSkills:

## N1 - 治理红线与开发/确认防火墙

- Position: 6067,235
- Size: 420,420
- Completion: 进行中
- Problem: 防止为了得到好看的 novelty 相关而违反项目根本目的。
- Approach: GOAL/AGENTS 不由代理改；LLM 不做 target-prior novelty/相似判断；embedding 不参与判断；PROTOCOL_V2 commit 必须早于 M6/M7；确认集只跑一次。
- Input:
  - GOAL 版本 = v1.4 # M4 硬口径已改为零件级覆盖 + 可审计残差
  - 红线 1 = LLM 不做 target-prior novelty/相似性判断 # 合规边界
  - 红线 3 = PeerRead 2017 是开发集，确认集只跑一次 # 防火墙
  - 红线 5 = PROTOCOL_V2 commit 必须早于 M6/M7 结果 # 预注册要求
- Output:
  - 当前合规结论 = 仍处于探索/整理阶段 # 不能声称公式冻结
  - 当前风险 = 已有探索性结果不能倒灌成确认性证据 # 防止后验调参
  - 必须保留 = 负结果、BLOCKED、commit hash、缓存记录 # 审计链
- Metrics: 无红线违规；所有 LLM 调用有缓存；所有负结果写入 ITERATION_LOG；M6/M7 前存在有效 PROTOCOL_V2 commit。
- Notes: GOAL.md 当前为 v1.4：M4 闸门是零件级覆盖 + 可审计残差，漏引召回为诊断指标。GOAL 还显示 M4 硬条件为 total 覆盖率 >=0.80；这和早先聊天里的 head 覆盖说法不同，应以 GOAL.md 为准。
- CurrentResult: 规则已复核；当前树以后应作为任务状态入口。
- RootCauseAnalysis: 过去多次探索性实验已接近 M6 分析，但没有在 PROTOCOL_V2 冻结后执行，必须明确区分探索和确认。
- CaseStudy:
  - case 1: 先看 originality 再调 coverage 定义会违反红线 5/8。
  - case 2: 生成域 n=26 正信号不能替代全 dev 集 n=86 结果。
- NextIdea: 在任何相关分析前确认对应节点是否仍处于探索阶段。
- SelectedSkills:

## N2 - M0-M3 数据、抽取、森林、索引底座

- Position: 2271,2272
- Size: 649,663
- Completion:
- Problem: 建立可复用的数据底座、想法图抽取、分面森林和语料图索引。
- Approach: M0 统一 PeerRead 与评审挖掘；M1 抽取 idea graph 并过 HC-1；M2 建四棵 facet tree 并过 HC-2/HC-3；M3 建 corpus_index 与 rarity_stats。
- Input:
  - 开发语料 = PeerRead ICLR/ACL 2017 # 全部实验迭代来源
  - baseline fulltext 覆盖率 = 61.05% # M0.3 过线
  - HC-6 α = 0.8664 # review stance 信度通过
  - HC-1 v2.1 α = 0.8897 # 中心方法信度通过
  - HC-2 α ≈ 0.934；M2 α ≈ 0.829 # 映射信度通过
- Output:
  - forest version = v0.9.0 # 当前 live 树版本
  - M3 effective unknown = 四个 facet 均 < 0.50 # M3 已过
  - 产出能力 = 已能给论文零件、坐标、稀有度、前作池提供输入 # 下游公式可运行
- Metrics: M0.3 baseline fulltext 61.05%；HC-6 α=0.8664；HC-1 v2.1 α=0.8897；M2 α≈0.829/HC-2 α≈0.934；M3 v0.9.0 effective unknown 四面均 <0.50。
- Notes: 当前有效森林版本是 v0.9.0。后续如果树增长必须版本化，不得静默改树。
- CurrentResult: M0-M3 可作为下游探索基础使用。
- RootCauseAnalysis: M3 曾被 method/task unknown 卡住；通过 admission 修复、HC-5 central-method 增长和 v0.9.0 incremental rebuild 解决。
- CaseStudy:
  - case 1: observed center 原始字符串灌树造成 HC-3 自证，后改为 unknown_pending。
  - case 2: exact-string 高频长树不足，central unknown 需要语义聚类和审核。
  - case 3: v0.9.0 修复 M3，但没有自动解决 M4/M5 新颖性效度。
- NextIdea: 详细说明这个节点里面的内容，都是怎么得到的。可以分成多个节点
- SelectedSkills:

## N2a - M0 数据底座与评审挖掘

- Position: 763,2531
- Size: 1125,1159
- Completion:
- Problem: 后续 novelty 残差需要可靠的论文文本和 baseline 全文；评审立场与漏引线索只作为开发集 gold/诊断材料，不能作为最终方法运行时的新颖性判断输入。
- Approach: 统一 PeerRead ICLR/ACL 2017 schema；从评审句子里转写评审员已经表达的新颖性立场；抽取 missing citation gold；解析 direct baseline 全文并保留失败清单。
- Input:
  - PeerRead 2017 = ICLR2017 427 篇 + ACL2017 137 篇 # 开发语料全集
  - schema = {id, venue, title, abstract, intro, methods_text, related_work_text, conclusion_text, references[], scores{}, review_texts[]} # 统一论文记录
  - review candidate sentences = 3128 # novelty/original/incremental/missing citation 关键词初筛句
  - direct baseline pairs = 724 # M0.3 外部 baseline 论文-目标论文对
  - sample paper = {"id":"ACL2017:173","venue":"ACL2017","split":"dev","title":"Determining Gains Acquired from Word Embedding Quantitatively Using Discrete Distribution Clustering","has_intro":true,"has_methods":true,"has_related":true,"has_conclusion":true,"n_references":38,"n_review_texts":2,"originality_mean":3.0,"clarity_mean":3.5} # 单篇论文进入统一 schema 后的关键字段
  - sample review sentence = {"paper_id":"ACL2017:489","sentence":"In this sense, the originality of the paper is not high.","rule_missing_citation_hint":false} # 规则初筛出的候选评审句
  - sample direct baseline = {"target_id":"ACL2017:105","name":"soft attention model","citation_hint":"Bahdanau et al., 2014","reference_title":"Neural machine translation by jointly learning to align and translate","evidence_quote":"Finally we present an analysis... both the hard and soft attention... models"} # 实验中拿来比较的外部方法/论文
- Output:
  - unified corpus records = 564 # papers.jsonl 行数，ICLR 427 + ACL 137
  - novelty_stance != unmentioned = 413 papers # 超过 M0.2 >=100 要求
  - missing_citation_gold = 122 instances # 超过 M0.2 >=30 要求
  - baseline fulltext acquired = 442/724 = 0.6105 # M0.3 过 60% 门
  - HC-6 alpha = 0.8664 over 100 items # independent model rater (GPT-5.5), user-approved, blind
  - sample stance label = {"sentence":"In this sense, the originality of the paper is not high.","label":"criticize_incremental","missing_citations":[],"rationale":"explicitly says 'the originality of the paper is not high'"} # LLM 只转写评审句立场
  - sample missing citation gold = {"paper_id":"ACL2017:145","mentioned_work":"Efficient Non-parametric Estimation of Multiple Embeddings per Word in Vector Space","evidence_sentence":"There are some missing citations that could be mentioned..."} # 从 missing_citation_complaint 抽出的被点名工作
  - sample acquired baseline = {"pair_id":"1824e977366928e184c0fa07","fulltext_status":"acquired","fulltext_source":"ar5iv_cache","arxiv_id":"1409.0473","matched_reference_score":"1.0000"} # 成功拿到全文
  - sample failed baseline = {"pair_id":"96ed39d0be71741846b936d4","fulltext_status":"attempted_failed","resolver_status":"oa_pdf_error_ProxyError","oa_url":"https://repository.upenn.edu/cis_papers/159"} # 失败也留在分母和失败清单
- Metrics: M0.1 看统一 schema 是否覆盖全部 564 篇并统计 section 缺失；M0.2 看非 unmentioned 论文数和 missing citation 实例数；HC-6 用名义 Krippendorff alpha 检查评审立场分类一致性；M0.3 用 acquired / attempted = 442/724 计算全文获取率。
- Notes: M0 的 LLM 用途是评审文本立场转写和 baseline 抽取，不是让 LLM 判断论文与前作是否相似或是否新颖。review stance 用于 Track A 的次 gold/评估；missing citation gold 历史上用于 M4 前作池校准，GOAL v1.4 后只保留为诊断指标，不进入最终 novelty 计分。最终方法运行时应只使用目标论文文本、可信前作文本/引用/树坐标、corpus_index、rarity_stats 和确定性覆盖规则。HC-6 必须写成 independent model rater，不是 human annotation。
- CurrentResult:
  - M0 总结 = 已关闭 # M0.1/M0.2/M0.3/HC-6 均满足 GOAL.md；评审立场和 missing citation gold 是评估/诊断材料，不是最终 novelty 计分输入
  - 语料完整性 = 564/564 papers loaded # 现实意义：确认开发集论文没有漏载；ICLR2017=427，ACL2017=137
  - methods_text 缺失率 = ACL 21/137=15.33%；ICLR 104/427=24.36% # 现实意义：衡量方法区全文证据缺口；缺失不猜测，保留 null 供后续置信度/limitation 使用
  - related_work_text 缺失率 = ACL 31/137=22.63%；ICLR 151/427=35.36% # 现实意义：衡量显式相关工作证据缺口；影响 L2 related-work 前作证据可见性
  - conclusion_text 缺失率 = ACL 2/137=1.46%；ICLR 19/427=4.45% # 现实意义：衡量抽中心贡献/结论证据是否充足
  - review candidate sentences = 3128 # 现实意义：评审挖掘的句级候选池规模；用于 stance 聚合与 HC-6 分层抽样，不是方法运行时输入
  - classified review sentences = 3128/3128 # 现实意义：候选句全部完成立场转写；没有未分类候选造成统计缺口
  - label counts = praise_novel 944 / criticize_incremental 1049 / missing_citation_complaint 135 / other 1000 # 现实意义：检查评审立场标签分布，避免只抽到单一类别
  - papers with novelty_stance != unmentioned = 413/564 # 现实意义：有足够论文带评审新颖性立场，可作为开发集次 gold；超过 GOAL 的 >=100 要求
  - missing_citation_gold = 122 instances # 现实意义：评审员点名的漏引线索数量；GOAL v1.4 后只作前作池召回诊断，不作最终 novelty 计分输入；超过 >=30 要求
  - direct baseline denominator = 724 external baseline pairs # 现实意义：只统计实验中明确拿来数值比较的外部方法/论文；内部消融、泛称、背景提及不进分母
  - excluded baseline mentions = 2994 # 现实意义：被排除的候选仍留审计，防止通过缩小分母抬高全文覆盖率
  - direct baseline fulltext = 442/724=0.6105 # 现实意义：多数显式实验基线有可审计全文证据；超过 M0.3 >=60% 门
  - fulltext failures = 282 attempted_failed # 现实意义：失败项仍在分母和失败清单中，后续不能假装这些前作有全文证据
  - fulltext source counts = ar5iv 210 / ar5iv_cache 44 / ACL Anthology PDF 126 / OA PDF 46 / local unified corpus 16 # 现实意义：说明全文证据来源可追溯，不依赖单一 API
  - HC-6 alpha = 0.8664 over 100 items, disagreements=10, threshold=0.80, passed=true # 现实意义：检验评审句立场转写与独立盲评评分者的一致性；说明次 gold/诊断标签足够可靠
- RootCauseAnalysis:
  - section 缺失根因 = 保守标题规则 + PDF 解析结构不稳定 + 论文写法不统一 # `methods_text` 缺失通常不是论文没有方法内容，而是没有显式 method/approach/model 等标题、方法内容并入 introduction/experiments，或 PeerRead parsed PDF 标题结构丢失；related work 常并入 introduction/background；conclusion 有时被 discussion/future work 替代或解析不到
  - section 缺失处理原则 = 不猜测、不用 LLM 补区域 # 现实意义：宁可把区域记为 null，也不把错误段落当 methods/related work；后续用缺失率表达输入证据不足
  - other=1000 根因 = 候选句召回故意宽，分类边界故意严 # 候选规则只要出现 novelty/original/citation 等词就抓；但句子如果只是说“怎么表述 novelty”、讨论清晰度、格式、比较设置，或没有明确 praise/criticize/missing-citation 立场，就标 other
  - other=1000 是否好 = 可接受但要由 HC-6 约束 # 现实意义：宽召回 + 严分类能减少漏掉真实立场句；代价是 other 多。HC-6 alpha=0.8664 说明这个边界大体稳定
  - baseline 全文失败根因 = 可访问全文不足 + 解析失败 + API/站点限制 + baseline 名称不总是标准论文标题 # v4 已尝试 local/ACL/arXiv-ar5iv/OpenAlex/S2/Unpaywall/OA PDF；失败样例包括 landing page 没 PDF、PDF stream parse error、403/404/429、ProxyError、无 arxiv/doi/acl id
  - 为什么不能简单“继续爬到满” = 没有可审计全文时不能伪造；任意扩大爬虫会引入不可复现页面、许可/限速问题和错配风险 # 当前做法是成功全文用于 L1 强证据，失败项留清单并在后续降级为摘要级或低置信前作，而不是从分母删除
  - M0.3 前两轮全文获取未过线根因 = 解析源和 baseline denominator 不稳定 # v4 通过多来源解析并保留 attempted_failed，避免静默缩小分母
- CaseStudy:
  - case 1: M0.3 attempt 1 = 98/1745 = 5.62% → 不能用低覆盖全文前作支撑残差。
  - case 2: M0.3 v4 = 442/724 = 61.05% → 过线，同时 failure list 留档。
  - case 3: `ACL2017:18` has_methods_text=False but has_intro/related/conclusion=True → 方法内容可能在非 method 标题区域，保守规则不强行猜。
  - case 4: `ACL2017:489` 句子 “A significant novelty might be...” 标为 other → 句子提到 novelty，但不是明确 praise/criticize/missing-citation。
  - case 5: baseline failure `ACL2017:108` CRF baseline → OpenAlex 找到 OA URL，但 PDF 抓取 `oa_pdf_error_ProxyError`，所以记录 attempted_failed。
- NextIdea: 若要提高 M0 质量，应新增子节点分别诊断 section heading 规则扩展和 baseline 全文增量解析；不能把失败项从分母删除，也不能用不可复现爬取结果替代审计来源。
- SelectedSkills: agents:literature-review, agents:citation-management

## N2b - M1 Idea Graph 抽取与 HC-1

- Position: 2290,1571
- Size: 520,560
- Completion: 已完成
- Problem: novelty 残差不能直接算在原文字符串上，必须先把论文贡献拆成可定位、可映射、可加权的 idea graph 零件。
- Approach: `extract_ideagraph.py` 用 `extract_prompt_v1` 系列从论文文本抽取中心贡献、方法、机制、任务、目标等结构；中心层先找贡献声明，找不到再用标题/摘要/引言末/结论多数票；泛指词防线禁止把“the proposed method”当中心方法。
- Input:
  - unified corpus = 564 papers # M0 输出的 PeerRead 统一论文
  - extraction source regions = title + abstract + intro + methods_text + related_work_text + conclusion_text # idea graph 可用文本区域
  - prompt cache key includes prompt version # 同输入同 prompt 可复现
  - HC-1 blind sample = 100 papers # 中心贡献信度检查样本
- Output:
  - graph files = 564/564 with prompt v1.2 at HC-1 repair time # 全语料 idea graph 抽取完成
  - central method per graph = exactly 1 # 修复后每图一个中心方法
  - generic central violations = 0 # 泛指词防线通过
  - HC-1 v2.1 weighted alpha = 0.8897 # >=0.80，通过
  - center_ambiguous = 34/100 = 0.34 # 只报告，不作失败阈值
- Metrics: HC-1 不是让 LLM 判“像不像”，而是管道和独立模型评分者分别输出结构化中心贡献；确定性脚本按 evidence_anchor、alias、name_containment、cross_evidence_contains、primary_secondary_swap 等规则给一致/半一致/不一致，再算带权 Krippendorff alpha。
- Notes: idea graph 是论文想法的结构化表示，一张图里零件之后会变成 S_x 的候选残差项。M1 的风险是抽得太泛或中心贡献选错，所以 HC-1 盯的是中心层可靠性。
- CurrentResult: M1 通过 HC-1 v2.1：weighted alpha 0.8897，高于 0.80；BLOCKED-M1-HC1-V2 已由该结果关闭。
- RootCauseAnalysis: 早期 HC-1 失败不是单纯抽取坏，而是自由文本表面不一致混淆了同一证据句、别名和主次贡献互换；v2.1 用确定性证据规则修正了测量口径。
- CaseStudy:
  - case 1: HC-1 v1.2 alpha = 0.3353 → 自由文本中心名一致性不可用。
  - case 2: HC-1 v2.1 alpha = 0.8897 → 证据锚点和论文内别名能解释大部分表面差异。
- NextIdea: 下游读取 idea graph 时必须保留 node_text、role_slot、facet 候选和 evidence，不能只保留一个总方法名。
- SelectedSkills:

## N2c - M2 分面森林、map_node 与 HC-2/HC-3

- Position: 2137,3028
- Size: 520,600
- Completion: 已完成
- Problem: idea graph 零件如果只停在自然语言字符串，无法跨论文比较；M2 把每个零件落到四棵分面树的可审计坐标上。
- Approach: 建四棵 facet tree：method_architecture、mechanism_operation、task_problem、objective_criterion；每层设 `_unknown_` 桶；`map_node.py` 从根逐层下降，候选子节点可复现洗牌，允许 STOP_HERE、UNKNOWN_HERE、UNDECIDABLE。
- Input:
  - facets = method_architecture / mechanism_operation / task_problem / objective_criterion # 四类树坐标
  - tree node schema = {id, name, aliases[], parent, definition_one_line} # 每个本体节点字段
  - mapping reliability sample = 300 nodes # facet x head/tail 分层双扰动
  - HC-2 blind sample = 100 nodes # 独立模型映射对照
- Output:
  - forest v0.1.0 HC-3 = human re-review passed # 顶部两层人工审核冻结
  - mapper reliability v0.1.0 weighted alpha = 0.8518 # 300 节点双扰动，>=0.80
  - position change rate = 0.0467 # <0.10，选项顺序偏差通过
  - HC-2 v0.1.0 weighted alpha = 0.9617 # GPT-5.5 blind rater，>=0.80
  - later live forest = v0.9.0 # 经后续 HC-5/结构迁移/独立模型闸门后成为当前树版本
- Metrics: M2 双扰动 alpha 比较同一节点在文本改写和候选顺序变化后的坐标稳定性；HC-2 比较管道 mapper 与独立模型评分者的盲评映射坐标，距离越近惩罚越小；HC-3 是真人审核树顶部两层是否合理，不用 alpha。
- Notes: `_unknown_` 是真实树坐标，不是丢弃项；最新用户裁决后，主覆盖也把 unknown bucket 当普通节点计算，但仍必须报告 bucket-level audit。
- CurrentResult: M2 的原始硬闸已通过，当前有效森林经后续治理为 v0.9.0；后续任何树增长都必须版本化并重建相关索引/统计。
- RootCauseAnalysis: 初版树曾出现把 observed center 原始字符串直接灌成叶子的自证风险，后来改为 unknown_pending 和 HC-5/attestation 治理，避免用开发语料字符串污染本体。
- CaseStudy:
  - case 1: v0.1.0 通过 HC-3，但 leaf hit rate 很低 → M3 必须监控 Unknown 放大。
  - case 2: v0.9.0 迁移 1024 个错挂坐标并重算索引 → 树坐标变动必须同步到 corpus_index 与 rarity_stats。
- NextIdea: 解释任何下游分数时都要写 tree_version；同一个 path 在不同版本下不能混用。
- SelectedSkills:

## N2d - M3 语料图索引与 rarity_stats

- Position: 2767,3004
- Size: 560,620
- Completion: 已完成
- Problem: 结构残差要问“目标零件是否能被可信前作池联合解释”，所以需要一个可查询的语料坐标索引和一份坐标/坐标对的历史频率统计。
- Approach: 清洗 S2 no_match 缓存污染；解析参考文献摘要；对目标语料和参考文献摘要抽取摘要级 idea graph；对去重节点运行 map_node；把每个坐标及其路径前缀写入 `corpus_index.sqlite`；按论文内部坐标共现写 `rarity_stats.json`。
- Input:
  - reference abstract resolution = 0.6093 # 参考文献摘要解析率，>=0.60 后才继续
  - mapped corpus scope = target papers + resolved references # M3 索引范围
  - tree version = v0.9.0 # 当前 live forest 版本
  - admitted nodes only # admission 过滤后才进入 map/index/rarity
- Output:
  - corpus_index rows rewritten at v0.9.0 relocation = 4116 # 旧坐标迁移到新坐标并重建 postings
  - rarity_stats docs = 6105 # v0.9.0 重算统计窗口论文数
  - rarity_stats coordinates = 858 # v0.9.0 坐标数
  - rarity_stats coordinate_pairs = 18851 # v0.9.0 坐标对数
  - M3 effective unknown = method 45.0%, mechanism 0.3%, task 9.0%, objective 4.0% # 四个 facet 均 <50%
- Metrics: 参考文献摘要解析率 = resolved unique reference titles / all unique reference titles；Unknown 率按 facet 统计 mapped/admitted 节点中落到 `_unknown_` 的比例，任一 facet >50% 触发 BLOCKED；corpus_index 抽查坐标能返回论文列表；rarity_stats 必须记录统计窗口和语料规模。
- Notes: corpus_index 是倒排表：给一个树坐标或路径前缀，查哪些论文有这个坐标。rarity_stats 是频率表：给坐标或坐标对，查它在语料窗口里常见还是少见。二者都不是 novelty 判断本身，只给确定性召回、权重和组合罕见度提供输入。
- CurrentResult: M3 已在 v0.9.0 上通过 Unknown 红线并重建索引/稀有度；当前可以为前作池、w_i 和 N_comb 提供可审计输入。
- RootCauseAnalysis: M3 最初被 method/task Unknown 卡住，根因有两类：树叶覆盖不足和 admission 把非概念噪音放进分母。后续通过 admission 收紧、HC-5 增长、mapper 描述、v0.9.0 坐标迁移解决。
- CaseStudy:
  - case 1: reference abstract gate 0.5373 <0.60 → M3 暂停并写 BLOCKED。
  - case 2: reference abstract gate 0.6093 >=0.60 → 允许进入真实 mapping/index。
  - case 3: v0.9.0 Unknown 全 facet <0.50 → M3 红线关闭，但不代表 M4/M5 novelty 效度自动成立。
- NextIdea: 下游使用 rarity_stats 时必须报告统计窗口、n_docs、坐标版本和 bucket-level unknown 标记。
- SelectedSkills:

## N3 - M4/M5 结构残差公式实现与诊断

- Position: 5848,2220
- Size: 460,520
- Completion: 已诊断，未冻结
- Problem: FINAL-PLAN 的原始结构残差公式已可运行，但在当前开发集上没有形成可冻结的新颖性效度证据；需要把它当作总系统的核心基线和诊断资产，而不是简单丢弃。
- Approach: 已实现 align.py/residual.py、精确覆盖、unknown 主口径与 unknown-exclude 变体；用 part audit 检查覆盖与 residual。对应 FINAL-PLAN 原始公式族：A=多前作联合解释后的分面结构残差；B=同族部分计分/树距离折扣；C=组合罕见度项。
- Input:
  - 宽覆盖口径 = d_cov<=2 # 已证明失败
  - 精确覆盖口径 = d_cov=0 # 恢复 N 的区分度但效度未稳
  - 标签 = originality / clarity / substance # 只用于效度分析，不用于调公式
  - 前作池 = L1-L4 联合候选 # 覆盖搜索空间
- Output:
  - 宽覆盖结果 = 2/4576 residual # N 近常数，失败
  - 原始公式恢复结果 = β=0 # 组合罕见度未改善最终信号
  - 当前结论 = 结构残差实现是重要基线和审计资产，但不能冻结为成功方法 # 负结果保留
- Metrics: 宽覆盖 N 近常数；精确覆盖 N 不退化但 head/total 覆盖和效度问题暴露；多轮恢复原始公式/组合罕见度仍未形成可靠 originality 信号。
- Notes: 当前不能把该路线冻结为最终公式，但它仍是 FINAL-PLAN 的主干实现和解释报告基础。typed-edge 只能作为“覆盖单位/组合关系”修正候选，不能替代整个系统层次。
- CurrentResult: 原始公式已探索并多次负结果；当前不应继续在 residual.py 上无约束调参，但应保留其审计、覆盖和分面输出能力。
- RootCauseAnalysis: 节点/零件级覆盖过于粗糙，要么 family/intermediate 坐标把所有东西覆盖掉，要么 exact 坐标导致 head evidence 稀疏。N 容易退化为结构丰富度、unknown 数量或无效常数。
- CaseStudy:
  - case 1: coverage distance<=2 → 2/4576 residual，N 近常数。
  - case 2: exact distance=0 → N 有区分度，但覆盖门和效度仍不稳。
  - case 3: 公式 A: `N_struct = Σ role_weight × residual_factor × rarity_weight`，其中 `residual_factor=1-coverage_score`，partial coverage 会给 0 到 1 之间的小数残差；unknown bucket 在主覆盖中按普通坐标算 coverage，未被覆盖时才按具体角色留下残差。
  - case 4: 公式 B: `residual_factor(d)=0 if d=0; p_partial if 同族且 d>=1; 1.0 if 无同族前作`，补回后边际仍≈0。
  - case 5: 公式 C: `N_comb = -log P(分支对共现)`，`N_final=(1-β)N_struct+βN_comb`；全参调优最优 β=0，说明组合项没有救回 originality 信号。
- NextIdea: 不用 originality 结果反调残差定义；若 typed-edge 或树增长验证有效，应回到总残差框架里决定它是替换覆盖单位、增加关系项，还是仅作为诊断附录。
- SelectedSkills:

## N3a - 原始公式 ABC 与前作池公式索引

- Position: 6684,993
- Size: 520,500
- Completion: 已记录
- Problem: 项目早期的公式被散落在 FINAL-PLAN、RUNBOOK 和 PROGRESS 中；若任务树只写“残差失败”，后续代理会误以为原始方法只是简单节点覆盖。
- Approach: 把公式作为索引节点保留，不再作为当前冻结候选。A=结构残差，B=部分计分/同族树距离，C=组合罕见度；前作池准入是确定性召回公式，不是 novelty 判断。
- Input:
  - A = N_struct # 多前作联合解释后的结构残差
  - B = N_partial # 同族部分计分/树距离折扣
  - C = N_comb # 分支对共现罕见度
  - admission = shared_references >= k OR core_role_branch_distance <= d # 前作池准入
- Output:
  - A 当前结论 = 可运行但效度未稳 # 主基线
  - B 当前结论 = 边际≈0 # 不能当成功项
  - C 当前结论 = β=0 # 理论保留，未改善
  - 用途 = limitations 和 PROTOCOL 的公式索引 # 不再无约束调参
- Metrics: 所有公式都能展开到角色、坐标、前作、树距离或历史共现频率；不使用 embedding 或 LLM 相似性。
- Notes: 前作池准入公式：`admission(candidate,target) = shared_references >= k OR core_role_branch_distance <= d`。M4 v1.4 后漏引召回仅作诊断，零件级覆盖/可审计残差才是硬口径。
- CurrentResult: 原始 ABC 已被补回并试验，结果仍为负；保留为被证伪但重要的理论基线。
- RootCauseAnalysis: 负结果不是因为少了组合项或部分计分，而是因为节点/零件级覆盖和坐标分辨率不足，不能稳定表达“已知部件的新组合”。
- CaseStudy:
  - A 结构残差: 每个目标零件若被前作池同坐标覆盖则解释，否则进入残差；输出按 task/method/mechanism/objective 分面。
  - B 部分计分: 同族但非同坐标的前作给 p_partial 折扣，试图表达“接近但不完全相同”的已知前作。
  - C 组合罕见度: 用历史语料中分支对共现概率的负对数衡量非典型组合，作为 `N_final` 的可调混合项。
- NextIdea: 不再从 ABC 上找新调参；若重启该路线，必须先证明覆盖单位问题已解决。
- SelectedSkills:

## N4 - Typed Relation Graph 覆盖单位探索

- Position: 5326,3244
- Size: 500,560
- Completion: 进行中
- Problem: 原始节点/零件袋覆盖可能测不到“已知部件的新组合”；typed relation triple/edge 是对覆盖单位的候选修正，不是整个项目的唯一公式。
- Approach: 用 problem-method、method-role、method-mechanism、mechanism-effect 等 typed edges；覆盖单位从“节点袋”升级为“带类型关系三元组/边”。`edge_cov = slot_close(A_t,A_p) × slot_close(B_t,B_p)`，乘积要求同一篇前作同时拥有两个端点；Far 与 Near 双通道，Near 表示近成熟前作但机制替换。
- Input:
  - typed edges = problem-method / method-role / method-mechanism / mechanism-effect # 固定关系类型
  - edge_cov = slot_close(A_t,A_p) × slot_close(B_t,B_p) # 同一 prior 必须同时覆盖两个端点
  - 开发样本 = 全 dev n=86 # typed-edge 探索集合
- Output:
  - Near in-sample ρ ≈ +0.21 # 有理论方向
  - 非生成子集 in-sample ρ ≈ +0.28 # 局部有信号
  - 全 dev LOO-CV ρ ≈ -0.43 # 不泛化，不能冻结
  - 可观测性 = 44/86 篇 0 条可观测边，22/86 篇 >=2 条边 # 主要瓶颈
- Metrics: 全 dev n=86：Near in-sample ρ≈+0.21，非生成子集 in-sample ρ≈+0.28；但 LOO-CV 全集 ρ≈-0.43，不泛化。信号随可观测边数上升。
- Notes: 理论方向有支持，但模型不可冻结。主要瓶颈是 edge observability：86 篇里 44 篇 0 条可观测边，仅 22 篇 >=2 条边。
- CurrentResult: typed-edge 在理论上更贴近组合新颖性，但全开发集不泛化；它是当前重点诊断分支，不是已选最终路线。
- RootCauseAnalysis: 边要求两个端点都映射到非 unknown 细坐标；非生成域树覆盖偏斜导致 target/prior 双侧大量 unknown，C 出现大量并列和过拟合。
- CaseStudy:
  - case 1: 图 schema: `problem --solved_by--> method`, `method --plays_role--> role`, `method --works_by--> mechanism`, `mechanism --enables--> effect`, `method --differs_from--> prior_difference`。
  - case 2: 双通道公式: `FarNovelty = 1 - max_prior mean(edge_cov over observed edges)`；`MechanismSubstitutionCost = 1 - mean(edge_cov over mechanism edges)`；`NearMechReplacement = max_prior(ContextCloseness × MechanismSubstitutionCost)`；`C = α·Far + (1-α)·Near`。
  - case 3: 节点袋全 dev C-LOO ≈0.071；edge 重写让 Near 方向出现，但 LOO 负。
  - case 4: 生成域 n=26 曾有 C-LOO ≈0.485；扩到全 dev n=86 后崩为 null，说明域泛化失败。
  - case 5: asym target-known/prior-unknown 指标无效，因为真新颖概念常在 target 侧也 unknown。
- NextIdea: 先验证 edge observability 是否真是瓶颈；若验证失败，回到 FINAL-PLAN 总框架考虑其他残差/前作池/金标解释，而不是继续改 Far/Near。
- SelectedSkills:

## N4a - 想法图与关系层资产

- Position: 5995,2830
- Size: 500,520
- Completion: 进行中
- Problem: typed-edge 路线依赖的是图结构本身；如果任务树只写“公式”，会遗漏抽取层和边标签层。
- Approach: 明确图层资产：M1 四层 idea graph 用于中心/方法/机制/效果；`idea_relation_layer1.py` 产生 typed relation graph；端点经 `map_node` 到四棵分面树；边覆盖报告必须能回溯到端点文本、端点坐标、边类型和覆盖前作。
- Input:
  - 图槽位 = problem / method / role / mechanism / effect / prior_difference # typed-edge 端点来源
  - 边 schema = solved_by / plays_role / works_by / enables / differs_from # 关系层结构
  - 端点映射 = 每个端点仍落到四棵 facet tree # 不新增第五棵树
- Output:
  - audit 最小字段 = edge_type + target endpoints + mapped coordinates + prior edge + edge_cov + unknown reason # 人能读懂边覆盖
  - 当前结论 = 图边层已实现，但端点 unknown 导致 edge observability 不足 # 输入层瓶颈
- Metrics: 每条边至少包含 edge_type、target endpoints、mapped coordinates、prior edge、edge_cov、是否 bucket-level unknown 覆盖、是否因端点缺失/未映射不可比。
- Notes: 图路线不是第五棵树，不新增 data/representation/paradigm/evaluation 树；所有端点仍落到现有四棵 facet tree。
- CurrentResult: 图边层已实现并记录探索性结果，但 edge observability 不足。
- RootCauseAnalysis: 图层与树层粒度不一致曾导致 family collapse；atom_mode=False 修复过生成域信号，但全 dev 仍被 unknown 端点限制。
- CaseStudy:
  - case 1: “已知部件的新组合”必须由同一条边或同一篇前作中的端点组合判断，节点袋不能表达。
  - case 2: PATE/Match-LSTM 这类 case 的失败不是没有图，而是图端点在 target/prior 双侧没有细坐标。
- NextIdea: N6 先做 6 篇 case 的 unknown endpoint 临时补坐标，验证图边可观测性是否改善。
- SelectedSkills:

## N5 - 当前诊断瓶颈：坐标覆盖与可观测性

- Position: 9166,1341
- Size: 480,560
- Completion: 进行中
- Problem: 当前多条路线都暴露出同一类风险：坐标粒度、unknown、前作池和图端点可观测性会决定残差是否可解释。typed-edge 全集不泛化只是这个风险的一种表现。
- Approach: 用 case study 区分召回问题、前作池问题、target/prior 双侧 unknown 问题、以及公式覆盖单位问题；只增长概念纯叶，禁止粗语义聚类制造伪同坐标。工程修复 A/B/C 保留为工具箱：A=书目耦合加载目标和候选 refsets，B=Unknown 桶语义聚类后提议概念纯中层/叶，C=mapper gloss/lookahead/管理桶隐藏以提高下降能力。
- Input:
  - 关键现象 = target/prior 双侧核心概念经常 unknown # edge 与 residual 都受影响
  - 反例风险 = atom_mode=True 会降低 unknown 但造成 L1 家族塌缩 # 低 unknown 不等于好
  - 6 篇高 originality case = 多数是已知部件新组合 # 不是单纯召回缺失
- Output:
  - 当前根因假设 = 坐标覆盖不足 + 前作池/图抽取需区分诊断 # 不能预设唯一原因
  - 修复方向 A = 书目耦合补召回 # 解决前作池缺口
  - 修复方向 B = Unknown 语义聚类后策展转正 # 解决树缺口
  - 修复方向 C = mapper gloss/lookahead # 解决下降不足，不参与检索匹配
- Metrics: 不只看 typed-edge：同时看 target/prior 核心概念坐标覆盖、零件覆盖审计、可观测 typed edge 数、解释报告可读性和 LOO/区分效度；不能以牺牲概念纯度换指标。
- Notes: 2026-06-18 诊断显示：6 篇 orig=5.0 的真新颖大多是已知部件新组合，前作池里有部件，问题是双侧 unknown，而不是召回完全缺失。
- CurrentResult: 当前最具体的可执行瓶颈是：非生成域 target/prior 核心概念坐标覆盖不足，使残差或边覆盖无法稳定解释人类 originality；但这仍是总系统的一个诊断假设，需小规模验证。
- RootCauseAnalysis: atom_mode=True 会假装低 unknown 但造成 L1 家族塌缩；atom_mode=False 诚实落 unknown 保住分辨率。当前证据支持“坐标覆盖不足”是重要问题，但不能把它预设为唯一根因；还需区分 gold 噪声、前作池宇宙缺口、图抽取错误和公式覆盖单位问题。
- CaseStudy:
  - case 1: PATE=差分隐私+蒸馏，前作池有部件，但 target/prior 都 unknown。
  - case 2: Match-LSTM+Pointer，前作池有 CopyNet/Attention Sum Reader，组合边观测不到。
  - case 3: 粗聚类长 37 叶让 C-LOO 变负，说明“同主题合并”会制造假匹配。
  - case 4: 修复 A 书目耦合是召回轴：`target_refset ∩ candidate_refset >= k` 才能让同一学术对话的前作进入池，但它不解决无坐标。
  - case 5: 修复 B 树生长是坐标轴：Unknown 先按父桶/语义聚类提出概念纯节点，经 HC-5/授权审核后版本化入树；不能把粗主题桶当叶。
  - case 6: 修复 C mapper 是下降轴：gloss/lookahead/隐藏管理桶只帮助 text→coordinate，不参与检索匹配；它修“敢不敢下降”，不修“树里有没有叶”。
- NextIdea: 对少量高价值 case 做临时核心坐标补充，观察零件残差审计和 typed-edge 审计是否同时变得更合理；验证通过后才考虑正式 HC-5 树增长。
- SelectedSkills:

## N7a - 评估轨道 A/B 与确认防火墙

- Position: 7418,210
- Size: 500,500
- Completion: 未开始
- Problem: 项目最终不是只要一个探索性相关；必须区分理论效度轨道和工程性能轨道，并在预注册后才产出正式结果。
- Approach: 轨道 A=测量效度，检查分面残差/边分数与 originality 的收敛效度、与 clarity/substance 的区分效度、控制 word count/graph size 后的偏相关；轨道 B=工程性能，对打 LLM 直接打分、fine-tuned SciBERT、embedding-NN novelty、BM25 novelty，统一 CV。
- Input:
  - Track A = 测量效度 # 看 originality 收敛效度和 clarity/substance 区分效度
  - Track B = 工程性能对打 # 对比 LLM 直接打分、SciBERT、embedding-NN、BM25 等
  - 当前前提 = PROTOCOL_V2 未冻结 # 不能启动正式评估
- Output:
  - 当前结论 = 评估轨道未开始 # 因为公式和审计口径未冻结
  - 必报结果 = originality / clarity / substance / 偏相关 # 防止测到 clarity/substance
  - 确认集规则 = tag confirmatory-freeze 后只跑一次 # 防火墙
- Metrics: Track A 成功线按预注册；Track B 用重复嵌套 CV 和跨 venue 盲测；所有结果同时报告 originality/clarity/substance。
- Notes: 这里的 A/B 是评估轨道，不等于 N3a 的公式 A/B/C，也不等于 N5 的工程修复 A/B/C。
- CurrentResult: 还不能启动；typed-edge 和树覆盖瓶颈未收口，PROTOCOL_V2 未冻结。
- RootCauseAnalysis: 之前已有探索性 Track A 负结果，但 commit 前结果不能当确认性证据；不能用这些结果反调协议。
- CaseStudy:
  - case 1: residual v0.9.0 探索性 Track A 得到 N 与 originality 近 0，证明旧 N 不测新颖性。
  - case 2: typed-edge Near 有方向但 LOO 不泛化，说明还未达到冻结要求。
- NextIdea: N6/N5 收口后再进入 PROTOCOL_V2 和轨道 A/B。
- SelectedSkills:

## N6 - 最小验证：临时核心坐标补充是否改善解释

- Position: 4720,1970
- Size: 460,520
- Completion: 未开始
- Problem: 在投入全量树增长或重写公式前，先验证“补足少量核心概念坐标”是否能让总系统的解释变好：目标零件残差更可审计、前作覆盖更合理、typed-edge 更可观测。
- Approach: 选 6 篇 high-originality case 及其前作池；只对核心 unknown 部件创建临时坐标映射表，不改 forest v0.9.0；同时检查零件级覆盖/残差审计和 typed-edge coverage，而不是只看 Far/Near 数值。
- Input:
  - case 数 = 6 篇 high-originality 论文 # 小规模诊断，不是正式评估
  - 临时坐标 = 只给核心 unknown 部件补映射 # 不改 forest v0.9.0
  - 对照对象 = 补坐标前后的 part residual 与 edge_cov # 看解释是否变好
- Output:
  - before/after part audit # 哪些零件从未覆盖变为可解释，或仍为残差
  - before/after edge audit # n_obs_edges 和 edge_cov 是否改善
  - 决策 = 值得 HC-5 树增长 / 不值得 / 需要回到前作池或抽取问题 # 下一步分叉
- Metrics: 每个 case 必须能解释“哪些目标零件/边因补坐标变得可审计、被哪些前作覆盖或仍为残差”；不能只看 originality ρ。若 case-level 解释不成立，则停止全量长树并回到总框架重新诊断。
- Notes: 这是探索性验证，不是树版本升级；不得写入正式 forest，不得触碰确认集。
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea: 先生成 6 篇 case 的 target/prior unknown endpoint 和 residual part 清单，选择少量核心概念做临时坐标表，再比较补充前后的解释报告。
- SelectedSkills:

## N7 - PROTOCOL_V2 冻结与正式评估

- Position: 7660,2476
- Size: 460,520
- Completion: 未开始
- Problem: 只有当最终结构指标定义清楚、审计链完整，并且不会被当前探索结果反向调参后，才能进入冻结、M6/M7 和确认集。
- Approach: 基于 FINAL-PLAN 生成 PROTOCOL_V2.md，明确最终公式、权重/训练方案、覆盖语义、解释报告、Track A/B 分析计划；commit hash 写入 PROGRESS；再跑 M6 Track A、M7 baseline 对打；最后 tag confirmatory-freeze 后跑 M8 一次。
- Input:
  - 前提 1 = N_final 定义已定 # 公式不能再靠结果反调
  - 前提 2 = 审计量已定 # 每个分数能展开
  - 前提 3 = HC-4/相关审核完成 # 权重与口径可冻结
- Output:
  - PROTOCOL_V2 commit hash # 必须早于 M6/M7 结果
  - M6/M7 正式报告 # 同时报告 originality/clarity/substance
  - confirmatory-freeze tag # M8 前打 tag
  - M8 一次性结果 # 跑完后不能改方法再跑
- Metrics: 相关分析完整报告 originality/clarity/substance/偏相关；轨道 B 用统一 CV；确认集未重跑。
- Notes: 当前不得进入此节点。已有探索性相关结果不能倒灌为预注册结果；typed-edge 若要并入最终公式，必须在协议中明确其角色和审计单位。
- CurrentResult:
- RootCauseAnalysis:
- CaseStudy:
- NextIdea: 等 N6 或后续诊断说明最终指标该如何定义后，再起草 PROTOCOL_V2；如果所有路线均负，也应冻结“负结果评估协议”并完整报告。
- SelectedSkills:

## N8 - 公式定义、变量与理论支撑

- Position: 8062,1534
- Size: 845,901
- Completion: 已记录，待冻结
- Problem: 项目的核心公式散落在 FINAL-PLAN、residual.py、idea_dual_channel_edge.py、PROGRESS 和 ITERATION_LOG 中；如果不集中定义，后续容易把“某次实现变体”误当成最终方法。
- Approach: 该节点作为公式总索引，不再承载全部解释。主线是结构残差 N：目标论文 x 的想法图零件 P_x 中，哪些具体零件不能被可信前作池 Π_x 覆盖。探索分支是 typed-edge 双通道 C：把覆盖单位从单个节点升级为带类型关系边。当前已知结论是：N 的宽覆盖口径曾退化为近常数；typed-edge 理论方向有意义但边可观测性不足，不能作为冻结公式。该节点只定义公式与变量来源，不改变 GOAL、阈值、gold 或确认集纪律。
- Input:
  - 新颖性 = 无法被可信前作池联合解释的带权结构残差 # 项目根定义
  - 当前主公式 = N_final；当前实证退回 N_struct，因为 β=0 # 最终分数节点的当前状态
  - typed-edge C = 探索分支，不能冻结 # 全 dev LOO 为负，主要受边可观测性限制
  - 宽覆盖 d_cov<=2 的失败结果 = 2/4576 residual # 说明祖先/兄弟覆盖会让 N 近常数
  - typed-edge 可观测性失败结果 = 44/86 篇 0 条可观测边 # 说明 C 的主要瓶颈是输入不可见
- Output:
  - N8h = 最终新颖性公式节点 # 总节点只连到这里，不再散连所有公式
  - N8a-N8l = 公式变量拆解节点 # 每个节点解释一个变量或计算步骤
  - 当前结论 = 公式体系已整理，但尚未冻结 PROTOCOL_V2 # 仍需逐节点校对和 HC-4/预注册
- Metrics: 公式中每一项都能追溯到目标论文零件/边、树坐标、前作池来源、覆盖前作、树距离、rarity_stats 或引用关系；无 LLM novelty/相似性判断；无 embedding 决策。
- Notes: N8 是总节点；细节见 N8a-N8k。结构残差 N 是 FINAL-PLAN 主输出；typed-edge C 是覆盖单位探索，只有在解释链和可观测性问题解决后才考虑并入最终公式。
- CurrentResult:
  - $P_x = \{i: i=(t_i,r_i,f_i,c_i,path_i,termination_i)\}$
  - $\Pi_x = L1_x \cup L2_x \cup L3_x \cup L4_x$
  - $admit(x,p)=\mathbf{1}[shared\_references(x,p) \ge k \lor core\_role\_branch\_distance(x,p) \le d]$
  - $w_i = role\_weight(r_i) \times rarity\_weight(c_i) \times unknown\_discount(i)$
  - $rarity\_weight(c_i)=0.5+rarity(c_i)$
  - $tree\_distance(path_i,path_j)=|path_i|-|LCA|+|path_j|-|LCA|$
  - $cover(i,p)=\mathbf{1}[f_i=f_j \land tree\_distance(path_i,path_j) \le d_{cov}]$
  - $residual_i=1-\max_{p\in\Pi_x} cover(i,p)$
  - $N_{struct}(x)=\frac{\sum_{i\in S_x} w_i residual_i}{\sum_{i\in S_x} w_i}$
  - $N_{partial}(x)=\frac{\sum_{i\in S_x} w_i residual\_factor_i}{\sum_{i\in S_x} w_i}$
  - $N_{comb}(x)=mean_{(a,b)\in pairs(B_x)}[-\log P(a,b)]$
  - $N_{final}(x)=(1-\beta)N_{struct,norm}(x)+\beta N_{comb,norm}(x)$
  - $edge\_cov(e,p)=slot\_close(A_x,A_p)\times slot\_close(B_x,B_p)$
  - $slot\_close(A,B)=\gamma^{tree\_distance(A,B)}$
  - $FarNovelty(x)=1-\max_{p\in\Pi_x} mean(edge\_cov(e,p))$
  - $NearMechReplacement(x)=\max_{p\in\Pi_x}[ContextCloseness(x,p)\times MechanismSubstitutionCost(x,p)]$
  - $C(x)=\alpha FarNovelty(x)+(1-\alpha)NearMechReplacement(x)$
- RootCauseAnalysis: 公式混乱的根因是历史上先实现了简化残差，再补回部分计分和组合罕见度，又并行探索 typed-edge；没有一个节点集中说明变量来源和构念含义，导致“公式失败”“树失败”“图失败”容易混成一件事。
- CaseStudy:
  - case 1: d_cov<=2 时 residual 只有 2/4576 → 公式技术上覆盖高，但 N 近常数，说明祖先/兄弟覆盖不能等同解释。
  - case 2: N_final 补回组合罕见度后 β=0 → 负结果不是因为少了 Fleming/Uzzi 项，而是结构覆盖本身缺动态范围。
  - case 3: edge_cov 用乘积后能表达“同一前作同时拥有两端”，但 44/86 篇 0 条可观测边 → 公式依赖坐标覆盖。
- NextIdea: 先重新稳固公式，不要继续推进其他的内容，并且我们的知识的树是否可以用已有的树，或者开源的知识图谱尝试一下，会不会减少所谓的unknown的问题，并且重新审视我们的公式是否被完全执行了，先解释公式，各个公式或计算方式都可以产生一个新的节点来专注于每一步公式的改进。每一个公式至少都要有“投入什么输出什么，有什么现实意义，每一个公式里面的变量有什么现实意义，这个公式的依据是什么“这些内容。
- SelectedSkills: agents:literature-review, agents:grill-with-docs

## N8a - 零件、角色、facet、termination_level

- Position: 3491,2922
- Size: 707,723
- Completion: 已完成
- Problem: 需要明确“零件”到底是什么，以及 role_slot、facet、termination_level 是从哪里来的。
- Approach: 零件是目标论文想法图或语料论文想法图中的一个结构化节点，不是任意词语。M1 抽取器从论文文本中抽 central_methods、method_objects、mechanism_operations 等字段；M3 将这些字段转成 mapped_nodes 表中的行；map_node 把每行 node_text 映射到四棵树之一，产生 facet、mapped_node_id、path_json、termination_level。role_slot 来自抽取字段或派生规则，例如 central_methods 变成 central_method，效率目标派生变成 derived_efficiency_goal。facet 是映射目标树：task_problem、method_architecture、mechanism_operation、objective_criterion。termination_level 表示映射停在树的哪一层：leaf/intermediate/family/_unknown_ 等。
- Input:
  - node_text = "Multi-Prototype Mention Embedding" # 一个零件的文本内容
  - role_slot = "central_method" # 这个零件来自中心方法字段
  - facet = "method_architecture" # 这个零件被映射到方法/架构树
  - target_coordinate = "method_architecture::<具体节点>" # 这个零件在树上的坐标，具体 ID 由 map_node 产出
  - termination_level = "leaf" 或 "intermediate" 或 "family" 或 "_unknown_" # 映射停在叶子、中间层、家族层或 unknown
- Output:
  - part i = (t_i, r_i, f_i, c_i, path_i, termination_i) # 公式里一个可审计零件的完整形式
  - P_x = 目标论文 x 的全部零件集合 # N_struct 的候选分母来源
  - 结论 = 零件不是任意词，而是抽取字段经过树映射后的结构化节点 # 后续所有分数都必须能展开到这些字段
- Metrics: 随机抽样时，每个 part_node_id 都能回溯到原文 evidence 或抽取字段；facet 必须属于四棵树；role_slot 必须来自抽取 schema 或明确派生规则。
- Notes: 这里的“零件”不是由 LLM 判断新颖性得出，LLM 只负责文本到结构字段和单节点到树坐标。
- CurrentResult:
  - $i=(t_i,r_i,f_i,c_i,path_i,termination_i)$
  - $P_x=\{i: paper\_id(i)=x\}$
- RootCauseAnalysis: 用户困惑的根因是“零件”同时经历了抽取、派生、映射、索引四步；如果只看最终公式，会误以为零件是公式凭空定义的变量。
- CaseStudy:
  - case 1: central_methods.name="Multi-Prototype Mention Embedding" → role_slot=central_method → facet=method_architecture → 进入残差主分母。
  - case 2: 文本含 quantization/pruning 等效率信号 → 派生 role_slot=derived_efficiency_goal → facet=task_problem → additive 加入，不删除原 method/mechanism 零件。
- NextIdea:
- SelectedSkills:

## N8b - 前作池与准入公式

- Position: 3852,1400
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明前作 Π_x 是怎么找到的，L1/L2/L3/L4、source_layers、shared_references、k、d 分别是什么。
- Approach: 前作池不是“相似论文全集”，而是可审计候选集合。L1 是实验区或基线解析出的 direct baseline；L2 是作者 related work/reference 中显式引用的论文；L3 是语料图索引按树坐标召回的候选；L4 是引用图邻居和书目耦合候选。source_layers 是候选命中的层，可以同时有多个层，合并为集合。shared_references(x,p) 是目标论文和候选论文参考文献集合的交集大小。core_role_branch_distance(x,p) 是中心角色坐标在同 facet 树上的分支距离。k 和 d 是开发集校准得到的工程阈值，不是理论常数；历史上 M4 v1.4 后漏引召回只作为诊断，不再作为硬门。
- Input:
  - L1 = direct baseline # 实验区或 baseline 解析得到的前作
  - L2 = related-work/reference # 作者显式引用的相关工作
  - L3 = coordinate retrieval # 用目标零件坐标从语料索引召回候选
  - L4 = citation-neighbor / bibliographic coupling # 引用图邻居或共享参考文献候选
  - source_layers = ["L2_related_work","bibliographic_coupling"] # 同一篇 prior 可同时来自多层
  - shared_references(x,p) = 目标和候选共享参考文献数量 # 书目耦合准入变量
- Output:
  - Π_x = L1 ∪ L2 ∪ L3 ∪ L4 # 目标论文 x 的可信前作池
  - admit(x,p)=1 表示候选 p 可进入 Π_x # 满足共享引用或核心分支距离门槛
  - covered_by = 某篇 prior 的 ID # 覆盖审计里实际解释某零件的前作
  - 结论 = 前作池是确定性召回集合，不是 LLM 相似度集合 # 合规关键点
- Metrics: 每个进入 Π_x 的 prior 都能解释来源层；重复命中时只保留一个 prior 记录但 source_layers 合并；准入规则不读取 originality 标签。
- Notes: 书目耦合的理论依据是 Kessler 1963：共享参考文献可表示同一研究对话。核心分支距离的依据是分类检索思想：同分支候选更可能检查同类技术问题，但这仍只是召回准入，不是 novelty 判断。
- CurrentResult:
  - $\Pi_x=L1_x\cup L2_x\cup L3_x\cup L4_x$
  - $admit(x,p)=\mathbf{1}[shared\_references(x,p)\ge k \lor core\_role\_branch\_distance(x,p)\le d]$
  - $source\_layers(p)=\{L: p\in L_x\}$
- RootCauseAnalysis: 前作池容易被误解成“模型觉得相似的论文”。实际规则必须可展开为引用、坐标、来源层，避免变成黑盒相似度。
- CaseStudy:
  - case 1: 一个 prior 同时来自 related work 和坐标召回 → source_layers 保留两个标签，覆盖审计仍只算一篇 prior。
  - case 2: 共享参考文献数低且核心坐标跨家族 → 不准入，即使标题看起来相近，也不能靠 embedding 放进来。
- NextIdea: 下一步解释哪些零件进入 N 的分母，哪些只做诊断。
- SelectedSkills:

## N8c - 可计分零件、generic/family、unknown 口径

- Position: 4262,2073
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明什么叫计分，为什么 family/generic 被剔除，unknown 为什么有主口径和稳健性口径。
- Approach: 计分是指该零件进入 N 的分母并可能贡献 residual。leaf 和 intermediate 坐标足够具体，可以计分。family/generic 坐标太粗，例如只停在“optimization_training”这种大桶，会导致几乎所有论文互相覆盖，所以从 N 分母剔除并记录 excluded_generic_n。具体角色的 _unknown_ 在主口径中也计分，并且从本轮起按普通树节点参与主覆盖：同一个 unknown bucket 可 exact 覆盖，同父桶 unknown 与具体叶可按 tree_distance 软覆盖。稳健性口径仍可把 _unknown_ 剔除，用来检查结果是否被树缺口主导。
- Input:
  - scorable termination levels = {"leaf","intermediate"} # 只有具体坐标默认进入 N 分母
  - concrete unknown roles = central_method / central_method_visible_objective / derived_efficiency_goal / method_object_task # 这些 unknown 在主口径计 residual
  - excluded_generic example = termination_level:"family" # 太粗，不能当作被解释或未解释的具体零件
- Output:
  - scorable_specific # leaf/intermediate，进入 N_struct 分母
  - scorable_unknown # 具体角色 unknown，主口径进入分母并参与覆盖
  - unknown_bucket_path # unknown 的父桶路径仍可用于诊断树缺口位置
  - excluded_generic # family/generic，不进入分母，只计数
  - excluded_generic_n = 被剔除的粗坐标数量 # 判断仪器是否太粗
  - 结论 = family/generic 不能拿来洗覆盖率 # 否则 N 会退化为近常数
- Metrics: family 级零件不能进入 N_struct 分母；具体角色 unknown 的主口径和剔除口径都要能复现。
- Notes: “主口径”是正式报告的默认定义；“稳健性口径”是敏感性分析，不是为了调高结果。当前主覆盖已把 unknown bucket 当普通坐标处理；`unknown_part_count` 仍需报告，因为它表示树分辨率不足。
- CurrentResult:
  - $S_x=\{i\in P_x: termination_i\in\{leaf,intermediate\}\lor specific\_unknown(i)\}$
  - $excluded\_generic\_n=|\{i\in P_x: termination_i=family/generic\}|$
  - $specific\_unknown(i)=\mathbf{1}[c_i=\_unknown\_\land r_i\in R_{concrete}]$
- RootCauseAnalysis: 历史退化来自 family 级坐标过多又允许 d_cov<=2，导致覆盖过宽；具体度门槛是为了防止“粗分类等于解释”。
- CaseStudy:
  - case 1: 66% 零件停在 family 级时，宽覆盖让残差几乎为 0，N 失去区分度。
  - case 2: central_method 映射到 `method_architecture:neural_architectures:_unknown_` 时，它进入主覆盖；若前作也在同 bucket，则 coverage_score=1；若前作在同父桶具体叶，则按 shared_depth 给软覆盖。
- NextIdea: 下一步解释进入分母的零件如何加权。
- SelectedSkills:

## N8d - 零件权重 w_i

- Position: 5200,2166
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 role_weight、rarity_weight、unknown_discount 怎么计算，是否拟合，以及 role_slot 是谁判断的。
- Approach: 当前实现中 role_weight 是人工设定的先验权重，不是从 originality 回归拟合出来的。role_slot 来自 M1 抽取 schema 和派生规则：LLM 在抽取阶段根据 prompt 从论文文本中转写 central_methods、mechanism_operations 等字段；工程管道再把字段名转成 role_slot。rarity_weight 来自语料索引中的坐标稀有度，坐标越少见，权重越高。unknown_discount 是 Unknown 桶经验贝叶斯思想的冷启动折扣：unknown 可能是真新概念，也可能是树缺口或抽取噪声，所以先按 0.5 计，未来可由 HC-5 转正率校准。
- Input:
  - role_weight("central_method") = 4.0 # 中心方法最高权重
  - role_weight("central_method_visible_objective") = 3.0 # 明确目标类中心贡献
  - role_weight("derived_efficiency_goal") = 3.0 # 派生效率目标，较高权重
  - role_weight("method_object_task") = 2.0 # 方法对象/任务，中等权重
  - role_weight("operation_atom") = 0.75 # 机制操作原子，低权重
  - rarity_weight(c) = 0.5 + rarity(c) # 坐标越少见，权重越高
  - unknown_discount = 0.5 if coordinate contains "_unknown_" else 1.0 # unknown 冷启动折扣
- Output:
  - weight = centrality_weight × rarity_weight × unknown_discount # 每个零件进入 N 的最终权重
  - centrality_weight = role_weight(role_slot) # 角色重要性
  - rarity_weight = 0.5 + rarity(coordinate) # 坐标稀有度权重
  - 结论 = 当前权重是先验赋值，不是用 originality 回归拟合 # HC-4 未完成前不能声称冻结
- Metrics: 权重计算不能读取 originality/clarity/substance；每个权重都能从 role_slot、rarity_stats、unknown 标志复算。
- Notes: HC-4 权重审核未完成前，权重不能声称最终冻结。
- CurrentResult:
  - $w_i=role\_weight(r_i)\times rarity\_weight(c_i)\times unknown\_discount(i)$
  - $rarity\_weight(c_i)=0.5+rarity(c_i)$
  - $unknown\_discount(i)=0.5$ if $c_i$ contains $_unknown_$ else $1.0$
- RootCauseAnalysis: 用户关心“凭什么这是中心方法”是合理的；答案不是残差公式判断的，而是 M1 抽取器按贡献声明锚定和中心层信度闸门输出的。
- CaseStudy:
  - case 1: role_slot=central_method → role_weight=4.0，因此中心方法残差比 operation_atom 更影响 N。
  - case 2: operation_atom=learning 这类空壳动词曾污染机制原子化，所以后续规则要求操作+对象才算完整机制。
- NextIdea: 下一步解释 tree_distance 和覆盖判定。
- SelectedSkills:

## N8e - tree_distance,coverage与覆盖判定

- Position: 4289,2996
- Size: 710,871
- Completion:
- Problem: 需要说明 tree_distance、d_cov、精确主口径、历史宽口径和覆盖审计字段。
- Approach: tree_distance 只比较同一 facet 的树路径，不用文本相似度。unknown 在当前 v0.9.0 森林里是不同父节点下的真实 bucket 坐标，例如 `method_architecture:neural_architectures:_unknown_` 和 `method_architecture:symbolic_structured:_unknown_`，所以它有 path、LCA、shared_depth，也能算 tree_distance。从本轮起，主覆盖把 unknown bucket 当普通树节点：同 bucket unknown exact 覆盖，unknown 与同家族具体坐标按 Wu-Palmer/LCS 式共享深度比例给部分分数，跨家族/跨 facet 为 0。0.67 是本项目保守 cap，不是文献固定常数。
- Input:
  - target node = annotation projection comparable corpora # ACL2017:107 的目标机制零件
  - target path = ["mechanism_operation:root","mechanism_operation:representation_transform","mechanism_operation:representation_transform:linear_projection","mechanism_operation:representation_transform:linear_projection:annotation_projection"] # |path_i|=4
  - prior node = modeling linear projection models # ACL2017:21 的前作机制零件
  - prior path = ["mechanism_operation:root","mechanism_operation:representation_transform","mechanism_operation:representation_transform:linear_projection"] # |path_j|=3
  - LCA path = ["mechanism_operation:root","mechanism_operation:representation_transform","mechanism_operation:representation_transform:linear_projection"] # |LCA|=shared_depth=3
  - exact covered = True only when tree_distance=0 # 保留给审计的硬覆盖字段
  - coverage_score = 1.0 when same coordinate # 完全覆盖
  - coverage_score = min(0.67, 2*shared_depth/(len(target_path)+len(prior_path))) # 同家族部分覆盖
  - unknown example path = ["method_architecture:root","method_architecture:neural_architectures","method_architecture:neural_architectures:_unknown_"] # unknown 也有树坐标位置
  - coverage_score for unknown = same rule as normal node # unknown bucket 参与主覆盖
- Output:
  - tree_distance = (4-3)+(3-3)=1 # 目标叶子与前作中层是祖先-后代关系
  - raw shared-depth score = 2*3/(4+3)=0.857142857 # Wu-Palmer/LCS 式接近度
  - coverage_score = min(0.67,0.857142857)=0.67 # cap 后的部分覆盖
  - residual_factor = 1 - 0.67 = 0.33 # 该零件仍保留三分之一残差
  - audit row = target ACL2017:107; soft_covered_by ACL2017:21; soft_alignment_relation ancestor_descendant # 真实 CSV 行
  - unknown exact example = neural_architectures:_unknown_ vs same bucket gives tree_distance=0 and coverage_score=1 # 同 bucket 覆盖
  - unknown partial example = neural_architectures:_unknown_ vs neural_architectures:rnn gives tree_distance=2 and raw score=2/3 # 同父桶软覆盖
- Metrics: 同 facet 同 path 的距离必须为 0；跨 facet 必须拒绝；d_cov=0 时只有 keeps 能覆盖。
- Notes: 代码依据：`align.py` 负责 LCA/shared_depth/tree_distance/relation；`residual.py` 当前已取消 `if scorable and not unknown` 的覆盖跳过逻辑，unknown bucket 会进入 find_cover/find_soft_cover。外部依据只是“用 LCA/shared depth 衡量 taxonomy 节点相似”的思路，例如 Wu & Palmer 1994 的 `2*depth(LCS)/(depth(c1)+depth(c2))`、Resnik 1995 的 least common subsumer 信息量思路、Silla & Freitas 2011 对层级分类的 survey。项目没有照搬论文参数；`partial_cap=0.67` 是为避免近邻变成 full coverage 的保守工程护栏。
- CurrentResult:
  - `path_i` 是目标零件映射到 facet tree 后从 root 到当前节点的 ID 列表，长度就是列表元素个数。
  - `|LCA|` 在代码里等于 `shared_depth`，即两条 path 从第一个元素开始连续相同的节点数；不是额外查树，而是 zip 两条路径逐项比较。
  - `tree_distance(path_i,path_j)=|path_i|-|LCA|+|path_j|-|LCA|`；这是树上最短路径边数。
  - `coverage_score=1` if exact coordinate, including exact unknown bucket。
  - `coverage_score=min(0.67, 2*shared_depth/(|path_i|+|path_j|))` if same-family non-exact, including unknown-vs-concrete。
  - `coverage_score=0` only for cross-family / cross-facet / unmapped。
  - 代码已同步：`residual.py` 主覆盖不再跳过 unknown；`idea_dual_channel_tree.py` / `idea_dual_channel_edge.py` 的 slot/edge coverage 也把 unknown bucket 当普通路径。
- RootCauseAnalysis: 用户疑惑来自四件事混在一起：一是 `path_i` 不是论文文本路径，而是树坐标 ID 列表；二是 `|LCA|` 与 `shared_depth` 在本实现里是同一个计数；三是 `0.67` 不是自然算出来的相似度，而是 raw shared-depth score 之上的 cap；四是 unknown 在树上有位置。上一版把 unknown 从主 coverage 排除；本轮按用户裁决改为 unknown bucket 作为普通坐标参与主覆盖。
- CaseStudy:
  - case 1: ACL2017:107 `annotation_projection` vs ACL2017:21 `linear_projection` → shared_depth=3, tree_distance=1, raw=0.857, cap 后 coverage_score=0.67, residual_factor=0.33。
  - case 2: 单元测试里 `model_pruning` vs `weight_quantization` → shared_depth=2, tree_distance=2, raw=2*2/(3+3)=0.6667, relation=variant_of。
  - case 3: `model_pruning` vs `machine_translation` → 只共享 root，relation=cross_family_replace，coverage_score=0，因为“同在一棵树根下”不足以解释目标零件。
  - case 4: `method_architecture:neural_architectures:_unknown_` vs 同 bucket unknown → align distance=0, coverage_score=1。
- NextIdea:
- SelectedSkills:

## N8f - 结构残差 N_struct

- Position: 5467,1242
- Size: 481,705
- Completion: 进行中
- Problem: 需要说明 covered(i,x)、residual_i、N_struct、分 facet 子分数和零件数量变化时如何归一。
- Approach: 对目标论文 x 的每个可计分零件 i，在前作池 Π_x 中找最佳解释。`covered(i,x)` 不再承担主计算职责，它只表示是否存在 exact 同坐标前作，方便审计。主计算用 `coverage_score(i,x)=max_p coverage_score(i,p)`，因此部分覆盖会让 residual_factor 变成 0 到 1 之间的小数。零件数量每篇不同，所以 N_struct 用权重和归一化，而不是直接求和。分 facet 子分数是在每个 facet 内重复同一公式，用来诊断到底是 task/method/mechanism/objective 哪个分面产生残差；它不一定直接进入最终单分数，但对解释报告有用。
- Input:
  - S_x = 可计分零件集合 # 来自 N8c
  - w_i = 每个零件权重 # 来自 N8d
  - coverage_score(i,x) ∈ [0,1] # 来自 N8e，在 Π_x 内取最佳软覆盖
  - covered_exact(i,x) = 0 或 1 # 同坐标审计字段，不是主计算字段
  - residual_factor_i = 1-coverage_score(i,x) # 部分覆盖时为小数
- Output:
  - N_struct ∈ [0,1] # 每篇论文的软结构残差主分数
  - total_weight = Σw_i # 归一化分母，解决每篇零件数不同
  - scorable_part_count = |S_x| # 进入分母的零件数量
  - facet subscore = 每个 facet 内单独计算同一公式 # task/method/mechanism/objective 子分数
  - coverage_score/residual_factor = part audit 中的新审计列 # 直接说明部分覆盖如何影响 N
  - smoke run: N mean=0.2546, median=0.1686, nonzero_paper_rate=0.5851 # soft coverage 开发集轻量验证，未看相关
  - smoke run: soft_total_part_coverage mean=0.9056, median=1.0 # 部分覆盖能进入覆盖率诊断
  - smoke run: partial_head=20, partial_tail=28 # 实际产生了小数覆盖样本
- Metrics: N_struct 必须在 [0,1]；total_weight=0 时不能伪造分数，必须标低置信或缺失；每个 residual_i 都能展开 covered_by 或未覆盖理由。
- Notes: w_i 不随每篇零件数“更新”，而是固定规则计算；归一化处理每篇零件数不同的问题。
- CurrentResult:
  - $coverage\_score(i,x)=\max_{p\in\Pi_x}coverage\_score(i,p)$
  - $residual\_factor_i=1-coverage\_score(i,x)$
  - $N_{struct}(x)=\frac{\sum_{i\in S_x}w_i residual\_factor_i}{\sum_{i\in S_x}w_i}$
  - $N_{struct}^{facet=f}(x)=\frac{\sum_{i\in S_x,f_i=f}w_i residual\_factor_i}{\sum_{i\in S_x,f_i=f}w_i}$
- RootCauseAnalysis: 用户指出的问题成立：part-level 二值 covered 太硬，会把“部分被前作解释”当成“完全没解释”。修复方式不是让 LLM 判相似，而是用树路径的确定性软覆盖把 partial credit 放进 residual_factor。
- CaseStudy:
  - case 1: 旧口径 4576 个 residual 只有 2 个为 1 → N 几乎没有方差。
  - case 2: 同家族兄弟叶过去 exact covered=False、residual=1；现在 coverage_score≈0.67、residual_factor≈0.33，表示前作部分解释了该零件。
- NextIdea:
- SelectedSkills:

## N8g - 部分计分 N_partial

- Position: 6635,2060
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 residual_factor_i(d)、p_partial、同族、N_partial 是什么，以及为什么是离散值。
- Approach: 部分计分是历史变体，用来表达“近邻前作部分解释目标零件”。d 是目标零件与最佳前作零件的 tree_distance。同族指两条 path 共享同一 L2 或更深分支，align_paths 会给出 variant_of、ancestor_descendant、same_branch_replace 等关系。p_partial 是人工设定或待审核的部分残差系数，不是由标签回归得到。当前结果显示边际贡献很小，因此它是理论保留项，不是已冻结成功项。
- Input:
  - best_match_distance = 0 # 同坐标，residual_factor=0
  - best_match_distance >= 1 且 same_branch=True # 同族近邻，residual_factor=p_partial
  - no comparable prior 或 unknown # residual_factor=1
  - p_partial = 待审核的部分残差系数 # 不是从 originality 回归得到
- Output:
  - N_partial = 用 residual_factor 替代 residual_i 的残差分数 # N_struct 的稳健性/变体
  - 当前结论 = 边际≈0 # 不能作为已成功冻结项
  - 解释 = 同族近邻只提供部分解释，不等同同坐标覆盖 # 语义比宽覆盖更保守
- Metrics: N_partial 只能作为预注册变体报告；不能因为它相关性更好临时替换主口径。
- Notes: 离散值来自可审计性要求；连续相似度容易滑向黑盒相似判断。
- CurrentResult:
  - $residual\_factor_i(d)=0$ if $d=0$
  - $residual\_factor_i(d)=p_{partial}$ if same_branch and $d\ge1$
  - $residual\_factor_i(d)=1$ if no comparable prior or unknown
  - $N_{partial}(x)=\frac{\sum_{i\in S_x}w_i residual\_factor_i}{\sum_{i\in S_x}w_i}$
- RootCauseAnalysis: 部分计分想解决精确覆盖过严的问题，但如果树节点过粗或 unknown 过多，它仍然不能提供有效区分。
- CaseStudy:
  - case 1: 同家族兄弟叶在 N_struct 主口径 residual=1，在 N_partial 可记 p_partial。
  - case 2: 跨家族没有可靠同族关系，仍记 1 或不可比；unknown bucket 按当前主覆盖可参与距离，但必须在审计中标明 bucket-level。
- NextIdea: 下一步解释组合罕见度。
- SelectedSkills:

## N8h - 最终新颖性公式 N_final

- Position: 7334,1418
- Size: 0,720
- Completion: 进行中
- Problem: 需要明确最终“新颖性分数”到底由哪些直接变量计算出来，避免总节点直接连到所有中间变量。
- Approach: 最终主线分数写作 N_final。它的直接变量只有两个：结构残差 N_struct 和组合罕见度 N_comb。当前实证结果中 β=0，所以正式主线实际上退回 N_struct；N_comb 保留为理论变量和审计项，但不能包装成已有效信号。
- Input:
  - N_struct_norm = 结构残差归一化值 # 当前主线有效变量
  - N_comb_norm = 组合罕见度归一化值 # 理论保留变量
  - β = 0 # 当前探索结果下最优混合权重
- Output:
  - N_final = N_struct when β=0 # 当前实际最终分数退回结构残差
  - 当前结论 = N_comb 没有改善 originality 信号 # 负结果必须保留
  - 冻结状态 = 未冻结 # PROTOCOL_V2/HC-4 未完成
- Metrics: N_final 的每个直接变量必须能展开到下级节点；不得从 originality 结果反调 β；当前 β=0 的负结果必须保留。
- Notes: N8 总节点只连接本节点；本节点再连接 N_struct、N_comb 和审计量。
- CurrentResult: $N_{final}(x)=(1-\beta)N_{struct,norm}(x)+\beta N_{comb,norm}(x)$
- RootCauseAnalysis: 之前把 N_comb 和 N_final 放在同一个节点，导致边关系无法表达“最终公式 → 直接变量 → 子变量”的层级。
- CaseStudy:
  - case 1: β=0 时，N_final=N_struct，说明组合项没有提供额外有效信号。
  - case 2: 如果未来 β>0，必须先预注册并通过 HC-4/PROTOCOL 冻结，不能用开发集相关性临时调。
- NextIdea:
  - 下一级应先校对 N_struct 和 N_comb 两个直接变量。
  - 结构残差和组合的罕见度都是必要的，现在的拟合β是0可能是我们的数据不足也有可能是下面的公式有一些有问题，这里的公式暂时不用改。
- SelectedSkills:

## N8l - 组合罕见度 N_comb

- Position: 6174,1390
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 L2 分支集合、分支对、co-occurrence、rarity_stats.coordinate_pairs、N_comb。
- Approach: 对一篇论文，取所有非 unknown 可计分零件的 L2 分支，形成集合 B_x。L2 这里不是前作池 L2，而是树路径的第二层分支。对 B_x 中每个分支对 (a,b)，在全语料统计它们共同出现在同一篇论文中的频率 P(a,b)。越少共同出现，-log P(a,b) 越大，表示组合越少见。未见组合用 0.5/n_docs 作为 floor，避免 -log(0) 无穷大。N_comb 可取 mean 或 max。
- Input:
  - B_x = 非 unknown 的 L2 树分支集合 # 这里的 L2 是树第二层，不是前作池 L2
  - (a,b) = B_x 中两个不同分支 # 一个分支对
  - P(a,b) = 全语料中 a 和 b 同篇共现概率 # 来自坐标对统计
  - floor = 0.5/n_docs # 未见组合的概率下界
- Output:
  - score(a,b) = -log(max(P(a,b), floor)) # 分支对越少见分数越高
  - N_comb_mean = 所有分支对 score 的平均 # 稳定型组合罕见度
  - N_comb_max = 所有分支对 score 的最大 # 极端罕见组合
  - 当前结论 = 理论保留，但 β=0 表明未改善最终效度 # 不得夸大
- Metrics: unknown 分支不能进入 B_x；coordinate_pairs 的统计窗口和 n_docs 必须记录；未见组合必须使用固定 floor。
- Notes: 现实意义是“已知分支的新组合”，理论来源对应组合创新文献如 Fleming/Uzzi，但在本项目实证中暂未成为有效主信号。
- CurrentResult:
  - $B_x=\{branch_2(path_i): i\in S_x, i\ not\ unknown\}$
  - $score(a,b)=-\log(max(P(a,b),0.5/n_{docs}))$
  - $N_{comb}^{mean}(x)=mean_{(a,b)\in pairs(B_x)}score(a,b)$
  - $N_{comb}^{max}(x)=max_{(a,b)\in pairs(B_x)}score(a,b)$
- RootCauseAnalysis: 用户容易把前作池 L2 和树 L2 混淆；这里的 L2 是树层级，不是前作来源层。
- CaseStudy:
  - case 1: task_problem::efficiency_compression 与 method_architecture::optimization_training 共同出现少 → score 较高。
  - case 2: β=0 表示 N_comb 实证上未改善最终分数，不得包装为组合项成功。
- NextIdea: 下一步解释 typed-edge 的覆盖单位。
- SelectedSkills:

## N8i - typed_edge、edge_cov、slot_close

- Position: 4894,3029
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 typed_edge 是什么，rel 是否固定，edge_cov、slot_close、γ、unknown bucket 怎么处理。
- Approach: typed_edge 是关系三元组，端点是想法图槽位映射后的树坐标，关系类型来自固定小集合而不是自由别名：problem-method、method-role、method-mechanism、mechanism-effect。当前 edge 实现把关系类型固定在代码 EDGES 列表中，实际比较时只比较同一种 edge 的两个端点。slot_close(A,B,gamma) 输入两个坐标路径和 gamma；从本轮起 unknown bucket 也按普通坐标参与 slot_close：同 bucket 为 1，同树可计算距离则为 gamma^d，跨树为 0，只有缺失/未映射端点才返回 None。γ 是网格拟合参数，探索轨道使用，未冻结。
- Input:
  - EDGES = [problem-method, method-role, method-mechanism, mechanism-effect] # 固定 typed edge 类型
  - target edge e = (method, works_by, mechanism) # 目标论文的一条关系边
  - prior edge e' = (method, works_by, mechanism) # 前作中同类型关系边
  - γ ∈ {0.0,0.25,0.5,0.75,0.9} # 探索网格参数，未冻结
  - unknown bucket endpoint = ["method_architecture:root","method_architecture:neural_architectures","method_architecture:neural_architectures:_unknown_"] # 作为普通坐标参与 slot_close
- Output:
  - edge_cov ∈ [0,1] 或 None # 同一 prior 同时覆盖两个端点才高
  - slot_close=1 # 同坐标
  - slot_close=γ^d # 同树可比但不同坐标
  - slot_close=None only when endpoint missing/unmapped # 不再因为 unknown 本身返回 None
  - 当前失败数字 = 44/86 篇 0 条可观测 typed edge # 主要瓶颈是可观测性
- Metrics: 只有同 rel 的边可以比较；同一 prior 必须同时覆盖两个端点；unknown 端点的 bucket path 与其他坐标一样进入 slot_close。
- Notes: unknown 不是“没路径”，而是“有父桶位置的 bucket 节点”。本轮裁决是主覆盖把它当正常节点处理，同时继续报告 unknown 数量来提示树分辨率不足。
- CurrentResult:
  - $e=(A,rel,B)$
  - $slot\_close(A,B)=None$ only if endpoint path is missing/unmapped
  - $slot\_close(A,B)=1$ if $A=B$
  - $slot\_close(A,B)=\gamma^{tree\_distance(A,B)}$ if same facet and comparable
  - $edge\_cov(e,p)=slot\_close(A_x,A_p)\times slot\_close(B_x,B_p)$
- RootCauseAnalysis: 旧 tree-channel 把槽位平均，无法表达“同一前作是否同时拥有两个端点”；typed-edge 改成乘积后解决了覆盖单位问题。上一版把 unknown 简写成不可比过于粗糙；本轮按用户裁决改为 unknown bucket 参与主 edge_cov。
- CaseStudy:
  - case 1: target 有 (method, works_by, mechanism)，prior 只有 method 近但 mechanism 端点缺失 → edge_cov=None 或低，不算完整解释。
  - case 2: target/prior 都是 `neural_architectures:_unknown_` → tree_distance=0, slot_close=1。
- NextIdea: 下一步解释 Far/Near/C 双通道。
- SelectedSkills:

## N8j - FarNovelty、NearMechReplacement、C(x)

- Position: 6861,2870
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 typed-edge 双通道公式里 x、p、max、mean、observed edge、ContextCloseness、MechanismSubstitutionCost 的现实意义。
- Approach: x 是目标论文，p 是前作池中的一篇 prior。observed edge 是目标论文中两个端点都有映射路径的 typed edge，unknown bucket 也算映射路径。FarNovelty 衡量“有没有某篇前作能整体覆盖目标所有可观测边”；对每篇 prior 先求目标所有 observed edges 的平均 edge_cov，再取最大 prior，最后用 1 减掉。MechanismSubstitutionCost 衡量在机制相关边上，前作与目标机制不同的程度。ContextCloseness 衡量非机制上下文边是否接近。NearMechReplacement 取 context 接近且机制替换成本高的最大 prior。C 是 Far 和 Near 的线性组合，α 和 γ 是探索轨道拟合参数，当前不能冻结。
- Input:
  - edge_cov(e,p) # 来自 N8i 的边覆盖值
  - E_ctx = {problem-method, method-role} # 上下文边集合
  - E_mech = {method-mechanism, mechanism-effect} # 机制边集合
  - α ∈ {0,0.05,...,1.0} # Far/Near 混合探索参数，未冻结
- Output:
  - FarNovelty = 1 - best prior edge coverage # 远距离新颖性通道
  - NearMechReplacement = max(ContextCloseness × MechanismSubstitutionCost) # 近邻机制替换通道
  - C(x) = α·Far + (1-α)·Near # typed-edge 探索分数
  - 当前结论 = Near in-sample 约 +0.21，但 C 全 dev LOO 约 -0.43 # 不可冻结
- Metrics: 必须同时报告 LOO-CV；不能只看 in-sample；可观测 edge 数必须报告。
- Notes: 公式写 x 但实现中通过 tc=coords_of(x) 使用 x 的槽位坐标；p 通过 prior_coords 遍历使用。
- CurrentResult:
  - $FarNovelty(x)=1-\max_{p\in\Pi_x}mean_{e\in E_x^{obs}}edge\_cov(e,p)$
  - $MechanismSubstitutionCost(x,p)=1-mean_{e\in E_{mech}^{obs}}edge\_cov(e,p)$
  - $ContextCloseness(x,p)=mean_{e\in E_{ctx}^{obs}}edge\_cov(e,p)$
  - $NearMechReplacement(x)=\max_{p\in\Pi_x}[ContextCloseness(x,p)\times MechanismSubstitutionCost(x,p)]$
  - $C(x)=\alpha FarNovelty(x)+(1-\alpha)NearMechReplacement(x)$
- RootCauseAnalysis: C 的全 dev LOO 为负，不能用来证明方法有效；它现在的价值是暴露“节点袋覆盖单位不够”和“边可观测性不足”。
- CaseStudy:
  - case 1: Near in-sample 约 +0.21 但 LOO-CV C 约 -0.43 → 泛化失败。
  - case 2: 限制到可观测样本仍不稳定 → 下一步不是调 α，而是提高 relation/endpoint 可观测性。
- NextIdea: 下一步解释置信度和审计量。
- SelectedSkills:

## N8k - 置信度与审计量

- Position: 7271,2238
- Size: 0,720
- Completion: 进行中
- Problem: 需要说明 N、C 周边的 graph coverage、unknown_n、head/tail coverage、prior_pool_size 等为什么必须报告。
- Approach: N 或 C 本身是分数，但项目目标要求每个分数可解释、可追溯。graph coverage 表示抽取/映射后有多少必要结构可观测；unknown_n 表示树缺口或映射停在 unknown bucket 的数量；unknown_bucket_distribution 表示这些 bucket 级坐标落在哪些父桶；head coverage 表示 L1/L2 显式相关前作对目标零件的覆盖，其中 unknown bucket 覆盖也计入；tail coverage 表示 L3/L4 对剩余零件的补充覆盖；prior_pool_size 表示联合解释的候选规模。它们不直接等于 novelty，但用于判断残差是否可信。
- Input:
  - pool_size # 前作池大小，解释“联合解释是否过宽”
  - head_part_coverage # L1/L2 显式相关前作覆盖了多少零件
  - tail_part_coverage_remaining # L3/L4 对 head 未覆盖零件补了多少
  - unknown_part_count # 树缺口或映射失败数量
  - unknown_bucket_distribution # unknown 落在哪些父桶，例如 neural_architectures:_unknown_
  - excluded_generic_n # 因太粗被剔除的 family/generic 数量
  - n_obs_edges # typed-edge 可观测边数量
- Output:
  - 结论类型 1 = 分数可信 # coverage 足够、unknown 低、审计能展开
  - 结论类型 2 = 覆盖主要发生在 bucket 层 # unknown 多但 coverage 高，说明分数可审计但树分辨率低
  - 结论类型 3 = 覆盖规则可疑 # coverage 高但 N 近常数
  - 必报项 = 每个分数都能展开到 covered_by、coordinate、tree_distance # 项目根本目的
- Metrics: 每篇论文至少能展开“哪个零件、哪个坐标、被哪篇前作覆盖、覆盖距离是多少”；不能只报一个总分。
- Notes: 置信度不是 LLM 自评，也不是为了洗掉失败样本；它是解释测量仪器是否看得见目标结构。
- CurrentResult:
  - $head\_coverage(x)=\frac{covered\_weight_{L1\cup L2}}{total\_scorable\_weight}$
  - $tail\_coverage(x)=\frac{newly\_covered\_weight_{L3\cup L4}}{remaining\_weight\ after\ head}$
  - $total\_coverage(x)=\frac{covered\_weight_{\Pi_x}}{total\_scorable\_weight}$
  - $unknown\_n(x)=|\{i\in P_x:c_i contains\ \_unknown\_\}|$
  - $unknown\_bucket\_distribution(x)=count(parent\_bucket(c_i))$ for unknown parts
  - $graph\_coverage(x)=\frac{observed\ structural\ units}{expected\ structural\ units}$
- RootCauseAnalysis: 上一代方法失败的教训是总分可能测到 clarity/substance，而不是 novelty；审计量让我们能判断分数来自真实结构残差还是输入缺失。
- CaseStudy:
  - case 1: head coverage 高但 N 无方差 → 前作池足够，覆盖语义可能过宽。
  - case 2: unknown bucket coverage 高 → 不是不可审计，但解释报告必须标明“此前作覆盖到同一 unknown 父桶”，不能写成具体叶概念相同。
- NextIdea: 完成 N8a-N8k 的逐项校对后，再决定 PROTOCOL_V2 是否可冻结。
- SelectedSkills:

# GraphState

- Current: N2a
- Next: N2a
- NextPlan: 为什么methods_text会缺失，是抽取的问题吗？还是说有些论文就没有methods？为什么会有抽取的缺失，按道理论文是非常格式化的，不应该有抽取缺失，比如说related_work和conclusion的缺失？为什么label的other有1000个，我不知道这样是否好？为什么会没有论文全文，实在不行就爬虫把论文全文爬虫下来，不要空着。

# Edges

## E1 - ROOT → governance

- Endpoints: ROOT, N1
- LabelOffset: -173,-44
- Label: ROOT → governance
- Notes: 看这条边时要确认任何实验推进都没有绕开红线；结论是系统目标必须服从开发/确认防火墙和可审计性要求。

## E2 - Track A/B → final project

- Endpoints: N7a, ROOT
- LabelOffset: -76,-48
- Label: Track A/B → final project
- Notes: 看这条边时要区分当前公式探索和最终论文评估；结论是 N7a 暂不推进，等 PROTOCOL_V2 冻结后再做。

## E3 - ROOT → ABC formula index

- Endpoints: ROOT, N3a
- LabelOffset: -168,345
- Label: ROOT → ABC formula index
- Notes: 看这条边时要把 ABC 当作历史主公式索引；结论是 ABC 被证伪/部分负结果后仍要保留，方便解释 limitations。

## E4 - 前作池准入公式

- Endpoints: N3a, N8b
- LabelOffset: -273,-6
- Label: 前作池准入公式
- Notes: 看这条边时要检查 N3a 的 admission 公式是否真的落到 N8b 的 Π_x 构造；结论是前作池准入属于召回/审计问题，不是 novelty 判断。

## E5 - A = N_struct

- Endpoints: N3a, N8f
- LabelOffset:
- Label: A = N_struct
- Notes: 看这条边时要检查 A 的每一项是否能在 N8f 展开为零件、权重、coverage_score/residual_factor；结论是 A 是当前主线公式，不是旁支。

## E6 - B = N_partial

- Endpoints: N3a, N8g
- LabelOffset: -196,180
- Label: B = N_partial
- Notes: 看这条边时要问“同族近邻是否应该部分解释”；当前结论是它是 N_struct 的稳健性变体，边际≈0，不能作为已成功公式。

## E7 - C = N_comb

- Endpoints: N3a, N8l
- LabelOffset: -173,36
- Label: C = N_comb
- Notes: 看这条边时要区分公式 C 和 typed-edge 的 C(x)；这里的 C 是组合罕见度，当前结论是理论合理但实证混合权重 β=0。

## E8 - ABC → N_final

- Endpoints: N3a, N8h
- LabelOffset:
- Label: ABC → N_final
- Notes: 看这条边时要读成“原始 ABC 怎样汇总成最终分数”；当前结论是最终分数退回 N_struct，不能声称组合项已救回效度。

## E9 - M0-M3 → part 字段

- Endpoints: N2, N8a
- LabelOffset:
- Label: M0-M3 → part 字段
- Notes: 看这条边时要抽查一个零件是否有 node_text、role_slot、facet、path、termination_level；结论是数据底座决定后面公式能不能解释。

## E10 - M0-M3 → Π_x 输入

- Endpoints: N2, N8b
- LabelOffset:
- Label: M0-M3 → Π_x 输入
- Notes: 看这条边时要检查 L1-L4 每层候选是否有来源标签；结论是前作池缺漏会造成假残差，前作池过宽会造成假覆盖。

## E11 - M3 rarity_stats → w_i

- Endpoints: N2, N8d
- LabelOffset:
- Label: M3 rarity_stats → w_i
- Notes: 看这条边时要检查 rarity_weight 是否只来自语料频率而非 originality；结论是它是先验权重，不是标签拟合。

## E12 - M3 coordinate_pairs → N_comb

- Endpoints: N2, N8l
- LabelOffset:
- Label: M3 coordinate_pairs → N_comb
- Notes: 看这条边时要检查 coordinate_pairs 的统计窗口和 n_docs；结论是 N_comb 的意义取决于共现统计是否稳定。

## E13 - residual.py → N_struct

- Endpoints: N3, N8f
- LabelOffset: -174,434
- Label: residual.py → N_struct
- Notes: 看这条边时要对照实现是否是 residual_factor=1-coverage_score；结论是代码实现必须和 N8f 公式一致。

## E14 - residual.py → N_partial

- Endpoints: N3, N8g
- LabelOffset:
- Label: residual.py → N_partial
- Notes: 看这条边时要确认 partial 没有被偷偷当主口径；结论是它只做敏感性分析。

## E15 - residual.py → N_comb

- Endpoints: N3, N8l
- LabelOffset: -116,101
- Label: residual.py → N_comb
- Notes: 看这条边时要确认 unknown 分支是否按当前协议进入 B_x；若进入，必须标记为 bucket-level co-occurrence，不能和具体叶组合混写。当前 N_comb 仍需在 N8l 单独校对。

## E16 - residual.py → N_final

- Endpoints: N3, N8h
- LabelOffset:
- Label: residual.py → N_final
- Notes: 看这条边时要确认 β 和归一化在协议中预注册；结论是当前不能用开发集相关性反调 N_final。

## E17 - typed triples → edge_cov

- Endpoints: N4, N8i
- LabelOffset:
- Label: typed triples → edge_cov
- Notes: 看这条边时要检查覆盖单位是否从节点变成 typed edge；结论是 edge_cov 解决“同一前作同时有两个端点”的表达问题。

## E18 - typed triples → C(x)

- Endpoints: N4, N8j
- LabelOffset: -113,254
- Label: typed triples → C(x)
- Notes: 看这条边时要同时看 in-sample 和 LOO；结论是 Near 有方向但 C(x) 当前不泛化，不能冻结。

## E19 - relation graph assets → edge_cov

- Endpoints: N4a, N8i
- LabelOffset:
- Label: relation graph assets → edge_cov
- Notes: 看这条边时要确认边类型固定、端点有坐标；结论是如果端点 unknown，当前 edge_cov 主口径把它当 bucket 坐标纳入覆盖，并应在审计字段中标记 bucket-level。

## E20 - relation graph assets → audit

- Endpoints: N4a, N8k
- LabelOffset:
- Label: relation graph assets → audit
- Notes: 看这条边时要能展开每条边的 rel、两个端点文本、两个端点坐标、是否 bucket-level unknown 覆盖和不可比原因；结论是 C(x) 不能只报纸面分数。

## E21 - case audit → part 字段

- Endpoints: N6, N8a
- LabelOffset:
- Label: case audit → part 字段
- Notes: 看这条边时要先确认 case 的中心概念是否真的被抽成零件；结论是未抽到零件时补树也救不了。

## E22 - case audit → cover

- Endpoints: N6, N8e
- LabelOffset: 86,130
- Label: case audit → cover
- Notes: 看这条边时要比较补坐标前后 covered_by 是否从空变成具体前作；结论是这能判断问题在树坐标还是前作池。

## E23 - case audit → N_struct

- Endpoints: N6, N8f
- LabelOffset: -131,131
- Label: case audit → N_struct
- Notes: 看这条边时不要只看 N 变大变小，要看 residual_i 的理由是否更符合论文语义；结论是 case audit 服务解释质量。

## E24 - case audit → edge_cov

- Endpoints: N6, N8i
- LabelOffset:
- Label: case audit → edge_cov
- Notes: 看这条边时要比较 n_obs_edges 和 edge_cov 明细；结论是补坐标若不能增加可观测边，typed-edge 路线仍卡住。

## E25 - case audit → diagnostics

- Endpoints: N6, N8k
- LabelOffset:
- Label: case audit → diagnostics
- Notes: 看这条边时要把 unknown、coverage、n_obs_edges 合起来判断；结论是单一分数好看不能说明仪器有效。

## E26 - protocol freeze → N_final

- Endpoints: N7, N8h
- LabelOffset:
- Label: protocol freeze → N_final
- Notes: 看这条边时要确认 N_final 的 β、归一化和变量都已冻结；结论是冻结前不能跑确认性 M6/M7。

## E27 - protocol freeze → audit

- Endpoints: N7, N8k
- LabelOffset: 678,-119
- Label: protocol freeze → audit
- Notes: 看这条边时要确认审计字段也是协议的一部分；结论是没有审计口径的分数不符合项目根本目的。

## E28 - N8 → N_final

- Endpoints: N8, N8h
- LabelOffset:
- Label: N8 → N_final
- Notes: 看这条边时只回答“总公式最终落到哪个分数”；结论是 N8 不是枢纽，N8h 才是公式树根。

## E29 - N_final ← N_struct

- Endpoints: N8h, N8f
- LabelOffset: -20,115
- Label: N_final ← N_struct
- Notes: 看这条边时要确认 N_struct 是 N_final 的直接变量；结论是当前实际主输出由结构残差决定。

## E30 - N_final ← N_comb

- Endpoints: N8h, N8l
- LabelOffset: -191,9
- Label: N_final ← N_comb
- Notes: 看这条边时要确认 N_comb 没有被误读为已有效信号；结论是它目前解释理论，不解释正结果。

## E31 - N_struct ← S_x

- Endpoints: N8f, N8c
- LabelOffset: -164,119
- Label: N_struct ← S_x
- Notes: 看这条边时要检查哪些零件进分母、哪些被剔除；结论是分母口径决定 N 是否诚实。

## E32 - N_struct ← w_i

- Endpoints: N8f, N8d
- LabelOffset: 242,579
- Label: N_struct ← w_i
- Notes: 看这条边时要检查权重是否来自预设规则而非标签；结论是权重影响解释强弱，但不能后验调参。

## E33 - N_struct ← covered/residual_i

- Endpoints: N8f, N8e
- LabelOffset:
- Label: N_struct ← covered/residual_i
- Notes: 看这条边时要逐条看 coverage_score、residual_factor、soft_covered_by；结论是 N_struct 的每一分都必须解释为“被哪篇前作解释了多少”。

## E34 - cover ← Π_x

- Endpoints: N8e, N8b
- LabelOffset:
- Label: cover ← Π_x
- Notes: 看这条边时要检查未覆盖是否因为 prior 不在池里；结论是假残差常来自前作池召回缺口。

## E35 - S_x ← part fields

- Endpoints: N8c, N8a
- LabelOffset:
- Label: S_x ← part fields
- Notes: 看这条边时要检查 termination_level 和 role_slot；结论是 family/generic 剔除不是删数据，而是避免粗坐标污染分数。

## E36 - w_i ← part fields

- Endpoints: N8d, N8a
- LabelOffset:
- Label: w_i ← part fields
- Notes: 看这条边时要看 role_slot 和 unknown 标志；结论是同一坐标下中心方法比 operation_atom 更影响 N。

## E37 - cover ← part paths

- Endpoints: N8e, N8a
- LabelOffset:
- Label: cover ← part paths
- Notes: 看这条边时要比较 target/prior 的 facet、path 和 shared_depth；结论是软覆盖只看树坐标位置，不看文本相似。

## E38 - N_partial variant of N_struct

- Endpoints: N8g, N8f
- LabelOffset: -298,328
- Label: N_partial variant of N_struct
- Notes: 看这条边时要确认 N_partial 不替代 N_struct；结论是它只能回答“近邻是否部分解释”。

## E39 - N_partial ← tree_distance

- Endpoints: N8g, N8e
- LabelOffset:
- Label: N_partial ← tree_distance
- Notes: 看这条边时要看 d 和 alignment_relation；结论是 partial 的核心是假设同族近邻有部分解释力。

## E40 - N_partial ← w_i

- Endpoints: N8g, N8d
- LabelOffset:
- Label: N_partial ← w_i
- Notes: 看这条边时要确认 partial 只换 residual_factor，不换权重；结论是差异来自覆盖语义，不来自权重。

## E41 - edge_cov → C(x)

- Endpoints: N8i, N8j
- LabelOffset:
- Label: edge_cov → C(x)
- Notes: 看这条边时要先看单边 edge_cov，再看 Far/Near 聚合；结论是 C(x) 的失败要拆到边层定位。

## E42 - slot_close ← tree_distance

- Endpoints: N8i, N8e
- LabelOffset:
- Label: slot_close ← tree_distance
- Notes: 看这条边时要确认 slot_close 是树距离函数，不是 embedding 相似度；结论是 typed-edge 仍遵守红线。unknown 的 tree_distance 可算，并按当前主口径参与 slot_close。

## E43 - N_final → audit

- Endpoints: N8h, N8k
- LabelOffset: -361,60
- Label: N_final → audit
- Notes: 看这条边时要同时读 N_final 和 audit；结论是没有 coverage/unknown/pool_size 的 N_final 不可解释。

## E44 - C(x) → audit

- Endpoints: N8j, N8k
- LabelOffset: -135,68
- Label: C(x) → audit
- Notes: 看这条边时要先看 n_obs_edges；结论是 44/86 篇 0 可观测边时，C(x) 负结果主要是仪器可见性问题。

## E45 - N2 → M0 data base

- Endpoints: N2, N2a
- LabelOffset:
- Label: N2 → M0 data base
- Notes: 看这条边时要确认 M0 提供的是统一语料、评审立场、漏引 gold 和 direct baseline 全文；结论是它解决“输入文本和 gold 线索是否可追溯”。

## E46 - N2 → M1 idea graph

- Endpoints: N2, N2b
- LabelOffset:
- Label: N2 → M1 idea graph
- Notes: 看这条边时要确认 idea graph 零件来自论文文本证据，不是 novelty 判断；结论是 M1 把原文变成后续 S_x 的候选残差单位。

## E47 - N2 → M2 forest mapping

- Endpoints: N2, N2c
- LabelOffset:
- Label: N2 → M2 forest mapping
- Notes: 看这条边时要确认四棵树、map_node、HC-2/HC-3 都通过；结论是 M2 把自然语言零件变成可比较树坐标。

## E48 - N2 → M3 index rarity

- Endpoints: N2, N2d
- LabelOffset:
- Label: N2 → M3 index rarity
- Notes: 看这条边时要确认 corpus_index 和 rarity_stats 使用同一树版本；结论是 M3 给前作池召回、权重和组合罕见度提供确定性输入。
