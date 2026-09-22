# ZCode 架构与改动索引

本文件是「想改什么 → 去哪改 → 注意什么」的导航索引，覆盖全部包和关键机制。维护规则与 AGENTS.md 一致：以当前检出的源码为准，删除或迁移功能时同步更新本文件；发现索引与源码不符，以源码为准并修正本文件。

配套文档，各管一摊：

| 文件 | 管什么 |
| --- | --- |
| `AGENTS.md` | 工作流程纪律、命令表、进程/协议/日志边界 |
| `DESIGN.md` | UI 设计规范（`text-ui-*` 字号、语义色、圆角层级） |
| `CONTEXT.md` | 插件商店领域词汇表 |
| `architecture-policy.yaml` | 模块边界与检查规则（唯一可执行来源） |
| 本文件 | 架构地图与改动定位索引 |

## 全局分层与依赖方向

```
shared（协议/类型）  rpc（RPC 框架）  provider / provider-node（模型接入）
        ↑                  ↑                      ↑
   services（Node 侧业务服务 + 持久化）  client（渲染侧接入 SDK）
        ↑                                          ↑
       ui（共享 React 组件 + hooks + Zustand store）← web / desktop renderer（壳）
                                                     ↑
                          desktop（Electron Main + Host + scheduler + 打包）
                                                     ↑ stdio
                          apps/zcode-cli（Agent 运行时：core/adapters/bootstrap/cli/tui）
```

三条消费路径共享同一套 ui + services：
- **Desktop**：Renderer(壳) ← `@zcode/client` connectViaMessagePort → 窗口 Host utility process → spawn Agent CLI 子进程（stdio）。
- **Web/命令行版**：浏览器 ← `@zcode/client` connectViaWebSocket → `packages/server`（Hono，静态托管 + WS）→ spawn Agent CLI。
- **纯 CLI**：TUI（Ink）直接跑 Agent，不经 Host。

## 进程与运行时拓扑（Desktop）

```
Electron Main（窗口/IPC/薄转发，src/main/index.ts）
  ├─ utilityProcess.fork() → 窗口 Host（src/host/index.ts，每窗口一个）
  │     ├─ 本地 workspace：共享本窗口 Host
  │     ├─ 远程 workspace：windowRemoteConnectionRegistry（SSH/WSL，connecting/online/…）
  │     └─ 手机远控：taskRealtimeBridge 镜像帧 → 云端 relay → 手机 Web
  ├─ utilityProcess → cron scheduler（src/scheduler/，automation 认领/派发）
  └─ Renderer（src/renderer/，只做壳与桥，UI 本体在 packages/ui）
Agent CLI 子进程由 packages/services/src/zcode-agent/zcodeAgentProcessManager.ts spawn
```

## 改动场景索引

### UI 与交互（packages/ui）

| 想改什么 | 去哪 | 注意 |
| --- | --- | --- |
| 对话消息流、工具调用块 | `src/ToolCallBlocks*/`、`ModelTrajectory*`（平铺） | 状态只读 `zcodeSessionStore`，别自建副本 |
| 聊天输入框 | `src/prompt-editor/`（`ChatPromptEditor`）、`chat-input-toolbar/` | 输入壳是唯一 `rounded-2xl` 白名单例外；未提交草稿归 Renderer，已提交归 CommandInbox |
| 多 Tab 工作区 | `src/store/tabStore.ts` + `tabWorkspaceIdentity.ts` | 身份 key 用 `workspaceIdentity?.trim() \|\| workspacePath` |
| 插件商店 | `src/settings/PluginStore*.tsx` + `src/store/pluginStore.ts`、`pluginManagementStore*` | 术语严格按 CONTEXT.md；服务在 services/plugins、plugin-sync |
| 设置页 | `src/SettingsPage.tsx` + `src/settings/` | 存储走 services/storage（受控模块） |
| 终端 | `src/terminal/`、`SidePaneTerminalPane.tsx`、`Terminal.tsx` | 服务在 services/terminal |
| Git 面板 | `GitPane*`（平铺）、`git-graph/` | 服务在 services/git |
| MCP/Skill/命令/Hooks 管理 | `mcpStore*(+Desktop/Helpers/Migration)`、`skillStore.ts`、`commandsStore.ts`、`hooksStore.ts` | 对应服务 mcp-sync、skill-sync、official-mcp、commands、hooks |
| 子代理/动态工作流面板 | `subagentsStore.ts`、`savedWorkflowStore.ts`、`components/workflow-graph/` | 引擎在 apps/zcode-cli 的 dynamic-workflow 包 |
| 远程连接向导/SSH 对话框 | `RemoteConnection*`（平铺）、`remote-connection/` | 连接状态真相在 Host 侧注册表，UI 只做投影 |
| 权限/审批/澄清弹窗 | `PermissionDialog.tsx`、`ElicitationDialog.tsx` | 等待徽章统一用 confirmation 色（DESIGN.md） |
| 移动端 Web 适配 | `src/v4/`、`lib/mobileTextInput.ts` | iOS 输入用 `text-mobile-input-safe`；单列 + 抽屉布局 |
| 主题/i18n/日志 | `hooks/useTheme.ts`、`i18n/`、`src/logger.ts` | UI 日志只用 `logger.ts`，禁 `console.log`/`window.zcode.log` |
| 头部动作区按钮 / 侧栏底部按钮 | `WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx`、`WorkspaceSidebarFooter.tsx` | 刷新当前对话复用 `onReloadSession`；任务列表刷新走 `v4/taskListManualRefresh.ts` + membership bump（spec: `packages/ui/specs/task-list-manual-refresh.md`） |
| 模型选择器 / 视觉委托下拉 | `V4ComposerToolbar.tsx`（ModelConfigSelect）+ `useDraftConfigControl.ts`（draft 三态） | 视觉下拉仅主模型 `supportsImage !== true` 时显示；提交经 sendText/createSession payload `visionDelegateModel`（spec: `apps/zcode-cli/packages/core/specs/vision-delegate.md`） |

组件访问服务的唯一通道：`hooks/useServices.tsx`（`IServiceAccessor`）与 `hooks/usePlatform.tsx`（`IPlatformService`）。禁止 UI 直调 Repo、直调 `window.zcode`。

### 状态（packages/ui/src/store/）

约 30 个 Zustand store；核心 `zcodeSessionStore.ts` 按 slice 拆分（`*Selectors` / `*TaskSlice` / `*Navigation`）。广播同步字段（主题、语言等）必须防回环；UI 局部状态不得当作服务端事实。

### 服务层（packages/services/src/）

按域一目录（zcode-agent、zcode-session、session(automation/offPeak/tasks)、plugins、skills、mcp-sync、git、terminal、file、fs、credential/oauth、model-provider、providers、conversation-share、memory、subagents、storage、feedback、onboarding、remote-sync、settings-sync、usage-stats、cua-permission-broker、prompt-attachment-transfer、window-controller 等）。

- 新增服务：按域建目录 → `descriptors.ts` 用 `createServiceDescriptor` 注册 → `accessor.ts` 聚合进 `IServiceAccessor` → 日志用 `createServiceLogger(scope)`（`src/logger/serviceLogger.ts`）。
- `storage` 是唯一 `managed: true` 受控模块（domain/app/adapters 三层，domain 纯净无 IO）；`session` 在 policy 中标记 legacy，其声明的 `contract.ts` 当前不存在。
- Agent 子进程生命周期全在 `zcode-agent/`（spawn、stdio transport、connection scope）。

### 协议（packages/shared）

| 层 | 位置 | 说明 |
| --- | --- | --- |
| v1 协议 | `src/zcode-protocol/index.ts`（Zod schema，约 3700 行） | 信封 + `session/*`、`plugins/*`、`workflows/*`、`interaction/*`、`automation/*`、`offPeak/*` 等命令与通知 |
| v4 wire | `src/zcode-protocol-v4/`（wire-codec、transport） | 新二进制编解码，含 clientMode/deliveryProfile 校验 |
| 实时链路 | `src/task-realtime.ts` | 手机 relay 的 owner/delivery kind 定义 |
| 平台桥 | `src/platform.ts` | `IPlatformService` 接口 |

协议改动的联动清单：
1. `zcode-protocol/index.ts` 或 `zcode-protocol-v4/` 同步改类型 + 运行时校验（AGENTS.md 硬性要求）。
2. 实现侧：Agent 宿主在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol(-v4)/`；服务侧在 packages/services；消费侧在 packages/ui hooks。
3. 两条投递链路（continuous/replayable）都要验证（见下文机制速查）。

### Agent 运行时（apps/zcode-cli/packages/）

| 想改什么 | 去哪 |
| --- | --- |
| 会话循环/turn 状态机 | `core/src/agent/turn-machine.ts`、`runtime/agent-runtime.ts`、`runtime/command-queue.ts` |
| 工具注册与执行 | `core/src/tool/registry.ts`、`executor.ts`、`scheduler.ts`、`handlers/`（80+ 工具） |
| 权限/审批策略 | `core/src/permission/`（broker、service、rule-matching、plan-mode-policy） |
| 上下文组装/压缩 | `core/src/context/`、`core/src/compact/`（policy、microcompact） |
| 端口与事件契约 | `contracts/`；基础设施实现在 `adapters/`（fs/model/provider/skills/mcp） |
| Desktop 协议宿主/命令准入 | `bootstrap/src/zcode-protocol-v4/command-inbox.ts`（串行 admission，in-flight pinned / settled LRU / stale 裁决）、`v4-gateway.ts` |
| 模型工厂 | `bootstrap/src/model-factory.ts`、`model-config.ts` + `adapters/src/model/` |
| 媒体能力投影（图片/PDF/视频剔除与预算） | `core/src/runtime/helpers/media-capability.ts`、`media-budget.ts` + `contracts/src/model/media-policy.ts` | 主模型 `inputFormat.supportsImage=false` 时图片换占位文本 |
| 视觉委托（无视觉主模型的图片描述代理） | `core/src/runtime/methods/vision-delegate.ts`（注入点 `methods/model.ts` runModelTextRequest）+ facade `bootstrap/src/app/session-facade.ts#setVisionDelegateSelection`（必须 `allowMissingReasoning: true`）+ 持久化 entry `runtime/vision_delegate` | spec: `core/specs/vision-delegate.md`；sha256 缓存按 runtime 实例，失败回退占位 |
| TUI 界面 | `tui/src/app-*.tsx`（approval-panel、input-pane 等） |
| 动态工作流引擎 | `dynamic-workflow/`、`dynamic-workflow-runtime/` |
| slash 命令中心 | `cli/src/command-center/` |

改完 Agent 侧代码后：桌面重跑 `pnpm dev:desktop` 即可（自动重打）；**web 端必须 `pnpm --filter @zcode/cli build && pnpm --filter @zcode/server build:remote` 再重启 dev:web**（server 的 tsup watch 不会重建 `dist/remote/zcode-server.cjs`，旧 bundle 会把新 payload 字段静默剥掉）。

### 模型接入（packages/provider + provider-node）

`provider/src/registry.ts`（冻结快照 + revision）→ `sources.ts`（zcodeBuiltin + personal 两层配置合并）→ resolver 计算最终模型选择；Node 落地在 `provider-node/`（配置仓库、内置供应商配置物化/下载/远端同步）。内置兜底配置在根 `config/provider/zcode-builtin.json`。新增智谱模型的正式接入：该文件的 `builtinModelIds` 加 ID + `packages/shared/src/official-glm-model-id.ts` 白名单加一行；能力差异才加 `modelConfigRules.modelRules` 条目（正则 `.*glm-5.*` 已兜底覆盖 5 系）。GLM-5.3 标 `supportsImage=true` 是套餐服务端桥接标记。

### 桌面（packages/desktop）

| 想改什么 | 去哪 | 注意 |
| --- | --- | --- |
| 窗口/原生能力/IPC 转发 | `src/main/`（入口 index.ts；窗口生命周期 desktopWindowLifecycle、主窗口协调 primaryWindowCoordinator） | Main 不承载 task/session 业务状态，只做窗口、进程调度、消息转发 |
| Host 编排/远程 workspace | `src/host/index.ts`、`windowRemoteConnectionRegistry.ts`、`remoteWorkspaceServiceCollection.ts` | 每窗口一个 Host；远程连接走窗口内注册表，不建 Desktop Remote Host |
| 手机远控帧镜像 | `src/host/taskRealtimeBridge.ts` + shared `task-realtime.ts` | relay 只做鉴权/配对/心跳/转发/attachment 调度，不存业务状态 |
| 定时/闲时任务调度进程 | `src/scheduler/` | 业务逻辑在 services/session（automation*、offPeak*） |
| 打包/运行资源 | `scripts/`（prepare-runtime-assets、bundle、agent-node-bundle、mock-cdn） | 远程资源开发态取自本地 mock-cdn，SFTP 上传 |
| 原生模块 | `src/native/`（macos-window-bounds、windows-browser-import-helper） | 三平台兼容 |

### Web 与命令行版（packages/web、server、zcode-server-cli）

- `packages/web/src/main.tsx`：入口 + 手写路由分流（工作台 / OAuth 回调 `src/auth/` / 分享落地页 `src/share/`）；其余 1100+ 文件是 material-icons 资产。
- `packages/server/src/http.ts`：Hono。`/ws`（web-remote-replayable）、`/ws/host`（凭 capability 升级 desktop-continuous）、`/ws/remote/:id`（SSH/Docker/WSL 远程后端）；authToken → HttpOnly Cookie；SPA 静态托管。
- `packages/zcode-server-cli`：守护进程管理（serve/status/stop/restart/update，Supervisor + crashBudget + generation fork）。`zcode --web` 的分流在发行包 `scripts/zcode-distribution/runner.mjs`。
- Agent 连接 scope：`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`（deliveryProfile 映射、分块 attachment 队列、重连 flow state）。
- web 端 window-controller channel（置顶/归档/时间线/搜索列表）：`packages/server/src/windowControllerReplay.ts`（http.ts 装配期注册，spec 在 `packages/server/specs/window-controller-replay.md`）。帧语义：`frame.fromSeq` 必须等于消费端上一帧 `toSeq`，否则 registry 判 gap 触发 resync。

## 关键机制速查

### 两条投递链路（改 stream/snapshot/queue/重连时必须同时验证）

```
desktop: continuous  ── 直接实时流 ────────────┐
                                              ├─ 同一 owner 与序号
mobile/web: replayable ─ 快照 + 分块队列补洞 ──┘
```

- `desktop-continuous`：WS `/ws/host`，Host 直发实时帧。
- `web-remote-replayable`：WS `/ws`，快照（`task_snapshot_updated`）+ gap repair；权限弹窗/资源事实禁止进入 replayable 流。

### workspaceIdentity

身份隔离用 `workspaceIdentity`，文件操作/命令 cwd/Git/路径展示用 `workspacePath`。身份 key 统一 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化、请求关联；远程链路全程贯穿 `workspaceIdentity` + `remoteSessionId`，不得仅按路径匹配。

### 命令准入（CommandInbox）

已接受的 busy/running 输入由 CLI/runtime 的 `bootstrap/src/zcode-protocol-v4/command-inbox.ts` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay；跨 Host 路由靠 owner/lease。不能仅凭单一路径删除 stale run 防护。

### 架构治理

- 模块清单与规则唯一来源：`architecture-policy.yaml`（maxFileLines 400、maxPublicMethods 12、禁循环、禁深导入；目前仅 storage 是 managed 模块）。
- 改码前：`pnpm architecture:check --changed` 定位模块 → `pnpm architecture:context <module-id>` 拿受控阅读包 → 先写 spec 再实现；改后再跑一次，新增违规与存量 baseline 分开报告。流程详见 `.agents/skills/architecture-governance/SKILL.md`。

## 验证清单

| 时机 | 命令 |
| --- | --- |
| 开工前基线 | `node scripts/check-workspace-freshness.mjs` |
| 类型检查（必跑） | `pnpm typecheck` |
| Lint（必跑） | `pnpm lint` / `pnpm lint:fix` |
| 格式 | `pnpm fmt:check` |
| 架构检查 | `pnpm architecture:check --changed` |
| 提交前 | `pnpm verify:pre-push` |
| 未使用依赖/导出 | `pnpm knip`；导出引用 `pnpm dep:refs --list-exports <file>` |

行为改动先补测试；交互改动补 E2E 场景。测试入口以目标包 `package.json` 和实际测试文件为准，不存在统一命令。
