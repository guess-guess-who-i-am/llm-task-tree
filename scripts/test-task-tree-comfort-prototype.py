from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5411/task-tree-prototype/index.html"
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)

variants = {
    "a": ".tta-node",
    "b": "[data-focus-card], .ttb-relative, .ttb-map [role='button']",
    "c": ".ttvc-branch-trigger",
}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    results = []
    for width, height, viewport_name in [(1600, 1000, "desktop"), (390, 844, "mobile")]:
        for key, selector in variants.items():
            page = browser.new_page(viewport={"width": width, "height": height})
            errors = []
            page.on("console", lambda msg, errors=errors: errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda exc, errors=errors: errors.append(str(exc)))
            page.goto(f"{BASE}?variant={key}")
            page.wait_for_load_state("networkidle")
            page.locator(selector).first.wait_for(state="visible")
            node_count = page.locator(selector).count()
            overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1")
            label = page.locator("#variantLabel").inner_text().strip().lower()
            assert label == key, f"variant label mismatch: expected {key}, got {label}"
            assert node_count > 0, f"variant {key} rendered no interactive tree objects"
            assert not overflow, f"variant {key} has page-level horizontal overflow at {width}px"
            assert not errors, f"variant {key} console errors: {errors}"
            page.locator(selector).first.click()
            page.screenshot(path=str(ARTIFACTS / f"task-tree-prototype-{key}-{viewport_name}.png"), full_page=True)
            results.append(f"{key}-{viewport_name}: objects={node_count}, overflow={overflow}, errors=0")
            page.close()

    page = browser.new_page(viewport={"width": 1200, "height": 800})
    page.goto(f"{BASE}?variant=a")
    page.wait_for_load_state("networkidle")
    page.locator("#variantNext").click()
    assert "variant=b" in page.url
    page.keyboard.press("ArrowRight")
    assert "variant=c" in page.url
    results.append("switcher: button and keyboard cycling passed")
    page.close()
    browser.close()

print("\n".join(results))
