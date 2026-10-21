// 编排通知/候选摘要的有界摘录（spec: packages/services/specs/orchestration-tasks.md）。
// 独立叶子模块：通知 relay（终态通知附最终回复摘要）与 workspace 查询
// （link 候选附最近回复摘要）共用，避免两方互相依赖。

import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";

const logger = createServiceLogger("zcode-orchestration");

/** 最终回复摘要的长度上限：要容纳一段完整交付说明（结论+关键改动+未尽事项），
 * 让主任务凭通知即可转述、不必回读子会话（400 字时实测不够，主任务仍会 ReadSessionContext）。 */
export const FINAL_REPLY_EXCERPT_MAX_CHARS = 1500;

/** listWorkspaceTasks 候选摘要的更紧上限：列表信号，不是搬运内容。 */
export const WORKSPACE_TASK_EXCERPT_MAX_CHARS = 120;

/** 会话最近一条 assistant 回复的有界摘要（spec: orchestration-tasks.md）。
 * 取尾部窗口内最后一条 assistant 消息的文本 part：收尾回复本身就是交付概括。
 * 冷会话（runtime 已卸载，requireSession 只认活跃会话）读不到时返回 null。
 */
export async function readLatestAssistantReplyExcerpt(
  agentService: Pick<IZCodeAgentService, "readSessionMessages">,
  params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
  maxChars: number,
): Promise<string | null> {
  try {
    const messages = await agentService.readSessionMessages({
      sessionId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      limit: 5,
    });
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.info.role !== "assistant") continue;
      const text = message.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    }
    return null;
  } catch (error) {
    logger.info("Latest assistant reply excerpt unavailable", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "orchestration.child_excerpt.unavailable",
      taskId: params.taskId,
      workspacePath: params.workspacePath,
    });
    return null;
  }
}
