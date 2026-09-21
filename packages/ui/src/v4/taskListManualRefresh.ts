// 任务列表手动刷新的全局串行号。
// tasks-index.sqlite 可能被其他进程（官方客户端等）直接写入，本进程事件链路收不到
// workspace_task_list_changed，controller channel 的 queryCache 不会失效。头部刷新按钮
// bump 这里的串行号，useGlobalTaskList 将其并入 manualRefreshSerial 版本键强制缓存 miss。
import { useSyncExternalStore } from "react";

let serial = 0;
const listeners = new Set<() => void>();

/** 手动刷新入口：通知所有 controller channel 任务列表（置顶/归档/时间线/搜索）重新拉取。 */
export function bumpTaskListManualRefresh(): void {
  serial += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeTaskListManualRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getTaskListManualRefreshSerial(): number {
  return serial;
}

/** React 绑定：串行号变化触发重渲染并重查。 */
export function useTaskListManualRefreshSerial(): number {
  return useSyncExternalStore(subscribeTaskListManualRefresh, getTaskListManualRefreshSerial);
}
