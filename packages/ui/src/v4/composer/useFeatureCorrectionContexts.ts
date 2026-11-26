// composer 读取订正隐藏上下文（spec: feature-knowledge.md）：真值在 per-scope store，
// 本 hook 只做键控读取与移除命令转发，不持有第二份状态（先例 useWebElementContexts 的返回面）。
import { useCallback, useMemo } from "react";
import type { FeatureCorrectionComposerAttachment } from "@/lib/featureCorrectionContext.js";
import {
  getFeatureCorrectionScopeKey,
  useFeatureCorrectionContextStore,
} from "@/store/featureCorrectionContextStore.js";

const EMPTY_CONTEXTS: readonly FeatureCorrectionComposerAttachment[] = [];

interface UseFeatureCorrectionContextsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
}

interface UseFeatureCorrectionContextsResult {
  contexts: readonly FeatureCorrectionComposerAttachment[];
  hasContexts: boolean;
  removeContext: (id: string) => void;
  clearContexts: () => void;
}

export function useFeatureCorrectionContexts({
  workspacePath,
  workspaceIdentity,
  scopeId,
}: UseFeatureCorrectionContextsOptions): UseFeatureCorrectionContextsResult {
  const scopeKey = getFeatureCorrectionScopeKey(workspacePath, workspaceIdentity, scopeId);
  const contexts = useFeatureCorrectionContextStore(
    (state) => state.contextsByScope[scopeKey] ?? EMPTY_CONTEXTS,
  );
  const removeContext = useCallback(
    (id: string) => useFeatureCorrectionContextStore.getState().removeContext(scopeKey, id),
    [scopeKey],
  );
  const clearContexts = useCallback(
    () => useFeatureCorrectionContextStore.getState().clearContexts(scopeKey),
    [scopeKey],
  );
  return useMemo(
    () => ({ contexts, hasContexts: contexts.length > 0, removeContext, clearContexts }),
    [clearContexts, contexts, removeContext],
  );
}