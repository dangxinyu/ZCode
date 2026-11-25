// 功能点知识库全局页（spec: packages/services/specs/feature-knowledge.md 验收 2/4/6/7/9/10/11）。
// 全局单例 tab（先例 openSettingsTab）；按域分组列表 + 搜索（标注命中层 + 语义召回状态）
// + 活文档阅读 + 版本历史 + 关联跳转 + 待确认提案区。数据经 useFeatureKnowledge（base host）。
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { FeatureDetail, FeatureProposal, FeatureSummary, SearchHit } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useFeatureKnowledge } from "@/hooks/useFeatureKnowledge.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { KNOWLEDGE_TAB_ID } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useTheme } from "@/useTheme.js";
import { FeatureKnowledgeDetail } from "./FeatureKnowledgeDetail.js";
import { FeatureAnalysisRunningList } from "./FeatureAnalysisRunningList.js";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";
import { FeatureKnowledgeGroupedList } from "./FeatureKnowledgeGroupedList.js";
import { useFeatureAnalysisStatusPolling } from "./useFeatureAnalysisStatusPolling.js";
import { useFeatureDocAnalysisDialogStore } from "@/store/featureKnowledgeDocAnalysisDialogStore.js";
import { FeatureKnowledgeEmbeddingSetting } from "./FeatureKnowledgeEmbeddingSetting.js";
import { FeatureProposalConfirmDialog } from "./FeatureProposalConfirmDialog.js";

type Segment = "features" | "proposals" | "analysis" | "analysisDone";

function groupByDomain(features: FeatureSummary[]): Array<[string, FeatureSummary[]]> {
  const groups = new Map<string, FeatureSummary[]>();
  for (const feature of features) {
    const domain = feature.domain.trim() || "__ungrouped__";
    const list = groups.get(domain) ?? [];
    list.push(feature);
    groups.set(domain, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function FeatureKnowledgePage({
  onJumpToSession,
}: {
  onJumpToSession?: (
    workspacePath: string,
    sessionId: string,
    workspaceIdentity?: string,
  ) => void;
} = {}) {
  const { intl } = useZCodeIntl();
  const { theme } = useTheme();
  const closeTab = useTabStore((state) => state.closeTab);
  const kb = useFeatureKnowledge();
  const services = useServices();
  const analysisEntries = useFeatureAnalysisStore((state) => state.entries);
  useFeatureAnalysisStatusPolling();
  const scout = useFeatureDocAnalysisDialogStore((state) => state.scout);
  const themePlan = useFeatureDocAnalysisDialogStore((state) => state.plan);
  // 侦察计划落盘后重开弹窗到主题勾选步（等待期间弹窗关闭，用户落在会话里看侦察）。
  useEffect(() => {
    if (!scout || themePlan) return;
    let cancelled = false;
    const tick = async () => {
      const next = await kb.readDocThemePlan(scout.planPath);
      if (cancelled || !next) return;
      const store = useFeatureDocAnalysisDialogStore.getState();
      store.setPlan(next);
      store.setStep("themes");
      store.setOpen(true);
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scout, themePlan, kb]);

  const [segment, setSegment] = useState<Segment>("features");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<FeatureProposal | null>(null);
  const [embeddingOpen, setEmbeddingOpen] = useState(false);


  const featureNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const feature of kb.features) {
      map[feature.id] = feature.name;
    }
    return map;
  }, [kb.features]);

  const openFeature = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setSegment("features");
      const next = await kb.readFeature(id);
      setDetail(next);
    },
    [kb],
  );

  const submitSearch = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setSegment("features");
      await kb.search(query);
    },
    [kb, query],
  );

  const pendingProposals = kb.proposals.filter((proposal) => proposal.status === "pending");
  const hits = kb.searchResult?.hits ?? null;
  const semanticDisabled = kb.searchResult != null && !kb.searchResult.semanticEnabled;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="text-ui-lg font-semibold">{intl.formatMessage({ id: "knowledge.title" })}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => useFeatureDocAnalysisDialogStore.getState().setOpen(true)}>
            {intl.formatMessage({ id: "knowledge.analyzeDocs" })}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEmbeddingOpen(true)}>
            {intl.formatMessage({ id: "knowledge.configureEmbedding" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "knowledge.close" })}
            onClick={() => closeTab(KNOWLEDGE_TAB_ID)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {!kb.available ? (
        <div className="p-6 text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "knowledge.unavailable" })}
        </div>
      ) : (
        <>
          <form onSubmit={submitSearch} className="flex shrink-0 items-center gap-2 px-4 py-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={intl.formatMessage({ id: "knowledge.searchPlaceholder" })}
              aria-label={intl.formatMessage({ id: "knowledge.search" })}
            />
            <Button type="submit" variant="secondary">
              {intl.formatMessage({ id: "knowledge.search" })}
            </Button>
          </form>

          {semanticDisabled ? (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-ui-xs text-muted-foreground">
              <span>{intl.formatMessage({ id: "knowledge.semanticDisabled" })}</span>
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setEmbeddingOpen(true)}
              >
                {intl.formatMessage({ id: "knowledge.configureEmbedding" })}
              </button>
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-1 px-4">
            <SegmentButton
              active={segment === "features"}
              label={intl.formatMessage({ id: "knowledge.tabFeatures" })}
              onClick={() => setSegment("features")}
            />
            <SegmentButton
              active={segment === "proposals"}
              label={intl.formatMessage({ id: "knowledge.tabProposals" })}
              count={pendingProposals.length}
              onClick={() => setSegment("proposals")}
            />
            <SegmentButton
              active={segment === "analysis"}
              label={intl.formatMessage({ id: "knowledge.tabAnalyzing" })}
              count={analysisEntries.filter((e) => e.status !== "done").length}
              onClick={() => setSegment("analysis")}
            />
            <SegmentButton
              active={segment === "analysisDone"}
              label={intl.formatMessage({ id: "knowledge.tabAnalysisDone" })}
              count={analysisEntries.filter((e) => e.status === "done").length}
              onClick={() => setSegment("analysisDone")}
            />
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,320px)_1fr] gap-0 border-t border-border">
            <div className="min-h-0 overflow-auto border-r border-border p-3">
              {kb.loading ? (
                <p className="text-ui-sm text-muted-foreground">
                  {intl.formatMessage({ id: "knowledge.loading" })}
                </p>
              ) : segment === "proposals" ? (
                <ProposalList
                  proposals={pendingProposals}
                  featureNameById={featureNameById}
                  onOpen={setConfirmProposal}
                />
              ) : segment === "analysis" || segment === "analysisDone" ? (
                <FeatureAnalysisRunningList
                  mode={segment === "analysisDone" ? "done" : "running"}
                  onJump={(entry) =>
                    onJumpToSession?.(
                      entry.workspacePath,
                      entry.sessionId,
                      entry.workspaceIdentity,
                    )
                  }
                />
              ) : hits ? (
                <HitList hits={hits} onOpen={openFeature} />
              ) : kb.features.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">
                  {intl.formatMessage({ id: "knowledge.empty" })}
                </p>
              ) : (
                <FeatureKnowledgeGroupedList
                  groups={groupByDomain(kb.features)}
                  selectedId={selectedId}
                  onOpen={openFeature}
                />
              )}
            </div>

            <div className="min-h-0 overflow-hidden">
              {detail && selectedId ? (
                <FeatureKnowledgeDetail
                  detail={detail}
                  parent={kb.features.find((f) => f.id === detail.feature.parentFeatureId) ?? null}
                  children={kb.features.filter((f) => f.parentFeatureId === detail.feature.id)}
                  categoryOptions={kb.features.filter((f) => f.id !== detail.feature.id)}
                  onSetParent={(featureId, parentFeatureId) => {
                    void services.featureKnowledgeService
                      ?.setFeatureParent(featureId, parentFeatureId)
                      .then(() => kb.refresh())
                      .then(() => kb.readFeature(featureId))
                      .then((next) => next && setDetail(next));
                  }}
                  onCreateCategory={(name, domain) => {
                    void services.featureKnowledgeService
                      ?.createFeatureCategory(name, domain)
                      .then((created) => {
                        kb.refresh();
                        return services.featureKnowledgeService?.setFeatureParent(
                          detail.feature.id,
                          created.id,
                        );
                      })
                      .then(() => kb.refresh())
                      .then(() => kb.readFeature(detail.feature.id))
                      .then((next) => next && setDetail(next));
                  }}
                  theme={theme}
                  featureNameById={featureNameById}
                  onOpenFeature={openFeature}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-ui-sm text-muted-foreground">
                  {intl.formatMessage({ id: "knowledge.selectFeature" })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <FeatureProposalConfirmDialog
        proposal={confirmProposal}
        features={kb.features}
        readFeature={kb.readFeature}
        onConfirm={kb.commitProposal}
        onReject={kb.rejectProposal}
        onClose={() => setConfirmProposal(null)}
      />
      <FeatureKnowledgeEmbeddingSetting
        open={embeddingOpen}
        onClose={() => setEmbeddingOpen(false)}
      />
    </div>
  );
}

function SegmentButton({
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



function HitList({ hits, onOpen }: { hits: SearchHit[]; onOpen: (id: string) => void }) {
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

function ProposalList({
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