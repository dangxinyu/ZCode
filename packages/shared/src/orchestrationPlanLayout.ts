// 编排计划画布的分层布局算法（spec: packages/services/specs/orchestration-plan.md
// 「卡片尺寸与自动布局」「自动整理布局」）。纯函数零依赖，三处共用同一实现：
// UI 渲染兜底（缺坐标节点）/ 工具栏「整理布局」/ 服务端 proposePlan 落库补算。
// 三阶段：最长路径定层 → 重心法层内排序（消除连线交叉的核心）→ 列间距/行间距坐标分配。
// 确定性：同输入同输出；防御性断环（编辑缓冲中间态不保证无环，算法绝不挂起）。

/** 布局输入节点（只关心结构与依赖；悬空 dependsOn 引用忽略）。 */
export interface PlanLayoutInputNode {
  nodeId: string;
  dependsOn: readonly string[];
}

export interface PlanLayoutPosition {
  x: number;
  y: number;
}

export interface PlanLayoutOptions {
  /** 列间距（层 = 列，左→右流向）。 */
  columnPitch?: number;
  /** 行间距（列内纵向等距）。 */
  rowPitch?: number;
}

/** 带 layout 的节点形状（编排计划节点 layout 字段，protocol：{x, y, w?, h?}）。 */
export interface PlanLayoutNode extends PlanLayoutInputNode {
  layout?: { x: number; y: number; w?: number; h?: number };
}

/** 与 UI 卡片默认尺寸对应的近似值，仅用于补缺时的矩形碰撞避让（非渲染尺寸）。 */
const CARD_WIDTH = 200;
const CARD_HEIGHT = 168;
/** 避让安全间距：补算位与锚定卡片至少留出这么大的空隙。 */
const COLLISION_MARGIN = 24;
const DEFAULT_COLUMN_PITCH = 320;
const DEFAULT_ROW_PITCH = 200;
/** 重心法扫描轮数（down/up 交替；小图 4 轮已充分收敛）。 */
const BARYCENTER_SWEEPS = 4;

export const PLAN_LAYOUT_COLUMN_PITCH = DEFAULT_COLUMN_PITCH;
export const PLAN_LAYOUT_ROW_PITCH = DEFAULT_ROW_PITCH;

/** 三阶段分层布局：返回每个节点的坐标（x = 层 × 列距；列内相对最高列垂直居中）。 */
export function computePlanLayout(
  nodes: readonly PlanLayoutInputNode[],
  options: PlanLayoutOptions = {},
): Map<string, PlanLayoutPosition> {
  const columnPitch = options.columnPitch ?? DEFAULT_COLUMN_PITCH;
  const rowPitch = options.rowPitch ?? DEFAULT_ROW_PITCH;
  const positions = new Map<string, PlanLayoutPosition>();
  if (nodes.length === 0) return positions;

  // 去重保序：定义顺序是层内初始排序与并列决选的稳定依据。
  const byId = new Map<string, PlanLayoutInputNode>();
  for (const node of nodes) {
    if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  }

  // ① 定层：最长路径（Kahn 拓扑序传播 layer = max(上游层) + 1）。
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const id of byId.keys()) {
    indegree.set(id, 0);
    downstream.set(id, []);
  }
  for (const node of byId.values()) {
    for (const dep of node.dependsOn) {
      // 悬空引用与自连边忽略；重复依赖只计一次（入度按边数扣会提前清零导致层算浅）。
      if (dep === node.nodeId || !byId.has(dep) || downstream.get(dep)!.includes(node.nodeId)) {
        continue;
      }
      indegree.set(node.nodeId, (indegree.get(node.nodeId) ?? 0) + 1);
      downstream.get(dep)!.push(node.nodeId);
    }
  }
  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    if (!layer.has(id)) layer.set(id, 0);
    for (const child of downstream.get(id)!) {
      layer.set(child, Math.max(layer.get(child) ?? 0, (layer.get(id) ?? 0) + 1));
      const degree = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }
  // 防御性断环：拓扑序覆盖不到的节点（环上/环下游）按层 0 收编，保证全图有坐标。
  for (const node of byId.values()) {
    if (!layer.has(node.nodeId)) layer.set(node.nodeId, 0);
  }

  // ② 层内排序：重心法降交叉。初始序 = 定义顺序；down/up 交替扫描，每节点排序键 =
  // 相邻层邻居当前序位均值（无邻居保持原位），稳定排序并列时保持既有相对次序。
  const columns: string[][] = [];
  for (const node of byId.values()) {
    const id = node.nodeId;
    (columns[layer.get(id) ?? 0] ??= []).push(id);
  }
  const orderIndex = new Map<string, number>();
  for (const column of columns) {
    column.forEach((id, index) => orderIndex.set(id, index));
  }
  const barycenter = (id: string, neighborIds: readonly string[]): number => {
    const neighbors = neighborIds
      .map((neighbor) => orderIndex.get(neighbor))
      .filter((value): value is number => value !== undefined);
    if (neighbors.length === 0) return orderIndex.get(id) ?? 0;
    return neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length;
  };
  for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    for (let step = 1; step < columns.length; step += 1) {
      const layerId = downward ? step : columns.length - 1 - step;
      const column = columns[layerId];
      if (!column || column.length === 0) continue;
      const keyed = column.map((id) => {
        const node = byId.get(id)!;
        const neighbors = downward ? node.dependsOn : (downstream.get(id) ?? []);
        return { id, key: barycenter(id, neighbors) };
      });
      // Array.prototype.sort 稳定：键相同保持既有次序（即上一轮结果）。
      keyed.sort((a, b) => a.key - b.key);
      column.length = 0;
      for (const entry of keyed) {
        column.push(entry.id);
        orderIndex.set(entry.id, column.length - 1);
      }
    }
  }

  // ③ 坐标分配：x = 层 × 列距；列内行距等距，各列相对最高列垂直居中（平均边长最短）。
  const columnSpan = columns.map(
    (column) => (column.length > 0 ? (column.length - 1) * rowPitch : 0),
  );
  const maxSpan = Math.max(...columnSpan, 0);
  columns.forEach((column, layerId) => {
    const offset = (maxSpan - (columnSpan[layerId] ?? 0)) / 2;
    column.forEach((id, index) => {
      positions.set(id, { x: layerId * columnPitch, y: offset + index * rowPitch });
    });
  });
  return positions;
}

/** 只给缺 layout 的节点补坐标：已有 layout 节点锚定不动，补算位与其矩形碰撞下移避让。
 * 返回 Map 只含缺失节点（渲染兜底用）。 */
export function fillMissingLayoutPositions<T extends PlanLayoutNode>(
  nodes: readonly T[],
): Map<string, PlanLayoutPosition> {
  const fixed = new Map<string, PlanLayoutPosition>();
  const missing: T[] = [];
  for (const node of nodes) {
    if (node.layout) fixed.set(node.nodeId, { x: node.layout.x, y: node.layout.y });
    else missing.push(node);
  }
  const positions = new Map<string, PlanLayoutPosition>();
  if (missing.length === 0) return positions;
  const computed = computePlanLayout(nodes);
  // 矩形避让：补算位逐个检查与已锚定卡片（近似尺寸 + 安全间距）是否重叠，
  // 重叠则行距下移直到腾空。补算位彼此同列不同槽，互不重叠。
  const occupied = [...fixed.values()];
  for (const node of missing) {
    const spot = { ...(computed.get(node.nodeId) ?? { x: 0, y: 0 }) };
    while (
      occupied.some(
        (other) =>
          Math.abs(spot.x - other.x) < CARD_WIDTH + COLLISION_MARGIN &&
          Math.abs(spot.y - other.y) < CARD_HEIGHT + COLLISION_MARGIN,
      )
    ) {
      spot.y += DEFAULT_ROW_PITCH;
    }
    occupied.push(spot);
    positions.set(node.nodeId, spot);
  }
  return positions;
}

/** 节点表补 layout（服务端 proposePlan 落库用）：缺 layout 的节点补算坐标，
 * 已有的保持原引用原值。全部已有 layout 时返回原数组（引用稳定）。 */
export function applyMissingLayouts<T extends PlanLayoutNode>(nodes: readonly T[]): T[] {
  if (!nodes.some((node) => !node.layout)) return nodes as T[];
  const positions = fillMissingLayoutPositions(nodes);
  return nodes.map((node) =>
    node.layout
      ? node
      : ({ ...node, layout: { ...(positions.get(node.nodeId) ?? { x: 0, y: 0 }) } } as T),
  );
}
