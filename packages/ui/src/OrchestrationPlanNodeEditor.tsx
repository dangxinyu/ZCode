// 编排计划画布的节点编辑侧栏（spec: packages/services/specs/orchestration-plan.md）。
// 用户需求 2026-10-29：只保留「目标」（占满侧栏）与「派发时附上游交付摘要」选项；
// 名称走画布双击/右键重命名，删除走节点右键菜单，都不在侧栏出现。
// 起始节点仅显示说明（无目标可编辑）。
// 用户需求 2026-10-30：新增「关联子任务」——未执行完成的节点可手动改绑/解绑编排子任务；
// 绑定即"确定"（childTaskLocked），此后主任务/agent 不可再改绑，只有用户能改。
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useImeSafeText } from "@/OrchestrationPlanTextField.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { Lock } from "lucide-react";

export interface PlanNodeEditorProps {
  editNode: {
    nodeId: string;
    name: string;
    goal: string;
    needsUpstreamResult: boolean;
    dependsOn: string[];
    childTaskId: string | null;
    /** 已绑定子任务的显示标题（候选列表没加载/不含它时下拉仍能显示当前项）。 */
    childTitle?: string | null;
    /** 用户手动确定的绑定：主任务/agent 不可改绑（用户仍可在本编辑器修改）。 */
    childTaskLocked: boolean;
    status: "pending" | "dispatched" | "terminal" | "stale" | "failed";
    /** 起始节点：仅作开始标记，无目标可编辑。 */
    isStart?: boolean;
    /** 子任务模型（用户需求 2026-11-05）：null = 跟随主任务；对象 = 指定选型。 */
    model?: ModelSelection | null;
  };
  busy: boolean;
  /** 可选关联的编排子任务（links 权威列表，标题经 sessions-index 解析）。 */
  childCandidates: Array<{ taskId: string; title: string }>;
  /** 手动改绑/解绑（null = 解除关联）；写库后页面重拉 plansMap。 */
  onBindChild: (childTaskId: string | null) => void;
  /** 派发时写入子会话的常驻 skill（用户需求 2026-11-04）：当前选中（0/1 个）。 */
  pinnedSkill: string | null;
  /** 常驻 skill 候选（catalog name；页面经 useSkills 解析）。 */
  skillCandidates: Array<{ name: string; description: string }>;
  /** 选/清常驻 skill（null = 清除，节点不带 skill 派发）。 */
  onPickPinnedSkill: (name: string | null) => void;
  /** 子任务模型（用户需求 2026-11-05）：null = 跟随主任务；对象 = 指定选型。 */
  childModel: ModelSelection | null;
  /** 计划级子任务默认模型：未显式指定的节点显示它的生效值（工具栏改这里，节点跟着动）。 */
  planChildModelDefault: ModelSelection | null;
  /** 主任务当前选型（getTaskModelSelection）：跟随主任务链路的生效模型与档位候选来源。 */
  orchestratorModel: ModelSelection | null;
  /** 模型候选（useModelSelectionView 目录；supportsImage 的带视觉标识）。 */
  modelCandidates: Array<{
    providerId: string;
    modelId: string;
    supportsImage: boolean;
    reasoningLevels: readonly string[];
  }>;
  /** 选子任务模型（null = 跟随主任务）。 */
  onPickChildModel: (model: ModelSelection | null) => void;
  /** 思考档位（用户需求 2026-11-05）：null = 跟随主任务；字符串 = 指定档位。 */
  thoughtLevel: string | null;
  /** 选思考档位（null = 跟随主任务）。 */
  onPickThoughtLevel: (level: string | null) => void;
  /** 子任务权限模式（用户需求 2026-11-05）：null = 跟随主任务；build/edit/yolo = 指定。 */
  childMode: "build" | "edit" | "yolo" | null;
  /** 选权限模式（null = 跟随主任务）。 */
  onPickChildMode: (mode: "build" | "edit" | "yolo" | null) => void;
  /** 字段编辑统一入口（flow 节点 data 直写）。 */
  onPatch: (partial: { name?: string; goal?: string; needsUpstreamResult?: boolean }) => void;
}

export function PlanNodeEditor({
  editNode,
  busy,
  childCandidates,
  onBindChild,
  pinnedSkill,
  skillCandidates,
  onPickPinnedSkill,
  childModel,
  planChildModelDefault,
  orchestratorModel,
  modelCandidates,
  onPickChildModel,
  thoughtLevel,
  onPickThoughtLevel,
  childMode,
  onPickChildMode,
  onPatch,
}: PlanNodeEditorProps) {
  const { intl } = useZCodeIntl();
  // 上游只有起始节点时不可能有上游交付（用户需求 2026-10-30）：勾选禁用并视为 false，
  // host 保存通道同样归一（revisePlanNodes）。
  const hasNonStartUpstream = editNode.dependsOn.some((dep) => dep !== "start");
  const childFinished = editNode.status === "terminal";
  // 生效模型（用户需求 2026-11-05"修改上边下边要跟着动"）：节点未显式指定（null）时
  // 实际生效的是计划默认 → 主任务链，展示直接读解析结果而不是裸的显式配置——工具栏
  // 改计划默认，未指定节点的下拉显示立即跟随。
  const effectiveChildModel = childModel ?? planChildModelDefault ?? orchestratorModel;
  // 未指定项文案：计划默认设了显示它（带标），否则显示主任务当前模型（跟随语义）。
  const followOptionLabel = planChildModelDefault
    ? `${planChildModelDefault.modelId}（${intl.formatMessage({ id: "orchestration.plan.childModelPlanDefaultBadge" })}）`
    : orchestratorModel
      ? `${orchestratorModel.modelId}（${intl.formatMessage({ id: "orchestration.plan.childModelFollow" })}）`
      : intl.formatMessage({ id: "orchestration.plan.childModelFollow" });
  // 目标编辑 IME 安全（用户需求 2026-11-03）：合成期间本地镜像、compositionEnd 提交。
  // 必须在 isStart 提前 return 之前调用——hooks 顺序不能随分支变化（React 强制）。
  const { fieldProps: goalField } = useImeSafeText<HTMLTextAreaElement>(
    editNode.goal,
    (next) => onPatch({ goal: next }),
  );
  if (editNode.isStart) {
    return (
      <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border-subtle p-3">
        <div className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "orchestration.plan.editNodeTitle" })}
        </div>
        <p className="rounded-md bg-surface px-2 py-1.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "orchestration.plan.startNodeHint" })}
        </p>
      </aside>
    );
  }
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-hidden border-l border-border-subtle p-3">
      <div className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "orchestration.plan.editNodeTitle" })}
        <span className="ml-1 text-ui-xs font-normal text-foreground-subtlest">
          {editNode.name}
        </span>
      </div>
      <label className="flex min-h-0 flex-1 flex-col gap-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "orchestration.plan.fieldGoal" })}
        {/* IME 安全（用户需求 2026-11-03）：合成期间本地镜像、compositionEnd 提交。 */}
        <textarea
          {...goalField}
          disabled={busy}
          className="min-h-0 flex-1 resize-none rounded-md border border-border-subtle bg-background px-2 py-1.5 text-ui-sm text-foreground"
        />
      </label>
      {editNode.dependsOn.length > 0 ? (
        <label className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
          <input
            type="checkbox"
            checked={hasNonStartUpstream && editNode.needsUpstreamResult}
            disabled={busy || !hasNonStartUpstream}
            onChange={(event) => onPatch({ needsUpstreamResult: event.target.checked })}
          />
          {intl.formatMessage({ id: "orchestration.plan.fieldNeedsResult" })}
        </label>
      ) : null}
      {editNode.dependsOn.length > 0 && !hasNonStartUpstream ? (
        <p className="shrink-0 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "orchestration.plan.upstreamStartOnlyHint" })}
        </p>
      ) : null}
      {/* 关联子任务（用户需求 2026-10-30）：绑定即确定并锁定，主任务/agent 不可改绑；
       * 已执行完成（terminal）的节点不可再改。解绑清除锁定，主任务可重新发起关联。 */}
      <div className="flex shrink-0 flex-col gap-1 text-ui-xs text-foreground-subtle">
        <div className="flex items-center gap-1">
          {intl.formatMessage({ id: "orchestration.plan.childFieldLabel" })}
          {editNode.childTaskLocked ? (
            <span
              className="flex items-center gap-0.5 text-foreground-subtlest"
              title={intl.formatMessage({ id: "orchestration.plan.childLockedHint" })}
            >
              <Lock aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "orchestration.plan.childLockedBadge" })}
            </span>
          ) : null}
        </div>
        <select
          value={editNode.childTaskId ?? ""}
          disabled={busy || childFinished || editNode.status === "dispatched"}
          title={
            // 执行事实节点（执行中/已完成）绑定不可修改：修订通道会保留服务端绑定，
            // 本地改了也会被忽略（与其给一个静默失效的选项，不如明示）。
            editNode.status === "dispatched" || childFinished
              ? intl.formatMessage({ id: "orchestration.plan.childFrozenHint" })
              : undefined
          }
          onChange={(event) => onBindChild(event.target.value || null)}
          className="h-7 rounded-md border border-border-subtle bg-background px-1.5 text-ui-xs text-foreground"
        >
          <option value="">{intl.formatMessage({ id: "orchestration.plan.childUnbound" })}</option>
          {/* 当前已绑定的子任务必须是一个选项：此前把它从候选里过滤掉，<select> 的 value
              找不到匹配项，浏览器回落显示首项"未关联"（用户实测：明明已绑定却显示未关联）。
              候选列表没加载/不含它时用卡片上的标题兜底。 */}
          {editNode.childTaskId ? (
            <option value={editNode.childTaskId}>
              {childCandidates.find((candidate) => candidate.taskId === editNode.childTaskId)
                ?.title ??
                editNode.childTitle ??
                editNode.childTaskId}
            </option>
          ) : null}
          {childCandidates
            .filter((candidate) => candidate.taskId !== editNode.childTaskId)
            .map((candidate) => (
              <option key={candidate.taskId} value={candidate.taskId}>
                {candidate.title}
              </option>
            ))}
        </select>
        {childFinished ? (
          <p className="text-foreground-subtlest">
            {intl.formatMessage({ id: "orchestration.plan.childFinishedHint" })}
          </p>
        ) : editNode.childTaskLocked ? (
          <p className="text-foreground-subtlest">
            {intl.formatMessage({ id: "orchestration.plan.childLockedHint" })}
          </p>
        ) : null}
      </div>
      {/* 常驻 skill（用户需求 2026-11-04）：派发时自动写入子会话；未选=不动子会话现有配置。 */}
      <div className="flex shrink-0 flex-col gap-1 text-ui-xs text-foreground-subtle">
        <div className="flex items-center gap-1">
          {intl.formatMessage({ id: "orchestration.plan.pinnedSkillField" })}
        </div>
        <select
          value={pinnedSkill ?? ""}
          disabled={busy}
          onChange={(event) => onPickPinnedSkill(event.target.value || null)}
          title={
            (pinnedSkill ? skillCandidates.find((c) => c.name === pinnedSkill)?.description : null) ??
            intl.formatMessage({ id: "orchestration.plan.pinnedSkillHint" })
          }
          className="h-7 rounded-md border border-border-subtle bg-background px-1.5 text-ui-xs text-foreground"
        >
          <option value="">
            {intl.formatMessage({ id: "orchestration.plan.pinnedSkillNone" })}
          </option>
          {pinnedSkill && !skillCandidates.some((c) => c.name === pinnedSkill) ? (
            <option value={pinnedSkill}>{pinnedSkill}</option>
          ) : null}
          {skillCandidates.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {/* 子任务模型（用户需求 2026-11-05）：null = 跟随主任务（缺省）；指定后派发的
       * 子会话按该选型执行（视觉模型 supportsImage 在目录里带标识，截图类任务用）。 */}
      <div className="flex shrink-0 flex-col gap-1 text-ui-xs text-foreground-subtle">
        <div className="flex items-center gap-1">
          {intl.formatMessage({ id: "orchestration.plan.childModelField" })}
        </div>
        <select
          value={
            effectiveChildModel
              ? `${effectiveChildModel.providerId}::${effectiveChildModel.modelId}`
              : ""
          }
          disabled={busy}
          title={intl.formatMessage({ id: "orchestration.plan.childModelHint" })}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              onPickChildModel(null);
              return;
            }
            const separator = value.indexOf("::");
            onPickChildModel({
              providerId: value.slice(0, separator),
              modelId: value.slice(separator + 2),
            });
            // 换模型后旧档位可能不在新模型的目录档位里 → 回落跟随主任务（派发解析
            // 会按新模型目录兜底首档）。
            const nextLevels = modelCandidates.find(
              (candidate) =>
                candidate.providerId === value.slice(0, separator) &&
                candidate.modelId === value.slice(separator + 2),
            )?.reasoningLevels;
            if (thoughtLevel && nextLevels && !nextLevels.includes(thoughtLevel)) {
              onPickThoughtLevel(null);
            }
          }}
          className="h-7 rounded-md border border-border-subtle bg-background px-1.5 text-ui-xs text-foreground"
        >
          {/* 未指定项的文案 = 当前生效来源：计划默认（带标）或主任务当前模型（跟随语义）。
              选它 = 清除显式指定（回到解析链）。 */}
          <option value="">{followOptionLabel}</option>
          {/* 当前生效模型必须是选项：目录没加载/不含它时下拉才不会回落成跟随主任务。 */}
          {effectiveChildModel && !modelCandidates.some(
            (candidate) =>
              candidate.providerId === effectiveChildModel.providerId &&
              candidate.modelId === effectiveChildModel.modelId,
          ) ? (
            <option value={`${effectiveChildModel.providerId}::${effectiveChildModel.modelId}`}>
              {effectiveChildModel.modelId}
            </option>
          ) : null}
          {modelCandidates.map((candidate) => (
            <option
              key={`${candidate.providerId}::${candidate.modelId}`}
              value={`${candidate.providerId}::${candidate.modelId}`}
            >
              {candidate.supportsImage
                ? `${candidate.modelId}（${intl.formatMessage({ id: "orchestration.plan.childModelVisionBadge" })}）`
                : candidate.modelId}
            </option>
          ))}
        </select>
        <p className="text-foreground-subtlest">
          {intl.formatMessage({ id: "orchestration.plan.childModelHint" })}
        </p>
      </div>
      {/* 思考档位（用户需求 2026-11-05）：null = 跟随主任务；候选 = 当前生效模型的
       * 目录档位（values 按语义强度低→高）。声明档位的模型缺档位会被 registry 拒。 */}
      <div className="flex shrink-0 flex-col gap-1 text-ui-xs text-foreground-subtle">
        <div className="flex items-center gap-1">
          {intl.formatMessage({ id: "orchestration.plan.thoughtLevelField" })}
        </div>
        <select
          value={thoughtLevel ?? ""}
          disabled={busy}
          onChange={(event) => onPickThoughtLevel(event.target.value || null)}
          className="h-7 rounded-md border border-border-subtle bg-background px-1.5 text-ui-xs text-foreground"
        >
          <option value="">{intl.formatMessage({ id: "orchestration.plan.childModelFollow" })}</option>
          {(modelCandidates.find(
            (candidate) =>
              candidate.providerId === (effectiveChildModel?.providerId ?? "") &&
              candidate.modelId === (effectiveChildModel?.modelId ?? ""),
          )?.reasoningLevels ?? []).map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <p className="text-foreground-subtlest">
          {intl.formatMessage({ id: "orchestration.plan.thoughtLevelHint" })}
        </p>
      </div>
      {/* 子任务权限模式（用户需求 2026-11-05"三种模式加第四种默认跟随主任务"）：
       * build=变更前确认 / edit=自动编辑 / yolo=完全访问；仅 spawn 新子会话生效。 */}
      <div className="flex shrink-0 flex-col gap-1 text-ui-xs text-foreground-subtle">
        <div className="flex items-center gap-1">
          {intl.formatMessage({ id: "orchestration.plan.childModeField" })}
        </div>
        <select
          value={childMode ?? ""}
          disabled={busy}
          onChange={(event) =>
            onPickChildMode(
              event.target.value === "build" || event.target.value === "edit" || event.target.value === "yolo"
                ? (event.target.value as "build" | "edit" | "yolo")
                : null,
            )
          }
          className="h-7 rounded-md border border-border-subtle bg-background px-1.5 text-ui-xs text-foreground"
        >
          <option value="">{intl.formatMessage({ id: "orchestration.plan.childModeFollow" })}</option>
          <option value="build">{intl.formatMessage({ id: "mode.label.glm.build" })}</option>
          <option value="edit">{intl.formatMessage({ id: "mode.label.glm.edit" })}</option>
          <option value="yolo">{intl.formatMessage({ id: "mode.label.glm.yolo" })}</option>
        </select>
        <p className="text-foreground-subtlest">
          {childMode
            ? intl.formatMessage({ id: `mode.description.glm.${childMode}` })
            : intl.formatMessage({ id: "orchestration.plan.childModeHint" })}
        </p>
      </div>
    </aside>
  );
}
