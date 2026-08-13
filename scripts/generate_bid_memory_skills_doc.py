from __future__ import annotations

import html
import json
import re
import struct
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "dist" / "skills-memory-transfer-kit"
TEMPLATE = Path(r"C:\Users\Administrator\Desktop\标书修改\8.6_技术参数证明文件.docx")
OUT = KIT / "8.6_技术参数证明文件_记忆模块与Skills.docx"
SCREENSHOT_DIR = KIT / "evidence" / "screenshots"

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "rels": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}

for prefix, uri in NS.items():
    if prefix not in {"rels", "ct"}:
        ET.register_namespace(prefix, uri)


def esc(text: object) -> str:
    return html.escape(str(text), quote=False)


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Not a PNG: {path}")
    return struct.unpack(">II", data[16:24])


def run(text: object, bold: bool = False, size: int | None = None, color: str | None = None) -> str:
    props = ['<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/>']
    if bold:
        props.append("<w:b/>")
    if size:
        props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    return f"<w:r><w:rPr>{''.join(props)}</w:rPr><w:t>{esc(text)}</w:t></w:r>"


def para(
    text: object = "",
    *,
    style: str | None = None,
    bold: bool = False,
    size: int | None = None,
    color: str | None = None,
    align: str | None = None,
    before: int = 0,
    after: int = 120,
    indent: int | None = None,
) -> str:
    ppr: list[str] = []
    if style:
        ppr.append(f'<w:pStyle w:val="{style}"/>')
    if indent:
        ppr.append(f'<w:ind w:left="{indent}" w:firstLine="0"/>')
    if align:
        ppr.append(f'<w:jc w:val="{align}"/>')
    ppr.append(f'<w:spacing w:before="{before}" w:after="{after}" w:line="360" w:lineRule="auto"/>')
    return f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{run(text, bold=bold, size=size, color=color)}</w:p>"


def heading(text: str, level: int) -> str:
    if level == 1:
        return para(text, style="Heading1", bold=True, size=32, before=240, after=160)
    return para(text, style="Heading2", bold=True, size=28, before=180, after=120)


def proof_pair(requirement: str, implementation: str) -> list[str]:
    return [
        para(f'"招标指标要求"：{requirement}', after=90),
        para(f'"技术实现说明"：{implementation}', after=160),
    ]


def numbered(items: list[str]) -> list[str]:
    return [para(f"{i}. {item}", indent=420, after=80) for i, item in enumerate(items, 1)]


def cell(text: object, width: int, header: bool = False) -> str:
    shade = '<w:shd w:fill="D9EAF7" w:val="clear"/>' if header else ""
    bold = header
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>'
        '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/>'
        '<w:left w:val="single" w:sz="4" w:color="BFBFBF"/>'
        '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/>'
        '<w:right w:val="single" w:sz="4" w:color="BFBFBF"/></w:tcBorders>'
        f'<w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/>'
        f'<w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar>{shade}</w:tcPr>'
        f"{para(text, bold=bold, after=60)}</w:tc>"
    )


def table(rows: list[list[object]], widths: list[int]) -> str:
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    body = []
    for row_idx, row in enumerate(rows):
        tcs = "".join(cell(value, widths[col_idx], header=(row_idx == 0)) for col_idx, value in enumerate(row))
        body.append(f"<w:tr>{tcs}</w:tr>")
    return (
        '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/>'
        '<w:tblLook w:firstRow="1" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{''.join(body)}</w:tbl>"
    )


def image_paragraph(rel_id: str, image_path: Path, caption: str, max_width_in: float = 6.35) -> str:
    width_px, height_px = png_size(image_path)
    width_in = min(max_width_in, width_px / 144.0)
    height_in = width_in * height_px / width_px
    cx = int(width_in * 914400)
    cy = int(height_in * 914400)
    name = esc(caption)
    drawing = f"""
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="80"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="{cx}" cy="{cy}"/>
            <wp:docPr id="{rel_id.replace('rIdEvidence', '')}" name="{name}"/>
            <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr><pic:cNvPr id="0" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>
                  <pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                  <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    """
    return drawing + para(caption, align="center", size=20, color="666666", after=160)


def page_break() -> str:
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'


def load_metrics() -> dict[str, object]:
    manifest = json.loads((KIT / "manifest.json").read_text(encoding="utf-8"))
    total = sum(p.stat().st_size for p in KIT.rglob("*") if p.is_file())
    standard = sum(p.stat().st_size for p in (KIT / "standard-skills").rglob("*") if p.is_file())
    memory = sum(p.stat().st_size for p in (KIT / "memory-system").rglob("*") if p.is_file())
    return {
        "skills": manifest.get("total_standard_skills", 241),
        "installed_new": manifest.get("installed_new", 226),
        "skipped_existing": manifest.get("skipped_existing", 15),
        "size_mb": round(total / 1024 / 1024, 2),
        "standard_mb": round(standard / 1024 / 1024, 2),
        "memory_mb": round(memory / 1024 / 1024, 2),
        "files": sum(1 for p in KIT.rglob("*") if p.is_file()),
        "chunks": 1552,
        "nodes": 13,
        "edges": 15,
        "versions": 208,
    }


def build_body(sect_pr: str, image_map: list[tuple[str, Path, str]]) -> str:
    m = load_metrics()
    parts: list[str] = []
    parts.append(para("8.6 技术参数证明文件", align="center", bold=True, size=36, after=160))
    parts.append(para("记忆模块与 Skills 能力体系", align="center", bold=True, size=30, after=120))
    parts.append(para("基于任务树的外部化工作记忆、执行证据链与可插拔 Agent 能力库", align="center", size=22, color="666666", after=260))
    parts.append(
        para(
            f"本文件依据现有项目实现与迁移包产物编制，重点证明“记忆模块”和“Skills 能力模块”的技术参数、工程实现与创新性。当前迁移包包含 {m['skills']} 个标准 SKILL.md，已补装全局 skills {m['installed_new']} 个，同名跳过 {m['skipped_existing']} 个；项目任务图当前包含 {m['nodes']} 个节点、{m['edges']} 条语义边、{m['versions']} 个版本快照，知识库索引显示 {m['chunks']} 个 chunk。",
            after=220,
        )
    )

    parts.append(heading("一、带★主要技术参数", 1))

    parts.append(heading("★ 统一任务记忆与状态外置化", 2))
    parts.extend(
        proof_pair(
            "系统应支持将复杂长任务中的目标、阶段、输入输出、执行结果、失败原因、下一步动作和历史版本进行持续沉淀，避免上下文丢失，并支持人机共同查看与维护。",
            "本项目以 task-tree.md 作为外部化工作记忆的主账本，将隐性对话上下文转化为可读、可审计、可版本化的 Markdown 任务图。每个节点包含 Problem、Approach、Input、Output、Metrics、CurrentResult、RootCauseAnalysis、CaseStudy、NextIdea 等字段，边用于保存节点之间的语义依赖关系，GraphState.Current 与 GraphState.Next 用于明确当前焦点与下一候选任务。该设计把模型短期上下文中的“正在做什么、为什么这么做、做到哪里、下一步是什么”显式固化到文件系统，支持跨会话恢复、人工检查和多 Agent 续接。",
        )
    )
    parts.append(
        table(
            [
                ["证明项", "当前实现", "工程证据"],
                ["外部化工作记忆", "task-tree.md 保存任务语义、节点字段、关系边和 GraphState", "任务图 UI 可直接编辑并自动落盘"],
                ["版本化状态恢复", f"版本树保留 {m['versions']} 个快照", "versions/ 保存历史，当前树保持紧凑状态"],
                ["节点级可审计结果", "CurrentResult、RootCauseAnalysis、CaseStudy 分字段存储", "避免把计划、失败和结果混写"],
                ["人机协同控制", "Current/Next/NextIdea 与 UI 按钮联动", "Agent 不直接执行用户备忘型 NextPlan"],
            ],
            [2100, 3900, 3360],
        )
    )
    parts.append(image_paragraph(*image_map[0]))

    parts.append(heading("★ Skills 可插拔能力库与自动路由", 2))
    parts.extend(
        proof_pair(
            "系统应支持可扩展能力模块管理，能够按照任务类型选择对应工具化能力，并对能力来源、描述、安装状态和调用记录进行管理。",
            f"Skills 模块采用标准 SKILL.md 作为能力单元，每个 skill 由名称、description、触发条件、执行步骤、可选 references/scripts/assets 组成。当前打包后的能力库包含 {m['skills']} 个标准 skills，来源覆盖科研写作、中文 LaTeX/国自然、故事写作、工程技能、科学计算与多 Agent 协作等仓库；同时把本地缺失能力安装到全局目录 C:\\Users\\Administrator\\.codex\\skills，实现可迁移、可复用、可被 Agent progressive disclosure 加载的能力层。",
        )
    )
    parts.append(
        table(
            [
                ["能力类别", "代表功能", "路由价值"],
                ["记忆/任务树类", "task-tree-grill、chain-run、subtree-run", "规范任务图维护、链式推进和子树并行协作"],
                ["科研写作类", "paper-writer、paper-polish、citation-verification、NSFC 系列", "将论文、标书、综述等高频任务封装为专业流程"],
                ["科学计算类", "scanpy、rdkit、pymc、qiskit、transformers 等", "按领域工具栈加载细分指导，减少泛化回答"],
                ["工程质量类", "diagnose、tdd、code-review、frontend-design", "在调试、测试、评审和界面实现时形成可复用规范"],
            ],
            [2100, 3700, 3560],
        )
    )
    parts.append(image_paragraph(*image_map[1]))

    parts.append(page_break())
    parts.append(heading("二、带▲关键技术指标", 1))

    sections = [
        (
            "▲ 2.1 任务树记忆数据模型",
            "模块应支持长任务拆解、节点关系表达、当前状态定位、输入输出样例和结果证据记录。",
            "任务树采用“节点字段 + 二元关系边 + GraphState”的数据模型。节点不是普通 checklist，而是一个可审计的推理单元：Problem 写一个子问题，Approach 写当前有效方法，Metrics 写可测量标准，CurrentResult 写已验证事实，RootCauseAnalysis 写失败或偏航根因，NextIdea 写下一步可执行建议。关系边只连接两个节点，用 Label/Notes 说明依赖含义，保证布局、解析和审计都稳定。",
        ),
        (
            "▲ 2.2 执行流与语义记忆分离",
            "模块应支持任务语义与执行顺序分离，便于人工调整流程、Agent 追踪步骤和后续审计。",
            "项目将 task-tree.md 作为“语义账本”，将 scripts/project.json 与 scripts/run.json 作为“执行账本”。语义树回答为什么做、做什么、证据是什么；执行流回答按什么顺序做。流程视图以类 Scratch 模块呈现，每个任务块绑定 nodeId 和完成态，避免仅靠节点编号或画布位置推断执行顺序。",
        ),
        (
            "▲ 2.3 步骤证据与可追溯审计",
            "模块应支持对关键执行步骤形成可追溯证据，包括执行输入、输出、prompt、代码位置和报告。",
            "每个流程 task 块可对应 scripts/steps/<nodeId>/latest/ 审计包，其中 step.json 保存机器可读索引，report.zh.md 作为中文入口，prompts/ 保存原始提示与中文备份，outputs/ 保存产物。该机制把“模型说完成”转化为“文件、指标、截图、命令结果可查”的证据链。",
        ),
        (
            "▲ 2.4 长期知识库与检索增强",
            "模块应支持将项目资料、论文、说明文档和历史材料转化为可检索长期记忆，并控制检索范围和证据多样性。",
            f"当前知识库面板显示 {m['chunks']} 个索引 chunk，支持按一级文件夹形成独立知识库，支持当前库/全部库检索、topK、chunk 大小、重叠、候选池倍数和每篇最多段数配置。检索多样性策略按论文 path 轮询去重，避免检索结果被单篇长文档垄断，从工程上提高跨资料引用覆盖率。",
        ),
        (
            "▲ 2.5 Skills Progressive Disclosure 加载机制",
            "模块应支持按任务需要逐步加载能力说明，避免一次性加载全部能力造成上下文污染和执行噪声。",
            "Skills 路由采用“先索引、再召回、后读取”的渐进式加载：常驻上下文只保存 skill 名称、description 和路径；当用户明确点名或任务描述命中时，Agent 才读取对应 SKILL.md；只有 SKILL.md 明确引用 references/scripts/assets 时才继续读取下级材料。该机制兼顾能力规模、上下文预算和安全边界，尤其适合 200+ skills 的大型能力库。",
        ),
        (
            "▲ 2.6 迁移打包与全局安装",
            "模块应支持将记忆系统和能力库打包为可交付目录，并具备在新项目中快速复用的安装路径。",
            f"当前迁移包位于 dist/skills-memory-transfer-kit，删减后大小约 {m['size_mb']} MB，共 {m['files']} 个文件；其中 standard-skills 约 {m['standard_mb']} MB，memory-system 约 {m['memory_mb']} MB。包内包含 README、manifest、skill-index、中文 skills 描述、安装报告、记忆系统说明和截图证据，可作为另一个项目的即插即用迁移材料。",
        ),
    ]
    for title, requirement, implementation in sections:
        parts.append(heading(title, 2))
        parts.extend(proof_pair(requirement, implementation))
        if title.startswith("▲ 2.3"):
            parts.append(image_paragraph(*image_map[2]))

    parts.append(page_break())
    parts.append(heading("三、其它一般技术指标", 1))

    parts.append(heading("3.1 模块功能清单", 2))
    parts.append(
        table(
            [
                ["模块", "主要功能", "工程落点"],
                ["当前工作记忆", "任务目标、方法、输入输出、评价指标、结果、根因、下一步", "task-tree.md"],
                ["历史记忆", "版本快照、回滚证据、漂移判断", "versions/"],
                ["执行记忆", "流程块、任务状态、步骤审计包", "scripts/project.json、scripts/steps/"],
                ["长期资料记忆", "Markdown 文档库、索引、检索多样性配置", "knowledge/、knowledge-index.json"],
                ["Skills 能力库", "标准能力定义、描述索引、全局安装、路由日志", "standard-skills/、metadata/、skill-routing-log.md"],
                ["迁移交付", "轻量包、中文说明、安装报告、截图证据", "dist/skills-memory-transfer-kit"],
            ],
            [1800, 4200, 3360],
        )
    )

    parts.append(heading("3.2 新颖性与技术特点", 2))
    parts.extend(
        numbered(
            [
                "外部化工作记忆：不是依赖模型聊天历史，而是把任务状态变成可读、可 diff、可回滚的结构化 Markdown 图。",
                "语义图与执行流双账本：任务树表达问题依赖，流程脚本表达执行顺序，两者同步但不混写，便于审计和人工调整。",
                "节点级证据闭环：结果、根因、案例、输入输出和步骤审计分层存储，使 Agent 工作从“口头完成”转向“证据可查”。",
                "大规模 Skills 的渐进式加载：241 个 skills 不直接进入上下文，只在命中任务时读取相关 SKILL.md，降低噪声和提示注入风险。",
                "人机共同维护机制：UI 负责 Current/Next 选择、版本树回退和可视化编辑；Agent 负责小范围结果写回和校验，减少长对话漂移。",
            ]
        )
    )

    parts.append(heading("3.3 证明材料清单", 2))
    parts.append(
        table(
            [
                ["材料", "路径或数值", "说明"],
                ["迁移包目录", str(KIT), "包含记忆系统、skills、元数据和截图证据"],
                ["标准 skills 数量", m["skills"], "以标准 SKILL.md 为统计口径"],
                ["全局安装结果", f"新增 {m['installed_new']} 个，跳过 {m['skipped_existing']} 个", "安装报告见 metadata/github-skill-install-report.zh.md"],
                ["包体大小", f"{m['size_mb']} MB", "用户删减后的当前包体积"],
                ["截图证据", "evidence/screenshots/*.png", "工作台、skill 节点、执行流程三类截图"],
            ],
            [2300, 3900, 3160],
        )
    )

    parts.append(heading("3.4 后续可扩展方向", 2))
    parts.extend(
        numbered(
            [
                "为每个 skill 增加 trust level、source、risk 和适用边界字段，用于更细粒度的自动路由。",
                "将 skill 调用日志转化为离线评估集，统计命中率、误召回率和人工纠正次数。",
                "把记忆节点与执行证据包关联为可视化审计链，支持一键导出项目复盘报告。",
                "在迁移包中加入安装脚本和健康检查脚本，进一步降低新项目接入成本。",
            ]
        )
    )

    return f'<w:body>{"".join(parts)}{sect_pr}</w:body>'


def extract_sect_pr(template_zip: zipfile.ZipFile) -> str:
    root = ET.fromstring(template_zip.read("word/document.xml"))
    sect = root.find(".//w:sectPr", NS)
    if sect is None:
        return (
            '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
            "</w:sectPr>"
        )
    return ET.tostring(sect, encoding="unicode")


def next_rel_id(rels_root: ET.Element) -> int:
    ids = []
    for rel in rels_root.findall("rels:Relationship", NS):
        rid = rel.attrib.get("Id", "")
        match = re.match(r"rId(\d+)$", rid)
        if match:
            ids.append(int(match.group(1)))
    return max(ids, default=0) + 1


def ensure_png_content_type(content_types_xml: bytes) -> bytes:
    root = ET.fromstring(content_types_xml)
    has_png = any(el.attrib.get("Extension") == "png" for el in root.findall("ct:Default", NS))
    if not has_png:
        ET.SubElement(root, f"{{{NS['ct']}}}Default", {"Extension": "png", "ContentType": "image/png"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def main() -> None:
    if not TEMPLATE.exists():
        raise FileNotFoundError(TEMPLATE)
    screenshots = [
        (SCREENSHOT_DIR / "01-task-tree-overview.png", "图 1 任务树工作台总览：知识库、任务图、版本树共同构成外部化记忆界面"),
        (SCREENSHOT_DIR / "02-skill-routing-panel-wide.png", "图 2 Skills 节点与能力选择：N4 节点展示已选能力、管理入口和 skill 路由结果"),
        (SCREENSHOT_DIR / "03-execution-flow.png", "图 3 执行流程与步骤审计：语义任务树与流程脚本分离，任务块保留完成态和审计入口"),
    ]
    for path, _ in screenshots:
        if not path.exists():
            raise FileNotFoundError(path)

    image_map: list[tuple[str, Path, str]] = []
    with zipfile.ZipFile(TEMPLATE, "r") as zin:
        sect_pr = extract_sect_pr(zin)
        rels_root = ET.fromstring(zin.read("word/_rels/document.xml.rels"))
        rel_num = next_rel_id(rels_root)
        media_entries: list[tuple[str, Path]] = []
        for idx, (path, caption) in enumerate(screenshots, 1):
            rel_id = f"rIdEvidence{idx}"
            target = f"media/evidence_{idx:02d}.png"
            ET.SubElement(
                rels_root,
                f"{{{NS['rels']}}}Relationship",
                {
                    "Id": rel_id,
                    "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                    "Target": target,
                },
            )
            media_entries.append((f"word/{target}", path))
            image_map.append((rel_id, path, caption))
            rel_num += 1

        document_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            f"{build_body(sect_pr, image_map)}</w:document>"
        ).encode("utf-8")
        rels_xml = ET.tostring(rels_root, encoding="utf-8", xml_declaration=True)
        content_types_xml = ensure_png_content_type(zin.read("[Content_Types].xml"))

        OUT.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            skipped = {"word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"}
            for item in zin.infolist():
                if item.filename in skipped:
                    continue
                zout.writestr(item, zin.read(item.filename))
            zout.writestr("[Content_Types].xml", content_types_xml)
            zout.writestr("word/_rels/document.xml.rels", rels_xml)
            zout.writestr("word/document.xml", document_xml)
            for arcname, path in media_entries:
                zout.writestr(arcname, path.read_bytes())

    print(f"generated: {OUT}")


if __name__ == "__main__":
    main()
