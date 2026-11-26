// 文档分析第二阶段（主题提炼）派发 + 自动派发开关（spec: feature-knowledge.md 分阶段）。
// 弹窗人闸与 KB 页「计划落盘自动派发」共用同一条投递逻辑，保证行为单一来源。
import type { useServices } from "@/hooks/useServices.js";
import type { TraceId } from "@zcode/shared";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";
import { buildFeatureDistillThemeInstruction, type FeatureDocThemeBatch } from "./distillInstruction.js";
import { verifySubagentSpawned } from "./proposalCorrection.js";

type Services = ReturnType<typeof useServices>;

export async function dispatchDocThemes(
  services: Services,
  scout: { sessionId: string; workspacePath: string },
  themes: readonly FeatureDocThemeBatch[],
): Promise<void> {
  const content = buildFeatureDistillThemeInstruction(themes);
  const send = () =>
    services.zcodeTaskService.enqueueTaskCommand({
      workspacePath: scout.workspacePath,
      taskId: scout.sessionId,
      commandId: crypto.randomUUID(),
      traceId: crypto.randomUUID() as TraceId,
      type: "send_prompt",
      content,
      clientLabel: "feature-knowledge-doc-analysis",
    });
  await send();
  // 第二阶段已派发：立即置 running，避免「主 task 终态+子智能体尚未 spawn」间隙被轮询误判 done。
  useFeatureAnalysisStore.getState().setStatus(scout.sessionId, "running");
  // 派发回执校验：防主 agent 口头交付；未 spawn 重发一次，仍无则抛错交调用方兜底。
  let spawned = await verifySubagentSpawned(services, scout.sessionId, {
    workspacePath: scout.workspacePath,
  });
  if (!spawned) {
    await send();
    spawned = await verifySubagentSpawned(services, scout.sessionId, {
      workspacePath: scout.workspacePath,
    });
  }
  if (!spawned) {
    throw new Error("doc-themes dispatch produced no subagent");
  }
}