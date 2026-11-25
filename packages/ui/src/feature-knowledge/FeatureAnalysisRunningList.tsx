// 知识库「分析中 / 分析完成」列表：登记过的分析会话 + live 子智能体状态 + 提案结果 + 点击跳转。
// running 态进「分析中」，跑完进「分析完成」（spec: feature-knowledge.md，用户确认 2026-11-25）。
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge.js";
import { useFeatureKnowledge } from "@/hooks/useFeatureKnowledge.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useFeatureAnalysisStore,
  type FeatureAnalysisEntry,
} from "@/store/featureKnowledgeAnalysisStore.js";

const POLL_INTERVAL_MS = 5000;

function AnalysisRow({
  entry,
  mode,
  onJump,
}: {
  entry: FeatureAnalysisEntry;
  mode: "running" | "done";
  onJump: (entry: FeatureAnalysisEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const dismiss = useFeatureAnalysisStore((state) => state.dismiss);
  const { proposals } = useFeatureKnowledge();
  const { running, ended, refresh } = useSessionSubagents({
    sessionId: entry.sessionId,
    workspacePath: entry.workspacePath,
    workspaceIdentity: entry.workspaceIdentity,
  });
  useEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  // 状态归页级轮询独占（tasks-index 真相源）；行只展示，避免 runtime 释放后覆写回 unknown。
  const active = entry.status === "running" || running.length > 0;
  // 提案 source.sessionId 是子智能体 id，不能直接匹配父会话；按 workspace + 起始时间归集。
  const workspaceKey = entry.workspaceIdentity?.trim() || entry.workspacePath;
  const mine = proposals.filter(
    (p) => p.source.workspaceKey === workspaceKey && p.createdAt >= entry.startedAt,
  );
  const committed = mine.filter((p) => p.status === "committed").length;
  const rejected = mine.filter((p) => p.status === "rejected").length;
  const pending = mine.filter((p) => p.status === "pending").length;
  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => onJump(entry)}
        className="w-full text-left hover:bg-surface-hover"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{entry.label}</span>
          <Badge variant={active ? "default" : "secondary"} className="h-4 px-1.5 text-ui-xs">
            {active
              ? intl.formatMessage({ id: "knowledge.analyzingRunning" }, { count: running.length })
              : intl.formatMessage({ id: "knowledge.analyzingDone" })}
          </Badge>
        </span>
        <span className="mt-0.5 block truncate text-ui-xs text-foreground-subtle">
          {entry.kind === "docs"
            ? intl.formatMessage({ id: "knowledge.analyzingDocs" }, { count: entry.batchCount ?? 1 })
            : intl.formatMessage({ id: "knowledge.analyzingDistill" })}
          {" · "}
          {entry.sessionId}
        </span>
        <span className="block truncate text-ui-xs text-foreground-subtle">
          {entry.workspacePath}
          {ended.total > 0
            ? ` · ${intl.formatMessage({ id: "knowledge.analyzingEnded" }, { count: ended.total })}`
            : ""}
        </span>
        {mode === "done" && mine.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {pending > 0 ? (
              <Badge variant="destructive" className="h-4 px-1.5 text-ui-xs">
                {intl.formatMessage({ id: "knowledge.outcomePending" }, { count: pending })}
              </Badge>
            ) : null}
            {committed > 0 ? (
              <Badge variant="secondary" className="h-4 px-1.5 text-ui-xs">
                {intl.formatMessage({ id: "knowledge.outcomeCommitted" }, { count: committed })}
              </Badge>
            ) : null}
            {rejected > 0 ? (
              <Badge variant="outline" className="h-4 px-1.5 text-ui-xs">
                {intl.formatMessage({ id: "knowledge.outcomeRejected" }, { count: rejected })}
              </Badge>
            ) : null}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => dismiss(entry.sessionId)}
        className="mt-1 text-ui-xs text-foreground-subtle underline hover:text-foreground"
      >
        {intl.formatMessage({ id: "knowledge.analyzingDismiss" })}
      </button>
    </li>
  );
}

export function FeatureAnalysisRunningList({
  mode,
  onJump,
}: {
  mode: "running" | "done";
  onJump: (entry: FeatureAnalysisEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const entries = useFeatureAnalysisStore((state) => state.entries);
  const visible = entries.filter((entry) =>
    mode === "done" ? entry.status === "done" : entry.status !== "done",
  );
  if (visible.length === 0) {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({
          id: mode === "done" ? "knowledge.analyzingDoneEmpty" : "knowledge.analyzingEmpty",
        })}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {visible.map((entry) => (
        <AnalysisRow key={entry.sessionId} entry={entry} mode={mode} onJump={onJump} />
      ))}
    </ul>
  );
}