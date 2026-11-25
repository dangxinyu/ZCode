// 开工自动召回的纯逻辑单测（spec: feature-knowledge.md 主动调用机制 1+2）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_RECALL_TOP_K,
  buildFeatureKnowledgeRecallReminder,
  shouldAutoRecallFeatureKnowledge,
} from "../src/feature-knowledge/auto-recall.js";

const hit = (name: string) => ({
  feature: {
    id: `id-${name}`,
    name,
    domain: "模型与供应商",
    aliases: [],
    anchors: [{ paths: ["src/a.ts", "src/b.ts"] }],
    currentVersion: 2,
    updatedAt: 0,
  },
  layers: ["lexical", "alias"] as const,
  score: 1,
});

test("gate：子代理/工作流 actor、空输入、slash 命令不召回", () => {
  assert.equal(shouldAutoRecallFeatureKnowledge("subagent_child", "分析 bug"), false);
  assert.equal(shouldAutoRecallFeatureKnowledge("workflow_child", "分析 bug"), false);
  assert.equal(shouldAutoRecallFeatureKnowledge(undefined, "   "), false);
  assert.equal(shouldAutoRecallFeatureKnowledge(undefined, "/compact"), false);
  assert.equal(shouldAutoRecallFeatureKnowledge(undefined, "分析 GLM 接入的坑"), true);
  assert.equal(shouldAutoRecallFeatureKnowledge("orchestration_parent", "分析 bug"), true);
});

test("reminder：top-k 截断、含锚点与命中层、带主动检索常设指令", () => {
  const hits = [hit("甲"), hit("乙"), hit("丙"), hit("丁")];
  const reminder = buildFeatureKnowledgeRecallReminder(hits);
  assert.ok(reminder);
  assert.ok(reminder.includes("<system-reminder>"));
  assert.ok(reminder.includes("「甲」"));
  assert.ok(reminder.includes("「丙」"));
  assert.ok(!reminder.includes("「丁」"));
  assert.equal(AUTO_RECALL_TOP_K, 3);
  assert.ok(reminder.includes("src/a.ts"));
  assert.ok(reminder.includes("lexical/alias"));
  assert.ok(reminder.includes("SearchFeatures"));
  assert.ok(reminder.includes("ReadFeatureDoc"));
});

test("reminder：无命中返回 null，不注入空提醒", () => {
  assert.equal(buildFeatureKnowledgeRecallReminder([]), null);
});