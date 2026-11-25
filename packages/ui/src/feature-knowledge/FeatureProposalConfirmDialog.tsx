// 功能点提案合并确认 dialog（spec: packages/services/specs/feature-knowledge.md 验收 1/2/6/7）。
// 旧/新活文档 diff + 变更摘要 + 实体归属明示；base 已变（他人先提交）→ 提示冲突并禁用确认。
// 键盘：Enter 确认、Esc 拒绝（Radix 默认 Esc 仅关闭，这里 intercept 成拒绝以满足验收 7）。
import { useEffect, useMemo, useState } from "react";
import type { FeatureProposal, FeatureSummary } from "@zcode/services";
import { KB_ERROR_CODES } from "@zcode/services";
import {
  listChangedFeatureDocSections,
  mergeFeatureDocSections,
} from "@zcode/shared";
import type { FeatureKnowledgeMutationResult } from "@/hooks/useFeatureKnowledge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { resolveTheme, useTheme } from "@/useTheme.js";
import { logger } from "@/logger.js";
import { buildFeatureDistillCorrectionInstruction } from "./distillInstruction.js";
import { resolveOwnerSession, sendCorrectionToSession } from "./proposalCorrection.js";

export interface FeatureProposalConfirmDialogProps {
  proposal: FeatureProposal | null;
  features: FeatureSummary[];
  readFeature: (id: string) => Promise<{ feature: { docMd: string; currentVersion: number; name: string } } | null>;
  onConfirm: (
    id: string,
    acceptedSections?: readonly string[],
  ) => Promise<FeatureKnowledgeMutationResult>;
  onReject: (id: string) => Promise<FeatureKnowledgeMutationResult>;
  onClose: () => void;
}

export function FeatureProposalConfirmDialog({
  proposal,
  features,
  readFeature,
  onConfirm,
  onReject,
  onClose,
}: FeatureProposalConfirmDialogProps) {
  const { intl } = useZCodeIntl();
  const { theme } = useTheme();
  const tabStore = useTabStoreApi();
  const services = useServices();
  const themeType = resolveTheme(theme);
  const [oldDoc, setOldDoc] = useState<string>("");
  const [entityName, setEntityName] = useState<string>("");
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingTarget, setPickingTarget] = useState(false);
  const [sectionSelection, setSectionSelection] = useState<Record<string, boolean>>({});

  const open = proposal !== null;
  const isNew = proposal?.featureId == null;

  useEffect(() => {
    if (!proposal) {
      return;
    }
    let cancelled = false;
    setError(null);
    setBusy(false);
    setPickingTarget(false);
    if (proposal.featureId == null) {
      setOldDoc("");
      setEntityName(proposal.proposedName);
      setCurrentVersion(null);
      setSectionSelection({});
      return;
    }
    setEntityName(proposal.proposedName);
    void (async () => {
      const detail = await readFeature(proposal.featureId as string);
      if (cancelled) {
        return;
      }
      if (detail) {
        setOldDoc(detail.feature.docMd);
        setEntityName(detail.feature.name);
        setCurrentVersion(detail.feature.currentVersion);
        // 默认全接受；用户取消勾选的章节提交时保持原文。
        setSectionSelection(
          Object.fromEntries(
            listChangedFeatureDocSections(detail.feature.docMd, proposal.docMd).map((section) => [
              section.name,
              true,
            ]),
          ),
        );
      } else {
        setOldDoc("");
        setCurrentVersion(null);
        setSectionSelection({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proposal, readFeature]);

  const baseConflict =
    !isNew &&
    proposal?.baseVersion != null &&
    currentVersion != null &&
    proposal.baseVersion !== currentVersion;
  const resolved = proposal != null && proposal.status !== "pending";

  const changedSections = useMemo(
    () =>
      isNew || !proposal
        ? []
        : listChangedFeatureDocSections(oldDoc, proposal.docMd),
    [isNew, oldDoc, proposal],
  );
  const acceptedSectionNames = useMemo(
    () => changedSections.filter((section) => sectionSelection[section.name]).map((s) => s.name),
    [changedSections, sectionSelection],
  );
  const partialAccept = changedSections.length > 0 && acceptedSectionNames.length < changedSections.length;
  // diff 展示「将要提交的内容」：部分接受时以旧文档为底合并勾选章节，而非整份提案。
  const mergedDoc = useMemo(() => {
    if (!proposal) return "";
    if (!partialAccept) return proposal.docMd;
    return mergeFeatureDocSections(oldDoc, proposal.docMd, acceptedSectionNames);
  }, [proposal, partialAccept, oldDoc, acceptedSectionNames]);

  const diffFiles = useMemo(() => {
    const name = `${entityName || proposal?.proposedName || "feature"}.md`;
    const next = mergedDoc;
    return {
      oldFile: {
        name,
        contents: oldDoc,
        cacheKey: `old:${name}:${oldDoc.length}:${oldDoc.slice(0, 80)}`,
      },
      newFile: {
        name,
        contents: next,
        cacheKey: `new:${name}:${next.length}:${next.slice(0, 80)}`,
      },
    };
  }, [entityName, mergedDoc, proposal?.proposedName]);

  const runConfirm = async () => {
    if (!proposal || busy || baseConflict || resolved) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onConfirm(
      proposal.id,
      partialAccept ? acceptedSectionNames : undefined,
    );
    setBusy(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(
      result.code === KB_ERROR_CODES.baseVersionConflict
        ? intl.formatMessage({ id: "knowledge.conflict" })
        : result.code === KB_ERROR_CODES.proposalResolved
          ? intl.formatMessage({ id: "knowledge.proposalResolved" })
          : `${intl.formatMessage({ id: "knowledge.confirmFailed" })}: ${result.message}`,
    );
    logger.warn("[feature-knowledge] confirm rejected by host", { code: result.code });
  };

  const runReject = async () => {
    if (!proposal || busy || resolved) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onReject(proposal.id);
    setBusy(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(
      result.code === KB_ERROR_CODES.proposalResolved
        ? intl.formatMessage({ id: "knowledge.proposalResolved" })
        : `${intl.formatMessage({ id: "knowledge.rejectFailed" })}: ${result.message}`,
    );
  };

  // 归属不对：拒绝旧提案（留墓碑）→ 向来源会话发纠正指令，指定正确归属重新合并重提。
  const runMisattribute = async (target: { featureId?: string; name: string }) => {
    if (!proposal || busy || resolved) return;
    const sourceSessionId = proposal.source?.sessionId;
    if (!sourceSessionId) {
      setError(intl.formatMessage({ id: "knowledge.correctionSourceMissing" }));
      return;
    }
    const ownerSessionId = await resolveOwnerSession(sourceSessionId, services, tabStore);
    if (!ownerSessionId) {
      setError(intl.formatMessage({ id: "knowledge.correctionFailed" }));
      return;
    }
    setBusy(true);
    setError(null);
    const rejectResult = await onReject(proposal.id);
    if (!rejectResult.ok) {
      setBusy(false);
      setError(
        `${intl.formatMessage({ id: "knowledge.rejectFailed" })}: ${rejectResult.message}`,
      );
      return;
    }
    const instruction = buildFeatureDistillCorrectionInstruction({
      ...(target.featureId ? { targetFeatureId: target.featureId } : {}),
      targetName: target.name,
      wrongTargetName: entityName || proposal.proposedName,
    });
    const sent = await sendCorrectionToSession(ownerSessionId, instruction, tabStore);
    setBusy(false);
    setPickingTarget(false);
    if (sent) {
      toast(intl.formatMessage({ id: "knowledge.correctionSent" }, { name: target.name }), {
        variant: "info",
      });
      onClose();
    } else {
      logger.warn("[feature-knowledge] 纠正指令未送达来源会话", { sessionId: ownerSessionId });
      toast(intl.formatMessage({ id: "knowledge.correctionFailed" }), { variant: "warning" });
    }
  };

  const entityLabel = isNew
    ? intl.formatMessage({ id: "knowledge.entityCreate" }, { name: entityName || proposal?.proposedName || "" })
    : intl.formatMessage({ id: "knowledge.entityMerge" }, { name: entityName });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-3xl"
        showCloseButton
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            // 选择归属期间 Enter 不确认，避免误把投错的提案提交。
            if (!pickingTarget) void runConfirm();
          }
        }}
        // Radix 默认 Esc 会直接 dismiss 整个 dialog；这里接管：选择器开着只关选择器，否则拒绝。
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (pickingTarget) setPickingTarget(false);
          else void runReject();
        }}
      >
        <DialogHeader>
          <DialogTitle>{entityLabel}</DialogTitle>
          <DialogDescription>
            {proposal?.changeSummary?.trim() ||
              intl.formatMessage({ id: "knowledge.changeSummary" })}
          </DialogDescription>
        </DialogHeader>

        {baseConflict ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {intl.formatMessage({ id: "knowledge.conflict" })}
          </p>
        ) : null}
        {resolved ? (
          <p className="rounded-md border border-border px-3 py-2 text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "knowledge.proposalResolved" })}
          </p>
        ) : null}
        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}

        {changedSections.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "knowledge.partialAccept" })}
            </span>
            {changedSections.map((section) => (
              <label
                key={section.name}
                className="flex items-center gap-1.5 text-ui-sm text-foreground"
              >
                <input
                  type="checkbox"
                  checked={Boolean(sectionSelection[section.name])}
                  disabled={busy}
                  onChange={(event) =>
                    setSectionSelection((current) => ({
                      ...current,
                      [section.name]: event.target.checked,
                    }))
                  }
                />
                {section.label}
              </label>
            ))}
            <span className="w-full text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "knowledge.partialAcceptHint" })}
            </span>
          </div>
        ) : null}

        <div className="grid gap-2 text-ui-xs text-muted-foreground">
          <span>
            {intl.formatMessage({ id: "knowledge.oldDoc" })}
            {isNew ? ` ${intl.formatMessage({ id: "knowledge.noOldDoc" })}` : ""}
            {" → "}
            {intl.formatMessage({ id: "knowledge.newDoc" })}
          </span>
        </div>
        <div className="h-[50vh] overflow-hidden rounded-md border border-border">
          <DiffViewer
            oldFile={diffFiles.oldFile}
            newFile={diffFiles.newFile}
            diffClassName="block"
            themeType={themeType}
            // 用户要求 git 式 diff：classic 的 +/- 行标记比色条更接近 git diff/冲突视图的阅读习惯。
            options={{ diffIndicators: "classic" }}
          />
        </div>

        {pickingTarget ? (
          <div className="max-h-48 overflow-auto rounded-md border border-border p-1">
            <p className="px-2 py-1 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "knowledge.pickTarget" })}
            </p>
            {features
              .filter((feature) => feature.id !== proposal?.featureId)
              .map((feature) => (
                <button
                  key={feature.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void runMisattribute({ featureId: feature.id, name: feature.name })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{feature.name}</span>
                  {feature.domain ? (
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {feature.domain}
                    </span>
                  ) : null}
                </button>
              ))}
            {!isNew ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runMisattribute({ name: proposal?.proposedName || entityName })
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-hover"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {intl.formatMessage(
                    { id: "knowledge.correctionCreateNew" },
                    { name: proposal?.proposedName || entityName },
                  )}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || resolved}
            onClick={() => setPickingTarget((current) => !current)}
          >
            {intl.formatMessage({ id: "knowledge.misattributed" })}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void runReject()}>
            {intl.formatMessage({ id: "knowledge.reject" })}
            <span className="ml-1 text-ui-xs opacity-60">Esc</span>
          </Button>
          <Button
            type="button"
            autoFocus
            disabled={
              busy ||
              baseConflict ||
              resolved ||
              (changedSections.length > 0 && acceptedSectionNames.length === 0)
            }
            onClick={() => void runConfirm()}
          >
            {intl.formatMessage({ id: "knowledge.confirm" })}
            <span className="ml-1 text-ui-xs opacity-60">⏎</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}