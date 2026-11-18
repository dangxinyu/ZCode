// 编排计划开关的 composer 数据源 v2（spec: packages/services/specs/orchestration-plan.md）。
// 输入框工具栏的"计划模式"滑块只在编排主任务会话显示；切换不发消息（纯配置翻转）。
// 草稿态（新建编排任务，尚未首发）：开关先记本地意图，会话创建后自动补投。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeOrchestrationPlansMap } from "@zcode/shared";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import {
  bumpOrchestrationPlanVersion,
  openOrchestrationPlanPage,
  useOrchestrationPlanVersion,
  useOrchestrationPlansChangedSync,
} from "@/lib/orchestrationPlanSync.js";

export interface OrchestrationPlanControl {
  /** 当前会话是否编排主任务（false = 工具栏不渲染开关）。 */
  isOrchestrator: boolean;
  /** 开关态：草稿意图优先，回落持久模式开关。 */
  planModeOn: boolean;
  /** 模式开时的计划视图（下拉切换计划 + activePlanId）。 */
  plansMap: ZCodeOrchestrationPlansMap | null;
  sessionId: string | null;
  busy: boolean;
  togglePlanMode: () => void;
  /** 下拉切换选中计划（纯配置，不发消息）。 */
  selectPlan: (planId: string) => void;
  /** 「另起新计划」等待态（服务端事实 plansMap.pendingNewPlan）：只挂状态不发消息，
   * 起不起新计划由后续对话决定；新计划落地或用户取消时自动消失。
   * 草稿态（无 sessionId）默认 true（镜像服务端零计划开启模式默认挂起的规则）。 */
  pendingNewPlan: boolean;
  /** 等待态开关：未挂起 → 挂起；已挂起 → 取消。均不发消息。草稿态只记本地意图，建会话后补投。 */
  requestNewPlanIntent: () => void;
  /** 打开计划页（覆盖对话区的独立视图）。 */
  openPlanPage: () => void;
}

export function useOrchestrationPlanControl(params: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 草稿态且为编排任务入口（新建编排任务的首发前）。 */
  draftOrchestration?: boolean;
}): OrchestrationPlanControl {
  const { sessionId, workspacePath, workspaceIdentity, draftOrchestration = false } = params;
  const services = useWorkspaceServices(workspacePath || null, null, workspaceIdentity ?? null);
  // 角色判据走 sessions-index 聚合（summary.orchestrationRole 由 CLI taskType 投影）。
  const { items } = useWorkspaceSessionsIndexItems(
    useMemo(
      () =>
        workspacePath
          ? [
              {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
            ]
          : [],
      [workspacePath, workspaceIdentity],
    ),
  );
  const isOrchestrator = useMemo(() => {
    if (!sessionId) return draftOrchestration;
    const summary = items.find((item) => item.taskId === sessionId);
    return summary?.orchestrationRole === "orchestrator";
  }, [draftOrchestration, items, sessionId]);

  const [plansMap, setPlansMap] = useState<ZCodeOrchestrationPlansMap | null>(null);
  const [busy, setBusy] = useState(false);
  // agent 侧计划变更（提案/派发/进度）广播 → 重拉 plansMap（用户需求 2026-10-30）。
  useOrchestrationPlansChangedSync(services.broadcastService ?? null);
  // 侧栏的计划变更（选中/提案/确认）也反映到滑块态：版本号进重拉依赖。
  const planVersion = useOrchestrationPlanVersion();
  useEffect(() => {
    if (!sessionId || !isOrchestrator) {
      setPlansMap(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const map = await services.zcodeTaskService.getOrchestrationPlansMap({
          orchestrationTaskIds: [sessionId],
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        if (!cancelled) setPlansMap(map[sessionId] ?? null);
      } catch {
        // 计划读取失败不阻断会话；开关态退化为关（可重试开启）。
        if (!cancelled) setPlansMap(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOrchestrator, planVersion, services, sessionId, workspaceIdentity, workspacePath]);

  // 草稿态的开关意图：会话创建后由 effect 补投到 host。
  const [pendingDraftMode, setPendingDraftMode] = useState<boolean | null>(null);
  const applyingPendingRef = useRef(false);
  useEffect(() => {
    if (!sessionId || pendingDraftMode === null || applyingPendingRef.current) return;
    applyingPendingRef.current = true;
    setBusy(true);
    void services.zcodeTaskService
      .setOrchestrationPlanMode({
        orchestrationTaskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        enabled: pendingDraftMode,
      })
      .then((next) => {
        setPlansMap(next);
        setPendingDraftMode(null);
        bumpOrchestrationPlanVersion();
      })
      .catch(() => {
        // 补投失败保留意图，不阻断会话。
      })
      .finally(() => {
        applyingPendingRef.current = false;
        setBusy(false);
      });
  }, [pendingDraftMode, services, sessionId, workspaceIdentity, workspacePath]);

  const togglePlanMode = useCallback(() => {
    if (busy || !isOrchestrator) return;
    // 草稿（无 sessionId）：只记本地意图，首发建会话后补投。
    if (!sessionId) {
      setPendingDraftMode((current) => !(current ?? false));
      return;
    }
    setBusy(true);
    void services.zcodeTaskService
      .setOrchestrationPlanMode({
        orchestrationTaskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        enabled: !(plansMap?.planMode ?? false),
      })
      .then((next) => {
        setPlansMap(next);
        bumpOrchestrationPlanVersion();
      })
      .catch(() => {
        // 失败保持原状态；host 未落库，无半开状态。
      })
      .finally(() => setBusy(false));
  }, [
    busy,
    isOrchestrator,
    plansMap?.planMode,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  const selectPlan = useCallback(
    (planId: string) => {
      if (!sessionId || busy) return;
      setBusy(true);
      void services.zcodeTaskService
        .selectOrchestrationPlan({
          orchestrationTaskId: sessionId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          planId,
        })
        .then((next) => {
          setPlansMap(next);
          bumpOrchestrationPlanVersion();
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    },
    [busy, services, sessionId, workspaceIdentity, workspacePath],
  );

  // 「另起新计划」等待态：服务端事实（plansMap.pendingNewPlan），不发消息——
  // 起不起新计划由后续对话决定（用户需求 2026-10-29 改版）。
  // 新计划落地（agent 走 createNew 提案）或用户再点取消时由服务端清除，
  // UI 随 plansMap 重拉自动同步。
  //
  // 草稿态（新建编排任务未首发，无 sessionId）没有服务端事实：原先下拉显示「暂无计划」
  // 且「新建计划」因无 sessionId 直接短路成死点击（用户反馈 2026-11-02）。修复：
  // 1) 开关开着时默认 true——草稿必然零计划，镜像服务端 setPlanMode 零计划默认挂起的规则，
  //    与建会话后的真实状态一致；2) 点击走与 togglePlanMode 同款的本地意图通道，
  //    未点过跟随默认，点过以最后一次为准，建会话后补投。
  const [pendingDraftNewPlan, setPendingDraftNewPlan] = useState<boolean | null>(null);
  // 模式意图尚未补投完（含建会话后到 setPlanMode 返回前的窗口）都按默认 true 显示，避免闪回「暂无计划」。
  const draftPendingDefault = pendingDraftMode === true;
  const pendingNewPlan = plansMap?.pendingNewPlan ?? pendingDraftNewPlan ?? draftPendingDefault;
  const applyingNewPlanRef = useRef(false);
  useEffect(() => {
    // 必须等模式意图补投完（pendingDraftMode 归 null）再补投：setPlanMode 零计划会默认
    // 置 pending=true，顺序颠倒会把用户在草稿态的显式取消覆盖掉。
    if (
      !sessionId ||
      pendingDraftNewPlan === null ||
      pendingDraftMode !== null ||
      applyingNewPlanRef.current
    ) {
      return;
    }
    applyingNewPlanRef.current = true;
    setBusy(true);
    void services.zcodeTaskService
      .setOrchestrationNewPlanPending({
        orchestrationTaskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        pending: pendingDraftNewPlan,
      })
      .then((next) => {
        setPlansMap(next);
        setPendingDraftNewPlan(null);
        bumpOrchestrationPlanVersion();
      })
      .catch(() => {
        // 补投失败保留意图，不阻断会话。
      })
      .finally(() => {
        applyingNewPlanRef.current = false;
        setBusy(false);
      });
  }, [pendingDraftMode, pendingDraftNewPlan, services, sessionId, workspaceIdentity, workspacePath]);

  const requestNewPlanIntent = useCallback(() => {
    if (busy) return;
    // 草稿（无 sessionId）：只记本地意图，首发建会话后补投。未点过视为默认 true。
    if (!sessionId) {
      setPendingDraftNewPlan((current) => !(current ?? draftPendingDefault));
      return;
    }
    setBusy(true);
    void services.zcodeTaskService
      .setOrchestrationNewPlanPending({
        orchestrationTaskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        pending: !pendingNewPlan,
      })
      .then((next) => {
        setPlansMap(next);
        bumpOrchestrationPlanVersion();
      })
      .catch(() => {
        // 失败保持原状态；host 未落库，无半开状态。
      })
      .finally(() => setBusy(false));
  }, [
    busy,
    draftPendingDefault,
    pendingNewPlan,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    isOrchestrator,
    planModeOn: pendingDraftMode ?? plansMap?.planMode ?? false,
    plansMap,
    sessionId,
    busy,
    togglePlanMode,
    selectPlan,
    pendingNewPlan,
    requestNewPlanIntent,
    openPlanPage: () => {
      if (sessionId) openOrchestrationPlanPage(sessionId);
    },
  };
}
