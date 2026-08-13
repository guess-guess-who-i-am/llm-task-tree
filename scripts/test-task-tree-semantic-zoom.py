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
    assert not errors, errors
    page.screenshot(path=str(ARTIFACTS / "task-tree-semantic-zoom-macro.png"), full_page=True)

    for _ in range(18):
        page.locator("#graphViewport").dispatch_event(
            "wheel", {"deltaY": -700, "clientX": 80, "clientY": 80}
        )
    page.wait_for_timeout(300)
    detail_level = page.locator(".graphPane").get_attribute("data-zoom-level")
    normal_titles = page.locator(".graphNode .nodeTitle:visible").count()
    assert detail_level == "细节", detail_level
    assert normal_titles > 0, normal_titles
    assert not errors, errors
    page.screenshot(path=str(ARTIFACTS / "task-tree-semantic-zoom-detail.png"), full_page=True)

    print(
        f"nodes={node_count}; macro={macro_count}; trunkEdges={trunk_edges}; "
        f"fitScale={scale:.3f}; physicalTitle={physical_title_px:.1f}px; "
        f"titleWeight={title_weight}; detailTitles={normal_titles}; errors=0"
    )
    browser.close()
