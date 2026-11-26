// 文档分析 dialog 的全局开关与跨跳转状态：派发后关闭弹窗（用户落在会话里看分析）。
// 全自动（用户确认 2026-11-26：除提案确认外全自动）：侦察计划落盘由 KB 页轮询直接自动派发主题，
// 不再重开弹窗做主题勾选人闸；故步骤只剩 paths/docs，无 waiting/themes。
import { create } from "zustand";

export type DocAnalysisStep = "paths" | "docs";

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
  setOpen: (open: boolean) => void;
  setStep: (step: DocAnalysisStep) => void;
  setScout: (scout: DocAnalysisScout | null) => void;
  reset: () => void;
}

export const useFeatureDocAnalysisDialogStore = create<FeatureDocAnalysisDialogStoreState>(
  (set) => ({
    open: false,
    step: "paths",
    scout: null,
    setOpen: (open) => set({ open }),
    setStep: (step) => set({ step }),
    setScout: (scout) => set({ scout }),
    reset: () => set({ open: false, step: "paths", scout: null }),
  }),
);