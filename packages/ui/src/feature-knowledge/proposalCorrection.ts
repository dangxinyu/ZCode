// 提案归属纠正的发送与归因（spec: feature-knowledge.md 提案-确认闸门）。
// 发送唯一归 SessionPane 登记把手；这里只做归因反查与 bounded 等待，不另起发送通道。
import type { useServices } from "@/hooks/useServices.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useFeatureKnowledgeDistillStore } from "@/store/featureKnowledgeDistillStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

// 提案 source.sessionId 可能是派生提炼的子智能体 child session（propose 工具在 child 里调用），
// 而发送把手/自动弹窗只认父会话：用当前活动会话的子智能体目录把 child 反查回父会话。
export async function resolveOwnerSession(
  sourceSessionId: string,
  services: ReturnType<typeof useServices>,
  tabStore: ReturnType<typeof useTabStoreApi>,
): Promise<string | null> {
  if (useFeatureKnowledgeDistillStore.getState().controllers[sourceSessionId]) {
    return sourceSessionId;
  }
  const state = tabStore.getState();
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (!active || !isWorkspaceTab(active)) return null;
  try {
    const result = await services.zcodeAgentService.listSessionSubagents({
      workspacePath: active.workspacePath,
      ...(active.workspaceIdentity ? { workspaceIdentity: active.workspaceIdentity } : {}),
      sessionId: active.id,
      endedLimit: 100,
    });
    return result.childSessionIds.includes(sourceSessionId) ? active.id : null;
  } catch {
    return null;
  }
}

// 纠正指令必须落到来源会话（工作记录在那里的上下文）；该会话 pane 未聚焦时先激活 tab，
// 等它登记发送把手（bounded 8s：新会话 hydration+pane 挂载可能超过 2s），超时交由用户手动重试。
export async function sendCorrectionToSession(
  sessionId: string,
  instruction: string,
  tabStore: ReturnType<typeof useTabStoreApi>,
  submission?: ComposerSubmissionConfig,
): Promise<boolean> {
  const store = useFeatureKnowledgeDistillStore.getState();
  // disabled 只表示头部「提炼」按钮不可用（无对话内容）；sendInstruction 是外部动作通道，
  // 空会话的首条指令必须能发（2026-11-25 bug：曾误用 disabled 拦截发送）。
  const ready = store.controllers[sessionId];
  if (ready) {
    return await ready.sendInstruction(instruction, submission);
  }
  tabStore.getState().activateTab(sessionId);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 8000);
    const unsubscribe = useFeatureKnowledgeDistillStore.subscribe((state) => {
      const controller = state.controllers[sessionId];
      if (controller) {
        void controller.sendInstruction(instruction, submission).then((ok) => finish(ok));
      }
    });
    const current = useFeatureKnowledgeDistillStore.getState().controllers[sessionId];
    if (current) {
      void current.sendInstruction(instruction, submission).then((ok) => finish(ok));
    }
  });
}
const LAND_VERIFY_MS = 6000;

/** 发送 ack 不等于执行：坏模型/未就绪 runtime 会静默丢指令；校验真落库或 lastError。 */
export async function verifyInstructionLanded(
  services: ReturnType<typeof useServices>,
  sessionId: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): Promise<boolean> {
  const deadline = Date.now() + LAND_VERIFY_MS;
  while (Date.now() < deadline) {
    try {
      const snapshot = await services.zcodeSessionService.readSession({
        sessionId,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      });
      if (snapshot && snapshot.messages.length > 0) return true;
      if (snapshot?.projection.lastError) return false;
    } catch {
      // 读失败继续轮询，超时判未落库
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
