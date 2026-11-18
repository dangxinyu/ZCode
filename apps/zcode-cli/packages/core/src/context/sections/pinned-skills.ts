// ============================================================
// Pinned Skills Section Builder
// ============================================================
// 常驻 skill：会话级 pin 名单的全文注入。与 skills_listing（只列清单）不同，这里
// 承载用户显式选择加载的 SKILL.md 全文，走 request_prefix 通道——每请求随前缀重建，
// compact 只保留前缀，因此「压缩后不丢、丢失自动重载」由通道语义保证。

import type { ResolvedPinnedSkill } from "../types.js";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/** 常驻 skill 全文注入的总字符预算（多 skill 共享，超限降级为名字清单）。
 * 50k 依据（用户实测 2026-11-04）：真实 skill 的 SKILL.md 普遍 1.5~3 万字符
 * （ai-novel-assistant 30.5k ≈ 1.6 万 token、workmate 14.8k ≈ 0.7 万 token），
 * 旧的 20k 预算几乎必然降级——挂名 + "用 Skill 工具按需加载"的指示模型不会主动执行，
 * 编排派发挂载的 skill 实际形同虚设。50k 可同时全文常驻两个真实 skill
 * （约 2.2 万 token，request_prefix 通道 compact 不丢）；真正超大（>50k）的
 * skill 仍走挂名降级，不无限吃上下文。 */
const DEFAULT_PINNED_SKILLS_BUDGET = 50_000;

interface PinnedSkillsSectionOptions {
  skills: readonly ResolvedPinnedSkill[];
  budget?: number;
}

export function buildPinnedSkillsSection(
  options: PinnedSkillsSectionOptions,
): ContextSection | null {
  if (options.skills.length === 0) {
    return null;
  }

  const content = buildPinnedSkillsContent(
    options.skills,
    options.budget ?? DEFAULT_PINNED_SKILLS_BUDGET,
  );

  return {
    name: "Pinned Skills",
    source: "pinned_skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildPinnedSkillsContent(
  skills: readonly ResolvedPinnedSkill[],
  budget: number,
): string {
  const header = [
    "The user has pinned the following skills to be always loaded in this session.",
    "Treat their instructions as active guidance for this session:",
  ];
  const available = skills.filter((skill) => skill.content !== null);
  const unavailable = skills.filter((skill) => skill.content === null);

  const fullBody = [
    ...header,
    "",
    ...available.flatMap((skill) => availableSkillLines(skill)),
    ...unavailable.map(unavailableSkillLine),
  ].join("\n");
  if (fullBody.length <= budget) {
    return fullBody;
  }

  // 超预算降级：全文换成名字清单 + 指示模型按需用 Skill 工具加载；unavailable 占位保留。
  return [
    ...header,
    "",
    ...available.map(
      (skill) =>
        `- ${skill.name}: content omitted for context budget; load it with the Skill tool before following its instructions.`,
    ),
    ...unavailable.map(unavailableSkillLine),
  ].join("\n");
}

function availableSkillLines(skill: ResolvedPinnedSkill): string[] {
  const lines = [`<pinned_skill name="${escapeAttributeName(skill.name)}">`];
  lines.push(skill.content ?? "");
  if (skill.baseDirectory) {
    lines.push("");
    lines.push(`Base directory for this skill: ${skill.baseDirectory}`);
    lines.push("Relative paths in this skill are relative to this base directory.");
  }
  if (skill.truncated) {
    lines.push("[Skill content truncated]");
  }
  lines.push("</pinned_skill>");
  return lines;
}

function unavailableSkillLine(skill: ResolvedPinnedSkill): string {
  return (
    `<pinned_skill name="${escapeAttributeName(skill.name)}" status="unavailable">` +
    `The pinned skill "${skill.name}" could not be loaded (missing or unreadable). ` +
    "If it is needed, tell the user it is unavailable.</pinned_skill>"
  );
}

function escapeAttributeName(name: string): string {
  return name.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}
