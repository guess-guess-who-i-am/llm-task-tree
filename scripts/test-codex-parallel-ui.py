import json
import sys
from playwright.sync_api import sync_playwright


base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5410"

jobs = [
    {
        "taskId": "ui",
        "nodeId": "N2",
        "title": "界面",
        "instruction": "实现两次审核界面",
        "writeSet": ["public/**"],
        "dependsOn": [],
        "tests": ["node scripts/test-ui.mjs"],
        "status": "planned",
        "testResults": [],
    },
    {
        "taskId": "server",
        "nodeId": "N3",
        "title": "服务",
        "instruction": "实现隔离运行状态机",
        "writeSet": ["server/**"],
        "dependsOn": [],
        "tests": ["node scripts/test-server.mjs"],
        "status": "planned",
        "testResults": [],
    },
]


def run(status, current_jobs=None):
    value = {
        "id": "run-12345678",
        "status": status,
        "summary": "前后端独立执行，合并后统一回归。",
        "jobs": current_jobs or jobs,
        "integrationTests": ["node scripts/test-all.mjs"],
        "integrationTestResults": [],
        "coordinator": None,
        "review": None,
        "events": [],
        "error": "",
    }
    if status == "approved":
        value["jobs"] = [{**job, "status": "queued"} for job in jobs]
    if status == "review":
        value["jobs"] = [
            {**job, "status": "completed", "testResults": [{"command": job["tests"][0], "ok": True, "exitCode": 0}]}
            for job in jobs
        ]
        value["integrationTestResults"] = [{"command": "node scripts/test-all.mjs", "ok": True, "exitCode": 0}]
        value["coordinator"] = {"status": "completed", "threadId": "coordinator-thread"}
        value["review"] = {
            "readyToAccept": True,
            "summary": "自动并行流程已通过验收。",
            "changedFiles": ["public/app.js", "server/codex-coordinator.js"],
            "stat": "2 files changed",
            "patchPreview": "diff --git a/public/app.js b/public/app.js",
            "warnings": [],
        }
    if status == "accepted":
        value.update(run("review"))
        value["status"] = "accepted"
        value["review"]["appliedFiles"] = value["review"]["changedFiles"]
    return value


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    thread_menu = json.dumps({"threads": [], "pinned": "", "presets": []})
    page.route("**/api/codex/threads", lambda route: route.fulfill(status=200, content_type="application/json", body=thread_menu))
    page.route("**/api/codex/parallel/plan", lambda route: route.fulfill(status=201, content_type="application/json", body=json.dumps({"run": run("draft")})))
    page.route("**/api/codex/parallel/run-12345678/approve", lambda route: route.fulfill(status=202, content_type="application/json", body=json.dumps({"run": run("approved")})))
    page.route("**/api/codex/parallel/run-12345678", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"run": run("review")})))
    page.route("**/api/codex/parallel/run-12345678/accept", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"run": run("accepted")})))
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(base_url, wait_until="networkidle")
    page.locator("#codexThreadsBtn").click()
    page.locator("#codexParallelMenuItem").click()
    dialog = page.locator("#codexParallelDialog")
    assert dialog.is_visible()
    rows = dialog.locator("tbody tr")
    assert rows.count() == 2
    assert dialog.locator("#codexParallelState").get_by_text("开始审核", exact=False).is_visible()
    assert rows.nth(0).locator(".codexParallelInstruction").is_editable()

    with page.expect_request("**/api/codex/parallel/run-12345678/approve") as approved_request:
        dialog.locator("#codexParallelStart").click()
    assert len(approved_request.value.post_data_json["jobs"]) == 2
    dialog.locator("#codexParallelAccept").wait_for(state="visible")
    assert dialog.locator("#codexParallelFiles").inner_text() == "2 个文件"
    assert dialog.locator("#codexParallelTests").inner_text() == "3/3 通过"
    assert "diff --git" in dialog.locator("#codexParallelPatch").inner_text()
    dialog.locator("#codexParallelAccept").click()
    dialog.locator("#codexParallelState").get_by_text("已接受", exact=False).wait_for()
    assert not errors, errors

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
    mobile.route("**/api/codex/parallel/plan", lambda route: route.fulfill(status=201, content_type="application/json", body=json.dumps({"run": run("draft")})))
    mobile.goto(base_url, wait_until="networkidle")
    mobile.locator("#codexThreadsBtn").click()
    mobile.locator("#codexParallelMenuItem").click()
    mobile_dialog = mobile.locator("#codexParallelDialog")
    mobile_dialog.locator("tbody tr").nth(1).wait_for()
    box = mobile_dialog.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390
    assert mobile_dialog.locator(".codexParallelTableWrap").evaluate("el => el.scrollWidth > el.clientWidth")
    browser.close()

print("PASS automatic parallel dialog exposes only start and end review on desktop and mobile")
