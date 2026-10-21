/* eslint-disable max-lines -- timeline 同时承载本地 scoped 查询、远端主动缓存和任务操作分发，先集中保持链路清晰。 */
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { isOrchestrationTask } from "@zcode/shared";
import { OrchestrationChildrenList, isChildRunning } from "@/OrchestrationChildrenList.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { useOrchestrationChildrenCollapsed } from "@/lib/orchestrationChildrenCollapse.js";
import { useOrchestrationWorkspaceGroupsCollapsed } from "@/lib/orchestrationWorkspaceGroupsCollapse.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskTimelineGroupMessage, groupTaskTimelineItems } from "@/lib/taskTimelineGroups.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import {
  bumpTaskListManualRefresh,
  useTaskListManualRefreshSerial,
} from "@/v4/taskListManualRefresh.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { logger } from "@/logger.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";

/** timeline 分组的统一形状：日期分组只带 label；编排的工作区分组带 workspace 字段。 */
interface TimelineTaskGroup {
  key: string;
  label: Parameters<typeof getTaskTimelineGroupMessage>[0] | null;
  /** 编排工作区分组：工作区显示名（tab 名或目录末段）。 */
  workspaceName?: string;
  /** 与 workspaceName 配对的完整路径（组头悬停 title）。 */
  workspacePath?: string;
  /** 与 workspaceName 配对的 workspace key（分组折叠态的持久化键）。 */
  workspaceKey?: string;
  items: ZCodeTaskMeta[];
}

function buildTimelineItemKey(workspacePath: string, taskId: string, workspaceIdentity?: string) {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

interface TimelineTaskItemHandlers {
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: ReactMouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu: (taskId: string) => void;
}

export function WorkspaceTimelineTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  groupByDate = true,
  taskRowVariant = "timeline",
  emptyMessage,
  excludeOrchestration = true,
  orchestrationOnly = false,
  onOrchestrationChildJump,
  onSelectTask,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  groupByDate?: boolean;
  taskRowVariant?: "default" | "timeline";
  emptyMessage?: string;
  /**
   * 普通时间线默认排除编排主任务（spec: orchestration-tasks.md）。
   * 行 role 来自 tasks-index 标记，首次 spawn 自愈盖标记前可能滞后（短暂双显，已知降级）。
   */
  excludeOrchestration?: boolean;
  /** 「编排」分区模式：只显示编排主任务，行交互与项目/时间线完全一致（归档→归档区删除）。 */
  orchestrationOnly?: boolean;
  /**
   * 子任务跳转覆盖（spec: orchestration-tasks.md）：编排分区里点击子任务时，
   * 由侧栏注入"切到项目视图 + 选中该任务"的组合动作；缺省回落 onSelectTask。
   */
  onOrchestrationChildJump?: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const scopedWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs,
  });
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [pendingArchiveItemKey, setPendingArchiveItemKey] = useState<string | null>(null);
  const [renamingItemKey, setRenamingItemKey] = useState<string | null>(null);
  const [contextMenuItemKey, setContextMenuItemKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // timeline 不应沿用 10 条首屏限制，和其它 sidebar 列表的 20 条基准保持一致。
  // 这里把首屏和每次“显示更多”的阶梯统一成 20，避免用户误以为列表只加载到 10/20 就结束。
  const collapsedLimit = 20;
  const [visibleTaskLimit, setVisibleTaskLimit] = useState(collapsedLimit);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveItemKeyRef = useRef<string | null>(pendingArchiveItemKey);
  const renamingItemKeyRef = useRef<string | null>(renamingItemKey);
  const taskSortByRef = useRef(taskSortBy);
  const intlRef = useRef(intl);
  const onSelectTaskRef = useRef(onSelectTask);
  const removeTaskStateRef = useRef(removeTaskState);
  const upsertOptimisticTaskListItemRef = useRef(upsertOptimisticTaskListItem);
  const removeOptimisticTaskListItemRef = useRef(removeOptimisticTaskListItem);
  const setTaskUnreadIndicatorRef = useRef(setTaskUnreadIndicator);
  const taskItemHandlersByKeyRef = useRef(new Map<string, TimelineTaskItemHandlers>());
  pendingArchiveItemKeyRef.current = pendingArchiveItemKey;
  renamingItemKeyRef.current = renamingItemKey;
  taskSortByRef.current = taskSortBy;
  intlRef.current = intl;
  onSelectTaskRef.current = onSelectTask;
  removeTaskStateRef.current = removeTaskState;
  upsertOptimisticTaskListItemRef.current = upsertOptimisticTaskListItem;
  removeOptimisticTaskListItemRef.current = removeOptimisticTaskListItem;
  setTaskUnreadIndicatorRef.current = setTaskUnreadIndicator;
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const workspaceTabsSignature = useMemo(
    () =>
      workspaceTabs
        .map((tab) => `${tab.workspaceIdentity?.trim() || tab.workspacePath}:${tab.workspacePath}`)
        .join("|"),
    [workspaceTabs],
  );
  const {
    items: localItems,
    total: localTotal,
    hasMore: localHasMore,
    loading: localLoading,
  } = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs: scopedWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: false,
    collapsedLimit: visibleTaskLimit,
  });
  const remoteTimelineItemsByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.itemsByWorkspaceKey,
  );
  const remoteTimelineLoadingByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.loadingByWorkspaceKey,
  );
  const remoteTimelineTotalByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.totalByWorkspaceKey,
  );
  const remoteTimelineHasMoreByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.hasMoreByWorkspaceKey,
  );
  const remoteWorkspaceKeys = useMemo(
    () => [
      ...new Set(
        workspaceTabs
          .filter((tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
          .map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)),
      ),
    ],
    [workspaceTabs],
  );
  const remoteItems = useMemo(() => {
    return remoteWorkspaceKeys.flatMap(
      (workspaceKey) => remoteTimelineItemsByWorkspaceKey[workspaceKey] ?? [],
    );
  }, [remoteTimelineItemsByWorkspaceKey, remoteWorkspaceKeys]);
  const sortedItems = useMemo(() => {
    return [...localItems, ...remoteItems]
      .filter((item) =>
        orchestrationOnly
          ? isOrchestrationTask(item)
          : excludeOrchestration && isOrchestrationTask(item)
            ? false
            : true,
      )
      .sort((left, right) => compareZCodeTaskListItems(left, right, taskSortBy));
  }, [excludeOrchestration, localItems, orchestrationOnly, remoteItems, taskSortBy]);
  // 编排分区的子任务索引（spec: orchestration-tasks.md）：子任务行 meta 自带
  // orchestrationParentTaskId。索引源必须是"三桶并集"（timeline + pinned + archived，
  // 各无 limit）——关联子任务常常已被置顶/归档/沉在深页，分区自身条目只含 timeline
  // 首页，只用它建索引会让父行子任务数严重失真（webworkspace 16 关联只显示 1 实测）。
  // 非编排模式传空 tabs：hook 直接空返回，零查询开销。
  const indexOnlyWorkspaceTabs = orchestrationOnly ? scopedWorkspaceTabs : [];
  const { items: pinnedIndexItems } = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs: indexOnlyWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
  });
  const { items: archivedIndexItems } = useGlobalTaskList({
    kind: "archived",
    workspaceTabs: indexOnlyWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
  });
  // 用户手动取消关联：透传任务服务，成功后 bump 全局刷新串号——所有 useGlobalTaskList
  // 实例（时间线/置顶/归档索引、本分区与置顶区）统一强制缓存 miss 重拉，
  // 子任务从父行下拉原地消失并回到普通分区（局部 refresh 只覆盖本组件实例，会漏）。
  const unlinkOrchestrationChild = useCallback(
    (params: {
      orchestrationTaskId: string;
      childWorkspacePath: string;
      childTaskId: string;
      childWorkspaceIdentity?: string;
    }) => {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(params.childWorkspacePath, params.childWorkspaceIdentity),
      );
      if (!workspaceServices) {
        return;
      }
      void workspaceServices.services.zcodeTaskService
        .unlinkOrchestrationChild({
          orchestrationTaskId: params.orchestrationTaskId,
          workspacePath: params.childWorkspacePath,
          ...(params.childWorkspaceIdentity
            ? { workspaceIdentity: params.childWorkspaceIdentity }
            : {}),
          childTaskId: params.childTaskId,
        })
        .then((result) => {
          if (!result.unlinked) {
            toast(intl.formatMessage({ id: "workspaceSidebar.orchestrationChildUnlinkFailed" }));
            return;
          }
          bumpTaskListManualRefresh();
        })
        .catch(() => {
          toast(intl.formatMessage({ id: "workspaceSidebar.orchestrationChildUnlinkFailed" }));
        });
    },
    [intl, workspaceServiceLookup],
  );
  // 权威子关系（links）按编排拉取：多编排跟踪下 tasks 行的 parent 列只记首个父，
  // 第二父的下拉/计数必须查 links。触达面：编排分区可见的 orchestrator 行
  // （数量级小）；手动刷新串号变化时重拉。
  const manualRefreshSerial = useTaskListManualRefreshSerial();
  // 用未分页的 sortedItems 聚合 orchestrator id 集（items 定义在本块之后且被分页截断）。
  const orchestratorIdsKey = sortedItems
    .filter((item) => isOrchestrationTask(item))
    .map((item) => item.taskId)
    .join(",");
  const [authoritativeLinksByParentId, setAuthoritativeLinksByParentId] = useState<Record<
    string,
    Array<{ childTaskId: string; kind: "derived" | "linked" }>
  > | null>(null);
  useEffect(() => {
    if (!orchestrationOnly || orchestratorIdsKey.length === 0) {
      setAuthoritativeLinksByParentId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // 按编排任务所在 workspace 分组逐组查询再合并：任务服务按 workspace 定位
      // tasks-index，用首个 tab 的 scope 查全部编排会把别的 workspace 的编排查成空
      // （实测命中：scope[0]=server 时 webworkspace 编排计数恒 0）。
      const orchestratorsByWorkspace = new Map<
        string,
        { workspacePath: string; workspaceIdentity?: string; ids: string[] }
      >();
      for (const item of sortedItems) {
        if (!isOrchestrationTask(item)) continue;
        const key = buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity);
        const group = orchestratorsByWorkspace.get(key);
        if (group) {
          group.ids.push(item.taskId);
        } else {
          orchestratorsByWorkspace.set(key, {
            workspacePath: item.workspacePath,
            workspaceIdentity: item.workspaceIdentity,
            ids: [item.taskId],
          });
        }
      }
      try {
        const merged: Record<
          string,
          Array<{ childTaskId: string; kind: "derived" | "linked" }>
        > = {};
        for (const group of orchestratorsByWorkspace.values()) {
          const workspaceServices = workspaceServiceLookup.get(
            buildTaskWorkspaceKey(group.workspacePath, group.workspaceIdentity),
          );
          if (!workspaceServices) continue;
          const map =
            await workspaceServices.services.zcodeTaskService.listOrchestrationChildrenMap({
              orchestrationTaskIds: group.ids,
              workspacePath: group.workspacePath,
              ...(group.workspaceIdentity ? { workspaceIdentity: group.workspaceIdentity } : {}),
            });
          Object.assign(merged, map);
        }
        if (!cancelled) setAuthoritativeLinksByParentId(merged);
      } catch {
        // links 拉取失败时退回 parent 列索引（首父正确，第二父缺失），不阻断渲染。
        if (!cancelled) setAuthoritativeLinksByParentId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // orchestratorIdsKey 聚合 id 集变化；serial 驱动手动刷新后重拉。
  }, [
    orchestrationOnly,
    orchestratorIdsKey,
    manualRefreshSerial,
    sortedItems,
    workspaceServiceLookup,
  ]);
  // 子任务行执行指示的活流源：sessions-index 聚合 meta（phase 实时、响应式）。
  // syncer 对 running 帧不落库不广播（processSummary 只处理终态/标题），静态列表
  // 在子任务运行期间 status 停在 completed——下拉的转圈必须以这里的活流 meta 为准。
  const { items: liveSessionItems } = useWorkspaceSessionsIndexItems(
    orchestrationOnly
      ? scopedWorkspaceTabs.map((tab) => ({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        }))
      : [],
  );
  const orchestrationChildrenByParentId = useMemo(() => {
    if (!orchestrationOnly) return null;
    // 三桶并集 + 活流优先：live sessions-index meta 带 running phase（转圈依据），
    // 静态三桶补位置/兜底；同 taskId 活流优先（first-wins）。
    const allItems = [
      ...liveSessionItems,
      ...localItems,
      ...remoteItems,
      ...pinnedIndexItems,
      ...archivedIndexItems,
    ];
    const metaByTaskId = new Map<string, ZCodeTaskMeta>();
    for (const item of allItems) {
      if (!metaByTaskId.has(item.taskId)) metaByTaskId.set(item.taskId, item);
    }
    if (authoritativeLinksByParentId) {
      // links 权威路径：按各编排的在册子关系装配 metas（跨 workspace 子任务极罕见，
      // 按 taskId 匹配足够；匹配不到的行跳过，计数以 links 为准会出现 0 行——可接受）。
      const byParent = new Map<string, ZCodeTaskMeta[]>();
      for (const [parentId, links] of Object.entries(authoritativeLinksByParentId)) {
        const children = links
          .map((link) => metaByTaskId.get(link.childTaskId))
          .filter((meta): meta is ZCodeTaskMeta => Boolean(meta));
        if (children.length > 0) byParent.set(parentId, children);
      }
      return byParent;
    }
    // 兜底（links 未就绪/失败）：parent 列分组，仅首父视角。
    const byParent = new Map<string, ZCodeTaskMeta[]>();
    const seenTaskKeys = new Set<string>();
    for (const item of allItems) {
      const parentId = item.orchestrationParentTaskId?.trim();
      if (!parentId) continue;
      const taskKey = buildTimelineItemKey(item.workspacePath, item.taskId, item.workspaceIdentity);
      if (seenTaskKeys.has(taskKey)) continue;
      seenTaskKeys.add(taskKey);
      const list = byParent.get(parentId);
      if (list) {
        list.push(item);
      } else {
        byParent.set(parentId, [item]);
      }
    }
    return byParent;
  }, [
    archivedIndexItems,
    authoritativeLinksByParentId,
    liveSessionItems,
    localItems,
    orchestrationOnly,
    pinnedIndexItems,
    remoteItems,
  ]);
  // 子任务折叠态：共享 hook（编排分区与置顶区同步），localStorage 持久化、默认展开。
  const {
    isCollapsed: isOrchestrationChildrenCollapsed,
    toggleCollapsed: toggleOrchestrationChildren,
  } = useOrchestrationChildrenCollapsed();
  // 编排工作区分组折叠态：默认展开，localStorage 持久化（key 为 workspace key）。
  const {
    isGroupCollapsed: isOrchestrationWorkspaceGroupCollapsed,
    toggleGroupCollapsed: toggleOrchestrationWorkspaceGroup,
  } = useOrchestrationWorkspaceGroupsCollapsed();
  // 编排分区的子任务折叠态与工作区分组（spec: orchestration-tasks.md）：
  // 编排任务跨 workspace 混排时按工作区分组展示（同项目视图语义），组头 =
  // workspace tab 显示名（悬停完整路径），行内不再重复工作区标签。
  const workspaceTabByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [
          buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          tab,
        ]),
      ),
    [workspaceTabs],
  );
  const items = sortedItems.slice(0, visibleTaskLimit);
  const itemByKey = useMemo(() => {
    const nextItemByKey = new Map<string, ZCodeTaskMeta>();
    for (const item of items) {
      nextItemByKey.set(
        buildTimelineItemKey(item.workspacePath, item.taskId, item.workspaceIdentity),
        item,
      );
    }
    return nextItemByKey;
  }, [items]);
  const itemByKeyRef = useRef(itemByKey);
  const workspaceServiceLookupRef = useRef(workspaceServiceLookup);
  itemByKeyRef.current = itemByKey;
  workspaceServiceLookupRef.current = workspaceServiceLookup;
  const timelineGroups = useMemo(() => {
    const visibleItems = items.filter((item) =>
      workspaceServiceLookup.has(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity)),
    );
    if (!groupByDate) {
      // 编排分区按工作区分组：组序沿用 workspace tabs 顺序（用户排过的顺序），
      // 组内保持既有排序（最近优先）；组头悬停显示完整目录路径。
      if (orchestrationOnly) {
        const itemsByWorkspaceKey = new Map<string, typeof visibleItems>();
        for (const item of visibleItems) {
          const workspaceKey = buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity);
          const list = itemsByWorkspaceKey.get(workspaceKey);
          if (list) {
            list.push(item);
          } else {
            itemsByWorkspaceKey.set(workspaceKey, [item]);
          }
        }
        const groupOrder = [
          ...workspaceTabs.map((tab) =>
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          ),
          ...itemsByWorkspaceKey.keys(),
        ].filter((key, index, all) => all.indexOf(key) === index);
        return groupOrder
          .map((workspaceKey): TimelineTaskGroup | null => {
            const groupItems = itemsByWorkspaceKey.get(workspaceKey);
            const sample = groupItems?.[0];
            if (!groupItems || !sample) return null;
            const tab = workspaceTabByKey.get(workspaceKey);
            return {
              key: `workspace:${workspaceKey}`,
              label: null,
              workspaceName:
                tab?.label || getPathLeaf(sample.workspacePath) || sample.workspacePath,
              workspacePath: sample.workspacePath,
              workspaceKey,
              items: groupItems,
            };
          })
          .filter((group): group is TimelineTaskGroup => group !== null);
      }
      return [{ key: "all", label: null, items: visibleItems }];
    }
    return groupTaskTimelineItems(items, {
      sortBy: taskSortBy,
      now: Date.now(),
      locale,
    })
      .map(
        (group): TimelineTaskGroup => ({
          ...group,
          items: group.items.filter((item) =>
            workspaceServiceLookup.has(
              buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
            ),
          ),
        }),
      )
      .filter((group) => group.items.length > 0);
  }, [
    groupByDate,
    items,
    locale,
    orchestrationOnly,
    taskSortBy,
    workspaceServiceLookup,
    workspaceTabByKey,
    workspaceTabs,
  ]);
  const remoteTotal = remoteWorkspaceKeys.reduce(
    (sum, workspaceKey) =>
      sum +
      (remoteTimelineTotalByWorkspaceKey[workspaceKey] ??
        remoteTimelineItemsByWorkspaceKey[workspaceKey]?.length ??
        0),
    0,
  );
  const total = localTotal + remoteTotal;
  const remoteHasMore = remoteWorkspaceKeys.some(
    (workspaceKey) => remoteTimelineHasMoreByWorkspaceKey[workspaceKey],
  );
  const syncingRemoteWorkspaces = workspaceTabs.some((tab) => {
    if (!tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId) {
      return false;
    }
    return Boolean(
      remoteTimelineLoadingByWorkspaceKey[
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)
      ],
    );
  });
  const loading = localLoading || syncingRemoteWorkspaces;
  // 客户端过滤场景（编排分区 / 时间线排除编排任务）里 total 是未过滤的全量计数，
  // items 却是过滤后的列表：total > items.length 恒真。运行中任务的每个 activity 帧
  // 都会触发重查（loading 反复翻转），canLoadMore 的 loading 分支只看 hasKnownMore，
  // 于是"显示更多"随每帧闪烁出现/消失。过滤场景的"还有更多"只能信服务端 hasMore；
  // 未过滤场景保留 total 兜底（hasMore 偶发陈旧时按总数兜住）。
  const clientFiltered = orchestrationOnly || excludeOrchestration;
  const hasKnownMore = localHasMore || remoteHasMore || (!clientFiltered && total > items.length);
  // 页是否填满同样要按未过滤计数判定：过滤后条数 < limit 不代表到底（后续分页
  // 可能还有被过滤掉的目标条目），否则编排分区会漏掉沉在深页的编排任务。
  const unfilteredLoadedCount = useMemo(() => {
    const keys = new Set<string>();
    for (const item of localItems) {
      keys.add(
        `${buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity)}:${item.taskId}`,
      );
    }
    for (const item of remoteItems) {
      keys.add(
        `${buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity)}:${item.taskId}`,
      );
    }
    return keys.size;
  }, [localItems, remoteItems]);
  const currentLimitFilled =
    (clientFiltered ? unfilteredLoadedCount : sortedItems.length) >= visibleTaskLimit;
  // 远端/本地 hasMore 偶尔会在下一轮请求完成前保持旧值。
  // 如果当前已加载数量没有填满 limit，说明这轮已经到底了，不能继续显示 show more。
  const canLoadMore = loading ? hasKnownMore : currentLimitFilled && hasKnownMore;

  useEffect(() => {
    setVisibleTaskLimit(collapsedLimit);
  }, [taskSortBy, workspaceTabsSignature]);

  useEffect(() => {
    // 这条日志会随着远端 timeline 同步和 tab 恢复多次触发。
    // 生产环境只需要保留生命周期和异常，列表同步细节降为 debug，避免任务多时持续落盘。
    logger.debug("[WorkspaceTimelineTasksSection] scopedWorkspaceTabs", {
      workspaceTabs: workspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        remoteSessionId: tab.remoteSessionId,
        hasRemoteTarget: Boolean(tab.remoteTarget),
      })),
      scopedWorkspaceTabs: scopedWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        remoteSessionId: tab.remoteSessionId,
        hasRemoteTarget: Boolean(tab.remoteTarget),
      })),
      remoteItemCount: remoteItems.length,
    });
  }, [remoteItems.length, scopedWorkspaceTabs, workspaceTabs]);

  useEffect(() => {
    const remoteTabs = workspaceTabs.filter(
      (tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId,
    );
    if (remoteTabs.length === 0) {
      return;
    }

    for (const tab of remoteTabs) {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
      );
      if (!workspaceServices?.isRemoteWorkspace) {
        continue;
      }
      // timeline 不能复用 useGlobalTaskList 的远端混合查询，否则 active services 切到远端时会影响本地缓存。
      // 远端数据跟 pinned 一样走独立 store，show more 时只把 limit 按 20 条阶梯增加，避免一次性拉全量。
      void useRemoteTimelineTaskStore.getState().refreshWorkspace({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        zcodeTaskService: workspaceServices.services.zcodeTaskService,
        sortBy: taskSortBy,
        limit: visibleTaskLimit,
      });
    }
  }, [taskSortBy, visibleTaskLimit, workspaceServiceLookup, workspaceTabs]);

  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveItemKey(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingItemKey(null);
    setRenameDraft("");
  }, []);

  const findItemByKey = useCallback(
    (itemKey: string) => itemByKey.get(itemKey) ?? null,
    [itemByKey],
  );
  const getCurrentItemContext = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return null;
    }

    const workspaceServices = workspaceServiceLookupRef.current.get(
      buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
    );
    if (!workspaceServices) {
      return null;
    }

    return { item, workspaceServices };
  }, []);
  const archiveTimelineItem = useCallback(
    (itemKey: string) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      void workspaceServices.services.zcodeTaskService
        .archiveTask({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        })
        .then((meta) => {
          removeTaskStateRef.current(item.workspacePath, item.taskId, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: true },
          });
        });
    },
    [getCurrentItemContext],
  );
  const selectTimelineItem = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return;
    }
    onSelectTaskRef.current(item.workspacePath, item.taskId, item.workspaceIdentity, item.unreadAt);
  }, []);
  const archiveTimelineItemInline = useCallback(
    (event: ReactMouseEvent, itemKey: string) => {
      event.stopPropagation();
      if (renamingItemKeyRef.current) {
        handleCancelRenameTask();
      }
      if (pendingArchiveItemKeyRef.current !== itemKey) {
        setPendingArchiveItemKey(itemKey);
        return;
      }
      setPendingArchiveItemKey(null);
      archiveTimelineItem(itemKey);
    },
    [archiveTimelineItem, handleCancelRenameTask],
  );
  const toggleTimelineItemPin = useCallback(
    (itemKey: string, pinned: boolean) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      if (item.workspaceIdentity && pinned) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
        useRemotePinnedTaskStore.getState().upsertTask(item);
      }
      applyTaskQueryCacheMutation({
        previousTask: item,
        nextTask: item,
        previousState: { pinned: false, archived: false },
        nextState: { pinned, archived: false },
      });
      void workspaceServices.services.zcodeTaskService
        .setTaskPinned({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          pinned,
        })
        .then((meta) => {
          removeOptimisticTaskListItemRef.current(
            item.workspacePath,
            item.taskId,
            item.workspaceIdentity,
          );
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned, archived: false },
            nextState: { pinned, archived: false },
          });
        })
        .catch(() => {
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemoteTimelineTaskStore.getState().upsertTask(item, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: item,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: false },
          });
          toast(
            intlRef.current.formatMessage({
              id: "taskList.pinFailed",
            }),
          );
        });
    },
    [getCurrentItemContext],
  );
  const startTimelineItemRename = useCallback((itemKey: string, currentTitle: string) => {
    setPendingArchiveItemKey(null);
    setRenamingItemKey(itemKey);
    setRenameDraft(currentTitle ?? "");
  }, []);
  const archiveTimelineItemFromMenu = useCallback(
    (itemKey: string) => {
      setPendingArchiveItemKey(null);
      handleCancelRenameTask();
      archiveTimelineItem(itemKey);
    },
    [archiveTimelineItem, handleCancelRenameTask],
  );
  const markTimelineItemAsUnread = useCallback(
    (itemKey: string) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      void workspaceServices.services.zcodeTaskService
        .setTaskUnread({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          unread: true,
        })
        .then((meta) => {
          setTaskUnreadIndicatorRef.current(
            item.workspacePath,
            item.taskId,
            true,
            item.workspaceIdentity,
          );
          upsertOptimisticTaskListItemRef.current(item.workspacePath, meta, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: false },
          });
        });
    },
    [getCurrentItemContext],
  );
  const openTimelineItemContextMenu = useCallback((itemKey: string) => {
    // timeline row 现在会按 itemKey 缓存 action handler。
    // 打开菜单时必须通过 ref 读取最新确认态，避免把 pendingArchiveItemKey 放进依赖后重建所有 row callback。
    if (pendingArchiveItemKeyRef.current === itemKey) {
      setPendingArchiveItemKey(null);
    }
    setContextMenuItemKey(itemKey);
  }, []);
  const getTimelineTaskItemHandlers = useCallback(
    (itemKey: string) => {
      let handlers = taskItemHandlersByKeyRef.current.get(itemKey);
      if (!handlers) {
        // trace 显示 timeline row 的所有 action prop 都因 map 内 inline closure 变更。
        // 每个 itemKey 只创建一次 handler，handler 运行时再通过 ref 读取最新 item/services，兼顾 memo 稳定性和实时数据。
        handlers = {
          onSelectTask: () => {
            selectTimelineItem(itemKey);
          },
          onArchiveTaskInline: (event) => {
            archiveTimelineItemInline(event, itemKey);
          },
          onTogglePinTask: (_taskId, pinned) => {
            toggleTimelineItemPin(itemKey, pinned);
          },
          onStartRenameTask: (_taskId, currentTitle) => {
            startTimelineItemRename(itemKey, currentTitle);
          },
          onArchiveTask: () => {
            archiveTimelineItemFromMenu(itemKey);
          },
          onMarkTaskAsUnread: () => {
            markTimelineItemAsUnread(itemKey);
          },
          onOpenTaskContextMenu: () => {
            openTimelineItemContextMenu(itemKey);
          },
        };
        taskItemHandlersByKeyRef.current.set(itemKey, handlers);
      }
      return handlers;
    },
    [
      archiveTimelineItemFromMenu,
      archiveTimelineItemInline,
      markTimelineItemAsUnread,
      openTimelineItemContextMenu,
      selectTimelineItem,
      startTimelineItemRename,
      toggleTimelineItemPin,
    ],
  );
  const contextMenuItem = contextMenuItemKey ? findItemByKey(contextMenuItemKey) : null;
  const contextMenuWorkspaceServices = contextMenuItem
    ? workspaceServiceLookup.get(
        buildTaskWorkspaceKey(contextMenuItem.workspacePath, contextMenuItem.workspaceIdentity),
      )
    : null;

  useEffect(() => {
    if (!renamingItemKey) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingItemKey]);

  useEffect(() => {
    if (!contextMenuItemKey) {
      return;
    }
    if (!findItemByKey(contextMenuItemKey)) {
      setContextMenuItemKey(null);
    }
  }, [contextMenuItemKey, findItemByKey]);

  useEffect(() => {
    for (const itemKey of taskItemHandlersByKeyRef.current.keys()) {
      if (!itemByKey.has(itemKey)) {
        taskItemHandlersByKeyRef.current.delete(itemKey);
      }
    }
  }, [itemByKey]);

  if (items.length === 0 && loading) {
    return (
      <div className="flex min-h-0 flex-col px-2">
        <TaskListLoadingHint />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-ui-base text-foreground-subtle">
        {emptyMessage ?? intl.formatMessage({ id: "taskList.noTasks" })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {renamingItemKey !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            if (!renamingItemKey) {
              return;
            }
            const item = findItemByKey(renamingItemKey);
            if (!item) {
              handleCancelRenameTask();
              return;
            }
            const normalizedTitle = renameDraft.trim();
            if (normalizedTitle === item.title.trim()) {
              handleCancelRenameTask();
              return;
            }
            const workspaceServices = workspaceServiceLookup.get(
              buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
            );
            if (!workspaceServices) {
              handleCancelRenameTask();
              return;
            }
            void workspaceServices.services.zcodeTaskService
              .renameTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                title: normalizedTitle,
              })
              .then((meta) => {
                upsertOptimisticTaskListItem(item.workspacePath, meta, item.workspaceIdentity);
                if (item.workspaceIdentity) {
                  useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                }
                applyTaskQueryCacheMutation({
                  previousTask: item,
                  nextTask: meta,
                  previousState: { pinned: false, archived: false },
                  nextState: { pinned: false, archived: false },
                });
                handleCancelRenameTask();
              })
              .catch(() => {
                toast(intl.formatMessage({ id: "taskList.renameFailed" }));
              });
          }}
        />
      ) : null}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuItemKey(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <ul className="space-y-1">
            {timelineGroups.map((group) => {
              const labelMessage = group.label ? getTaskTimelineGroupMessage(group.label) : null;
              // 编排工作区分组可折叠（组头整行点击 + 键盘），收起时隐藏该组行；
              // 折叠态按 workspace key 持久化，默认展开。
              const isWorkspaceGroup = Boolean(group.workspaceName && group.workspaceKey);
              const workspaceGroupCollapsed =
                isWorkspaceGroup && group.workspaceKey
                  ? isOrchestrationWorkspaceGroupCollapsed(group.workspaceKey)
                  : false;
              return (
                <li key={group.key} className="space-y-0.5">
                  {isWorkspaceGroup ? (
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={!workspaceGroupCollapsed}
                      title={group.workspacePath}
                      className="flex min-w-0 cursor-pointer select-none items-center gap-1 rounded-md px-2 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle hover:bg-hover"
                      onClick={() => {
                        if (group.workspaceKey)
                          toggleOrchestrationWorkspaceGroup(group.workspaceKey);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        if (group.workspaceKey)
                          toggleOrchestrationWorkspaceGroup(group.workspaceKey);
                      }}
                    >
                      {workspaceGroupCollapsed ? (
                        <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{group.workspaceName}</span>
                      <span className="ml-auto shrink-0 text-foreground-subtlest">
                        {group.items.length}
                      </span>
                    </div>
                  ) : labelMessage ? (
                    <div className="px-3 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle">
                      {intl.formatMessage({ id: labelMessage.id }, labelMessage.values)}
                    </div>
                  ) : null}
                  {!workspaceGroupCollapsed ? (
                    <ul className="space-y-0.5">
                      {group.items.map((item) => {
                        const itemKey = buildTimelineItemKey(
                          item.workspacePath,
                          item.taskId,
                          item.workspaceIdentity,
                        );
                        const workspaceServices = workspaceServiceLookup.get(
                          buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
                        );
                        if (!workspaceServices) {
                          return null;
                        }
                        const handlers = getTimelineTaskItemHandlers(itemKey);
                        // 编排分区的子任务展开器挂在编排行行首（TaskListItem 的
                        // orchestrationExpander）：无子任务也显示图标，展开后才见
                        // "尚未派生"提示（空态常驻太吵，联调用户反馈）。
                        const orchestrationChildTasks = orchestrationChildrenByParentId
                          ? (orchestrationChildrenByParentId.get(item.taskId) ?? [])
                          : [];
                        const orchestrationChildrenCollapsed = isOrchestrationChildrenCollapsed(
                          item.taskId,
                        );
                        return (
                          <Fragment key={itemKey}>
                            <MemoTaskItem
                              workspacePath={item.workspacePath}
                              remoteSessionId={workspaceServices.remoteSessionId}
                              task={item}
                              isPinned={false}
                              variant={taskRowVariant}
                              isActive={
                                // timeline 是跨 workspace 视图，active 判断必须使用 workspaceKey，避免同路径远端串高亮。
                                buildTaskWorkspaceKey(
                                  item.workspacePath,
                                  item.workspaceIdentity,
                                ) === activeWorkspaceKey && item.taskId === activeTaskId
                              }
                              orchestrationExpander={
                                orchestrationChildrenByParentId
                                  ? {
                                      collapsed: orchestrationChildrenCollapsed,
                                      childCount: orchestrationChildTasks.length,
                                      runningCount:
                                        orchestrationChildTasks.filter(isChildRunning).length,
                                      onToggle: () => {
                                        toggleOrchestrationChildren(item.taskId);
                                      },
                                    }
                                  : undefined
                              }
                              hideWorkspaceLabel={Boolean(orchestrationChildrenByParentId)}
                              onSelectTask={handlers.onSelectTask}
                              onArchiveTaskInline={handlers.onArchiveTaskInline}
                              onCancelArchiveConfirm={handleCancelArchiveConfirm}
                              isArchiveConfirming={pendingArchiveItemKey === itemKey}
                              onTogglePinTask={handlers.onTogglePinTask}
                              onStartRenameTask={handlers.onStartRenameTask}
                              onArchiveTask={handlers.onArchiveTask}
                              onMarkTaskAsUnread={handlers.onMarkTaskAsUnread}
                              onOpenTaskContextMenu={handlers.onOpenTaskContextMenu}
                              intl={intl}
                            />
                            {orchestrationChildrenByParentId && !orchestrationChildrenCollapsed ? (
                              <OrchestrationChildrenList
                                parentTaskId={item.taskId}
                                childTasks={orchestrationChildTasks}
                                onUnlinkTask={(
                                  childWorkspacePath,
                                  childTaskId,
                                  childWorkspaceIdentity,
                                ) => {
                                  unlinkOrchestrationChild({
                                    orchestrationTaskId: item.taskId,
                                    childWorkspacePath,
                                    childTaskId,
                                    childWorkspaceIdentity,
                                  });
                                }}
                                isActiveTaskId={(child) =>
                                  child.taskId === activeTaskId &&
                                  buildTaskWorkspaceKey(
                                    child.workspacePath,
                                    child.workspaceIdentity,
                                  ) === activeWorkspaceKey
                                }
                                onOpenTask={onSelectTask}
                                onJumpToTask={onOrchestrationChildJump ?? onSelectTask}
                              />
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </ContextMenuTrigger>
        {contextMenuItem && contextMenuWorkspaceServices && contextMenuItemKey ? (
          <TaskListItemContextMenuContent
            workspacePath={contextMenuItem.workspacePath}
            remoteSessionId={contextMenuWorkspaceServices.remoteSessionId}
            task={contextMenuItem}
            isPinned={false}
            intl={intl}
            onTogglePinTask={(_taskId, pinned) => {
              // timeline 现在本地和远端分属两套缓存，pin 时需要同时维护成员关系。
              // 否则远端任务会进入 pinned 后仍残留在 timeline 缓存里。
              if (contextMenuItem.workspaceIdentity && pinned) {
                useRemoteTimelineTaskStore
                  .getState()
                  .removeTask(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                useRemotePinnedTaskStore.getState().upsertTask(contextMenuItem);
              }
              applyTaskQueryCacheMutation({
                previousTask: contextMenuItem,
                nextTask: contextMenuItem,
                previousState: { pinned: false, archived: false },
                nextState: { pinned, archived: false },
              });
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .setTaskPinned({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  pinned,
                })
                .then((meta) => {
                  removeOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned, archived: false },
                    nextState: { pinned, archived: false },
                  });
                })
                .catch(() => {
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemoteTimelineTaskStore.getState().upsertTask(contextMenuItem, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: contextMenuItem,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: false },
                  });
                  toast(
                    intl.formatMessage({
                      id: "taskList.pinFailed",
                    }),
                  );
                });
            }}
            onStartRenameTask={(_taskId, currentTitle) => {
              setPendingArchiveItemKey(null);
              setRenamingItemKey(contextMenuItemKey);
              setRenameDraft(currentTitle ?? "");
            }}
            onArchiveTask={() => {
              setPendingArchiveItemKey(null);
              handleCancelRenameTask();
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .archiveTask({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                })
                .then((meta) => {
                  removeTaskState(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: true },
                  });
                });
            }}
            onMarkTaskAsUnread={() => {
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .setTaskUnread({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  unread: true,
                })
                .then((meta) => {
                  setTaskUnreadIndicator(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    true,
                    contextMenuItem.workspaceIdentity,
                  );
                  upsertOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    meta,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: false },
                  });
                });
            }}
          />
        ) : null}
      </ContextMenu>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canLoadMore ? (
        <div className="cursor-pointer pl-8.5 pb-4">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              // timeline 目标是单向分页，每次点击只增加一个 20 条阶梯。
              // 不再复用“显示更少”的旧展开/收起方案，避免按钮状态和真实分页语义冲突。
              setVisibleTaskLimit((current) => current + collapsedLimit);
            }}
          >
            {intl.formatMessage({
              id: "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
