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
import { createOrchestrationNotifyRelay } from "./orchestrationNotifyRelay.js";
import {
  listOrchestrationChildrenSummaries,
  listOrchestrationWorkspaceTasks,
} from "./orchestrationWorkspaceQuery.js";

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
  }): Promise<{ childTaskName: string }>;
  listChildren(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ children: OrchestrationChildSummary[] }>;
  listWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ tasks: OrchestrationWorkspaceTaskSummary[] }>;
  /**
   * host 启动恢复扫描（spec: orchestration-tasks.md）：遍历持久化的终态通知
   * 意图行——墓碑清行、终态晚于水位线补投、其余按原水位线重新武装 relay。
   * 不抛错（逐行兜底），可安全 fire-and-forget 调用。
   */
  recoverPendingChildNotifications(): Promise<void>;
}

interface WorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
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
   * readSessionMessages 用于通知附带的最终回复摘要（runtime 被回收时降级）；
   * resumeSession 用于向冷会话（旧的关联任务）下发指令前的物化恢复。
   */
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "sendPrompt" | "readSessionMessages" | "resumeSession"
  >;
}): IOrchestrationTaskService {
  const { taskService, taskIndexRepo, zcodeAgentService } = options;
  // 终态通知 relay（spec: orchestration-tasks.md）：持久水位线 + busy/冷会话重试 +
  // 启动恢复扫描，机制细节见 orchestrationNotifyRelay.ts。spawn 首条指令与
  // SendChildTaskPrompt 下发共用同一条武装链路。
  const notifyRelay = createOrchestrationNotifyRelay(options);

  return {
    async spawnSubTask(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      // 专名兜底收口：schema 已保证非空，这里只防超长标题污染列表布局。
      const childTaskName = params.name.trim().slice(0, 60) || "子任务";
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
      // 终态回流：双通道 relay（订阅 + 短窗轮询兜底），
      // spawn 首条指令与后续 SendChildTaskPrompt 下发共用同一条通知链路。
      notifyRelay.armChildTerminalRelay(
        {
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        child.taskId,
        child.title,
      );
      try {
        await taskService.sendPrompt({
          taskId: child.taskId,
          traceId: createUuid(),
          // 派生子会话有会话级"收尾交付摘要"环境引导，消息正文保持编排 agent 的原文。
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
      // 专名落库放在首条指令送达之后：session 主记录在首条输入 admission 时持久化，
      // 此刻 renameSession 才有落点（v4 命令经同一串行 inbox，排在 admission 之后）。
      // renameTask 自身三写路径（overlay + tasks-index titleOverridden + 尽力 v4），
      // 失败不回滚派生——标题退化为 prompt 派生文本，只影响展示。
      try {
        await taskService.renameTask({
          taskId: child.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          title: childTaskName,
        });
      } catch (error) {
        logger.warn("Orchestration child rename failed; keeping prompt-derived title", {
          event: "orchestration.spawn.rename_failed",
          childTaskId: child.taskId,
          childTaskName,
          errorMessage: error instanceof Error ? error.message : String(error),
          orchestrationTaskId: params.orchestrationTaskId,
        });
      }
      return { childTaskId: child.taskId, childTaskName };
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
      // 硬性规定（用户确认）：归档任务不参与编排统筹——归档意味着用户已把它移出
      // 活动视野，收它的终态没有意义。拒绝而不是静默跳过，让编排 agent 明确换候选。
      // archived 不在 ZCodeTaskMeta 上，从 tasks-index 列读（getTaskBucketFlags）。
      const bucketFlags = await taskIndexRepo.getTaskBucketFlags({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        taskId: params.childTaskId,
      });
      if (bucketFlags?.archived) {
        throw new Error(
          `Task "${childMeta.title}" is archived. Archived tasks cannot be linked into an orchestration.`,
        );
      }
      // 多编排跟踪（用户确认）：同域多个编排任务是合法用法，links 表 PK 本就支持
      // (workspace, orchestration, child) 多父。不再拒绝"已被其他编排持有"——关联是
      // 轻量书签；tasks 行的 parent 列只记首个父（UI 子任务下拉按它分组），后续编排
      // 的 SendChildTaskPrompt/终态通知按各自的 link 行独立工作。
      // 墓碑拦截：用户取消关联过的子任务，未经点名不得自动重关联。
      // 必须读原始 link 行（含 unlinked_at）判别（parentOf 查询会过滤墓碑）。
      const existingLink = await taskIndexRepo.getOrchestrationLink({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        orchestrationTaskId: params.orchestrationTaskId,
        childTaskId: params.childTaskId,
      });
      if (existingLink?.unlinkedAt != null && params.force !== true) {
        throw new Error(
          `Task "${childMeta.title}" was unlinked from this orchestration by the user. ` +
            "Do not relink it on your own; only retry with force=true when the user explicitly asks to link this exact task.",
        );
      }
      // 以本编排自己的 link 行判重（多编排跟踪下 parent 列可能指向别的编排）。
      const alreadyLinked = existingLink != null && existingLink.unlinkedAt == null;
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
      return { childTaskId: params.childTaskId, childTaskName: childMeta.title, alreadyLinked };
    },

    async unlinkTask(params) {
      // 手动 UI 动作：调用方是本机 renderer（经 IZCodeTaskService RPC 透传），
      // 不做 ensureOrchestratorMeta 终审——那是 CLI 反向请求通道的防御层。
      const clearedChild = await taskIndexRepo.unlinkOrchestrationChild({
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
      });
      // 墓碑后终态不再通知（spec）：内存 relay 废弃 + 持久意图清行，恢复扫描也不再捡起。
      notifyRelay.disposeChildRelay(
        {
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        params.childTaskId,
      );
      // await 清行：解链返回后 pending 行确定性消失（恢复扫描/并发读不再看到它）；
      // 失败仅记日志，不阻断取消关联本身。
      await taskIndexRepo
        .clearOrchestrationPendingNotify({
          orchestration: {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            taskId: params.orchestrationTaskId,
          },
          childTaskId: params.childTaskId,
        })
        .catch((error: unknown) => {
          // 清行失败只影响下次恢复扫描的一次冗余墓碑判断，不阻断取消关联。
          logger.warn("Failed to clear orchestration pending notify on unlink", {
            childTaskId: params.childTaskId,
            event: "orchestration.pending_notify.unlink_clear_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            orchestrationTaskId: params.orchestrationTaskId,
          });
        });
      logger.info("Orchestration child unlinked by user", {
        childTaskId: params.childTaskId,
        event: "orchestration.unlink",
        orchestrationTaskId: params.orchestrationTaskId,
        unlinked: clearedChild !== null,
        workspacePath: params.workspacePath,
      });
      return { unlinked: clearedChild !== null, child: clearedChild };
    },

    async sendChildTaskPrompt(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      // 只能对在册子任务下发：墓碑（已取消关联）与非子任务一律拒绝——
      // 这条通道是"用户分发语义"的执行面，脱离统筹的任务不再接受编排驱动。
      const link = await taskIndexRepo.getOrchestrationLink({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        orchestrationTaskId: params.orchestrationTaskId,
        childTaskId: params.childTaskId,
      });
      if (!link || link.unlinkedAt != null) {
        throw new Error(
          `Task ${params.childTaskId} is not an active child of this orchestration (it may have been unlinked). Use ListOrchestrationChildren to check current children.`,
        );
      }
      const childMeta = await taskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          taskId: params.childTaskId,
        })
        .catch(() => null);
      const childTaskName = childMeta?.title?.trim() || "子任务";
      // 武装终态 relay（每子任务去重，废弃同子任务旧 relay），再发指令：
      // 与 spawn 同序，秒级完成的子任务也不会漏通知。
      notifyRelay.armChildTerminalRelay(
        {
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        params.childTaskId,
        childTaskName,
      );
      // 下发走 v1 sendPrompt（与终态通知同通道）：目标多为关联进来的旧任务，
      // runtime 可能早已回收，v4 sendText 对冷会话直接 proto.sessionNotFound
      // （实测命中：向「6、生单」下发被拒）。v1 通道对冷会话的兜底是先
      // sessionResume 把会话从 store 物化回注册表，再重试一次。
      const dispatchPrompt = () =>
        zcodeAgentService.sendPrompt({
          sessionId: params.childTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          // 正文原样透传（用户确认）：修饰后缀会干扰子任务自己的判断——追问尤其
          // 需要原话。子任务的收尾纪律由其会话级引导（orchestration_child 身份）
          // 常驻保证，不靠每条消息带后缀；linked 会话亦不再例外。
          content: params.prompt,
          clientMode: "desktop-continuous",
        });
      try {
        try {
          await dispatchPrompt();
        } catch (firstError) {
          const firstMessage =
            firstError instanceof Error ? firstError.message : String(firstError);
          if (!/not active|sessionnotfound|unavailable/i.test(firstMessage)) {
            throw firstError;
          }
          logger.info("Child session cold; resuming before dispatch retry", {
            childTaskId: params.childTaskId,
            event: "orchestration.send_child_prompt.cold_resume",
            firstMessage,
            orchestrationTaskId: params.orchestrationTaskId,
          });
          // 冷恢复必须补模型选型：老会话没有持久化选型记录时，裸 resume 后首轮
          // 会被模型闸门拒绝（"Select a model before continuing"，实测命中）。
          // 用该任务 tasks-index 里最后一次使用的 provider/model 兜底。
          await zcodeAgentService.resumeSession({
            sessionId: params.childTaskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(childMeta?.provider && childMeta?.model
              ? {
                  model: { providerId: childMeta.provider, modelId: childMeta.model },
                  ...(childMeta.thoughtLevel ? { thoughtLevel: childMeta.thoughtLevel } : {}),
                }
              : {}),
          });
          await dispatchPrompt();
        }
      } catch (error) {
        logger.warn("Orchestration child prompt dispatch failed", {
          childTaskId: params.childTaskId,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "orchestration.send_child_prompt.failed",
          orchestrationTaskId: params.orchestrationTaskId,
        });
        throw new Error(
          `Failed to send the prompt to child task "${childTaskName}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      logger.info("Orchestration child prompt dispatched", {
        childTaskId: params.childTaskId,
        event: "orchestration.send_child_prompt.dispatched",
        orchestrationTaskId: params.orchestrationTaskId,
      });
      return { childTaskName };
    },

    async listChildren(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      return listOrchestrationChildrenSummaries(taskIndexRepo, params);
    },

    async listWorkspaceTasks(params) {
      return listOrchestrationWorkspaceTasks(taskIndexRepo, zcodeAgentService, params);
    },

    async recoverPendingChildNotifications() {
      await notifyRelay.recoverPendingChildNotifications();
    },
  };
}
