Option Explicit

Dim shell, fso, scriptDir, configPath, powershell, watcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watcher = fso.BuildPath(scriptDir, "edit-global-prompt.ps1")
If WScript.Arguments.Count > 0 Then
  configPath = WScript.Arguments(0)
Else
  configPath = fso.BuildPath(scriptDir, "targets.json")
End If

powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Quote(powershell) & " -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(watcher) & " -Config " & Quote(configPath)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
