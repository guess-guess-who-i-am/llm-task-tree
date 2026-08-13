# 全局 Prompt 发布器

桌面快捷方式打开中文唯一源 `~/.codex/prompts/global-every-turn.zh.md`。文件每次实际保存并稳定 3 秒后，发布器会：

1. 用当前 Codex 登录态启动不保留历史的只读翻译会话；瞬时失败时默认最多尝试 3 次。
2. 校验中英文行数、Markdown 结构、规则数、`[TTxx]`、URL、路径和反引号内容。
3. 备份并更新本机用户级英文 Prompt。用户级 `UserPromptSubmit` Hook 会让本机所有项目下一轮自动读取它，不需要复制到每个项目。
4. 通过 SSH 暂存、校验并更新 `targets.json` 中每台远程机器的用户级中英文 Prompt；该远程账号下的所有 Codex 项目共用它。
5. 任一目标暂存或校验失败时停止发布；已进入提交阶段后出错会尝试回滚。

关闭编辑器时还会再做一次哈希核验，因此远端文件被意外改动后也能修复。没有内容或目标漂移时不会再次调用模型。桌面快捷方式经 `wscript.exe` 隐藏启动监测器，不显示 PowerShell 终端窗口。

## 目标配置

编辑安装目录中的 `targets.json`。增加远程机器时，向 `remoteTargets` 添加：

```json
{
  "name": "server-name",
  "sshHost": "ssh-config-alias",
  "codexHome": ".codex",
  "requireGlobalHook": true
}
```

远程主机须能用密钥无交互登录，并已安装读取 `prompts/global-every-turn.en.md` 的用户级 `global-user-prompt-submit` Hook。改变 `hooks.json` 本身后仍需在 Codex 中重新信任；只更新 Prompt 内容不需要重新信任。

`translationAttempts` 和 `translationRetryDelayMs` 分别控制翻译尝试次数和重试间隔毫秒数；未配置时默认使用 `3` 和 `2000`。

## 手动命令

```powershell
node "$env:USERPROFILE\.codex\prompt-publisher\publish-global-prompt.mjs" --config "$env:USERPROFILE\.codex\prompt-publisher\targets.json"
```

加 `--dry-run` 只检查和翻译，不写目标；加 `--force` 强制重新翻译；加 `--skip-remotes` 只处理本机。

日志在安装目录的 `logs/`，历史 Prompt 在各 Codex Home 的 `prompts/backups/`。
