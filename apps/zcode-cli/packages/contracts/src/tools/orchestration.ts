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
export const SEND_CHILD_TASK_PROMPT_TOOL_NAME = "SendChildTaskPrompt";
export const LIST_ORCHESTRATION_CHILDREN_TOOL_NAME = "ListOrchestrationChildren";
export const LIST_WORKSPACE_TASKS_TOOL_NAME = "ListWorkspaceTasks";

export const SpawnSubTaskInputSchema = z
  .object({
    name: nonEmptyString.describe(
      'Short distinctive name for the child task, derived from its mission (2-20 chars, e.g. "登录页回归验证"). It becomes the task title shown in the task list and in terminal notifications.',
    ),
    prompt: nonEmptyString.describe(
      "Complete first instruction for the new child task. Self-contained: the child session starts fresh with no conversation history from this orchestration task. Describe the deliverable explicitly; the task title is derived from it automatically.",
    ),
  })
  .strict();
export type SpawnSubTaskInput = z.infer<typeof SpawnSubTaskInputSchema>;
export const SpawnSubTaskInputJsonSchema = toToolJsonSchema(SpawnSubTaskInputSchema);

export const SpawnSubTaskOutputSchema = z
  .object({
    childTaskName: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type SpawnSubTaskOutput = z.infer<typeof SpawnSubTaskOutputSchema>;
export const SpawnSubTaskOutputJsonSchema = toToolJsonSchema(SpawnSubTaskOutputSchema);

export const LinkTaskInputSchema = z
  .object({
    taskId: nonEmptyString.describe(
      "taskId of an existing active (non-archived) normal task in the same workspace to adopt into this orchestration. Use ListWorkspaceTasks first to find candidates; orchestrator tasks, tasks already owned by another orchestration, and archived tasks are rejected.",
    ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Only set true when the user explicitly asks to link this exact task. Tasks the user previously unlinked are blocked by the host; force overrides that block and must never be used for autonomous relinking.",
      ),
  })
  .strict();
export type LinkTaskInput = z.infer<typeof LinkTaskInputSchema>;
export const LinkTaskInputJsonSchema = toToolJsonSchema(LinkTaskInputSchema);

export const LinkTaskOutputSchema = z
  .object({
    childTaskName: nonEmptyString,
    alreadyLinked: z.boolean(),
    message: nonEmptyString,
  })
  .strict();
export type LinkTaskOutput = z.infer<typeof LinkTaskOutputSchema>;
export const LinkTaskOutputJsonSchema = toToolJsonSchema(LinkTaskOutputSchema);

export const SendChildTaskPromptInputSchema = z
  .object({
    taskId: nonEmptyString.describe(
      "taskId of a child task currently tracked by this orchestration (derived or linked; use ListOrchestrationChildren to check). Unlinked or non-child tasks are rejected.",
    ),
    prompt: nonEmptyString.describe(
      "The instruction to send to this child task. Self-contained: reference deliverables and file paths explicitly; the child has no access to this conversation.",
    ),
  })
  .strict();
export type SendChildTaskPromptInput = z.infer<typeof SendChildTaskPromptInputSchema>;
export const SendChildTaskPromptInputJsonSchema = toToolJsonSchema(SendChildTaskPromptInputSchema);

export const SendChildTaskPromptOutputSchema = z
  .object({
    childTaskName: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type SendChildTaskPromptOutput = z.infer<typeof SendChildTaskPromptOutputSchema>;
export const SendChildTaskPromptOutputJsonSchema = toToolJsonSchema(
  SendChildTaskPromptOutputSchema,
);

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
    /** 最近一条 assistant 回复的有界摘要（活跃会话可取，冷会话为 null）：判断任务实际在做什么的关键信号。 */
    latestReply: z.string().nullable(),
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
    /** 给模型的行动提示：结果消费点比工具描述更靠近决策，未关联的匹配任务在这里再推一次。 */
    hint: z.string().optional(),
  })
  .strict();
export type ListWorkspaceTasksOutput = z.infer<typeof ListWorkspaceTasksOutputSchema>;
export const ListWorkspaceTasksOutputJsonSchema = toToolJsonSchema(ListWorkspaceTasksOutputSchema);
