// 编排任务的子任务缩进列表（spec: packages/services/specs/orchestration-tasks.md）。
// 数据零新增查询：子任务行的 meta 自带 orchestrationParentTaskId（spawn/link 时盖、
// preserve 兜底），从列表同源 items 按 parent 分组即可。点击跳转子任务会话。
// 展开器在编排任务行的行首（TaskListItem 的 orchestrationExpander），本组件只负责
// 展开态的子任务行；收起态由调用方直接不渲染。
// 下拉内置顶：hover 图钉把子任务钉在该下拉最前（纯 UI 排序偏好，不进全局置顶区）。
// 取消关联：行尾解链按钮 → 确认弹窗（useConfirmDialog）→ 解除。
// 解除后编排不再收该任务的终态，误触代价高，必须弹窗二次确认。
import { memo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { ArrowUpRight, CornerDownRight, LoaderIcon, Pin, Unlink } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { cn } from "@/components/lib/utils.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { useOrchestrationChildrenPinned } from "@/lib/orchestrationChildrenPinned.js";

interface OrchestrationChildrenListProps {
  parentTaskId: string;
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
  /** 行尾解链按钮：用户手动取消关联（二次确认通过后调用）。 */
  onUnlinkTask: (
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
  childTasks,
  isActiveTaskId,
  onOpenTask,
  onJumpToTask,
  onUnlinkTask,
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
  if (childTasks.length === 0) {
    return (
      <li className="pl-8 pr-2 py-0.5 text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "workspaceSidebar.orchestrationNoChildren" })}
      </li>
    );
  }
  return (
    <li className="py-0.5" data-testid="orchestration-children-list">
      <ul className="space-y-0.5">
        {orderedChildTasks.map((child) => {
          const active = isActiveTaskId(child);
          const pinnedInDropdown = isChildPinned(parentTaskId, child.taskId);
          const taskKey = `${child.workspaceIdentity ?? child.workspacePath}:${child.taskId}`;
          const running = isChildRunning(child);
          return (
            <li key={taskKey}>
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
                    onOpenTask(child.workspacePath, child.taskId, child.workspaceIdentity, child.unreadAt);
                  }}
                >
                  <CornerDownRight aria-hidden="true" className="size-3 shrink-0 text-foreground-subtlest" />
                  {running ? (
                    // 执行中：转圈指示（用户要求：不用挨个找谁在跑）。
                    <LoaderIcon
                      aria-label={intl.formatMessage({ id: "workspaceSidebar.orchestrationChildStatus" })}
                      className="size-3 shrink-0 animate-spin text-foreground-subtle"
                    />
                  ) : (
                    <span
                      aria-label={intl.formatMessage({ id: "workspaceSidebar.orchestrationChildStatus" })}
                      className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(child.status))}
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
                    onJumpToTask(child.workspacePath, child.taskId, child.workspaceIdentity, child.unreadAt);
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
                  <Pin aria-hidden="true" className={cn("size-3", pinnedInDropdown && "fill-current")} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
};

export const OrchestrationChildrenList = memo(OrchestrationChildrenListComponent);
