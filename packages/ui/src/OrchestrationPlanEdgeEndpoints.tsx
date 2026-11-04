// 选中连线的端点拖拽（用户需求点 1：拖动箭头改动目标）。xyflow 此版本无内置
// reconnect 组件：选中边后在其两端渲染拖点，按下后跟随指针、松手时按"落点所在
// 节点"解析新端点，交由编辑器按全部校验（防环/防自连/起始不可当 target）重连。
// 必须在 <ReactFlow> 内部使用（依赖 flowToScreenPosition / screenToFlowPosition）。
import { useCallback, useEffect, useState } from "react";
import { useReactFlow } from "@xyflow/react";

export interface EdgeEndpointsEdge {
  edgeId: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

type EndpointNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number | null; height?: number | null } | null;
  data: { isStart?: boolean };
};

const NODE_W = 104;
const NODE_H = 52;

/** 锚点侧从 handle id 前缀解析（right-s / left-t / top-s …）。 */
function anchorFlowPoint(node: EndpointNode, handleId: string | null): { x: number; y: number } {
  const side = (handleId ?? "").split("-")[0] ?? "right";
  const w = node.measured?.width ?? NODE_W;
  const h = node.measured?.height ?? NODE_H;
  const base =
    side === "left"
      ? { x: node.position.x, y: node.position.y + h / 2 }
      : side === "top"
        ? { x: node.position.x + w / 2, y: node.position.y }
        : side === "bottom"
          ? { x: node.position.x + w / 2, y: node.position.y + h }
          : { x: node.position.x + w, y: node.position.y + h / 2 };
  return base;
}

export function OrchestrationPlanEdgeEndpoints({
  edge,
  nodes,
  onReconnect,
}: {
  edge: EdgeEndpointsEdge | null;
  nodes: EndpointNode[];
  onReconnect: (oldSource: string, oldTarget: string, newSource: string, newTarget: string) => void;
}) {
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  const [drag, setDrag] = useState<{ end: "source" | "target"; x: number; y: number } | null>(null);

  const screenDot = useCallback(
    (end: "source" | "target"): { x: number; y: number } | null => {
      if (!edge) return null;
      const nodeId = end === "source" ? edge.source : edge.target;
      const handleId = end === "source" ? edge.sourceHandle : edge.targetHandle;
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return null;
      return flowToScreenPosition(anchorFlowPoint(node, handleId));
    },
    [edge, flowToScreenPosition, nodes],
  );

  const startDrag = (end: "source" | "target") => (event: React.PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setDrag({ end, x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!drag || !edge) return;
    const move = (event: PointerEvent) => {
      setDrag((current) =>
        current ? { ...current, x: event.clientX, y: event.clientY } : current,
      );
    };
    const up = (event: PointerEvent) => {
      setDrag(null);
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const hit = nodes.find((node) => {
        const w = node.measured?.width ?? NODE_W;
        const h = node.measured?.height ?? NODE_H;
        return (
          flowPoint.x >= node.position.x - 12 &&
          flowPoint.x <= node.position.x + w + 12 &&
          flowPoint.y >= node.position.y - 12 &&
          flowPoint.y <= node.position.y + h + 12
        );
      });
      if (!hit) return;
      const source = drag.end === "source" ? hit.id : edge.source;
      const target = drag.end === "target" ? hit.id : edge.target;
      onReconnect(edge.source, edge.target, source, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, edge, nodes, onReconnect, screenToFlowPosition]);

  if (!edge) return null;
  const sourceDot = screenDot("source");
  const targetDot = screenDot("target");
  const fixedDot = drag ? (drag.end === "source" ? targetDot : sourceDot) : null;

  const dot = (end: "source" | "target", position: { x: number; y: number } | null) =>
    position && !(drag?.end === end) ? (
      <div
        title={end === "source" ? "拖动改起点" : "拖动改目标"}
        className="fixed z-50 size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-accent bg-background"
        style={{ left: position.x, top: position.y }}
        onPointerDown={startDrag(end)}
      />
    ) : null;

  return (
    <>
      {/* 预览线：固定端 → 指针当前位置（此前误画到原锚点，等于零长线不可见） */}
      {drag && fixedDot ? (
        <svg className="pointer-events-none fixed inset-0 z-40 h-full w-full">
          <line
            x1={fixedDot.x}
            y1={fixedDot.y}
            x2={drag.x}
            y2={drag.y}
            stroke="#38bdf8"
            strokeWidth={1.5}
          />
        </svg>
      ) : null}
      {dot("source", sourceDot)}
      {dot("target", targetDot)}
    </>
  );
}
