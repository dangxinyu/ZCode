// 编排子任务的"下拉内置顶"（spec: orchestration-tasks.md）：被钉住的子任务在该编排的
// 子任务下拉里排最前。刻意不复用 tasks-index 的全局 pinned 列——那会把子任务抬进
// 全局置顶区，语义越界；这是纯 UI 排序偏好，localStorage 持久化 + 跨分区/置顶区共享。
import { useCallback, useSyncExternalStore } from "react";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

const STORAGE_KEY = "zcode-orchestration-children-pinned";

function childKey(parentTaskId: string, childTaskId: string): string {
  return `${parentTaskId}\u0000${childTaskId}`;
}

function readFromStorage(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === "string") as string[]) : [];
  } catch {
    return [];
  }
}

let pinnedChildKeys: Set<string> = new Set(readFromStorage());
let version = 0;
const listeners = new Set<() => void>();

function writeToStorage(keys: Set<string>): void {
  try {
    getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // storage 受限时钉选只活在当前进程，不阻断交互。
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

export function useOrchestrationChildrenPinned(): {
  isChildPinned: (parentTaskId: string, childTaskId: string) => boolean;
  toggleChildPinned: (parentTaskId: string, childTaskId: string) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  void snapshot;
  const isChildPinned = useCallback(
    (parentTaskId: string, childTaskId: string) => pinnedChildKeys.has(childKey(parentTaskId, childTaskId)),
    [],
  );
  const toggleChildPinned = useCallback((parentTaskId: string, childTaskId: string) => {
    const key = childKey(parentTaskId, childTaskId);
    const next = new Set(pinnedChildKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    pinnedChildKeys = next;
    writeToStorage(next);
    emitChange();
  }, []);
  return { isChildPinned, toggleChildPinned };
}
