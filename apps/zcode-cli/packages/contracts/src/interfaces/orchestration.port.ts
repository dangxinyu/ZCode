// ============================================================
// Orchestration Port - 编排任务派生/关联普通子任务的边界
// spec: packages/services/specs/orchestration-tasks.md
// 实现在 host 域（desktop host 经反向 RPC 提供）；CLI 侧工具只做透传。
// ============================================================

import type {
  LinkTaskInput,
  LinkTaskOutput,
  ListOrchestrationChildrenInput,
  ListOrchestrationChildrenOutput,
  ListWorkspaceTasksInput,
  ListWorkspaceTasksOutput,
  SpawnSubTaskInput,
  SpawnSubTaskOutput,
} from "../tools/orchestration.js";

export interface OrchestrationTaskContext {
  /** 发起编排工具调用的会话；host 侧以此定位编排任务与 workspace，拒绝跨 workspace 派生/关联。 */
  sessionId: string;
}

export interface OrchestrationPort {
  /** 在编排任务的 workspace 内新建普通子任务并发送首条指令（kind=derived）。 */
  spawnSubTask(
    input: SpawnSubTaskInput,
    context: OrchestrationTaskContext,
  ): Promise<SpawnSubTaskOutput>;
  /** 把同 workspace 已有普通任务纳入统筹（kind=linked）；不向目标任务注入指令。 */
  linkTask(input: LinkTaskInput, context: OrchestrationTaskContext): Promise<LinkTaskOutput>;
  /** 列出当前编排任务的子任务及状态（含派生/关联 kind）。 */
  listChildren(
    input: ListOrchestrationChildrenInput,
    context: OrchestrationTaskContext,
  ): Promise<ListOrchestrationChildrenOutput>;
  /** 列出当前 workspace 的任务摘要，供模型分析哪些已有任务适合关联。 */
  listWorkspaceTasks(
    input: ListWorkspaceTasksInput,
    context: OrchestrationTaskContext,
  ): Promise<ListWorkspaceTasksOutput>;
}
