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
  SEND_CHILD_TASK_PROMPT_TOOL_NAME,
  SendChildTaskPromptInputJsonSchema,
  SendChildTaskPromptInputSchema,
  SendChildTaskPromptOutputJsonSchema,
  SendChildTaskPromptOutputSchema,
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
  type SendChildTaskPromptInput,
  type SendChildTaskPromptOutput,
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
  | typeof SEND_CHILD_TASK_PROMPT_TOOL_NAME
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

const sendChildTaskPromptHandler: ToolHandler = async (input, context) => {
  const parsed = SendChildTaskPromptInputSchema.parse(input) as SendChildTaskPromptInput;
  assertOrchestrationPort(context, SEND_CHILD_TASK_PROMPT_TOOL_NAME);
  return context.orchestrationPort.sendChildTaskPrompt(parsed, { sessionId: context.sessionId });
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
      "Register a workspace task as a child of this orchestration (its terminal outcomes get reported here). Cheap and default-on: whenever a user message corresponds to a specific task — a status question, a bug in its domain, follow-up work — link that task FIRST, then answer or dispatch via SendChildTaskPrompt. Orchestrator tasks, archived tasks, and tasks owned by another orchestration are rejected.",
    modelInstructions: [
      "Match candidates by task identity first: the title states the task's purpose — a task named after a module/feature owns that domain. latestReply confirms current activity, but incidental mentions are NOT ownership: a transcript that merely echoes the question (asked there once in passing, or the file was touched while doing something else) must not outrank the task whose title/purpose matches the domain. Never guess a taskId.",
      "If the identity-matching task still looks right but you are unsure of its scope, use ReadSessionContext with that taskId to verify its goal before linking.",
      "Never link an archived task — the host rejects it. If the only matching task is archived, tell the user instead of attempting the link.",
      "Linking is read-only for the target: it does not send it any prompt. To dispatch work, use SendChildTaskPrompt after linking.",
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

export const sendChildTaskPromptToolEntry: ToolEntry = {
  capability: "Send a follow-up instruction to an existing child task of this orchestration",
  metadata: {
    name: SEND_CHILD_TASK_PROMPT_TOOL_NAME,
    description:
      "Send a follow-up instruction to a child task already tracked by this orchestration (derived or linked). Use this to dispatch work that matches a child's domain instead of doing it yourself; the child's terminal outcome (with a reply excerpt) is reported back automatically.",
    modelInstructions: [
      "Decision order for any work-like user message, cheapest first: (1) match the message against your existing children's domains — one ListOrchestrationChildren call at most, no code reads, no session reads; the dispatch decision is made from child names/domains alone. (2) If a child's domain matches, dispatch immediately with this tool — do NOT research the problem yourself first; that duplicates the child's job and wastes tokens. (3) If no child fits and the work is non-trivial, spawn a new child. (4) Only handle a message inline when it targets the orchestration itself — planning, progress, summaries, quick clarifications — and keep such answers brief.",
      "Not every message is dispatch material: questions about status, summaries, or the orchestration plan are answered inline; hands-on work that no child covers is spawned. When in doubt between dispatching and investigating, dispatch — the child reports back with an excerpt if the work belongs to it.",
      "The taskId must be a current child: call ListOrchestrationChildren first if unsure. Unlinked or non-child tasks are rejected.",
      "When reporting to the user, refer to the child task by its name only; internal identifiers never appear in user-visible text.",
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
  handler: sendChildTaskPromptHandler,
  inputSchema: SendChildTaskPromptInputJsonSchema,
  outputSchema: SendChildTaskPromptOutputJsonSchema,
  runtimeInputSchema: SendChildTaskPromptInputSchema,
  runtimeOutputSchema: SendChildTaskPromptOutputSchema,
  permission: orchestrationPermission(
    "orchestration.sendChildTaskPrompt",
    "SendChildTaskPrompt forwards an instruction to a child task already tracked by this orchestration",
    false,
  ),
  resultBudget: orchestrationResultBudget,
  timeout: orchestrationTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SendChildTaskPrompt was cancelled before the prompt was sent",
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
      "List the child tasks currently tracked by this orchestration (kind derived/linked, status, latest reply). Questions about your own children — what's dispatched, what finished, what's still running — are answered from THIS tool, not from the filesystem.",
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
      "Authoritative task inventory of this workspace (active non-archived tasks with taskId, title, status, role, latest reply excerpt). You are an orchestration task: any question about what tasks exist, their progress, or workload distribution is answered from THIS tool — never by reading feature docs or the codebase. It is also the entry point for adoption: when listed tasks clearly belong to your orchestration's scope, bring them in with LinkTask (or propose it).",
    modelInstructions: [
      "You coordinate other tasks; you are not their executor. Task-inventory or progress questions (\"how many tasks\", \"what's running\", \"who owns what\") go through this tool, not the filesystem or project docs.",
      "After listing, if unlinked active tasks clearly belong to this orchestration's scope, link them (or propose linking) — an orchestration with no children coordinates nothing.",
      "Archived tasks are excluded and cannot be linked. latestReply is a short excerpt of the task's most recent assistant reply — prefer it over the title for judging what a task is actually doing.",
    ],
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
  SendChildTaskPromptOutput,
  SpawnSubTaskOutput,
};
