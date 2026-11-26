// 功能点知识库全局页（spec: packages/services/specs/feature-knowledge.md 验收 2/4/6/7/9/10/11）。
// 全局单例 tab（先例 openSettingsTab）；按域分组列表 + 搜索（标注命中层 + 语义召回状态）
// + 活文档阅读 + 版本历史 + 关联跳转 + 待确认提案区。数据经 useFeatureKnowledge（base host）。
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { FeatureDetail, FeatureProposal, FeatureSummary } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useFeatureKnowledge } from "@/hooks/useFeatureKnowledge.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { KNOWLEDGE_TAB_ID } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useTheme } from "@/useTheme.js";
import { FeatureKnowledgeDetail } from "./FeatureKnowledgeDetail.js";
import { FeatureAnalysisRunningList } from "./FeatureAnalysisRunningList.js";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";
import { FeatureKnowledgeGroupedList } from "./FeatureKnowledgeGroupedList.js";
import { HitList, ProposalList, SegmentButton } from "./FeatureKnowledgeLists.js";
import { useFeatureAnalysisStatusPolling } from "./useFeatureAnalysisStatusPolling.js";
import { useFeatureDocAnalysisDialogStore } from "@/store/featureKnowledgeDocAnalysisDialogStore.js";
import { FeatureKnowledgeEmbeddingSetting } from "./FeatureKnowledgeEmbeddingSetting.js";
import { FeatureProposalConfirmDialog } from "./FeatureProposalConfirmDialog.js";
import { FeatureDeleteConfirmDialog } from "./FeatureDeleteConfirmDialog.js";
import { startFeatureCorrection } from "./startFeatureCorrection.js";
import { useBatchConfirmProposals } from "./useBatchConfirmProposals.js";
import { dispatchDocThemes } from "./dispatchDocThemes.js";
import { toast } from "@/components/ui/toast.js";

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
  const batch = useBatchConfirmProposals(kb);
  const services = useServices();
  const tabStore = useTabStoreApi();
  const analysisEntries = useFeatureAnalysisStore((state) => state.entries);
  useFeatureAnalysisStatusPolling();
  const scout = useFeatureDocAnalysisDialogStore((state) => state.scout);
  // 全自动（除提案确认）：侦察计划落盘即自动派发全部主题；失败/未派发留 waiting，行内手动派发兜底。
  useEffect(() => {
    if (!scout) return;
    let cancelled = false;
    let failNotified = false;
    const tick = async () => {
      const next = await kb.readDocThemePlan(scout.planPath);
      if (cancelled || !next || next.themes.length === 0) return;
      try {
        await dispatchDocThemes(services, scout, next.themes);
        useFeatureDocAnalysisDialogStore.getState().reset();
        toast(
          intl.formatMessage(
            { id: "knowledge.analyzeAutoDispatched" },
            { count: next.themes.length },
          ),
          { variant: "info" },
        );
      } catch {
        // 自动派发失败：不 reset，entry 留 waiting，「分析中」行手动派发兜底；只提示一次防刷屏。
        if (!failNotified) {
          failNotified = true;
          toast(intl.formatMessage({ id: "knowledge.analyzeAutoDispatchFailed" }), {
            variant: "warning",
          });
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scout, kb, services, intl]);

  const [segment, setSegment] = useState<Segment>("features");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<FeatureProposal | null>(null);
  const [embeddingOpen, setEmbeddingOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FeatureSummary | null>(null);
  const [correcting, setCorrecting] = useState(false);


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

  // 末级右键删除：二次确认后走 host 事务删除（hook 内部已 refresh）；正打开的被删文档清空详情。
  const confirmDelete = useCallback(
    async (id: string): Promise<boolean> => {
      const target = kb.features.find((f) => f.id === id);
      const result = await kb.deleteFeature(id);
      if (!result.ok) {
        toast(`${intl.formatMessage({ id: "knowledge.deleteFailed" })}: ${result.message}`, {
          variant: "warning",
        });
        return false;
      }
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      toast(
        intl.formatMessage({ id: "knowledge.deleteDone" }, { name: target?.name ?? id }),
        { variant: "info" },
      );
      return true;
    },
    [kb, intl, selectedId],
  );

  // 末级右键订正：新建会话 + 隐藏上下文（不自动发送）；correcting 防连点重复建会话。
  const correctFeature = useCallback(
    async (feature: FeatureSummary) => {
      if (correcting) return;
      setCorrecting(true);
      try {
        const result = await startFeatureCorrection(feature, {
          services,
          tabStore,
          readFeature: kb.readFeature,
          onJumpToSession,
        });
        if (!result.ok) {
          toast(intl.formatMessage({ id: result.messageKey }), { variant: "warning" });
        } else {
          toast(
            intl.formatMessage({
              id: result.jumped ? "knowledge.correctStarted" : "knowledge.correctNoJump",
            }),
            { variant: "info" },
          );
        }
      } finally {
        setCorrecting(false);
      }
    },
    [correcting, services, tabStore, kb.readFeature, onJumpToSession, intl],
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
                <div className="space-y-2">
                  <div className="flex justify-end px-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={batch.busy || pendingProposals.length === 0}
                      onClick={() => void batch.confirmAll()}
                    >
                      {intl.formatMessage(
                        { id: "knowledge.batchConfirm" },
                        { count: pendingProposals.length },
                      )}
                    </Button>
                  </div>
                  <ProposalList
                    proposals={pendingProposals}
                    featureNameById={featureNameById}
                    onOpen={setConfirmProposal}
                  />
                </div>
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
                  onDelete={setDeleteTarget}
                  onCorrect={(feature) => void correctFeature(feature)}
                />
              )}
            </div>

            <div className="min-h-0 overflow-hidden">
              {detail && selectedId ? (
                <FeatureKnowledgeDetail
                  detail={detail}
                  parent={kb.features.find((f) => f.id === detail.feature.parentFeatureId) ?? null}
                  children={kb.features.filter((f) => f.parentFeatureId === detail.feature.id)}
                  categoryOptions={kb.features.filter(
                    (f) =>
                      f.id !== detail.feature.id &&
                      // 父候选只列分类（有子文档的父节点），不列叶子知识文件（用户确认 2026-11-26）。
                      kb.features.some((c) => c.parentFeatureId === f.id),
                  )}
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
      <FeatureDeleteConfirmDialog
        feature={deleteTarget}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
      <FeatureKnowledgeEmbeddingSetting
        open={embeddingOpen}
        onClose={() => setEmbeddingOpen(false)}
      />
    </div>
  );
}