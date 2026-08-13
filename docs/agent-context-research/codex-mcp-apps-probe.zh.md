# Codex 桌面端能不能渲染第三方界面：直接问二进制

写这份东西的起因是一个错判。上一轮的结论是「桌面应用不给第三方插件 UI 位，能进对话的只有 MCP 内容块」，于是做成了返回一张静态 PNG。这个结论是从"没找到相关文档"推出来的，不是从证据推出来的——而宿主的能力就写在本机那个 353 MB 的 `codex.exe` 里。

## 探针

```powershell
$codex = "$env:LOCALAPPDATA\OpenAI\Codex\bin\<build>\codex.exe"
rg -a -c -- "enable_mcp_apps" $codex
rg -a -o ".{0,110}resourceUri.{0,140}" $codex
```

命中结果：

| 字符串 | 次数 | 含义 |
|---|---|---|
| `enable_mcp_apps` | 7 | `[features]` 里的开关，和 `multi_agent_v2`、`tool_search` 并列 |
| `mcp_app_resource_uri` | 14 | `McpToolCallEndEvent` 的字段：内核把它交给界面层去渲染 |
| `resourceUri` | 13 | `McpToolCallAppContext { connectorId, linkId, resourceUri, appName, actionName }` |
| `skybridge` | 0 | 旧 Apps SDK 的 MIME 后缀，这版已经不认 |
| `widgetCSP` / `frameDomains` | 0 | CSP 由界面层执行，不在内核里 |

最关键的一条是这串连在一起的键名：

```
resource_uri  ui  resourceUri  ui/resourceUri  openai/outputTemplate
```

这是内核在工具 `_meta` 里的查找顺序：先找嵌套的 `ui.resourceUri`，再找扁平的 `ui/resourceUri`，最后兜底 Apps SDK 的 `openai/outputTemplate`。找到就把 `mcp_app_resource_uri` 发给界面层。

由此确定三件事：

1. 这版桌面端**带** MCP Apps 渲染层，默认关着，开关是 `features.enable_mcp_apps`。
2. 事件走的是通用的 `McpToolCall` 路径，**本地 stdio 服务同样适用**，不要求注册成远程 connector。
3. 三个键都发出去最稳妥，新老宿主都能认。

## 官方文档补上的约束

- 资源 MIME 必须是 `text/html;profile=mcp-app`——桥只对这个类型打开。
- **子 iframe 默认被拦**，除非资源自己声明 `_meta.ui.csp.frameDomains`。这一条决定了「把网页原样搬进去」到底可不可行：可行，但必须显式声明。
- 宿主会按 URI 缓存模板，破坏性改动要换 URI。

## 我方那一半的验证

宿主行为要等实测，但"界面能不能在跨域 iframe 里正常跑"完全可以本地先验：一个探针页 iframe 到 `http://127.0.0.1:<port>/?embed=1`，听 `postMessage`。

```
HANDSHAKE OK: loaded,rendered
```

两段都收到，说明页面加载了、树也画完了。截图确认知识库面板、关系图、版本树、工具栏全在，能操作。所以如果桌面端那边没出界面，问题一定在宿主侧，不在我们这半边——这个隔离让实测只剩一个变量。

## 教训

判断宿主能力时，翻它的二进制比翻文档快，也比猜准。字符串表里同时有配置键名、事件字段名和 `_meta` 查找顺序，等于把契约直接写在磁盘上。
