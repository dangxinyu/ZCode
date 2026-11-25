// 章节级部分接受的 host 提交路径单测（spec: feature-knowledge.md 提案-确认闸门）。
// 内存库验证：部分接受以当前文档为底只替换勾选章节；全选与整份提交字节一致；版本单调。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFeatureDocSections } from "@zcode/shared";
import { FeatureKnowledgeRepo } from "./featureKnowledgeRepo.js";

const BASE = `## 需求背景
旧背景。

## 业务规则
旧规则。

## 坑与注意
旧坑。
`;

const NEXT = `## 需求背景
旧背景。

## 业务规则
新规则。

## 代码位置
src/a.ts。

## 坑与注意
新坑。
`;

// propose 入库前 trim 文档，故期望值用 trim 后的常量。
const BASE_DOC = BASE.trim();
const NEXT_DOC = NEXT.trim();

test("部分接受：未勾选章节保持原文，勾选章节取提案", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const created = await repo.propose({ proposedName: "功能甲", docMd: BASE });
    const v1 = await repo.commitProposal(created.id);
    assert.equal(v1.currentVersion, 1);

    const partial = await repo.propose({ featureId: v1.id, docMd: NEXT });
    const v2 = await repo.commitProposal(partial.id, ["业务规则", "坑与注意"]);
    assert.equal(v2.currentVersion, 2);
    assert.equal(
      v2.docMd,
      mergeFeatureDocSections(BASE_DOC, NEXT_DOC, ["业务规则", "坑与注意"]),
    );
    assert.ok(v2.docMd.includes("新规则。"));
    assert.ok(v2.docMd.includes("新坑。"));
    assert.ok(!v2.docMd.includes("src/a.ts。"));
    assert.ok(v2.docMd.includes("旧背景。"));
  } finally {
    repo.close();
  }
});

test("全选接受与整份提交字节一致；缺省参数仍整份提交", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const created = await repo.propose({ proposedName: "功能乙", docMd: BASE });
    const v1 = await repo.commitProposal(created.id);
    const all = await repo.propose({ featureId: v1.id, docMd: NEXT });
    const v2 = await repo.commitProposal(all.id, [
      "需求背景",
      "业务规则",
      "代码位置",
      "坑与注意",
    ]);
    assert.equal(v2.docMd, NEXT_DOC);

    const whole = await repo.propose({ featureId: v2.id, docMd: BASE });
    const v3 = await repo.commitProposal(whole.id);
    assert.equal(v3.docMd, BASE_DOC);
    assert.equal(v3.currentVersion, 3);
  } finally {
    repo.close();
  }
});
test("part_of 层级：migration 0003 允许 part_of，parentFeatureId 投影到 summary/feature", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const parent = await repo.commitProposal(
      (await repo.propose({ proposedName: "以销定采操作台", docMd: "## 业务规则\n父文档\n" })).id,
    );
    const childProposal = await repo.propose({
      proposedName: "帮助按钮",
      docMd: "## 业务规则\n子文档\n",
      proposedRelations: [{ toId: parent.id, kind: "part_of" }],
    });
    const child = await repo.commitProposal(childProposal.id);
    assert.equal(child.parentFeatureId, parent.id);
    const summaries = repo.listFeatures();
    assert.equal(summaries.find((f) => f.id === child.id)?.parentFeatureId, parent.id);
    assert.equal(summaries.find((f) => f.id === parent.id)?.parentFeatureId, null);
    assert.equal(repo.getFeature(child.id)?.parentFeatureId, parent.id);
  } finally {
    repo.close();
  }
});
