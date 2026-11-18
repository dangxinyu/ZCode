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
export const PROPOSE_ORCHESTRATION_PLAN_TOOL_NAME = "ProposeOrchestrationPlan";
export const MARK_PLAN_NODES_STALE_TOOL_NAME = "MarkPlanNodesStale";

export const SpawnSubTaskInputSchema = z
  .object({
    name: nonEmptyString.describe(
      'Short distinctive name for the child task, derived from its mission (2-20 chars, e.g. "登录页回归验证"). It becomes the task title shown in the task list and in terminal notifications.',
    ),
    prompt: nonEmptyString.describe(
      "Complete first instruction for the new child task. Self-contained: the child session starts fresh with no conversation history from this orchestration task. Describe the deliverable explicitly; the task title is derived from it automatically.",
    ),
    planNodeId: nonEmptyString.optional().describe(
      "Node id from the confirmed plan. Pass it when spawning plan nodes so progress is tracked; omit for ad-hoc spawns.",
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
    planNodeId: nonEmptyString.optional().describe(
      "Node id (［id: …］ in the confirmation message) of the plan node this dispatch executes. Pass it when executing plan nodes: the node is bound to this child and marked dispatched, so its outcome updates the plan. Omit for ad-hoc follow-up instructions.",
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
    planMode: z.boolean().optional().describe(
      "True when plan mode is ON: submit a plan via ProposeOrchestrationPlan before any SpawnSubTask/LinkTask; spawning stays blocked until the user confirms.",
    ),
    pendingNewPlan: z.boolean().optional().describe(
      "True when the user armed a 'start a NEW plan' request from the plan dropdown (no message was sent). Whether to actually create one is decided by the conversation: if the user's current request warrants a brand-new plan, call ProposeOrchestrationPlan with createNew=true; otherwise continue normally. The flag clears when a new plan is created or the user cancels it.",
    ),
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
    planMode: z.boolean().optional().describe(
      "True when plan mode is ON for this orchestration: submit a plan via ProposeOrchestrationPlan before any SpawnSubTask/LinkTask; spawning stays blocked until the user confirms the plan.",
    ),
    pendingNewPlan: z.boolean().optional().describe(
      "True when the user armed a 'start a NEW plan' request from the plan dropdown (no message was sent). Whether to actually create one is decided by the conversation: if the user's current request warrants a brand-new plan, call ProposeOrchestrationPlan with createNew=true; otherwise continue normally.",
    ),
  })
  .strict();
export type ListWorkspaceTasksOutput = z.infer<typeof ListWorkspaceTasksOutputSchema>;
export const ListWorkspaceTasksOutputJsonSchema = toToolJsonSchema(ListWorkspaceTasksOutputSchema);

// ---- 编排计划（spec: packages/services/specs/orchestration-plan.md）----
// 可选计划模式：默认关闭（host 侧拒绝提案，行为与现状一致）；开启后首轮派生前
// 必须提案并等待用户在界面确认（【编排计划·确认】消息）。
export const ProposeOrchestrationPlanInputSchema = z
  .object({
    title: nonEmptyString.optional().describe(
      "Title for a NEW plan (host names it after the first node when omitted). Ignored when revising the active plan. Plan titles are immutable after creation: never invent title variants (e.g. appending suffixes like（重新发起）/ \"(redo)\") — revise the existing plan instead.",
    ),
    createNew: z.boolean().optional().describe(
      "Set true to create a NEW plan for this proposal instead of revising the currently selected (active) plan. Use it when the user asks to start a fresh/separate plan.",
    ),
    nodes: z
      .array(
        z
          .object({
            nodeId: nonEmptyString.describe(
              'Stable short id for this node (e.g. "research", "impl-api"); referenced by dependsOn and passed as planNodeId when spawning.',
            ),
            name: nonEmptyString.describe(
              "Short distinctive child task name (2-20 chars); becomes the task title.",
            ),
            goal: nonEmptyString.describe(
              "What this node must deliver; used as the core of its first instruction.",
            ),
            dependsOn: z
              .array(nonEmptyString)
              .optional()
              .describe(
                "nodeIds that must reach terminal state before this node is dispatched (DAG, acyclic).",
              ),
            needsUpstreamResult: z
              .boolean()
              .optional()
              .describe(
                "true (default): dispatch injects upstream final delivery summaries into the instruction (result dependency); false: ordering only.",
              ),
            isStart: z
              .boolean()
              .optional()
              .describe(
                "Mark exactly one node as the START marker (goal/dependsOn stay empty; it is never dispatched). Omit and the host prepends one automatically; every other node must connect to it directly or indirectly.",
              ),
          })
          .strict(),
      )
      .min(1)
      .describe("Complete plan: every intended child task as one node."),
  })
  .strict();
export type ProposeOrchestrationPlanInput = z.infer<typeof ProposeOrchestrationPlanInputSchema>;
export const ProposeOrchestrationPlanInputJsonSchema = toToolJsonSchema(
  ProposeOrchestrationPlanInputSchema,
);

export const ProposeOrchestrationPlanOutputSchema = z
  .object({
    version: z.number().int().nonnegative(),
    nodeCount: z.number().int().positive(),
    message: nonEmptyString,
  })
  .strict();
export type ProposeOrchestrationPlanOutput = z.infer<typeof ProposeOrchestrationPlanOutputSchema>;
export const ProposeOrchestrationPlanOutputJsonSchema = toToolJsonSchema(
  ProposeOrchestrationPlanOutputSchema,
);

// ---- 微调变更传播（spec: packages/services/specs/orchestration-plan.md）----
export const MarkPlanNodesStaleInputSchema = z
  .object({
    nodeIds: z
      .array(nonEmptyString)
      .min(1)
      .describe("Node ids in the active plan to update (upstream-changed targets)."),
    stale: z.boolean().describe(
      "true: mark as stale (upstream delivered code changes; downstream must review). false: review finished with no changes needed; node returns to terminal.",
    ),
  })
  .strict();
export type MarkPlanNodesStaleInput = z.infer<typeof MarkPlanNodesStaleInputSchema>;
export const MarkPlanNodesStaleInputJsonSchema = toToolJsonSchema(MarkPlanNodesStaleInputSchema);

export const MarkPlanNodesStaleOutputSchema = z
  .object({
    updated: z.number().int().nonnegative(),
    message: nonEmptyString,
  })
  .strict();
export type MarkPlanNodesStaleOutput = z.infer<typeof MarkPlanNodesStaleOutputSchema>;
export const MarkPlanNodesStaleOutputJsonSchema = toToolJsonSchema(MarkPlanNodesStaleOutputSchema);

// ---- 计划节点 ↔ 子任务绑定（spec: packages/services/specs/orchestration-plan.md）----
// 手动关联的子任务没有 spawn 通道的 planNodeId；计划画布要显示每个节点挂的
// 子任务与执行进度，必须由 agent 把 List 结果里的 childTaskId 显式绑到节点上。
export const BIND_PLAN_NODES_TOOL_NAME = "BindOrchestrationPlanNodes";

export const BindPlanNodesInputSchema = z
  .object({
    bindings: z
      .array(
        z
          .object({
            planNodeId: nonEmptyString.describe("Node id in the active (confirmed) plan."),
            childTaskId: z
              .string()
              .nullable()
              .describe(
                "Linked child taskId (from ListOrchestrationChildren), or null to unbind the node.",
              ),
          })
          .strict(),
      )
      .min(1)
      .describe("Node-child pairs to apply; one child task may bind to exactly one node."),
  })
  .strict();
export type BindPlanNodesInput = z.infer<typeof BindPlanNodesInputSchema>;
export const BindPlanNodesInputJsonSchema = toToolJsonSchema(BindPlanNodesInputSchema);

export const BindPlanNodesOutputSchema = z
  .object({
    updated: z.number().int().nonnegative(),
    message: nonEmptyString,
  })
  .strict();
export type BindPlanNodesOutput = z.infer<typeof BindPlanNodesOutputSchema>;
export const BindPlanNodesOutputJsonSchema = toToolJsonSchema(BindPlanNodesOutputSchema);
