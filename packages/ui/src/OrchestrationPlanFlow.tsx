// 画布 Flow 封装（spec: packages/services/specs/orchestration-plan.md）。
// 从 OrchestrationPlanCanvasNodes 拆出（行数控制）：卡片/锚点/图算法留在原模块，
// 这里只做 ReactFlow 装配与卡片操作 context 下发；交互回调全部由页面注入。
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Edge, Node as FlowNode, NodeChange } from "@xyflow/react";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { OrchestrationPlanCanvasScrollbars } from "@/OrchestrationPlanCanvasScrollbars.js";
import {
  PlanNodeActionsContext,
  planNodeTypes,
  type CardData,
} from "@/OrchestrationPlanCanvasNodes.js";

/** children 渲染在 <ReactFlow> 内部（flow context 可用，如端点拖拽组件）。 */
export function OrchestrationPlanFlow({
  nodes,
  edges,
  editable,
  busy = false,
  onExecuteNode,
  onToggleNodeDone,
  onToggleNodeAuto,
  onToggleAllAuto,
  allAuto = false,
  savedNodeIds,
  onNodeClick,
  onNodeDoubleClick,
  onNodeContextMenu,
  onPaneClick,
  onEdgeClick,
  onEdgeContextMenu,
  onConnect,
  onNodesChange,
  onInit,
  children,
}: {
  nodes: Array<FlowNode<CardData>>;
  edges: Array<Edge>;
  editable: boolean;
  /** 手动操作进行中：卡片上的执行按钮/滑块禁用。 */
  busy?: boolean;
  /** 卡片"执行"按钮（非起始节点）；缺省 = 不显示为可用。 */
  onExecuteNode?: (nodeId: string) => void;
  /** 卡片"手动完成"滑块（非起始节点）。 */
  onToggleNodeDone?: (nodeId: string, done: boolean) => void;
  /** 卡片"自动"滑块（非起始节点，用户需求 2026-11-03）。 */
  onToggleNodeAuto?: (nodeId: string, auto: boolean) => void;
  /** 开始节点总控滑块：一键全开/全关自动执行。 */
  onToggleAllAuto?: (auto: boolean) => void;
  /** 总控勾选态 = 全部非起始节点已开自动。 */
  allAuto?: boolean;
  /** 已保存节点 id 集：执行/手动完成/自动开关对未保存本地节点禁用（提示先保存）。 */
  savedNodeIds?: Set<string>;
  onNodeClick: (nodeId: string) => void;
  onNodeDoubleClick: (nodeId: string) => void;
  onNodeContextMenu: (nodeId: string, position: { x: number; y: number }) => void;
  onPaneClick: () => void;
  onEdgeClick: (edgeId: string) => void;
  onEdgeContextMenu: (
    edge: { source: string; target: string },
    position: { x: number; y: number },
  ) => void;
  onConnect: (connection: { source: string | null; target: string | null }) => void;
  onNodesChange: (changes: NodeChange<FlowNode<CardData>>[]) => void;
  onInit: (instance: {
    fitView: (options?: { padding?: number; duration?: number }) => void;
    screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  }) => void;
  children?: ReactNode;
}) {
  const actions = useMemo(
    () => ({
      allAuto,
      busy,
      onExecuteNode,
      onToggleAllAuto,
      onToggleNodeAuto,
      onToggleNodeDone,
      savedNodeIds,
    }),
    [allAuto, busy, onExecuteNode, onToggleAllAuto, onToggleNodeAuto, onToggleNodeDone, savedNodeIds],
  );
  return (
    <PlanNodeActionsContext.Provider value={actions}>
      <div className="h-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={planNodeTypes}
          onNodeClick={(_, node) => onNodeClick(node.id)}
          onNodeDoubleClick={(_, node) => onNodeDoubleClick(node.id)}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            onNodeContextMenu(node.id, { x: event.clientX, y: event.clientY });
          }}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          onNodesChange={editable ? onNodesChange : undefined}
          onEdgeClick={(_, edge) => onEdgeClick(edge.id)}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            onEdgeContextMenu(
              { source: edge.source, target: edge.target },
              {
                x: event.clientX,
                y: event.clientY,
              },
            );
          }}
          onInit={onInit}
          nodesDraggable={editable}
          nodesConnectable={editable}
          // 连线可选中（点击高亮，配合右键删除/端点拖动改目标）。
          // 双向锚点（同位出/入成对）必须用 Loose：Strict 下落点 elementFromPoint 命中
          // 顶层的 source 锚点会判 source→source 无效，连线静默失败（实测踩坑）。
          connectionMode={ConnectionMode.Loose}
          // 连线预览走贝塞尔曲线、锚点 24px 内吸附落点（ProcessOn 的“就近挂上”手感）。
          // 预览色用固定亮蓝：暗色主题的 --color-accent 是深 sky-950，几乎看不见
          //（用户反馈"画线没连上时颜色太暗"）。
          connectionLineType={ConnectionLineType.Bezier}
          connectionLineStyle={{ stroke: "#38bdf8", strokeWidth: 1.5 }}
          connectionRadius={24}
          // 双击空白添加节点已移除（用户需求 2026-11-04：易误触，添加走工具栏按钮）；
          // 保留关闭双击缩放，避免双击改名/选节点时意外触发画面缩放。
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
        >
          {/* ProcessOn 式画布：点阵网格 + 左下角缩放控件 + 横竖滚动条（右/下） */}
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
          <Controls position="bottom-left" showInteractive={false} />
          <OrchestrationPlanCanvasScrollbars nodes={nodes} />
          {children}
        </ReactFlow>
      </div>
    </PlanNodeActionsContext.Provider>
  );
}
