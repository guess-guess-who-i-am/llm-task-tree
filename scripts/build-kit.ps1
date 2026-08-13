$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$Kit = Join-Path $Root "llm-task-tree-kit"

if (-not (Test-Path -LiteralPath $Kit)) {
  throw "llm-task-tree-kit not found"
}

$keep = @("task-tree.config.json", "install.ps1", "install.cmd", "README.md", "templates", "node_modules")

Copy-Item (Join-Path $Root "server.js") $Kit -Force
if (Test-Path -LiteralPath (Join-Path $Root "server")) {
  Remove-Item (Join-Path $Kit "server") -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Root "server") (Join-Path $Kit "server") -Recurse -Force
}
if (Test-Path -LiteralPath (Join-Path $Root "model-agents")) {
  Remove-Item (Join-Path $Kit "model-agents") -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Root "model-agents") (Join-Path $Kit "model-agents") -Recurse -Force
}
Copy-Item (Join-Path $Root "package.json") $Kit -Force
Copy-Item (Join-Path $Root "打开任务图.cmd") $Kit -Force
Copy-Item (Join-Path $Root "scripts\install-codex-hooks.mjs") (Join-Path $Kit "scripts\install-codex-hooks.mjs") -Force
Copy-Item (Join-Path $Root "scripts\check-tree-compact.mjs") (Join-Path $Kit "scripts\check-tree-compact.mjs") -Force
# MCP front door: the stdio server plus its Codex registrar travel with the kit so an
# installed project can register the task-graph tools without cloning this repo.
Copy-Item (Join-Path $Root "scripts\mcp-server.mjs") (Join-Path $Kit "scripts\mcp-server.mjs") -Force
Copy-Item (Join-Path $Root "scripts\install-codex-mcp.mjs") (Join-Path $Kit "scripts\install-codex-mcp.mjs") -Force
Copy-Item (Join-Path $Root "scripts\install-linux-project.mjs") (Join-Path $Kit "scripts\install-linux-project.mjs") -Force
Copy-Item (Join-Path $Root "scripts\project-port.mjs") (Join-Path $Kit "scripts\project-port.mjs") -Force
# Hosts that refuse to frame a plain http page need the UI over TLS; this is what creates and
# revokes the loopback certificate the https listener uses.
Copy-Item (Join-Path $Root "scripts\enable-local-https.ps1") (Join-Path $Kit "scripts\enable-local-https.ps1") -Force
# open-task-tree.ps1: keep kit launcher (accepts -StubDir, starts node). Root wrapper stays at repo root only.
# The root AGENTS.md is intentionally a short router. Package the canonical
# detailed tree protocol so installations do not lose any original function.
Copy-Item (Join-Path $Root "llm-task-tree\AGENTS.task-tree.md") (Join-Path $Kit "AGENTS.task-tree.md") -Force
Copy-Item (Join-Path $Root "llm-task-tree\AGENTS.node-writing.md") (Join-Path $Kit "AGENTS.node-writing.md") -Force
if (Test-Path -LiteralPath (Join-Path $Root "scripts\README.md")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Kit "templates\scripts") | Out-Null
  Copy-Item (Join-Path $Root "scripts\README.md") (Join-Path $Kit "templates\scripts\README.md") -Force
}
$stepsReadme = Join-Path $Root "scripts\steps\README.md"
if (Test-Path -LiteralPath $stepsReadme) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Kit "templates\scripts\steps") | Out-Null
  Copy-Item -LiteralPath $stepsReadme -Destination (Join-Path $Kit "templates\scripts\steps\README.md") -Force
} elseif (Test-Path -LiteralPath (Join-Path $Kit "templates\scripts\steps\README.md")) {
  Copy-Item (Join-Path $Kit "templates\scripts\steps\README.md") (Join-Path $Root "scripts\steps\README.md") -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $Kit "public\*") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Root "public\*") (Join-Path $Kit "public\") -Recurse -Force
Remove-Item (Join-Path $Kit "skills\task-tree-grill") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Root "skills\task-tree-grill") (Join-Path $Kit "skills\") -Recurse -Force
Remove-Item (Join-Path $Kit "skills\task-tree-core-state") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Root "llm-task-tree\skills\task-tree-core-state") (Join-Path $Kit "skills\") -Recurse -Force
Copy-Item (Join-Path $Root ".env.example") (Join-Path $Kit "templates\.env.example") -Force
# Codex plugin marketplace: one shared copy in the kit, so every installed project
# registers the same [marketplaces.llm-task-tree] source.
# Rebuild the source marketplace runtime first; otherwise copying it into the kit preserves a
# stale nested bundle even though the kit-side bundle is rebuilt below.
& node (Join-Path $Root "scripts\build-plugin-runtime.mjs") (Join-Path $Root "marketplace\plugins\task-tree")
Remove-Item (Join-Path $Kit "marketplace") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Root "marketplace") (Join-Path $Kit "marketplace") -Recurse -Force
# Rebuild the packaged plugin runtime after copying the marketplace metadata. The runtime is a
# deliberate bundle of root server/public files and must not lag behind the shared kit.
& node (Join-Path $Root "scripts\build-plugin-runtime.mjs") (Join-Path $Kit "marketplace\plugins\task-tree")
# Git-marketplace consumers (`codex plugin marketplace add owner/repo`) look for this
# at the cloned repo root. Keep a copy inside the kit so the kit itself can be the public repo.
$agentsPlugins = Join-Path $Kit ".agents\plugins"
New-Item -ItemType Directory -Force -Path $agentsPlugins | Out-Null
Copy-Item (Join-Path $Root ".agents\plugins\marketplace.json") (Join-Path $agentsPlugins "marketplace.json") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Kit "templates\codex\hooks") | Out-Null
Copy-Item (Join-Path $Root ".codex\hooks.json") (Join-Path $Kit "templates\codex\hooks.json") -Force
Copy-Item (Join-Path $Root ".codex\hooks\*") (Join-Path $Kit "templates\codex\hooks\") -Force
Copy-Item (Join-Path $Root "task-trees.json") (Join-Path $Kit "templates\task-trees.json") -Force
Copy-Item (Join-Path $Root "trees\background.md") (Join-Path $Kit "templates\background-tree.md") -Force
Copy-Item (Join-Path $Root "trees\architecture.md") (Join-Path $Kit "templates\architecture-tree.md") -Force

Write-Host "Synced llm-task-tree-kit from repository root."
