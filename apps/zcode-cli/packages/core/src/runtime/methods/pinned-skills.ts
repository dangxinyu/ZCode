// 常驻 skill（pinned skills）：会话级 pin 名单的会话真值与全文解析。
// 注入走 request_prefix 通道（context/sections/pinned-skills.ts），每请求随前缀重建；
// 本文件只负责「名单写入 → 内容重解析 → PinnedSkillsChanged 事件」的权威写路径。
import type { ResolvedPinnedSkill, TraceContext } from "../deps.js";
import { SessionEventType, createSessionEvent, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 与 Skill 工具 handler（tool/handlers/skill.ts）保持同一截断上限。 */
const MAX_PINNED_SKILL_BYTES = 100_000;

export function getPinnedSkills(this: AgentRuntimeInternal): readonly string[] {
  return this.sessionPinnedSkills;
}

/**
 * 免事件的名单写入（冷恢复专用，setSessionModelSelection 同先例）：恢复只还原真值，
 * 不追加重复配置事件；全文在首个 turn 的 ensureContextInitialized 里统一解析。
 */
export function setSessionPinnedSkills(
  this: AgentRuntimeInternal,
  skills: readonly string[],
): void {
  this.sessionPinnedSkills = normalizePinnedSkillNames(skills);
}

/**
 * 常驻名单唯一写入口：全量替换语义（空数组=清除）。写入后同步重解析全文，
 * 让下一个模型步的前缀重建立即拿到新内容；再追加 PinnedSkillsChanged 事件供投影消费。
 * 失败项不抛错——以 unavailable 占位进注入（见 context/sections/pinned-skills.ts），
 * 名单合法性由调用方（UI catalog / create config）与解析诊断共同呈现。
 */
export async function setPinnedSkills(
  this: AgentRuntimeInternal,
  options: {
    skills: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const skills = normalizePinnedSkillNames(options.skills);
  this.sessionPinnedSkills = skills;
  await this.resolvePinnedSkillContents(options.traceContext);

  const event = createSessionEvent(
    SessionEventType.PinnedSkillsChanged,
    this.sessionId,
    { skills: [...skills] },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * 按当前名单经 skillPort.loadSkill 解析全文。context 初始化（ensureContextInitialized）
 * 与 setPinnedSkills 都走这里，保证注入内容只有一个解析来源。
 * loadSkill 未命中/读取失败 → content=null 的 unavailable 占位，不阻断会话。
 */
export async function resolvePinnedSkillContents(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const names = this.sessionPinnedSkills;
  if (names.length === 0) {
    this.pinnedSkillContents = [];
    return;
  }
  if (!this.skillPort) {
    this.pinnedSkillContents = names.map((name) => ({ name, content: null }));
    return;
  }

  const resolved = await Promise.all(
    names.map(async (name): Promise<ResolvedPinnedSkill> => {
      try {
        const loaded = await this.skillPort!.loadSkill({
          name,
          workingDirectory: this.workingDirectory,
          maxBytes: MAX_PINNED_SKILL_BYTES,
          trace: traceContext,
        });
        return {
          name,
          content: loaded.content,
          baseDirectory: loaded.baseDirectory,
          truncated: loaded.truncated,
        };
      } catch (error) {
        this.logger?.warn("Pinned skill load failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "skill.pinned.load_failed",
          module: "core.runtime",
          name,
        });
        return { name, content: null };
      }
    }),
  );
  this.pinnedSkillContents = resolved;
}

function normalizePinnedSkillNames(skills: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of skills) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}
