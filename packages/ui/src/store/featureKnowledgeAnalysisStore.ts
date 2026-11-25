// 知识库「分析中」目录（spec: feature-knowledge.md，用户确认 2026-11-25：要明确知道哪个 session 在工作并可跳转）。
// 派发时登记（文档分析新会话 / 会话提炼），live 状态由列表组件经 listSessionSubagents 轮询；
// 登记经 sessionStorage 跨重载保留；live 状态由列表轮询刷新；提案事实以 host 库为准。
import { create } from "zustand";

export type FeatureAnalysisStatus = "unknown" | "running" | "done";

export interface FeatureAnalysisEntry {
  sessionId: string;
  status: FeatureAnalysisStatus;
  workspacePath: string;
  workspaceIdentity?: string;
  kind: "docs" | "distill";
  label: string;
  batchCount?: number;
  startedAt: number;
}

interface FeatureAnalysisStoreState {
  entries: FeatureAnalysisEntry[];
  record: (entry: Omit<FeatureAnalysisEntry, "status">) => void;
  setStatus: (sessionId: string, status: FeatureAnalysisStatus) => void;
  dismiss: (sessionId: string) => void;
}

const STORAGE_KEY = "zcode-feature-analysis-entries";

function readStored(): FeatureAnalysisEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FeatureAnalysisEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStored(entries: FeatureAnalysisEntry[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 隐私模式等写入失败不影响主流程
  }
}

export const useFeatureAnalysisStore = create<FeatureAnalysisStoreState>((set) => {
  // 登记跨重载保留（sessionStorage）；live 状态仍由列表轮询刷新。
  const persist = (
    updater: (state: FeatureAnalysisStoreState) => Partial<FeatureAnalysisStoreState>,
  ) =>
    set((state) => {
      const next = updater(state);
      if (next.entries) writeStored(next.entries);
      return next;
    });
  return {
    entries: readStored(),
    record: (entry) =>
      persist((state) => ({
        entries: [
          { ...entry, status: "unknown" },
          ...state.entries.filter((item) => item.sessionId !== entry.sessionId),
        ],
      })),
    setStatus: (sessionId, status) =>
      persist((state) => ({
        entries: state.entries.map((item) =>
          item.sessionId === sessionId ? { ...item, status } : item,
        ),
      })),
    dismiss: (sessionId) =>
      persist((state) => ({
        entries: state.entries.filter((item) => item.sessionId !== sessionId),
      })),
  };
});