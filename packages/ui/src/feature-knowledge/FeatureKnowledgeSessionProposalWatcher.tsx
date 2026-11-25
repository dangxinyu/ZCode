// 当前会话来源提案自动弹确认 dialog；其他来源 toast 提示（spec: packages/services/specs/feature-knowledge.md 事件顺序 / 验收 1）。
// 只有 focused pane 响应广播：来源会话 === 本 pane 会话 → 弹 dialog；否则 toast。
// 非 focused pane 不响应，避免分屏时重复弹窗/重复 toast。侧栏 pending 角标始终兜底，事实以 host 广播为准。
import { useEffect, useState } from "react";
import type { FeatureProposal } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useFeatureKnowledge } from "@/hooks/useFeatureKnowledge.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FeatureProposalConfirmDialog } from "./FeatureProposalConfirmDialog.js";

export interface FeatureKnowledgeSessionProposalWatcherProps {
  sessionId: string | null;
  focused: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function FeatureKnowledgeSessionProposalWatcher({
  sessionId,
  focused,
  workspacePath,
  workspaceIdentity,
}: FeatureKnowledgeSessionProposalWatcherProps) {
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.featureKnowledgeService;
  const agentService = useServices().zcodeAgentService;
  const kb = useFeatureKnowledge();
  const { intl } = useZCodeIntl();
  const [proposal, setProposal] = useState<FeatureProposal | null>(null);

  useEffect(() => {
    if (!service || !focused) {
      return;
    }
    const subscription = service.onDynamicFeatureKnowledgeChanged()((event) => {
      if (event.reason !== "proposed" || !event.proposalId) {
        return;
      }
      const proposalId = event.proposalId;
      void (async () => {
        const next = await service.getProposal(proposalId);
        if (!next || next.status !== "pending") {
          return;
        }
        // 提炼经内联子智能体提交时 source.sessionId 是 child session；
        // 用本会话的子智能体目录反查，child 来源也算「当前会话」自动弹窗。
        let own = !!sessionId && next.source.sessionId === sessionId;
        if (!own && sessionId && next.source.sessionId) {
          const sourceSessionId = next.source.sessionId;
          try {
            const subagents = await agentService.listSessionSubagents({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId,
              endedLimit: 100,
            });
            own = subagents.childSessionIds.includes(sourceSessionId);
          } catch {
            own = false;
          }
        }
        if (own) {
          setProposal(next);
        } else {
          toast(intl.formatMessage({ id: "knowledge.proposalToast" }));
        }
      })();
    });
    return () => subscription.dispose();
  }, [service, sessionId, focused, intl, agentService, workspacePath, workspaceIdentity]);

  return (
    <FeatureProposalConfirmDialog
      proposal={proposal}
      features={kb.features}
      readFeature={kb.readFeature}
      onConfirm={kb.commitProposal}
      onReject={kb.rejectProposal}
      onClose={() => setProposal(null)}
    />
  );
}