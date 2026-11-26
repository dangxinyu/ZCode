// 分析状态页级轮询（与当前 tab 无关）：行级轮询会因切 tab 卸载停摆、状态卡 unknown。
// 主会话 task 状态只反映主 agent 回合：派完子智能体即 completed，但各分类子智能体仍在跑，
// 故不能只看主 task（会提前进「分析完成」）。完成 = 主 task 终态 且 子智能体 running 清空。
// 子智能体 running 经 listSessionSubagents 读取：runtime 存活时可靠；空闲释放后 running=[] 即全部结束。
import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";
import { useFeatureDocAnalysisDialogStore } from "@/store/featureKnowledgeDocAnalysisDialogStore.js";

const POLL_INTERVAL_MS = 5000;

export function useFeatureAnalysisStatusPolling() {
  const services = useServices();
  useEffect(() => {
    const timer = setInterval(() => {
      // done 也参与复查：批次间隙 running=0 可能误判 done，后续子智能体 spawn 需拉回 running。
      const entries = useFeatureAnalysisStore.getState().entries;
      const workspaces = [...new Set(entries.map((e) => e.workspacePath))];
      for (const workspacePath of workspaces) {
        void services.zcodeTaskService
          .listTasks({ workspacePath })
          .then(async (metas) => {
            for (const entry of entries.filter((e) => e.workspacePath === workspacePath)) {
              const meta = metas.find((m) => m.taskId === entry.sessionId);
              const mainTerminal = meta?.status === "completed" || meta?.status === "error";
              let next: "running" | "waiting" | "done" | "unknown";
              if (meta?.status === "running") {
                next = "running";
              } else if (mainTerminal) {
                // 主回合已结束：还需全部子智能体结束才算完成；仍有 running 则留在「分析中」。
                try {
                  const sub = await services.zcodeAgentService.listSessionSubagents({
                    workspacePath,
                    ...(entry.workspaceIdentity
                      ? { workspaceIdentity: entry.workspaceIdentity }
                      : {}),
                    sessionId: entry.sessionId,
                    endedLimit: 1,
                  });
                  next = sub.running.length > 0 ? "running" : "done";
                  // 侦察会话第一阶段完成≠分析完成：第二阶段（主题派发）未开始前保持 waiting 留在分析中。
                  const scout = useFeatureDocAnalysisDialogStore.getState().scout;
                  if (next === "done" && scout?.sessionId === entry.sessionId) {
                    next = "waiting";
                  }
                } catch {
                  // 读取失败不降级为 done（子智能体可能仍在跑），保持现状等下一轮。
                  continue;
                }
              } else {
                next = "unknown";
              }
              const current = useFeatureAnalysisStore
                .getState()
                .entries.find((item) => item.sessionId === entry.sessionId);
              if (!current) continue;
              // 释放后读不到 meta 的 unknown 不把已 done 降级；running>0 的误判 done 会被拉回 running。
              if (current.status === "done" && next === "unknown") continue;
              if (current.status !== next) {
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