# 内置浏览器用户脚本（userscripts）注入

## 背景与问题

内置浏览器是 Electron `<webview>` guest（独立 `partition="persist:zcode-embedded-browser"`，`packages/ui/src/browser-use/BrowserViewportSurface.tsx`），与本机 Chrome 扩展体系完全隔离——篡改猴等扩展装不上。用户（开发者）在默认浏览器里依赖 userscript（如 ccweb-helper 开发助手）在内网 SaaS 页面上工作，需要在内置浏览器里获得等价能力。

## 产品规则

1. 约定目录 `{zcodeDataRoot}/userscripts/`（默认 `~/.zcode/userscripts/`，随 dataBaseDir 覆盖）下放置 `*.user.js` 文件即启用；目录不存在或为空 = 功能关闭，零开销。
2. 解析 `==UserScript==` 元数据的 `@match` / `@include`（`/regex/flags` 字面量按正则，其余按 glob 转 正则）；`@run-at` 统一按 document-start 执行（本特性面向开发助手，绝大多数脚本声明就是 document-start）。
3. 命中 URL 的脚本正文在页面上下文执行（`@grant none` 语义：无 GM_* API，v1 不提供 shim）。
4. 脚本读取发生在每次 guest CDP 会话建立时（初始 attach 与崩溃/换壳后的会话恢复），编辑脚本文件后无需重启应用——下一次新标签页/恢复即生效；已加载页需手动刷新。
5. 单个脚本解析/执行失败只 warn 日志并跳过，不得影响 guest 与其他脚本。

## 状态所有者与事件顺序

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 脚本文件与元数据 | `{zcodeDataRoot}/userscripts/`（用户文件系统） | 唯一事实源，进程内不做缓存 |
| 注入状态 | Chromium 的 CDP session（`Page.addScriptToEvaluateOnNewDocument`） | 会话级：guest 崩溃/换壳后随会话恢复流程重放 |

```
guest attach（setupDialogTracking）
  → Page.enable
  → 读 userscripts 目录 → 解析元数据 → 生成引导脚本（含 URL 匹配 + 脚本正文）
  → Page.addScriptToEvaluateOnNewDocument(引导脚本)
此后每次导航/新文档：Chromium 在页面脚本前执行引导 → 按 location 匹配 → (0,eval)(正文)
guest 会话恢复（runGuestCdpSessionRestore）
  → Page.enable 重放后同样重放注入（失败仅 warn，不阻断恢复屏障）
```

不新增持久化、不新增 IPC、不新增设置项——文件即配置。

## 失败语义

- 目录不存在 / 读取失败：静默跳过（功能未启用是合法状态）。
- 元数据缺 `@match`/`@include`：不注入该脚本（默认拒绝），warn 日志。
- 引导脚本执行期（页面内）匹配/eval 失败：console.error 打到 guest 控制台，主流程不受影响。
- CDP 注入命令失败：warn 日志，不影响 Page.enable 后的业务命令。

## 验收场景

1. 放置 ccweb-helper.user.js（@include 正则匹配 `*.chanjet.com` / `app.chanjet.com.cn` / localhost 端口），内置浏览器打开匹配域名 → 脚本生效；打开不匹配域名 → 不注入。
2. guest 渲染进程崩溃恢复后，注入随会话恢复重放。
3. 空目录 / 无目录时内置浏览器行为与现状完全一致。
4. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
