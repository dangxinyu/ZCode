// 知识库页列表子组件（自 FeatureKnowledgePage 抽出以守 max-lines）：分段按钮 / 搜索命中 / 待确认提案。
import type { FeatureProposal, SearchHit } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SegmentButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-ui-sm ${
        // 本仓库主题没有 --color-muted* token，bg-muted/text-muted-foreground 是死类，
        // 激活态曾与未激活完全同色；改用真实 token 的底色+字色双重色差标示当前 tab。
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-foreground-subtle hover:bg-hover hover:text-foreground"
      }`}
    >
      {label}
      {count != null && count > 0 ? (
        <Badge variant="destructive" className="h-4 px-1.5 text-ui-xs">
          {count}
        </Badge>
      ) : null}
    </button>
  );
}

export function HitList({ hits, onOpen }: { hits: SearchHit[]; onOpen: (id: string) => void }) {
  const { intl } = useZCodeIntl();
  if (hits.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        {intl.formatMessage({ id: "knowledge.noResults" })}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {hits.map((hit) => (
        <li key={hit.feature.id}>
          <button
            type="button"
            onClick={() => onOpen(hit.feature.id)}
            className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-hover"
          >
            <span className="block text-ui-sm text-foreground">{hit.feature.name}</span>
            <span className="mt-0.5 flex flex-wrap gap-1">
              {hit.layers.map((layer) => (
                <Badge key={layer} variant="outline" className="h-4 px-1.5 text-ui-xs">
                  {intl.formatMessage({ id: `knowledge.layer.${layer}` })}
                </Badge>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ProposalList({
  proposals,
  featureNameById,
  onOpen,
}: {
  proposals: FeatureProposal[];
  featureNameById: Record<string, string>;
  onOpen: (proposal: FeatureProposal) => void;
}) {
  const { intl } = useZCodeIntl();
  if (proposals.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        {intl.formatMessage({ id: "knowledge.proposalsEmpty" })}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {proposals.map((proposal) => {
        const name =
          (proposal.featureId ? featureNameById[proposal.featureId] : null) ?? proposal.proposedName;
        return (
          <li key={proposal.id}>
            <button
              type="button"
              onClick={() => onOpen(proposal)}
              className="w-full rounded-md border border-border px-2 py-1.5 text-left hover:bg-surface-hover"
            >
              <span className="block text-ui-sm text-foreground">{name}</span>
              <span className="mt-0.5 block text-ui-xs text-muted-foreground">
                {proposal.changeSummary || intl.formatMessage({ id: "knowledge.openProposal" })}
              </span>
              {proposal.source.origin === "mcp" ? (
                <Badge variant="secondary" className="mt-1 h-4 px-1.5 text-ui-xs">
                  {intl.formatMessage({ id: "knowledge.sourceMcp" })}
                </Badge>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}