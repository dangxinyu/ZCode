// 计划节点自动派发引擎（spec: packages/services/specs/orchestration-plan.md 节点自动执行，
// 用户需求 2026-11-03）。dispatchPlanNodeOnce 从 zcodeTaskServiceAdapter 迁出共用：
// 手动执行、计划级继续执行、自动派发三条路走同一条派发实现（提示词 = 目标 + 上游摘要，
// 有绑定下发 / 无绑定派生），计划门与失败回滚语义完全一致。
import type {
  ZCodeOrchestrationPlan,
  ZCodeOrchestrationPlanNode,
} from "@zcode/shared";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import type { IOrchestrationTaskService } from "./orchestrationTaskService.js";
import type { IOrchestrationPlanService } from "./orchestrationPlanService.js";
import { readLatestAssistantReplyExcerpt } from "./orchestrationExcerpt.js";

/** 派发指令附带的上游交付摘要上限（每个上游一段；提示词不是搬运全文）。 */
const PLAN_NODE_UPSTREAM_EXCERPT_MAX_CHARS = 600;

export interface PlanNodeDispatchDeps {
  /** 摘要读取只用到 readSessionMessages（窄口径：任务服务工厂的 Pick 也满足）。 */
  zcodeAgentService: Pick<IZCodeAgentService, "readSessionMessages">;
  /** 只需要派发两条入口；任务服务工厂自引用也满足（Pick 结构类型）。 */
  orchestrationService: Pick<IOrchestrationTaskService, "spawnSubTask" | "sendChildTaskPrompt">;
  resolveOrchestrationPlanService?: () => IOrchestrationPlanService | undefined;
}

/** 单节点派发（手动执行/计划级继续执行/自动派发共用）：提示词 = 目标（+上游交付摘要），
 * 有绑定子任务下发（planNodeId 置 dispatched），无则派生新子任务。 */
export async function dispatchPlanNodeOnce(
  deps: PlanNodeDispatchDeps,
  scope: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
  plan: ZCodeOrchestrationPlan,
  node: ZCodeOrchestrationPlanNode,
): Promise<void> {
  let prompt = node.goal.trim() || node.name;
  if (node.needsUpstreamResult) {
    const byId = new Map(plan.nodes.map((candidate) => [candidate.nodeId, candidate]));
    const excerpts: string[] = [];
    for (const dep of node.dependsOn) {
      const upstream = byId.get(dep);
      if (!upstream || upstream.isStart || !upstream.childTaskId) continue;
      const excerpt = await readLatestAssistantReplyExcerpt(
        deps.zcodeAgentService,
        {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          taskId: upstream.childTaskId,
        },
        PLAN_NODE_UPSTREAM_EXCERPT_MAX_CHARS,
      );
      if (excerpt) excerpts.push(`【上游「${upstream.name}」交付摘要】\n${excerpt}`);
    }
    if (excerpts.length > 0) prompt += `\n\n${excerpts.join("\n\n")}`;
  }
  if (node.childTaskId) {
    await deps.orchestrationService.sendChildTaskPrompt({
      ...scope,
      childTaskId: node.childTaskId,
      prompt,
      planNodeId: node.nodeId,
      // 两条来路都是"人类显式动作（UI 执行按钮）/已过闸的自动引擎"，绕过断流闸门；
      // agent 自主派发不走本函数，闸门在任务服务里拦。
      bypassAutoGate: true,
    });
  } else {
    await deps.orchestrationService.spawnSubTask({
      ...scope,
      name: node.name.trim().slice(0, 60) || "子任务",
      prompt,
      planNodeId: node.nodeId,
      bypassAutoGate: true,
    });
  }
}

/**
 * 自动派发就绪扫描（幂等，可安全重复触发）：对 active 计划找满足以下全部条件的节点并派发——
 * ① status ∈ pending/stale；② 依赖全部 terminal（start 视为满足）；③ 所有非起始直接上游的
 * autoExecute=true（手动闸门级联断流：任一上游关自动，本节点即使就绪也不动，其下游随之
 * 停住——"不自动的场景断得掉"；全开则波次推进不断流）；④ **候选自身的 autoExecute=true**
 * （用户需求 2026-11-05"没开自动的下游不擅自派发"：没开自动的节点是人工停留点，引擎不拉起）。
 * 失败即停不重试：单节点派发失败记录后继续兄弟节点（各自独立），失败节点按既有规则回滚、
 * 其下游因依赖未满足自然停住。草稿计划不扫描（计划门语义）；非计划模式/无 active 计划直接
 * 返回（用户需求 2026-11-05 明确范围）。
 * triggerNodeIds（用户需求 2026-11-04"无关节点被连带执行"实测修复）：节点终态/手动完成
 * 触发的扫描只考虑**触发节点的直接下游**——上游完成只释放自己的下游，不是"谁就绪谁跑"。
 * 直连 start 的节点没有可完成的上游，只由确认计划（全图第一波）/继续执行/手动执行拉起。
 * 不传 = 全图扫描（仅确认计划这类显式"跑整个计划"的动作使用）。
 * 返回派发结果供调用方记日志。
 */
export async function autoDispatchReadyNodes(
  deps: PlanNodeDispatchDeps,
  scope: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
  options?: { triggerNodeIds?: readonly string[] },
): Promise<{ dispatched: string[]; failed: Array<{ nodeId: string; error: string }> }> {
  const result: { dispatched: string[]; failed: Array<{ nodeId: string; error: string }> } = {
    dispatched: [],
    failed: [],
  };
  const planService = deps.resolveOrchestrationPlanService?.();
  if (!planService) return result;
  const map = await planService.getPlansMap({
    orchestrationTaskIds: [scope.orchestrationTaskId],
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  });
  const plansMap = map[scope.orchestrationTaskId];
  // 没开计划模式/没有 active 计划 → 无事可做（读时推导 status：draft 不可执行）。
  if (!plansMap?.planMode || !plansMap.activePlanId) return result;
  const plan = plansMap.plans.find((candidate) => candidate.planId === plansMap.activePlanId);
  if (!plan || plan.status === "draft") return result;
  const startNodeId = plan.nodes.find((candidate) => candidate.isStart)?.nodeId ?? "start";
  const statusById = new Map(plan.nodes.map((candidate) => [candidate.nodeId, candidate.status]));
  const autoById = new Map(
    plan.nodes.map((candidate) => [candidate.nodeId, candidate.autoExecute === true]),
  );
  // 极性（用户需求 2026-11-04 翻转；2026-11-05 收敛）：X.autoExecute=true 表示 X 完成后
  // 自动执行 X 的下游。节点 Y 可自动派发 = 待执行 + **Y 自身开关已开（2026-11-05 新增，
  // 没开自动的下游是人工停留点，主任务不得擅自调动）** + 依赖全部 terminal + 所有非起始
  // 直接上游的开关已开。
  // 触发范围（bug 修复 2026-11-04 实测）：限定了 triggerNodeIds 时候选必须是触发节点的
  // 直接下游（dependsOn 有交集）——节点1 完成不该点亮毫无关系的节点2（其上游只有
  // start、被上面 every 判为永远满足，全图扫描会把它误当就绪）。
  const triggerSet =
    options?.triggerNodeIds && options.triggerNodeIds.length > 0
      ? new Set(options.triggerNodeIds)
      : null;
  const ready = plan.nodes.filter(
    (candidate) =>
      !candidate.isStart &&
      (candidate.status === "pending" || candidate.status === "stale") &&
      // 空目标节点不自动派发（用户需求 2026-11-04）：没写目标 = 没定义要干什么。
      candidate.goal.trim() !== "" &&
      // 候选自身开关必开（用户需求 2026-11-05）：下游没开自动就不被引擎派发，
      // 等用户在画布开开关或点「执行」手动推进。
      autoById.get(candidate.nodeId) === true &&
      (!triggerSet || candidate.dependsOn.some((dep) => triggerSet.has(dep))) &&
      candidate.dependsOn.every(
        (dep) =>
          dep === startNodeId ||
          (statusById.get(dep) === "terminal" && autoById.get(dep) === true),
      ),
  );
  for (const node of ready) {
    try {
      await dispatchPlanNodeOnce(deps, scope, plan, node);
      result.dispatched.push(node.nodeId);
    } catch (error) {
      // 失败即停于该节点（sendChildTaskPrompt 内部已回滚节点状态）：不重试、不牵连兄弟。
      result.failed.push({
        nodeId: node.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** 最小结构日志口径（createServiceLogger 满足）。 */
type AutoDispatchLogger = {
  info: (message: string, context: Record<string, unknown>) => void;
};

/**
 * 构造 relay 用的自动派发触发器（用户需求 2026-11-03）：orchestrationService 惰性取——
 * 任务服务工厂在自身构造完成后才注入（工厂自引用解环），扫描结果记 info 日志。
 * triggerNodeIds 由调用方（relay 终态回写）传入：本轮真实迁移的节点，扫描只看它们的下游。
 */
export function createAutoDispatchTrigger(
  deps: {
    zcodeAgentService: PlanNodeDispatchDeps["zcodeAgentService"];
    resolveOrchestrationPlanService?: PlanNodeDispatchDeps["resolveOrchestrationPlanService"];
    logger: AutoDispatchLogger;
  },
  getOrchestrationService: () => PlanNodeDispatchDeps["orchestrationService"],
): (
  scope: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
  triggerNodeIds?: readonly string[],
) => Promise<void> {
  return async (scope, triggerNodeIds) => {
    const outcome = await autoDispatchReadyNodes(
      {
        zcodeAgentService: deps.zcodeAgentService,
        orchestrationService: getOrchestrationService(),
        resolveOrchestrationPlanService: deps.resolveOrchestrationPlanService,
      },
      scope,
      triggerNodeIds ? { triggerNodeIds } : undefined,
    );
    if (outcome.dispatched.length > 0 || outcome.failed.length > 0) {
      deps.logger.info("Orchestration plan auto-dispatch sweep", {
        dispatchedNodeIds: outcome.dispatched,
        event: "orchestration.plan.auto_dispatch_sweep",
        failures: outcome.failed,
        orchestrationTaskId: scope.orchestrationTaskId,
      });
    }
  };
}
