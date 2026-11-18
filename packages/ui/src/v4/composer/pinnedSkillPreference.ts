// 常驻 skill 的 workspace 级偏好（composerRecent 同款模式）：
// 所有权在 workspace 而非 per-session 草稿——建会话时 promoteComposerDraft 会把根草稿
// 搬进 session scope 并清空来源，per-scope 存储会让「常驻」每次新建任务都被清掉。
// 协议侧仍为 array（SessionConfigState.pinnedSkills），本偏好约束长度 ≤1（单选）。
import { logger } from "@/logger.js";

const PINNED_SKILL_PREFERENCE_KEY_PREFIX = "zcode-v4-composer-pinned-skill-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolvePinnedSkillPreferenceKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${PINNED_SKILL_PREFERENCE_KEY_PREFIX}:${workspaceKey}`;
}

function normalizePinnedSkills(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of skills) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  // 单选语义：只保留第一个。
  return normalized.slice(0, 1);
}

export function readPinnedSkillPreference(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(resolvePinnedSkillPreferenceKey(workspacePath, workspaceIdentity));
    if (!raw) return [];
    const record: unknown = JSON.parse(raw);
    const skills = (record as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(skills)) return [];
    return normalizePinnedSkills(skills.filter((name): name is string => typeof name === "string"));
  } catch {
    return [];
  }
}

export function writePinnedSkillPreference(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  skills: readonly string[],
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      resolvePinnedSkillPreferenceKey(workspacePath, workspaceIdentity),
      JSON.stringify({ skills: normalizePinnedSkills(skills) }),
    );
  } catch (error) {
    // 偏好写失败只降级为不持久化（隐私模式/配额），不影响本次选择生效。
    logger.warn("[PinnedSkillPreference] 保存常驻 skill 偏好失败", {
      workspacePath,
      workspaceIdentity,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
