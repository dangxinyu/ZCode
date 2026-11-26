// 末级文档「订正」入口（spec: packages/services/specs/feature-knowledge.md 末级右键订正）。
// 新建 zcode-kb 工作区会话，把功能点全文/名称/锚点等作为隐藏上下文写入该会话的 composer
// per-scope store（先写 store 再跳转，不依赖 pane 挂载时序），chip 是唯一可见面。
// **不自动发送任何指令**：等用户口述订正内容后随首条 prompt 尾块注入，提案仍走人闸。
import type { FeatureDetail, FeatureSummary } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared";
import type { useServices } from "@/hooks/useServices.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  getFeatureCorrectionScopeKey,
  useFeatureCorrectionContextStore,
} from "@/store/featureCorrectionContextStore.js";
import { logger } from "@/logger.js";
import { buildFeatureCorrectionInstruction } from "./distillInstruction.js";
import {
  FEATURE_ANALYSIS_DEFAULT_MODEL_ID,
  resolveAnalysisSubmission,
} from "./resolveAnalysisSubmission.js";

export type StartFeatureCorrectionResult =
  | { ok: true; jumped: boolean }
  | { ok: false; messageKey: string };

export interface StartFeatureCorrectionDeps {
  services: ReturnType<typeof useServices>;
  tabStore: ReturnType<typeof useTabStoreApi>;
  readFeature: (id: string) => Promise<FeatureDetail | null>;
  onJumpToSession?: (
    workspacePath: string,
    sessionId: string,
    workspaceIdentity?: string,
  ) => void;
}

export async function startFeatureCorrection(
  feature: FeatureSummary,
  deps: StartFeatureCorrectionDeps,
): Promise<StartFeatureCorrectionResult> {
  const { services } = deps;
  const kbService = services.featureKnowledgeService;
  if (!kbService) {
    return { ok: false, messageKey: "knowledge.unavailable" };
  }
  // 隐藏上下文要全文（docMd），列表 summary 不带正文，先读详情。
  let detail: FeatureDetail | null;
  try {
    detail = await deps.readFeature(feature.id);
  } catch (error) {
    logger.warn("[feature-knowledge] 订正前读取功能点失败", { error, featureId: feature.id });
    return { ok: false, messageKey: "knowledge.correctReadFailed" };
  }
  if (!detail) {
    return { ok: false, messageKey: "knowledge.correctReadFailed" };
  }
  let workspacePath: string;
  try {
    workspacePath = (await kbService.ensureDocAnalysisWorkspace()).workspacePath;
  } catch (error) {
    logger.warn("[feature-knowledge] 创建 zcode-kb 工作区失败", { error });
    return { ok: false, messageKey: "knowledge.correctFailed" };
  }
  // 模型与文档分析同款：健康 GLM-5.4 + low 档（account provider 强制 reasoningLevel）；
  // 不可用时回退全局 preferredSelection，再回退当前健康会话继承。
  let modelSelection: ModelSelection | undefined;
  try {
    const view = await services.modelSelectionService.getView();
    for (const provider of view.providers) {
      const healthy = provider.models.find(
        (m) => m.modelId === FEATURE_ANALYSIS_DEFAULT_MODEL_ID,
      );
      if (healthy) {
        modelSelection = {
          providerId: provider.providerId,
          modelId: healthy.modelId,
          options: { reasoningLevel: "low" },
        };
        break;
      }
    }
    modelSelection ??= view.preferredSelection ?? undefined;
  } catch (error) {
    logger.warn("[feature-knowledge] 订正会话读取模型视图失败，回退会话继承", { error });
  }
  if (!modelSelection) {
    const inherited = await resolveAnalysisSubmission(services, deps.tabStore, workspacePath);
    modelSelection = inherited?.modelSelection;
  }
  let sessionId: string;
  try {
    // 订正不立即发首条指令（等用户口述），故**不用 deferred**：会话立即落库，
    // 随后 renameTask 的 v4 renameSession 才有落点（deferred 未落库时 rename 只改索引、
    // pane/侧栏读的 v4 标题仍是 New session，2026-11-26 实测）。
    const created = await services.zcodeTaskService.createTask({
      workspacePath,
      mode: "yolo",
      ...(modelSelection ? { modelSelection } : {}),
    });
    sessionId = created.taskId;
  } catch (error) {
    logger.warn("[feature-knowledge] 订正会话创建失败", { error });
    return { ok: false, messageKey: "knowledge.correctFailed" };
  }
  // 空会话在首条 prompt 前 CLI v4 store 尚无记录，renameSession 会 Session not found；
  // 先 resumeSession 物化 v4 session，rename 才能落到 pane/侧栏读的 v4 标题。
  try {
    await services.zcodeAgentService.resumeSession({ sessionId, workspacePath });
  } catch (error) {
    logger.warn("[feature-knowledge] 订正会话 resume 失败", { error, sessionId });
  }
  // 会话命名「订正 · 文档名」，避免侧栏显示 New session（用户反馈 2026-11-26）。
  // pane/侧栏读 v4 session 标题，runtime 就绪有延迟，故跳转后延迟重试；rename 幂等。
  const rename = () =>
    services.zcodeTaskService
      .renameTask({ taskId: sessionId, workspacePath, title: `订正 · ${detail.feature.name}` })
      .catch((error) => {
        logger.warn("[feature-knowledge] 订正会话命名失败", { error, sessionId });
      });
  void rename();
  setTimeout(() => void rename(), 1500);
  setTimeout(() => void rename(), 4000);
  // 先写隐藏上下文再跳转：store 按 workspaceKey+scopeId 键控，composer 挂载后即读到 chip。
  // 本地 zcode-kb 工作区无远程 identity，scope key 用 workspacePath（与 composer 的
  // workspaceIdentity?.trim() || workspacePath 规则一致）。
  const scopeKey = getFeatureCorrectionScopeKey(workspacePath, undefined, sessionId);
  useFeatureCorrectionContextStore.getState().setContexts(scopeKey, [
    {
      id: crypto.randomUUID(),
      featureId: detail.feature.id,
      featureName: detail.feature.name,
      domain: detail.feature.domain,
      aliases: detail.feature.aliases,
      anchors: detail.feature.anchors,
      docMd: detail.feature.docMd,
      currentVersion: detail.feature.currentVersion,
      instruction: buildFeatureCorrectionInstruction({
        featureId: detail.feature.id,
        featureName: detail.feature.name,
      }),
      capturedAt: Date.now(),
    },
  ]);
  if (deps.onJumpToSession) {
    deps.onJumpToSession(workspacePath, sessionId);
    return { ok: true, jumped: true };
  }
  // 无跳转回调的宿主（如 Root 直挂 KB 页）：会话已建好，提示用户自行打开。
  return { ok: true, jumped: false };
}