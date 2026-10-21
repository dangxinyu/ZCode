// 编排只读查询（spec: packages/services/specs/orchestration-tasks.md）：
// ListOrchestrationChildren 与 ListWorkspaceTasks 的数据装配。从服务拆出，
// 服务文件聚焦关系写入（spawn/link/unlink/下发）与接口装配。

import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import type { OrchestrationChildSummary } from "./orchestrationTaskService.js";
import {
  readLatestAssistantReplyExcerpt,
  WORKSPACE_TASK_EXCERPT_MAX_CHARS,
} from "./orchestrationExcerpt.js";

/**
 * 摘要取值的任务数窗口：workspace 可能有几十个任务，逐个读会话开销无界；
 * listTaskMetas 已按 updated_at DESC 排序，只给最近活跃的候选补摘要。
 */
const WORKSPACE_TASK_EXCERPT_WINDOW = 20;

function toTaskStatus(status: ZCodeTaskMeta["status"]): "running" | "completed" | "error" | null {
  if (status === "completed" || status === "error") return status;
  return status === "running" ? "running" : null;
}

/** ListOrchestrationChildren 的数据面：按在册 links 逐个补 meta。 */
export async function listOrchestrationChildrenSummaries(
  taskIndexRepo: TaskIndexRepo,
  params: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
): Promise<{ children: OrchestrationChildSummary[] }> {
  const links = await taskIndexRepo.listOrchestrationChildren({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    taskId: params.orchestrationTaskId,
  });
  const children: OrchestrationChildSummary[] = [];
  for (const link of links) {
    const meta = await taskIndexRepo
      .getTaskMeta({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        taskId: link.childTaskId,
      })
      .catch(() => null);
    if (!meta) continue;
    children.push({
      taskId: meta.taskId,
      title: meta.title,
      kind: link.kind,
      status: toTaskStatus(meta.status),
      updatedAt: meta.updatedAt,
    });
  }
  return { children };
}

/** ListWorkspaceTasks 的数据面：归档排除 + 候选摘要窗口（见各注释）。 */
export async function listOrchestrationWorkspaceTasks(
  taskIndexRepo: TaskIndexRepo,
  agentService: Pick<IZCodeAgentService, "readSessionMessages">,
  params: { workspacePath: string; workspaceIdentity?: string },
): Promise<{
  tasks: Array<{
    taskId: string;
    title: string;
    status: "running" | "completed" | "error" | null;
    orchestrationRole: "orchestrator" | "child" | null;
    latestReply: string | null;
    updatedAt: number;
  }>;
}> {
  // 归档任务不参与统筹（硬性规定），link 候选分析直接不给模型看归档条目。
  const metas = await taskIndexRepo.listTaskMetas({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    excludeArchived: true,
  });
  // 候选摘要窗口：只给最近活跃的前 N 个非 orchestrator 任务补"最近回复"，
  // 让 link 候选分析从"看标题猜"升级为"看标题+看它最近在做什么"；
  // orchestrator 不能被 link，读它没有意义。冷会话/读失败单点降级为 null。
  const excerptTargets = new Set(
    metas
      .filter((meta) => meta.orchestrationRole !== "orchestrator")
      .slice(0, WORKSPACE_TASK_EXCERPT_WINDOW)
      .map((meta) => meta.taskId),
  );
  const excerpts = new Map<string, string | null>();
  if (excerptTargets.size > 0) {
    const scope = {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    };
    await Promise.all(
      [...excerptTargets].map(async (taskId) => {
        excerpts.set(
          taskId,
          await readLatestAssistantReplyExcerpt(
            agentService,
            { ...scope, taskId },
            WORKSPACE_TASK_EXCERPT_MAX_CHARS,
          ),
        );
      }),
    );
  }
  return {
    tasks: metas.map((meta) => ({
      taskId: meta.taskId,
      title: meta.title,
      status: toTaskStatus(meta.status),
      orchestrationRole: meta.orchestrationRole ?? null,
      latestReply: excerpts.get(meta.taskId) ?? null,
      updatedAt: meta.updatedAt,
    })),
  };
}
