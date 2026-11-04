// 编排计划画布的编辑状态机 hook（spec: packages/services/specs/orchestration-plan.md）。
// 单一事实 = flow 节点数组（xyflow 标准受控）：onNodesChange 用 applyNodeChanges 应用
// 全部变更（拖动/选中/缩放真正生效），依赖存在节点 data.dependsOn 上（连线 = 父子/上下游，
// 箭头指向下游）。位置不钳制（可负）；布局（位置+尺寸）在保存时写回 plan 节点 layout 持久化。
// resetKey（planId:version）变化 → 丢弃未保存编辑并按当前计划重建。
/* eslint-disable max-lines -- 画布状态机（编辑不变量/防环/服务器事实补丁）集中一个 hook
 * 才能保证 ref+state 双写镜像的一致性；拆分反而会复刻"直写 state 留下过期 ref"的实测坑。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyNodeChanges, type NodeChange, type Node as FlowNode } from "@xyflow/react";
import {
  computePlanLayout,
  fillMissingLayoutPositions,
} from "@zcode/shared/orchestration-plan-layout";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  DEFAULT_START_NODE_HEIGHT,
  type CardData,
  type EditableNode,
} from "@/OrchestrationPlanCanvasNodes.js";

type PlanFlowNode = FlowNode<CardData>;

/** 撤销栈上限：超过后丢弃最早的快照。 */
const HISTORY_LIMIT = 100;

export interface OrchestrationPlanCanvasEditorParams {
  /** 当前选中计划的节点（plan.nodes）。 */
  planNodesBase: EditableNode[];
  /** 重建缓冲的键（planId:version）；变化时丢弃未保存编辑。 */
  resetKey: string;
  editable: boolean;
  newNameLabel: string;
  /** 子任务会话 id → 真实标题（sessions-index 解析）。已绑定节点卡片显示真实子任务，
   * 未绑定的回落节点名（派发后子任务标题即节点名，但用户可能重命名会话）。 */
  childTaskTitles?: Record<string, string>;
}

function buildFlowNodes(
  planNodes: EditableNode[],
  inlineEditNodeId: string | null,
  editable: boolean,
  onNameChange: (nodeId: string, name: string) => void,
  childTaskTitles: Record<string, string> = {},
): PlanFlowNode[] {
  // 兜底布局（2026-11-04 整理布局）：与「整理布局」/服务端落库同一算法（shared 分层布局），
  // fixed = 已保存坐标——存量混合计划里缺坐标节点落在合理位置，不压盖已保存节点。
  const fallback = fillMissingLayoutPositions(planNodes);
  return planNodes.map((node) => ({
    id: node.nodeId,
    type: "planNode" as const,
    position: node.layout ?? fallback.get(node.nodeId) ?? { x: 0, y: 0 },
    // 尺寸挂在 xyflow 节点壳上（node.style）：NodeResizer 改的也是壳尺寸，卡片负责
    // 填满壳（w-full h-full）。默认尺寸也挂壳——卡片自带 min 尺寸会在壳缩小时溢出
    //（用户截图：宽度没变、边框进去了）。高度下限（minHeight）保证历史小布局随内容
    // 长高（自动行加入后旧 h=42 的开始节点被裁切，用户需求 2026-11-03）。
    // 保存高度只当下限（用户需求 2026-11-04 常驻 skill 行）：显式 height 会把比它高的
    // 内容裁切（CSS height 被 minHeight 抬到下限后不再随内容生长）——改为
    // minHeight = max(保存高度, 默认下限)，卡片加行时壳自动长高包住全部内容，
    // 用户手动调大的高度（layout.h）也不受影响。
    style: {
      width: node.layout?.w ?? DEFAULT_NODE_WIDTH,
      minHeight: Math.max(
        node.layout?.h ?? 0,
        node.isStart ? DEFAULT_START_NODE_HEIGHT : DEFAULT_NODE_HEIGHT,
      ),
      // 纵向 flex + 卡片 flex-1（用户需求 2026-11-03"箭头悬空"）：minHeight 抬高壳而
      // 内容不足时，卡片 h-full 的百分比高度解析不到（壳无显式 height），卡与壳之间
      // 会留一段空白，底部锚点/边线落点悬在空白上；flex 布局让卡片始终填满壳。
      display: "flex" as const,
      flexDirection: "column" as const,
    },
    data: {
      name: node.name,
      goal: node.goal,
      status: node.status,
      needsUpstreamResult: node.needsUpstreamResult,
      dependsOn: node.dependsOn,
      isStart: node.isStart,
      childTaskId: node.childTaskId,
      childTitle: node.childTaskId ? (childTaskTitles[node.childTaskId] ?? node.name) : null,
      // 用户手动确定的绑定（画布卡片锁标 + agent 改绑拒绝的展示面）。
      childLocked: node.childTaskLocked ?? false,
      // 自动执行开关（用户需求 2026-11-03 改版）：画布可编辑配置，进编辑缓冲随保存落库。
      autoExecute: node.autoExecute ?? false,
      // 常驻 skill（用户需求 2026-11-04）：派发时写入子会话；画布可编辑配置随保存落库。
      pinnedSkills: node.pinnedSkills ?? [],
      w: node.layout?.w,
      h: node.layout?.h,
      editingName: editable && inlineEditNodeId === node.nodeId,
      onNameChange: (name: string) => onNameChange(node.nodeId, name),
    } satisfies CardData,
  }));
}

/** target→…→source 可达即成环（新增 source→target 依赖前检查）。 */
function wouldCycle(
  from: string,
  to: string,
  nodes: Array<{ id: string; data: { dependsOn: string[] } }>,
): boolean {
  if (from === to) return true;
  const node = nodes.find((candidate) => candidate.id === from);
  if (!node) return false;
  return node.data.dependsOn.some((dep) => wouldCycle(dep, to, nodes));
}

/** 画布图不变量（保存前 UI 预检，host 保存通道是权威）：恰好一个起始节点、
 * 无环、全部节点直接或间接可达起始、id 唯一。返回 null = 合法，否则返回提示码。 */
export function findGraphIssue(nodes: PlanFlowNode[]): string | null {
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) return "duplicate";
  const starts = nodes.filter((node) => node.data.isStart);
  if (starts.length !== 1) return "start-missing";
  const start = starts[0]!;
  for (const node of nodes) {
    for (const dep of node.data.dependsOn) {
      if (!nodes.some((candidate) => candidate.id === dep)) return "unknown-dep";
      if (dep === node.id) return "cycle";
    }
  }
  for (const node of nodes) {
    for (const dep of node.data.dependsOn) {
      if (wouldCycle(dep, node.id, nodes)) return "cycle";
    }
  }
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.data.dependsOn) {
      children.set(dep, [...(children.get(dep) ?? []), node.id]);
    }
  }
  const reachable = new Set<string>([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (!reachable.has(child)) {
        reachable.add(child);
        queue.push(child);
      }
    }
  }
  if (nodes.some((node) => !reachable.has(node.id))) return "dangling";
  // 执行前置（用户需求 2026-10-29）：非起始节点必须已填写目标（只拦确认，不拦保存草稿）。
  if (nodes.some((node) => !node.data.isStart && node.data.goal.trim() === "")) {
    return "empty-goal";
  }
  return null;
}

export function useOrchestrationPlanCanvasEditor(params: OrchestrationPlanCanvasEditorParams) {
  const { planNodesBase, resetKey, editable, newNameLabel, childTaskTitles } = params;
  const planNodesRef = useRef(planNodesBase);
  planNodesRef.current = planNodesBase;
  const childTaskTitlesRef = useRef(childTaskTitles);
  childTaskTitlesRef.current = childTaskTitles;

  const [editNodes, setEditNodes] = useState<PlanFlowNode[] | null>(null);
  // updater 必须纯（React StrictMode 双调）：当前值经 ref 读取，禁止嵌套 setState。
  // 所有写入必须走这里（ref + state 双写）：直接 setEditNodes 会留下过期 ref，
  // 下一次 onNodesChange 用旧 base 应用拖拽 → 把刚连的边/刚改的字段整体冲掉
  //（实测：连线后一拖节点连线消失，就是 updateNodeData/onConnect/removeEdge 直写 state 导致）。
  const editNodesRef = useRef<PlanFlowNode[] | null>(null);
  const setEditNodesBoth = useCallback(
    (next: PlanFlowNode[] | null | ((current: PlanFlowNode[] | null) => PlanFlowNode[] | null)) => {
      const resolved = typeof next === "function" ? next(editNodesRef.current) : next;
      editNodesRef.current = resolved;
      setEditNodes(resolved);
    },
    [],
  );
  const [dirty, setDirty] = useState(false);
  const [inlineEditNodeId, setInlineEditNodeId] = useState<string | null>(null);

  // 撤销/重做栈（用户需求 2026-11-02）：快照 = 完整 flow 节点数组（位置/尺寸/数据）。
  // 栈随 resetKey 清空（切计划/保存/版本变化），计划之间天然独立；只覆盖本次未保存编辑。
  // 栈放 ref（高频入栈不触发渲染），长度镜像到 state 驱动按钮禁用态。
  const historyRef = useRef<{ past: PlanFlowNode[][]; future: PlanFlowNode[][] }>({
    past: [],
    future: [],
  });
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 });
  // 拖动/缩放会话：从 dragging/resizing=true 到 =false 只入栈一次（起点快照）。
  const geometrySessionRef = useRef(false);
  // 侧栏连续输入合并：同节点同字段 1s 内不重复入栈。
  const lastFieldEditRef = useRef<{ nodeId: string; key: string; at: number } | null>(null);
  const syncHistoryCounts = useCallback(() => {
    setHistoryCounts({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  }, []);
  /** 变更前入栈（传入变更前的节点数组）；任何新编辑都清空重做栈并打断输入合并。 */
  const pushHistory = useCallback(
    (snapshot: PlanFlowNode[]) => {
      const history = historyRef.current;
      history.past.push(snapshot);
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
      history.future = [];
      lastFieldEditRef.current = null;
      syncHistoryCounts();
    },
    [syncHistoryCounts],
  );
  const resetHistory = useCallback(() => {
    historyRef.current = { past: [], future: [] };
    geometrySessionRef.current = false;
    lastFieldEditRef.current = null;
    syncHistoryCounts();
  }, [syncHistoryCounts]);

  // 服务端绑定快照（2026-11-04 解链清绑定）：patchServerFacts 用它识别"服务端绑定
  // 从有到无"的迁移。只有缓冲绑定仍等于上次服务端值（用户没在缓冲里改过）才同步
  // 清缓冲——未保存的绑定编辑归编辑缓冲所有，不误伤。
  const lastServerBindingRef = useRef<Map<string, string | null>>(new Map());

  // 计划切换/版本变化 → 丢弃未保存编辑并按当前计划重建画布。
  // 必须连 ref 一起清（setEditNodesBoth）：只清 state 会留下上一份计划的 ref，
  // 同一提交里后执行的服务器事实补丁 effect 会按 ref 里的旧计划节点整表回填，
  // 计划互切后画布永远停在上一个计划（实测 2026-10-30：A→B 后仍是 A 的 13 节点）。
  useEffect(() => {
    setEditNodesBoth(null);
    setDirty(false);
    setInlineEditNodeId(null);
    lastServerBindingRef.current.clear();
    resetHistory();
  }, [resetKey, resetHistory, setEditNodesBoth]);

  const buildFlow = useCallback(
    (): PlanFlowNode[] =>
      buildFlowNodes(
        planNodesRef.current,
        inlineEditNodeId,
        editable,
        handleInlineNameChange,
        childTaskTitlesRef.current,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, inlineEditNodeId],
  );

  // 服务器事实补丁（用户需求 2026-10-30）：计划在别处被改（agent 绑定子任务、终态回传、
  // stale 标记）时广播重拉 plansMap、planNodesBase 更新。已编辑过的画布不能整体重建
  // （会冲掉未保存编辑），只回填非编辑字段 status/childTaskId/childTitle；名称/目标/
  // 依赖/布局属用户编辑面不在此同步（保存以画布为准），整表增删走 resetKey 重建。
  // 抽成函数：撤销/重做恢复快照时同样按当前服务端事实回填（快照里的状态可能已过期，
  // 撤销不能把已派发节点"撤回"成待执行）。未变化时返回原数组（引用稳定）。
  const patchServerFacts = useCallback((nodes: PlanFlowNode[]): PlanFlowNode[] => {
    const serverById = new Map(planNodesRef.current.map((node) => [node.nodeId, node]));
    let changed = false;
    const next = nodes.map((node) => {
      const server = serverById.get(node.id);
      if (!server) return node;
      const serverBinding = server.childTaskId ?? null;
      const seen = lastServerBindingRef.current.has(node.id);
      const lastBinding = lastServerBindingRef.current.get(node.id) ?? null;
      let data = node.data;
      // autoExecute / 绑定的常规回填不在服务端事实之列（用户需求 2026-11-03 改版）：
      // 它们是画布可编辑配置，归属编辑缓冲，随保存落库；常规回填会在保存前把用户
      // 刚改的开关/绑定冲回服务端旧值。唯一例外是下面的解链清空迁移。
      const status = server.status;
      if (data.status !== status) {
        data = { ...data, status };
      }
      // 解链清绑定（用户需求 2026-11-04）：unlinkTask 落库后服务端绑定非空→空，
      // 缓冲没被用户改过（仍等于上次服务端值）→ 缓冲一并清空，下拉随候选列表
      // 重拉不再出现该任务。
      if (
        seen &&
        lastBinding !== null &&
        serverBinding === null &&
        (data.childTaskId ?? null) === lastBinding
      ) {
        data = { ...data, childTaskId: null, childTitle: null, childLocked: false };
      }
      lastServerBindingRef.current.set(node.id, serverBinding);
      if (data !== node.data) {
        changed = true;
        return { ...node, data };
      }
      return node;
    });
    return changed ? next : nodes;
  }, []);
  useEffect(() => {
    setEditNodesBoth((current) => (current ? patchServerFacts(current) : current));
  }, [planNodesBase, childTaskTitles, patchServerFacts, setEditNodesBoth]);

  /** 文本类字段（name/goal）连续输入合并入栈：同节点同字段 1s 内只记起点快照。 */
  const pushFieldEditHistory = useCallback(
    (base: PlanFlowNode[], nodeId: string, key: string) => {
      const now = Date.now();
      const last = lastFieldEditRef.current;
      const coalesce =
        last !== null && last.nodeId === nodeId && last.key === key && now - last.at < 1000;
      if (!coalesce) pushHistory(base);
      lastFieldEditRef.current = { nodeId, key, at: now };
    },
    [pushHistory],
  );

  /** 双击节点 → 内联改名（数据写回 flow 节点）。 */
  const handleInlineNameChange = useCallback(
    (nodeId: string, name: string) => {
      const base = editNodesRef.current ?? buildFlow();
      pushFieldEditHistory(base, nodeId, "name");
      const next = base.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, name } } : node,
      );
      setEditNodesBoth(next);
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildFlow, pushFieldEditHistory, setEditNodesBoth],
  );

  /** 添加节点（append + 选中 + 直接进入内联改名）。position 由页面按画布视口中心换算，
   * 不再 fitView（用户反馈：加点不该缩放屏幕）。 */
  const addNode = useCallback(
    (position?: { x: number; y: number }) => {
      const existing = editNodes ?? buildFlow();
      const id = `n${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      // 兜底位 = 分层布局给新节点（无依赖 → 第 0 层）算的不碰撞槽位。
      const fallback = fillMissingLayoutPositions([
        ...existing.map((node) => ({
          nodeId: node.id,
          dependsOn: node.data.dependsOn,
          layout: { x: node.position.x, y: node.position.y },
        })),
        { nodeId: id, dependsOn: [] },
      ]).get(id) ?? { x: 60, y: 60 };
      const layout = {
        x: position?.x ?? fallback.x,
        y: position?.y ?? fallback.y,
      };
      const base = editNodesRef.current ?? existing;
      pushHistory(base);
      const next = [
        ...base.map((node) => ({ ...node, selected: false })),
        {
          id,
          type: "planNode" as const,
          position: layout,
          selected: true,
          // 高度交给内容撑开（minHeight 下限）：新节点 4 行内容，写死高度必然裁切。
          style: {
            width: DEFAULT_NODE_WIDTH,
            minHeight: DEFAULT_NODE_HEIGHT,
            display: "flex" as const,
            flexDirection: "column" as const,
          },
          data: {
            name: newNameLabel,
            goal: "",
            status: "pending" as const,
            needsUpstreamResult: false,
            dependsOn: [],
            childTitle: null,
            // editingName 必须直接写进缓存数据：它只在构建时计算，
            // 事后改 inlineEditNodeId 不会让缓存数组里的输入框出现（实测踩坑）。
            childTaskId: null,
            childLocked: false,
            // UI 新建节点默认手动（用户需求 2026-11-03）：自动与否由用户/总控决定。
            autoExecute: false,
            pinnedSkills: [],
            editingName: true,
            onNameChange: (name: string) => handleInlineNameChange(id, name),
          } satisfies CardData,
        },
      ];
      setEditNodesBoth(next);
      setInlineEditNodeId(id);
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editNodes, newNameLabel],
  );

  /** 进入内联改名（双击/右键重命名统一入口）：editingName 写进 editNodes 缓存，
   * 只改 inlineEditNodeId 对已缓存数组无效（输入框永远不出现，实测踩坑）。 */
  const enterInlineEdit = useCallback(
    (nodeId: string) => {
      setInlineEditNodeId(nodeId);
      setEditNodesBoth((current) =>
        (current ?? buildFlow()).map((node) => ({
          ...node,
          data: {
            ...node.data,
            editingName: node.id === nodeId,
            onNameChange: (name: string) => handleInlineNameChange(node.id, name),
          },
        })),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildFlow, handleInlineNameChange],
  );

  /** 退出内联改名（点空白/点击其他节点）：清缓存里的 editingName。 */
  const clearInlineEdit = useCallback(() => {
    setInlineEditNodeId(null);
    setEditNodesBoth((current) =>
      current
        ? current.map((node) => ({ ...node, data: { ...node.data, editingName: false } }))
        : null,
    );
  }, []);

  /** 编辑节点字段（侧栏/内联改名/卡片自动开关统一入口）：写 flow 节点 data（走双写镜像）。 */
  const updateNodeData = useCallback(
    (
      nodeId: string,
      partial: Partial<
        Pick<
          CardData,
          | "name"
          | "goal"
          | "needsUpstreamResult"
          | "dependsOn"
          | "autoExecute"
          | "childTaskId"
          | "childTitle"
          | "childLocked"
          | "pinnedSkills"
        >
      >,
    ) => {
      const base = editNodesRef.current ?? buildFlow();
      const keys = Object.keys(partial).sort().join(",");
      // 只有文本字段合并连续输入；勾选/依赖这类离散变更每次独立一步。
      if (keys === "goal" || keys === "name") pushFieldEditHistory(base, nodeId, keys);
      else pushHistory(base);
      setEditNodesBoth(
        base.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...partial } } : node,
        ),
      );
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, pushFieldEditHistory, pushHistory],
  );

  /** 连线 = 建依赖（target dependsOn source）；防环防自连；起始节点不能当 target。 */
  const onConnect = useCallback(
    (connection: { source: string | null; target: string | null }) => {
      const source = connection.source;
      const target = connection.target;
      if (!source || !target || source === target) return;
      const base = editNodesRef.current ?? buildFlow();
      const targetNode = base.find((node) => node.id === target);
      if (!targetNode || targetNode.data.isStart) return;
      if (!base.some((node) => node.id === source)) return;
      if (targetNode.data.dependsOn.includes(source)) return;
      if (wouldCycle(target, source, base)) return;
      pushHistory(base);
      setEditNodesBoth(
        base.map((node) =>
          node.id === target
            ? { ...node, data: { ...node.data, dependsOn: [...node.data.dependsOn, source] } }
            : node,
        ),
      );
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, pushHistory],
  );

  /** 双击连线删除依赖。 */
  const removeEdge = useCallback(
    (source: string, target: string) => {
      const base = editNodesRef.current ?? buildFlow();
      pushHistory(base);
      setEditNodesBoth(
        base.map((node) =>
          node.id === target
            ? {
                ...node,
                data: {
                  ...node.data,
                  dependsOn: node.data.dependsOn.filter((dep) => dep !== source),
                },
              }
            : node,
        ),
      );
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, pushHistory],
  );

  /** xyflow 标准受控：applyNodeChanges 应用全部变更（拖动/选中/缩放）。
   * 不钳制位置：fitView 平移下 flow 坐标 (0,0) 不是屏幕原点，钳 ≥0 会把
   * 原点附近的节点向上/向左拖不动（实测踩坑）。updater 全程纯（ref 读当前值）。
   * dirty 只认真实拖拽（position.dragging）与缩放（dimensions.resizing）——
   * 初次挂载的测量 dimensions 变更不算编辑（否则计划页一打开就亮保存）。
   * 撤销粒度：一次拖动/缩放会话（dragging/resizing 从 true 到 false）只在起点入栈一次。 */
  const onNodesChange = useCallback(
    (changes: NodeChange<PlanFlowNode>[]) => {
      if (!editable) return;
      const base = editNodesRef.current ?? buildFlow();
      const startsGeometry = changes.some(
        (change) =>
          (change.type === "position" && change.dragging === true) ||
          (change.type === "dimensions" && change.resizing === true),
      );
      const endsGeometry = changes.some(
        (change) =>
          (change.type === "position" && change.dragging === false) ||
          (change.type === "dimensions" && change.resizing === false),
      );
      if (startsGeometry && !geometrySessionRef.current) {
        pushHistory(base);
        geometrySessionRef.current = true;
      }
      if (endsGeometry) geometrySessionRef.current = false;
      const applied = applyNodeChanges(changes, base);
      setEditNodesBoth(applied);
      const isUserGeometry = changes.some(
        (change) =>
          (change.type === "position" && change.dragging !== undefined) ||
          (change.type === "dimensions" && change.resizing === true),
      );
      if (isUserGeometry) {
        // 布局不镜像 state：保存时 toSavePayload 直接读节点位置 + measured 尺寸。
        setDirty(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, buildFlow, pushHistory, setEditNodesBoth],
  );

  /** 拖动连线端点改目标（用户需求点 1）：等价于"删旧边 + 按全部校验建新边"——
   * 目标换成新节点（换上游同理），去旧依赖、防环、防自连、起始不可当 target。 */
  const reconnectEdge = useCallback(
    (oldSource: string, oldTarget: string, newSource: string, newTarget: string) => {
      if (!oldSource || !oldTarget || !newSource || !newTarget) return;
      if (oldSource === newSource && oldTarget === newTarget) return;
      if (newSource === newTarget) return;
      const base = editNodesRef.current ?? buildFlow();
      const newTargetNode = base.find((node) => node.id === newTarget);
      if (!newTargetNode || newTargetNode.data.isStart) return;
      if (!base.some((node) => node.id === newSource)) return;
      // 先在"去掉旧边"的图上校验，避免旧边干扰环检测/重复判断。
      const stripped = base.map((node) =>
        node.id === oldTarget
          ? {
              ...node,
              data: {
                ...node.data,
                dependsOn: node.data.dependsOn.filter((dep) => dep !== oldSource),
              },
            }
          : node,
      );
      const strippedTarget = stripped.find((node) => node.id === newTarget);
      if (!strippedTarget || strippedTarget.data.dependsOn.includes(newSource)) return;
      if (wouldCycle(newTarget, newSource, stripped)) return;
      pushHistory(base);
      const next = stripped.map((node) =>
        node.id === newTarget
          ? { ...node, data: { ...node.data, dependsOn: [...node.data.dependsOn, newSource] } }
          : node,
      );
      setEditNodesBoth(next);
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, pushHistory],
  );

  /** 删除节点（连带清理指向它的依赖边）；起始节点是结构标记，不可删除。 */
  const removeSelectedNode = useCallback(
    (nodeId: string) => {
      const base = editNodesRef.current ?? buildFlow();
      if (base.find((node) => node.id === nodeId)?.data.isStart) return;
      pushHistory(base);
      const next = base
        .filter((node) => node.id !== nodeId)
        .map((node) => ({
          ...node,
          data: {
            ...node.data,
            dependsOn: node.data.dependsOn.filter((dep) => dep !== nodeId),
          },
        }));
      setEditNodesBoth(next);
      setInlineEditNodeId(null);
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, pushHistory],
  );

  /** 开始节点总控（用户需求 2026-11-03）：一键全开/全关非起始节点的自动执行（本地编辑，
   * 随保存落库；就绪扫描在保存/确认后由 adapter 触发）。 */
  const setAllAutoExecute = useCallback(
    (auto: boolean) => {
      const base = editNodesRef.current ?? buildFlow();
      if (base.every((node) => node.data.isStart || node.data.autoExecute === auto)) return;
      pushHistory(base);
      setEditNodesBoth(
        base.map((node) =>
          node.data.isStart ? node : { ...node, data: { ...node.data, autoExecute: auto } },
        ),
      );
      setDirty(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildFlow, pushHistory, setEditNodesBoth],
  );

  /** 整理布局（用户需求 2026-11-04）：编辑缓冲全量重跑分层布局（不看存量坐标，
   * "梳理" = 重排全部）。入撤销栈可退；置 dirty 不自动保存——与拖动同一落库路径
   * （保存按钮 / ⌘S 读 toSavePayload 时带出新坐标）。 */
  const tidyLayout = useCallback(() => {
    const base = editNodesRef.current ?? buildFlow();
    if (base.length === 0) return;
    pushHistory(base);
    const positions = computePlanLayout(
      base.map((node) => ({ nodeId: node.id, dependsOn: node.data.dependsOn })),
    );
    setEditNodesBoth(
      base.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }),
    );
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildFlow, pushHistory, setEditNodesBoth]);

  const clearBuffers = useCallback(() => {
    editNodesRef.current = null;
    setEditNodes(null);
    setDirty(false);
    setInlineEditNodeId(null);
    resetHistory();
  }, [resetHistory]);

  /** 恢复快照：按 id 保留当前选中、清内联改名态、按服务端事实回填状态/绑定。 */
  const applySnapshot = useCallback(
    (snapshot: PlanFlowNode[]) => {
      const current = editNodesRef.current ?? buildFlow();
      const selectedIds = new Set(current.filter((node) => node.selected).map((node) => node.id));
      const restored = patchServerFacts(
        snapshot.map((node) => ({
          ...node,
          selected: selectedIds.has(node.id),
          data: { ...node.data, editingName: false },
        })),
      );
      setEditNodesBoth(restored);
      setInlineEditNodeId(null);
      geometrySessionRef.current = false;
      lastFieldEditRef.current = null;
    },
    [buildFlow, patchServerFacts, setEditNodesBoth],
  );

  /** 撤销：当前态压入重做栈，恢复上一快照；退到栈底即视为未修改。 */
  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push(editNodesRef.current ?? buildFlow());
    applySnapshot(previous);
    setDirty(history.past.length > 0);
    syncHistoryCounts();
  }, [applySnapshot, buildFlow, syncHistoryCounts]);

  /** 重做：当前态压回撤销栈，恢复下一快照。 */
  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next) return;
    history.past.push(editNodesRef.current ?? buildFlow());
    applySnapshot(next);
    setDirty(true);
    syncHistoryCounts();
  }, [applySnapshot, buildFlow, syncHistoryCounts]);

  /** 当前编辑态 → 保存载荷（依赖取自节点 data，布局取自位置+壳尺寸；起始标记透传）。 */
  const toSavePayload = useCallback(
    () =>
      (editNodes ?? buildFlow()).map((node) => {
        const w = node.measured?.width ?? node.data.w;
        const h = node.measured?.height ?? node.data.h;
        return {
          nodeId: node.id,
          name: node.data.name,
          goal: node.data.goal,
          dependsOn: node.data.dependsOn,
          needsUpstreamResult: node.data.needsUpstreamResult,
          // 自动执行/绑定随保存落库（用户需求 2026-11-03 改版）：编辑缓冲 → 服务端计划。
          ...(node.data.isStart
            ? {}
            : {
                autoExecute: node.data.autoExecute,
                childTaskId: node.data.childTaskId,
                childLocked: node.data.childLocked,
                pinnedSkills: node.data.pinnedSkills,
              }),
          ...(node.data.isStart ? { isStart: true } : {}),
          layout: {
            x: node.position.x,
            y: node.position.y,
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editNodes, dirty],
  );

  return {
    editNodes,
    dirty,
    buildFlow,
    handleInlineNameChange,
    addNode,
    onConnect,
    reconnectEdge,
    removeEdge,
    onNodesChange,
    removeSelectedNode,
    updateNodeData,
    onNodeDoubleClick: enterInlineEdit,
    clearInlineEdit,
    clearBuffers,
    setAllAutoExecute,
    tidyLayout,
    toSavePayload,
    undo,
    redo,
    canUndo: historyCounts.past > 0,
    canRedo: historyCounts.future > 0,
  };
}
