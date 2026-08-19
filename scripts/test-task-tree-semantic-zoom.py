from pathlib import Path
from time import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5410/"
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))

    def protect_tree(route):
        if route.request.method == "PUT":
            route.fulfill(status=200, content_type="application/json", body='{"ok":true,"versions":[]}')
        else:
            route.continue_()

    page.route("**/api/tree", protect_tree)
    page.goto(f"{BASE}?semantic_zoom_test={int(time())}", wait_until="domcontentloaded")
    page.locator(".graphNode").first.wait_for(state="visible", timeout=30_000)
    if page.locator("#projectOverviewDialog[open]").count():
        page.locator("#projectOverviewClose").click()

    page.locator("#layoutTreeBtn").click()
    page.wait_for_timeout(300)
    page.locator("#fitViewBtn").click()
    page.wait_for_timeout(500)

    node_count = page.locator(".graphNode").count()
    macro_count = page.locator(".nodeMacroSummary:visible").count()
    macro_auxiliary_count = page.locator(".nodeMacroRole:visible, .nodeMacroText:visible").count()
    trunk_edges = page.locator(".edgePath.nextPath").count()
    visible_edge_labels = page.locator(".edgeEditor:visible").count()
    visible_edge_hubs = page.locator(".edgeHub:visible").count()
    zoom_level = page.locator(".graphPane").get_attribute("data-zoom-level")
    scale = page.evaluate("new DOMMatrix(getComputedStyle(document.querySelector('#graphCanvas')).transform).a")
    title_px = page.locator(".graphNode.nextPath .nodeMacroTitle").first.evaluate(
        "el => parseFloat(getComputedStyle(el).fontSize)"
    )
    title_weight = page.locator(".graphNode.nextPath .nodeMacroTitle").first.evaluate(
        "el => parseInt(getComputedStyle(el).fontWeight, 10)"
    )
    physical_title_px = title_px * scale
    trunk_style = page.locator(".edgePath.nextPath").first.evaluate(
        "el => ({stroke:getComputedStyle(el).stroke, width:parseFloat(getComputedStyle(el).strokeWidth), dash:getComputedStyle(el).strokeDasharray})"
    )
    macro_sizes = page.locator(".graphNode").evaluate_all(
        "els => els.map(el => ({id:el.dataset.nodeId, width:Math.round(el.getBoundingClientRect().width), height:Math.round(el.getBoundingClientRect().height), contentLength:[...el.querySelectorAll('.coreSummaryText')].reduce((sum,item)=>sum+(item.textContent||'').trim().length,0)}))"
    )
    macro_areas = {item["id"]: item["width"] * item["height"] for item in macro_sizes}
    macro_by_content = sorted(macro_sizes, key=lambda item: item["contentLength"])
    macro_sparse_area = sum(macro_areas[item["id"]] for item in macro_by_content[:3]) / 3
    macro_rich_area = sum(macro_areas[item["id"]] for item in macro_by_content[-3:]) / 3
    unique_macro_sizes = {(item["width"], item["height"]) for item in macro_sizes}
    clipped_macro_titles = page.locator(".graphNode").evaluate_all(
        "els => els.filter(el => { const title=el.querySelector('.nodeMacroTitle'); if(!title) return false; const a=el.getBoundingClientRect(); const b=title.getBoundingClientRect(); return b.left < a.left - 1 || b.right > a.right + 1 || b.top < a.top - 1 || b.bottom > a.bottom + 1; }).map(el => el.dataset.nodeId)"
    )

    assert zoom_level in ("宏观", "结构"), zoom_level
    assert macro_count == node_count and node_count > 0, (macro_count, node_count)
    assert macro_auxiliary_count == 0, macro_auxiliary_count
    assert trunk_edges >= 2, trunk_edges
    assert visible_edge_labels == 0, visible_edge_labels
    assert visible_edge_hubs == 0, visible_edge_hubs
    assert 15.5 <= physical_title_px <= 16.5, physical_title_px
    assert title_weight >= 700, title_weight
    assert trunk_style["width"] >= 8, trunk_style
    assert trunk_style["dash"] in ("none", "0px"), trunk_style
    assert len(unique_macro_sizes) >= 4, macro_sizes
    assert macro_rich_area > macro_sparse_area * 1.08, (macro_sparse_area, macro_rich_area)
    assert not clipped_macro_titles, clipped_macro_titles
    assert not errors, errors
    page.screenshot(path=str(ARTIFACTS / "task-tree-semantic-zoom-macro.png"), full_page=True)

    root_rect = page.locator('.graphNode[data-node-id="ROOT"]').bounding_box()
    assert root_rect
    for _ in range(14):
        page.locator("#graphViewport").dispatch_event(
            "wheel",
            {
                "deltaY": -700,
                "clientX": root_rect["x"] + root_rect["width"] / 2,
                "clientY": root_rect["y"] + root_rect["height"] / 2,
            },
        )
        if page.locator(".graphPane").get_attribute("data-zoom-level") == "细节":
            break
    page.wait_for_timeout(300)
    detail_level = page.locator(".graphPane").get_attribute("data-zoom-level")
    normal_titles = page.locator(".graphNode .nodeTitle:visible").count()
    detail_sizes = page.locator(".graphNode").evaluate_all(
        "els => els.map(el => ({id:el.dataset.nodeId, width:Math.round(el.getBoundingClientRect().width), height:Math.round(el.getBoundingClientRect().height), contentLength:[...el.querySelectorAll('.coreSummaryText')].reduce((sum,item)=>sum+(item.textContent||'').trim().length,0)}))"
    )
    detail_areas = {item["id"]: item["width"] * item["height"] for item in detail_sizes}
    detail_by_content = sorted(detail_sizes, key=lambda item: item["contentLength"])
    detail_sparse_area = sum(detail_areas[item["id"]] for item in detail_by_content[:3]) / 3
    detail_rich_area = sum(detail_areas[item["id"]] for item in detail_by_content[-3:]) / 3
    unique_detail_sizes = {(item["width"], item["height"]) for item in detail_sizes}
    assert detail_level == "细节", detail_level
    assert normal_titles > 0, normal_titles
    assert len(unique_detail_sizes) >= 4, detail_sizes
    assert detail_rich_area > detail_sparse_area * 1.08, (detail_sparse_area, detail_rich_area)
    detail_overlaps = page.locator(".graphNode").evaluate_all(
        "els => { const items=els.map(el=>({id:el.dataset.nodeId,rect:el.getBoundingClientRect()})); const overlaps=[]; for(let i=0;i<items.length;i+=1){ for(let j=i+1;j<items.length;j+=1){ const a=items[i],b=items[j]; const w=Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left); const h=Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top); if(w>2&&h>2) overlaps.push(`${a.id}/${b.id}`); }} return overlaps; }"
    )
    assert not detail_overlaps, detail_overlaps
    assert not errors, errors
    page.screenshot(path=str(ARTIFACTS / "task-tree-semantic-zoom-detail.png"), full_page=True)

    print(
        f"nodes={node_count}; macro={macro_count}; trunkEdges={trunk_edges}; "
        f"fitScale={scale:.3f}; physicalTitle={physical_title_px:.1f}px; "
        f"titleWeight={title_weight}; macroSizes={len(unique_macro_sizes)}; "
        f"detailSizes={len(unique_detail_sizes)}; detailTitles={normal_titles}; errors=0"
    )
    browser.close()
