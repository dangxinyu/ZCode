// 编排任务服务（spec: packages/services/specs/orchestration-tasks.md）。
// 关系写入路径唯一：spawn/link 都从这里进 taskIndexRepo；子任务创建复用
// IZCodeTaskService.createTask 的无界面派发路径（deferred + 首条 prompt）。
// orchestrator 标记在这里幂等自愈——UI 的 v4 createSession 路径不落 tasks-index 标记，
// 分区过滤读 sessions-index 的 summary.orchestrationRole（taskType 投影），不依赖本标记。

import { createUuid } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";

const logger = createServiceLogger("zcode-orchestration");

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
  updatedAt: number;
}

export interface IOrchestrationTaskService {
  /** 在编排任务的 workspace 内新建普通子任务并发送首条指令（kind=derived）。 */
  spawnSubTask(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    prompt: string;
  }): Promise<{ childTaskId: string }>;
  /** 把同 workspace 已有普通任务纳入统筹（kind=linked）；不向目标任务注入指令。 */
  linkTask(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    childTaskId: string;
  }): Promise<{ childTaskId: string; alreadyLinked: boolean }>;
  listChildren(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ children: OrchestrationChildSummary[] }>;
  listWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ tasks: OrchestrationWorkspaceTaskSummary[] }>;
}

interface WorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

function toTaskStatus(status: ZCodeTaskMeta["status"]): "running" | "completed" | "error" | null {
  if (status === "completed" || status === "error") return status;
  return status === "running" ? "running" : null;
}

/**
 * 编排父任务的一层 team 校验（纵深防御，非第一道门）：
 * - 第一道门在 CLI：编排工具只对 taskType=orchestration_parent 会话注册，反向请求走受信
 *   stdio 通道——所以这里的库校验失败不能 fail-closed：
 * - child 身份的行存在 → 拒绝（CLI 结构性禁用之外的兜底）；
 * - 行存在但无标记 → 幂等自愈盖 orchestrator（写入路径唯一 = 本服务）；
 * - 行不存在（新建任务的首轮 turn 里 tasks-index 行尚未 sync，联调已证实该竞态）→ 放行，
 *   身份以 CLI 工具面门为准，workspace 一律用 handler 注入值。
 * 返回值仅供诊断日志使用；null = 行缺失放行。
 */
async function ensureOrchestratorMeta(
  repo: TaskIndexRepo,
  params: WorkspaceScope & { orchestrationTaskId: string },
): Promise<ZCodeTaskMeta | null> {
  const meta = await repo.getTaskMeta({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    taskId: params.orchestrationTaskId,
  });
  if (!meta) {
    logger.info("Orchestration meta row not synced yet; trusting CLI taskType gate", {
      event: "orchestration.marker.row_missing",
      taskId: params.orchestrationTaskId,
      workspacePath: params.workspacePath,
    });
    return null;
  }
  if (meta.orchestrationRole === "child") {
    throw new Error(
      "An orchestration child task cannot spawn or link further orchestration children.",
    );
  }
  if (meta.orchestrationRole !== "orchestrator") {
    await repo.syncTaskMeta({
      meta: { ...meta, orchestrationRole: "orchestrator", updatedAt: Date.now() },
    });
    logger.info("Self-healed orchestrator marker", {
      event: "orchestration.marker.self_healed",
      taskId: params.orchestrationTaskId,
      workspacePath: params.workspacePath,
    });
  }
  return meta;
}

export function createOrchestrationTaskService(options: {
  taskService: IZCodeTaskService;
  taskIndexRepo: TaskIndexRepo;
  /**
   * 终态通知通道：编排会话由 v4 createSession 创建，不在 task adapter 的
   * taskTargets 内存表里（taskService.sendPrompt 会抛 ZCODE_SESSION_TARGET_NOT_FOUND，
   * 联调实测命中），通知必须走 v1 sendPrompt（session/send → v4 sendText，不依赖内存表）。
   * 子任务由 taskService.createTask 创建（有 target），首条指令仍走 taskService。
   */
  zcodeAgentService: Pick<IZCodeAgentService, "sendPrompt">;
}): IOrchestrationTaskService {
  const { taskService, taskIndexRepo, zcodeAgentService } = options;
  return {
    async spawnSubTask(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      // workspace 以 handler 注入的 CLI 连接 workspace 为准（与编排会话一致），
      // 不从可能尚未 sync 的 parent meta 行取。
      const child = await taskService.createTask({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        // child 会话级身份：taskType=orchestration_child（结构性禁用编排工具）+
        // tasks-index child 标记，全部由 createTask 的 orchestrationParentTaskId 分支落。
        orchestrationParentTaskId: params.orchestrationTaskId,
        deferPersistenceUntilFirstPrompt: true,
      });
      // 先落关系再发指令：sendPrompt 失败时关系与任务仍在，错误抛回编排会话即可重试。
      await taskIndexRepo.linkOrchestrationChild({
        orchestration: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          taskId: params.orchestrationTaskId,
        },
        child: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          taskId: child.taskId,
        },
        kind: "derived",
      });
      // 终态回流（spec 事件顺序）双通道，通知幂等一次性：
      // 1) onDynamicTaskTerminalOutcome 订阅——长任务的常规通道；
      // 2) 短窗轮询兜底——syncer 的终态事件只在观察到 running→terminal 迁移时发射
      //    （processSummary 的 becameTerminal 要求 previous 非 undefined；draft 不进基线），
      //    秒级完成的子任务其 running 帧会被 sessions-index conflation 吞掉，终态帧
      //    到达时 previous 仍为 undefined 而不发射（联调实测命中）。轮询读 tasks-index
      //    的权威 status，30 秒窗内每 3 秒检查一次，双通道先到先发。
      // 进程重启两通道皆失时，编排 agent 靠 ListOrchestrationChildren 兜底（spec 声明）。
      let notified = false;
      const notifyChildTerminal = (outcome: "succeeded" | "failed", inputId?: string) => {
        if (notified) return;
        notified = true;
        logger.info("Orchestration child terminal outcome received", {
          childTaskId: child.taskId,
          event: "orchestration.child_terminal.received",
          inputId: inputId ?? null,
          outcome,
          orchestrationTaskId: params.orchestrationTaskId,
        });
        void zcodeAgentService
          .sendPrompt({
            sessionId: params.orchestrationTaskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            content:
              `[orchestration] 子任务「${child.title ?? child.taskId}」已${
                outcome === "failed" ? "失败" : "完成"
              }（taskId=${child.taskId}${inputId ? `，来源轮次 inputId=${inputId}` : ""}）。\n` +
              "如需其产出可调用 ReadSessionContext（sessionId 即该 taskId）读取；" +
              "用 ListOrchestrationChildren 查看全部子任务状态后决定是否汇总。",
            clientMode: "desktop-continuous",
          })
          .then(() => {
            logger.info("Orchestration child terminal notification delivered", {
              childTaskId: child.taskId,
              event: "orchestration.child_terminal_notify.delivered",
              orchestrationTaskId: params.orchestrationTaskId,
            });
          })
          .catch((error: unknown) => {
            logger.warn("Failed to notify orchestration parent of child terminal outcome", {
              childTaskId: child.taskId,
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "orchestration.child_terminal_notify.failed",
              orchestrationTaskId: params.orchestrationTaskId,
              workspacePath: params.workspacePath,
            });
          });
      };
      const subscription = taskService.onDynamicTaskTerminalOutcome(child.taskId)((result) => {
        subscription.dispose();
        notifyChildTerminal(result.outcome === "failed" ? "failed" : "succeeded", result.inputId);
      });
      logger.info("Orchestration child terminal subscription armed", {
        childTaskId: child.taskId,
        event: "orchestration.child_terminal_subscription.armed",
        orchestrationTaskId: params.orchestrationTaskId,
        workspacePath: params.workspacePath,
      });
      const pollAttempts = 10;
      const pollIntervalMs = 3_000;
      const pollTerminal = (attempt: number) => {
        if (notified || attempt > pollAttempts) return;
        setTimeout(() => {
          if (notified) return;
          void taskIndexRepo
            .getTaskMeta({
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
              taskId: child.taskId,
            })
            .then((meta) => {
              if (notified || !meta) {
                pollTerminal(attempt + 1);
                return;
              }
              if (meta.status === "completed" || meta.status === "error") {
                notifyChildTerminal(meta.status === "error" ? "failed" : "succeeded");
              } else {
                pollTerminal(attempt + 1);
              }
            })
            .catch(() => {
              pollTerminal(attempt + 1);
            });
        }, pollIntervalMs);
      };
      pollTerminal(1);
      try {
        await taskService.sendPrompt({
          taskId: child.taskId,
          traceId: createUuid(),
          content: params.prompt,
          clientMode: "desktop-continuous",
        });
      } catch (error) {
        logger.warn("Orchestration child first prompt failed after creation", {
          event: "orchestration.spawn.first_prompt_failed",
          childTaskId: child.taskId,
          errorMessage: error instanceof Error ? error.message : String(error),
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
        });
        throw new Error(
          `Child task ${child.taskId} was created and linked, but its first prompt failed to send: ${
            error instanceof Error ? error.message : String(error)
          }. Open the child task to send it manually.`,
        );
      }
      return { childTaskId: child.taskId };
    },

    async linkTask(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      const childMeta = await taskIndexRepo.getTaskMeta({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        taskId: params.childTaskId,
      });
      if (!childMeta) {
        throw new Error(`Task not found in this workspace: ${params.childTaskId}`);
      }
      if (childMeta.orchestrationRole === "orchestrator") {
        throw new Error("Cannot link an orchestration task into another orchestration.");
      }
      const existingParent = await taskIndexRepo.getOrchestrationParentOf({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        taskId: params.childTaskId,
      });
      if (existingParent && existingParent.orchestrationTaskId !== params.orchestrationTaskId) {
        throw new Error(
          `Task ${params.childTaskId} is already a child of another orchestration.`,
        );
      }
      const alreadyLinked = existingParent?.orchestrationTaskId === params.orchestrationTaskId;
      if (!alreadyLinked) {
        await taskIndexRepo.linkOrchestrationChild({
          orchestration: {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            taskId: params.orchestrationTaskId,
          },
          child: {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            taskId: params.childTaskId,
          },
          kind: "linked",
        });
      }
      return { childTaskId: params.childTaskId, alreadyLinked };
    },

    async listChildren(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
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
            workspaceIdentity: params.workspaceIdentity,
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
    },

    async listWorkspaceTasks(params) {
      const metas = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      return {
        tasks: metas.map((meta) => ({
          taskId: meta.taskId,
          title: meta.title,
          status: toTaskStatus(meta.status),
          orchestrationRole: meta.orchestrationRole ?? null,
          updatedAt: meta.updatedAt,
        })),
      };
    },
  };
}
