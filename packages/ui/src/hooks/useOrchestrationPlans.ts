// 编排计划数据源 v2（spec: packages/services/specs/orchestration-plan.md 多计划）。
// 侧栏计划列表（可展开）与画布详情共用：模式开关态 + 全量计划 + activePlanId，
// 按 workspace 分组批量拉取（任务服务按 workspace 定位 tasks-index）。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodeOrchestrationPlansMap } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  bumpOrchestrationPlanVersion,
  useOrchestrationPlanVersion,
} from "@/lib/orchestrationPlanSync.js";

/** 计划面板需要的任务服务面（结构等价于 IZCodeTaskService 的计划方法族）。 */
export interface OrchestrationPlanTaskService {
  getOrchestrationPlansMap(params: {
    orchestrationTaskIds: string[];
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<Record<string, ZCodeOrchestrationPlansMap>>;
  setOrchestrationPlanMode(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    enabled: boolean;
  }): Promise<ZCodeOrchestrationPlansMap>;
  selectOrchestrationPlan(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string | null;
  }): Promise<ZCodeOrchestrationPlansMap>;
  confirmOrchestrationPlan(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeOrchestrationPlansMap>;
  proposeOrchestrationPlanEdit(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
    nodes: Array<{
      nodeId: string;
      name: string;
      goal: string;
      dependsOn: string[];
      needsUpstreamResult: boolean;
      layout?: { x: number; y: number; w?: number; h?: number };
    }>;
  }): Promise<ZCodeOrchestrationPlansMap>;
  createOrchestrationPlan(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ZCodeOrchestrationPlansMap>;
  renameOrchestrationPlan(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string;
    title: string;
  }): Promise<ZCodeOrchestrationPlansMap>;
  deleteOrchestrationPlan(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string;
  }): Promise<ZCodeOrchestrationPlansMap>;
}

interface UseOrchestrationPlansParams {
  enabled: boolean;
  orchestrators: Array<{ taskId: string; workspacePath: string; workspaceIdentity?: string }>;
  resolvePlanServices: (
    workspacePath: string,
    workspaceIdentity?: string,
  ) => OrchestrationPlanTaskService | undefined;
  refreshKey: string | number;
}

export function useOrchestrationPlans({
  enabled,
  orchestrators,
  resolvePlanServices,
  refreshKey,
}: UseOrchestrationPlansParams): {
  plansByParentId: Record<string, ZCodeOrchestrationPlansMap> | null;
  setPlanMode: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    enabled: boolean;
  }) => Promise<void>;
  selectPlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string | null;
  }) => Promise<void>;
  confirmPlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  proposePlanEdit: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
    nodes: Array<{
      nodeId: string;
      name: string;
      goal: string;
      dependsOn: string[];
      needsUpstreamResult: boolean;
      layout?: { x: number; y: number; w?: number; h?: number };
    }>;
  }) => Promise<void>;
  createPlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }) => Promise<void>;
  renamePlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string;
    title: string;
  }) => Promise<void>;
  deletePlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planId: string;
  }) => Promise<void>;
} {
  const [plansByParentId, setPlansByParentId] = useState<Record<
    string,
    ZCodeOrchestrationPlansMap
  > | null>(null);
  // 计划版本号（composer 滑块/画布等任意方变更）进重拉依赖，双侧即时同步。
  const planVersion = useOrchestrationPlanVersion();
  const orchestratorsKey = useMemo(
    () =>
      orchestrators
        .map(
          (item) =>
            `${buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity)}:${item.taskId}`,
        )
        .sort()
        .join("|"),
    [orchestrators],
  );

  useEffect(() => {
    if (!enabled || orchestrators.length === 0) {
      setPlansByParentId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const groups = new Map<
        string,
        { workspacePath: string; workspaceIdentity?: string; ids: string[] }
      >();
      for (const item of orchestrators) {
        const key = buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity);
        const group = groups.get(key);
        if (group) group.ids.push(item.taskId);
        else groups.set(key, { ...item, ids: [item.taskId] });
      }
      const merged: Record<string, ZCodeOrchestrationPlansMap> = {};
      try {
        for (const group of groups.values()) {
          const taskService = resolvePlanServices(group.workspacePath, group.workspaceIdentity);
          if (!taskService) continue;
          const map = await taskService.getOrchestrationPlansMap({
            orchestrationTaskIds: group.ids,
            workspacePath: group.workspacePath,
            ...(group.workspaceIdentity ? { workspaceIdentity: group.workspaceIdentity } : {}),
          });
          Object.assign(merged, map);
        }
        if (!cancelled) setPlansByParentId(merged);
      } catch {
        // 计划拉取失败不阻断列表渲染；面板退化为不显示，刷新后重试。
        if (!cancelled) setPlansByParentId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, orchestratorsKey, planVersion, refreshKey, resolvePlanServices]);

  const runMutation = useCallback(
    async (
      params: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
      action: (taskService: OrchestrationPlanTaskService) => Promise<ZCodeOrchestrationPlansMap>,
    ) => {
      const taskService = resolvePlanServices(params.workspacePath, params.workspaceIdentity);
      if (!taskService) return;
      const map = await action(taskService);
      setPlansByParentId((current) => ({
        ...(current ?? {}),
        [params.orchestrationTaskId]: map,
      }));
      bumpOrchestrationPlanVersion();
    },
    [resolvePlanServices],
  );

  const setPlanMode = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      enabled: boolean;
    }) => runMutation(params, (taskService) => taskService.setOrchestrationPlanMode(params)),
    [runMutation],
  );

  const selectPlan = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      planId: string | null;
    }) => runMutation(params, (taskService) => taskService.selectOrchestrationPlan(params)),
    [runMutation],
  );

  const confirmPlan = useCallback(
    (params: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string }) =>
      runMutation(params, (taskService) => taskService.confirmOrchestrationPlan(params)),
    [runMutation],
  );

  const proposePlanEdit = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      title?: string;
      nodes: Array<{
        nodeId: string;
        name: string;
        goal: string;
        dependsOn: string[];
        needsUpstreamResult: boolean;
      }>;
    }) => runMutation(params, (taskService) => taskService.proposeOrchestrationPlanEdit(params)),
    [runMutation],
  );

  const createPlan = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      title: string;
    }) => runMutation(params, (taskService) => taskService.createOrchestrationPlan(params)),
    [runMutation],
  );

  const renamePlan = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      planId: string;
      title: string;
    }) => runMutation(params, (taskService) => taskService.renameOrchestrationPlan(params)),
    [runMutation],
  );

  const deletePlan = useCallback(
    (params: {
      orchestrationTaskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      planId: string;
    }) => runMutation(params, (taskService) => taskService.deleteOrchestrationPlan(params)),
    [runMutation],
  );

  return {
    plansByParentId,
    setPlanMode,
    selectPlan,
    confirmPlan,
    proposePlanEdit,
    createPlan,
    renamePlan,
    deletePlan,
  };
}
