$ErrorActionPreference = "Stop"

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$fixture = [System.IO.Path]::GetFullPath((Join-Path $tempRoot ("prompt-publisher-hidden-" + [guid]::NewGuid().ToString("N"))))
if (-not $fixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe test fixture path: $fixture"
}

try {
  $codexHome = Join-Path $fixture ".codex"
  $promptDir = Join-Path $codexHome "prompts"
  [System.IO.Directory]::CreateDirectory($promptDir) | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $promptDir "global-every-turn.zh.md"), "# 中文`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $promptDir "global-every-turn.en.md"), "# English`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $codexHome "hooks.json"), '{"global-user-prompt-submit":true}', $utf8)

  $installer = Join-Path $PSScriptRoot "prompt-publisher\install-global-prompt-publisher.ps1"
  & $installer `
    -CodexHome $codexHome `
    -RemoteHost "" `
    -ShortcutDirectory $fixture `
    -ShortcutName "hidden-launcher.lnk"

  $launcher = Join-Path $codexHome "prompt-publisher\launch-global-prompt-editor.vbs"
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "The hidden launcher was not installed."
  }

  $shortcutFile = Join-Path $fixture "hidden-launcher.lnk"
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutFile)
  if ([System.IO.Path]::GetFileName($shortcut.TargetPath) -ine "wscript.exe") {
    throw "The shortcut does not use the windowless wscript.exe host: $($shortcut.TargetPath)"
  }
  if ($shortcut.Arguments -notmatch 'launch-global-prompt-editor\.vbs') {
    throw "The shortcut does not invoke the hidden launcher: $($shortcut.Arguments)"
  }

  Write-Host "PASS Prompt publisher shortcut uses a windowless launcher"
} finally {
  if ([System.IO.Directory]::Exists($fixture)) {
    [System.IO.Directory]::Delete($fixture, $true)
  }
}
