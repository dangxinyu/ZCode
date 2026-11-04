// 编排计划页工具栏（spec: packages/services/specs/orchestration-plan.md）。
// 返回对话 / 添加节点 / 撤销·重做 / 保存计划（有修改即常驻；图不合法时点击只做提示）/ 确认执行。
import {
  ArrowLeftIcon,
  CheckIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SaveIcon,
  Undo2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export interface OrchestrationPlanPageToolbarProps {
  editable: boolean;
  dirty: boolean;
  hasNodes: boolean;
  /** 图预检不通过的原因文案（悬空/环/缺起始）；null = 合法。 */
  saveBlockedReason: string | null;
  /** 不合法时点过保存 → 原因文案强调一次。 */
  saveBlockedPulse: boolean;
  busy: boolean;
  /** 撤销/重做（用户需求 2026-11-02）：栈空时禁用；快捷键 ⌘Z / ⌘⇧Z 与按钮同一入口。 */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 确认后的执行进度（done/total，非起始节点口径）；null = 不展示。 */
  progress: { done: number; total: number } | null;
  /** 仅草稿态可确认（confirmed 计划保持可编辑但不复现确认按钮）。 */
  canConfirm: boolean;
  /**
   * 计划级执行按钮（用户需求 2026-11-02）：确认后有待执行节点时出现；部分执行 →
   * "继续执行"。disabledReason 非空 = 禁用并提示（有节点执行中 / 无满足依赖的节点）。
   */
  executePlan: { label: "execute" | "continue"; disabledReason: string | null } | null;
  onExecutePlan: () => void;
  onBack: () => void;
  onAddNode: () => void;
  /** 整理布局（用户需求 2026-11-04）：编辑缓冲全量重排（入撤销栈），随保存落库不自动存。 */
  onTidyLayout: () => void;
  onSave: () => void;
  onConfirm: () => void;
}

export function OrchestrationPlanPageToolbar({
  editable,
  dirty,
  hasNodes,
  saveBlockedReason,
  saveBlockedPulse,
  busy,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  progress,
  canConfirm,
  executePlan,
  onExecutePlan,
  onBack,
  onAddNode,
  onTidyLayout,
  onSave,
  onConfirm,
}: OrchestrationPlanPageToolbarProps) {
  const { intl } = useZCodeIntl();
  const undoLabel = intl.formatMessage({ id: "orchestration.plan.undo" });
  const redoLabel = intl.formatMessage({ id: "orchestration.plan.redo" });
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
      <Button type="button" size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        {intl.formatMessage({ id: "orchestration.plan.backToChat" })}
      </Button>
      {editable ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAddNode}>
          <PlusIcon aria-hidden="true" className="size-3.5" />
          {intl.formatMessage({ id: "orchestration.plan.addNode" })}
        </Button>
      ) : null}
      {/* 撤销/重做：只图标，title 带快捷键；栈空禁用（与 ⌘Z / ⌘⇧Z 同一入口） */}
      {editable ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="px-1.5"
            disabled={busy || !canUndo}
            aria-label={undoLabel}
            title={undoLabel}
            onClick={onUndo}
          >
            <Undo2Icon aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="px-1.5"
            disabled={busy || !canRedo}
            aria-label={redoLabel}
            title={redoLabel}
            onClick={onRedo}
          >
            <Redo2Icon aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {/* 整理布局（用户需求 2026-11-04）：分层布局算法全量重排（消连线交叉）；
          只改编辑缓冲，保存按钮/⌘S 落库，⌘Z 可退。 */}
      {editable && hasNodes ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onTidyLayout}>
          <WorkflowIcon aria-hidden="true" className="size-3.5" />
          {intl.formatMessage({ id: "orchestration.plan.tidyLayout" })}
        </Button>
      ) : null}
      {/* 保存按钮：有修改就常驻（用户需求点 6）；图不合法时点击只强调原因，不保存 */}
      {editable && dirty ? (
        <Button type="button" size="sm" disabled={busy} onClick={onSave}>
          <SaveIcon aria-hidden="true" className="size-3.5" />
          {intl.formatMessage({ id: "orchestration.plan.savePlan" })}
        </Button>
      ) : null}
      {executePlan ? (
        <Button
          type="button"
          size="sm"
          disabled={busy || executePlan.disabledReason !== null}
          title={executePlan.disabledReason ?? undefined}
          onClick={onExecutePlan}
        >
          <PlayIcon aria-hidden="true" className="size-3.5" />
          {intl.formatMessage({
            id:
              executePlan.label === "continue"
                ? "orchestration.plan.continuePlan"
                : "orchestration.plan.executePlan",
          })}
        </Button>
      ) : null}
      {progress ? (
        <span
          className="ml-auto shrink-0 text-ui-xs text-foreground-subtle"
          data-testid="orchestration-plan-progress"
        >
          {intl.formatMessage(
            { id: "orchestration.plan.progress" },
            { done: progress.done, total: progress.total },
          )}
        </span>
      ) : null}
      {canConfirm && editable && !dirty && hasNodes && !saveBlockedReason ? (
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
          <CheckIcon aria-hidden="true" className="size-3.5" />
          {intl.formatMessage({ id: "orchestration.plan.confirm" })}
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2 text-ui-xs text-foreground-subtlest">
        {saveBlockedReason ? (
          <span className={saveBlockedPulse ? "font-medium text-warning" : "text-warning/90"}>
            {saveBlockedReason}
          </span>
        ) : editable ? (
          intl.formatMessage({ id: "orchestration.plan.editModeHint" })
        ) : (
          intl.formatMessage({ id: "orchestration.plan.viewModeHint" })
        )}
      </div>
    </div>
  );
}
