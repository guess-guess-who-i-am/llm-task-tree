import os
from playwright.sync_api import sync_playwright


port = os.environ.get("PORT", "5199")
base_url = f"http://127.0.0.1:{port}"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    console_errors = []
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

    # The app polls tree/backend state continuously, so networkidle is not a stable readiness signal.
    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_function("document.querySelectorAll('#treeSelect option').length >= 2")

    page.wait_for_function("document.querySelector('#projectOverviewDialog').open")
    assert "N11" in page.locator("#projectOverviewMeta").inner_text()
    assert "下一次只做这一件事" in page.locator("#projectOverviewBody").inner_text()
    page.locator("[data-overview-mode='all']").click()
    page.wait_for_function("document.querySelectorAll('.overviewNodeRow').length === document.querySelectorAll('.graphNode').length")
    assert page.locator(".overviewNodeRow").count() >= 10
    page.locator("#projectOverviewClose").click()
    assert not page.locator("#projectOverviewDialog").evaluate("el => el.open")

    options = page.locator("#treeSelect option").all_text_contents()
    assert any("方法迭代" in item for item in options), options
    assert any("项目背景支撑" in item for item in options), options
    assert page.locator("#treeSelect").input_value() == "method"
    assert page.locator(".graphViewBtn[data-graph-view='flow']").is_enabled()
    assert "绑定执行流" in page.locator("#activeMethodBadge").inner_text()
    assert "Agent 不执行" in page.locator(".nextPlanLabel").inner_text()
    assert all("唯一执行依据" in text for text in page.locator(".nextIdeaLabel").all_inner_texts())

    page.locator("#treeSelect").select_option("background")
    page.wait_for_function("document.querySelector('#treeSelect').value === 'background' && document.querySelector('#subtitle').textContent.includes('项目背景支撑')")
    page.wait_for_function("[...document.querySelectorAll('.nodeTitle')].some(el => el.textContent.includes('让人类持续看懂并控制大模型任务'))")
    assert "tree=background" in page.url
    assert page.locator(".graphViewBtn[data-graph-view='flow']").is_disabled()
    assert "不进入执行流" in page.locator("#activeMethodBadge").inner_text()
    assert page.locator(".nodeTitle", has_text="让人类持续看懂并控制大模型任务").count() == 1
    assert page.locator(".chainDock").evaluate("el => el.classList.contains('hidden')")

    page.locator("#treeSelect").select_option("method")
    page.wait_for_function("document.querySelector('#treeSelect').value === 'method' && document.querySelector('#subtitle').textContent.includes('方法迭代')")
    page.wait_for_timeout(250)
    assert page.locator(".graphViewBtn[data-graph-view='flow']").is_enabled()
    assert not page.locator(".chainDock").evaluate("el => el.classList.contains('hidden')")
    assert not console_errors, console_errors

    print("PASS UI switches method/background trees without flow leakage")
    browser.close()
