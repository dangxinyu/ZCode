// 任务目录子条目 ↔ 计划节点反查（spec: packages/services/specs/orchestration-plan.md
// 「任务目录子条目直接展示/修改节点状态」用户需求 2026-11-20）。
// 纯内存 join：按节点 childTaskId === 子任务 taskId 在 plansMap.plans 里匹配，
// 零新增服务端查询（侧栏本就拉好 plansByParentId）。多计划残留绑定（解链/修订遗留）
// 时 activePlanId 命中优先、其余计划次之，取第一个命中。
import type { ZCodeOrchestrationPlanNode, ZCodeOrchestrationPlansMap } from "@zcode/shared";

export interface OrchestrationChildPlanNodeRef {
  planId: string;
  node: ZCodeOrchestrationPlanNode;
}

export function resolveChildPlanNode(
  plansMap: ZCodeOrchestrationPlansMap | null | undefined,
  childTaskId: string,
): OrchestrationChildPlanNodeRef | null {
  if (!plansMap || plansMap.plans.length === 0) return null;
  // 先扫 active 计划再扫其余计划：两轮遍历而非扁平排序，避免整表 sort。
  const activePlans = plansMap.activePlanId
    ? plansMap.plans.filter((plan) => plan.planId === plansMap.activePlanId)
    : [];
  const otherPlans = plansMap.activePlanId
    ? plansMap.plans.filter((plan) => plan.planId !== plansMap.activePlanId)
    : plansMap.plans;
  for (const plan of [...activePlans, ...otherPlans]) {
    const node = plan.nodes.find((candidate) => candidate.childTaskId === childTaskId);
    if (node) return { planId: plan.planId, node };
  }
  return null;
}
