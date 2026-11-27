# 会话视图底部 dock（对齐官方 4.0 接线）

## 背景与问题

官方 4.0 的会话视图在 composer 上方 / 转录末尾渲染状态胶囊（`ConversationStatusPanel` 经
`ComposerStatusRow`），并把已接纳输入队列作为 composer 的 `queueContent` 紧邻输入框。
本仓库此前把 `ConversationStatusPanel` 以浮层形式钉在转录区右上角，composer 上方区域为空，
队列面板渲染在 bottom dock 外层，且缺少 runtime 意外退出横幅。本次按官方接线补齐，不新增
官方没有的功能。

## 产品规则

1. **statusCapsules 进底部 dock**：`SessionPane` 组装 `statusCapsules = <ConversationStatusPanel …/>`
   （非草稿态），经两条官方同款路径渲染，且只渲染一次：
   - 可输入态：作为 `ConversationComposer` 的 `statusContent`，由 composer 内部
     `ComposerStatusRow` 渲染在错误横幅之后、输入 surface 之前；额度横幅接管错误位
     （`showQuotaBanner`）时置 null。
   - 只读态（subagent 观察视图等）：bottom dock 直接渲染
     `<ComposerStatusRow key={sessionId}>{statusCapsules}</ComposerStatusRow>`。
2. **面板容器适配**：面板不再浮在转录区上方。dock 内以正常流渲染（`layoutMode="none"` +
   `static` 容器覆盖），默认收起为摘要胶囊（variant override 缺省回退 `mini`）；用户显式展开
   （点击摘要 / composer 后台任务入口）时分区在 dock 内展开。转录区不再为浮层面板预留
   横向偏移（`summaryPanelLayout` 恒为 none）。
3. **queueContent 按官方传法**：`queueNode` 由同一份可见队列
   （`pendingGuideProjection?.visibleQueue ?? snapshot.queue`）驱动，仅当
   `sessionId && visibleQueue.items.length > 0` 时组装。composer 收
   `queueContent={blockingInteractionId ? null : queueNode}`；存在阻塞交互时队列改在
   dock 内 `<div className="pb-7">` 独立渲染（抵消队列衔接输入框的负下边距），
   已接纳输入仍可管理。
4. **runtime 意外退出横幅**：主泳道 runtime 进程非预期退出（terminationKind=unexpected）
   且退出码已知后，process manager 发布 `ZCodeAgentRuntimeExitedEvent`；
   `useAgentRuntimeExitNotice` 按 workspaceKey（identity 优先）过滤订阅，
   `AgentRuntimeExitBanner` 在额度横幅之后、待恢复命令横幅之前展示原因，可关闭。
   只展示，不改写会话状态；回合 / 子代理收口仍以重连后的 CLI 投影为准。
   退出码 0xE0000008（Windows 系统可提交内存耗尽）给出内存不足文案，其余为通用文案。
5. bottom dock 内容顺序（可输入态）：额度横幅 → runtime 退出横幅 → 待恢复命令横幅 →
   workspace hook 待审核横幅（本仓库既有）→ 阻塞交互卡片 → 阻塞态队列 → composer
   （内含 statusContent / queueContent）→ 草稿推荐。

## 状态所有者与接口

| 状态 / 接口                                            | 所有者                                                   | 说明                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `statusCapsules` / `queueNode` / `showQuotaBanner`     | `SessionPane`（组装，不持有业务状态）                    | 数据来自 snapshot / subagents 投影与既有 quotaBanner hook；props 以本仓库数据源实际能提供的为准。               |
| `ComposerStatusRow`                                    | `src/v4/ComposerStatusRow.tsx`（自官方搬移）             | 居中胶囊行容器 + 共享展开身份 / 折叠测量 context；经 `ConversationStatusPanel.tsx` re-export 保持官方导入路径。 |
| `statusContent` / `queueContent`                       | `ConversationComposer` props（ReactNode，被动渲染）      | composer 不解析内容，仅在错误横幅未展示时渲染状态行，队列紧邻输入 surface。                                     |
| `ZCodeAgentRuntimeExitedEvent` / `onRuntimeExited`     | `zcodeAgentProcessManager`（唯一发布方）                 | 仅主泳道（无 lane）unexpected 退出发布；晚于同进程 unavailable。                                                |
| `onAgentRuntimeExited`                                 | `IZCodeAgentService`（可选方法，直通 process manager）   | 与 `onAgentRuntimeLifecycle` 同款直通；远端 / 无该事件的服务面不显示横幅。                                      |
| `useAgentRuntimeExitNotice` / `AgentRuntimeExitBanner` | `src/v4/AgentRuntimeExitBanner.tsx`（自官方搬移）        | hook 持有本地 exit 展示态，dismiss 仅清展示；不写会话投影。                                                     |
| `classifyAgentProcessExitCause`                        | `@zcode/shared/agent-crash-diagnostic`（自官方搬移子集） | 纯函数；只认 Windows 0xE0000008，不按信号推断内存不足。                                                         |

## 事件顺序

```
runtime 进程意外退出
  └─ child "exit"（stderr 收齐、退出码可用）
       → runtimeLifecycleEmitter: unavailable（既有）
       → terminationKind === "unexpected" && 主泳道
           → runtimeExitedEmitter: ZCodeAgentRuntimeExitedEvent
           → zcodeAgentService.onAgentRuntimeExited 直通
           → useAgentRuntimeExitNotice（workspaceKey 匹配）→ AgentRuntimeExitBanner
           → 用户 dismiss / 切换 workspace → 仅清展示态
重连后的 CLI 投影 → 回合 / 子代理终态（既有链路，横幅不参与）
```

## 与官方的已知差异（数据源 / 设计边界，不硬造）

- 官方 `ConversationStatusPanel` 是胶囊 + popover 详情；本仓库沿用既有摘要 / 分区面板模型，
  dock 内默认 mini、显式展开为内联分区（占 dock 高度），不搬官方胶囊详情交互。
- 官方 props 中本仓库数据源没有的不传：`gitCwd`、`endedSubagents`（snapshot 只有
  `endedTotal`）、`completedActivityCount`、`activitySummaryDismissed`、`timersPaused`、
  `pendingSubagentStops`、`onStopSubagent`、`onOpenWorkflowRunDirectory` 的远控紧凑态门禁
  （本仓库无 compactForRemoteControl 对应门禁时按既有回调直传）。
- 只读 dock 的 `readOnlyReason` 提示：本仓库 SessionPane 无该数据源，不渲染。
- composer 状态行的 `initialization?.status !== "failed"` 门禁：本仓库 composer 无
  initialization 投影，仅按错误横幅条件门禁。
- runtime 退出原因分类只搬 `classifyAgentProcessExitCause` 子集；官方完整 crash 诊断 /
  脱敏上报不在本次范围。

## 验收场景

1. 有活动（git / goal / plan / 后台任务 / 子代理 / workflow）的会话：composer 上方出现
   状态摘要胶囊；无活动时该行隐藏（empty:hidden），不占高度。
2. 额度横幅接管错误位时状态行隐藏；错误横幅展示时状态行同样隐藏。
3. 队列有已接纳输入：队列紧邻输入框上方；出现阻塞交互（权限 / 问答）时 composer 隐藏，
   队列仍在 dock 内可管理（pb-7 外层）。
4. 只读 subagent 观察视图：无 composer，dock 仍渲染状态行。
5. runtime 意外退出：横幅出现在额度横幅之后，文案区分内存不足 / 通用；dismiss 后消失；
   切换 workspace 不串台；正常回收 / 换代 / 关闭不触发。
6. `pnpm typecheck` / `pnpm lint` 通过（基线 81 warnings 0 errors）。

## 子智能体 liveness 销账（2026-11-27，CLI 根因修复）

- 现象：状态面板「已运行 N 千分钟」假运行态——子智能体早已结束但仍挂 running。
- 根因：`runningStatus`（bootstrap subagent-session-query.ts）对 runInBackground 子智能体，在父 runtime 空闲释放（background/childProjection 皆缺）且 child 末条 assistant 带 tool round（childOutcome 无终态）时兜底返回 running，永久 stale。
- 修复：以 child session 自身持久化终态 `time.completed` 为判据——runningStatus 见 completed 即返回 undefined（ended）；endedStatus 见 completed 返回 success（而非 lost）。
- 真相源在 CLI projection，UI 不做二次销账（子智能体 child 不进 tasks-index，UI 侧无可靠真相源）。

## 后台进程 liveness 销账（2026-11-27）

- 现象：打包等后台 bash 早已结束，状态面板「进程」仍挂「后台进行中」。
- 根因：runtime 释放丢 `BackgroundTaskCompleted` 事件；registry 纯内存，hydrate 重建的 backgroundWorks 停 running。
- 修复：`backgroundWorkSummarySchema` 增 `pid`；`onBackgroundTaskLifecycle` 从 Started/Completed payload 保留 pid（hydrate 重放旧事件亦能补齐）；`getSnapshot()` 读取时 `reconcileStaleBackgroundWorks()`：running bash 且 pid 进程已不存在（`process.kill(pid,0)` ESRCH）⇒ cancelled + endedAt。
- 与子智能体销账（child session time.completed）同范式：读取侧按持久化/OS 事实销账，不依赖易丢的结束事件。
