/* eslint-disable max-lines -- relay 生命周期（武装/双通道观察/恢复扫描/闸门联动/选型保障）
 * 共享工厂闭包，拆分会把同一份终态语义散到多处。 */
// 子任务终态通知 relay（spec: packages/services/specs/orchestration-tasks.md）。
// 从 orchestrationTaskService 拆出：通知是"持久意图 + 健壮投递 + 启动恢复"的
// 独立机制，与 spawn/link 的关系写入职责分开，避免服务文件继续膨胀。
// 语义（用户确认 2026-10-21）：**下发驱动**——一轮下发（spawn 首条指令 /
// SendChildTaskPrompt）只上报它触发的那个执行轮的终态（下发后的第一个新终态），
// 送达即销毁 relay 与 pending 行；用户在子任务会话里的手动多轮不上报（关联任务
// 常在非编排场景独立使用，终身上报会持续骚扰编排会话）。可靠性（实测丢失驱动）：
// armed_at 持久化在 tasks-index orchestration_pending_notifies 行上——app 重启后
// 由恢复扫描接管（长周期编排 11 个子任务零通知），busy 拒绝退避重试（并行 15 丢 2）。

import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import { deliverChildTerminalNotice, sleep } from "./orchestrationNotifyDelivery.js";

const logger = createServiceLogger("zcode-orchestration");

export interface OrchestrationNotifyRelayScope {
  orchestrationTaskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 终态 relay 的内存去重键：workspaceKey:orchestrationTaskId:childTaskId。
 * 键必须含主任务 id（spec 多父关联：各编排的通知按各自 link 行独立工作）——
 * 早期版本只有 workspace:child，第二个编排下发会 dispose 第一个编排的订阅，
 * 终态只通知最后下发的那家（多父实测争抢点）。
 */
function buildChildRelayKey(
  scope: { orchestrationTaskId: string; workspacePath: string; workspaceIdentity?: string },
  childTaskId: string,
): string {
  return `${scope.workspaceIdentity ?? scope.workspacePath}:${scope.orchestrationTaskId}:${childTaskId}`;
}

export interface OrchestrationNotifyRelayScope {
  orchestrationTaskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function createOrchestrationNotifyRelay(options: {
  taskService: IZCodeTaskService;
  taskIndexRepo: TaskIndexRepo;
  /**
   * 通知通道：编排会话由 v4 createSession 创建，不在 task adapter 的 taskTargets
   * 内存表里，通知必须走 v1 sendPrompt（session/send → v4 sendText，不依赖内存表）。
   * readSessionMessages 用于通知附带的最终回复摘要（runtime 被回收时降级）；
   * resumeSession 用于冷编排会话（runtime 回收）投递前的物化恢复；
   * readSession 用于轮询兜底补读子会话快照（下发后首轮即崩的 error 终态）。
   */
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "sendPrompt" | "readSessionMessages" | "resumeSession" | "readSession" | "setModel"
  >;
  /** 计划节点进度同步（spec: orchestration-plan.md）：终态回传时把绑定节点置终态，
   * 返回本轮真实迁移的节点 id（供自动派发扫描限定触发范围）。 */
  resolveOrchestrationPlanService?: () =>
    | {
        markPlanNodeTerminal(params: {
          orchestrationTaskId: string;
          workspacePath: string;
          workspaceIdentity?: string;
          childTaskId: string;
          outcome: "succeeded" | "failed";
        }): Promise<{ markedNodeIds: string[] }>;
      }
    | undefined;
  /** 自动派发触发（spec: orchestration-plan.md 节点自动执行，用户需求 2026-11-03）：
   * 节点置 terminal 后触发一次就绪扫描（依赖满足且上游开关全开的自动节点由 host 派发）。
   * triggerNodeIds = 本轮真实迁移的节点——扫描只看它们的直接下游（2026-11-04 实测修复：
   * 全图扫描会把与完成节点无关、直连 start 的就绪节点误拉起）。
   * 惰性解析：任务服务工厂在自身构造完成后才注入实现（避免工厂自引用环）。 */
  resolveAutoDispatcher?: () =>
    | ((
        scope: OrchestrationNotifyRelayScope,
        triggerNodeIds?: readonly string[],
      ) => Promise<void>)
    | undefined;
}): {
  /** 武装子任务终态→编排会话的双通道通知 relay（spawn 首条指令与下发共用）。 */
  armChildTerminalRelay: (
    scope: OrchestrationNotifyRelayScope,
    childTaskId: string,
    fallbackTitle: string | undefined,
    options?: { recoveredArmedAt?: number },
  ) => void;
  /** 废弃内存 relay（取消关联时）：订阅停、pending 行由调用方清理。 */
  disposeChildRelay: (scope: OrchestrationNotifyRelayScope, childTaskId: string) => void;
  /** 构造并投递一次终态通知（恢复扫描补投共用）；机制见 orchestrationNotifyDelivery.ts。 */
  deliverChildTerminalNotice: (
    scope: OrchestrationNotifyRelayScope,
    childTaskId: string,
    fallbackTitle: string | undefined,
    outcome: "succeeded" | "failed",
    failureError?: string,
  ) => Promise<void>;
  /**
   * host 启动恢复扫描（spec: orchestration-tasks.md）：遍历持久化的通知意图行——
   * 墓碑清行、终态晚于水位线补投、其余按原水位线重新武装 relay。
   * 不抛错（逐行兜底），可安全 fire-and-forget 调用。
   */
  recoverPendingChildNotifications: () => Promise<void>;
} {
  const {
    taskService,
    taskIndexRepo,
    zcodeAgentService,
    resolveOrchestrationPlanService,
    resolveAutoDispatcher,
  } =
    options;
  // 终态回流 relay 的每子任务去重：同一子任务再次下发指令时废弃旧 relay（dispose），
  // 避免一次终态触发多条重复通知。key = workspaceKey:childTaskId。
  const childTerminalRelays = new Map<string, () => void>();

  function disposeChildRelay(scope: OrchestrationNotifyRelayScope, childTaskId: string): void {
    childTerminalRelays.get(buildChildRelayKey(scope, childTaskId))?.();
  }

  /**
   * 武装子任务终态→编排会话的双通道通知 relay（spec 事件顺序）：
   * 1) onDynamicTaskTerminalOutcome 订阅——长任务的常规通道；
   * 2) 短窗轮询兜底——syncer 的终态事件只在观察到 running→terminal 迁移时发射
   *    （processSummary 的 becameTerminal 要求 previous 非 undefined；draft 不进基线），
   *    秒级完成的子任务其 running 帧会被 sessions-index conflation 吞掉，终态帧
   *    到达时 previous 仍为 undefined 而不发射（联调实测命中）。轮询读 tasks-index
   *    的权威 status，30 秒窗内每 3 秒检查一次，双通道先到先发。
   */
  function armChildTerminalRelay(
    scope: OrchestrationNotifyRelayScope,
    childTaskId: string,
    fallbackTitle: string | undefined,
    options?: { recoveredArmedAt?: number },
  ): void {
    const relayKey = buildChildRelayKey(scope, childTaskId);
    // 同父重下发废弃自己同子任务的旧 relay（键含主任务 id，多编排互不影响）：
    // 本主任务只认最新一次下发的终态，别家的订阅不受牵连。
    childTerminalRelays.get(relayKey)?.();
    // 武装时刻 = 已处理终态的水位线（持久化在 pending 行上）：
    // - 恢复场景沿用持久化值，重启前已投递/陈旧的终态不会重复通知；
    // - 新下发取当前时刻——tasks-index 里的上一轮陈旧终态（新 running 帧尚未落库）
    //   不会被轮询兜底误报（实测：子任务 09:47:23 收指令、09:47:26 误发通知、
    //   09:48:51 才真正完成）。只接受 updatedAt 晚于武装时刻的终态。
    const armedAt = options?.recoveredArmedAt ?? Date.now();
    // pending 行的 orchestration scope 快照：武装与送达清理两处共用。
    const pendingRowScope = () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      taskId: scope.orchestrationTaskId,
    });
    // 通知意图持久化（spec: orchestration-tasks.md）：app 重启后由恢复扫描接管，
    // busy/冷会话投递失败也不丢。
    void taskIndexRepo
      .upsertOrchestrationPendingNotify({
        orchestration: pendingRowScope(),
        childTaskId,
        armedAt,
      })
      .catch((error: unknown) => {
        logger.warn("Failed to persist orchestration pending notify", {
          childTaskId,
          event: "orchestration.pending_notify.persist_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          orchestrationTaskId: scope.orchestrationTaskId,
        });
      });
    // 一轮一报闩（spec: orchestration-tasks.md）：订阅与轮询是同一终态的两个观察面，
    // 首个终态被任一通道捕获即闩住，另一通道随后的触发忽略并停掉。此前这里是
    // "投递中排队、投递完补发"——订阅先投递，投递期间（编排会话 busy 退避可达分钟级）
    // 轮询读到同一终态被排进队列，首投完成后补发同一份摘要，编排会话收到内容相同的
    // 重复回报（实测 2026-10-30 全体点名 12 个子任务重复 5 个，日志里 delivered 与
    // 第二个 received 同一毫秒）。
    let terminalCaptured = false;
    // 本 relay 是否已被废弃（同父重下发/解链）：废弃后送达不得清理新 relay 的行与 map 项。
    let superseded = false;
    let stopPolling: () => void = () => {};
    const notifyChildTerminal = async (
      outcome: "succeeded" | "failed",
      source: "subscription" | "poll",
      inputId?: string,
      failureError?: string,
    ): Promise<void> => {
      if (terminalCaptured) {
        logger.debug("Orchestration child terminal duplicate observation ignored", {
          childTaskId,
          event: "orchestration.child_terminal.duplicate_ignored",
          orchestrationTaskId: scope.orchestrationTaskId,
          source,
        });
        return;
      }
      terminalCaptured = true;
      // 捕获即停另一条通道：两条通道都只为捕获这一个终态而存在。
      subscription.dispose();
      stopPolling();
      // inputId 只进诊断日志；注入编排会话的文本面向用户，不携带内部标识。
      logger.info("Orchestration child terminal outcome received", {
        childTaskId,
        event: "orchestration.child_terminal.received",
        inputId: inputId ?? null,
        outcome,
        orchestrationTaskId: scope.orchestrationTaskId,
        source,
      });
      // 计划视图进度同步（无计划/未绑定节点时静默跳过，失败不影响通知投递）。
      // 必须等待写入完成再跑自动派发扫描（bug 修复 2026-11-04，实测竞态）：扫描若在
      // 终态落库前读计划，会把已完成的节点看成 dispatched 而空手而归，自动链路断在
      // 半路（fire-and-forget + 立即扫描的旧写法就是丢任务2的直接原因之一）。
      const marked = await resolveOrchestrationPlanService?.()
        ?.markPlanNodeTerminal({
          orchestrationTaskId: scope.orchestrationTaskId,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          childTaskId,
          outcome,
        })
        .catch((terminalError: unknown) => {
          logger.warn("Orchestration plan node terminal sync failed", {
            childTaskId,
            errorMessage:
              terminalError instanceof Error ? terminalError.message : String(terminalError),
            event: "orchestration.plan.node_terminal_sync_failed",
            orchestrationTaskId: scope.orchestrationTaskId,
          });
          return undefined;
        });
      // 自动派发就绪扫描（用户需求 2026-11-03）：节点 terminal 可能解锁下一波自动节点。
      // 只由真实迁移的节点触发并只扫它们的直接下游（2026-11-04 实测修复）：无迁移
      // （子任务没绑节点/绑定节点早已终态）就没有新的释放面，扫描纯属空转还可能误拉起
      // 与本子任务无关的就绪节点。
      const triggerNodeIds = marked?.markedNodeIds ?? [];
      const autoDispatcher = resolveAutoDispatcher?.();
      if (autoDispatcher && triggerNodeIds.length > 0) {
        void autoDispatcher(scope, triggerNodeIds).catch((autoError: unknown) => {
          logger.warn("Orchestration plan auto-dispatch after terminal failed", {
            childTaskId,
            errorMessage: autoError instanceof Error ? autoError.message : String(autoError),
            event: "orchestration.plan.auto_dispatch_after_terminal_failed",
            orchestrationTaskId: scope.orchestrationTaskId,
          });
        });
      }
      try {
        await deliverChildTerminalNotice(
          { taskIndexRepo, zcodeAgentService },
          scope,
          childTaskId,
          fallbackTitle,
          outcome,
          failureError,
        );
        // 一轮下发至多一条通知（用户确认 2026-10-21）：送达即销毁 relay 与持久行，
        // 用户后续在子任务会话里的手动多轮不再上报编排（关联任务常在非编排场景
        // 独立使用，终身上报会持续骚扰编排会话）。superseded = 本 relay 已被同父
        // 重下发/解链废弃，行与 map 归新 relay 所有，不动它们。（订阅/轮询已在捕获时停。）
        if (!superseded) {
          if (childTerminalRelays.get(relayKey) === dispose) {
            childTerminalRelays.delete(relayKey);
          }
          await taskIndexRepo
            .clearOrchestrationPendingNotify({
              orchestration: pendingRowScope(),
              childTaskId,
            })
            .catch((error: unknown) => {
              // 清行失败只让下次恢复扫描做一次冗余判断（届时终态已陈旧→重新武装），
              // 送达事实不受影响。
              logger.warn("Failed to clear orchestration pending notify after delivery", {
                childTaskId,
                event: "orchestration.pending_notify.deliver_clear_failed",
                errorMessage: error instanceof Error ? error.message : String(error),
                orchestrationTaskId: scope.orchestrationTaskId,
              });
            });
        }
      } catch (error: unknown) {
        // 投递最终失败：pending 行保留，下次启动恢复扫描补投。
        logger.warn(
          "Orchestration child terminal notification delivery failed; retained for recovery",
          {
            childTaskId,
            event: "orchestration.child_terminal_notify.failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            orchestrationTaskId: scope.orchestrationTaskId,
            workspacePath: scope.workspacePath,
          },
        );
      }
    };
    const subscription = taskService.onDynamicTaskTerminalOutcome(childTaskId)((result) => {
      // 手动停止（stopped）= 未完成 → failed/红色（用户需求 2026-11-04，实测停止后
      // 节点变绿）：非 succeeded 的一律按失败处理。
      const failed = result.outcome !== "succeeded";
      void notifyChildTerminal(
        failed ? "failed" : "succeeded",
        "subscription",
        result.inputId,
        failed ? result.error : undefined,
      );
    });
    const dispose = () => {
      superseded = true;
      subscription.dispose();
      // 废弃也要停轮询：否则 30 秒窗内轮询读到终态仍会再投一次（旧 relay 的重复源之一）。
      stopPolling();
    };
    childTerminalRelays.set(relayKey, dispose);
    logger.info("Orchestration child terminal subscription armed", {
      childTaskId,
      event: "orchestration.child_terminal_subscription.armed",
      orchestrationTaskId: scope.orchestrationTaskId,
      workspacePath: scope.workspacePath,
    });
    // 轮询兜底：可被 stopPolling 终止（捕获/废弃时），timer 句柄必须可清——此前只有
    // 一个 pollNotified 标志且订阅通道从不置它，relay 送达/废弃后 30 秒窗内的轮询照跑。
    let pollStopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    stopPolling = () => {
      pollStopped = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
    // 轮询窗口（用户需求 2026-11-05 实测修订；spec: orchestration-tasks.md 终态通知可靠性）：
    // 原 10×3s=30s 只兜得住秒级完成的子任务——订阅通道的 running→terminal 迁移帧被
    // sessions-index conflation 吞掉时（running 帧到达时 previous 仍 undefined），长任务
    // （实测 8.5 分钟）完成后无人观察：节点永远执行中、通知永不投递。改为长尾轮询：
    // 前 10 次 3s 抓秒级完成，其后每 30s 一次至约 2 小时；超长任务由重启恢复扫描兜底。
    const fastPollAttempts = 10;
    const fastPollIntervalMs = 3_000;
    const slowPollIntervalMs = 30_000;
    const maxPollAttempts = 250;
    // 快照 error 需连续两次轮询命中才认定（spec 失败可见）：send ACK 到执行轮真正开始之间
    // 可能有一瞬 status 仍是上一轮的 error 而 updatedAt 已被新消息顶新，单次命中会误报。
    let snapshotErrorStreak = 0;
    const sessionTarget = {
      sessionId: childTaskId,
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    };
    /** 单次轮询；返回 true = 终态已捕获（停止轮询）。 */
    const pollOnce = async (): Promise<boolean> => {
      try {
        const meta = await taskIndexRepo.getTaskMeta({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          taskId: childTaskId,
        });
        // 新终态守卫：updatedAt 不晚于武装时刻的是上一轮的陈旧终态，继续等。
        if (
          meta &&
          (meta.status === "completed" || meta.status === "error") &&
          meta.updatedAt > armedAt
        ) {
          void notifyChildTerminal(meta.status === "error" ? "failed" : "succeeded", "poll");
          return true;
        }
      } catch {
        // tasks-index 读失败：下一轮再试。
      }
      // 补读子会话快照（spec 失败可见）：下发后首轮即崩（如模型选型失效）时既无
      // running→terminal 迁移、tasks-index 行也不更新，上面两条路都看不见——实测
      // 2026-10-30 子任务「1、需求调研」就此永远"在路上"、pending 行永久挂起。运行时
      // 快照的 session.status/updatedAt 是最直接的事实，只认武装时刻之后、且无活跃轮的 error。
      try {
        const snapshot = await zcodeAgentService.readSession({ ...sessionTarget, messageLimit: 1 });
        const erroredAfterDispatch =
          snapshot.session.status === "error" &&
          snapshot.session.updatedAt > armedAt &&
          !snapshot.runtime.activeTurnId;
        snapshotErrorStreak = erroredAfterDispatch ? snapshotErrorStreak + 1 : 0;
        logger.debug("Orchestration child terminal poll snapshot", {
          activeTurnId: snapshot.runtime.activeTurnId ?? null,
          armedAt,
          childTaskId,
          erroredAfterDispatch,
          event: "orchestration.child_terminal_poll.snapshot",
          sessionStatus: snapshot.session.status,
          sessionUpdatedAt: snapshot.session.updatedAt,
          streak: snapshotErrorStreak,
        });
        if (snapshotErrorStreak >= 2) {
          logger.info("Orchestration child failed after dispatch (session error snapshot)", {
            childTaskId,
            event: "orchestration.child_terminal_poll.session_error",
            orchestrationTaskId: scope.orchestrationTaskId,
            sessionUpdatedAt: snapshot.session.updatedAt,
          });
          void notifyChildTerminal(
            "failed",
            "poll",
            undefined,
            "子任务会话进入 error 状态（下发后的执行轮未能完成；常见于模型选型失效或供应商错误）",
          );
          return true;
        }
      } catch (error: unknown) {
        // 冷会话（runtime 已回收，如恢复扫描重新武装的旧行）读不到快照是常态，只留 debug；
        // 本分支只覆盖下发后会话仍驻留运行时的窗口（本次事故的真实路径）。
        logger.debug("Orchestration child terminal poll snapshot read failed", {
          childTaskId,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "orchestration.child_terminal_poll.snapshot_read_failed",
          orchestrationTaskId: scope.orchestrationTaskId,
        });
      }
      return false;
    };
    const schedulePoll = (attempt: number) => {
      if (pollStopped || attempt > maxPollAttempts) return;
      const delay = attempt <= fastPollAttempts ? fastPollIntervalMs : slowPollIntervalMs;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        if (pollStopped) return;
        void pollOnce().then((captured) => {
          if (!captured) schedulePoll(attempt + 1);
        });
      }, delay);
    };
    schedulePoll(1);
  }

  async function recoverPendingChildNotifications(): Promise<void> {
    let rows;
    try {
      rows = await taskIndexRepo.listOrchestrationPendingNotifies();
    } catch (error: unknown) {
      logger.error("Failed to list orchestration pending notifies for recovery", {
        event: "orchestration.pending_notify.recovery_list_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (rows.length === 0) return;
    logger.info("Recovering orchestration pending notifications", {
      count: rows.length,
      event: "orchestration.pending_notify.recovery_start",
    });
    for (const row of rows) {
      const scope: OrchestrationNotifyRelayScope = {
        orchestrationTaskId: row.orchestration.taskId,
        workspacePath: row.orchestration.workspacePath,
        ...(row.orchestration.workspaceIdentity
          ? { workspaceIdentity: row.orchestration.workspaceIdentity }
          : {}),
      };
      try {
        const link = await taskIndexRepo.getOrchestrationLink({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          orchestrationTaskId: scope.orchestrationTaskId,
          childTaskId: row.childTaskId,
        });
        // 关系已墓碑/不存在：终态不再通知（spec），清行防反复扫描。
        if (!link || link.unlinkedAt != null) {
          await taskIndexRepo.clearOrchestrationPendingNotify({
            orchestration: row.orchestration,
            childTaskId: row.childTaskId,
          });
          continue;
        }
        const childMeta = await taskIndexRepo
          .getTaskMeta({
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            taskId: row.childTaskId,
          })
          .catch(() => null);
        // tasks 行暂不可读（启动竞态）：保留行，下次启动再试，不做错误推断。
        if (!childMeta) continue;
        // 节点终态回写（用户需求 2026-11-05 修复"节点卡执行中"）：恢复路径此前只补投
        // 通知、不调 markPlanNodeTerminal——节点永远 dispatched（画布假执行中）。两分支
        // 都先回写节点终态，再用 markedNodeIds 触发一次就绪扫描（链式推进与 relay
        // 常规路径同一触发，下一波自动节点照常解锁）。
        const reconcilePlanNode = async (outcome: "succeeded" | "failed") => {
          const marked = await resolveOrchestrationPlanService?.()?.markPlanNodeTerminal({
            orchestrationTaskId: scope.orchestrationTaskId,
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            childTaskId: row.childTaskId,
            outcome,
          });
          const triggerNodeIds = marked?.markedNodeIds ?? [];
          const autoDispatcher = resolveAutoDispatcher?.();
          if (triggerNodeIds.length > 0 && autoDispatcher) {
            void autoDispatcher(scope, triggerNodeIds).catch((error: unknown) => {
              logger.warn("Orchestration auto-dispatch after recovery failed", {
                childTaskId: row.childTaskId,
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "orchestration.pending_notify.auto_dispatch_failed",
                orchestrationTaskId: scope.orchestrationTaskId,
              });
            });
          }
        };
        if (
          (childMeta.status === "completed" || childMeta.status === "error") &&
          childMeta.updatedAt > row.armedAt
        ) {
          // 停机期间到达的新鲜终态（晚于武装时刻 = 下发轮已完成）：回写节点 + 补投 +
          // 清行——一轮下发至多一条通知，手动轮不续报。
          const outcome = childMeta.status === "error" ? ("failed" as const) : ("succeeded" as const);
          await reconcilePlanNode(outcome);
          await deliverChildTerminalNotice(
            { taskIndexRepo, zcodeAgentService },
            scope,
            row.childTaskId,
            childMeta.title,
            outcome,
          );
          await taskIndexRepo.clearOrchestrationPendingNotify({
            orchestration: row.orchestration,
            childTaskId: row.childTaskId,
          });
          logger.info("Recovered orchestration child terminal notification", {
            childTaskId: row.childTaskId,
            event: "orchestration.pending_notify.recovered",
            orchestrationTaskId: scope.orchestrationTaskId,
          });
        } else {
          // 死轮确定性判定（用户需求 2026-11-05 实测：aggregate 卡执行中的死法）：恢复
          // 扫描只在 host 启动时运行，重启后上一进程的子任务运行时必然全部死亡——tasks
          // 行非新鲜终态的 pending 轮次都是被中断的，按 failed 回写 + 补投 + 清行。
          // 不再用 readSession 探测判活：冷会话从持久层可读成功，误判"还活着"会让 relay
          // 重新武装后按固定窗口轮询死会话（窗口过后永久失明）。
          await reconcilePlanNode("failed");
          await deliverChildTerminalNotice(
            { taskIndexRepo, zcodeAgentService },
            scope,
            row.childTaskId,
            childMeta.title,
            "failed",
            "host 重启中断了子任务运行时，本轮未能完成；请在计划节点上重新执行",
          );
          await taskIndexRepo.clearOrchestrationPendingNotify({
            orchestration: row.orchestration,
            childTaskId: row.childTaskId,
          });
          logger.info("Recovered orchestration child lost with runtime (interrupted)", {
            childTaskId: row.childTaskId,
            event: "orchestration.pending_notify.recovered_interrupted",
            orchestrationTaskId: scope.orchestrationTaskId,
          });
        }
      } catch (error: unknown) {
        // 补投失败（含冷会话 resume 后仍不可达）：行保留，下次启动重试。
        logger.warn("Orchestration pending notify recovery failed for row", {
          childTaskId: row.childTaskId,
          event: "orchestration.pending_notify.recovery_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          orchestrationTaskId: scope.orchestrationTaskId,
        });
      }
      // 补投限速：多条积压时不瞬间打满编排会话（每条都会触发一轮模型生成）。
      await sleep(500);
    }
  }

  const deliverNotice = (
    scope: OrchestrationNotifyRelayScope,
    childTaskId: string,
    fallbackTitle: string | undefined,
    outcome: "succeeded" | "failed",
    failureError?: string,
  ) =>
    deliverChildTerminalNotice(
      { taskIndexRepo, zcodeAgentService },
      scope,
      childTaskId,
      fallbackTitle,
      outcome,
      failureError,
    );

  return {
    armChildTerminalRelay,
    disposeChildRelay,
    deliverChildTerminalNotice: deliverNotice,
    recoverPendingChildNotifications,
  };
}
