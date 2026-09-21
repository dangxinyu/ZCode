# 任务列表手动刷新 + 头部刷新当前对话

## 背景与问题

任务列表数据（tasks-index.sqlite）可能被**其他进程**直接写入（例如官方桌面客户端与自建 web/桌面端共享同一个 `~/.zcode` 数据目录）。本进程的事件链路（`workspace_task_list_changed` → controller frame / membership bump）收不到外部写入，导致：

- `useGlobalTaskList` 系（置顶 / 已归档 / 时间线 / 搜索，经 window-controller channel 的 queryCache）保持陈旧；
- `useWorkspaceTaskLists` 系（sidebar 普通 workspace 列表，taskQueryCacheStore）保持陈旧。

用户当前唯一的恢复手段是刷新整页 / 重启应用。

## 产品规则

两个独立入口，语义不同、互不替代：

1. **侧栏底部「刷新任务列表」按钮**：位于左下角设置按钮左侧。点击后所有已挂载的任务列表（置顶 / 归档 / 时间线 / 普通 workspace 列表 / 命令中心搜索）失效本地缓存并重新查询 SQLite，等价于刷新页面但不清空 React 状态、不重载窗口。这是外部进程写入（官方客户端置顶等）后的同步入口。
2. **头部「刷新当前对话」按钮**：位于右上角动作区最前（分享 / 终端 / 面板按钮之前）。复用既有 `onReloadSession` 链路（workspace 进程重建 + resume 当前任务，入口自带防抖 / pending / toast），不另起第二条会话重建路径。
3. 头部动作区按需求删除「帮助」入口（`WorkspaceHelpMenuButton`，组件保留供设置页使用）及 `hideHelpMenu` props 链；「分享」入口保留。

## 状态所有者与接口

| 状态 / 接口 | 所有者 | 说明 |
| --- | --- | --- |
| `bumpTaskListManualRefresh()` / `useTaskListManualRefreshSerial()` | `src/v4/taskListManualRefresh.ts`（模块级 store，模式同 `taskListMembershipVersion.ts`） | 全局串行号。`useGlobalTaskList` 将其与 hook 局部 serial 相加并入 `version.manualRefreshSerial`，使 registry queryCache 版本 miss → 强制重新 RPC。 |
| `bumpTaskListMembershipVersion()` | `src/v4/taskListMembershipVersion.ts`（既有） | bump 后 `useWorkspaceTaskLists` 的 sessions effect 把 taskQueryCache 标脏 → pendingConfigs 重查。手动刷新复用该既有链路，不新增第二条写路径。 |
| `WorkspaceTaskListRefreshButton` | `src/WorkspaceTaskListRefreshButton.tsx` | 侧栏底部按钮。点击时依次调用上述两个 bump；不持有任何业务状态。 |
| `WorkspaceSessionReloadButton` | `src/WorkspaceSessionReloadButton.tsx` | 头部按钮。仅调用 `onReloadSession`（透传自 shell 层 `useWorkspaceSessionReload` 的 `handleReloadSession`），pending 时图标旋转并禁用。 |

## 事件顺序

```
侧栏底部「刷新任务列表」
  ├─ bumpTaskListManualRefresh()  → 全局 serial +1 → 各 useGlobalTaskList effect 重跑
  │     → registry.list(version 含新 serial) → versionKey miss → controller.listTaskList RPC → SQLite 重读
  └─ bumpTaskListMembershipVersion() → 各 useWorkspaceTaskLists 标脏缓存 → refresh() 重查 zcodeTaskService

头部「刷新当前对话」
  └─ onReloadSession() → handleReloadSession（防抖）→ restartWorkspaceProcess + resumeTaskId → 会话内容重建
```

两条链路都是"失效 / 重建 → 既有路径重跑"，按钮本身不直接发起查询或进程操作。

## 验收场景

1. 官方客户端（或任意外部进程）置顶一个任务 → 自建 web/桌面端不刷新页面，点击侧栏底部刷新按钮 → 置顶区出现该任务。
2. 外部取消置顶 → 点击侧栏底部刷新 → 置顶区移除该任务，普通列表恢复。
3. 点击侧栏底部刷新前后，进行中的会话、草稿、面板状态不受影响（仅列表重查）。
4. 头部刷新当前对话：活动任务存在时可点击，pending 期间禁用并转圈，完成/失败走既有 toast。
5. 头部不再出现「帮助」按钮；「分享」仍按原条件显示。
6. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
