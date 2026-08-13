from __future__ import annotations

import html
import json
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "dist" / "skills-memory-transfer-kit"
OUT = KIT / "记忆模块与Skills能力体系技术总结.docx"


def esc(text: str) -> str:
    return html.escape(str(text), quote=False)


def run(text: str, bold: bool = False, size: int | None = None) -> str:
    props = []
    if bold:
        props.append("<w:b/>")
    if size:
        props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    props.append('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/>')
    return f"<w:r><w:rPr>{''.join(props)}</w:rPr><w:t>{esc(text)}</w:t></w:r>"


def para(text: str = "", style: str | None = None, bold: bool = False, size: int | None = None, align: str | None = None) -> str:
    ppr = []
    if style:
        ppr.append(f'<w:pStyle w:val="{style}"/>')
    if align:
        ppr.append(f'<w:jc w:val="{align}"/>')
    if not style:
        ppr.append('<w:spacing w:after="120" w:line="360" w:lineRule="auto"/>')
    return f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{run(text, bold=bold, size=size)}</w:p>"


def heading(text: str, level: int) -> str:
    return para(text, style=f"Heading{level}")


def bullet(text: str) -> str:
    return (
        "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/>"
        '<w:ind w:left="720" w:hanging="360"/><w:spacing w:after="80"/></w:pPr>'
        f"{run('· ' + text)}</w:p>"
    )


def cell(text: str, width: int, header: bool = False) -> str:
    shade = '<w:shd w:fill="D9EAF7" w:val="clear"/>' if header else ""
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>'
        '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="C8C8C8"/>'
        '<w:left w:val="single" w:sz="4" w:color="C8C8C8"/>'
        '<w:bottom w:val="single" w:sz="4" w:color="C8C8C8"/>'
        '<w:right w:val="single" w:sz="4" w:color="C8C8C8"/></w:tcBorders>'
        f"{shade}</w:tcPr>{para(text, bold=header)}</w:tc>"
    )


def table(rows: list[list[str]], widths: list[int]) -> str:
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    trs = []
    for i, row in enumerate(rows):
        tcs = "".join(cell(value, widths[j], header=(i == 0)) for j, value in enumerate(row))
        trs.append(f"<w:tr>{tcs}</w:tr>")
    return (
        '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/>'
        '<w:tblLook w:firstRow="1" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{''.join(trs)}</w:tbl>"
    )


def page_break() -> str:
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dir_size_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    total = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    return round(total / (1024 * 1024), 2)


manifest = read_json(KIT / "manifest.json")
index = json.loads((KIT / "metadata" / "skill-index.json").read_text(encoding="utf-8"))
repo_rows = [["来源仓库/模块", "标准 Skills 数量", "定位"]]
repo_labels = {
    "K-Dense-AI/scientific-agent-skills": "科研、数据处理、文档与科学计算能力库",
    "mattpocock/skills": "工程协作、需求澄清、TDD、诊断与交接方法库",
    "huangwb8/ChineseResearchLaTeX": "中文科研写作、基金申请与 LaTeX 模板相关技能",
    "HKUSTDial/Supervisor-Skills": "科研副导师式论文构思、写作、图表与评审技能",
    "local/handoff-recommended": "交接包内推荐的文档、引用、前端和测试能力",
    "local/task-tree": "本项目自研任务树构建、链式推进和子树执行技能",
    "local/open-webSearch": "联网检索工具的使用与维护技能",
    "local/agent-reach": "多平台互联网调研与内容获取路由技能",
    "Rimagination/good-story": "科研叙事与论文故事线诊断技能",
}
for item in manifest.get("by_repository", []):
    repo = item["repository"]
    repo_rows.append([repo, str(item["count"]), repo_labels.get(repo, "外部收集或本地补充技能")])

standard_mb = dir_size_mb(KIT / "standard-skills")
memory_mb = dir_size_mb(KIT / "memory-system")
metadata_mb = dir_size_mb(KIT / "metadata")
kit_mb = dir_size_mb(KIT)
cache_mb = dir_size_mb(KIT / "memory-system" / "llm-task-tree-kit" / "open-webSearch" / ".npm-cache")
light_mb = round(kit_mb - cache_mb, 2)

today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y年%m月%d日")

body: list[str] = []
body.append(para("记忆模块与 Skills 能力体系技术总结", style="Title", align="center"))
body.append(para("基于任务树的外部化工作记忆与可插拔 Agent 能力库", style="Subtitle", align="center"))
body.append(para(f"日期：{today}", align="center"))
body.append(para("本文侧重说明当前系统中“记忆模块”的技术方法与工程实现；Skills 部分仅概述能力范围、来源与集成方式。", align="center"))
body.append(page_break())

body.append(heading("1. 摘要", 1))
body.append(para(
    "本项目围绕长任务中大模型隐性上下文不可见、难以回溯、难以审计的问题，设计了一套外部化记忆模块。"
    "核心做法是将任务状态从聊天上下文中剥离出来，沉淀为 Markdown 任务树、节点字段、关系边、执行流程脚本、步骤证据和知识库索引。"
    "这样，模型每一轮不再依赖冗长的口头总结，而是读取结构化状态、执行当前节点、再把结果写回可视化任务图。"
))
body.append(para(
    f"在能力扩展层面，系统整理并安装了 {manifest['total_standard_skills']} 个标准 SKILL.md，来源包括科研写作、科学计算、工程协作、联网检索、任务树协作和本地自研技能。"
    f"其中新安装到全局目录 {manifest['global_install_dir']} 的技能为 {manifest['installed_new']} 个，已有同名技能跳过 {manifest['skipped_existing']} 个。"
    "Skills 不是一次性塞入上下文，而是通过索引、召回、选择、按需读取的 progressive disclosure 机制参与任务执行。"
))

body.append(heading("2. 设计目标与问题定义", 1))
body.append(para("当前设计主要解决四类问题。"))
for text in [
    "状态不可见：长对话中，模型知道什么、当前做到哪里、人类很难快速判断。",
    "历史与当前混杂：若把所有过程都追加到聊天或一个文档里，旧方案、废弃方法和当前结论会互相污染。",
    "执行不可审计：模型说“完成了”不足以证明完成，需要有节点结果、步骤证据、产物路径和可复查记录。",
    "能力调用不稳定：本地和外部 skills 数量多，如果全部读入上下文会浪费 token，也会增加误调用风险。",
]:
    body.append(bullet(text))
body.append(para(
    "因此，系统采用“外部工作记忆 + 可视化任务图 + 能力路由”的方式，把任务语义、执行顺序、证据和技能库分层存储。"
))

body.append(heading("3. 记忆模块总体架构", 1))
body.append(para("记忆模块不是单一文件，而是一组互相配合的状态层。每一层只承担一种职责，避免把长期背景、当前焦点、执行历史和工具说明混在一起。"))
body.append(table([
    ["层次", "主要文件/目录", "职责"],
    ["当前工作记忆", "task-tree.md", "保存当前任务图、节点语义、关系边和 GraphState，是 Agent 执行焦点的权威来源。"],
    ["历史版本", "versions/", "保存旧任务树快照，用于回溯；当前树仍是唯一权威状态。"],
    ["执行顺序", "scripts/project.json、scripts/run.json", "保存 Scratch 风格的执行流，表达任务块顺序、条件和循环结构。"],
    ["步骤证据", "scripts/steps/<nodeId>/latest/", "保存每个任务块的 step.json、中文审计报告、prompt 和输出产物。"],
    ["长期资料", "knowledge/、knowledge-index.json", "保存可检索 Markdown 知识库及可重建索引。"],
    ["技能审计", "skill-routing-log.md", "记录 skill 的选择、跳过、实际读取与结果，形成能力调用闭环。"],
], [2100, 3000, 4260]))

body.append(heading("4. 任务树数据模型", 1))
body.append(para(
    "任务树以 Markdown 为主存储格式，核心对象包括节点、边和 GraphState。选择 Markdown 的原因是可读、可 diff、可版本化，也便于模型直接编辑。"
))
body.append(heading("4.1 节点", 2))
body.append(para(
    "每个节点对应一个子问题或一个可执行任务，而不是普通清单项。节点字段包括 Problem、Approach、Input、Output、Metrics、CurrentResult、RootCauseAnalysis、CaseStudy、NextIdea 和 SelectedSkills。"
    "其中 CurrentResult 用于记录本轮已产生的可度量结果，RootCauseAnalysis 用于记录偏航或失败根因，NextIdea 用于给下一轮提供可执行入口。"
))
body.append(heading("4.2 边", 2))
body.append(para(
    "边用于表达节点之间的语义关系，例如依赖、扩展、证据、约束或方法替代。当前协议要求一条边只连接两个端点，避免多端点超边导致布局、推理和执行顺序不稳定。"
))
body.append(heading("4.3 GraphState", 2))
body.append(para(
    "GraphState 保存 Current 和 Next，用于指明当前焦点和下一步候选。系统特别将 NextPlan 降级为用户备忘，Agent 默认只根据 Next 节点的 NextIdea 执行，避免旧的用户备忘在后续轮次中被误当成新的执行命令。"
))

body.append(heading("5. 工程实现", 1))
body.append(heading("5.1 Markdown 作为可审计状态源", 2))
body.append(para(
    "task-tree.md 是人和 Agent 共同维护的状态源。前端编辑器可以直接修改节点、边、位置和字段；Agent 在完成任务后只更新最小相关节点。"
    "这种方式使状态既能被程序解析，也能被人直接阅读和手工修正。"
))
body.append(heading("5.2 可视化编辑器与版本机制", 2))
body.append(para(
    "本地 Web 前端将 Markdown 任务树渲染为图谱视图，支持节点拖动、边编辑、I/O 预览、SelectedSkills 保存、关系图和执行流程切换。"
    "每次重要写入前会生成版本快照，历史保存在 versions/，当前树保持精简状态，不承担追加式日志职责。"
))
body.append(heading("5.3 执行流程与步骤证据", 2))
body.append(para(
    "任务树表达语义关系，scripts/project.json 和 scripts/run.json 表达执行顺序。"
    "执行某个节点后，系统把可复查证据放入 scripts/steps/<nodeId>/latest/，包括机器可读 step.json、中文报告、prompt 和输出文件。"
    "这样可以把“模型说完成了”转化为“节点结果 + 证据包 + 产物路径”的可审计记录。"
))
body.append(heading("5.4 回溯与漂移处理", 2))
body.append(para(
    "任务树回滚只改变任务状态，不会自动回滚文件系统。系统把 task-tree.md 视为权威状态，把已有文件、聊天记录和旧日志视为证据。"
    "如果当前树没有记录某个产物，该产物只能作为候选草稿或 orphan artifact，不能直接证明任务已完成。"
))
body.append(heading("5.5 知识库检索", 2))
body.append(para(
    "长期资料通过 Markdown 知识库和 embedding 索引提供。知识库检索采用可配置 chunk、并发 embedding 和按文档多样化召回，避免长文档多个片段占满全部结果。"
    "检索结果可以进入节点级分析或多模型协作上下文。"
))

body.append(heading("6. Skills 能力体系", 1))
body.append(para(
    "Skills 层不是记忆模块本身，而是围绕任务图调度的可插拔能力库。系统当前整理了标准 SKILL.md 能力包，并同步安装到全局目录，便于后续项目直接复用。"
))
body.append(table(repo_rows, [3600, 1500, 4260]))
body.append(para(
    "这些 skills 大致覆盖五类能力：科研写作与论文评审、科学计算与数据分析、工程协作与代码实施、联网检索与资料收集、任务树协作与上下文维护。"
    "实际调用时，系统先基于任务节点和用户请求检索候选 skill，再按需读取对应 SKILL.md；只有 skill 明确要求时才继续读取 references、scripts 或 assets。"
))

body.append(heading("7. 打包与部署情况", 1))
body.append(table([
    ["项目", "当前结果"],
    ["标准 SKILL.md 数量", str(manifest["total_standard_skills"])],
    ["全局新安装", str(manifest["installed_new"])],
    ["同名已存在跳过", str(manifest["skipped_existing"])],
    ["全局安装目录", manifest["global_install_dir"]],
    ["迁移包当前体积", f"{kit_mb} MB"],
    ["标准 skills 目录体积", f"{standard_mb} MB"],
    ["记忆系统目录体积", f"{memory_mb} MB"],
    ["metadata 目录体积", f"{metadata_mb} MB"],
    ["可进一步裁剪项", f"open-webSearch npm cache 约 {cache_mb} MB；删后约 {light_mb} MB"],
], [3000, 6360]))
body.append(para(
    "当前可发送包已保留 standard-skills、memory-system、metadata 和 reference-only。GitHub 源码浅克隆不再作为运行必需部分；如果需要溯源，可根据 metadata 中记录的仓库重新拉取。"
))

body.append(heading("8. 技术价值与局限", 1))
body.append(para("技术价值主要体现在三个方面。"))
for text in [
    "把隐性上下文显性化：人类可以直接看到当前任务图、节点结果、阻塞点和下一步。",
    "把长任务变成可审计流程：每个节点的输入、输出、指标、结果和证据可以分开保存。",
    "把能力调用变成可治理机制：skills 通过索引和审计日志接入，而不是依赖模型临时记忆。",
]:
    body.append(bullet(text))
body.append(para(
    "当前局限也比较明确：任务树维护仍依赖 Agent 按协议写回；大型 skill 库需要持续去重和风险分级；部分专业技能依赖外部工具、网络或特定运行环境。"
    "后续可以继续加强自动 lint、轻量打包、技能质量评估和跨项目安装脚本。"
))

body.append(heading("9. 后续可推进方向", 1))
for text in [
    "建立轻量版迁移包，默认不包含源码克隆、npm 缓存和大示例素材。",
    "为 skill 路由增加命中率、误调用率、用户纠正率等评估指标。",
    "把任务树 postflight、step evidence 和 flow drift 检查进一步自动化。",
    "沉淀项目级常用 skill 白名单，减少大规模 skill 库带来的推荐噪声。",
]:
    body.append(bullet(text))


document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
 xmlns:v="urn:schemas-microsoft-com:vml"
 xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:w10="urn:schemas-microsoft-com:office:word"
 xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
 xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
 xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
 xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
 xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
 mc:Ignorable="w14 wp14">
 <w:body>
 {''.join(body)}
 <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
 </w:body>
</w:document>'''

styles_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:color w:val="4F6F8F"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="1F4E79"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="2F5597"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr></w:style>
</w:styles>'''

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
 <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''

rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''

doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>'''

settings = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>'''

now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
core = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>记忆模块与 Skills 能力体系技术总结</dc:title>
 <dc:creator>Codex</dc:creator>
 <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
 <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
 <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>'''

app = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
 <Application>Codex</Application>
</Properties>'''

OUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", document_xml)
    z.writestr("word/_rels/document.xml.rels", doc_rels)
    z.writestr("word/styles.xml", styles_xml)
    z.writestr("word/settings.xml", settings)
    z.writestr("docProps/core.xml", core)
    z.writestr("docProps/app.xml", app)

print(OUT)
