// 订正隐藏上下文尾块的无损 round-trip 单测（spec: feature-knowledge.md 末级右键订正）。
// 验证：JSON 尾块序列化/解析字段不丢；正文剥离；与网页元素尾块共存时按相反顺序解析；坏块不吞正文。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPromptWithFeatureCorrection,
  parsePromptFeatureCorrection,
  type FeatureCorrectionComposerAttachment,
} from "../src/lib/featureCorrectionContext.js";
import { buildPromptWithWebElementContexts } from "../src/lib/webElementContext.js";

const CONTEXT: FeatureCorrectionComposerAttachment = {
  id: "ctx-1",
  featureId: "feature-1",
  featureName: "库存成本核算",
  domain: "供应链",
  aliases: ["存货计价", "stock costing"],
  anchors: [{ repo: "erp", paths: ["src/cost/calc.ts"], symbols: ["calcCost"] }],
  // 故意携带换行 / markdown fence / 中文引号，验证 JSON 转义后 fence 边界无歧义。
  docMd: "## 业务规则\n存货计价口径。\n\n```sql\nSELECT 1;\n```\n\n「坑」：含 ``` 反引号。",
  currentVersion: 3,
  instruction: "按用户描述修复该文档并提案。",
  capturedAt: 1_700_000_000_000,
};

test("round-trip：序列化后解析字段无损，正文剥离尾块", () => {
  const prompt = buildPromptWithFeatureCorrection("把口径改成移动加权平均", [CONTEXT]);
  assert.ok(prompt.startsWith("把口径改成移动加权平均"));
  const parsed = parsePromptFeatureCorrection(prompt);
  assert.equal(parsed.visibleContent, "把口径改成移动加权平均");
  assert.deepEqual(parsed.featureCorrections, [CONTEXT]);
});

test("空正文也可携带尾块；无尾块时原样返回", () => {
  const prompt = buildPromptWithFeatureCorrection("", [CONTEXT]);
  const parsed = parsePromptFeatureCorrection(prompt);
  assert.equal(parsed.visibleContent, "");
  assert.deepEqual(parsed.featureCorrections, [CONTEXT]);

  const plain = parsePromptFeatureCorrection("普通消息，没有尾块");
  assert.equal(plain.visibleContent, "普通消息，没有尾块");
  assert.deepEqual(plain.featureCorrections, []);
});

test("与网页元素尾块共存：外层订正先剥，内层网页元素随后解析", () => {
  const web = {
    id: "web-1",
    workspacePath: "/tmp/ws",
    pageUrl: "https://example.com",
    pageTitle: "示例页",
    tagName: "BUTTON",
    capturedAt: 1,
  };
  const withWeb = buildPromptWithWebElementContexts("修复按钮", [web]);
  const prompt = buildPromptWithFeatureCorrection(withWeb, [CONTEXT]);
  const correction = parsePromptFeatureCorrection(prompt);
  assert.deepEqual(correction.featureCorrections, [CONTEXT]);
  assert.ok(correction.visibleContent.includes("# Web page elements:"));
});

test("坏 JSON / 缺字段不吞正文，按无上下文处理", () => {
  const badJson = "正文\n\n# Feature correction context:\n\n```json\n{not json}\n```";
  assert.equal(parsePromptFeatureCorrection(badJson).visibleContent, badJson);
  const missingField = `正文\n\n# Feature correction context:\n\n\`\`\`json\n${JSON.stringify([{ id: "x" }])}\n\`\`\``;
  const parsed = parsePromptFeatureCorrection(missingField);
  assert.equal(parsed.visibleContent, missingField);
  assert.deepEqual(parsed.featureCorrections, []);
});