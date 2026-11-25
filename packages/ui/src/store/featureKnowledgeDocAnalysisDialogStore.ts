// 文档分析 dialog 的全局开关与跨跳转状态：派发后关闭弹窗（用户落在会话里看分析），
// >20 份侦察计划落盘后由 KB 页轮询触发重开弹窗到主题勾选步。
import { create } from "zustand";
import type { FeatureDocThemePlan } from "@zcode/services";

export type DocAnalysisStep = "paths" | "docs" | "waiting" | "themes";

export interface DocAnalysisScout {
  sessionId: string;
  planPath: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface FeatureDocAnalysisDialogStoreState {
  open: boolean;
  step: DocAnalysisStep;
  scout: DocAnalysisScout | null;
  plan: FeatureDocThemePlan | null;
  setOpen: (open: boolean) => void;
  setStep: (step: DocAnalysisStep) => void;
  setScout: (scout: DocAnalysisScout | null) => void;
  setPlan: (plan: FeatureDocThemePlan | null) => void;
  reset: () => void;
}

export const useFeatureDocAnalysisDialogStore = create<FeatureDocAnalysisDialogStoreState>(
  (set) => ({
    open: false,
    step: "paths",
    scout: null,
    plan: null,
    setOpen: (open) => set({ open }),
    setStep: (step) => set({ step }),
    setScout: (scout) => set({ scout }),
    setPlan: (plan) => set({ plan }),
    reset: () => set({ open: false, step: "paths", scout: null, plan: null }),
  }),
);