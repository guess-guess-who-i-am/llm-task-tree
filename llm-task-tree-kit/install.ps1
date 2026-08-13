param(
  [string]$StubDir = "",
  [switch]$PromptsOnly
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "kit-runtime.ps1")

if (-not $StubDir) {
  $StubDir = $PSScriptRoot
}
$StubDir = [System.IO.Path]::GetFullPath($StubDir)
$KitDir = Resolve-SharedKitDir -StubDir $StubDir
$ProjectRoot = Resolve-TaskTreeProjectRoot -StubDir $StubDir
$MarkerBegin = "<!-- llm-task-tree:begin -->"
$MarkerEnd = "<!-- llm-task-tree:end -->"

function Write-Step([string]$Message) {
  Write-Host ">> $Message"
}

Write-Step "Stub: $StubDir"
Write-Step "Kit: $KitDir"
Write-Step "Project root: $ProjectRoot"

$configFile = Join-Path $StubDir "task-tree.config.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  @{ projectRoot = ".." } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding ascii
  Write-Step "Created task-tree.config.json (projectRoot=..)"
}

# Directories
foreach ($dir in @("versions", "knowledge")) {
  $target = Join-Path $ProjectRoot $dir
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Write-Step "Created $dir/"
  }
}

$treeRegistry = Join-Path $ProjectRoot "task-trees.json"
$treeRegistryTemplate = Join-Path $KitDir "templates\task-trees.json"
if (-not (Test-Path -LiteralPath $treeRegistry)) {
  Copy-Item $treeRegistryTemplate -Destination $treeRegistry -Force
  Write-Step "Created multi-tree registry"
} else {
  try {
    $registry = Get-Content -LiteralPath $treeRegistry -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedRegistry = Get-Content -LiteralPath $treeRegistryTemplate -Raw -Encoding UTF8 | ConvertFrom-Json
    $trees = @($registry.trees)
    $ids = @($trees | ForEach-Object { [string]$_.id })
    $added = @()
    foreach ($expected in @($expectedRegistry.trees)) {
      if ($ids -notcontains [string]$expected.id) {
        $trees += $expected
        $ids += [string]$expected.id
        $added += [string]$expected.id
      }
    }
    if ($added.Count -gt 0) {
      $registry.trees = $trees
      $json = $registry | ConvertTo-Json -Depth 10
      [System.IO.File]::WriteAllText($treeRegistry, ($json -replace "`r`n", "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
      Write-Step "Updated multi-tree registry (+$($added -join ','))"
    }
  } catch {
    throw "Cannot update task-trees.json safely: $($_.Exception.Message)"
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "trees") | Out-Null
foreach ($asset in @(
  @{ Source = "background-tree.md"; Target = "background.md" },
  @{ Source = "architecture-tree.md"; Target = "architecture.md" }
)) {
  $source = Join-Path $KitDir ("templates\" + $asset.Source)
  $target = Join-Path $ProjectRoot ("trees\" + $asset.Target)
  if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath $target)) {
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Step "Created trees/$($asset.Target)"
  }
}

Ensure-ProjectScriptsDir -ProjectRoot $ProjectRoot -SharedKitDir $KitDir
$scriptsReadme = Join-Path $ProjectRoot "scripts\README.md"
if (Test-Path -LiteralPath $scriptsReadme) {
  Write-Step "Ensured scripts/ (execution flow)"
}

# task-tree.md
$treeFile = Join-Path $ProjectRoot "task-tree.md"
if (-not (Test-Path -LiteralPath $treeFile)) {
  Copy-Item (Join-Path $KitDir "templates\task-tree.starter.md") -Destination $treeFile -Force
  Write-Step "Created task-tree.md from starter template"
} else {
  Write-Step "task-tree.md already exists — kept as-is"
}

# AGENTS.md merge
$agentsFile = Join-Path $ProjectRoot "AGENTS.md"
$mergeBlock = Get-Content (Join-Path $KitDir "templates\AGENTS.merge.md") -Raw -Encoding UTF8
$toolCallingBlock = Get-Content (Join-Path $KitDir "templates\AGENTS.tool-calling-rules.md") -Raw -Encoding UTF8
$toolCallingBegin = "<!-- llm-task-tree:tool-calling:begin -->"
$toolCallingEnd = "<!-- llm-task-tree:tool-calling:end -->"

function Merge-MarkedBlock {
  param(
    [string]$Content,
    [string]$Block,
    [string]$Begin,
    [string]$End
  )

  $blockText = $Block.Trim()
  if ($Content -match [regex]::Escape($Begin)) {
    $pattern = [regex]::Escape($Begin) + ".*?" + [regex]::Escape($End)
    return [regex]::Replace($Content, $pattern, ($blockText), [System.Text.RegularExpressions.RegexOptions]::Singleline)
  }

  $separator = if ($Content.TrimEnd().EndsWith("`n")) { "" } else { "`r`n" }
  return ($Content.TrimEnd() + $separator + "`r`n" + $blockText + "`r`n")
}

function Remove-MarkedBlock {
  param(
    [string]$Content,
    [string]$Begin,
    [string]$End
  )
  if ($Content -notmatch [regex]::Escape($Begin)) { return $Content }
  $pattern = "\s*" + [regex]::Escape($Begin) + ".*?" + [regex]::Escape($End) + "\s*"
  return ([regex]::Replace($Content, $pattern, "`r`n", [System.Text.RegularExpressions.RegexOptions]::Singleline)).TrimEnd() + "`r`n"
}

if (Test-Path -LiteralPath $agentsFile) {
  $existing = Get-Content -LiteralPath $agentsFile -Raw -Encoding UTF8
  $updated = $existing
  $hasShortRouter = $existing -match "(?m)^# Agent Entry Rules\s*$" -and $existing -match "Mandatory routing table" -and $existing -match "llm-task-tree/AGENTS\.task-tree\.md"
  if ($hasShortRouter) {
    $updated = Remove-MarkedBlock -Content $updated -Begin $MarkerBegin -End $MarkerEnd
    $updated = Remove-MarkedBlock -Content $updated -Begin $toolCallingBegin -End $toolCallingEnd
    Write-Step "AGENTS.md already has short router; skipped duplicate merge/tool blocks"
  } else {
    if ($existing -match [regex]::Escape($MarkerBegin)) {
      $updated = Merge-MarkedBlock -Content $updated -Block $mergeBlock -Begin $MarkerBegin -End $MarkerEnd
      Write-Step "Updated llm-task-tree block in AGENTS.md"
    } else {
      $updated = Merge-MarkedBlock -Content $updated -Block $mergeBlock -Begin $MarkerBegin -End $MarkerEnd
      Write-Step "Appended llm-task-tree block to existing AGENTS.md"
    }
    if ($updated -match [regex]::Escape($toolCallingBegin)) {
      $updated = Merge-MarkedBlock -Content $updated -Block $toolCallingBlock -Begin $toolCallingBegin -End $toolCallingEnd
      Write-Step "Updated tool-calling rules block in AGENTS.md"
    } else {
      $updated = Merge-MarkedBlock -Content $updated -Block $toolCallingBlock -Begin $toolCallingBegin -End $toolCallingEnd
      Write-Step "Appended tool-calling rules block to AGENTS.md"
    }
  }
  Set-Content -LiteralPath $agentsFile -Value $updated -Encoding UTF8 -NoNewline
} else {
  $header = @"
# Agent Instructions

See also the task graph protocol block below, the full rules in ``llm-task-tree/AGENTS.task-tree.md``, and the node-writing override in ``llm-task-tree/AGENTS.node-writing.md``.

"@
  $body = Merge-MarkedBlock -Content ($header + $mergeBlock.Trim() + "`r`n") -Block $toolCallingBlock -Begin $toolCallingBegin -End $toolCallingEnd
  Set-Content -LiteralPath $agentsFile -Value $body -Encoding UTF8
  Write-Step "Created AGENTS.md with llm-task-tree and tool-calling blocks"
}

function Sync-StubAgentFiles {
  param(
    [string]$KitDir,
    [string]$StubDir
  )

  $agentsTree = Join-Path $KitDir "AGENTS.task-tree.md"
  if (Test-Path -LiteralPath $agentsTree) {
    Copy-Item -LiteralPath $agentsTree -Destination (Join-Path $StubDir "AGENTS.task-tree.md") -Force
    Write-Step "Synced llm-task-tree/AGENTS.task-tree.md"
  }

  $nodeWriting = Join-Path $KitDir "AGENTS.node-writing.md"
  if (Test-Path -LiteralPath $nodeWriting) {
    Copy-Item -LiteralPath $nodeWriting -Destination (Join-Path $StubDir "AGENTS.node-writing.md") -Force
    Write-Step "Synced llm-task-tree/AGENTS.node-writing.md"
  }

  $skillsDir = Join-Path $KitDir "skills"
  $stubSkills = Join-Path $StubDir "skills"
  if (Test-Path -LiteralPath $skillsDir) {
    if (-not (Test-Path -LiteralPath $stubSkills)) {
      New-Item -ItemType Directory -Force -Path $stubSkills | Out-Null
    }
    Copy-Item -Path (Join-Path $skillsDir "*") -Destination $stubSkills -Recurse -Force
    Write-Step "Synced llm-task-tree/skills/"
  }
}

Sync-StubAgentFiles -KitDir $KitDir -StubDir $StubDir
if (Test-SharedKitStub -StubDir $StubDir) {
  Write-SharedKitStub -StubDir $StubDir -SharedKitDir $KitDir -ProjectRoot $ProjectRoot
}
Ensure-ProjectCursorRules -ProjectRoot $ProjectRoot -SharedKitDir $KitDir
Ensure-ProjectCursorMcp -ProjectRoot $ProjectRoot
Write-Step "Ensured .cursor/mcp.json (commit it: teammates get the task-graph tools on clone)"

& node (Join-Path $KitDir "scripts\install-codex-hooks.mjs") $ProjectRoot (Join-Path $KitDir "templates\codex") | Out-Host
Write-Step "Installed Codex postflight hooks (review and trust once with /hooks)"

if ($PromptsOnly) {
  Register-TaskTreeProject -ProjectRoot $ProjectRoot
  Write-Host "Agent prompts synced for: $ProjectRoot"
  exit 0
}

# .gitignore
$gitignoreFile = Join-Path $ProjectRoot ".gitignore"
$appendLines = Get-Content (Join-Path $KitDir "templates\gitignore.append") -Encoding UTF8
if (Test-Path -LiteralPath $gitignoreFile) {
  $gi = Get-Content -LiteralPath $gitignoreFile -Raw -Encoding UTF8
  $added = 0
  foreach ($line in $appendLines) {
    $t = $line.Trim()
    if (-not $t) { continue }
    if ($gi -notmatch [regex]::Escape($t)) {
      Add-Content -LiteralPath $gitignoreFile -Value $t -Encoding UTF8
      $added++
    }
  }
  Write-Step "Updated .gitignore (+$added entries)"
} else {
  Set-Content -LiteralPath $gitignoreFile -Value ($appendLines -join "`r`n") -Encoding UTF8
  Write-Step "Created .gitignore"
}

# .env
$envExample = Join-Path $KitDir "templates\.env.example"
$envTarget = Join-Path $ProjectRoot ".env"
if ((Test-Path -LiteralPath $envExample) -and -not (Test-Path -LiteralPath $envTarget)) {
  Copy-Item $envExample -Destination $envTarget -Force
  Write-Step "Copied templates/.env.example -> .env (fill in keys if needed)"
} else {
  Write-Step ".env already exists or no template — skipped"
}

# npm
Write-Step "Running npm install in kit directory..."
Push-Location $KitDir
try {
  & npm install 2>&1 | Out-Host
} finally {
  Pop-Location
}

$envTarget = Join-Path $ProjectRoot ".env"
if ((Test-Path -LiteralPath $envTarget) -and (Select-String -LiteralPath $envTarget -Pattern '^\s*WEB_SEARCH_PROVIDER\s*=\s*openwebsearch\s*$' -Quiet)) {
  Write-Step "WEB_SEARCH_PROVIDER=openwebsearch — preparing open-webSearch daemon..."
  & (Join-Path $KitDir "setup-open-websearch.ps1") -KitDir $KitDir
}

$codexAction = Ensure-CodexRegistration -KitDir $KitDir
if ($codexAction -eq "appended") {
  Write-Step "Registered task_tree in Codex — restart the Codex desktop app to see the plugin"
} elseif ($codexAction -eq "none") {
  Write-Step "Codex registration already present"
} elseif ($codexAction) {
  Write-Step "Codex registration: $codexAction"
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Open task graph: double-click llm-task-tree\open-task-tree.cmd"
Write-Host "  2. Ask your Agent to expand task-tree.md (task-tree-grill skill)"
Write-Host "  3. Full agent rules: $KitDir\AGENTS.task-tree.md + AGENTS.node-writing.md"

Register-TaskTreeProject -ProjectRoot $ProjectRoot
