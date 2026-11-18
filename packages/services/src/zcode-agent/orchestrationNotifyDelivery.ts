// 终态通知的投递机制（spec: packages/services/specs/orchestration-tasks.md）。
// 从 orchestrationNotifyRelay 拆出：构造【编排通知】正文 + 健壮投递（busy 退避重试、
// 冷会话 resume），relay 只负责生命周期（武装/轮询/恢复扫描）。
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import type { ModelSelection } from "@zcode/shared";
import { prepareChildSessionForDispatch } from "./orchestrationColdResume.js";
import {
  FINAL_REPLY_EXCERPT_MAX_CHARS,
  readLatestAssistantReplyExcerpt,
} from "./orchestrationExcerpt.js";

const logger = createServiceLogger("zcode-orchestration");

export interface OrchestrationNotifyScope {
  orchestrationTaskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 通知投递的 busy 重试间隔与总窗口：编排会话正执行时的拒绝是瞬态排队，不是错误。 */
const NOTIFY_BUSY_RETRY_DELAY_MS = 5_000;
const NOTIFY_DELIVERY_WINDOW_MS = 10 * 60_000;
const NOTIFY_COLD_RESUME_MAX = 3;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyRejection(message: string): boolean {
  return /already running|prompt.*running|-32010/i.test(message);
}

function isColdSessionRejection(message: string): boolean {
  return /not active|sessionnotfound|unavailable/i.test(message);
}

/**
 * 构造并投递一次子任务终态通知（【编排通知】）：正文含 tasks-index 最新标题与
 * 最终回复的有界摘要，投递经 deliverOrchestrationNotification 的重试通道。
 */
export async function deliverChildTerminalNotice(
  deps: {
    taskIndexRepo: TaskIndexRepo;
    zcodeAgentService: Pick<
      IZCodeAgentService,
      "sendPrompt" | "readSessionMessages" | "resumeSession" | "readSession" | "setModel"
    >;
  },
  scope: OrchestrationNotifyScope,
  childTaskId: string,
  fallbackTitle: string | undefined,
  outcome: "succeeded" | "failed",
  failureError?: string,
): Promise<void> {
  // 通知时读 tasks-index 最新标题：spawn 后 renameTask 已把专名落库（titleOverridden
  // 防 snapshot 冲掉）；读不到再退下发时的兜底称呼，最终兜底通用称呼，绝不展示 id。
  const [meta, finalReplyExcerpt] = await Promise.all([
    deps.taskIndexRepo
      .getTaskMeta({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        taskId: childTaskId,
      })
      .catch(() => null),
    readLatestAssistantReplyExcerpt(
      deps.zcodeAgentService,
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
  await deliverOrchestrationNotification(deps, scope, content);
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
export async function deliverOrchestrationNotification(
  deps: {
    taskIndexRepo: TaskIndexRepo;
    zcodeAgentService: Pick<
      IZCodeAgentService,
      "sendPrompt" | "readSessionMessages" | "resumeSession" | "readSession" | "setModel"
    >;
  },
  scope: OrchestrationNotifyScope,
  content: string,
): Promise<void> {
  const deadline = Date.now() + NOTIFY_DELIVERY_WINDOW_MS;
  let coldResumes = 0;
  let transientRetries = 0;
  // 投递前先过模型保障（探测/冷恢复/补选型）并取生效选型，**显式随通知携带**
  // （用户需求 2026-11-04，二次实测）：后台轮次不依赖会话级设置的隐性传递——活跃但
  // 无生效模型的会话，transport 层 send 成功、turn 却在 model_creation 被
  // "Select a model before continuing" 打死。
  let modelSelection = await resumeOrchestratorSession(deps, scope);
  for (;;) {
    try {
      await deps.zcodeAgentService.sendPrompt({
        sessionId: scope.orchestrationTaskId,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        content,
        clientMode: "desktop-continuous",
        ...(modelSelection ? { modelSelection } : {}),
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
        modelSelection = await resumeOrchestratorSession(deps, scope);
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

async function resumeOrchestratorSession(
  deps: {
    taskIndexRepo: TaskIndexRepo;
    zcodeAgentService: Pick<
      IZCodeAgentService,
      "sendPrompt" | "readSessionMessages" | "resumeSession" | "readSession" | "setModel"
    >;
  },
  scope: OrchestrationNotifyScope,
): Promise<ModelSelection | null> {
  const parentMeta = await deps.taskIndexRepo
    .getTaskMeta({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      taskId: scope.orchestrationTaskId,
    })
    .catch(() => null);
  // 编排任务自身也可能是旧数据（旧 provider 身份 / `$档位` 混进 modelId），冷恢复与
  // 子会话同款保障（bug 修复 2026-11-04，实测"Select a model before continuing"）：
  // dev 环境反复重启回收 runtime 后，编排会话冷恢复只带 resume 提示不够——选型没生效
  // 时注入的通知被运行时闸门拒绝并直接显示在用户对话里。统一走
  // prepareChildSessionForDispatch：探测/冷恢复 + 快照校验 + 显式 setModel（归一 +
  // 任务自身选型兜底 + 首个未禁用项）。
  return prepareChildSessionForDispatch(
    { taskIndexRepo: deps.taskIndexRepo, zcodeAgentService: deps.zcodeAgentService },
    {
      orchestrationTaskId: scope.orchestrationTaskId,
      childTaskId: scope.orchestrationTaskId,
      childTaskName: "编排会话",
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      childMeta: parentMeta,
    },
  );
}
