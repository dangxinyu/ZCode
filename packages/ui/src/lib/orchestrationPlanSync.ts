// 编排计划的跨组件同步信号 + 计划页路由（spec: orchestration-plan.md）。
// 1) 版本号：composer 滑块 / 侧栏列表 / 计划页任一方变更计划 → 广播重拉。
// 2) 页面信号：侧栏/composer 请求打开某编排的计划页（覆盖对话区的独立视图，
//    用户需求 2026-10-28：计划与对话来回切）——SessionPane 消费此信号切换视图。
import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { ORCHESTRATION_PLANS_CHANGED_BROADCAST_CHANNEL } from "@zcode/shared";

let version = 0;
const listeners = new Set<() => void>();

export function bumpOrchestrationPlanVersion(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOrchestrationPlanVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/**
 * 订阅 host 的计划变更广播（agent 侧提案/确认/派发/进度不经 UI 动作，无此信号
 * 画布/列表停在旧快照——用户需求 2026-10-30）。收到即 bump 全局版本号，
 * 所有 useOrchestrationPlanVersion 消费方统一重拉。结构化参数避免服务依赖环。
 */
export function useOrchestrationPlansChangedSync(
  broadcast: {
    onMessage: (listener: (message: { channel: string }) => void) => { dispose: () => void };
  } | null,
): void {
  useEffect(() => {
    if (!broadcast) return;
    const disposable = broadcast.onMessage((message) => {
      if (message.channel === ORCHESTRATION_PLANS_CHANGED_BROADCAST_CHANNEL) {
        bumpOrchestrationPlanVersion();
      }
    });
    return () => disposable.dispose();
  }, [broadcast]);
}

/** 计划页打开请求：sessionId + 可选聚焦的 planId。close = 置回 null。 */
interface PlanPageRequest {
  sessionId: string;
  focusPlanId: string | null;
}

let pageRequest: PlanPageRequest | null = null;

export function openOrchestrationPlanPage(sessionId: string, focusPlanId?: string): void {
  pageRequest = { sessionId, focusPlanId: focusPlanId ?? null };
  bumpOrchestrationPlanVersion();
}

export function closeOrchestrationPlanPage(): void {
  pageRequest = null;
  bumpOrchestrationPlanVersion();
}

export function useOrchestrationPlanPageRequest(): PlanPageRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => pageRequest,
    () => pageRequest,
  );
}

/**
 * 子任务跳转通道：计划页在 SessionPane 深处，没有任务切换回调可传——App 启动时
 * 注册全局 handleSelectTask（useAppPanels），计划页经此跳转子任务会话。
 */
type TaskOpener = (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

let taskOpener: TaskOpener | null = null;

export function registerOrchestrationTaskOpener(opener: TaskOpener | null): void {
  taskOpener = opener;
}

export function openTaskViaOrchestration(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): void {
  taskOpener?.(workspacePath, taskId, workspaceIdentity);
}
