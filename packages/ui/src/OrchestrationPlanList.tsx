// 编排计划列表 v3（spec: packages/services/specs/orchestration-plan.md）。
// 计划模式开启时展示；行 = 状态点 + 标题 + 进度 + 「当前」徽标；点击行 → 经调用方
// 跳到主任务会话并打开该计划页（独立视图非弹窗）。右键菜单：重命名 / 删除（二次确认）。
// 尾部"新计划"入口：创建空计划（draft、0 节点）并进入计划页编辑。
import { memo, useState } from "react";
import type { ZCodeOrchestrationPlan, ZCodeOrchestrationPlansMap } from "@zcode/shared";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  ListChecks,
  LoaderIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlert,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOrchestrationPlanPageRequest } from "@/lib/orchestrationPlanSync.js";

export interface OrchestrationPlanListProps {
  parentTaskId: string;
  plansMap: ZCodeOrchestrationPlansMap;
  /** 点击计划条目：由调用方先切到主任务会话再打开该计划页（计划页挂在主任务面板里）。 */
  onOpenPlan: (planId: string) => void;
  onCreatePlan: () => void;
  onRenamePlan: (planId: string, title: string) => void;
  onDeletePlan: (planId: string) => void;
  busy?: boolean;
}

function planStatusIcon(
  status: ZCodeOrchestrationPlan["status"],
  hasStale: boolean,
  hasRunning: boolean,
) {
  if (status === "completed") {
    return <CircleCheck aria-hidden="true" className="size-3 shrink-0 text-success" />;
  }
  if (status === "draft") {
    return <CircleDashed aria-hidden="true" className="size-3 shrink-0 text-warning" />;
  }
  if (hasStale) {
    return <TriangleAlert aria-hidden="true" className="size-3 shrink-0 text-warning" />;
  }
  // 只有真有节点在执行（dispatched）才转圈；confirmed 但无执行中节点 = 待执行，静态图标
  //（此前 confirmed 一律转圈，节点卡住时看起来"一直执行中"，用户实测）。
  if (hasRunning) {
    return (
      <LoaderIcon aria-hidden="true" className="size-3 shrink-0 animate-spin text-status-running" />
    );
  }
  return <CirclePlay aria-hidden="true" className="size-3 shrink-0 text-status-running" />;
}

export const OrchestrationPlanList = memo(function OrchestrationPlanList({
  parentTaskId,
  plansMap,
  onOpenPlan,
  onCreatePlan,
  onRenamePlan,
  onDeletePlan,
  busy = false,
}: OrchestrationPlanListProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const pageRequest = useOrchestrationPlanPageRequest();
  // 「当前」= 主区正在查看的计划（计划页开着谁就标谁，用户需求 2026-10-30：
  // 徽标必须与主会话选择的视图一致），与服务端 activePlanId（agent 执行口径）
  // 解耦；无 focus 的打开（composer 入口）页面显示 active 计划，徽标跟随。
  const viewedPlanId =
    pageRequest?.sessionId === parentTaskId
      ? (pageRequest.focusPlanId ?? plansMap.activePlanId)
      : null;
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState<ZCodeOrchestrationPlan | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (!plansMap.planMode) return null;

  return (
    <div className="py-0.5 pl-8 pr-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-ui-base text-foreground-subtle hover:text-foreground"
      >
        {expanded ? (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        <ListChecks aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">
          {intl.formatMessage({ id: "orchestration.plan.listTitle" })}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">{plansMap.plans.length}</span>
      </button>
      {expanded ? (
        <>
          <ul className="mt-0.5 space-y-0.5">
            {plansMap.plans.map((plan) => {
              // 进度口径 = 非起始节点（起始只是结构标记，不产出，用户需求 2026-10-30）。
              const taskNodes = plan.nodes.filter((node) => !node.isStart);
              const done = taskNodes.filter((node) => node.status === "terminal").length;
              const hasStale = plan.nodes.some((node) => node.status === "stale");
              const hasRunning = plan.nodes.some((node) => node.status === "dispatched");
              const isViewed = viewedPlanId === plan.planId;
              return (
                <li key={plan.planId}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={busy}
                        title={intl.formatMessage({ id: "orchestration.plan.openCanvasHint" })}
                        onClick={() => onOpenPlan(plan.planId)}
                        className={cn(
                          "flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md pl-4 pr-2 text-left text-ui-base",
                          isViewed
                            ? "bg-surface text-foreground"
                            : "text-foreground-subtle hover:bg-surface hover:text-foreground",
                        )}
                      >
                        {planStatusIcon(plan.status, hasStale, hasRunning)}
                        <span className="min-w-0 flex-1 truncate">{plan.title}</span>
                        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage(
                            { id: "orchestration.plan.progress" },
                            { done, total: taskNodes.length },
                          )}
                        </span>
                        <span className="shrink-0 rounded-sm bg-surface px-1 text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({
                            id:
                              plan.origin === "manual"
                                ? "orchestration.plan.originManual"
                                : "orchestration.plan.originAgent",
                          })}
                        </span>
                        {isViewed ? (
                          <span className="shrink-0 rounded-sm bg-accent/15 px-1 text-ui-xs text-accent">
                            {intl.formatMessage({ id: "orchestration.plan.activeBadge" })}
                          </span>
                        ) : null}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => {
                          setRenaming(plan);
                          setRenameValue(plan.title);
                        }}
                      >
                        <PencilIcon aria-hidden="true" className="size-3.5" />
                        {intl.formatMessage({ id: "orchestration.plan.rename" })}
                      </ContextMenuItem>
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => {
                          void confirmDialog({
                            title: intl.formatMessage(
                              { id: "orchestration.plan.deleteConfirmTitle" },
                              { title: plan.title },
                            ),
                            description: intl.formatMessage({
                              id: "orchestration.plan.deleteConfirmDescription",
                            }),
                            confirmLabel: intl.formatMessage({ id: "orchestration.plan.delete" }),
                          }).then((confirmed) => {
                            if (confirmed) onDeletePlan(plan.planId);
                          });
                        }}
                      >
                        <Trash2Icon aria-hidden="true" className="size-3.5" />
                        {intl.formatMessage({ id: "orchestration.plan.delete" })}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={onCreatePlan}
            className="mt-0.5 flex h-6 w-full items-center gap-1.5 rounded-md pl-4 pr-2 text-left text-ui-base text-foreground-subtle hover:bg-surface hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">
              {intl.formatMessage({ id: "orchestration.plan.newPlanEntry" })}
            </span>
          </button>
        </>
      ) : null}

      {/* 重命名对话框：回车即保存（用户需求 2026-10-29） */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "orchestration.plan.rename" })}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming && renameValue.trim().length > 0 && !busy) {
                onRenamePlan(renaming.planId, renameValue.trim());
                setRenaming(null);
              }
            }}
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="h-8 w-full rounded-md border border-border-subtle bg-background px-2 text-ui-base text-foreground"
            />
            <DialogFooter>
              <Button type="button" size="sm" variant="outline" onClick={() => setRenaming(null)}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button type="submit" size="sm" disabled={busy || renameValue.trim().length === 0}>
                {intl.formatMessage({ id: "common.save" })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
});
