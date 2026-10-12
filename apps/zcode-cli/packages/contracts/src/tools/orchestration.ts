// ============================================================
// Orchestration tools - 编排任务会话专属工具面
// spec: packages/services/specs/orchestration-tasks.md
// 仅 orchestration_parent 会话注册；orchestration_child 会话级结构性禁用
// （runtime/helpers/tool-allowlist.ts），保证一层 team 不变量。
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const SPAWN_SUB_TASK_TOOL_NAME = "SpawnSubTask";
export const LINK_TASK_TOOL_NAME = "LinkTask";
export const LIST_ORCHESTRATION_CHILDREN_TOOL_NAME = "ListOrchestrationChildren";
export const LIST_WORKSPACE_TASKS_TOOL_NAME = "ListWorkspaceTasks";

export const SpawnSubTaskInputSchema = z
  .object({
    prompt: nonEmptyString.describe(
      "Complete first instruction for the new child task. Self-contained: the child session starts fresh with no conversation history from this orchestration task. Describe the deliverable explicitly; the task title is derived from it automatically.",
    ),
  })
  .strict();
export type SpawnSubTaskInput = z.infer<typeof SpawnSubTaskInputSchema>;
export const SpawnSubTaskInputJsonSchema = toToolJsonSchema(SpawnSubTaskInputSchema);

export const SpawnSubTaskOutputSchema = z
  .object({
    childTaskId: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type SpawnSubTaskOutput = z.infer<typeof SpawnSubTaskOutputSchema>;
export const SpawnSubTaskOutputJsonSchema = toToolJsonSchema(SpawnSubTaskOutputSchema);

export const LinkTaskInputSchema = z
  .object({
    taskId: nonEmptyString.describe(
      "taskId of an existing normal task in the same workspace to adopt into this orchestration. Use ListWorkspaceTasks first to find candidates; orchestrator tasks and tasks already owned by another orchestration are rejected.",
    ),
  })
  .strict();
export type LinkTaskInput = z.infer<typeof LinkTaskInputSchema>;
export const LinkTaskInputJsonSchema = toToolJsonSchema(LinkTaskInputSchema);

export const LinkTaskOutputSchema = z
  .object({
    childTaskId: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type LinkTaskOutput = z.infer<typeof LinkTaskOutputSchema>;
export const LinkTaskOutputJsonSchema = toToolJsonSchema(LinkTaskOutputSchema);

const orchestrationChildSummarySchema = z
  .object({
    taskId: nonEmptyString,
    title: z.string(),
    kind: z.enum(["derived", "linked"]),
    status: z.enum(["running", "completed", "error"]).nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type OrchestrationChildSummary = z.infer<typeof orchestrationChildSummarySchema>;

export const ListOrchestrationChildrenInputSchema = z.object({}).strict();
export type ListOrchestrationChildrenInput = z.infer<typeof ListOrchestrationChildrenInputSchema>;
export const ListOrchestrationChildrenInputJsonSchema = toToolJsonSchema(
  ListOrchestrationChildrenInputSchema,
);

export const ListOrchestrationChildrenOutputSchema = z
  .object({
    children: z.array(orchestrationChildSummarySchema),
  })
  .strict();
export type ListOrchestrationChildrenOutput = z.infer<typeof ListOrchestrationChildrenOutputSchema>;
export const ListOrchestrationChildrenOutputJsonSchema = toToolJsonSchema(
  ListOrchestrationChildrenOutputSchema,
);

const workspaceTaskSummarySchema = z
  .object({
    taskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["running", "completed", "error"]).nullable(),
    orchestrationRole: z.enum(["orchestrator", "child"]).nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type OrchestrationWorkspaceTaskSummary = z.infer<typeof workspaceTaskSummarySchema>;

export const ListWorkspaceTasksInputSchema = z.object({}).strict();
export type ListWorkspaceTasksInput = z.infer<typeof ListWorkspaceTasksInputSchema>;
export const ListWorkspaceTasksInputJsonSchema = toToolJsonSchema(ListWorkspaceTasksInputSchema);

export const ListWorkspaceTasksOutputSchema = z
  .object({
    tasks: z.array(workspaceTaskSummarySchema),
  })
  .strict();
export type ListWorkspaceTasksOutput = z.infer<typeof ListWorkspaceTasksOutputSchema>;
export const ListWorkspaceTasksOutputJsonSchema = toToolJsonSchema(ListWorkspaceTasksOutputSchema);
