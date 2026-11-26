// 功能点订正隐藏上下文的 per-scope 唯一所有者（spec: feature-knowledge.md 末级右键订正）。
// 订正入口在 composer 挂载前写入（startFeatureCorrection 建会话后先写 store 再跳转），
// 故不能用组件局部 state（webElement 同款 hook 是挂载后事件写入）；这里按
// workspaceKey+scopeId 键控，composer 经 useFeatureCorrectionContexts 读取，发送成功后清除。
import { create } from "zustand";
import type { FeatureCorrectionComposerAttachment } from "@/lib/featureCorrectionContext.js";

export function getFeatureCorrectionScopeKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}\0${scopeId}`;
}

interface FeatureCorrectionContextStoreState {
  contextsByScope: Record<string, readonly FeatureCorrectionComposerAttachment[]>;
  setContexts: (
    scopeKey: string,
    contexts: readonly FeatureCorrectionComposerAttachment[],
  ) => void;
  removeContext: (scopeKey: string, id: string) => void;
  clearContexts: (scopeKey: string) => void;
}

export const useFeatureCorrectionContextStore = create<FeatureCorrectionContextStoreState>(
  (set) => ({
    contextsByScope: {},
    setContexts: (scopeKey, contexts) =>
      set((state) => ({
        contextsByScope:
          contexts.length === 0
            ? omitScope(state.contextsByScope, scopeKey)
            : { ...state.contextsByScope, [scopeKey]: contexts },
      })),
    removeContext: (scopeKey, id) =>
      set((state) => {
        const current = state.contextsByScope[scopeKey];
        if (!current) return state;
        const next = current.filter((item) => item.id !== id);
        return {
          contextsByScope:
            next.length === 0
              ? omitScope(state.contextsByScope, scopeKey)
              : { ...state.contextsByScope, [scopeKey]: next },
        };
      }),
    clearContexts: (scopeKey) =>
      set((state) => ({ contextsByScope: omitScope(state.contextsByScope, scopeKey) })),
  }),
);

function omitScope(
  contextsByScope: Record<string, readonly FeatureCorrectionComposerAttachment[]>,
  scopeKey: string,
): Record<string, readonly FeatureCorrectionComposerAttachment[]> {
  if (!(scopeKey in contextsByScope)) return contextsByScope;
  const next = { ...contextsByScope };
  delete next[scopeKey];
  return next;
}