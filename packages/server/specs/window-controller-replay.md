# window-controller replayable 实现（server 宿主）

## 背景与行为

Web/命令行版的 renderer 侧任务列表（置顶区、已归档视图、全局搜索）通过
`IWindowControllerService.listTaskList` 读取列表。桌面端该 channel 由窗口 Host 的
`windowHostControllerService`（实时投影，desktop-continuous 语义）提供；server 宿主
此前没有注册该 channel，RPC 超时后 UI 静默保留空列表，表现为 web 端看不到置顶
任务、已归档视图为空且无法删除。

本 spec 定义 server 宿主上的 replayable 实现：无自有状态，全部转发
`IZCodeTaskService`（tasks-index 权威），不维护实时帧。

## 所有权与边界

- 数据真相：`zcodeTaskService`（tasks-index.sqlite）。本服务是纯投影，不缓存、不落盘。
- 事件顺序：renderer 置顶/归档视图的重查扳机是 controller registry 收到 tasks-index
  delta 帧后失效缓存；桌面端该帧由窗口 Host 实时投影发出，replayable 后端没有投影，
  因此本实现约定：**每个 mutation（pin/archive/delete/mark-read/delete-archived）成功
  后必须广播一条 `controller/tasks-index` 的 deltas 帧**（进程级固定 logEpoch +
  单调 seq，保证不触发 renderer 的 gap resync）。列表读取本身不发帧。
- 订阅：`subscribeControllerV4`/`resyncControllerV4` 立即返回 snapshot ack；ack 的
  logEpoch 与后续 delta 帧一致，subscriptionId 仅用于帧路由。
  `unsubscribeControllerV4` 为空操作。

## 接口映射

| IWindowControllerService | 转发目标 |
| --- | --- |
| listTaskList(kind=pinned) | listPinnedTasks(scope) |
| listTaskList(kind=archived) | listArchivedTasks(scope) |
| listTaskList(kind=timeline/active) | listTasks(scope) |
| listTaskList(search 非空) | zcodeTaskService.listTaskList(query)（全文检索） |
| mutateTask(pin) | setTaskPinned |
| mutateTask(archive) | archiveTask / unarchiveTask |
| mutateTask(delete) | deleteTask（返回 null） |
| mutateTask(delete-archived) | deleteArchivedTask（返回 null） |
| mutateTask(mark-read / mark-unread) | setTaskUnread |
| mutateTask(open) | 无服务端效果，返回 null |
| deleteArchivedTask / deleteArchivedTasks | 同名转发 |

返回的 items 补 `sourceAvailability: "online"` 与按 meta 推导的 `liveStatus`
（completed/error/idle），与桌面实现的行形状一致。

## 失败语义

单个 scope 的列表读取失败直接抛出，由 UI 侧 `useGlobalTaskList` 的既有 catch
保留旧列表（不清空其他 workspace 的可信投影）。

## 验收

1. web 端侧栏置顶区显示 tasks-index 中 `pinned=1` 的任务。
2. 已归档视图可列出并删除归档任务。
3. pin/unpin/archive 后列表随事件刷新。
4. 桌面端行为不受影响（server 仅在 channel 未注册时补充注册）。
