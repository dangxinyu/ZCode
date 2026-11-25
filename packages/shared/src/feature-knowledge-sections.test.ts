import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURE_DOC_PREAMBLE_NAME,
  listChangedFeatureDocSections,
  mergeFeatureDocSections,
  splitFeatureDocSections,
} from "./feature-knowledge-sections.js";

const BASE = `开头说明。

## 需求背景
旧背景。

## 业务规则
旧规则一。
旧规则二。

## 坑与注意
旧坑。
`;

const NEXT = `开头说明改。

## 需求背景
旧背景。

## 业务规则
新规则一。

## 代码位置
src/a.ts。

## 坑与注意
旧坑。
`;

test("split 无损分块：拼接等于原文", () => {
  for (const doc of [BASE, NEXT, "", "无标题纯文本\n", "## 业务规则\n只有规则\n"]) {
    const joined = splitFeatureDocSections(doc)
      .map((section) => section.raw)
      .join("");
    assert.equal(joined, doc);
  }
});

test("changed 列表只含差异章节（含新增与开头）", () => {
  const changed = listChangedFeatureDocSections(BASE, NEXT).map((item) => item.name);
  assert.deepEqual(changed.sort(), [
    FEATURE_DOC_PREAMBLE_NAME,
    "业务规则",
    "代码位置",
  ].sort());
});

test("全选接受与整份新文档字节一致", () => {
  const all = listChangedFeatureDocSections(BASE, NEXT).map((item) => item.name);
  assert.equal(mergeFeatureDocSections(BASE, NEXT, all), NEXT);
});

test("部分接受：勾选章节取新、未勾选保持旧、新增章节未勾选不进入", () => {
  const merged = mergeFeatureDocSections(BASE, NEXT, ["业务规则"]);
  assert.ok(merged.includes("新规则一。"));
  assert.ok(!merged.includes("旧规则一。"));
  assert.ok(merged.includes("开头说明。"));
  assert.ok(!merged.includes("开头说明改。"));
  assert.ok(!merged.includes("src/a.ts。"));
  assert.ok(merged.includes("旧坑。"));
});

test("接受新增章节时按 base 顺序追加", () => {
  const merged = mergeFeatureDocSections(BASE, NEXT, ["代码位置"]);
  assert.ok(merged.includes("src/a.ts。"));
  assert.ok(merged.indexOf("## 业务规则") < merged.indexOf("## 代码位置"));
  assert.ok(merged.indexOf("## 代码位置") < merged.indexOf("## 坑与注意"));
});

test("接受删除：next 缺失的章节勾选后移除", () => {
  const nextWithout = BASE.replace("## 坑与注意\n旧坑。\n", "");
  const merged = mergeFeatureDocSections(BASE, nextWithout, ["坑与注意"]);
  assert.ok(!merged.includes("旧坑。"));
  const kept = mergeFeatureDocSections(BASE, nextWithout, []);
  assert.ok(kept.includes("旧坑。"));
});