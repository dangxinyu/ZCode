// 编排分区工作区分组的折叠态（spec: orchestration-tasks.md）。
// 编排 tab 按工作区分组展示，分组折叠选择需要跨渲染一致并持久化：
// 模块级单例 + useSyncExternalStore 订阅，localStorage 持久化。
// 默认展开（分组是主要导航），存储记录的是"用户收起的"工作区 key 集合。
import { useCallback, useSyncExternalStore } from "react";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

const STORAGE_KEY = "zcode-orchestration-workspace-groups-collapsed";

let collapsedKeys: Set<string> = new Set(readFromStorage());
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

function writeToStorage(keys: Set<string>): void {
  try {
    getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // storage 受限时折叠选择只活在当前进程，不阻断交互。
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

export function useOrchestrationWorkspaceGroupsCollapsed(): {
  isGroupCollapsed: (workspaceKey: string) => boolean;
  toggleGroupCollapsed: (workspaceKey: string) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  void snapshot;
  const isGroupCollapsed = useCallback((workspaceKey: string) => collapsedKeys.has(workspaceKey), []);
  const toggleGroupCollapsed = useCallback((workspaceKey: string) => {
    const next = new Set(collapsedKeys);
    if (next.has(workspaceKey)) {
      next.delete(workspaceKey);
    } else {
      next.add(workspaceKey);
    }
    collapsedKeys = next;
    writeToStorage(next);
    emitChange();
  }, []);
  return { isGroupCollapsed, toggleGroupCollapsed };
}
