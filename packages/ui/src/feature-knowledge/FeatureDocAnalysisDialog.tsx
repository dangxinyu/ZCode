// 知识库页「分析现有文档」入口（spec: feature-knowledge.md，用户确认 2026-11-25）。
// 四步：路径/目录 → 扫描勾选（>20）→ 侦察子智能体读大概按主题聚类落盘 → 主题清单人闸 → 按主题派发。
// 派发后关闭弹窗（用户落在会话里看分析）；侦察计划落盘后 KB 页轮询重开弹窗到主题步。
// 模型在弹窗里显式选择（默认健康 GLM-5.4），不依赖脆弱继承（全局默认账号鉴权失败）。
import { useEffect, useMemo, useState } from "react";
import { DOC_SCAN_DIRECT_LIMIT, DOC_SCAN_MAX_DOCS } from "@zcode/services";
import type { FeatureDocScanEntry, ModelSelectionView } from "@zcode/services";
import type { ModelSelection, TraceId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useFeatureKnowledge } from "@/hooks/useFeatureKnowledge.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFeatureAnalysisStore } from "@/store/featureKnowledgeAnalysisStore.js";
import {
  useFeatureDocAnalysisDialogStore,
  type DocAnalysisStep,
} from "@/store/featureKnowledgeDocAnalysisDialogStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import {
  buildFeatureDistillDocInstruction,
  buildFeatureDistillThemeInstruction,
  buildFeatureDocScoutInstruction,
} from "./distillInstruction.js";
import { FeatureDocThemePicker } from "./FeatureDocThemePicker.js";
import { verifyInstructionLanded } from "./proposalCorrection.js";
import { resolveAnalysisSubmission } from "./resolveAnalysisSubmission.js";

const DEFAULT_MODEL_ID = "GLM-5.4";

export function FeatureDocAnalysisDialog() {
  const { intl } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const services = useServices();
  const kb = useFeatureKnowledge();
  const open = useFeatureDocAnalysisDialogStore((s) => s.open);
  const step = useFeatureDocAnalysisDialogStore((s) => s.step);
  const scout = useFeatureDocAnalysisDialogStore((s) => s.scout);
  const plan = useFeatureDocAnalysisDialogStore((s) => s.plan);
  const [pathsText, setPathsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<FeatureDocScanEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [docSelection, setDocSelection] = useState<Record<string, boolean>>({});
  const [themeSelection, setThemeSelection] = useState<Record<string, boolean>>({});
  const [modelView, setModelView] = useState<ModelSelectionView | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void services.modelSelectionService.getView().then((view) => {
      if (cancelled) return;
      setModelView(view);
      setSelection((current) => {
        // 残留的无档位选择会被 account provider 拒绝（Reasoning level is required）：缺档补 low。
        if (current?.options?.reasoningLevel) return current;
        for (const provider of view.providers) {
          const healthy = provider.models.find((m) => m.modelId === DEFAULT_MODEL_ID);
          if (healthy) {
            // account provider 强制要求 reasoningLevel（日志：Reasoning level is required）；
            // 高档变体 $max/$high 个人套餐无 entitlement，用默认 low 档（2026-11-25 日志+数据证实）。
            return {
              providerId: provider.providerId,
              modelId: healthy.modelId,
              options: { reasoningLevel: "low" },
            };
          }
        }
        return view.preferredSelection ?? null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, services]);

  useEffect(() => {
    if (plan) {
      setThemeSelection(Object.fromEntries(plan.themes.map((t) => [t.name, true])));
    }
  }, [plan]);

  const modelOptions = useMemo(() => {
    if (!modelView) return [];
    return modelView.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
        label: `${provider.providerName}/${model.modelId}`,
      })),
    );
  }, [modelView]);

  const selectedDocs = useMemo(() => docs.filter((d) => docSelection[d.path]), [docs, docSelection]);

  const finish = (ok: boolean, message: string) => {
    toast(intl.formatMessage({ id: message }), { variant: ok ? "info" : "warning" });
    useFeatureDocAnalysisDialogStore.getState().reset();
  };

  const dispatch = async (
    build: (workspacePath: string) => string,
    meta: { label: string; batchCount?: number },
  ): Promise<{ sessionId: string; workspacePath: string } | null> => {
    const kbService = services.featureKnowledgeService;
    if (!kbService) {
      finish(false, "knowledge.analyzeDocsNoSession");
      return null;
    }
    let workspacePath: string;
    try {
      workspacePath = (await kbService.ensureDocAnalysisWorkspace()).workspacePath;
    } catch (error) {
      logger.warn("[feature-knowledge] 创建 zcode-kb 工作区失败", { error });
      finish(false, "knowledge.analyzeDocsFailed");
      return null;
    }
    // 分析会话给完全访问（yolo）：子智能体读文档/检索/提案不再逐工具确认（用户指定 2026-11-25）。
    const inherited = await resolveAnalysisSubmission(services, tabStore, workspacePath);
    const submission = selection
      ? { modelSelection: selection, mode: "yolo" as const, planEnabled: false }
      : inherited
        ? { ...inherited, mode: "yolo" as const }
        : undefined;
    let sessionId: string;
    try {
      // 建会话后立即发首条指令必须 deferred：session_input 有 session 外键，
      // 需 V4 admission 在首发前统一持久化 session 主记录（否则 FOREIGN KEY constraint failed，
      // 2026-11-25 host-command-drain 日志证实）。
      const created = await services.zcodeTaskService.createTask({
        workspacePath,
        mode: "yolo",
        deferPersistenceUntilFirstPrompt: true,
        ...(submission ? { modelSelection: submission.modelSelection } : {}),
      });
      sessionId = created.taskId;
    } catch (error) {
      logger.warn("[feature-knowledge] 文档分析会话创建失败", { error });
      finish(false, "knowledge.analyzeDocsFailed");
      return null;
    }
    // host 命令队列直接投递首条指令：会话已落库+显式模型，不依赖 pane 挂载/跳转/目录同步
    // （2026-11-25 多次实测 pane 桥接在新工作区竞态失败）。进度从「分析中」跳转查看。
    try {
      await services.zcodeTaskService.enqueueTaskCommand({
        workspacePath,
        taskId: sessionId,
        commandId: crypto.randomUUID(),
        traceId: crypto.randomUUID() as TraceId,
        type: "send_prompt",
        content: build(workspacePath),
        clientLabel: "feature-knowledge-doc-analysis",
      });
    } catch (error) {
      logger.warn("[feature-knowledge] 文档分析指令投递失败", { error, sessionId });
      finish(false, "knowledge.analyzeDocsFailed");
      return null;
    }
    const landed = await verifyInstructionLanded(services, sessionId, { workspacePath });
    if (!landed) {
      finish(false, "knowledge.analyzeDocsNotLanded");
      return null;
    }
    useFeatureAnalysisStore.getState().record({
      sessionId,
      workspacePath,
      kind: "docs",
      label: meta.label,
      ...(meta.batchCount ? { batchCount: meta.batchCount } : {}),
      startedAt: Date.now(),
    });
    return { sessionId, workspacePath };
  };

  const runScan = async () => {
    const paths = pathsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      toast(intl.formatMessage({ id: "knowledge.analyzeDocsEmpty" }), { variant: "warning" });
      return;
    }
    setBusy(true);
    const result = await kb.scanFeatureDocs(paths);
    setBusy(false);
    if (!result || result.docs.length === 0) {
      toast(intl.formatMessage({ id: "knowledge.analyzeDocsNoDocs" }), { variant: "warning" });
      return;
    }
    if (result.docs.length <= DOC_SCAN_DIRECT_LIMIT) {
      setBusy(true);
      const ok = await dispatch(
        () => buildFeatureDistillDocInstruction(result.docs.map((d) => d.path)),
        { label: paths[0] ?? "docs" },
      );
      setBusy(false);
      if (ok) finish(true, "knowledge.analyzeDocsSent");
      return;
    }
    setDocs(result.docs);
    setTruncated(result.truncated);
    setDocSelection(Object.fromEntries(result.docs.map((d) => [d.path, true])));
    useFeatureDocAnalysisDialogStore.getState().setStep("docs");
  };

  const runScout = async () => {
    if (selectedDocs.length === 0) {
      toast(intl.formatMessage({ id: "knowledge.analyzeDocsNoneSelected" }), { variant: "warning" });
      return;
    }
    setBusy(true);
    const ok = await dispatch(
      (workspacePath) =>
        buildFeatureDocScoutInstruction(
          selectedDocs.map((d) => d.path),
          `${workspacePath}/.zcode/doc-themes-plan.json`,
        ),
      { label: pathsText.split("\n")[0]?.trim() || "docs" },
    );
    setBusy(false);
    if (!ok) return;
    const state = useFeatureDocAnalysisDialogStore.getState();
    state.setScout({
      sessionId: ok.sessionId,
      planPath: `${ok.workspacePath}/.zcode/doc-themes-plan.json`,
      workspacePath: ok.workspacePath,
    });
    state.setStep("waiting");
    state.setOpen(false);
    toast(intl.formatMessage({ id: "knowledge.analyzeScoutDispatched" }), { variant: "info" });
  };

  const runThemes = async () => {
    if (!scout || !plan) return;
    const themes = plan.themes.filter((t) => themeSelection[t.name]);
    if (themes.length === 0) {
      toast(intl.formatMessage({ id: "knowledge.analyzeThemesNone" }), { variant: "warning" });
      return;
    }
    setBusy(true);
    try {
      await services.zcodeTaskService.enqueueTaskCommand({
        workspacePath: scout.workspacePath,
        taskId: scout.sessionId,
        commandId: crypto.randomUUID(),
        traceId: crypto.randomUUID() as TraceId,
        type: "send_prompt",
        content: buildFeatureDistillThemeInstruction(themes),
        clientLabel: "feature-knowledge-doc-analysis",
      });
      setBusy(false);
      finish(true, "knowledge.analyzeThemesSent");
    } catch (error) {
      logger.warn("[feature-knowledge] 主题提炼指令投递失败", { error });
      setBusy(false);
      finish(false, "knowledge.analyzeDocsFailed");
    }
  };

  const setStep = (next: DocAnalysisStep) =>
    useFeatureDocAnalysisDialogStore.getState().setStep(next);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && useFeatureDocAnalysisDialogStore.getState().setOpen(false)}
      modal={false}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "knowledge.analyzeDocs" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "knowledge.analyzeDocsHint" })}
          </DialogDescription>
        </DialogHeader>
        {step === "paths" ? (
          <>
            <textarea
              value={pathsText}
              onChange={(event) => setPathsText(event.target.value)}
              placeholder={intl.formatMessage({ id: "knowledge.analyzeDocsPlaceholder" })}
              rows={6}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-ui-sm text-foreground outline-none focus:border-input-border-focused"
            />
            <label className="flex items-center gap-2 text-ui-sm text-foreground">
              <span className="shrink-0 text-foreground-subtle">
                {intl.formatMessage({ id: "knowledge.analyzeModel" })}
              </span>
              <select
                value={selection ? `${selection.providerId}/${selection.modelId}` : ""}
                onChange={(event) => {
                  const [providerId, ...rest] = event.target.value.split("/");
                  const modelId = rest.join("/");
                  const found = modelOptions.find(
                    (o) => o.providerId === providerId && o.modelId === modelId,
                  );
                  if (found) {
                    setSelection({
                      providerId: found.providerId,
                      modelId: found.modelId,
                      options: { reasoningLevel: "low" },
                    });
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-ui-sm text-foreground"
              >
                {modelOptions.map((option) => (
                  <option
                    key={`${option.providerId}/${option.modelId}`}
                    value={`${option.providerId}/${option.modelId}`}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        {step === "docs" ? (
          <>
            <p className="text-ui-sm text-foreground">
              {intl.formatMessage({ id: "knowledge.analyzeDocsInventory" }, { count: docs.length })}
            </p>
            {truncated ? (
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "knowledge.analyzeDocsTruncated" },
                  { max: DOC_SCAN_MAX_DOCS },
                )}
              </p>
            ) : null}
            <div className="max-h-72 overflow-auto rounded-md border border-border p-2">
              {docs.map((doc) => (
                <label
                  key={doc.path}
                  className="flex items-start gap-2 rounded-md px-1 py-1 text-ui-sm hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={Boolean(docSelection[doc.path])}
                    disabled={busy}
                    onChange={(event) =>
                      setDocSelection((current) => ({
                        ...current,
                        [doc.path]: event.target.checked,
                      }))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{doc.title}</span>
                    <span className="block truncate text-ui-xs text-foreground-subtle">
                      {doc.path}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : null}
        {step === "themes" && plan ? (
          <FeatureDocThemePicker
            plan={plan}
            selection={themeSelection}
            busy={busy}
            onToggle={(name, checked) =>
              setThemeSelection((current) => ({ ...current, [name]: checked }))
            }
          />
        ) : null}
        <DialogFooter>
          {step === "docs" || step === "themes" ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setStep(step === "themes" ? "docs" : "paths")}
            >
              {intl.formatMessage({ id: "knowledge.analyzeDocsBack" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => useFeatureDocAnalysisDialogStore.getState().setOpen(false)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void (step === "paths" ? runScan() : step === "docs" ? runScout() : runThemes())
            }
          >
            {intl.formatMessage({ id: "knowledge.analyzeDocsStart" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}