// 编排计划画布的节点组件与图算法（spec: packages/services/specs/orchestration-plan.md）。
// 从 OrchestrationPlanPage 拆出：卡片渲染（状态色边框/进度图标/子任务名 + NodeResizer）、
// ProcessOn 式四向锚点与点阵网格、分层兜底布局、环检测（连线前防环）。ReactFlow 装配在 OrchestrationPlanFlow.tsx。
import { Handle, NodeResizer, Position } from "@xyflow/react";
import { createContext, useContext } from "react";
import type { Node as FlowNode, NodeProps, NodeTypes } from "@xyflow/react";
import type { ZCodeOrchestrationPlanNode } from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { CircleCheck, CircleDashed, CircleX, LoaderIcon, Lock, PlayIcon, TriangleAlert } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import { useImeSafeText } from "@/OrchestrationPlanTextField.js";

/**
 * 节点卡片上的手动操作（用户需求 2026-11-02：执行按钮 + 手动完成滑块，容错/手动推进）。
 * 经 context 下发而非塞进 flow 节点 data：busy/回调变化不必重建所有节点，画布补丁逻辑不受影响。
 */
interface PlanNodeActionsContextValue {
  busy: boolean;
  onExecuteNode?: (nodeId: string) => void;
  onToggleNodeDone?: (nodeId: string, done: boolean) => void;
  /** 节点自动执行滑块（用户需求 2026-11-03，非起始节点）。 */
  onToggleNodeAuto?: (nodeId: string, auto: boolean) => void;
  /** 开始节点总控：一键全开/全关非起始节点的自动执行。 */
  onToggleAllAuto?: (auto: boolean) => void;
  /** 总控勾选态 = 全部非起始节点已开自动（开始卡片滑块显示用）。 */
  allAuto?: boolean;
  /** 已保存节点的 id 集（用户需求 2026-11-03）：执行/手动完成/自动开关都是服务端操作，
   * 未保存的本地新节点一律禁用并提示先保存（此前直接报 Unknown plan node）。 */
  savedNodeIds?: Set<string>;
}
export const PlanNodeActionsContext = createContext<PlanNodeActionsContextValue>({ busy: false });

export interface NodeLayout {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export type EditableNode = ZCodeOrchestrationPlanNode & { layout?: NodeLayout };

/** 无保存宽度时的默认卡片宽：要装下节点名 + 目标 + 子任务区块 + 执行行（用户反馈太挤）。
 * 与 MIN_NODE_WIDTH 分开——手动缩小仍能到 104（"调大后要能调回来"），但默认不再那么窄。 */
export const DEFAULT_NODE_WIDTH = 200;
/** 手动缩小的最小宽度（NodeResizer 下限）。 */
export const MIN_NODE_WIDTH = 104;
/** 非起始节点内容高度下限（用户需求 2026-11-03 反馈"默认都小了"）：名称 + 目标(3 行) +
 * 子任务块 + 常驻 skill 块（配置了才渲染）+ 「完成后自动执行下游」行 + 执行/手动完成行。
 * 存过的小布局高度经 shell minHeight 自动长到装下内容；用户手动调大的高度不受影响。 */
export const DEFAULT_NODE_HEIGHT = 168;
/** 开始节点内容高度下限：名称行 + 全部自动总控行。 */
export const DEFAULT_START_NODE_HEIGHT = 72;

export type CardData = {
  name: string;
  goal: string;
  status: ZCodeOrchestrationPlanNode["status"];
  needsUpstreamResult: boolean;
  /** 依赖（上游节点 id）：连线绘制与保存载荷的来源（flow 节点单一事实）。 */
  dependsOn: string[];
  /** 起始节点：结构标记（不可删除/派发；其余节点必须可达它）。 */
  isStart?: boolean;
  childTitle: string | null;
  /** 已绑定的子任务会话 id：真实子任务标题解析的键（childTitle 展示用）。 */
  childTaskId: string | null;
  /** 用户手动确定的绑定（锁标展示；主任务/agent 不可改绑，用户仍可在编辑器改）。 */
  childLocked: boolean;
  /** 依赖满足后由 host 自动派发（用户需求 2026-11-03）；起始节点不用此字段（走总控）。 */
  autoExecute: boolean;
  /** 派发时写入子会话的常驻 skill（用户需求 2026-11-04）；编辑缓冲随保存落库。 */
  pinnedSkills: string[];
  /** 子任务模型（用户需求 2026-11-05）：null = 跟随主任务；对象 = 指定选型
   * （视觉模型在目录里带 supportsImage 标识）。编辑缓冲随保存落库。 */
  model?: ModelSelection | null;
  /** 思考档位（用户需求 2026-11-05）：null = 跟随主任务；字符串 = 指定档位。 */
  thoughtLevel?: string | null;
  w?: number;
  h?: number;
  /** 双击节点进入内联改名（用户需求 2026-10-29：模块内可编辑文字）。 */
  editingName?: boolean;
  onNameChange?: (name: string) => void;
};

function statusRing(status: ZCodeOrchestrationPlanNode["status"]): string {
  if (status === "terminal") return "border-success";
  // 失败=红色（用户需求 2026-11-04）：与成功=绿色对等，一眼区分。
  if (status === "failed") return "border-terminal-red";
  if (status === "dispatched") return "border-status-running";
  if (status === "stale") return "border-warning";
  // 待执行用实心中性灰：画布上 border-strong 太淡（用户反馈对比度差）。
  return "border-neutral-500";
}

/** 状态底色（用户需求 2026-10-30：节点状态一眼可辨，光靠边框不够）。 */
function statusBackground(status: ZCodeOrchestrationPlanNode["status"]): string {
  if (status === "terminal") return "bg-success/10";
  if (status === "failed") return "bg-terminal-red/10";
  if (status === "dispatched") return "bg-status-running/10";
  if (status === "stale") return "bg-warning/10";
  return "bg-[var(--color-plan-node-bg)]";
}

function statusIcon(status: ZCodeOrchestrationPlanNode["status"]) {
  if (status === "terminal")
    return <CircleCheck aria-hidden="true" className="size-3 shrink-0 text-success" />;
  if (status === "failed")
    return <CircleX aria-hidden="true" className="size-3 shrink-0 text-terminal-red" />;
  if (status === "dispatched")
    return (
      <LoaderIcon aria-hidden="true" className="size-3 shrink-0 animate-spin text-status-running" />
    );
  if (status === "stale")
    return <TriangleAlert aria-hidden="true" className="size-3 shrink-0 text-warning" />;
  return <CircleDashed aria-hidden="true" className="size-3 shrink-0 text-foreground-subtlest" />;
}

/** ProcessOn 式四向锚点（用户需求 2026-10-28：像 ProcessOn 一样连线）。
 * 显形与指针激活由 styles.css 的 .plan-anchor 规则统一管（平时不拦截拖节点）。 */
const PLAN_ANCHOR_CLASS_NAME = cn(
  "plan-anchor !size-2.5 !rounded-full !border-2 !border-accent !bg-background",
);

function PlanNodeCard({ id, data, selected }: NodeProps<FlowNode<CardData>>) {
  const { intl } = useZCodeIntl();
  const actions = useContext(PlanNodeActionsContext);
  // 内联改名 IME 安全（用户需求 2026-11-03：中文合成被父级回写打断）：合成期间本地
  // 镜像、compositionEnd 一次性提交；外部值变化（撤销/补丁）非合成期间同步。
  const { text: inlineName, fieldProps: inlineNameProps } = useImeSafeText<HTMLInputElement>(
    data.name,
    data.onNameChange ?? (() => {}),
  );
  return (
    <div
      className={cn(
        // 卡片填满 xyflow 节点壳：显式尺寸（保存的 layout / NodeResizer / 默认宽）
        // 全部挂在壳 style 上。卡片不能自带 min-w——壳缩到比它小时内容溢出
        //（用户截图：宽度没变、边框进去了）。内容垂直居中（用户需求点 7）。
        // flex-1：填满 flex 壳（含 minHeight 抬高的部分），锚点/边线不会悬在空白上。
        "flex w-full flex-1 flex-col justify-center rounded-lg border-2 px-2.5 py-2 shadow-md",
        statusBackground(data.status),
        selected ? "border-accent shadow-lg" : statusRing(data.status),
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_NODE_WIDTH}
        minHeight={data.isStart ? DEFAULT_START_NODE_HEIGHT : DEFAULT_NODE_HEIGHT}
        lineClassName="!border-accent/60"
        handleClassName="!size-2.5 !rounded-[3px] !border-2 !border-accent !bg-background"
      />
      {/* 四向锚点：同位先 target 后 source（source 在上层，拖拽按发起方处理） */}
      <Handle id="top-t" type="target" position={Position.Top} className={PLAN_ANCHOR_CLASS_NAME} />
      <Handle
        id="left-t"
        type="target"
        position={Position.Left}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <Handle
        id="bottom-t"
        type="target"
        position={Position.Bottom}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <Handle
        id="right-t"
        type="target"
        position={Position.Right}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <Handle id="top-s" type="source" position={Position.Top} className={PLAN_ANCHOR_CLASS_NAME} />
      <Handle
        id="left-s"
        type="source"
        position={Position.Left}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <Handle
        id="bottom-s"
        type="source"
        position={Position.Bottom}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <Handle
        id="right-s"
        type="source"
        position={Position.Right}
        className={PLAN_ANCHOR_CLASS_NAME}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        {data.isStart ? (
          <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-accent/15 px-1 text-ui-xs font-medium text-accent">
            <PlayIcon aria-hidden="true" className="size-2.5" />
            {intl.formatMessage({ id: "orchestration.plan.startBadge" })}
          </span>
        ) : data.status === "dispatched" ? (
          // 执行中不渲染标题行状态圈（用户需求 2026-11-04）：底部操作行已有转圈 +
          // 「执行中」文案，两个圈重复；其余状态的图标保留（各只出现一处）。
          null
        ) : (
          statusIcon(data.status)
        )}
        {data.editingName && data.onNameChange ? (
          <input
            autoFocus
            {...inlineNameProps}
            onClick={(event) => event.stopPropagation()}
            // 全键停止冒泡：IME 的 Enter/Escape 等按键不惊动画布/页面的键盘处理。
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") event.stopPropagation();
              else event.stopPropagation();
            }}
            className="nodrag nopan h-5 min-w-0 flex-1 rounded-sm border border-accent/60 bg-background px-1 text-ui-sm text-foreground"
          />
        ) : (
          <span className="truncate text-ui-sm font-medium text-foreground">{data.name}</span>
        )}
      </div>
      {/* 开始节点总控滑块（用户需求 2026-11-03）：点一下全部非起始节点开自动、再点全关；
       * 勾选态 = 全部已开。分节点手动 + 总控两种形态齐了。 */}
      {data.isStart ? (
        <div
          className="nodrag nopan mt-1.5 flex shrink-0 items-center justify-between rounded-md border border-border-subtle bg-background/85 px-1.5 py-1 text-ui-2xs"
          title={intl.formatMessage({ id: "orchestration.plan.autoAllHint" })}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="text-foreground-subtlest">
            {intl.formatMessage({ id: "orchestration.plan.autoAll" })}
          </span>
          <Switch
            size="sm"
            checked={actions.allAuto ?? false}
            disabled={actions.busy || !actions.onToggleAllAuto}
            onCheckedChange={(checked) => actions.onToggleAllAuto?.(checked)}
          />
        </div>
      ) : null}
      {data.goal ? (
        <p className="mt-1 line-clamp-3 text-ui-xs text-foreground-subtle">{data.goal}</p>
      ) : null}
      {data.dependsOn.length > 0 && data.needsUpstreamResult ? (
        <p className="mt-1 text-ui-xs text-foreground-subtlest">⟶ 需上游结果</p>
      ) : null}
      {/* 子任务独立区块（用户需求 2026-10-30）：不再用一行小字，而是卡片底部一块
       * 带边框的专属区域——近实底 bg-background/85 让文字在任意状态底色（绿/蓝/黄/灰）
       * 上都可读（旧 bg-accent/10 + text-accent 在完成态绿底上几乎不可读，用户实测）。
       * 点击区块 = 点击节点 → 选中后右侧编辑器可改绑（未执行完成时）。 */}
      {!data.isStart ? (
        <div
          className="mt-1.5 shrink-0 rounded-md border border-border-subtle bg-background/85 px-1.5 py-1"
          title={
            data.childTitle ?? intl.formatMessage({ id: "orchestration.plan.childBlockEmptyHint" })
          }
        >
          <div className="flex items-center gap-1 text-ui-2xs uppercase tracking-wide text-foreground-subtlest">
            <span aria-hidden="true">⧉</span>
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "orchestration.plan.childBlockLabel" })}
            </span>
            {data.childLocked ? (
              <Lock aria-hidden="true" className="size-2.5 shrink-0 text-foreground-subtle" />
            ) : null}
          </div>
          <div
            className={cn(
              "truncate text-ui-xs font-medium",
              data.childTitle ? "text-foreground" : "text-foreground-subtlest",
            )}
          >
            {data.childTitle ?? intl.formatMessage({ id: "orchestration.plan.childBlockEmpty" })}
          </div>
        </div>
      ) : null}
      {/* 常驻 skill 区块（用户需求 2026-11-04）：与子任务区块同风格；派发时 host 会把
       * 名单写入子会话常驻。仅在配置了 skill 时渲染——空块会让每张卡片凭空高一行。 */}
      {!data.isStart && (data.pinnedSkills?.length ?? 0) > 0 ? (
        <div
          className="mt-1.5 shrink-0 rounded-md border border-border-subtle bg-background/85 px-1.5 py-1"
          title={data.pinnedSkills.join("、")}
        >
          <div className="flex items-center gap-1 text-ui-2xs uppercase tracking-wide text-foreground-subtlest">
            <span aria-hidden="true">⚡</span>
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "orchestration.plan.pinnedSkillField" })}
            </span>
          </div>
          <div className="truncate text-ui-xs font-medium text-foreground">
            {data.pinnedSkills.join("、")}
          </div>
        </div>
      ) : null}
      {/* 子任务模型区块（用户需求 2026-11-05）：仅在显式指定时渲染——null（跟随主任务）
       * 是缺省态，块会凭空高一行。null 不显示即"跟随主任务"的视觉表达。 */}
      {!data.isStart && data.model ? (
        <div
          className="mt-1.5 shrink-0 rounded-md border border-border-subtle bg-background/85 px-1.5 py-1"
          title={intl.formatMessage({ id: "orchestration.plan.childModelHint" })}
        >
          <div className="flex items-center gap-1 text-ui-2xs uppercase tracking-wide text-foreground-subtlest">
            <span aria-hidden="true">🤖</span>
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "orchestration.plan.childModelField" })}
            </span>
          </div>
          <div className="truncate text-ui-xs font-medium text-foreground">
            {data.model.modelId}
          </div>
        </div>
      ) : null}
      {/* 自动执行开关独立一行（用户需求 2026-11-03 改版：「完成后自动执行下游」全称标签
       * 与执行/手动完成并排放不下）。它是画布可编辑配置（进编辑缓冲随保存落库），
       * 未保存的新节点也能拨——这正是"新增时就把配置确定好"的诉求。
       * nodrag/nopan + stopPropagation：点击别变成拖/选节点。 */}
      {!data.isStart ? (
        <div
          className="nodrag nopan mt-1.5 flex flex-nowrap shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border-subtle bg-background/85 px-1.5 py-1 text-ui-2xs"
          title={intl.formatMessage({ id: "orchestration.plan.nodeAutoHint" })}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="min-w-0 truncate text-foreground-subtlest">
            {intl.formatMessage({ id: "orchestration.plan.nodeAuto" })}
          </span>
          <Switch
            size="sm"
            checked={data.autoExecute}
            disabled={actions.busy || !actions.onToggleNodeAuto}
            onCheckedChange={(checked) => actions.onToggleNodeAuto?.(id, checked)}
          />
        </div>
      ) : null}
      {/* 手动操作行（用户需求 2026-11-02）：执行中显示运行态（蓝色，与 agent 派发同色，
       * 不区分谁触发）；否则给"执行"按钮；右侧"手动完成"滑块用于回报丢失/线下完成等容错。
       * nodrag/nopan + stopPropagation：别让按钮点击变成拖节点/选节点。 */}
      {!data.isStart ? (
        <div className="nodrag nopan mt-1.5 flex flex-nowrap shrink-0 items-center justify-between gap-2 whitespace-nowrap text-ui-2xs">
          {data.status === "dispatched" ? (
            <span className="flex items-center gap-1 text-status-running">
              <LoaderIcon aria-hidden="true" className="size-3 animate-spin" />
              {intl.formatMessage({ id: "orchestration.plan.nodeExecuting" })}
            </span>
          ) : (
            <button
              type="button"
              disabled={
                actions.busy ||
                !actions.onExecuteNode ||
                (actions.savedNodeIds !== undefined && !actions.savedNodeIds.has(id)) ||
                data.goal.trim() === ""
              }
              title={
                intl.formatMessage({
                  id:
                    actions.savedNodeIds && !actions.savedNodeIds.has(id)
                      ? "orchestration.plan.nodeUnsavedHint"
                      : data.goal.trim() === ""
                        ? "orchestration.plan.nodeEmptyGoalHint"
                        : "orchestration.plan.nodeExecuteHint",
                })
              }
              onClick={(event) => {
                event.stopPropagation();
                actions.onExecuteNode?.(id);
              }}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border-subtle bg-background/85 px-1.5 py-0.5 text-foreground-subtle hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlayIcon aria-hidden="true" className="size-2.5" />
              {intl.formatMessage({ id: "orchestration.plan.nodeExecute" })}
            </button>
          )}
          <label
            className="flex shrink-0 items-center gap-1 whitespace-nowrap text-foreground-subtlest"
            title={
              actions.savedNodeIds && !actions.savedNodeIds.has(id)
                ? intl.formatMessage({ id: "orchestration.plan.nodeUnsavedHint" })
                : intl.formatMessage({ id: "orchestration.plan.nodeManualDoneHint" })
            }
            onClick={(event) => event.stopPropagation()}
          >
            <span>{intl.formatMessage({ id: "orchestration.plan.nodeManualDone" })}</span>
            <Switch
              size="sm"
              checked={data.status === "terminal"}
              disabled={
                actions.busy ||
                !actions.onToggleNodeDone ||
                (actions.savedNodeIds !== undefined && !actions.savedNodeIds.has(id))
              }
              onCheckedChange={(checked) => actions.onToggleNodeDone?.(id, checked)}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

export const planNodeTypes: NodeTypes = { planNode: PlanNodeCard };

// 自动布局（兜底/整理/落库）统一收敛到 @zcode/shared/orchestration-plan-layout：
// 旧 autoPosition（最长路径定层 + 定义顺序堆叠）层内不看连线关系，边必然交叉，已删除。

/** target→…→source 可达即成环（新增 source→target 依赖前检查）。 */
export function wouldCycle(from: string, to: string, nodes: EditableNode[]): boolean {
  if (from === to) return true;
  const node = nodes.find((candidate) => candidate.nodeId === from);
  if (!node) return false;
  return node.dependsOn.some((dep) => wouldCycle(dep, to, nodes));
}

/** 按两节点相对位置挑连线锚点（横向差占优走左右、纵向差占优走上下）：
 * 边在每次渲染时重算挂点，拖动节点后连线自动换侧（ProcessOn 的自动绕行观感）。 */
export function pickEdgeAnchorPair(
  source: { position: { x: number; y: number } },
  target: { position: { x: number; y: number } },
): { sourceHandle: string; targetHandle: string } {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "right-s", targetHandle: "left-t" }
      : { sourceHandle: "left-s", targetHandle: "right-t" };
  }
  return dy >= 0
    ? { sourceHandle: "bottom-s", targetHandle: "top-t" }
    : { sourceHandle: "top-s", targetHandle: "bottom-t" };
}
