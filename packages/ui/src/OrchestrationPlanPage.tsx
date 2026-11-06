/* oxlint-disable eslint(max-lines) -- 计划页视图控制器：数据加载/画布/菜单/快捷键共享
   同一套编辑状态，继续拆会打散 editor 句柄与 flowInstance 的传递链。 */
// 编排计划独立页面（spec: orchestration-plan.md 用户需求点 3/4/5）：覆盖对话区的主视图。
// 工具栏在 OrchestrationPlanPageToolbar；画布 Flow 封装与节点组件在 OrchestrationPlanCanvasNodes；
// 编辑侧栏在 OrchestrationPlanNodeEditor；画布编辑状态机在 useOrchestrationPlanCanvasEditor。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "@xyflow/react";
import type { ZCodeOrchestrationPlansMap } from "@zcode/shared";
import { zcodeProviderAccountAccessSchema } from "@zcode/shared";
import { LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";
import { Button } from "@/components/ui/button.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { toast } from "@/components/ui/toast.js";
import {
  findGraphIssue,
  useOrchestrationPlanCanvasEditor,
} from "@/hooks/useOrchestrationPlanCanvasEditor.js";
import { OrchestrationPlanContextMenu } from "@/OrchestrationPlanContextMenu.js";
import { OrchestrationPlanPageToolbar } from "@/OrchestrationPlanPageToolbar.js";
import { PlanNodeEditor } from "@/OrchestrationPlanNodeEditor.js";
import { OrchestrationPlanEdgeEndpoints } from "@/OrchestrationPlanEdgeEndpoints.js";
import { OrchestrationPlanFlow } from "@/OrchestrationPlanFlow.js";
import { pickEdgeAnchorPair, type EditableNode } from "@/OrchestrationPlanCanvasNodes.js";
import {
  bumpOrchestrationPlanVersion,
  useOrchestrationPlanVersion,
  useOrchestrationPlansChangedSync,
} from "@/lib/orchestrationPlanSync.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { useSkills } from "@/hooks/useSkills.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import type { ModelSelection } from "@zcode/shared/model-selection";

export interface OrchestrationPlanPageProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  focusPlanId: string | null;
  /** 返回对话视图。 */
  onBack: () => void;
}

/** 焦点在文本输入面上（输入框/文本域/可编辑区域）：画布快捷键让位给原生编辑行为。 */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function OrchestrationPlanPage({
  sessionId,
  workspacePath,
  workspaceIdentity,
  focusPlanId,
  onBack,
}: OrchestrationPlanPageProps) {
  const { intl } = useZCodeIntl();
  const services = useWorkspaceServices(workspacePath || null, null, workspaceIdentity ?? null);
  const planVersion = useOrchestrationPlanVersion();
  useOrchestrationPlansChangedSync(services.broadcastService ?? null);
  const scope = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspacePath, workspaceIdentity],
  );

  const [plansMap, setPlansMap] = useState<ZCodeOrchestrationPlansMap | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [retrySerial, setRetrySerial] = useState(0);
  const [busy, setBusy] = useState(false);
  // 选中 = 用户点谁看谁（用户需求 2026-10-30：点哪个计划就切到哪个计划的页面，
  // 与状态无关）；activePlanId 是 agent 执行口径，只在无 focus（如 composer 入口
  // 打开）时兜底显示。保存/确认/绑定显式带 planId，不依赖 active。
  const selectedPlanId = focusPlanId ?? plansMap?.activePlanId ?? null;

  const plan = useMemo(
    () => plansMap?.plans.find((candidate) => candidate.planId === selectedPlanId) ?? null,
    [plansMap, selectedPlanId],
  );
  // 服务端已保存的节点 id 集（用户需求 2026-11-03）：执行/手动完成/自动开关都是服务端
  // 操作，画布上未保存的本地新节点先禁用并提示保存（此前直接报 Unknown plan node）。
  const savedNodeIds = useMemo(
    () => new Set(plan?.nodes.map((node) => node.nodeId) ?? []),
    [plan],
  );
  // 画布编辑跟"正在查看"走（用户需求 2026-10-30：确认/完成 ≠ 锁死，草稿、确认、
  // 完成态都可查看/增删节点）；已派发/已完结的节点在删除入口单独拦截（frozen）。
  // 完成态编辑后节点状态由 host 修订通道重算（改动节点回 pending、下游查缺补漏标
  // stale），计划自动脱离完成态。确认按钮仍只在草稿态出现。
  const editable = plan !== null;
  const canConfirm = plan?.status === "draft";

  // 存量计划缺起始节点时 UI 侧同样补注入/收编（与 host withStartNode 同规则；
  // 空计划也要有起始；保存载荷带上 isStart，host 校验是权威）。
  // 收编规则：无标记但占用 start id 的存量节点直接标记为起始——否则会注入第二个
  // start 造成 id 重复（实测：旧 agent 提案留下 start 节点 → 保存报 nodeIds unique）。
  const planNodesBase = useMemo(() => {
    const base = (plan?.nodes ?? []) as EditableNode[];
    let seen = false;
    const normalized = base.map((node) => {
      if (seen) return node.isStart ? { ...node, isStart: undefined } : node;
      if (node.isStart || node.nodeId === "start") {
        seen = true;
        return { ...node, isStart: true, goal: "", dependsOn: [], needsUpstreamResult: false };
      }
      return node;
    });
    if (seen) return normalized;
    return [
      {
        nodeId: "start",
        name: intl.formatMessage({ id: "orchestration.plan.startBadge" }),
        goal: "",
        dependsOn: [],
        needsUpstreamResult: false,
        isStart: true,
        status: "pending" as const,
        childTaskId: null,
        layout: { x: 80, y: 80 },
      },
      ...normalized,
    ];
  }, [intl, plan]);

  // 画布编辑状态机（拖动/连线/缩放/加节点/内联改名，spec 微调重执行布局持久化）。
  // 子任务真实标题（sessions-index 解析）：节点卡片展示实际挂载的子任务（用户需求 4）。
  const { items: sessionIndexItems } = useWorkspaceSessionsIndexItems(
    useMemo(
      () =>
        workspacePath
          ? [{ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }]
          : [],
      [workspacePath, workspaceIdentity],
    ),
  );
  // 常驻 skill 候选（用户需求 2026-11-04）：只取用户级 scope（~/.zcode/skills）。
  const skillCatalog = useSkills({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sessionId,
    enabled: true,
  });
  const childTaskTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of sessionIndexItems) map[item.taskId] = item.title;
    return map;
  }, [sessionIndexItems]);
  // 子任务模型候选（用户需求 2026-11-05）：useModelSelectionView 目录；视觉标识走产品
  // 统一规则 shouldShowModelVisionBadge——套餐 GLM-5.3 的图片输入是服务端桥接，不是
  // 原生视觉，不标（与模型选择器/委托入口同一判定，避免"5.3 没有视觉却标了视觉"）。
  const modelSelectionRead = useModelSelectionView(workspacePath, undefined, workspaceIdentity);
  const modelCandidates = useMemo(() => {
    if (modelSelectionRead.state.status !== "ready") return [];
    return modelSelectionRead.state.view.providers.flatMap((provider) => {
      const access = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
      const accessData = access.success ? access.data : undefined;
      return provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
        supportsImage: shouldShowModelVisionBadge(
          model.modelId,
          model.config.properties?.inputFormat?.supportsImage,
          accessData,
        ),
        // 目录档位（values 按语义强度低→高）：节点级「思考档位」下拉的候选。
        reasoningLevels: model.config.optionSpecs?.reasoningLevel?.values ?? [],
      }));
    });
  }, [modelSelectionRead.state]);

  const editor = useOrchestrationPlanCanvasEditor({
    planNodesBase,
    resetKey: `${plan?.planId ?? ""}:${plan?.version ?? 0}`,
    editable,
    childTaskTitles,
    newNameLabel: intl.formatMessage({ id: "orchestration.plan.newNodeName" }),
  });
  const flowInstanceRef = useRef<{
    fitView: (options?: { padding?: number }) => void;
    screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  } | null>(null);
  // 节点/连线右键菜单；null = 关闭。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    kind: "node" | "edge";
    nodeId?: string;
    edge?: { source: string; target: string };
  } | null>(null);
  // 选中的连线（点击高亮 + 端点拖拽）；pane 点击清除。
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // 图不合法时点过保存 → 强调提示（工具栏已展示原因文案）。
  const [saveBlockedPulse, setSaveBlockedPulse] = useState(false);
  const confirmDialog = useConfirmDialog();

  // 拉取计划（loading/ready/error 三态；错误可重试）。
  // services 每次渲染都是新引用（useWorkspaceServices 重建对象），进 deps 会让 effect
  // 无限重跑——每次先置回 loading，页面永远卡在加载（实测：RPC 每 2 秒 OK 一次）。
  // 服务经 ref 读取，deps 只留真正的重拉信号。
  const taskServiceRef = useRef(services?.zcodeTaskService ?? null);
  taskServiceRef.current = services?.zcodeTaskService ?? null;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const taskService = taskServiceRef.current;
        if (!taskService) {
          throw new Error("zcodeTaskService unavailable for plan page");
        }
        const map = await taskService.getOrchestrationPlansMap({
          orchestrationTaskIds: [sessionId],
          ...scope,
        });
        if (cancelled) return;
        setPlansMap(map[sessionId] ?? null);
        setLoadState("ready");
      } catch (error) {
        logger.error("Orchestration plan page load failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          sessionId,
          workspacePath,
        });
        if (!cancelled) {
          setPlansMap(null);
          setLoadState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planVersion, retrySerial, scope, sessionId, workspacePath]);

  // 点侧栏计划条目 = 纯视图切换（用户需求 2026-10-30）：显示 focusPlanId 指向的
  // 计划即可，不改服务端 active 选中（查看 ≠ 执行口径；保存/确认/绑定显式带
  // planId 定位目标计划）。计划页随任务选中关闭（App 层已处理）。

  // 编辑目标 = xyflow 选中的节点（applyNodeChanges 管选区；字段都在 flow data 上）。
  const selectedFlowNode = editor.editNodes?.find((node) => node.selected) ?? null;
  const editNode = selectedFlowNode
    ? {
        nodeId: selectedFlowNode.id,
        name: selectedFlowNode.data.name,
        goal: selectedFlowNode.data.goal,
        status: selectedFlowNode.data.status,
        needsUpstreamResult: selectedFlowNode.data.needsUpstreamResult,
        dependsOn: selectedFlowNode.data.dependsOn,
        isStart: selectedFlowNode.data.isStart,
        childTaskId: selectedFlowNode.data.childTaskId,
        childTitle: selectedFlowNode.data.childTitle,
        childTaskLocked: selectedFlowNode.data.childLocked,
        pinnedSkills: selectedFlowNode.data.pinnedSkills,
        model: selectedFlowNode.data.model ?? null,
        thoughtLevel: selectedFlowNode.data.thoughtLevel ?? null,
      }
    : null;

  const runAction = useCallback(
    async (action: () => Promise<ZCodeOrchestrationPlansMap | unknown>) => {
      setBusy(true);
      try {
        await action();
        const map = await taskServiceRef.current!.getOrchestrationPlansMap({
          orchestrationTaskIds: [sessionId],
          ...scope,
        });
        setPlansMap(map[sessionId] ?? null);
        setLoadState("ready");
        bumpOrchestrationPlanVersion();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Orchestration plan action failed", { errorMessage: message, sessionId });
        // 单次操作失败（如执行被拒：计划未确认/节点正在执行）用 toast 提示，页面保持可用；
        // 此前整页翻成"加载失败"，用户只能点重试，错误原因也看不到。
        toast(intl.formatMessage({ id: "orchestration.plan.actionFailed" }, { message }));
      } finally {
        setBusy(false);
      }
    },
    [intl, scope, sessionId],
  );

  const runPlansAction = useCallback(
    (action: (taskService: NonNullable<typeof taskServiceRef.current>) => Promise<unknown>) =>
      runAction(() => {
        const taskService = taskServiceRef.current;
        if (!taskService) throw new Error("zcodeTaskService unavailable for plan page");
        return action(taskService);
      }),
    [runAction],
  );

  // 关联子任务候选（用户需求 2026-10-30）：编排 links 权威列表 + sessions-index 标题。
  // 已被其他节点绑定的子任务不进候选（一个子任务只挂一个节点；host 校验双保险）。
  const [childLinkList, setChildLinkList] = useState<Array<{ childTaskId: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void taskServiceRef.current
      ?.listOrchestrationChildrenMap({
        orchestrationTaskIds: [sessionId],
        ...scope,
      })
      .then((map) => {
        if (!cancelled) setChildLinkList(map[sessionId] ?? []);
      })
      .catch(() => {
        // 候选取不到时编辑器下拉只剩「未关联」，不阻断计划页。
      });
    return () => {
      cancelled = true;
    };
  }, [planVersion, scope, sessionId]);
  // 候选 = 全部已关联子任务，不做"已被其他节点绑定"排除（用户需求 2026-11-04：
  // 允许一个子任务挂多个节点；其完成会把挂它的节点全部置 terminal）。
  const childCandidates = useMemo(
    () =>
      childLinkList.map((link) => ({
        taskId: link.childTaskId,
        title: childTaskTitles[link.childTaskId] ?? link.childTaskId,
      })),
    [childLinkList, childTaskTitles],
  );
  // 关联子任务（用户需求 2026-11-03 改版）：画布可编辑配置，进编辑缓冲随保存落库
  //（此前走服务端即时绑定：不亮保存按钮，且后续保存的修订通道会把未完成节点的绑定
  // 清掉——实测绑定丢失）。绑定即锁定，解绑清锁；就绪扫描在保存/确认后触发。
  const onBindChild = useCallback(
    (childTaskId: string | null) => {
      if (!editNode) return;
      const title = childTaskId
        ? (childTaskTitles?.[childTaskId] ?? editNode.childTitle ?? childTaskId)
        : null;
      editor.updateNodeData(editNode.nodeId, {
        childTaskId,
        childTitle: title,
        childLocked: childTaskId !== null,
      });
    },
    [childTaskTitles, editNode, editor],
  );

  const saveDraft = useCallback(() => {
    if (!selectedPlanId) return;
    void runPlansAction((taskService) =>
      taskService.proposeOrchestrationPlanEdit({
        orchestrationTaskId: sessionId,
        ...scope,
        planId: selectedPlanId,
        nodes: editor.toSavePayload(),
      }),
    );
  }, [editor, runPlansAction, scope, selectedPlanId, sessionId]);

  const confirmPlan = useCallback(() => {
    if (editor.dirty || !selectedPlanId) return; // 有未保存编辑时先保存
    void runPlansAction((taskService) =>
      taskService.confirmOrchestrationPlan({
        orchestrationTaskId: sessionId,
        ...scope,
        planId: selectedPlanId,
      }),
    );
  }, [editor.dirty, runPlansAction, scope, selectedPlanId, sessionId]);

  // 计划级子任务默认模型（用户需求 2026-11-05）：即改即存（计划级配置不走编辑缓冲），
  // 随当前编辑缓冲一并落库（显式用户动作，顺带保存未存编辑是可接受的）。
  const onPickChildModelDefault = useCallback(
    (model: ModelSelection | null) => {
      if (!selectedPlanId) return;
      void runPlansAction((taskService) =>
        taskService.proposeOrchestrationPlanEdit({
          orchestrationTaskId: sessionId,
          ...scope,
          planId: selectedPlanId,
          nodes: editor.toSavePayload(),
          childModelDefault: model,
        }),
      );
    },
    [editor, runPlansAction, scope, selectedPlanId, sessionId],
  );

  // 节点卡片手动操作（用户需求 2026-11-02）：执行 = 向绑定子任务下发/派生新子任务并置
  // dispatched；手动完成 = 节点自己的完成口径（容错：回报丢失、线下完成）。都显式带
  // planId（看哪个改哪个）。
  const onExecuteNode = useCallback(
    (nodeId: string) => {
      if (!selectedPlanId) return;
      void runPlansAction((taskService) =>
        taskService.executeOrchestrationPlanNode({
          orchestrationTaskId: sessionId,
          ...scope,
          planId: selectedPlanId,
          planNodeId: nodeId,
        }),
      );
    },
    [runPlansAction, scope, selectedPlanId, sessionId],
  );
  const onToggleNodeDone = useCallback(
    (nodeId: string, done: boolean) => {
      if (!selectedPlanId) return;
      void runPlansAction((taskService) =>
        taskService.setOrchestrationPlanNodeManualDone({
          orchestrationTaskId: sessionId,
          ...scope,
          planId: selectedPlanId,
          planNodeId: nodeId,
          done,
        }),
      );
    },
    [runPlansAction, scope, selectedPlanId, sessionId],
  );

  // 节点自动执行开关（用户需求 2026-11-03 改版）：画布可编辑配置，进编辑缓冲随保存落库
  //（保存/确认后 adapter 触发就绪扫描生效）；不再走服务端即时翻转——那样未保存的新节点
  // 只能被禁用，违背"新增时就把配置确定好"。
  const onToggleNodeAuto = useCallback(
    (nodeId: string, auto: boolean) => {
      editor.updateNodeData(nodeId, { autoExecute: auto });
    },
    [editor],
  );

  // 开始节点总控：一键全开/全关非起始节点的自动执行（本地编辑，随保存落库）。
  const onToggleAllAuto = useCallback(
    (auto: boolean) => {
      editor.setAllAutoExecute(auto);
    },
    [editor],
  );

  const flowNodes = useMemo(() => editor.editNodes ?? editor.buildFlow(), [editor]);
  // 总控勾选态跟编辑缓冲走（本地可拨，含未保存节点）：全部非起始节点已开 = 勾选。
  const allAuto = useMemo(() => {
    const taskNodes = flowNodes.filter((node) => !node.data.isStart);
    return taskNodes.length > 0 && taskNodes.every((node) => node.data.autoExecute === true);
  }, [flowNodes]);

  // 保存前置校验（UI 预检；host 保存通道是权威）：悬空节点/环/起始唯一。
  const graphIssue = findGraphIssue(flowNodes);
  // 分类原因文案（工具栏常驻展示；点保存被拦时 pulse 强调）。
  const graphIssueText = useMemo(() => {
    switch (graphIssue) {
      case "dangling":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphDangling" });
      case "cycle":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphCycle" });
      case "start-missing":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphStart" });
      case "duplicate":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphDuplicate" });
      case "empty-goal":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphEmptyGoal" });
      case "unknown-dep":
        return intl.formatMessage({ id: "orchestration.plan.invalidGraphDangling" });
      default:
        return null;
    }
  }, [graphIssue, intl]);
  useEffect(() => {
    if (!graphIssue) setSaveBlockedPulse(false);
  }, [graphIssue]);

  // 保存入口（画布按钮 / Cmd+S 共用）：结构性问题（悬空/环/起始/重复）不允许保存；
  // 「节点没填目标」只拦确认执行，草稿可以先存后补（用户需求 2026-10-29 分级拦截）。
  const handleSave = useCallback(() => {
    if (!editable || !editor.dirty) return;
    if (graphIssue && graphIssue !== "empty-goal") {
      setSaveBlockedPulse(true);
      return;
    }
    saveDraft();
  }, [editable, editor, graphIssue, saveDraft]);

  // Cmd/Ctrl+S 保存计划（计划页挂载期间生效）。
  // Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z（兼容 Ctrl+Y）重做（用户需求 2026-11-02）：
  // 焦点在输入框/文本域/可编辑区域时不接管，交给原生文本撤销。
  const { undo, redo } = editor;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        handleSave();
        return;
      }
      if (!editable || isTextEditingTarget(event.target)) return;
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editable, handleSave, redo, undo]);

  const flowEdges = useMemo(() => {
    // 选中节点的上下游连线高亮（用户需求 2026-11-02）：指向它的（上游）和从它出发的
    // （下游）连线亮蓝加粗置顶，其余连线淡化；方向靠箭头读。选中态是 xyflow 维护的
    // node.selected（与右侧编辑窗同一事实源）。
    const selectedNodeId = flowNodes.find((candidate) => candidate.selected)?.id ?? null;
    return flowNodes.flatMap((node) =>
      node.data.dependsOn.flatMap((dep) => {
        const source = flowNodes.find((candidate) => candidate.id === dep);
        if (!source) return [];
        // 锚点按两节点相对位置自动挑选（横向走左右、纵向走上下），拖动后随渲染换侧。
        const handles = pickEdgeAnchorPair(source, node);
        const id = `${dep}->${node.id}`;
        const isSelected = id === selectedEdgeId;
        const touchesSelectedNode =
          selectedNodeId !== null && (dep === selectedNodeId || node.id === selectedNodeId);
        const highlighted = isSelected || touchesSelectedNode;
        const dimmed = selectedNodeId !== null && !highlighted;
        return [
          {
            id,
            source: dep,
            target: node.id,
            sourceHandle: handles.sourceHandle,
            targetHandle: handles.targetHandle,
            // 贝塞尔曲线 + 箭头指向下游：连线即父子/上下游关系（用户需求点 3）。
            type: "default" as const,
            animated: node.data.status === "dispatched" || node.data.status === "stale",
            selected: isSelected,
            // 高亮边置顶，避免被淡化的边盖住。
            zIndex: highlighted ? 1 : 0,
            style: {
              strokeWidth: highlighted ? 2.5 : 1.5,
              stroke: highlighted ? "#38bdf8" : "var(--color-plan-edge)",
              ...(dimmed ? { opacity: 0.3 } : {}),
            },
            markerEnd: {
              type: "arrowclosed" as const,
              width: 14,
              height: 14,
              color: highlighted ? "#38bdf8" : "#808089",
            },
            // 加宽命中区，点选/右键不用精确瞄准细线。
            interactionWidth: 24,
          },
        ];
      }),
    );
  }, [flowNodes, selectedEdgeId]);

  const selectedEdge = selectedEdgeId
    ? (flowEdges.find((edge) => edge.id === selectedEdgeId) ?? null)
    : null;

  // 执行进度（确认后展示；口径 = 非起始节点 terminal 占比，用户需求 4）。
  // 位置硬约束：必须在 loading 提前 return 之前——hooks 数量在 loading→ready
  // 两次渲染间不能变化（实测放 return 后触发 "Rendered more hooks" 崩溃）。
  const progress = useMemo(() => {
    if (plan?.status !== "confirmed") return null;
    const taskNodes = plan.nodes.filter((node) => !node.isStart);
    if (taskNodes.length === 0) return null;
    const done = taskNodes.filter((node) => node.status === "terminal").length;
    return { done, total: taskNodes.length };
  }, [plan]);

  // 计划级执行按钮（用户需求 2026-11-02）：确认后有待执行节点才出现；部分执行 → 继续执行。
  // 禁用态给出原因：有节点执行中 / 没有满足依赖、可立即执行的节点。
  const executePlan = useMemo(() => {
    if (!plan || plan.status === "draft" || plan.nodes.length === 0) return null;
    const taskNodes = plan.nodes.filter((node) => !node.isStart);
    const remaining = taskNodes.filter(
      (node) => node.status === "pending" || node.status === "stale",
    );
    const running = taskNodes.some((node) => node.status === "dispatched");
    // 全部完成（既无待执行也无执行中）才隐藏；执行中保留按钮但禁用，用户能看到为何不能点。
    if (taskNodes.length === 0 || (remaining.length === 0 && !running)) return null;
    // 依赖满足判定含起始节点（根节点直接依赖 start，start 不在可执行集合里）。
    const statusById = new Map(plan.nodes.map((node) => [node.nodeId, node.status]));
    const startNodeId = plan.nodes.find((node) => node.isStart)?.nodeId ?? "start";
    const readyCount = remaining.filter((node) =>
      node.dependsOn.every((dep) => dep === startNodeId || statusById.get(dep) === "terminal"),
    ).length;
    let disabledReason: string | null = null;
    if (running) {
      disabledReason = intl.formatMessage({ id: "orchestration.plan.planExecuteRunning" });
    } else if (readyCount === 0) {
      disabledReason = intl.formatMessage({ id: "orchestration.plan.planExecuteNoneReady" });
    }
    return {
      label: taskNodes.some((node) => node.status === "terminal")
        ? ("continue" as const)
        : ("execute" as const),
      disabledReason,
    };
  }, [intl, plan]);

  const onExecutePlan = useCallback(() => {
    if (!selectedPlanId) return;
    void runPlansAction((taskService) =>
      taskService.executeOrchestrationPlanNodes({
        orchestrationTaskId: sessionId,
        ...scope,
        planId: selectedPlanId,
      }),
    );
  }, [runPlansAction, scope, selectedPlanId, sessionId]);

  if (loadState !== "ready" || !plansMap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
        {loadState === "loading" ? (
          <>
            <LoaderIcon aria-hidden="true" className="size-4 animate-spin" />
            {intl.formatMessage({ id: "orchestration.plan.loading" })}
          </>
        ) : (
          <>
            {intl.formatMessage({ id: "orchestration.plan.loadFailed" })}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetrySerial((current) => current + 1)}
            >
              {intl.formatMessage({ id: "orchestration.plan.retry" })}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="orchestration-plan-page">
      <OrchestrationPlanPageToolbar
        editable={editable}
        dirty={editor.dirty}
        // 至少一个非起始节点才可确认（用户需求 2026-11-02）：起始节点只是结构标记。
        hasNodes={plan?.nodes.some((node) => !node.isStart) ?? false}
        saveBlockedReason={graphIssueText}
        saveBlockedPulse={saveBlockedPulse}
        busy={busy}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={undo}
        onRedo={redo}
        onBack={onBack}
        onAddNode={() => {
          // 新节点落在当前画布视口中心（不 fitView 缩放屏幕——用户反馈点 3）。
          const container = document
            .querySelector('[data-testid="orchestration-plan-page"] .react-flow')
            ?.getBoundingClientRect();
          const position = container
            ? flowInstanceRef.current?.screenToFlowPosition({
                x: container.left + container.width / 2,
                y: container.top + container.height / 2,
              })
            : undefined;
          editor.addNode(position);
        }}
        onTidyLayout={editor.tidyLayout}
        childModelDefault={plan?.childModelDefault ?? null}
        modelCandidates={modelCandidates}
        onPickChildModelDefault={onPickChildModelDefault}
        onSave={handleSave}
        onConfirm={confirmPlan}
        progress={progress}
        canConfirm={canConfirm}
        executePlan={executePlan}
        onExecutePlan={onExecutePlan}
      />
      {/* 主体：画布 + 编辑侧栏（空计划时显示引导行） */}
      {editable && flowNodes.length <= 1 ? (
        <div className="shrink-0 border-b border-border-subtle px-3 py-1.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "orchestration.plan.emptyCanvasHint" })}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <OrchestrationPlanFlow
            nodes={flowNodes}
            edges={flowEdges}
            editable={editable}
            busy={busy}
            onExecuteNode={onExecuteNode}
            onToggleNodeDone={onToggleNodeDone}
            onToggleNodeAuto={onToggleNodeAuto}
            onToggleAllAuto={onToggleAllAuto}
            allAuto={allAuto}
            savedNodeIds={savedNodeIds}
            onNodeClick={(nodeId) => {
              editor.clearInlineEdit();
              setSelectedEdgeId(null);
              void nodeId;
            }}
            onNodeDoubleClick={(nodeId) => editor.onNodeDoubleClick(nodeId)}
            onNodeContextMenu={(nodeId, position) =>
              setContextMenu({ ...position, kind: "node", nodeId })
            }
            onPaneClick={() => {
              editor.clearInlineEdit();
              setContextMenu(null);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(edgeId) =>
              setSelectedEdgeId((current) => (current === edgeId ? null : edgeId))
            }
            onEdgeContextMenu={(edge, position) =>
              setContextMenu({ ...position, kind: "edge", edge })
            }
            onConnect={(connection) => editor.onConnect(connection as Connection)}
            onNodesChange={editor.onNodesChange}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
          >
            {editable ? (
              <OrchestrationPlanEdgeEndpoints
                edge={
                  selectedEdge
                    ? {
                        edgeId: selectedEdge.id,
                        source: selectedEdge.source,
                        target: selectedEdge.target,
                        sourceHandle: selectedEdge.sourceHandle,
                        targetHandle: selectedEdge.targetHandle,
                      }
                    : null
                }
                nodes={flowNodes}
                onReconnect={editor.reconnectEdge}
              />
            ) : null}
          </OrchestrationPlanFlow>
        </div>
        {editable && editNode ? (
          <PlanNodeEditor
            editNode={editNode}
            busy={busy}
            childCandidates={childCandidates}
            onBindChild={onBindChild}
            pinnedSkill={editNode.pinnedSkills[0] ?? null}
            // 只取 ~/.zcode/skills 这一级（用户需求 2026-11-04）：scope 过滤挡不住
            // （~/.agents 等目录的技能也被标 user），按目录路径精确过滤。
            skillCandidates={skillCatalog.skills
              .filter((skill) => skill.path.includes("/.zcode/skills/"))
              .map((skill) => ({
                name: skill.name,
                description: skill.description,
              }))}
            onPickPinnedSkill={(name) =>
              editor.updateNodeData(editNode.nodeId, { pinnedSkills: name ? [name] : [] })
            }
            childModel={editNode.model ?? null}
            planChildModelDefault={plan?.childModelDefault ?? null}
            modelCandidates={modelCandidates}
            onPickChildModel={(model) => editor.updateNodeData(editNode.nodeId, { model })}
            thoughtLevel={editNode.thoughtLevel ?? null}
            onPickThoughtLevel={(level) =>
              editor.updateNodeData(editNode.nodeId, { thoughtLevel: level })
            }
            onPatch={(partial) => editor.updateNodeData(editNode.nodeId, partial)}
          />
        ) : null}
      </div>
      {/* 右键菜单：节点（重命名/删除，二次确认）与连线（删除） */}
      {contextMenu ? (
        <OrchestrationPlanContextMenu
          menu={contextMenu}
          nodeName={flowNodes.find((node) => node.id === contextMenu.nodeId)?.data.name ?? null}
          isStartNode={
            flowNodes.find((node) => node.id === contextMenu.nodeId)?.data.isStart === true
          }
          busy={busy}
          onClose={() => setContextMenu(null)}
          onRenameNode={(nodeId) => editor.onNodeDoubleClick(nodeId)}
          onDeleteNode={(nodeId) => {
            const node = flowNodes.find((candidate) => candidate.id === nodeId);
            if (!node) return;
            // 确认后画布可编辑（用户需求 2026-10-30），但已派发/已完结节点是执行中的
            // 事实——删除会让终态回传找不到节点、进度推导失真，只允许删 pending 节点。
            if (node.data.status && node.data.status !== "pending") {
              void confirmDialog({
                title: intl.formatMessage(
                  { id: "orchestration.plan.deleteFrozenNodeTitle" },
                  { name: node.data.name },
                ),
                description: intl.formatMessage({
                  id: "orchestration.plan.deleteFrozenNodeDescription",
                }),
                confirmLabel: intl.formatMessage({ id: "orchestration.plan.confirm" }),
              });
              return;
            }
            void confirmDialog({
              title: intl.formatMessage(
                { id: "orchestration.plan.deleteNodeConfirmTitle" },
                { name: node.data.name },
              ),
              description: intl.formatMessage({
                id: "orchestration.plan.deleteNodeConfirmDescription",
              }),
              confirmLabel: intl.formatMessage({ id: "orchestration.plan.deleteNode" }),
            }).then((confirmed) => {
              if (confirmed) editor.removeSelectedNode(nodeId);
            });
          }}
          onDeleteEdge={(edge) => editor.removeEdge(edge.source, edge.target)}
        />
      ) : null}
    </div>
  );
}
