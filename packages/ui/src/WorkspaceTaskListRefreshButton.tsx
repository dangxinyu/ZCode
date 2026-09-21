import { TID_TASK_LIST_REFRESH } from "@zcode/shared";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { bumpTaskListManualRefresh } from "@/v4/taskListManualRefresh.js";

/**
 * 侧栏底部「刷新任务列表」按钮。tasks-index.sqlite 可被其他进程（官方客户端等）直接写入，
 * 本进程事件链路感知不到；这里统一失效两类任务列表缓存后走既有查询路径重查，
 * 按钮本身不直接发起查询，也不持有业务状态。
 */
export function WorkspaceTaskListRefreshButton() {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "workspaceHeader.taskListRefresh" });

  return (
    <ControlHintTooltip title={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        data-testid={TID_TASK_LIST_REFRESH}
        aria-label={label}
        onClick={() => {
          // manual refresh serial 让 controller channel（置顶/归档/时间线/搜索）queryCache 版本 miss；
          // membership bump 让 sidebar 普通 workspace 列表缓存标脏，各自经既有链路重查。
          bumpTaskListManualRefresh();
          bumpTaskListMembershipVersion();
        }}
      >
        <RefreshCwIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
