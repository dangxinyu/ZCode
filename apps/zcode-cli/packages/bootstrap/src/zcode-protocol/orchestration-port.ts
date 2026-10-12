import {
  type LinkTaskOutput,
  type ListOrchestrationChildrenOutput,
  type ListWorkspaceTasksOutput,
  type OrchestrationPort,
  type SpawnSubTaskOutput,
} from "@zcode/contracts";
import {
  zcodeOrchestrationLinkParamsSchema,
  zcodeOrchestrationLinkResultSchema,
  zcodeOrchestrationListChildrenParamsSchema,
  zcodeOrchestrationListChildrenResultSchema,
  zcodeOrchestrationListWorkspaceTasksParamsSchema,
  zcodeOrchestrationListWorkspaceTasksResultSchema,
  zcodeOrchestrationSpawnParamsSchema,
  zcodeOrchestrationSpawnResultSchema,
  zcodeProtocolMethods,
  type ZCodeOrchestrationChildSummaryProtocol,
  type ZCodeOrchestrationWorkspaceTaskSummaryProtocol,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 编排任务端口（spec: packages/services/specs/orchestration-tasks.md）。
 * CLI 侧工具只透传；任务创建、关系落库、盖标记全部由 host 域经
 * orchestration/* 反向请求执行。端口对 taskType 不做判断——core 的
 * includeOrchestration 门（端口在场 + orchestration_parent）才是唯一曝光面。
 */
export function createProtocolOrchestrationPort(
  context: ZCodeProtocolAgentServerContext,
): OrchestrationPort {
  return {
    async spawnSubTask(input, taskContext): Promise<SpawnSubTaskOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.orchestrationSpawnSubTask,
        zcodeOrchestrationSpawnParamsSchema.parse({
          sessionId: taskContext.sessionId,
          name: input.name,
          prompt: input.prompt,
        }),
        zcodeOrchestrationSpawnResultSchema,
      );
      // 工具结果只回名称：childTaskId 是内部标识，模型侧不接触就不会念给用户。
      return {
        childTaskName: result.childTaskName,
        message: `Spawned child task "${result.childTaskName}". Its terminal outcome will be reported back to this orchestration task automatically.`,
      };
    },
    async linkTask(input, taskContext): Promise<LinkTaskOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.orchestrationLinkTask,
        zcodeOrchestrationLinkParamsSchema.parse({
          sessionId: taskContext.sessionId,
          childTaskId: input.taskId,
        }),
        zcodeOrchestrationLinkResultSchema,
      );
      return {
        childTaskName: result.childTaskName,
        alreadyLinked: result.alreadyLinked,
        message: result.alreadyLinked
          ? `Task "${result.childTaskName}" was already linked to this orchestration.`
          : `Linked existing task "${result.childTaskName}" into this orchestration. Linking never sends instructions to it; terminal outcomes will be reported here.`,
      };
    },
    async listChildren(_input, taskContext): Promise<ListOrchestrationChildrenOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.orchestrationListChildren,
        zcodeOrchestrationListChildrenParamsSchema.parse({
          sessionId: taskContext.sessionId,
        }),
        zcodeOrchestrationListChildrenResultSchema,
      );
      return {
        children: result.children.map((child: ZCodeOrchestrationChildSummaryProtocol) => ({
          taskId: child.taskId,
          title: child.title,
          kind: child.kind,
          status: child.status,
          updatedAt: child.updatedAt,
        })),
      };
    },
    async listWorkspaceTasks(_input, taskContext): Promise<ListWorkspaceTasksOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.orchestrationListWorkspaceTasks,
        zcodeOrchestrationListWorkspaceTasksParamsSchema.parse({
          sessionId: taskContext.sessionId,
        }),
        zcodeOrchestrationListWorkspaceTasksResultSchema,
      );
      return {
        tasks: result.tasks.map(
          (task: ZCodeOrchestrationWorkspaceTaskSummaryProtocol) => ({
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            orchestrationRole: task.orchestrationRole,
            latestReply: task.latestReply,
            updatedAt: task.updatedAt,
          }),
        ),
      };
    },
  };
}
