import json
import sys
from playwright.sync_api import sync_playwright


base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5410"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    thread_menu = json.dumps({"threads": [], "pinned": "", "presets": []})
    page.route("**/api/codex/threads", lambda route: route.fulfill(status=200, content_type="application/json", body=thread_menu))
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(base_url, wait_until="networkidle")
    page.locator("#codexThreadsBtn").click()
    page.locator("#codexParallelMenuItem").click()
    dialog = page.locator("#codexParallelDialog")
    assert dialog.is_visible()
    rows = dialog.locator("tbody tr")
    assert rows.count() >= 2

    for index in range(2):
        row = rows.nth(index)
        row.locator(".codexParallelEnabled").check()
        row.locator(".codexParallelInstruction").fill(f"task {index + 1}")
    rows.nth(0).locator(".codexParallelWriteSet").fill("public/**")
    rows.nth(1).locator(".codexParallelWriteSet").fill("public/app.js")
    dialog.locator("#codexParallelStart").click()
    dialog.locator("#codexParallelState").get_by_text("写集冲突", exact=False).wait_for()
    unexpected_errors = [message for message in errors if "400 (Bad Request)" not in message]
    assert not unexpected_errors, unexpected_errors

    response = page.request.post(
        f"{base_url}/api/codex/parallel",
        data={
            "jobs": [
                {"nodeId": "N2", "instruction": "x", "writeSet": ["public/**"]},
                {"nodeId": "N3", "instruction": "y", "writeSet": ["task-tree.md"]},
            ]
        },
    )
    assert response.status == 400
    assert "共享状态" in response.json()["error"]

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile.route("**/api/codex/threads", lambda route: route.fulfill(status=200, content_type="application/json", body=thread_menu))
    mobile.goto(base_url, wait_until="networkidle")
    mobile.locator("#codexThreadsBtn").click()
    mobile.locator("#codexParallelMenuItem").click()
    mobile_dialog = mobile.locator("#codexParallelDialog")
    box = mobile_dialog.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390
    assert mobile_dialog.locator(".codexParallelTableWrap").evaluate("el => el.scrollWidth > el.clientWidth")
    browser.close()

print("PASS parallel Codex dialog renders, rejects conflicting leases, and stays usable on mobile")
