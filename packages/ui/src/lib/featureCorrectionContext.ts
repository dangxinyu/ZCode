// 功能点订正隐藏上下文（spec: feature-knowledge.md 末级右键订正）。
// composer 第五类尾块 context：JSON  fenced 块无损序列化（全文/名称/锚点 round-trip 不丢字段），
// 与 webElementContext 等四类相同只识别 prompt 尾块；历史 user row 解析剥离，chip 是唯一可见面。
import type { FeatureAnchor } from "@zcode/services";

const FEATURE_CORRECTION_BLOCK_TITLE = "# Feature correction context:";

export interface FeatureCorrectionComposerAttachment {
  id: string;
  featureId: string;
  featureName: string;
  domain: string;
  aliases: string[];
  anchors: FeatureAnchor[];
  docMd: string;
  currentVersion: number;
  /** 给 agent 的订正任务说明（随隐藏上下文注入，不进输入框）。 */
  instruction?: string;
  capturedAt: number;
}

interface ParsedFeatureCorrectionPrompt {
  visibleContent: string;
  featureCorrections: FeatureCorrectionComposerAttachment[];
}

export function isFeatureCorrectionPayload(
  payload: unknown,
): payload is FeatureCorrectionComposerAttachment {
  const candidate = payload as FeatureCorrectionComposerAttachment;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.featureId === "string" &&
    candidate.featureId.length > 0 &&
    typeof candidate.featureName === "string" &&
    typeof candidate.domain === "string" &&
    Array.isArray(candidate.aliases) &&
    Array.isArray(candidate.anchors) &&
    typeof candidate.docMd === "string" &&
    typeof candidate.currentVersion === "number" &&
    (candidate.instruction === undefined || typeof candidate.instruction === "string") &&
    typeof candidate.capturedAt === "number"
  );
}

export function buildPromptWithFeatureCorrection(
  text: string,
  contexts: readonly FeatureCorrectionComposerAttachment[],
): string {
  const content = text.trimEnd();
  if (contexts.length === 0) {
    return content.trim();
  }
  // JSON 字符串内的换行被转义为 \n 字面量，块内不可能出现裸 "\n```"，fence 边界无歧义。
  const contextBlock = `${FEATURE_CORRECTION_BLOCK_TITLE}\n\n\`\`\`json\n${JSON.stringify(
    contexts,
    null,
    2,
  )}\n\`\`\``;
  return `${content}${content ? "\n\n" : ""}${contextBlock}`.trim();
}

export function parsePromptFeatureCorrection(content: string): ParsedFeatureCorrectionPrompt {
  const blockMatch =
    /(?:^|\n\n)# Feature correction context:\s*\n\n```json\n([\s\S]*?)\n```\s*$/.exec(content);
  if (!blockMatch || blockMatch.index < 0 || blockMatch[1] === undefined) {
    return { visibleContent: content, featureCorrections: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blockMatch[1]);
  } catch {
    return { visibleContent: content, featureCorrections: [] };
  }
  const featureCorrections = Array.isArray(parsed)
    ? parsed.filter(isFeatureCorrectionPayload)
    : [];
  if (featureCorrections.length === 0) {
    return { visibleContent: content, featureCorrections: [] };
  }
  return {
    visibleContent: content.slice(0, blockMatch.index).trimEnd(),
    featureCorrections,
  };
}