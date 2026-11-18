// 常驻 skill 的注入与压缩保留边界单测（node:test，`npx tsx --test` 直跑）。
import assert from "node:assert/strict";
import test from "node:test";

import { buildPinnedSkillsSection } from "../src/context/sections/pinned-skills.js";
import type { ResolvedPinnedSkill } from "../src/context/types.js";
import {
  countContextPrefixMessages,
  systemReminderAttachmentEntry,
} from "../src/agent/message-history.js";

function availableSkill(name: string, content: string): ResolvedPinnedSkill {
  return { name, content, baseDirectory: `/tmp/skills/${name}` };
}

test("pinned skills section: 无名单时返回 null，不产生空附件", () => {
  assert.equal(buildPinnedSkillsSection({ skills: [] }), null);
});

test("pinned skills section: 注入全文与 base directory，标记 pin 语义", () => {
  const section = buildPinnedSkillsSection({
    skills: [availableSkill("workmate", "# 老搭档\n永远在线")],
  });
  assert.ok(section);
  assert.equal(section.source, "pinned_skills");
  assert.equal(section.injectionTarget, "meta_user");
  assert.match(section.content, /always loaded in this session/);
  assert.match(section.content, /<pinned_skill name="workmate">/);
  assert.match(section.content, /# 老搭档/);
  assert.match(section.content, /Base directory for this skill: \/tmp\/skills\/workmate/);
});

test("pinned skills section: 名单项失效时注入 unavailable 占位，不静默消失", () => {
  const section = buildPinnedSkillsSection({
    skills: [
      availableSkill("workmate", "content"),
      { name: "ghost", content: null },
    ],
  });
  assert.ok(section);
  assert.match(section.content, /<pinned_skill name="ghost" status="unavailable">/);
  assert.match(section.content, /could not be loaded/);
});

test("pinned skills section: 超预算降级为名字清单并指引 Skill 工具加载", () => {
  const section = buildPinnedSkillsSection({
    skills: [availableSkill("big", "x".repeat(50_000))],
    budget: 100,
  });
  assert.ok(section);
  assert.ok(!section.content.includes("x".repeat(100)));
  assert.match(section.content, /- big: content omitted for context budget/);
  assert.match(section.content, /load it with the Skill tool/);
});

test("pinned skills section: XML 属性转义防注入", () => {
  const section = buildPinnedSkillsSection({
    skills: [availableSkill('a"b<c', "content")],
  });
  assert.ok(section);
  assert.match(section.content, /name="a&quot;b&lt;c"/);
});

test("countContextPrefixMessages: pinned_skill 与既有前缀附件同受 compact 保留边界保护", () => {
  const entries = [
    systemReminderAttachmentEntry("context_prefix", "prefix"),
    systemReminderAttachmentEntry("skills_listing", "listing"),
    systemReminderAttachmentEntry("pinned_skill", "pinned"),
    systemReminderAttachmentEntry("todo_reminder", "todo"),
  ];
  assert.equal(countContextPrefixMessages(entries), 3);
});
