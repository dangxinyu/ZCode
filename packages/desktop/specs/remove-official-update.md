# 移除官方更新功能（remove-official-update）

## 背景

本仓库为 ZCode 开源 fork（产品 Don't-think，appId `dev.dontthink.app`），由使用者自行修改并打包分发。
官方更新链路（electron-updater 轮询官方 feed、强制升级拦截、更新入口 UI）对本 fork 有实际危害：
接受官方更新会用官方安装包覆盖 fork 的私有改动。需求：把更新功能整体砍掉。

## 范围（删除）

### 桌面 main（行为断根）

- `src/main/autoUpdater.ts`：electron-updater 封装（轮询/下载/安装/菜单/IPC）——整文件删除。
- `src/main/forceUpdateGuard.ts` + `forceUpdatePrompt.ts`：官方 `/api/v1/client/configs` 最低版本拦截——删除。
- `src/main/manifestUpdateProvider.ts`：更新 manifest 数据源——删除（mock-cdn 的运行时组件分发不受影响，属 remoteCdn 资产链）。
- `src/main/index.ts`：`initAutoUpdater(...)` 启动调用、forceUpdateGuard 门、相关 import。
- `src/main/desktopApplicationMenu.ts`：`CHECK_FOR_UPDATE_MENU_ID` 菜单项与 locale 同步。
- `src/main/desktopTray.ts`：托盘「检查更新」项。
- `src/main/desktopCommandHandlers.ts`：`checkForUpdateMenuClick` 处理。
- `src/main/desktopWindowLifecycle.ts`：3 个 update 同步回调参数。
- `src/main/desktopSecondInstanceDeepLink.ts`：`forceUpdateBlocked` 依赖。

### UI（用户入口）

- `UpdateStatusButton/Dialog/DialogController/WindowRoot/ReleaseNotesTooltip`、
  `updateStatusModel/updateReleaseNotes/updateStatusButtonLayout`、
  `lib/desktopUpdateMenu`、`hooks/useDesktopUpdateMenu`——整文件删除。
- `DesktopTopOverlay.tsx`：顶部更新按钮挂载与状态 props。
- `WorkspaceHelpMenuButton.tsx`：帮助菜单内的更新菜单组。
- `app-shell/WorkspaceShellLayout.tsx`：`hasUpdateStatusButton` 派生与透传。

### 协议与平台面

- `packages/shared/src/update.ts`、`forceUpdate.ts`：更新 payload/强升类型。
- `packages/shared/src/platform.ts`：`DesktopCommandIds.CheckForUpdates` 与 update 相关平台类型、
  IPlatformService 上的 update API（onUpdateState/getAutoUpdaterState 等）。
- `packages/shared/src/channels.ts`：更新相关 IPC channel 常量。
- `packages/shared/src/desktopMenu.ts`：`helpCheckForUpdates` 消息 id 与文案。
- `packages/desktop/src/preload/index.ts`：update API 暴露与回调集合。
- `packages/desktop/src/main/desktopMainIpcPlatform.ts`：update IPC handler。
- `packages/client/src/globals.d.ts`：残留 update 类型引用。
- i18n：仅删除已无引用的 update 专属 key（`titleBar.menu.help.checkForUpdates` 等）。

## 明确不动的

- mock-cdn / remoteCdn / 运行时组件（node-runtime、glm agent、server-bundle）分发链——与 app 自更新无关。
- `zcode-source-headers.ts` 的 `X-Release-Channel` 请求头（服务端遥测归属，非更新功能）。
- 设置里的 endpoint/主题等无关设置项。

## 状态所有者与验收

- main 不再持有任何更新状态；`initAutoUpdater`、force update guard 无调用点（grep 零命中）。
- UI 无更新按钮/菜单/弹窗；删除后 `pnpm typecheck`、`pnpm lint`、
  `pnpm architecture:check --changed` 全绿，残留 grep（autoUpdater|forceUpdate|checkForUpdate|UpdateStatus）
  仅允许命中本 spec 与 mock-cdn 等白名单。
- 行为验收：打包后应用启动不向官方 endpoint 发更新请求；菜单/托盘/顶栏无「检查更新」入口。
