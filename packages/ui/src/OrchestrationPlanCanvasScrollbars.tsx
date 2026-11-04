// 编排计划画布滚动条（用户反馈：没有滚动条）。xyflow 是 transform 视口，没有原生
// 滚动条；这里把「内容包围盒 ∪ 当前可视世界矩形」当虚拟文档，渲染底部/右下两条
// 可拖拽滚动条（拖滑块平移视口，点轨道跳转）。必须在 <ReactFlow> 内部使用
//（依赖 flow context 的 useStore/useReactFlow）。
import { useCallback, useRef } from "react";
import { useReactFlow, useStore } from "@xyflow/react";

/** 内容外留白（世界坐标），避免贴边节点顶死滑块。 */
const CONTENT_PAD = 120;
/** 滚动条命中区厚度（透明，方便抓）。 */
const HIT = 14;
/** 滑块最小长度（px）。 */
const THUMB_MIN = 28;

type ScrollbarNode = {
  position: { x: number; y: number };
  measured?: { width?: number | null; height?: number | null } | null;
  data: { w?: number; h?: number };
};

export function OrchestrationPlanCanvasScrollbars({ nodes }: { nodes: ScrollbarNode[] }) {
  const transform = useStore((state) => state.transform);
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const setViewport = useReactFlow().setViewport;
  const [vx, vy, zoom] = transform;
  const dragRef = useRef<{ axis: "x" | "y"; startPointer: number; startVis: number } | null>(null);

  // 可视世界矩形
  const visX = -vx / zoom;
  const visY = -vy / zoom;
  const visW = canvasWidth / zoom;
  const visH = canvasHeight / zoom;
  // 虚拟文档 = 内容包围盒（外扩留白）∪ 可视矩形
  let minX = visX;
  let minY = visY;
  let maxX = visX + visW;
  let maxY = visY + visH;
  for (const node of nodes) {
    const w = node.measured?.width ?? node.data.w ?? 208;
    const h = node.measured?.height ?? node.data.h ?? 64;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }
  const docX = minX - CONTENT_PAD;
  const docY = minY - CONTENT_PAD;
  const docW = Math.max(visW, maxX - minX) + CONTENT_PAD * 2;
  const docH = Math.max(visH, maxY - minY) + CONTENT_PAD * 2;

  // 竖条占右侧 HIT，横条长度避开竖条（角落留白）
  const trackW = canvasWidth - HIT - 4;
  const trackH = canvasHeight - HIT - 4;
  const thumbW = Math.max(THUMB_MIN, (visW / docW) * trackW);
  const thumbH = Math.max(THUMB_MIN, (visH / docH) * trackH);
  const thumbX = ((visX - docX) / Math.max(1, docW - visW)) * (trackW - thumbW);
  const thumbY = ((visY - docY) / Math.max(1, docH - visH)) * (trackH - thumbH);

  const startDrag = useCallback((axis: "x" | "y", pointer: number, vis: number) => {
    dragRef.current = { axis, startPointer: pointer, startVis: vis };
  }, []);

  const onThumbPointerDown = useCallback(
    (axis: "x" | "y") => (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      startDrag(axis, axis === "x" ? event.clientX : event.clientY, axis === "x" ? visX : visY);
    },
    [startDrag, visX, visY],
  );

  const onThumbPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.stopPropagation();
      const current = drag.axis === "x" ? event.clientX : event.clientY;
      const delta = current - drag.startPointer;
      if (drag.axis === "x") {
        const worldPerPx = (docW - visW) / Math.max(1, trackW - thumbW);
        setViewport({ x: -(drag.startVis + delta * worldPerPx) * zoom, y: vy, zoom });
      } else {
        const worldPerPx = (docH - visH) / Math.max(1, trackH - thumbH);
        setViewport({ x: vx, y: -(drag.startVis + delta * worldPerPx) * zoom, zoom });
      }
    },
    [docH, docW, setViewport, thumbH, thumbW, trackH, trackW, visH, visW, vx, vy, zoom],
  );

  const onThumbPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /** 点轨道 = 视口中心跳到点击处。 */
  const onTrackPointerDown = useCallback(
    (axis: "x" | "y") => (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const frac =
        axis === "x"
          ? (event.clientX - rect.left) / Math.max(1, rect.width)
          : (event.clientY - rect.top) / Math.max(1, rect.height);
      if (axis === "x") {
        setViewport({ x: -(docX + frac * docW - visW / 2) * zoom, y: vy, zoom });
      } else {
        setViewport({ x: vx, y: -(docY + frac * docH - visH / 2) * zoom, zoom });
      }
    },
    [docH, docW, docX, docY, setViewport, visH, visW, vx, vy, zoom],
  );

  return (
    <>
      <div
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-20"
        style={{ width: trackW + 2 * 4, height: HIT }}
        onPointerDown={onTrackPointerDown("x")}
      >
        <div className="absolute inset-x-1 bottom-1 h-1.5 rounded-full bg-white/10" />
        <div
          role="scrollbar"
          aria-orientation="horizontal"
          className="absolute bottom-0.5 h-2 cursor-default rounded-full bg-neutral-500/80 transition-colors hover:bg-neutral-400"
          style={{ left: thumbX + 4, width: thumbW }}
          onPointerDown={(event) => {
            onThumbPointerDown("x")(event);
          }}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
        />
      </div>
      <div
        aria-hidden="true"
        className="absolute right-0 top-0 z-20"
        style={{ width: HIT, height: trackH + 2 * 4 }}
        onPointerDown={onTrackPointerDown("y")}
      >
        <div className="absolute inset-y-1 right-1 w-1.5 rounded-full bg-white/10" />
        <div
          role="scrollbar"
          aria-orientation="vertical"
          className="absolute right-0.5 w-2 cursor-default rounded-full bg-neutral-500/80 transition-colors hover:bg-neutral-400"
          style={{ top: thumbY + 4, height: thumbH }}
          onPointerDown={(event) => {
            onThumbPointerDown("y")(event);
          }}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
        />
      </div>
    </>
  );
}
