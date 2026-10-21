// 子任务终态通知 relay（spec: packages/services/specs/orchestration-tasks.md）。
// 从 orchestrationTaskService 拆出：通知是"持久意图 + 健壮投递 + 启动恢复"的
// 独立机制，与 spawn/link 的关系写入职责分开，避免服务文件继续膨胀。
// 可靠性语义（实测丢失驱动）：armed_at 是已处理终态的水位线，持久化在
// tasks-index orchestration_pending_notifies 行上——app 重启后由恢复扫描接管
// （长周期编排 11 个子任务零通知），busy 拒绝退避重试（并行子任务 15 个丢 2 个），
// 订阅不随单次终态销毁（失败后用户重跑完成时主任务毫不知情）。

import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import {
  FINAL_REPLY_EXCERPT_MAX_CHARS,
  readLatestAssistantReplyExcerpt,
} from "./orchestrationExcerpt.js";

const logger = createServiceLogger("zcode-orchestration");

export interface OrchestrationNotifyRelayScope {
  orchestrationTaskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 通知投递的 busy 重试间隔与总窗口：编排会话正执行时的拒绝是瞬态排队，不是错误。 */
const NOTIFY_BUSY_RETRY_DELAY_MS = 5_000;
const NOTIFY_DELIVERY_WINDOW_MS = 10 * 60_000;
const NOTIFY_COLD_RESUME_MAX = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyRejection(message: string): boolean {
  return /already running|prompt.*running|-32010/i.test(message);
}

function isColdSessionRejection(message: string): boolean {
  return /not active|sessionnotfound|unavailable/i.test(message);
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
   * resumeSession 用于冷编排会话（runtime 回收）投递前的物化恢复。
   */
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "sendPrompt" | "readSessionMessages" | "resumeSession"
  >;
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
  /** 构造并投递一次终态通知（恢复扫描补投共用）。 */
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
  const { taskService, taskIndexRepo, zcodeAgentService } = options;
  // 终态回流 relay 的每子任务去重：同一子任务再次下发指令时废弃旧 relay（dispose），
  // 避免一次终态触发多条重复通知。key = workspaceKey:childTaskId。
  const childTerminalRelays = new Map<string, () => void>();

  /**
   * 构造并投递一次子任务终态通知（【编排通知】）：正文含 tasks-index 最新标题与
   * 最终回复的有界摘要，投递经 deliverOrchestrationNotification 的重试通道。
   */
  async function deliverChildTerminalNotice(
    scope: OrchestrationNotifyRelayScope,
    childTaskId: string,
    fallbackTitle: string | undefined,
    outcome: "succeeded" | "failed",
    failureError?: string,
  ): Promise<void> {
    // 通知时读 tasks-index 最新标题：spawn 后 renameTask 已把专名落库（titleOverridden
    // 防 snapshot 冲掉）；读不到再退下发时的兜底称呼，最终兜底通用称呼，绝不展示 id。
    const [meta, finalReplyExcerpt] = await Promise.all([
      taskIndexRepo
        .getTaskMeta({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          taskId: childTaskId,
        })
        .catch(() => null),
      readLatestAssistantReplyExcerpt(
        zcodeAgentService,
        {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          taskId: childTaskId,
        },
        FINAL_REPLY_EXCERPT_MAX_CHARS,
      ),
    ]);
    const childName = meta?.title?.trim() || fallbackTitle?.trim() || "子任务";
    // 摘要已附最终回复时引导"不必再读"，阻断编排 agent 每次通知都 ReadSessionContext
    // 全量拉子会话的资源浪费；摘要缺失才保留读取路径。
    const content =
      `【编排通知】子任务「${childName}」已${outcome === "failed" ? "失败" : "完成"}。\n` +
      (outcome === "failed" && failureError?.trim()
        ? `错误摘要：${failureError.trim().slice(0, 300)}\n`
        : "") +
      (finalReplyExcerpt
        ? `最终回复摘要：${finalReplyExcerpt}\n` +
          "向用户转述上述内容即可（概括为两三句），不要转述全文；摘要已含结论与关键改动，" +
          "不要回读该子任务的会话——只有用户明确追问摘要之外的细节时才用 ReadSessionContext。"
        : "需要其产出细节时：先用 ListOrchestrationChildren 查该子任务的 taskId，" +
          "再以该 taskId 作为 sessionId 调用 ReadSessionContext 读取；汇报时概括即可，不要转述全文。");
    await deliverOrchestrationNotification(scope, content);
    logger.info("Orchestration child terminal notification delivered", {
      childTaskId,
      event: "orchestration.child_terminal_notify.delivered",
      excerptChars: finalReplyExcerpt?.length ?? 0,
      orchestrationTaskId: scope.orchestrationTaskId,
    });
  }

  /**
   * 终态通知的健壮投递：并行子任务几乎同时完成时，第二条通知会撞上编排会话
   * 正在处理第一条的 busy 窗口（v1 session/send 拒绝 "A prompt is already running"，
   * 实测 15 个子任务丢 2 个）；编排会话冷（runtime 回收）时 sendPrompt 直接
   * sessionNotFound。busy 退避重试到总窗口上限，冷会话先 resumeSession（带
   * tasks-index 最后使用的 provider/model 兜底，防裸 resume 后模型闸门拒绝）再重试。
   * 最终失败抛出——调用方保留 pending 行，下次启动恢复扫描补投。
   */
  async function deliverOrchestrationNotification(
    scope: OrchestrationNotifyRelayScope,
    content: string,
  ): Promise<void> {
    const deadline = Date.now() + NOTIFY_DELIVERY_WINDOW_MS;
    let coldResumes = 0;
    let transientRetries = 0;
    for (;;) {
      try {
        await zcodeAgentService.sendPrompt({
          sessionId: scope.orchestrationTaskId,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          content,
          clientMode: "desktop-continuous",
        });
        return;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (Date.now() >= deadline) throw error;
        if (isBusyRejection(message)) {
          await sleep(NOTIFY_BUSY_RETRY_DELAY_MS);
          continue;
        }
        if (isColdSessionRejection(message) && coldResumes < NOTIFY_COLD_RESUME_MAX) {
          coldResumes += 1;
          await resumeOrchestratorSession(scope);
          continue;
        }
        if (++transientRetries <= 2) {
          await sleep(NOTIFY_BUSY_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  }

  async function resumeOrchestratorSession(scope: OrchestrationNotifyRelayScope): Promise<void> {
    const parentMeta = await taskIndexRepo
      .getTaskMeta({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        taskId: scope.orchestrationTaskId,
      })
      .catch(() => null);
    await zcodeAgentService.resumeSession({
      sessionId: scope.orchestrationTaskId,
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(parentMeta?.provider && parentMeta?.model
        ? {
            model: { providerId: parentMeta.provider, modelId: parentMeta.model },
            ...(parentMeta.thoughtLevel ? { thoughtLevel: parentMeta.thoughtLevel } : {}),
          }
        : {}),
    });
  }

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
    // 通知意图持久化（spec: orchestration-tasks.md）：app 重启后由恢复扫描接管，
    // busy/冷会话投递失败也不丢。
    void taskIndexRepo
      .upsertOrchestrationPendingNotify({
        orchestration: {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          taskId: scope.orchestrationTaskId,
        },
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
    // 投递中的终态去重 + 后到终态合并：长投递（busy 重试可达分钟级）期间到来的
    // 新终态排队为最新一条，投递完成后补发，不丢也不并发双发。
    let delivering = false;
    let queuedOutcome: { outcome: "succeeded" | "failed"; failureError?: string } | null = null;
    const notifyChildTerminal = async (
      outcome: "succeeded" | "failed",
      inputId?: string,
      failureError?: string,
    ): Promise<void> => {
      if (delivering) {
        queuedOutcome = { outcome, failureError };
        return;
      }
      delivering = true;
      // inputId 只进诊断日志；注入编排会话的文本面向用户，不携带内部标识。
      logger.info("Orchestration child terminal outcome received", {
        childTaskId,
        event: "orchestration.child_terminal.received",
        inputId: inputId ?? null,
        outcome,
        orchestrationTaskId: scope.orchestrationTaskId,
      });
      try {
        await deliverChildTerminalNotice(scope, childTaskId, fallbackTitle, outcome, failureError);
        // 水位线推进到本次投递时刻：下次重启恢复不会重复投递同一条终态。
        // relay 不随单次终态销毁——spec 要求"任一终态（含用户手动多轮的终态）
        // 都通知"，订阅继续等下一次终态（实测丢失场景：失败通知送达后用户重跑
        // 子任务，完成时主任务毫不知情）。
        void taskIndexRepo
          .upsertOrchestrationPendingNotify({
            orchestration: {
              workspacePath: scope.workspacePath,
              ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
              taskId: scope.orchestrationTaskId,
            },
            childTaskId,
            armedAt: Date.now(),
          })
          .catch(() => {
            // 水位线推进失败只影响下次恢复的重复投递风险，不影响本次已送达的事实。
          });
      } catch (error: unknown) {
        // 投递最终失败：pending 行保留（armed_at 未推进），下次启动恢复扫描补投。
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
      } finally {
        delivering = false;
        const queued = queuedOutcome;
        queuedOutcome = null;
        if (queued) {
          void notifyChildTerminal(queued.outcome, undefined, queued.failureError);
        }
      }
    };
    const subscription = taskService.onDynamicTaskTerminalOutcome(childTaskId)((result) => {
      void notifyChildTerminal(
        result.outcome === "failed" ? "failed" : "succeeded",
        result.inputId,
        result.outcome === "failed" ? result.error : undefined,
      );
    });
    const dispose = () => {
      subscription.dispose();
    };
    childTerminalRelays.set(relayKey, dispose);
    logger.info("Orchestration child terminal subscription armed", {
      childTaskId,
      event: "orchestration.child_terminal_subscription.armed",
      orchestrationTaskId: scope.orchestrationTaskId,
      workspacePath: scope.workspacePath,
    });
    let pollNotified = false;
    const pollAttempts = 10;
    const pollIntervalMs = 3_000;
    const pollTerminal = (attempt: number) => {
      if (pollNotified || attempt > pollAttempts) return;
      setTimeout(() => {
        if (pollNotified) return;
        void taskIndexRepo
          .getTaskMeta({
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            taskId: childTaskId,
          })
          .then((meta) => {
            if (pollNotified || !meta) {
              pollTerminal(attempt + 1);
              return;
            }
            if (meta.status === "completed" || meta.status === "error") {
              // 新终态守卫：updatedAt 不晚于武装时刻的是上一轮的陈旧终态，继续等。
              if (meta.updatedAt <= armedAt) {
                pollTerminal(attempt + 1);
                return;
              }
              pollNotified = true;
              void notifyChildTerminal(meta.status === "error" ? "failed" : "succeeded");
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
        if (
          (childMeta.status === "completed" || childMeta.status === "error") &&
          childMeta.updatedAt > row.armedAt
        ) {
          // 停机期间到达的终态（晚于水位线）：直接补投，成功后推进水位线。
          await deliverChildTerminalNotice(
            scope,
            row.childTaskId,
            childMeta.title,
            childMeta.status === "error" ? "failed" : "succeeded",
          );
          await taskIndexRepo.upsertOrchestrationPendingNotify({
            orchestration: row.orchestration,
            childTaskId: row.childTaskId,
            armedAt: Date.now(),
          });
          logger.info("Recovered orchestration child terminal notification", {
            childTaskId: row.childTaskId,
            event: "orchestration.pending_notify.recovered",
            orchestrationTaskId: scope.orchestrationTaskId,
          });
        } else {
          // 未终态，或终态早于水位线（已投递过的陈旧终态）：按原水位线重新武装，
          // 等待下一次终态（含用户停机期间手动多轮后的后续执行）。
          armChildTerminalRelay(scope, row.childTaskId, childMeta.title, {
            recoveredArmedAt: row.armedAt,
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

  return {
    armChildTerminalRelay,
    disposeChildRelay,
    deliverChildTerminalNotice,
    recoverPendingChildNotifications,
  };
}
