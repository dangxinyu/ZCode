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
test("parentName：同批新父无 id 时按名建骨架挂 part_of；同名复用不重复建父", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const childA = await repo.commitProposal(
      (
        await repo.propose({
          proposedName: "组合促销架构",
          proposedDomain: "供应链",
          proposedParentName: "组合促销",
          docMd: "## 业务规则\n子A\n",
        })
      ).id,
    );
    assert.ok(childA.parentFeatureId, "子A 应挂上按名新建的分类父");
    const parent = repo.getFeature(childA.parentFeatureId!);
    assert.equal(parent?.name, "组合促销");
    assert.equal(parent?.domain, "供应链");

    const childB = await repo.commitProposal(
      (
        await repo.propose({
          proposedName: "组合促销互斥",
          proposedDomain: "供应链",
          proposedParentName: "组合促销",
          docMd: "## 业务规则\n子B\n",
        })
      ).id,
    );
    assert.equal(childB.parentFeatureId, childA.parentFeatureId, "同名父应复用而非重复建");
    const categories = repo
      .listFeatures()
      .filter((f) => f.name === "组合促销");
    assert.equal(categories.length, 1);
  } finally {
    repo.close();
  }
});

test("deleteFeature：末级删除清掉投影/账本/关系/FTS，检索不再命中", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const feature = await repo.commitProposal(
      (
        await repo.propose({
          proposedName: "库存成本核算",
          docMd: "## 业务规则\n存货计价口径\n",
          proposedRelations: [],
        })
      ).id,
    );
    // 再提交一版，验证版本账本一并删除（FTS 只认当前版，旧词在 v2 后本就不可检索）。
    assert.ok(repo.searchFeatures("存货计价").length > 0);
    await repo.commitProposal(
      (await repo.propose({ featureId: feature.id, docMd: "## 业务规则\n新口径\n" })).id,
    );
    assert.ok(repo.searchFeatures("新口径").length > 0);
    await repo.deleteFeature(feature.id);
    assert.equal(repo.getFeature(feature.id), null);
    assert.deepEqual(repo.getVersionHistory(feature.id), []);
    assert.deepEqual(repo.listRelations(feature.id), []);
    assert.equal(repo.listFeatures().length, 0);
    assert.equal(repo.searchFeatures("存货计价").length, 0);
    assert.equal(repo.searchFeatures("新口径").length, 0);
  } finally {
    repo.close();
  }
});

test("deleteFeature：有子文档的父拒绝删除；不存在报 featureNotFound", async () => {
  const repo = new FeatureKnowledgeRepo(":memory:");
  try {
    const parent = await repo.commitProposal(
      (await repo.propose({ proposedName: "直运分类", docMd: "## 业务规则\n父\n" })).id,
    );
    const child = await repo.commitProposal(
      (
        await repo.propose({
          proposedName: "直运结算",
          docMd: "## 业务规则\n子\n",
          proposedRelations: [{ toId: parent.id, kind: "part_of" }],
        })
      ).id,
    );
    await assert.rejects(
      () => repo.deleteFeature(parent.id),
      (error: { code?: string }) => error.code === "kb_invalid_input",
    );
    assert.ok(repo.getFeature(parent.id), "拒绝后父与子均保持原状");
    assert.ok(repo.getFeature(child.id));
    // 先删子再删父可行。
    await repo.deleteFeature(child.id);
    await repo.deleteFeature(parent.id);
    assert.equal(repo.listFeatures().length, 0);
    await assert.rejects(
      () => repo.deleteFeature(child.id),
      (error: { code?: string }) => error.code === "kb_feature_not_found",
    );
  } finally {
    repo.close();
  }
});
