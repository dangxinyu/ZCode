// 编排任务服务接口（spec: packages/services/specs/orchestration-tasks.md）。
// 从 orchestrationTaskService 拆出：服务实现与 adapter/agent 的 resolver 消费方共用。
import type { ZCodeTaskMeta } from "@zcode/shared";

export interface OrchestrationChildSummary {
  taskId: string;
  title: string;
  kind: "derived" | "linked";
  status: "running" | "completed" | "error" | null;
  updatedAt: number;
}

export interface OrchestrationWorkspaceTaskSummary {
  taskId: string;
  title: string;
  status: "running" | "completed" | "error" | null;
  orchestrationRole: "orchestrator" | "child" | null;
  /** 最近一条 assistant 回复的有界摘要（活跃会话可取，冷会话 null）。 */
  latestReply: string | null;
  updatedAt: number;
}

export interface IOrchestrationTaskService {
  /** 在编排任务的 workspace 内新建普通子任务并发送首条指令（kind=derived）。 */
  spawnSubTask(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    /** 子任务专名（模型起）：首条指令送达后经 renameTask 落为标题，全链路按名称展示。 */
    name: string;
    prompt: string;
    /** 按已确认计划派生时携带的节点 id（spec: orchestration-plan.md）。 */
    planNodeId?: string;
    /** 同 sendChildTaskPrompt：仅 UI「执行」按钮传，绕过断流闸门。 */
    bypassAutoGate?: boolean;
  }): Promise<{ childTaskId: string; childTaskName: string }>;
  /** 把同 workspace 已有普通任务纳入统筹（kind=linked）；不向目标任务注入指令。 */
  linkTask(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    childTaskId: string;
    /**
     * 用户点名强制重关联：墓碑（用户取消关联）默认拦截自动重关联；
     * 仅当用户明确要求关联这个任务时才允许模型带 force 重试。
     */
    force?: boolean;
  }): Promise<{ childTaskId: string; childTaskName: string; alreadyLinked: boolean }>;
  /**
   * 用户手动取消关联（UI 动作，非模型工具）：置关系墓碑 + 清子任务编排标记。
   * 幂等：关系不在册（不存在或已是墓碑）返回 unlinked=false。
   */
  unlinkTask(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    childTaskId: string;
  }): Promise<{ unlinked: boolean; child: ZCodeTaskMeta | null }>;
  /**
   * 向在册子任务（derived/linked）下发一条追加指令（SendChildTaskPrompt 工具）。
   * 只允许编排任务对在册子任务使用；下发后武装终态通知 relay（每子任务去重）。
   */
  sendChildTaskPrompt(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    childTaskId: string;
    prompt: string;
    /**
     * 执行计划节点时携带（spec: orchestration-plan.md 执行通道统一）：下发前把节点绑定到
     * 该子任务并置 dispatched，终态回报才有落点；计划外的追加指令不带。
     */
    planNodeId?: string;
    /** 绕过自动执行闸门（用户需求 2026-11-03）：仅 UI「执行」按钮（人类显式动作）传；
     * agent 自主派发不传——autoExecute=false 的节点是断流点，谁都不得自动派发。 */
    bypassAutoGate?: boolean;
  }): Promise<{ childTaskName: string }>;
  listChildren(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ children: OrchestrationChildSummary[] }>;
  listWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    /** 发起调用的编排任务 id：planMode 字段按它读取（spec: orchestration-plan.md）。 */
    orchestrationTaskId?: string;
  }): Promise<{ planMode: boolean; tasks: OrchestrationWorkspaceTaskSummary[] }>;
  /**
   * host 启动恢复扫描（spec: orchestration-tasks.md）：遍历持久化的终态通知
   * 意图行——墓碑清行、终态晚于水位线补投、其余按原水位线重新武装 relay。
   * 不抛错（逐行兜底），可安全 fire-and-forget 调用。
   */
  recoverPendingChildNotifications(): Promise<void>;
}
