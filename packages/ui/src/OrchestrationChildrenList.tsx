// 编排任务的子任务缩进列表（spec: packages/services/specs/orchestration-tasks.md）。
// 数据零新增查询：子任务行的 meta 自带 orchestrationParentTaskId（spawn/link 时盖、
// preserve 兜底），从列表同源 items 按 parent 分组即可。点击跳转子任务会话。
// 展开器在编排任务行的行首（TaskListItem 的 orchestrationExpander），本组件只负责
// 展开态的子任务行；收起态由调用方直接不渲染。
// 下拉内置顶：hover 图钉把子任务钉在该下拉最前（纯 UI 排序偏好，不进全局置顶区）。
import { memo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { ArrowUpRight, CornerDownRight, Pin } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
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
}

function statusDotClass(status: ZCodeTaskMeta["status"]): string {
  if (status === "running") return "bg-status-running";
  if (status === "error") return "bg-status-error";
  if (status === "completed") return "bg-success";
  return "bg-foreground-subtlest";
}

const OrchestrationChildrenListComponent = ({
  parentTaskId,
  childTasks,
  isActiveTaskId,
  onOpenTask,
  onJumpToTask,
}: OrchestrationChildrenListProps) => {
  const { intl } = useZCodeIntl();
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
          return (
            <li key={`${child.workspaceIdentity ?? child.workspacePath}:${child.taskId}`}>
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
                  <span
                    aria-label={intl.formatMessage({ id: "workspaceSidebar.orchestrationChildStatus" })}
                    className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(child.status))}
                  />
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
