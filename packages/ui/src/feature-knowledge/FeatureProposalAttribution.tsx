// 提案归属明示（spec: feature-knowledge.md 提案-确认闸门；用户反馈 2026-11-27：
// 不展示域/功能分类父就没法判断归属对不对）。自 confirm dialog 抽出以守 max-lines。
import { useMemo } from "react";
import type { FeatureProposal, FeatureSummary } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function FeatureProposalAttribution({
  proposal,
  features,
}: {
  proposal: FeatureProposal | null;
  features: FeatureSummary[];
}) {
  const { intl } = useZCodeIntl();
  const attribution = useMemo(() => {
    if (!proposal) return null;
    const target = proposal.featureId
      ? (features.find((f) => f.id === proposal.featureId) ?? null)
      : null;
    const domain = proposal.proposedDomain?.trim() || target?.domain || "";
    const partOf = proposal.proposedRelations.find((r) => r.kind === "part_of");
    const parentById = partOf ? (features.find((f) => f.id === partOf.toId) ?? null) : null;
    const proposedParent = proposal.proposedParentName?.trim() || "";
    const parentName =
      proposedParent ||
      parentById?.name ||
      (target?.parentFeatureId
        ? (features.find((f) => f.id === target.parentFeatureId)?.name ?? "")
        : "");
    const parentIsNew =
      proposedParent !== "" &&
      !features.some((f) => f.name === proposedParent && f.domain === domain);
    return { domain, parentName, parentIsNew };
  }, [proposal, features]);

  if (!attribution) return null;
  return (
    <span>
      {intl.formatMessage({ id: "knowledge.attribution" })}
      {"："}
      {attribution.domain || intl.formatMessage({ id: "knowledge.domainFallback" })}
      {" → "}
      {attribution.parentName
        ? attribution.parentIsNew
          ? intl.formatMessage(
              { id: "knowledge.attributionNewCategory" },
              { name: attribution.parentName },
            )
          : attribution.parentName
        : intl.formatMessage({ id: "knowledge.attributionNoParent" })}
    </span>
  );
}