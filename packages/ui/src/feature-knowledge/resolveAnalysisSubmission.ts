// 文档分析会话的模型选择继承（spec: feature-knowledge.md）：全局默认模型可能是鉴权失败的账号，
// 新会话继承当前健康会话的 modelSelection，建会话与发送显式携带，避免静默跑不了。
import type { useServices } from "@/hooks/useServices.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useFeatureKnowledgeDistillStore } from "@/store/featureKnowledgeDistillStore.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { logger } from "@/logger.js";
import { readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

// 知识库工作会话（文档分析 / 订正）的默认模型；account provider 强制 reasoningLevel，
// 高档变体个人套餐无 entitlement，统一 low 档（2026-11-25 日志+数据证实）。
export const FEATURE_ANALYSIS_DEFAULT_MODEL_ID = "GLM-5.4";

export async function resolveAnalysisSubmission(
  services: ReturnType<typeof useServices>,
  tabStore: ReturnType<typeof useTabStoreApi>,
  fallbackWorkspacePath: string,
): Promise<ComposerSubmissionConfig | undefined> {
  const sourceSessionId = useFeatureKnowledgeDistillStore.getState().activeSessionId;
  if (!sourceSessionId) return undefined;
  try {
    const sourceWorkspace =
      useFeatureKnowledgeDistillStore.getState().activeWorkspacePath ?? fallbackWorkspacePath;
    const source = await services.zcodeSessionService.readSession({
      sessionId: sourceSessionId,
      workspacePath: sourceWorkspace,
    });
    // 模型选择存在 composer 草稿（workspace+session scope），session settings/config 均可能为空。
    const draft = readV4ComposerDraft(sourceWorkspace, undefined, sourceSessionId);
    const selection =
      draft?.modelSelection ??
      useFeatureKnowledgeDistillStore.getState().activeModelSelection ??
      source.settings.model.current ??
      source.settings.model.lastUsed;
    if (!selection) return undefined;
    return { modelSelection: selection, mode: "build", planEnabled: false };
  } catch (error) {
    logger.warn("[feature-knowledge] 读取源会话模型失败，回退 composer 配置", { error });
    return undefined;
  }
}