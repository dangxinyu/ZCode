import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeatureKnowledgeRepo } from "../src/feature-knowledge/featureKnowledgeRepo.js";
import { KB_ERROR_CODES } from "../src/feature-knowledge/types.js";
import { getAppConfigDir, getFeatureKnowledgeDatabasePath, setDataBaseDir } from "../src/paths.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-feature-kb-"));
  const repo = new FeatureKnowledgeRepo(join(dir, "feature-knowledge.sqlite"));
  await repo.ensureReady();
  return {
    repo,
    dir,
    async cleanup() {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function expectCode(error: unknown, code: string): void {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, code);
}

test("默认库路径落在 app config 目录下", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-feature-kb-path-"));
  setDataBaseDir(dir);
  try {
    assert.equal(getFeatureKnowledgeDatabasePath(), join(getAppConfigDir(), "feature-knowledge.sqlite"));
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移幂等：重复 ensureReady 不重复建表", async () => {
  const { repo, cleanup } = await setup();
  try {
    await repo.ensureReady();
    await repo.ensureReady();
    assert.deepEqual(repo.listFeatures(), []);
  } finally {
    await cleanup();
  }
});

test("新功能点提案 → 提交：建 feature v1 且可检索", async () => {
  const { repo, cleanup } = await setup();
  try {
    const proposal = await repo.propose({
      proposedName: "库存成本核算",
      proposedDomain: "供应链",
      proposedAliases: ["存货计价"],
      docMd: "# 库存成本核算\n\n## 需求背景\n移动加权平均成本。",
      changeSummary: "首次建档",
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.featureId, null);
    const feature = await repo.commitProposal(proposal.id);
    assert.equal(feature.name, "库存成本核算");
    assert.equal(feature.currentVersion, 1);
    assert.deepEqual(feature.aliases, ["存货计价"]);
    assert.equal(repo.getVersionHistory(feature.id).length, 1);
    const hits = repo.searchFeatures("库存成本");
    assert.ok(hits.some((hit) => hit.feature.id === feature.id));
    assert.equal(repo.getProposal(proposal.id)?.status, "committed");
  } finally {
    await cleanup();
  }
});

test("merge-on-write：二次提交整篇重写、版本单调、别名累积", async () => {
  const { repo, cleanup } = await setup();
  try {
    const first = await repo.propose({ proposedName: "成本核算", docMd: "旧文档" });
    const feature = await repo.commitProposal(first.id);
    const second = await repo.propose({
      featureId: feature.id,
      proposedAliases: ["存货计价", "成本计算"],
      docMd: "重新整理后的完整文档",
      changeSummary: "补充业务规则",
    });
    assert.equal(second.baseVersion, 1);
    const updated = await repo.commitProposal(second.id);
    assert.equal(updated.currentVersion, 2);
    assert.equal(updated.docMd, "重新整理后的完整文档");
    assert.deepEqual(updated.aliases, ["存货计价", "成本计算"]);
    const history = repo.getVersionHistory(feature.id);
    assert.deepEqual(history.map((version) => version.version), [2, 1]);
    assert.equal(history[1].docMd, "旧文档");
  } finally {
    await cleanup();
  }
});

test("并发提案冲突：base 已变则拒绝提交", async () => {
  const { repo, cleanup } = await setup();
  try {
    const first = await repo.propose({ proposedName: "功能A", docMd: "v1" });
    const feature = await repo.commitProposal(first.id);
    const staleA = await repo.propose({ featureId: feature.id, docMd: "A 改" });
    const staleB = await repo.propose({ featureId: feature.id, docMd: "B 改" });
    await repo.commitProposal(staleA.id);
    await assert.rejects(
      () => repo.commitProposal(staleB.id),
      (error) => {
        expectCode(error, KB_ERROR_CODES.baseVersionConflict);
        return true;
      },
    );
    assert.equal(repo.getFeature(feature.id)?.currentVersion, 2);
    assert.equal(repo.getProposal(staleB.id)?.status, "pending");
  } finally {
    await cleanup();
  }
});

test("提案状态机：已处理不可重复提交/拒绝", async () => {
  const { repo, cleanup } = await setup();
  try {
    const proposal = await repo.propose({ proposedName: "功能B", docMd: "doc" });
    await repo.commitProposal(proposal.id);
    await assert.rejects(
      () => repo.commitProposal(proposal.id),
      (error) => {
        expectCode(error, KB_ERROR_CODES.proposalResolved);
        return true;
      },
    );
    const rejected = await repo.propose({ proposedName: "功能C", docMd: "doc" });
    const result = await repo.rejectProposal(rejected.id);
    assert.equal(result.status, "rejected");
    await assert.rejects(
      () => repo.commitProposal(rejected.id),
      (error) => {
        expectCode(error, KB_ERROR_CODES.proposalResolved);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("关联目标缺失：事务回滚，功能点不落库", async () => {
  const { repo, cleanup } = await setup();
  try {
    const proposal = await repo.propose({
      proposedName: "功能D",
      docMd: "doc",
      proposedRelations: [{ toId: "missing-id", kind: "relates" }],
    });
    await assert.rejects(
      () => repo.commitProposal(proposal.id),
      (error) => {
        expectCode(error, KB_ERROR_CODES.relationTargetMissing);
        return true;
      },
    );
    assert.deepEqual(repo.listFeatures(), []);
    assert.equal(repo.getProposal(proposal.id)?.status, "pending");
  } finally {
    await cleanup();
  }
});

test("检索分层：词面 / 别名 / 代码锚点各自命中", async () => {
  const { repo, cleanup } = await setup();
  try {
    const proposal = await repo.propose({
      proposedName: "库存成本核算",
      proposedAliases: ["存货计价"],
      proposedAnchors: [{ repo: "erp", paths: ["src/cost/InventoryCost.java"], symbols: ["calcCost"] }],
      docMd: "移动加权平均成本核算逻辑。",
    });
    const feature = await repo.commitProposal(proposal.id);
    const lexical = repo.searchFeatures("加权平均");
    assert.ok(lexical.find((hit) => hit.feature.id === feature.id)?.layers.includes("lexical"));
    const alias = repo.searchFeatures("存货计价");
    assert.ok(alias.find((hit) => hit.feature.id === feature.id)?.layers.includes("alias"));
    const anchor = repo.searchFeatures("InventoryCost");
    assert.ok(anchor.find((hit) => hit.feature.id === feature.id)?.layers.includes("anchor"));
  } finally {
    await cleanup();
  }
});

test("非法输入与不存在目标", async () => {
  const { repo, cleanup } = await setup();
  try {
    await assert.rejects(
      () => repo.propose({ proposedName: "X", docMd: "  " }),
      (error) => {
        expectCode(error, KB_ERROR_CODES.invalidInput);
        return true;
      },
    );
    await assert.rejects(
      () => repo.propose({ docMd: "doc" }),
      (error) => {
        expectCode(error, KB_ERROR_CODES.invalidInput);
        return true;
      },
    );
    await assert.rejects(
      () => repo.propose({ featureId: "nope", docMd: "doc" }),
      (error) => {
        expectCode(error, KB_ERROR_CODES.featureNotFound);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});