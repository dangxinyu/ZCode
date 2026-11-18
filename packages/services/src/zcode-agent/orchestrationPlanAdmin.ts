// 编排计划的 UI 管理操作（创建空计划/重命名/删除，spec: orchestration-plan.md）。
// 从 orchestrationPlanService 拆出的行级操作，仅操作 orchestration_plans 行。
import { randomUUID } from "node:crypto";
import type { ZCodeOrchestrationPlansMapProtocol } from "@zcode/shared";
import type { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import {
  rowToPlan,
  START_NODE_NAME,
  type OrchestrationPlan,
  type WorkspaceScope,
} from "./orchestrationPlanModel.js";

type LoggerLike = ReturnType<typeof createServiceLogger>;

async function readPlansMap(
  taskIndexRepo: TaskIndexRepo,
  params: WorkspaceScope & { orchestrationTaskId: string },
): Promise<ZCodeOrchestrationPlansMapProtocol> {
  const [planMode, rows] = await Promise.all([
    taskIndexRepo.isOrchestrationPlanModeOn(params),
    taskIndexRepo.listOrchestrationPlanRows(params),
  ]);
  const active = rows.find((row) => row.isActive);
  return {
    planMode,
    activePlanId: active?.planId ?? null,
    plans: rows.map(rowToPlan),
  };
}

async function writeRow(
  taskIndexRepo: TaskIndexRepo,
  params: WorkspaceScope & { orchestrationTaskId: string },
  row: {
    planId: string;
    title: string;
    status: string;
    planJson: string;
    isActive: boolean;
    createdAt: number;
  },
): Promise<void> {
  await taskIndexRepo.upsertOrchestrationPlanRow({
    ...params,
    planId: row.planId,
    title: row.title,
    planMode: true,
    status: row.status,
    planJson: row.planJson,
    isActive: row.isActive,
    createdAt: row.createdAt,
  });
}

export async function createEmptyPlanRow(
  deps: { taskIndexRepo: TaskIndexRepo; logger: LoggerLike },
  params: WorkspaceScope & { orchestrationTaskId: string; title: string },
): Promise<OrchestrationPlan> {
  if (!(await deps.taskIndexRepo.isOrchestrationPlanModeOn(params))) {
    throw new Error("Plan mode is disabled for this orchestration task.");
  }
  const planId = `plan-${randomUUID().slice(0, 8)}`;
  const title = params.title.trim() || "新计划";
  const now = Date.now();
  // 每个计划默认带一个起始节点（用户需求 2026-10-29：结构标记，不可删除/派发）。
  const nodes = [
    {
      nodeId: "start",
      name: START_NODE_NAME,
      goal: "",
      dependsOn: [] as string[],
      needsUpstreamResult: false,
      isStart: true,
      status: "pending" as const,
      childTaskId: null,
      layout: { x: 80, y: 80 },
    },
  ];
  await writeRow(deps.taskIndexRepo, params, {
    planId,
    title,
    status: "draft",
    planJson: JSON.stringify({ version: 1, nodes, origin: "manual" }),
    isActive: true,
    createdAt: now,
  });
  deps.logger.info("Orchestration plan created (empty)", {
    event: "orchestration.plan.created_empty",
    orchestrationTaskId: params.orchestrationTaskId,
    planId,
  });
  return { planId, title, status: "draft", version: 1, nodes, createdAt: now, updatedAt: now };
}

export async function renamePlanRow(
  deps: { taskIndexRepo: TaskIndexRepo },
  params: WorkspaceScope & { orchestrationTaskId: string; planId: string; title: string },
): Promise<ZCodeOrchestrationPlansMapProtocol> {
  const rows = await deps.taskIndexRepo.listOrchestrationPlanRows(params);
  const row = rows.find((candidate) => candidate.planId === params.planId);
  if (!row) throw new Error(`Plan not found: ${params.planId}`);
  await writeRow(deps.taskIndexRepo, params, {
    planId: row.planId,
    title: params.title.trim() || row.title,
    status: row.status,
    planJson: row.planJson,
    isActive: row.isActive,
    createdAt: row.createdAt,
  });
  return readPlansMap(deps.taskIndexRepo, params);
}

export async function deletePlanRow(
  deps: { taskIndexRepo: TaskIndexRepo; logger: LoggerLike },
  params: WorkspaceScope & { orchestrationTaskId: string; planId: string },
): Promise<ZCodeOrchestrationPlansMapProtocol> {
  await deps.taskIndexRepo.deleteOrchestrationPlanRow(params);
  deps.logger.info("Orchestration plan deleted", {
    event: "orchestration.plan.deleted",
    orchestrationTaskId: params.orchestrationTaskId,
    planId: params.planId,
  });
  return readPlansMap(deps.taskIndexRepo, params);
}
