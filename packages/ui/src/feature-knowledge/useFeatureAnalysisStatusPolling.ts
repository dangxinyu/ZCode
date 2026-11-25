// 分析状态页级轮询（与当前 tab 无关）：行级轮询会因切 tab 卸载停摆、状态卡 unknown。
// 真相源用 tasks-index（listTasks）：runtime 空闲释放后 readSession/listSessionSubagents 不可靠。
import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";

const POLL_INTERVAL_MS = 5000;

export function useFeatureAnalysisStatusPolling() {
  const services = useServices();
  useEffect(() => {
    const timer = setInterval(() => {
      const entries = useFeatureAnalysisStore.getState().entries.filter((e) => e.status !== "done");
      const workspaces = [...new Set(entries.map((e) => e.workspacePath))];
      for (const workspacePath of workspaces) {
        void services.zcodeTaskService
          .listTasks({ workspacePath })
          .then((metas) => {
            for (const entry of entries.filter((e) => e.workspacePath === workspacePath)) {
              const meta = metas.find((m) => m.taskId === entry.sessionId);
              const next =
                meta?.status === "completed" || meta?.status === "error"
                  ? "done"
                  : meta?.status === "running"
                    ? "running"
                    : "unknown";
              const current = useFeatureAnalysisStore
                .getState()
                .entries.find((item) => item.sessionId === entry.sessionId);
              if (current && current.status !== next) {
                useFeatureAnalysisStore.getState().setStatus(entry.sessionId, next);
              }
            }
          })
          .catch(() => undefined);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [services]);
}