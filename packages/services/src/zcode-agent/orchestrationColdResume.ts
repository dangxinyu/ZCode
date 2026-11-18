// 冷会话 resume 的模型选型归一与补齐（spec: packages/services/specs/orchestration-tasks.md
// "冷恢复选型归一"）。编排向关联进来的旧任务下发指令时 runtime 多半已回收，resume 需要
// 带 tasks-index 里最后一次选型兜底；但旧数据的选型可能已经失效——实测 2026-10-30：
// 最老的子任务存的是 8 月的 `builtin:bigmodel-coding-plan/GLM-5.2$max`（旧 provider 身份、
// 思考档位混进 modelId），其余 11 个是 `account:…/GLM-5.3`，只有它 resume 后没有生效模型，
// ACK 进去的输入被模型闸门挡住，既不执行也不报错，编排侧完全看不见。
// 两个事实形态要分清：tasks-index 存的是 `provider='glm'` + `model='身份/模型名[$档位]'`
// 的复合串；运行时选型与快照可用列表 ref 是 `{providerId: 身份, modelId: 模型名}` 规范形。
import {
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
  type ModelSelection,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "../session/taskIndexRepo.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";

export interface ColdResumeModelHint {
  model: { providerId: string; modelId: string };
  thoughtLevel?: string;
}

/** tasks-index task meta 中与选型相关的三列（缺省/空串一律视为无选型）。 */
export interface StoredModelSelection {
  provider?: string | null;
  model?: string | null;
  thoughtLevel?: string | null;
}

/**
 * tasks-index 最后选型 → resume 模型提示（复合串形态，runtime 接受）。归一三种旧形态：
 * 1) provider 身份是旧体系（`builtin:bigmodel-coding-plan` 等）→ 经单向迁移表换成账号体系；
 * 2) 思考档位混进 modelId（`…/GLM-5.2$max`）→ 拆回 thoughtLevel（已有显式档位时不覆盖）；
 * 3) 官方 GLM 模型名大小写漂移 → 规范名。
 * 未知旧身份无法迁移时返回 undefined。
 */
export function buildColdResumeModelHint(
  stored: StoredModelSelection | null | undefined,
): ColdResumeModelHint | undefined {
  const provider = stored?.provider?.trim();
  const rawModel = stored?.model?.trim();
  if (!provider || !rawModel) return undefined;
  let modelRef = rawModel;
  let thoughtLevel = stored?.thoughtLevel?.trim() || undefined;
  const levelAt = modelRef.lastIndexOf("$");
  if (levelAt > 0) {
    thoughtLevel ??= modelRef.slice(levelAt + 1).trim() || undefined;
    modelRef = modelRef.slice(0, levelAt);
  }
  const slashAt = modelRef.indexOf("/");
  if (slashAt > 0) {
    const identity = modelRef.slice(0, slashAt);
    const name = modelRef.slice(slashAt + 1);
    const migratedIdentity = migrateLegacyModelProviderId(identity);
    if (!migratedIdentity || !name) return undefined;
    modelRef = `${migratedIdentity}/${migrateLegacyOfficialGlmModelId(migratedIdentity, name)}`;
  }
  return {
    model: { providerId: provider, modelId: modelRef },
    ...(thoughtLevel ? { thoughtLevel } : {}),
  };
}

/** 复合串提示 → 规范形 `{providerId: 身份, modelId: 模型名}`，用于与快照可用列表 ref 比对。 */
function toCanonicalSelection(hint: ColdResumeModelHint): { providerId: string; modelId: string } {
  const slashAt = hint.model.modelId.indexOf("/");
  return slashAt > 0
    ? {
        providerId: hint.model.modelId.slice(0, slashAt),
        modelId: hint.model.modelId.slice(slashAt + 1),
      }
    : { providerId: hint.model.providerId, modelId: hint.model.modelId };
}

/**
 * 会话没有生效模型时（快照 `settings.model.current` 为空 = 后续输入会被闸门拦住），从
 * 可用列表里挑一个可 setModel 的规范选型：按候选顺序（子任务自身旧选型 → 父编排任务
 * 选型）找在列表内的项，都不在则取首个未禁用项；列表为空返回 undefined。
 * 模型声明了思考档位时必须带 reasoningLevel（实测 setModel 被拒
 * "Reasoning level is required for …/GLM-5.3"）：优先候选里带的档位（旧 `$max` 拆出来的
 * 也算）→ 模型默认档 → 首个档。
 */
export function resolveColdResumeModelSelection(
  snapshot: ZCodeSessionStateSnapshot,
  candidates: ReadonlyArray<StoredModelSelection | null | undefined>,
): ModelSelection | undefined {
  const usable = snapshot.settings.model.available.filter((option) => !option.disabledReason);
  const hints = candidates.map((candidate) => buildColdResumeModelHint(candidate));
  const preferredLevels = hints.flatMap((hint) => (hint?.thoughtLevel ? [hint.thoughtLevel] : []));
  const withReasoningLevel = (
    option: ZCodeSessionStateSnapshot["settings"]["model"]["available"][number],
  ): ModelSelection => {
    const reasoning = option.reasoning;
    if (!reasoning || reasoning.levels.length === 0) return option.ref;
    const level =
      preferredLevels.find((candidate) =>
        reasoning.levels.some((entry) => entry.value === candidate),
      ) ??
      reasoning.defaultLevel ??
      reasoning.levels[0]?.value;
    if (!level) return option.ref;
    return {
      providerId: option.ref.providerId,
      modelId: option.ref.modelId,
      options: { ...option.ref.options, reasoningLevel: level },
    };
  };
  for (const hint of hints) {
    if (!hint) continue;
    const canonical = toCanonicalSelection(hint);
    const match = usable.find(
      (option) =>
        option.ref.modelId === canonical.modelId && option.ref.providerId === canonical.providerId,
    );
    if (match) return withReasoningLevel(match);
  }
  const first = usable[0];
  return first ? withReasoningLevel(first) : undefined;
}

const logger = createServiceLogger("zcode-orchestration");

/**
 * 下发前把子会话准备到"可执行"：
 * 1) 统一先 readSession（messageLimit=1）探测——活跃会话直接拿快照；`not active` 的冷会话
 *    先 resume 物化（带归一后的旧选型提示）。两条路落到同一份快照，后续检查对冷/热一视同仁
 *    （此前只在"下发被拒→冷恢复"路径检查模型，热会话没模型照样被 ACK 进闸门后面，实测
 *    agent 重试即命中）。
 * 2) 以快照 `settings.model.current` 为准：为空就显式 setModel。resume 的 model 提示对已
 *    持久化旧选型的会话不生效（实测两次 resume 后 current 仍为空、UI 显示"选择模型"）；
 *    readSession 快照的 available 可能为空，先用 resume 拿完整设置再选。
 * 仍无法得到生效模型即抛错——让下发失败可见，而不是 ACK 后静默卡死。
 */
export async function prepareChildSessionForDispatch(
  deps: {
    taskIndexRepo: Pick<TaskIndexRepo, "getTaskMeta">;
    zcodeAgentService: Pick<IZCodeAgentService, "readSession" | "resumeSession" | "setModel">;
  },
  params: {
    orchestrationTaskId: string;
    childTaskId: string;
    childTaskName: string;
    workspacePath: string;
    workspaceIdentity?: string;
    childMeta: StoredModelSelection | null;
  },
): Promise<ModelSelection | null> {
  const sessionScope = {
    sessionId: params.childTaskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };
  const resume = () =>
    deps.zcodeAgentService.resumeSession({
      ...sessionScope,
      ...buildColdResumeModelHint(params.childMeta),
    });
  let snapshot: ZCodeSessionStateSnapshot;
  try {
    snapshot = await deps.zcodeAgentService.readSession({ ...sessionScope, messageLimit: 1 });
  } catch (probeError) {
    const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
    if (!/not active|sessionnotfound|unavailable/i.test(probeMessage)) throw probeError;
    logger.info("Child session cold; resuming before dispatch", {
      childTaskId: params.childTaskId,
      event: "orchestration.send_child_prompt.cold_resume",
      firstMessage: probeMessage,
      orchestrationTaskId: params.orchestrationTaskId,
    });
    snapshot = await resume();
  }
  // 生效模型判定（bug 修复 2026-11-04，实测编排会话 current 非空但失效，轮次在
  // model_creation 被 "Select a model before continuing" 拒绝）：current 非空 ≠ 可用——
  // 持久化选型在 runtime 重启/配置漂移后可能解析不到。用快照 available（未禁用项）校验
  // current；available 为空 = 快照信息不足，先 resume 拿完整设置再看，仍拿不到则退回
  // 信任 current（与旧行为一致，避免过度拒绝）。
  const matchesUsable = (snap: ZCodeSessionStateSnapshot): boolean => {
    const current = snap.settings.model.current;
    if (!current) return false;
    const usable = snap.settings.model.available.filter((option) => !option.disabledReason);
    if (usable.length === 0) return true;
    return usable.some(
      (option) =>
        option.ref.providerId === current.providerId &&
        option.ref.modelId === current.modelId,
    );
  };
  let usableKnown = matchesUsable(snapshot);
  if (!usableKnown && snapshot.settings.model.available.length === 0) {
    snapshot = await resume();
    usableKnown = matchesUsable(snapshot);
  }
  if (usableKnown) return snapshot.settings.model.current ?? null;
  const parentMeta = await deps.taskIndexRepo
    .getTaskMeta({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      taskId: params.orchestrationTaskId,
    })
    .catch(() => null);
  const staleSelection =
    params.childMeta?.model ?? JSON.stringify(snapshot.settings.model.current ?? null);
  const selection = resolveColdResumeModelSelection(snapshot, [params.childMeta, parentMeta]);
  if (!selection) {
    throw new Error(
      `Session has no usable model: its last selection (${staleSelection}) is no longer valid and it offers no alternative (available models: ${snapshot.settings.model.available.length}). Open it, pick a model, then resend.`,
    );
  }
  logger.info("Session model stale or missing; selecting one explicitly", {
    childTaskId: params.childTaskId,
    event: "orchestration.send_child_prompt.model_fallback",
    orchestrationTaskId: params.orchestrationTaskId,
    reasoningLevel: selection.options?.reasoningLevel ?? null,
    selectedModelId: selection.modelId,
    selectedProviderId: selection.providerId,
    staleSelection,
  });
  snapshot = await deps.zcodeAgentService.setModel({ ...sessionScope, model: selection });
  if (!matchesUsable(snapshot)) {
    throw new Error(
      `Still has no effective model after selecting ${selection.providerId}/${selection.modelId} (stale selection: ${staleSelection}). Open it, pick a model, then resend.`,
    );
  }
  return snapshot.settings.model.current ?? null;
}
