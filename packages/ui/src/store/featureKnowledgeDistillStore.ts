import { create } from "zustand";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { ModelSelection } from "@zcode/shared";

/**
 * 头部「提炼」按钮与 focused SessionPane 之间的桥接（spec: feature-knowledge.md 手动提炼触发）。
 * 发送路径唯一归 SessionPane.handleDistill（持有 lease 级 dispatchSendText）；这里只登记
 * 一个命令式把手 + 禁用态投影，头部按 activeSessionId 哑渲染，不在 header 另起发送路径。
 * 按 sessionId 建桶：split/side pane 各自登记，头部只认当前活动会话，互不覆盖。
 */
export interface FeatureKnowledgeDistillController {
  disabled: boolean;
  requestDistill: () => void;
  /** 归属纠正等外部动作复用 pane 的唯一发送路径（lease 级 dispatchSendText），不另起发送通道。 */
  sendInstruction: (text: string, submission?: ComposerSubmissionConfig) => Promise<boolean>;
}

interface FeatureKnowledgeDistillStoreState {
  controllers: Record<string, FeatureKnowledgeDistillController>;
  /** 当前 focused pane 的会话：文档分析等外部动作的默认派发目标。 */
  activeSessionId: string | null;
  activeWorkspacePath: string | null;
  activeModelSelection: ModelSelection | null;
  /** 打开知识库前的活动工作会话：KB 开页时 pane 卸载，文档分析等动作需回落激活它再发送。 */
  lastWorkspaceTabId: string | null;
  rememberWorkspaceTab: (tabId: string | null) => void;
  register: (sessionId: string, controller: FeatureKnowledgeDistillController) => void;
  unregister: (sessionId: string) => void;
}

export const useFeatureKnowledgeDistillStore = create<FeatureKnowledgeDistillStoreState>(
  (set) => ({
    controllers: {},
    activeSessionId: null,
    activeWorkspacePath: null,
    activeModelSelection: null,
    lastWorkspaceTabId: null,
    rememberWorkspaceTab: (tabId) => set({ lastWorkspaceTabId: tabId }),
    register: (sessionId, controller) =>
      set((state) => ({
        controllers: { ...state.controllers, [sessionId]: controller },
      })),
    unregister: (sessionId) =>
      set((state) => {
        if (!state.controllers[sessionId]) return state;
        const { [sessionId]: _removed, ...controllers } = state.controllers;
        return { controllers };
      }),
  }),
);

// TEMP DEBUG（验证派发链后移除）
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__kbDistillStore = useFeatureKnowledgeDistillStore;
}