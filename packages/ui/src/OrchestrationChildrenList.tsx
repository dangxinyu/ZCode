// 编排任务的子任务缩进列表（spec: packages/services/specs/orchestration-tasks.md）。
// 数据零新增查询：子任务行的 meta 自带 orchestrationParentTaskId（spawn/link 时盖、
// preserve 兜底），从列表同源 items 按 parent 分组即可。点击跳转子任务会话。
// 展开器在编排任务行的行首（TaskListItem 的 orchestrationExpander），本组件只负责
// 展开态的子任务行；收起态由调用方直接不渲染。
// 下拉内置顶：hover 图钉把子任务钉在该下拉最前（纯 UI 排序偏好，不进全局置顶区）。
// 取消关联：行尾解链按钮 → 确认弹窗（useConfirmDialog）→ 解除。
// 解除后编排不再收该任务的终态，误触代价高，必须弹窗二次确认。
import { memo } from "react";
import type {
  ZCodeOrchestrationPlanNode,
  ZCodeTaskMeta,
  ZCodeOrchestrationPlansMap,
} from "@zcode/shared";
import { Archive, ArrowUpRight, CornerDownRight, LoaderIcon, Pin, Unlink } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { Switch } from "@/components/ui/switch.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { useOrchestrationChildrenPinned } from "@/lib/orchestrationChildrenPinned.js";
import { resolveChildPlanNode } from "@/lib/orchestrationChildPlanNode.js";
import { openOrchestrationPlanPage } from "@/lib/orchestrationPlanSync.js";
import { OrchestrationPlanList } from "@/OrchestrationPlanList.js";

interface OrchestrationChildrenListProps {
  parentTaskId: string;
  /** 主任务工作区：计划条目点击要先跳主任务会话（计划页挂在主任务面板里）。 */
  parentWorkspacePath: string;
  parentWorkspaceIdentity?: string;
  childTasks: ZCodeTaskMeta[];
  isActiveTaskId: (task: ZCodeTaskMeta) => boolean;
  /** 单击行：打开子任务会话（不切视图、不滚动定位）。 */
  onOpenTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  /** 行尾 ↗ 按钮：跳转到项目列表定位（切视图 + 选中 + 滚动）。 */
  onJumpToTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  /** 计划列表数据（spec: orchestration-plan.md v2 多计划）；null/缺省 = 不渲染。 */
  plansMap?: ZCodeOrchestrationPlansMap | null;
  /**
   * 子条目行尾完成 toggle（用户需求 2026-11-20：任务目录直接改节点完成状态，不开画布）。
   * 画布"手动完成"同通道（setOrchestrationPlanNodeManualDone）：done=true → terminal
   * 并触发直接下游就绪扫描；done=false → pending 不触发。未命中节点的子任务不渲染按钮。
   */
  onToggleNodeDone?: (args: { planId: string; planNodeId: string; done: boolean }) => void;
  onCreatePlan?: () => void;
  onRenamePlan?: (planId: string, title: string) => void;
  onDeletePlan?: (planId: string) => void;
  planBusy?: boolean;
  /** 行尾解链按钮：用户手动取消关联（二次确认通过后调用）。 */
  onUnlinkTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  /**
   * 行尾归档按钮（用户确认 2026-10-23）：解链 + 归档一体（二次确认通过后调用）。
   * 归档不参与统筹（spec 硬性规定），挂在编排名下的任务归档前必须先解除关系。
   */
  onArchiveTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
}

/** 确认弹窗承担二次确认（useConfirmDialog），组件内不再有武装态。 */
function statusDotClass(status: ZCodeTaskMeta["status"]): string {
  if (status === "running") return "bg-status-running";
  if (status === "error") return "bg-status-error";
  if (status === "completed") return "bg-success";
  return "bg-foreground-subtlest";
}

/** 计划节点状态圆点配色（用户需求 2026-11-20：目录行与画布 statusRing 同语义）。
 * dispatched 的转圈由 phase 判定负责（isChildRunning），这里只决定非转圈时的颜色。 */
function nodeStatusDotClass(status: ZCodeOrchestrationPlanNode["status"]): string {
  if (status === "terminal") return "bg-success";
  if (status === "failed") return "bg-terminal-red";
  if (status === "dispatched") return "bg-status-running";
  if (status === "stale") return "bg-warning";
  return "bg-foreground-subtlest";
}

/** 节点状态 tooltip 文案键（zh-CN：待执行/执行中/已完成/待复核/失败）。 */
function nodeStatusLabelId(status: ZCodeOrchestrationPlanNode["status"]): string {
  if (status === "terminal") return "workspaceSidebar.orchestrationChildNodeTerminal";
  if (status === "failed") return "workspaceSidebar.orchestrationChildNodeFailed";
  if (status === "dispatched") return "workspaceSidebar.orchestrationChildNodeDispatched";
  if (status === "stale") return "workspaceSidebar.orchestrationChildNodeStale";
  return "workspaceSidebar.orchestrationChildNodePending";
}

/** 子行是否正在执行：sessions-index 实时 phase 优先；无 activity 时退持久化 running
 * （子任务下拉是瞬态视图，终态由通知/列表刷新兜底，短暂陈旧可接受）。
 * 导出供分区计算展开器的 runningCount（收起态显示"有活在跑"小转圈）。 */
export function isChildRunning(child: ZCodeTaskMeta): boolean {
  const phase = getTaskListRowActivity(child)?.phase;
  if (phase) return phase === "prewarming" || phase === "running";
  return child.status === "running";
}

const OrchestrationChildrenListComponent = ({
  parentTaskId,
  parentWorkspacePath,
  parentWorkspaceIdentity,
  childTasks,
  isActiveTaskId,
  onOpenTask,
  onJumpToTask,
  onUnlinkTask,
  onArchiveTask,
  plansMap,
  onToggleNodeDone,
  onCreatePlan,
  onRenamePlan,
  onDeletePlan,
  planBusy,
}: OrchestrationChildrenListProps) => {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const { isChildPinned, toggleChildPinned } = useOrchestrationChildrenPinned();
  // 钉住的子任务排最前，其余保持列表原序（updatedAt 排序由数据源保证）。
  // 刻意不做 useMemo：isChildPinned 是稳定引用（useCallback([])），依赖里没有钉选
  // 状态的版本信号，缓存会让钉选后的重排不生效（联调实测命中）；列表规模小，直接算。
  const orderedChildTasks = (() => {
    if (childTasks.length < 2) return childTasks;
    const pinned: ZCodeTaskMeta[] = [];
    const rest: ZCodeTaskMeta[] = [];
    for (const child of childTasks) {
      (isChildPinned(parentTaskId, child.taskId) ? pinned : rest).push(child);
    }
    return pinned.length > 0 ? [...pinned, ...rest] : childTasks;
  })();
  const planList =
    plansMap && plansMap.planMode && onCreatePlan && onRenamePlan && onDeletePlan ? (
      <OrchestrationPlanList
        parentTaskId={parentTaskId}
        plansMap={plansMap}
        busy={planBusy}
        onOpenPlan={(planId) => {
          // 计划页挂在主任务会话面板里，主任务未选中时只发页面信号看不见
          // （用户需求 2026-10-30：点计划要自动跳转）。onOpenTask 同步关掉旧
          // 计划页并选中主任务会话，随后打开目标计划页——计划间互切同一路径。
          onOpenTask(parentWorkspacePath, parentTaskId, parentWorkspaceIdentity);
          openOrchestrationPlanPage(parentTaskId, planId);
        }}
        onCreatePlan={onCreatePlan}
        onRenamePlan={onRenamePlan}
        onDeletePlan={onDeletePlan}
      />
    ) : null;
  // 右键菜单（用户确认 2026-11-11）：child taskId 即会话 id，写入剪贴板 + toast 反馈。
  const copyChildSessionId = (child: ZCodeTaskMeta) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard.writeText(child.taskId).then(
      () => {
        toast(intl.formatMessage({ id: "workspaceSidebar.orchestrationChildSessionIdCopied" }));
      },
      () => {
        // 写剪贴板失败（权限拒绝等）：静默，不打断列表交互。
      },
    );
  };
  if (childTasks.length === 0) {
    return (
      <>
        {planList}
        <li className="pl-8 pr-2 py-0.5 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workspaceSidebar.orchestrationNoChildren" })}
        </li>
      </>
    );
  }
  return (
    <li className="py-0.5" data-testid="orchestration-children-list">
      <ul className="space-y-0.5">
        {planList}
        {orderedChildTasks.map((child) => {
          const active = isActiveTaskId(child);
          const pinnedInDropdown = isChildPinned(parentTaskId, child.taskId);
          const taskKey = `${child.workspaceIdentity ?? child.workspacePath}:${child.taskId}`;
          const running = isChildRunning(child);
          // 命中计划节点（activePlanId 优先）：圆点与 tooltip 换节点状态口径，行尾补完成 toggle。
          const childNodeRef = resolveChildPlanNode(plansMap, child.taskId);
          return (
            <li key={taskKey}>
              {/* 右键菜单挂在整行（用户确认 2026-11-11），目前仅「复制会话 ID」。
                  Trigger asChild 直接用行 div：行内左键行为（打开会话/行尾按钮）不受影响。 */}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "group/orch-child flex h-7 w-full items-center gap-1.5 rounded-md pl-8 pr-2 text-left text-ui-base",
                      active
                        ? "bg-surface text-foreground"
                        : "text-foreground-subtle hover:bg-surface hover:text-foreground",
                    )}
                  >
                    {/* 单击只打开子任务会话（不切视图）；跳转定位是行尾 ↗ 按钮的显式动作。 */}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      onClick={() => {
                        onOpenTask(
                          child.workspacePath,
                          child.taskId,
                          child.workspaceIdentity,
                          child.unreadAt,
                        );
                      }}
                    >
                      <CornerDownRight
                        aria-hidden="true"
                        className="size-3 shrink-0 text-foreground-subtlest"
                      />
                      {running ? (
                        // 执行中：转圈指示（用户要求：不用挨个找谁在跑）。
                        <LoaderIcon
                          aria-label={intl.formatMessage({
                            id: "workspaceSidebar.orchestrationChildStatus",
                          })}
                          className="size-3 shrink-0 animate-spin text-foreground-subtle"
                        />
                      ) : childNodeRef ? (
                        // 节点状态口径（用户需求 2026-11-20）：与画布 statusRing 同语义配色，
                        // tooltip 显示节点状态文案；不再重复子任务自身 status。
                        <span
                          aria-label={intl.formatMessage({
                            id: nodeStatusLabelId(childNodeRef.node.status),
                          })}
                          title={intl.formatMessage({
                            id: nodeStatusLabelId(childNodeRef.node.status),
                          })}
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            nodeStatusDotClass(childNodeRef.node.status),
                          )}
                        />
                      ) : (
                        <span
                          aria-label={intl.formatMessage({
                            id: "workspaceSidebar.orchestrationChildStatus",
                          })}
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            statusDotClass(child.status),
                          )}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{child.title || child.taskId}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "workspaceSidebar.orchestrationChildJump",
                      })}
                      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 group-hover/orch-child:opacity-100 hover:text-foreground-subtle"
                      onClick={() => {
                        onJumpToTask(
                          child.workspacePath,
                          child.taskId,
                          child.workspaceIdentity,
                          child.unreadAt,
                        );
                      }}
                    >
                      <ArrowUpRight aria-hidden="true" className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "workspaceSidebar.orchestrationChildUnlink",
                      })}
                      title={intl.formatMessage({
                        id: "workspaceSidebar.orchestrationChildUnlink",
                      })}
                      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 group-hover/orch-child:opacity-100 hover:text-foreground-subtle"
                      onClick={() => {
                        // 二次确认走确认弹窗；确认后解除关联，子任务回归普通任务。
                        void (async () => {
                          const confirmed = await confirmDialog({
                            title: intl.formatMessage({
                              id: "confirmDialog.orchestrationChildUnlinkTitle",
                            }),
                            description: intl.formatMessage(
                              { id: "confirmDialog.orchestrationChildUnlinkDescription" },
                              { title: child.title || child.taskId },
                            ),
                            confirmLabel: intl.formatMessage({ id: "common.confirm" }),
                          });
                          if (!confirmed) {
                            return;
                          }
                          onUnlinkTask(child.workspacePath, child.taskId, child.workspaceIdentity);
                        })();
                      }}
                    >
                      <Unlink aria-hidden="true" className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "workspaceSidebar.orchestrationChildArchive",
                      })}
                      title={intl.formatMessage({
                        id: "workspaceSidebar.orchestrationChildArchive",
                      })}
                      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest opacity-0 group-hover/orch-child:opacity-100 hover:text-foreground-subtle"
                      onClick={() => {
                        // 归档 = 解链 + 移入归档区（spec 硬性规定：归档不参与统筹，
                        // 挂在编排名下必须先解除关系）。误触代价高于解链，同样二次确认。
                        void (async () => {
                          const confirmed = await confirmDialog({
                            title: intl.formatMessage({
                              id: "confirmDialog.orchestrationChildArchiveTitle",
                            }),
                            description: intl.formatMessage(
                              { id: "confirmDialog.orchestrationChildArchiveDescription" },
                              { title: child.title || child.taskId },
                            ),
                            confirmLabel: intl.formatMessage({ id: "common.confirm" }),
                          });
                          if (!confirmed) {
                            return;
                          }
                          onArchiveTask(child.workspacePath, child.taskId, child.workspaceIdentity);
                        })();
                      }}
                    >
                      <Archive aria-hidden="true" className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: pinnedInDropdown
                          ? "workspaceSidebar.orchestrationChildUnpin"
                          : "workspaceSidebar.orchestrationChildPin",
                      })}
                      aria-pressed={pinnedInDropdown}
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-sm",
                        pinnedInDropdown
                          ? "text-foreground-subtle"
                          : "text-foreground-subtlest opacity-0 group-hover/orch-child:opacity-100 hover:text-foreground-subtle",
                      )}
                      onClick={() => {
                        toggleChildPinned(parentTaskId, child.taskId);
                      }}
                    >
                      <Pin
                        aria-hidden="true"
                        className={cn("size-3", pinnedInDropdown && "fill-current")}
                      />
                    </button>
                    {childNodeRef && onToggleNodeDone ? (
                      // 完成 toggle（用户需求 2026-11-20）：滑块形态（用户反馈"图标不好看，
                      // 改成滑块"，再反馈"滑块有点大"→ xs 档；"放在四个功能按钮的最后边"）。
                      // 画布"手动完成"滑块同款 Switch。开 = terminal（触发直接下游就绪扫描），
                      // 关 = pending 不触发；常显表达完成状态。planBusy 期间禁用防连点。
                      <span
                        title={intl.formatMessage({
                          id:
                            childNodeRef.node.status === "terminal"
                              ? "workspaceSidebar.orchestrationChildUnmarkDone"
                              : "workspaceSidebar.orchestrationChildMarkDone",
                        })}
                        className="flex shrink-0 items-center"
                      >
                        <Switch
                          size="xs"
                          aria-label={intl.formatMessage({
                            id:
                              childNodeRef.node.status === "terminal"
                                ? "workspaceSidebar.orchestrationChildUnmarkDone"
                                : "workspaceSidebar.orchestrationChildMarkDone",
                          })}
                          checked={childNodeRef.node.status === "terminal"}
                          disabled={planBusy}
                          onCheckedChange={(checked) => {
                            onToggleNodeDone({
                              planId: childNodeRef.planId,
                              planNodeId: childNodeRef.node.nodeId,
                              done: checked,
                            });
                          }}
                        />
                      </span>
                    ) : null}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => {
                      copyChildSessionId(child);
                    }}
                  >
                    {intl.formatMessage({ id: "appHeader.copySessionId" })}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
    </li>
  );
};

export const OrchestrationChildrenList = memo(OrchestrationChildrenListComponent);
