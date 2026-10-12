// 编排任务子任务折叠态的跨组件共享（spec: orchestration-tasks.md）。
// 编排分区与置顶区都会渲染编排任务的子任务展开器，同一编排的展开选择必须在
// 两处一致：模块级单例 + useSyncExternalStore 订阅，localStorage 持久化。
// 默认收起（空态提示"尚未派生"不常驻，展开是用户的主动动作——联调用户反馈），
// 存储记录的是"用户展开过的"集合；键名与旧的 collapsed 集合刻意不同，避免旧数据反读。
import { useCallback, useSyncExternalStore } from "react";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

const STORAGE_KEY = "zcode-orchestration-children-expanded";

let expandedIds: Set<string> = new Set(readFromStorage());
let version = 0;
const listeners = new Set<() => void>();

function readFromStorage(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === "string") as string[]) : [];
  } catch {
    return [];
  }
}

function writeToStorage(ids: Set<string>): void {
  try {
    getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // storage 受限时展开选择只活在当前进程，不阻断交互。
  }
}

function emitChange(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOrchestrationChildrenCollapsed(): {
  isCollapsed: (parentTaskId: string) => boolean;
  toggleCollapsed: (parentTaskId: string) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  void snapshot;
  const isCollapsed = useCallback(
    (parentTaskId: string) => !expandedIds.has(parentTaskId),
    [],
  );
  const toggleCollapsed = useCallback((parentTaskId: string) => {
    const next = new Set(expandedIds);
    if (next.has(parentTaskId)) {
      next.delete(parentTaskId);
    } else {
      next.add(parentTaskId);
    }
    expandedIds = next;
    writeToStorage(next);
    emitChange();
  }, []);
  return { isCollapsed, toggleCollapsed };
}
