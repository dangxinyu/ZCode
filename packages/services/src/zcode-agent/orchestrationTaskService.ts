/* eslint-disable max-lines -- 编排任务服务工厂：spawn/sendChildTaskPrompt 两条派发路径与
 * relay/计划门/自动派发接线共享工厂闭包（taskService/zcodeAgentService/notifyRelay），拆分
 * 会把闭包依赖变成参数面板；excerpt/coldResume/nodeStatus/autoDispatch 已各自成模块。 */
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
import { prepareChildSessionForDispatch } from "./orchestrationColdResume.js";
import { createOrchestrationNotifyRelay } from "./orchestrationNotifyRelay.js";
import { createAutoDispatchTrigger } from "./orchestrationPlanAutoDispatch.js";
import type { IOrchestrationPlanService } from "./orchestrationPlanService.js";
import {
  listOrchestrationChildrenSummaries,
  listOrchestrationWorkspaceTasks,
} from "./orchestrationWorkspaceQuery.js";
import type { IOrchestrationTaskService } from "./orchestrationTypes.js";

export type {
  OrchestrationChildSummary,
  OrchestrationWorkspaceTaskSummary,
  IOrchestrationTaskService,
} from "./orchestrationTypes.js";

const logger = createServiceLogger("zcode-orchestration");

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
   * resumeSession 用于向冷会话（旧的关联任务）下发指令前的物化恢复；
   * setModel 用于冷恢复后会话没有生效模型时显式补选型（否则输入被闸门挡住）；
   * readSession 供终态 relay 轮询兜底补读子会话快照（首轮即崩的 error 终态）。
   */
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "sendPrompt"
    | "readSessionMessages"
    | "resumeSession"
    | "readSession"
    | "setModel"
    | "sendConversationCommandV4"
  >;
  /**
   * 计划门（spec: orchestration-plan.md）：计划模式开启且计划未确认时拒绝派生/关联。
   * 经 resolver 晚绑定（plan service 与本服务都只依赖 repo+agent 通道，装配顺序无关）。
   */
  resolveOrchestrationPlanService?: () => IOrchestrationPlanService | undefined;
}): IOrchestrationTaskService {
  const { taskService, taskIndexRepo, zcodeAgentService } = options;
  // 终态通知 relay（spec: orchestration-tasks.md）：持久水位线 + busy/冷会话重试 +
  // 启动恢复扫描，机制细节见 orchestrationNotifyRelay.ts。spawn 首条指令与
  // SendChildTaskPrompt 下发共用同一条武装链路。
  // 自动派发触发器（用户需求 2026-11-03）：service 构造后注入（工厂自引用解环，见模块注释）。
  let autoDispatchImpl:
    | ((
        scope: WorkspaceScope & { orchestrationTaskId: string },
        triggerNodeIds?: readonly string[],
      ) => Promise<void>)
    | null = null;
  const notifyRelay = createOrchestrationNotifyRelay({
    ...options,
    resolveAutoDispatcher: () => autoDispatchImpl ?? undefined,
  });

  /**
   * 节点配置的常驻 skill 写入子会话（用户需求 2026-11-04）：节点带 pinnedSkills 且
   * planNodeId 命中 active 计划时，经 v4 setPinnedSkills 命令全量替换子会话常驻名单
   * （与 UI 同一 runtime 写路径）。失败只记日志不阻断派发——skill 是增益不是前置。
   */
  async function applyPlanNodePinnedSkills(params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planNodeId?: string;
  }): Promise<void> {
    if (!params.planNodeId) return;
    const planService = options.resolveOrchestrationPlanService?.();
    if (!planService) return;
    try {
      const plan = await planService.getActivePlan({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        orchestrationTaskId: params.orchestrationTaskId,
      });
      const node = plan?.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
      if (!node || node.isStart || !node.pinnedSkills || node.pinnedSkills.length === 0) return;
      // setPinnedSkills 是 CAS 命令（信封必带 baseRevision）：首试从 0 起步，
      // stale 被拒时用 ack.revisionAtDecision 重试（与 UI CAS 循环同策略，最多三次）。
      let baseRevision = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ack = await zcodeAgentService.sendConversationCommandV4({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          envelope: {
            commandId: createUuid(),
            clientId: `orchestration-plan-${params.orchestrationTaskId}`,
            sessionId: node.childTaskId,
            type: "setPinnedSkills",
            payload: { skills: node.pinnedSkills },
            issuedAt: Date.now(),
            baseRevision,
          },
        });
        if (
          ack.status === "accepted" ||
          ack.status === "noop" ||
          ack.status === "duplicate"
        ) {
          return;
        }
        logger.warn("Plan node pinned skills command not accepted", {
          ackStatus: ack.status,
          attempt,
          event: "orchestration.plan.node_pinned_skills_rejected",
          orchestrationTaskId: params.orchestrationTaskId,
          planNodeId: params.planNodeId,
          reasonCode: ack.reasonCode ?? null,
          revisionAtDecision: ack.revisionAtDecision ?? null,
        });
        if (ack.revisionAtDecision === undefined || ack.revisionAtDecision === baseRevision) {
          return;
        }
        baseRevision = ack.revisionAtDecision;
      }
    } catch (error) {
      logger.warn("Plan node pinned skills apply failed", {
        event: "orchestration.plan.node_pinned_skills_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        orchestrationTaskId: params.orchestrationTaskId,
        planNodeId: params.planNodeId ?? null,
      });
    }
  }

  // 计划门（spec: orchestration-plan.md）：转发 plan service（模式开且计划未确认 → 拒绝）。
  function assertPlanGate(params: WorkspaceScope & { orchestrationTaskId: string }): Promise<void> {
    return (
      options.resolveOrchestrationPlanService?.()?.assertDispatchAllowed(params) ??
      Promise.resolve()
    );
  }

  // 自动执行闸门（用户需求 2026-11-03"断流"语义）：autoExecute=false 的节点是人工
  // 停留点，agent 自主派发不得越过（host 自动派发引擎自身已按开关过滤，UI「执行」
  // 按钮传 bypassAutoGate 表示人类显式动作）。检查读 active 计划的节点开关。
  async function assertAutoGate(
    params: WorkspaceScope & { orchestrationTaskId: string; planNodeId?: string; bypassAutoGate?: boolean },
  ): Promise<void> {
    if (!params.planNodeId || params.bypassAutoGate) return;
    const planService = options.resolveOrchestrationPlanService?.();
    if (!planService) return;
    const map = await planService.getPlansMap({
      orchestrationTaskIds: [params.orchestrationTaskId],
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const plansMap = map[params.orchestrationTaskId];
    const plan = plansMap?.plans.find((candidate) => candidate.planId === plansMap.activePlanId);
    const node = plan?.nodes.find((candidate) => candidate.nodeId === params.planNodeId);
    if (!plan || !node || node.isStart) return;
    if (node.status !== "pending" && node.status !== "stale") return;
    // 极性（用户需求 2026-11-04 翻转）：开关挂上游——任一非起始直接上游未开
    // 「完成后自动执行下游」，它完成时就不会释放本节点，链路在本节点前暂停。
    const gatedUpstream = (node.dependsOn ?? [])
      .filter((dep) => dep !== "start")
      .map((dep) => plan.nodes.find((candidate) => candidate.nodeId === dep))
      .find((upstream) => upstream && upstream.autoExecute !== true);
    if (!gatedUpstream) return;
    throw new Error(
      `自动执行闸门：上游「${gatedUpstream.name}」未开启「完成后自动执行下游」，链路在「${node.name}」前暂停。` +
        "请在画布开启它的自动开关（开始节点上有总控），或点本节点的「执行」按钮手动推进；" +
        "不要尝试重试派发。",
    );
  }

  const service: IOrchestrationTaskService = {
    async spawnSubTask(params) {
      await ensureOrchestratorMeta(taskIndexRepo, params);
      await assertPlanGate(params);
      await assertAutoGate(params);
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
      // 计划节点绑定（spec: orchestration-plan.md）：计划确认后按节点派生，
      // host 记下 childTaskId 供计划视图显示进度；未带 planNodeId 的计划外派生不绑定。
      if (params.planNodeId) {
        await options.resolveOrchestrationPlanService?.()?.bindPlanNodeForSpawn({
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          planNodeId: params.planNodeId,
          childTaskId: child.taskId,
        });
      }
      // 节点配置的常驻 skill 先落子会话（用户需求 2026-11-04）：首条指令之前注入。
      await applyPlanNodePinnedSkills(params);
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
      await assertPlanGate(params);
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
      // 解链清绑定（用户需求 2026-11-04）：计划里对它的绑定随解链一并清掉
      // （binding+锁定，dispatched 回落 pending），并广播计划变更让画布/下拉同步。
      // 失败只记日志不阻断取消关联本身——绑定残留可由用户在编辑器手动解绑兜底。
      await options
        .resolveOrchestrationPlanService?.()
        ?.clearPlanNodesForUnlinkedChild({
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          childTaskId: params.childTaskId,
        })
        .catch((error: unknown) => {
          logger.warn("Failed to clear plan node bindings on unlink", {
            childTaskId: params.childTaskId,
            event: "orchestration.unlink_clear_bindings_failed",
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
      await assertAutoGate(params);
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
      // 执行计划节点（spec 执行通道统一）：先把节点绑到该子任务并置 dispatched，再武装
      // relay、再发指令——与 spawn 同序，秒级终态也能落点。此前给已有子任务下发没有这一步，
      // 节点永远 pending、计划永远"执行中"（实测：确认后 agent 给 1 号点名 9 秒就回报了）。
      // 记下置态前的状态/绑定：下发失败必须回滚（bug 修复 2026-11-03），否则重派被
      // "already executing" 拒绝、agent 误以为已派发，节点永远卡在 dispatched。
      let dispatchMark: {
        planService: IOrchestrationPlanService;
        planNodeId: string;
        previousStatus: "pending" | "dispatched" | "terminal" | "stale" | "failed";
        previousChildTaskId: string | null;
      } | null = null;
      if (params.planNodeId) {
        const planService = options.resolveOrchestrationPlanService?.();
        if (!planService) {
          throw new Error("Orchestration plan service is unavailable; cannot execute a plan node.");
        }
        const previous = await planService.markPlanNodeDispatched({
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          planNodeId: params.planNodeId,
          childTaskId: params.childTaskId,
        });
        dispatchMark = { planService, planNodeId: params.planNodeId, ...previous };
      }
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
      // sessionResume 把会话从 store 物化回注册表。
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
        // 下发前把子会话准备到可执行（探测/冷恢复/补模型，细节与踩坑见
        // orchestrationColdResume.ts）：没有生效模型就换一个可用的，换不了就抛错——
        // 失败对编排 agent 可见，不再 ACK 后静默卡死。
        await prepareChildSessionForDispatch(
          { taskIndexRepo, zcodeAgentService },
          {
            orchestrationTaskId: params.orchestrationTaskId,
            childTaskId: params.childTaskId,
            childTaskName,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            childMeta,
          },
        );
        await applyPlanNodePinnedSkills(params);
        await dispatchPrompt();
      } catch (error) {
        logger.warn("Orchestration child prompt dispatch failed", {
          childTaskId: params.childTaskId,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "orchestration.send_child_prompt.failed",
          orchestrationTaskId: params.orchestrationTaskId,
        });
        // 下发没成功就没有"这一轮"：拆掉刚武装的 relay 与 pending 行，否则每次失败都
        // 留一条永久挂起的通知意图（恢复扫描反复重新武装却永远等不到终态）。
        notifyRelay.disposeChildRelay(
          {
            orchestrationTaskId: params.orchestrationTaskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          },
          params.childTaskId,
        );
        await taskIndexRepo
          .clearOrchestrationPendingNotify({
            orchestration: {
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
              taskId: params.orchestrationTaskId,
            },
            childTaskId: params.childTaskId,
          })
          .catch(() => {});
        // 节点状态/绑定回滚（bug 修复 2026-11-03）：没派出去就不该是 dispatched，否则
        // agent 重试被 "already executing" 拒绝、计划永远卡住。回滚本身失败只记日志。
        if (dispatchMark) {
          await dispatchMark.planService
            .revertPlanNodeDispatch({
              orchestrationTaskId: params.orchestrationTaskId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
              planNodeId: dispatchMark.planNodeId,
              childTaskId: params.childTaskId,
              previousStatus: dispatchMark.previousStatus,
              previousChildTaskId: dispatchMark.previousChildTaskId,
            })
            .catch((revertError: unknown) => {
              logger.warn("Orchestration plan node dispatch revert failed", {
                errorMessage:
                  revertError instanceof Error ? revertError.message : String(revertError),
                event: "orchestration.plan.node_dispatch_revert_failed",
                orchestrationTaskId: params.orchestrationTaskId,
                planNodeId: dispatchMark?.planNodeId,
              });
            });
        }
        throw new Error(
          `Failed to send the prompt to child task "${childTaskName}": ${
            error instanceof Error ? error.message : String(error)
          }${dispatchMark ? " The plan node was rolled back to its previous state; you may retry." : ""}`,
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

  autoDispatchImpl = createAutoDispatchTrigger(
    {
      zcodeAgentService: options.zcodeAgentService,
      resolveOrchestrationPlanService: options.resolveOrchestrationPlanService,
      logger,
    },
    () => service,
  );

  return service;
}
