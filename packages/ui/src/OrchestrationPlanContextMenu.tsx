// 编排计划画布右键菜单（spec: orchestration-plan.md）：
// 节点 → 重命名（画布内联）/ 删除（二次确认；起始节点禁用）；连线 → 删除连线。
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface OrchestrationPlanContextMenuState {
  x: number;
  y: number;
  kind: "node" | "edge";
  nodeId?: string;
  edge?: { source: string; target: string };
}

export interface OrchestrationPlanContextMenuProps {
  menu: OrchestrationPlanContextMenuState;
  /** 节点名（删除确认标题用）。 */
  nodeName: string | null;
  /** 起始节点：删除项禁用。 */
  isStartNode: boolean;
  busy: boolean;
  onClose: () => void;
  onRenameNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteEdge: (edge: { source: string; target: string }) => void;
}

export function OrchestrationPlanContextMenu({
  menu,
  nodeName,
  isStartNode,
  busy,
  onClose,
  onRenameNode,
  onDeleteNode,
  onDeleteEdge,
}: OrchestrationPlanContextMenuProps) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div
        className="fixed z-50 min-w-32 rounded-md border border-border-subtle bg-menu p-1 shadow-lg"
        style={{ left: menu.x, top: menu.y }}
      >
        {menu.kind === "node" ? (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-ui-sm text-foreground hover:bg-surface-hover"
              onClick={() => {
                onRenameNode(menu.nodeId!);
                onClose();
              }}
            >
              <PencilIcon aria-hidden="true" className="size-3.5" />
              {intl.formatMessage({ id: "orchestration.plan.rename" })}
            </button>
            <button
              type="button"
              disabled={busy || isStartNode}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-ui-sm text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-foreground-subtlest"
              onClick={() => {
                onClose();
                onDeleteNode(menu.nodeId!);
              }}
            >
              <Trash2Icon aria-hidden="true" className="size-3.5" />
              {intl.formatMessage({ id: "orchestration.plan.deleteNode" })}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-ui-sm text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-foreground-subtlest"
            onClick={() => {
              onClose();
              if (menu.edge) onDeleteEdge(menu.edge);
            }}
          >
            <Trash2Icon aria-hidden="true" className="size-3.5" />
            {intl.formatMessage({ id: "orchestration.plan.deleteEdge" })}
          </button>
        )}
      </div>
    </>
  );
}
