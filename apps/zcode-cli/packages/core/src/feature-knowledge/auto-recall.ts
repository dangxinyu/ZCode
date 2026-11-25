// 开工自动召回（spec: feature-knowledge.md 检索分层 / 主动调用机制 1+2，用户确认 2026-11-25）。
// 每轮用户输入提交时以本轮问题检索知识库，把 top-k 摘要+锚点作为当轮 reminder 注入，
// 模型忘不忘都看得到相关功能点；全文不注入，按需 ReadFeatureDoc，控制上下文膨胀。
import type { FeatureKnowledgePort, SearchFeaturesOutput } from "@zcode/contracts";
import { wrapSystemReminderForSource } from "../system-reminder/source.js";

export const AUTO_RECALL_TOP_K = 3;
export const AUTO_RECALL_QUERY_MAX_CHARS = 400;
const AUTO_RECALL_ANCHOR_PATHS_MAX = 4;
const AUTO_RECALL_BODY_MAX_CHARS = 4000;

const SKIPPED_TASK_TYPES = new Set(["subagent_child", "workflow_child"]);

/** 子代理/工作流 actor 自带任务指令，不重复注入；空输入与 slash 命令不检索。 */
export function shouldAutoRecallFeatureKnowledge(
  taskType: string | undefined,
  input: string,
): boolean {
  if (taskType && SKIPPED_TASK_TYPES.has(taskType)) return false;
  const text = input.trim();
  if (!text || text.startsWith("/")) return false;
  return true;
}

export function buildFeatureKnowledgeRecallReminder(
  hits: SearchFeaturesOutput["hits"],
): string | null {
  const top = hits.slice(0, AUTO_RECALL_TOP_K);
  if (top.length === 0) return null;
  const lines = top.map((hit) => {
    const paths = hit.feature.anchors
      .flatMap((anchor) => anchor.paths)
      .slice(0, AUTO_RECALL_ANCHOR_PATHS_MAX);
    const anchorText = paths.length > 0 ? `；代码锚点：${paths.join("、")}` : "";
    return `- 「${hit.feature.name}」（${hit.feature.domain || "未分域"}，id=${hit.feature.id}，v${hit.feature.currentVersion}）命中层：${hit.layers.join("/")}${anchorText}`;
  });
  const body = [
    "功能点知识库自动召回：以下功能点可能与本轮问题相关。",
    ...lines,
    "分析或改动前先 ReadFeatureDoc 读相关功能点的当前活文档作底稿；若以上都不相关，忽略本提醒并自行 SearchFeatures 换词（别名/业务黑话/代码路径）检索。",
  ].join("\n");
  return wrapSystemReminderForSource(
    "feature_knowledge_recall",
    body.length > AUTO_RECALL_BODY_MAX_CHARS
      ? `${body.slice(0, AUTO_RECALL_BODY_MAX_CHARS)}…（召回摘要截断）`
      : body,
  );
}

export interface AutoRecallRuntimeTarget {
  sessionId: string;
  featureKnowledgePort?: FeatureKnowledgePort;
  messageHistory: { addAttachment(source: "feature_knowledge_recall", content: string): void };
}

/** 检索失败不阻断本轮对话：召回是增益上下文，不是前置条件。 */
export async function injectFeatureKnowledgeRecall(
  runtime: AutoRecallRuntimeTarget,
  taskType: string | undefined,
  input: string,
): Promise<boolean> {
  if (!runtime.featureKnowledgePort) return false;
  if (!shouldAutoRecallFeatureKnowledge(taskType, input)) return false;
  try {
    const result = await runtime.featureKnowledgePort.searchFeatures(
      { query: input.trim().slice(0, AUTO_RECALL_QUERY_MAX_CHARS) },
      { sessionId: runtime.sessionId },
    );
    const reminder = buildFeatureKnowledgeRecallReminder(result.hits);
    if (!reminder) return false;
    runtime.messageHistory.addAttachment("feature_knowledge_recall", reminder);
    return true;
  } catch {
    return false;
  }
}