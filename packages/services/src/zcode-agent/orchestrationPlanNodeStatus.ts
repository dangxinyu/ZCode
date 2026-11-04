// 计划节点状态的纯变换（spec: packages/services/specs/orchestration-plan.md）。
// 从 orchestrationPlanModel 拆出：终态回写与 stale 批量标记只依赖节点数组，独立于计划行读写。
import type { OrchestrationPlanNode } from "./orchestrationPlanModel.js";

/** 节点终态回写：按 childTaskId 匹配的节点置终态（succeeded → terminal 绿；
 * failed → failed 红，用户需求 2026-11-04：失败与成功对等成状态）。
 * 一个子任务允许挂多个节点：完成/失败时把挂它的**全部**未达终态的节点一并置同终态；
 * 全部已是该终态（或没有任何节点挂它）才视为无变化。 */
export function markNodeTerminalByChild(
  nodes: OrchestrationPlanNode[],
  childTaskId: string,
  outcome: "succeeded" | "failed",
): OrchestrationPlanNode[] | null {
  const finalStatus = outcome === "failed" ? ("failed" as const) : ("terminal" as const);
  const matched = nodes.filter((candidate) => candidate.childTaskId === childTaskId);
  if (matched.length === 0) return null;
  if (matched.every((candidate) => candidate.status === finalStatus)) return null;
  return nodes.map((candidate) =>
    candidate.childTaskId === childTaskId && candidate.status !== finalStatus
      ? { ...candidate, status: finalStatus }
      : candidate,
  );
}

/** 微调传播批量状态变换：stale=true 只对 terminal 节点生效；false 把 stale 收敛回 terminal。 */
export function applyStaleMarks(
  nodes: OrchestrationPlanNode[],
  nodeIds: string[],
  stale: boolean,
): { nodes: OrchestrationPlanNode[]; updated: number } {
  const ids = new Set(nodeIds);
  let updated = 0;
  const next = nodes.map((candidate) => {
    if (!ids.has(candidate.nodeId)) return candidate;
    updated += 1;
    if (stale) {
      return candidate.status === "terminal"
        ? { ...candidate, status: "stale" as const }
        : candidate;
    }
    return candidate.status === "stale" ? { ...candidate, status: "terminal" as const } : candidate;
  });
  return { nodes: next, updated };
}
