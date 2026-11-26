// 待确认提案批量确认（spec: feature-knowledge.md 提案-确认闸门；用户确认 2026-11-26：不想逐条看时批量确认）。
// 整份接受（不做章节勾选）；顺序提交，同功能点后续提案因 baseVersion 冲突跳过并汇报，不静默丢。
import { useCallback, useState } from "react";
import { KB_ERROR_CODES } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import type { UseFeatureKnowledgeResult } from "@/hooks/useFeatureKnowledge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function useBatchConfirmProposals(kb: UseFeatureKnowledgeResult) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);

  const confirmAll = useCallback(async () => {
    if (busy) return;
    const pending = kb.proposals.filter((proposal) => proposal.status === "pending");
    if (pending.length === 0) return;
    setBusy(true);
    let committed = 0;
    let skipped = 0;
    let failed = 0;
    for (const proposal of pending) {
      const result = await kb.commitProposal(proposal.id);
      if (result.ok) committed += 1;
      else if (result.code === KB_ERROR_CODES.baseVersionConflict) skipped += 1;
      else failed += 1;
    }
    kb.refresh();
    setBusy(false);
    toast(
      intl.formatMessage({ id: "knowledge.batchConfirmDone" }, { committed, skipped, failed }),
      { variant: skipped > 0 || failed > 0 ? "warning" : "info" },
    );
  }, [busy, kb, intl]);

  return { busy, confirmAll };
}