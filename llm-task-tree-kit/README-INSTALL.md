# LLM Task Tree - Install Guide

## For you (share with others)

1. Send **`LLMTaskTree-Setup.zip`** (build with `scripts/build-dist.ps1`)
2. Friend extracts the zip anywhere (Desktop is fine)
3. Double-click **`Setup.cmd`**
4. Pick install folder on any drive (example: `D:\Apps\LLMTaskTree`)
5. Done

## After install

In **Windows File Explorer** (not Cursor sidebar):

| Right-click menu | Action |
|------------------|--------|
| **Install LLM Task Tree** | Create task tree in that folder (`task-tree.md`, `llm-task-tree/`, merge `AGENTS.md`) |
| **Open Task Tree** | Open the task graph UI for that folder |

## Requirements

- Windows 10/11
- Node.js 18+ (https://nodejs.org/)

## Uninstall

Run **`Uninstall.cmd`** in the install folder.

## Repair

Run **`Setup.cmd`** again from the install folder to re-register the right-click menu.

## One-click update (any PC, any path)

1. Copy/extract the kit folder **anywhere** (USB, Desktop, network share)
2. Double-click **`Update.cmd`** or **`一键更新.cmd`**
3. First run on a PC: pick that PC's install folder
4. Updates global kit + right-click menu + all registered projects

Optional sidecar lists (UTF-8, next to Update.cmd):

- **`update-projects.txt`** — explicit project roots (one per line)
- **`update-search-roots.txt`** — parent folders to scan (depth 2) for `task-tree.md`

Discovery also runs automatically for **sibling folders** of any known project. Opening a task tree registers that project for the next update.

## Repair

From repo root:

```powershell
powershell -File scripts/build-dist.ps1
```

Output: `dist/LLMTaskTree-Setup.zip`
