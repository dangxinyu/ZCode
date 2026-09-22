import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostControllerTaskDelta } from "@zcode/shared/zcode-protocol-v4";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import type {
  ServiceCollection,
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
} from "@zcode/services";
import { IWindowControllerService, IZCodeTaskService } from "@zcode/services";

/**
 * server 宿主的 window-controller replayable 实现。
 *
 * Web/命令行版 renderer 的任务列表（置顶区、已归档视图、全局搜索）经
 * IWindowControllerService.listTaskList 读取；桌面端由窗口 Host 的实时投影提供，
 * server 侧此前未注册该 channel，RPC 超时后 UI 静默保留空列表，表现为 web 端
 * 置顶任务与已归档视图不可见。本实现不持有业务状态：列表读取全部转发
 * zcodeTaskService（tasks-index 权威），mutation 成功后广播一条 tasks-index
 * delta 帧，驱动 renderer 的 controller registry 失效缓存并重查——桌面端该
 * 扳机由 Host 实时投影发出，replayable 后端没有投影，必须在 mutation 出口补发。
 * 行为规约见 specs/window-controller-replay.md。
 */
export function createWindowControllerReplayService(
  taskService: IZCodeTaskService,
): IWindowControllerService {
  const frameEmitter = new Emitter<WindowHostControllerFrame>();
  // 进程级固定 logEpoch + 单调 seq：renderer registry 用 (logEpoch, seq) 做 gap 检测，
  // 连续递增的 fromSeq/toSeq 保证不触发 forceSnapshot resync。
  const logEpoch = randomUUID();
  let seqCounter = 0;
  let lastSubscriptionId = "";
  // 查询过的 scope 建立 workspace 事件订阅；mutation 出口统一由事件转译成 delta 帧，
  // 覆盖 UI 直调 zcodeTaskService（置顶/归档操作不走 controller.mutateTask）的场景。
  const subscribedEventDisposables = new Map<string, { dispose(): void }>();

  function ensureWorkspaceEventSubscription(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): void {
    const key = `${scope.workspaceIdentity?.trim() || ""}::${scope.workspacePath}`;
    if (subscribedEventDisposables.has(key)) {
      return;
    }
    const disposable = taskService.onDynamicWorkspaceEvent({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    })((event) => {
      if (event.type !== "workspace_task_list_changed") {
        return;
      }
      if (event.taskMeta) {
        emitTaskDeltas(membershipInvalidationDeltas(event.taskMeta));
        return;
      }
      if (event.taskId) {
        emitTaskDeltas([
          removedDelta({
            workspacePath: event.workspacePath,
            workspaceIdentity: event.workspaceIdentity,
            taskId: event.taskId,
          }),
        ]);
      }
    });
    subscribedEventDisposables.set(key, disposable);
  }

  function liveStatusFromMeta(status: string | undefined): "completed" | "error" | "idle" {
    if (status === "completed") return "completed";
    if (status === "error") return "error";
    return "idle";
  }

  function projectItem(item: ZCodeTaskListItem): WindowHostControllerTaskListItem {
    return {
      ...item,
      sourceAvailability: "online",
      liveStatus: liveStatusFromMeta(item.status),
    };
  }

  function compareItems(
    left: WindowHostControllerTaskListItem,
    right: WindowHostControllerTaskListItem,
    sortBy: ZCodeTaskListQuery["sortBy"],
  ): number {
    if (sortBy === "created") {
      return right.createdAt - left.createdAt || right.updatedAt - left.updatedAt;
    }
    return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt;
  }

  async function listPartitionTasks(
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult> {
    const lists = await Promise.all(
      query.workspaceScopes.map(async (scope) => {
        const scopeParams = {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        };
        ensureWorkspaceEventSubscription(scopeParams);
        if (query.kind === "pinned") {
          return taskService.listPinnedTasks(scopeParams);
        }
        if (query.kind === "archived") {
          return taskService.listArchivedTasks(scopeParams);
        }
        return taskService.listTasks(scopeParams);
      }),
    );
    const items = lists
      .flat()
      .map(projectItem)
      .sort((left, right) => compareItems(left, right, query.sortBy));
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total: items.length, hasMore: items.length > visible.length };
  }

  function scopeParamsOf(address: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): { workspacePath: string; workspaceIdentity?: string } {
    return {
      workspacePath: address.workspacePath,
      ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
    };
  }

  /** mutation 成功后广播 delta 帧；subscriptionId 取最近一次订阅，registry 按 delta 内容失效缓存。 */
  function emitTaskDeltas(deltas: WindowHostControllerTaskDelta[]): void {
    if (deltas.length === 0 || !lastSubscriptionId) {
      return;
    }
    // 协议要求 frame.fromSeq === 消费端 cursor.seq（上一帧的 toSeq），否则判 gap 触发 resync。
    // 这里 fromSeq 取上一帧 toSeq、toSeq 前进一格，保证连续流不误判。
    const fromSeq = seqCounter;
    seqCounter = fromSeq + 1;
    frameEmitter.fire({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      subscriptionId: lastSubscriptionId,
      logEpoch,
      fromSeq,
      toSeq: seqCounter,
      sentAt: Date.now(),
      payload: { kind: "deltas", deltas },
    });
  }

  /**
   * gap/重连自愈：广播一个空 snapshot 帧重置消费端 cursor 并清空其投影缓存，
   * registry 随即整轮重查（本实现列表读取实时转发 tasks-index，重查即恢复真相）。
   */
  function emitEmptySnapshotFrame(subscriptionId: string): void {
    const toSeq = seqCounter + 1;
    seqCounter = toSeq;
    frameEmitter.fire({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      subscriptionId,
      logEpoch,
      fromSeq: 0,
      toSeq,
      sentAt: Date.now(),
      // 快照 schema 已收紧为 strict（必须携带 protocolVersion/logEpoch 与帧头的
      // (logEpoch, seq) 对齐）；空 snapshot 缺字段会让消费端解析失败，
      // gap 自愈重置反而断流，这里补齐同一 envelope 字段。
      payload: {
        kind: "snapshot",
        snapshot: { protocolVersion: 1, logEpoch, tasks: [] },
      },
    });
  }

  /**
   * 事件携带的 ZCodeTaskMeta 不含 pinned/archived（adapter 序列化不回传组织态），
   * 无法构造精确 membership。这里发一对互补 membership 的 upserted delta
   * （pinned 变体 + timeline 变体）：renderer registry 按 previous/next 任一命中
   * 即失效对应 kind 的缓存，重查后拿到真实归属——删除/归档/置顶全场景通用。
   */
  function membershipInvalidationDeltas(meta: ZCodeTaskMeta): WindowHostControllerTaskDelta[] {
    const task = {
      address: {
        workspacePath: meta.workspacePath,
        ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
        taskId: meta.taskId,
      },
      meta,
      sourceAvailability: "online" as const,
      liveStatus: liveStatusFromMeta(meta.status),
    };
    return [
      { op: "task.upserted", task: { ...task, membership: { pinned: true, archived: false, active: true } } },
      { op: "task.upserted", task: { ...task, membership: { pinned: false, archived: false, active: true } } },
    ];
  }

  function removedDelta(address: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): WindowHostControllerTaskDelta {
    return {
      op: "task.removed",
      address: {
        workspacePath: address.workspacePath,
        ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        taskId: address.taskId,
      },
    };
  }

  return {
    async listTaskList(query) {
      if (query.search?.trim()) {
        const result = await taskService.listTaskList(query);
        const items = result.items.map(projectItem);
        return { ...result, items };
      }
      return listPartitionTasks(query);
    },
    async deleteArchivedTask({ address }) {
      return taskService.deleteArchivedTask({
        taskId: address.taskId,
        ...scopeParamsOf(address),
      });
    },
    async deleteArchivedTasks({ address, taskIds }) {
      if (taskIds.length === 0) {
        return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
      }
      return taskService.deleteArchivedTasks({
        taskIds,
        ...scopeParamsOf(address),
      });
    },
    async mutateTask({ address, mutation }): Promise<ZCodeTaskMeta | null> {
      const base = { taskId: address.taskId, ...scopeParamsOf(address) };
      switch (mutation.kind) {
        case "pin": {
          const meta = await taskService.setTaskPinned({ ...base, pinned: mutation.pinned });
          return meta;
        }
        case "archive": {
          const meta = mutation.archived
            ? await taskService.archiveTask(base)
            : await taskService.unarchiveTask(base);
          return meta;
        }
        case "delete": {
          await taskService.deleteTask(base);
          return null;
        }
        case "delete-archived": {
          await taskService.deleteArchivedTask(base);
          return null;
        }
        case "mark-read": {
          const meta = await taskService.setTaskUnread({
            ...base,
            unread: false,
            ...(mutation.expectedUnreadAt !== undefined
              ? { expectedUnreadAt: mutation.expectedUnreadAt }
              : {}),
          });
          return meta;
        }
        case "mark-unread": {
          const meta = await taskService.setTaskUnread({ ...base, unread: true });
          return meta;
        }
        case "open":
        case "resume":
          // 会话打开/恢复是运行时动作，无列表归属变更。
          return null;
      }
    },
    async subscribeControllerV4() {
      // replayable 语义：ack 后不主动发 snapshot 帧；变更由 workspace 事件转译成 delta 广播。
      const subscriptionId = randomUUID();
      lastSubscriptionId = subscriptionId;
      return { ack: { subscriptionId, mode: "snapshot", logEpoch } };
    },
    async resyncControllerV4() {
      // gap 自愈：ack 的同时广播空 snapshot 重置消费端 cursor，驱动整轮重查。
      const subscriptionId = randomUUID();
      lastSubscriptionId = subscriptionId;
      emitEmptySnapshotFrame(subscriptionId);
      return { ack: { subscriptionId, mode: "snapshot", logEpoch } };
    },
    async unsubscribeControllerV4() {
      // 无后台订阅状态可清理。
    },
    onDynamicControllerFrame() {
      return frameEmitter.event;
    },
  };
}

/** 在 http 宿主装配期补充 window-controller channel；已有实现（测试注入等）不覆盖。 */
export function registerWindowControllerReplayService(services: ServiceCollection): void {
  if (services.getOptional(IWindowControllerService)) {
    return;
  }
  services.register(
    IWindowControllerService,
    createWindowControllerReplayService(services.get(IZCodeTaskService)),
  );
}
