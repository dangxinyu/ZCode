// 编排计划的纯函数模型层（spec: packages/services/specs/orchestration-plan.md）。
// 从 orchestrationPlanService 拆出：行↔计划映射、DAG 校验、完成推导、微调修订 diff、
// 确认消息文案。无 IO，便于单测与复用。
import type {
  ZCodeOrchestrationPlanNodeProtocol,
  ZCodeOrchestrationPlanProtocol,
  ZCodeOrchestrationPlansMapProtocol,
} from "@zcode/shared";

export type OrchestrationPlanNode = ZCodeOrchestrationPlanNodeProtocol;
export type OrchestrationPlan = ZCodeOrchestrationPlanProtocol;

export interface WorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ProposedPlanNode {
  nodeId: string;
  name: string;
  goal: string;
  dependsOn: string[];
  needsUpstreamResult: boolean;
  /** 起始节点标记（用户需求 2026-10-29：每计划恰好一个，其余节点必须可达它）。 */
  isStart?: boolean;
  /** 依赖满足后自动执行（用户需求 2026-11-03 画布可编辑配置）：UI 保存随节点携带，
   * 缺省由服务端按新建/存量语义取默认。 */
  autoExecute?: boolean;
  /** 派发时写入子会话的常驻 skill（用户需求 2026-11-04）：提案值优先，缺省保留存量。 */
  pinnedSkills?: string[];
  /** 手动绑定的子任务（用户需求 2026-11-03 画布可编辑配置）：UI 保存随节点携带
   * （null = 显式解绑）；缺省（agent 提案）按存量语义处理，仅 pending 节点生效。 */
  childTaskId?: string | null;
  /** 用户手动绑定的锁定标记。 */
  childTaskLocked?: boolean;
  /** 画布布局（用户拖动后的位置/尺寸；UI 保存通道透传，模型提案不带）。 */
  layout?: { x: number; y: number; w?: number; h?: number };
}

/** 起始节点默认名（host 侧兜底注入时使用）。 */
export const START_NODE_NAME = "开始";
export const START_NODE_ID = "start";

type StartLike = {
  nodeId: string;
  name: string;
  goal: string;
  dependsOn: string[];
  needsUpstreamResult: boolean;
  isStart?: boolean;
};

/**
 * 起始节点规范化（用户需求 2026-10-29）：
 * - isStart 标记最多保留一个（多余的摘掉）；
 * - 无标记但占用了 start id 的存量节点 → 收编为起始（旧数据自愈，不产生重复 id）；
 * - 一个都没有 → 头部注入一个结构起始节点（不派发，仅作开始标记）。
 */
export function withStartNode<T extends StartLike>(
  nodes: T[],
  buildStart: (seed: Required<StartLike> & { isStart: true }) => T,
): T[] {
  let seen = false;
  const normalized = nodes.map((node) => {
    if (seen) {
      return node.isStart ? { ...node, isStart: undefined } : node;
    }
    if (node.isStart || node.nodeId === START_NODE_ID) {
      seen = true;
      // 起始节点语义收口：无目标、无上游（agent/存量数据带了也归零）。
      return {
        ...node,
        isStart: true,
        goal: "",
        dependsOn: [],
        needsUpstreamResult: false,
      };
    }
    return node;
  });
  if (seen) return normalized;
  return [
    buildStart({
      nodeId: START_NODE_ID,
      name: START_NODE_NAME,
      goal: "",
      dependsOn: [],
      needsUpstreamResult: false,
      isStart: true,
    }),
    ...normalized,
  ];
}

export interface PlanRowLike {
  planId: string;
  title: string;
  status: string;
  planJson: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export function parsePlanJson(raw: string): {
  version: number;
  nodes: OrchestrationPlanNode[];
  origin: "agent" | "manual";
} {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      nodes?: unknown;
      origin?: unknown;
    };
    if (typeof parsed.version === "number" && Array.isArray(parsed.nodes)) {
      return {
        version: parsed.version,
        nodes: parsed.nodes as OrchestrationPlanNode[],
        origin: parsed.origin === "manual" ? "manual" : "agent",
      };
    }
  } catch {
    // 损坏行按空计划处理（rows 由服务独占写入，正常不会走到）。
  }
  return { version: 0, nodes: [], origin: "agent" };
}

/** 读取时推导完成态（用户需求 2026-10-30）：计划是否完成只看节点状态，不信任存储列——
 * 中途关会话、终态写丢都不会让显示漂移（实测：绑定后 12/12 全 terminal 但行仍 confirmed，
 * 侧栏转圈不停）。库列退化为缓存，写入侧照常回写推导值保持一致。 */
export function rowToPlan(row: PlanRowLike): OrchestrationPlan {
  const { version, nodes, origin } = parsePlanJson(row.planJson);
  const stored =
    row.status === "draft" || row.status === "confirmed" || row.status === "completed"
      ? row.status
      : "draft";
  return {
    planId: row.planId,
    title: row.title,
    origin,
    status: deriveStatus(nodes, stored),
    version,
    nodes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 计划级完成推导（用户需求 2026-10-30：完成与否只看节点状态，不单独存储）：
 * 口径 = 非起始节点全部 terminal → completed（stale 不算 terminal，必须复核收敛；
 * start 是结构标记永远 pending——旧口径含 start 导致完成态永不翻转，实测踩坑）。
 * completed 在节点不再全 terminal 时（如修订加入新节点）回落 confirmed。 */
export function deriveStatus(
  nodes: OrchestrationPlanNode[],
  current: "draft" | "confirmed" | "completed",
): "draft" | "confirmed" | "completed" {
  if (current === "draft") return current;
  const taskNodes = nodes.filter((node) => !node.isStart);
  if (taskNodes.length > 0 && taskNodes.every((node) => node.status === "terminal")) {
    return "completed";
  }
  return current === "completed" ? "confirmed" : current;
}

/** 无上游的根节点自动挂到起始节点下（host 兜底：老版本 agent 不认识 start，
 * 注入后不接线校验必挂）。带 status 的节点只处理 pending（冻结节点不动，避免
 * 误触微调重执行）；无 status 的提案节点全部接线。 */
export function wireRootsToStart<
  T extends { nodeId: string; dependsOn: string[]; isStart?: boolean },
>(nodes: T[]): T[] {
  const start = nodes.find((node) => node.isStart);
  if (!start) return nodes;
  return nodes.map((node) => {
    if (node.isStart || node.nodeId === start.nodeId || node.dependsOn.length > 0) return node;
    const status = (node as { status?: string }).status;
    if (status !== undefined && status !== "pending") return node;
    return { ...node, dependsOn: [start.nodeId] };
  });
}

/** 图校验：nodeId 唯一、dependsOn 引用存在、无环、恰好一个起始节点且全图可达。 */
export function validatePlanGraph(nodes: ProposedPlanNode[]): void {
  const ids = new Set(nodes.map((node) => node.nodeId));
  if (ids.size !== nodes.length) throw new Error("Plan nodeIds must be unique.");
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Node "${node.nodeId}" depends on unknown node "${dep}".`);
      if (dep === node.nodeId) throw new Error(`Node "${node.nodeId}" depends on itself.`);
    }
  }
  const color = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    const state = color.get(id);
    if (state === 2) return;
    if (state === 1) throw new Error("Plan dependency graph must be acyclic.");
    color.set(id, 1);
    const node = nodes.find((candidate) => candidate.nodeId === id);
    for (const dep of node?.dependsOn ?? []) visit(dep);
    color.set(id, 2);
  };
  for (const node of nodes) visit(node.nodeId);
  // 起始节点不变量（用户需求 2026-10-29）：恰好一个、无上游；其余节点直接或间接可达它。
  const starts = nodes.filter((node) => node.isStart);
  if (starts.length !== 1) {
    throw new Error("Plan must have exactly one start node (isStart).");
  }
  const start = starts[0]!;
  if (start.dependsOn.length > 0) {
    throw new Error("The start node cannot depend on other nodes.");
  }
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      children.set(dep, [...(children.get(dep) ?? []), node.nodeId]);
    }
  }
  const reachable = new Set<string>([start.nodeId]);
  const queue = [start.nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (!reachable.has(child)) {
        reachable.add(child);
        queue.push(child);
      }
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.nodeId)) {
      throw new Error(
        `Node "${node.nodeId}" is not connected (directly or indirectly) to the start node.`,
      );
    }
  }
}

/**
 * 微调修订 diff（spec：微调重执行）：
 * - dispatched/terminal 节点冻结；其中 terminal 节点若被修改（名称/目标/依赖变化）→ 回
 *   pending 并保留 reuseChildTaskId（确认后优先下发原子任务）；
 * - 提案里删除的已派生节点保留（它们是 links 里的既成事实，视图不能消失）；
 * - 新节点 pending。
 */
export function revisePlanNodes(
  current: OrchestrationPlanNode[],
  proposed: ProposedPlanNode[],
  /** 新增/无历史节点的 autoExecute 默认值（按计划 origin：agent 提案 true / 手动 false，
   * 用户需求 2026-11-03）。按 nodeId 保留的原值优先。 */
  defaultAuto: boolean,
): OrchestrationPlanNode[] {
  const frozen = new Map(
    current
      .filter((node) => node.status === "dispatched" || node.status === "terminal")
      .map((node) => [node.nodeId, node]),
  );
  const modifiedIds = new Set(
    current
      .filter((prev) => {
        const next = proposed.find((candidate) => candidate.nodeId === prev.nodeId);
        return (
          prev.status === "terminal" &&
          next !== undefined &&
          (next.name !== prev.name ||
            next.goal !== prev.goal ||
            next.dependsOn.join("|") !== prev.dependsOn.join("|"))
        );
      })
      .map((prev) => prev.nodeId),
  );
  const nodes: OrchestrationPlanNode[] = proposed.map((node) => {
    const bound = frozen.get(node.nodeId);
    if (bound && !modifiedIds.has(node.nodeId)) {
      // 冻结节点保留执行事实（status/childTaskId），但布局是纯展示（用户需求
      // 2026-10-30：确认后画布可编辑，拖动/缩放保存后不能弹回旧位置）。
      return node.layout ? { ...bound, layout: node.layout } : bound;
    }
    if (bound) {
      return {
        nodeId: node.nodeId,
        name: node.name,
        goal: node.goal,
        dependsOn: node.dependsOn,
        // 上游只有起始节点时不可能有上游交付（用户需求 2026-10-30）。
        needsUpstreamResult: node.dependsOn.some((dep) => dep !== START_NODE_ID)
          ? node.needsUpstreamResult
          : false,
        ...(node.isStart ? { isStart: true } : {}),
        // 自动执行是画布可编辑配置（用户需求 2026-11-03）：提案携带的用户值优先，
        // 缺省保留存量值，无存量按计划 origin 取默认。
        ...(node.isStart
          ? {}
          : { autoExecute: node.autoExecute ?? bound.autoExecute ?? defaultAuto }),
        // 常驻 skill 随保存落库（用户需求 2026-11-04）：提案值优先，缺省保留存量。
        ...(node.isStart
          ? {}
          : { pinnedSkills: node.pinnedSkills ?? bound.pinnedSkills ?? [] }),
        status: "pending",
        // 绑定随保存落库（用户需求 2026-11-03 改版）：提案携带的用户绑定优先；
        // 未携带（agent 修订提案）→ 沿用旧绑定（不再清空只留微调提示）。
        childTaskId: node.isStart ? null : (node.childTaskId ?? bound.childTaskId),
        childTaskLocked: node.isStart
          ? false
          : (node.childTaskLocked ?? bound.childTaskLocked ?? false),
        ...(node.isStart || node.childTaskId ? {} : { reuseChildTaskId: bound.childTaskId }),
        ...((node.layout ?? bound.layout) ? { layout: node.layout ?? bound.layout } : {}),
      };
    }
    return {
      nodeId: node.nodeId,
      name: node.name,
      goal: node.goal,
      dependsOn: node.dependsOn,
      // 上游只有起始节点时不可能有上游交付（用户需求 2026-10-30）。
      needsUpstreamResult: node.dependsOn.some((dep) => dep !== START_NODE_ID)
        ? node.needsUpstreamResult
        : false,
      ...(node.isStart ? { isStart: true } : {}),
      ...(node.isStart ? {} : { autoExecute: node.autoExecute ?? defaultAuto }),
      ...(node.isStart ? {} : { pinnedSkills: node.pinnedSkills ?? [] }),
      status: "pending",
      // 全新节点：提案携带的用户绑定直接生效（用户需求 2026-11-03 改版）。
      childTaskId: node.isStart ? null : (node.childTaskId ?? null),
      childTaskLocked: node.isStart ? false : (node.childTaskLocked ?? false),
      ...(node.layout ? { layout: node.layout } : {}),
    };
  });
  for (const bound of frozen.values()) {
    if (!nodes.some((node) => node.nodeId === bound.nodeId)) nodes.push(bound);
  }
  return nodes;
}

/** 编排计划服务的公开 API（factory 返回类型的具名形式，spec: orchestration-plan.md）。 */
export type IOrchestrationPlanService = OrchestrationPlanServiceApi;
export interface OrchestrationPlanServiceApi {
  /** active 计划（无 active/无计划返回 null）。计划门与 CLI 反向请求用。 */
  getActivePlan: (
    params: WorkspaceScope & { orchestrationTaskId: string },
  ) => Promise<OrchestrationPlan | null>;
  isPlanModeOn: (params: WorkspaceScope & { orchestrationTaskId: string }) => Promise<boolean>;
  /** UI 批量读：模式 + 全量计划 + activePlanId。 */
  getPlansMap: (
    params: WorkspaceScope & { orchestrationTaskIds: string[] },
  ) => Promise<Record<string, ZCodeOrchestrationPlansMapProtocol>>;
  /** 模式开关：开时按"最近计划未完成则自动选中"规则处理选中态；不发消息。 */
  setPlanMode: (
    params: WorkspaceScope & { orchestrationTaskId: string; enabled: boolean },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
  /** UI 选中切换（planId=null = 全部取消选中）；不发消息。
   * clearNewPlanPending：用户显式点选现有计划 = 放弃「另起新计划」意图，同次写入清等待态
   * （仅 UI 选择入口传 true；执行前的内部预选不传，执行动作不替用户取消对话意图）。 */
  selectPlan: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      planId: string | null;
      clearNewPlanPending?: boolean;
    },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
  /** UI 手动创建空计划（draft、0 节点、置 active）；画布编辑后保存。 */
  createEmptyPlan: (
    params: WorkspaceScope & { orchestrationTaskId: string; title: string },
  ) => Promise<OrchestrationPlan>;
  /** UI 重命名计划。 */
  renamePlan: (
    params: WorkspaceScope & { orchestrationTaskId: string; planId: string; title: string },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
  /** UI 删除计划（删除的是计划行：子任务/关系不动；删 active 则选中清空）。 */
  deletePlan: (
    params: WorkspaceScope & { orchestrationTaskId: string; planId: string },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
  /**
   * 模型提交草案：planId 指定计划 → 修订（微调 diff，UI 编辑通道显式定位，
   * 用户需求 2026-10-30：看哪个存哪个）；缺省 = active 计划修订；无目标或
   * createNew → 新建。
   */
  proposePlan: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    nodes: ProposedPlanNode[];
    title?: string;
    /** true = 另起新计划承载本提案（不改 active 计划；用户需求 2026-10-29）。 */
    createNew?: boolean;
    /** 修订目标计划（UI 编辑通道）；缺省 = active 计划。指定但不存在 → 报错。 */
    planId?: string;
  }) => Promise<{ planId: string; version: number; status: "draft"; nodeCount: number }>;
  /**
   * 用户确认：目标 draft → confirmed，注入确认消息（节点清单；执行规则是常驻引导）；确认的计划同时
   * 置为唯一 active（执行口径跟随确认，用户需求 2026-10-30）。缺省 = active。
   */
  confirmPlan: (
    params: WorkspaceScope & { orchestrationTaskId: string; planId?: string },
  ) => Promise<OrchestrationPlan>;
  /** spawn 绑定：active 计划须 confirmed 且节点 pending；失败抛错。 */
  bindPlanNodeForSpawn: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    planNodeId: string;
    childTaskId: string;
  }) => Promise<void>;
  /**
   * 显式绑定（BindOrchestrationPlanNodes 工具，用户需求 2026-10-30）：把已关联
   * （linked/derived）子任务挂到 active confirmed 计划节点上，或解绑
   * （childTaskId=null）。绑定时按子任务当前状态回填节点状态（已完成的直接亮 terminal），
   * 画布的执行可见性才有数据可显示。返回实际发生变化的绑定数。
   */
  bindPlanNodesToChildren: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    bindings: Array<{ planNodeId: string; childTaskId: string | null }>;
  }) => Promise<{ updated: number }>;
  /** 节点进入 dispatched 的唯一口径（spec 执行通道统一）：未绑定则绑上该子任务，锁定到
   * 别的子任务/已在执行 → 拒绝；SendChildTaskPrompt 带 planNodeId 与 UI 手动执行共用。
   * 返回置态前的状态/绑定，供下发失败时 revertPlanNodeDispatch 回滚。 */
  markPlanNodeDispatched: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      planNodeId: string;
      childTaskId: string;
    },
  ) => Promise<{
    previousStatus: OrchestrationPlanNode["status"];
    previousChildTaskId: string | null;
  }>;
  /** 下发失败回滚（bug 修复 2026-11-03）：仅当节点仍是本次置的 dispatched 且绑定同一
   * childTaskId 才恢复为置态前的状态/绑定（防止覆盖并发的新派发）；否则静默不动。 */
  revertPlanNodeDispatch: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      planNodeId: string;
      childTaskId: string;
      previousStatus: OrchestrationPlanNode["status"];
      previousChildTaskId: string | null;
    },
  ) => Promise<void>;
  /** 手动完成滑块（容错）：done → terminal，!done → pending，关联/锁定不动；planId 缺省 active。 */
  setPlanNodeManualDone: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      planId?: string;
      planNodeId: string;
      done: boolean;
    },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
  /** spawn/link 计划门：模式开且无 confirmed active 计划 → 抛错引导提案。 */
  assertDispatchAllowed: (
    params: WorkspaceScope & { orchestrationTaskId: string },
  ) => Promise<void>;
  /** 子任务终态回传同步节点进度（全计划按 childTaskId 匹配）；含 completed 推导。
   * outcome（用户需求 2026-11-04）：成功 → terminal 绿；失败/被取消 → failed 红。
   * 返回本轮真实迁移的节点 id（2026-11-04：自动派发扫描按它限定触发范围）。 */
  markPlanNodeTerminal: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      childTaskId: string;
      outcome: "succeeded" | "failed";
    },
  ) => Promise<{ markedNodeIds: string[] }>;
  /** 子任务被用户取消关联（unlink）后清掉计划里对它的绑定（2026-11-04）：
   * 遍历全部计划，childTaskId 命中的节点清绑定+锁定，dispatched 回落 pending
   * （子任务脱离统筹后终态不再回传，留着 dispatched 会永久卡住「继续执行」）。
   * 返回发生清理的计划数。 */
  clearPlanNodesForUnlinkedChild: (
    params: WorkspaceScope & {
      orchestrationTaskId: string;
      childTaskId: string;
    },
  ) => Promise<{ clearedPlans: number }>;
  /** 微调变更传播（MarkPlanNodesStale 工具）：active 计划内置 stale / 复核完成回 terminal。 */
  markPlanNodesStale: (params: {
    orchestrationTaskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    nodeIds: string[];
    stale: boolean;
  }) => Promise<{ updated: number }>;
  /** 下拉「新建计划（AI 生成）」等待态开关（用户需求 2026-10-29 改版：不发任何消息，
   * 只挂服务端事实；起不起新计划由后续对话决定——agent 经 List 工具结果里的
   * pendingNewPlan 感知。新计划落地（createNew 提案）或用户再点取消时清除。 */
  setNewPlanPending: (
    params: WorkspaceScope & { orchestrationTaskId: string; pending: boolean },
  ) => Promise<ZCodeOrchestrationPlansMapProtocol>;
}

function describeNode(node: OrchestrationPlanNode): string {
  const deps = node.dependsOn.length > 0 ? `；依赖：${node.dependsOn.join("、")}` : "";
  const result = node.needsUpstreamResult ? "；派发时附上游交付摘要" : "";
  // 节点 id 必须列出（用户需求 2026-11-02）：手动建的计划节点 id 是随机串，不列出来 agent
  // 执行该节点时填不了 planNodeId（SpawnSubTask/SendChildTaskPrompt），节点永远进不了 dispatched。
  return `${node.name}［id: ${node.nodeId}］（${node.goal}${deps}${result}）`;
}

/** 确认消息（执行触发，注入编排会话）：计划清单（含节点 id）+ 微调复用；执行规则/多计划契约/变更传播是 CLI 计划模式常驻引导。 */
export function buildConfirmNotice(plan: OrchestrationPlan): string {
  const taskNodes = plan.nodes.filter((node) => !node.isStart);
  const lines = taskNodes.map((node, index) => `${index + 1}. ${describeNode(node)}`);
  const reuseNodes = plan.nodes.filter(
    (node) => node.status === "pending" && node.reuseChildTaskId,
  );
  // 自动执行节点计数（用户需求 2026-11-03）：让 agent/用户在确认时就知道哪些节点会自动流转。
  const autoCount = taskNodes.filter((node) => node.autoExecute === true).length;
  // 执行规则/多计划契约/变更传播不再进确认消息（用户需求 2026-11-02：别整段刷屏）——
  // 它们是计划模式的常驻约定，改住在 CLI 计划模式引导（dynamic-sections）里，每次都在上下文中。
  return (
    `【编排计划·确认】用户已确认执行计划「${plan.title}」（第 ${plan.version} 版）：\n` +
    lines.join("\n") +
    (autoCount > 0
      ? `\n自动执行：${autoCount}/${taskNodes.length} 个节点依赖满足后由 host 自动派发（含第一波）；其余节点按依赖波次由你派发。`
      : "") +
    (reuseNodes.length > 0
      ? `\n微调重执行：${reuseNodes.map((node) => node.name).join("、")} 是本次修改的节点，` +
        "优先向其原原子任务下发微调指令继续执行；仅当原子任务已归档/删除/解链时才重新派生。"
      : "")
  );
}
