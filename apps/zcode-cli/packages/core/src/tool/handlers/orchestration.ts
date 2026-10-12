// ============================================================
// Orchestration Tool Handlers
// spec: packages/services/specs/orchestration-tasks.md
// handler 刻意薄：解析输入 → 断言端口在场 → 透传 orchestrationPort。
// 注册门（runtime-tools includeOrchestration）已按 taskType 限制在
// orchestration_parent 会话；orchestration_child 由结构性禁用名单拦截，
// 这里再做一层终审，防旧入口或异常 provider 漏网。
// ============================================================

import {
  CoreErrorType,
  LINK_TASK_TOOL_NAME,
  LIST_ORCHESTRATION_CHILDREN_TOOL_NAME,
  LIST_WORKSPACE_TASKS_TOOL_NAME,
  LinkTaskInputJsonSchema,
  LinkTaskInputSchema,
  LinkTaskOutputJsonSchema,
  LinkTaskOutputSchema,
  ListOrchestrationChildrenInputJsonSchema,
  ListOrchestrationChildrenInputSchema,
  ListOrchestrationChildrenOutputJsonSchema,
  ListOrchestrationChildrenOutputSchema,
  ListWorkspaceTasksInputJsonSchema,
  ListWorkspaceTasksInputSchema,
  ListWorkspaceTasksOutputJsonSchema,
  ListWorkspaceTasksOutputSchema,
  SPAWN_SUB_TASK_TOOL_NAME,
  SpawnSubTaskInputJsonSchema,
  SpawnSubTaskInputSchema,
  SpawnSubTaskOutputJsonSchema,
  SpawnSubTaskOutputSchema,
  createCoreError,
  type LinkTaskInput,
  type LinkTaskOutput,
  type ListOrchestrationChildrenOutput,
  type ListWorkspaceTasksOutput,
  type OrchestrationPort,
  type SpawnSubTaskInput,
  type SpawnSubTaskOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const ORCHESTRATION_TOOL_TIMEOUT_MS = 30_000;
const ORCHESTRATION_MODEL_BYTES = 32_000;

type OrchestrationToolName =
  | typeof SPAWN_SUB_TASK_TOOL_NAME
  | typeof LINK_TASK_TOOL_NAME
  | typeof LIST_ORCHESTRATION_CHILDREN_TOOL_NAME
  | typeof LIST_WORKSPACE_TASKS_TOOL_NAME;

function assertOrchestrationPort(
  context: ToolExecutionContext,
  toolName: OrchestrationToolName,
): asserts context is ToolExecutionContext & {
  orchestrationPort: NonNullable<ToolExecutionContext["orchestrationPort"]>;
} {
  if (context.orchestrationPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `OrchestrationPort is not configured for ${toolName}`,
    {
      context: { toolCallId: context.toolCallId, toolName },
      recoverable: false,
    },
  );
}

const spawnSubTaskHandler: ToolHandler = async (input, context) => {
  const parsed = SpawnSubTaskInputSchema.parse(input) as SpawnSubTaskInput;
  assertOrchestrationPort(context, SPAWN_SUB_TASK_TOOL_NAME);
  return context.orchestrationPort.spawnSubTask(parsed, { sessionId: context.sessionId });
};

const linkTaskHandler: ToolHandler = async (input, context) => {
  const parsed = LinkTaskInputSchema.parse(input) as LinkTaskInput;
  assertOrchestrationPort(context, LINK_TASK_TOOL_NAME);
  return context.orchestrationPort.linkTask(parsed, { sessionId: context.sessionId });
};

const listChildrenHandler: ToolHandler = async (input, context) => {
  ListOrchestrationChildrenInputSchema.parse(input);
  assertOrchestrationPort(context, LIST_ORCHESTRATION_CHILDREN_TOOL_NAME);
  return context.orchestrationPort.listChildren({}, { sessionId: context.sessionId });
};

const listWorkspaceTasksHandler: ToolHandler = async (input, context) => {
  ListWorkspaceTasksInputSchema.parse(input);
  assertOrchestrationPort(context, LIST_WORKSPACE_TASKS_TOOL_NAME);
  return context.orchestrationPort.listWorkspaceTasks({}, { sessionId: context.sessionId });
};

/**
 * 权限基线：编排工具只在用户显式创建的编排任务会话注册（taskType 门），
 * 派生出的子任务是普通任务，执行期的工具调用照常走各自权限确认——
 * 权限不随委派转移是 spec 红线，所以这里的创建/关联动作本身不再叠加确认。
 */
function orchestrationPermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: needsApproval ? "medium" : "low",
    sideEffectScope: needsApproval ? "workspace" : "none",
    needsApproval,
    patternSources: ["toolName"],
    ...(needsApproval ? {} : { alwaysAllowPatternSources: ["toolName"] as const }),
    denyPriority: "beforeAsk",
  };
}

const orchestrationResultBudget = {
  maxInlineBytes: ORCHESTRATION_MODEL_BYTES,
  maxModelBytes: ORCHESTRATION_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: ORCHESTRATION_MODEL_BYTES,
    direction: "head" as const,
  },
};

const orchestrationTimeout = {
  defaultMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
  maxMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

export const spawnSubTaskToolEntry: ToolEntry = {
  capability: "Spawn a normal child task under this orchestration task",
  metadata: {
    name: SPAWN_SUB_TASK_TOOL_NAME,
    description:
      "Spawn a new normal child task in this orchestration task's workspace and send it the first instruction. The child runs as a normal task with its own session and permissions; it cannot spawn or link further orchestration children. Its terminal outcomes are reported back to this orchestration task.",
    modelInstructions: [
      "Use this to parallelize independent work as top-level tasks the user can watch, pause, or open in the task list.",
      "Write a self-contained prompt: the child starts with no history from this conversation. Include the deliverable and any file paths it needs.",
      "After spawning, do not wait idly for the child; terminal notifications arrive automatically. Continue other work or summarize the plan.",
      "When reporting to the user, refer to the child task by its name only. Internal identifiers (taskId/sessionId/inputId) must never appear in user-visible text.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
    maxOutputBytes: ORCHESTRATION_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: spawnSubTaskHandler,
  inputSchema: SpawnSubTaskInputJsonSchema,
  outputSchema: SpawnSubTaskOutputJsonSchema,
  runtimeInputSchema: SpawnSubTaskInputSchema,
  runtimeOutputSchema: SpawnSubTaskOutputSchema,
  permission: orchestrationPermission(
    "orchestration.spawnSubTask",
    "SpawnSubTask creates a normal child task in this workspace and sends it the first instruction",
    false,
  ),
  resultBudget: orchestrationResultBudget,
  timeout: orchestrationTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SpawnSubTask was cancelled before the child task was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const linkTaskToolEntry: ToolEntry = {
  capability: "Adopt an existing normal task into this orchestration",
  metadata: {
    name: LINK_TASK_TOOL_NAME,
    description:
      "Link an existing normal task in the same workspace into this orchestration so its terminal outcomes are tracked and summarized here. Linking never injects instructions into the target task. Orchestrator tasks and tasks already owned by another orchestration are rejected.",
    modelInstructions: [
      "Call ListWorkspaceTasks first to analyze which existing task fits the current sub-goal (title, status, recency, latest reply); never guess a taskId.",
      "Judge fit by the latestReply excerpt (what the task is actually doing or delivered), not by title similarity alone. If a candidate looks right but you are still unsure of its scope, use ReadSessionContext with that taskId to verify its goal before linking.",
      "Linking is read-only for the target: it does not send it any prompt. If the linked task must do new work, spawn a new child task instead or tell the user.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
    maxOutputBytes: ORCHESTRATION_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: linkTaskHandler,
  inputSchema: LinkTaskInputJsonSchema,
  outputSchema: LinkTaskOutputJsonSchema,
  runtimeInputSchema: LinkTaskInputSchema,
  runtimeOutputSchema: LinkTaskOutputSchema,
  permission: orchestrationPermission(
    "orchestration.linkTask",
    "LinkTask adopts an existing normal task into this orchestration without injecting instructions",
    false,
  ),
  resultBudget: orchestrationResultBudget,
  timeout: orchestrationTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LinkTask was cancelled before the task was linked",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const listOrchestrationChildrenToolEntry: ToolEntry = {
  capability: "List child tasks tracked by this orchestration",
  metadata: {
    name: LIST_ORCHESTRATION_CHILDREN_TOOL_NAME,
    description:
      "List the child tasks of this orchestration task with their kind (derived or linked) and status.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
    maxOutputBytes: ORCHESTRATION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listChildrenHandler,
  inputSchema: ListOrchestrationChildrenInputJsonSchema,
  outputSchema: ListOrchestrationChildrenOutputJsonSchema,
  runtimeInputSchema: ListOrchestrationChildrenInputSchema,
  runtimeOutputSchema: ListOrchestrationChildrenOutputSchema,
  permission: orchestrationPermission(
    "orchestration.read",
    "ListOrchestrationChildren only reads this orchestration's child relations",
    false,
  ),
  resultBudget: orchestrationResultBudget,
  timeout: orchestrationTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ListOrchestrationChildren was cancelled before children were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const listWorkspaceTasksToolEntry: ToolEntry = {
  capability: "List task summaries in the current workspace",
  metadata: {
    name: LIST_WORKSPACE_TASKS_TOOL_NAME,
    description:
      "List task summaries (taskId, title, status, orchestration role, latest reply excerpt) in this orchestration task's workspace, for analyzing which existing task could take over a sub-goal before LinkTask. latestReply is a short excerpt of the task's most recent assistant reply (null when its runtime is no longer active) — prefer it over the title for judging what a task is actually doing.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: ORCHESTRATION_TOOL_TIMEOUT_MS,
    maxOutputBytes: ORCHESTRATION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listWorkspaceTasksHandler,
  inputSchema: ListWorkspaceTasksInputJsonSchema,
  outputSchema: ListWorkspaceTasksOutputJsonSchema,
  runtimeInputSchema: ListWorkspaceTasksInputSchema,
  runtimeOutputSchema: ListWorkspaceTasksOutputSchema,
  permission: orchestrationPermission(
    "orchestration.read",
    "ListWorkspaceTasks only reads task summaries in this workspace",
    false,
  ),
  resultBudget: orchestrationResultBudget,
  timeout: orchestrationTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ListWorkspaceTasks was cancelled before tasks were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export type {
  LinkTaskOutput,
  ListOrchestrationChildrenOutput,
  ListWorkspaceTasksOutput,
  OrchestrationPort,
  SpawnSubTaskOutput,
};
