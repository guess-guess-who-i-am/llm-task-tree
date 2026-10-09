# 紧凑执行链

底部常驻一行：执行链展开/收起按钮、节点数量/状态、复制按钮。收起高度为 41px；展开才显示横向节点链及「执行下一步 / 说明 / 清空」。不再常驻整段循环命令。

复制仍包含完整循环提示、当前服务端口、单步推进规则和当前子树路径。只复制，不启动模型。折叠状态保存在浏览器中，刷新后保留；按钮支持键盘操作。

## 修复及证据

- 删除旧命令栏的 HTML、渲染逻辑和样式；保留原复制、执行及链编辑逻辑，不新增依赖。
- 窄屏固定网格的子项超过主区域：390px 测试中主区域底部为 803px，树面板延伸至 918px，盖住 803–844px 的底栏。主区域改为内部滚动，使画布不会挡住底栏，同时仍可查看侧栏。
- 新浏览器测试先因收起后无法复制失败；修改后又复现画布遮挡。修复后真实点击通过，不使用强制点击。
- 21 项相邻浏览器测试全部通过，覆盖复制全文、主/子树、键盘展开、刷新记忆、390px 手机及 820px 平板。
- 私有 Node 22 定向测试通过；插件运行时 92 文件一致性检查通过。
- 5491/5866 实际页面的三份静态资源与源码一致；1440px/390px 页面复制和折叠通过，脚本错误和修改 API 请求均为零。未重启服务、未执行业务节点。

相邻附件测试的错误提示可能被后台状态更新替换。测试改为观察真实提示变化并等待真实 502 响应，仍验证错误确实显示、发送恢复和附件保留，不修改附件生产逻辑。

## 复测

```sh
node --check public/app.js
node --test server/subtree-workspace-ui.test.js
node scripts/build-plugin-runtime.mjs --check
macos/IDE/runtime/current/bin/node --test --test-name-pattern='compact chain dock' server/subtree-workspace-ui.test.js
```

预览：`artifacts/compact-chain-desktop.png`、`artifacts/compact-chain-mobile.png`。刷新现有 IDE 页面即可使用。测试使用临时工程与模型替身，不证明所有设备上的主观易读性。
