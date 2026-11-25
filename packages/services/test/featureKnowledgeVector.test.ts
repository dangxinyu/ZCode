// 语义向量层单测（spec: feature-knowledge.md 检索分层③ + RRF 融合 + 降级）。
// 用确定性假 embedder 构造一个迷你语义空间，验证「换说法」经向量层召回。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeatureKnowledgeRepo } from "../src/feature-knowledge/featureKnowledgeRepo.js";
import { createFeatureKnowledgeService } from "../src/feature-knowledge/featureKnowledgeService.js";
import type { FeatureEmbedder } from "../src/feature-knowledge/featureKnowledge.js";
import { chunkDocument, cosineSimilarity, fuseByRrf } from "../src/feature-knowledge/embeddings.js";

// 迷你语义空间：成本概念=[1,0]，库存概念=[0,1]；同义词归一到同一概念向量。
const lexicalEmbedder: FeatureEmbedder = async ({ texts }) => ({
  model: "fake-embed",
  vectors: texts.map((text) => {
    const cost = /成本|计价|核算|cost/.test(text) ? 1 : 0;
    const inventory = /库存|存货|inventory/.test(text) ? 1 : 0;
    return cost === 0 && inventory === 0 ? [0.001, 0.001] : [cost, inventory];
  }),
});

async function setup(embedder?: FeatureEmbedder, expandQuery?: (query: string) => Promise<string[]>) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-feature-kb-vec-"));
  const repo = new FeatureKnowledgeRepo(join(dir, "feature-knowledge.sqlite"));
  const service = createFeatureKnowledgeService({ repo, embedder, expandQuery });
  return {
    repo,
    service,
    async cleanup() {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("纯函数：分块保段落、cosine 正交为 0、RRF 多层命中排前", () => {
  const chunks = chunkDocument("第一段\n\n第二段\n\n第三段", 12);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  const fused = fuseByRrf([
    [{ id: "a", layers: ["lexical"] }, { id: "b", layers: ["lexical"] }],
    [{ id: "b", layers: ["vector"] }],
  ]);
  assert.equal(fused[0].id, "b");
  assert.deepEqual(fused[0].layers.sort(), ["lexical", "vector"]);
});

test("向量层换说法召回：文档「库存成本核算」搜「存货计价」命中且标 vector 层", async () => {
  const { service, cleanup } = await setup(lexicalEmbedder);
  try {
    const proposal = await service.propose({ proposedName: "成本核算", docMd: "库存成本核算流程" });
    const feature = await service.commitProposal(proposal.id);
    await tick();

    const result = await service.searchFeatures("存货计价");
    assert.equal(result.semanticEnabled, true);
    const hit = result.hits.find((item) => item.feature.id === feature.id);
    assert.ok(hit, "向量层应召回换说法查询");
    assert.ok(hit.layers.includes("vector"));
  } finally {
    await cleanup();
  }
});

test("无 embedder 时换说法查询降级：词面/别名/锚点均不命中，semanticEnabled=false", async () => {
  const { service, cleanup } = await setup();
  try {
    const proposal = await service.propose({ proposedName: "成本核算", docMd: "库存成本核算流程" });
    await service.commitProposal(proposal.id);
    const result = await service.searchFeatures("存货计价");
    assert.equal(result.semanticEnabled, false);
    assert.equal(result.hits.length, 0);
  } finally {
    await cleanup();
  }
});

test("RRF 融合：词面+向量双命中功能点排在仅向量命中之前", async () => {
  const { service, cleanup } = await setup(lexicalEmbedder);
  try {
    const a = await service.propose({ proposedName: "库存成本", docMd: "库存成本核算" });
    const featureA = await service.commitProposal(a.id);
    const b = await service.propose({ proposedName: "存货计价", docMd: "存货计价方法" });
    const featureB = await service.commitProposal(b.id);
    await tick();

    const result = await service.searchFeatures("库存成本");
    const ids = result.hits.map((hit) => hit.feature.id);
    assert.ok(ids.includes(featureA.id) && ids.includes(featureB.id));
    assert.ok(ids.indexOf(featureA.id) < ids.indexOf(featureB.id), "双命中应排前");
    const hitA = result.hits.find((hit) => hit.feature.id === featureA.id)!;
    assert.ok(hitA.layers.includes("lexical") && hitA.layers.includes("vector"));
  } finally {
    await cleanup();
  }
});

test("embedder 返回 null：提交成功、词面仍召回、semanticEnabled=true 但无 vector 层", async () => {
  const nullEmbedder: FeatureEmbedder = async () => null;
  const { service, cleanup } = await setup(nullEmbedder);
  try {
    const proposal = await service.propose({ proposedName: "库存核算", docMd: "库存成本核算流程" });
    const feature = await service.commitProposal(proposal.id);
    await tick();
    const result = await service.searchFeatures("库存成本");
    assert.equal(result.semanticEnabled, true);
    const hit = result.hits.find((item) => item.feature.id === feature.id);
    assert.ok(hit);
    assert.ok(!hit.layers.includes("vector"));
  } finally {
    await cleanup();
  }
});

test("embedder 抛错不阻塞提交：commit 仍成功，词面检索可用", async () => {
  const failingEmbedder: FeatureEmbedder = async () => {
    throw new Error("embedding endpoint down");
  };
  const { service, cleanup } = await setup(failingEmbedder);
  try {
    const proposal = await service.propose({ proposedName: "库存核算", docMd: "库存成本核算流程" });
    const feature = await service.commitProposal(proposal.id);
    await tick();
    assert.equal(feature.currentVersion, 1);
    const result = await service.searchFeatures("库存成本");
    assert.ok(result.hits.some((hit) => hit.feature.id === feature.id));
  } finally {
    await cleanup();
  }
});

test("查询扩展：expandQuery 把口语翻成检索词，向量层据此召回", async () => {
  const expandQuery = async (query: string): Promise<string[]> =>
    query === "东西值多少钱" ? ["存货计价"] : [];
  const { service, cleanup } = await setup(lexicalEmbedder, expandQuery);
  try {
    const proposal = await service.propose({ proposedName: "成本核算", docMd: "库存成本核算流程" });
    const feature = await service.commitProposal(proposal.id);
    await tick();
    // 原 query 不含概念词，扩展出「存货计价」后向量层召回。
    const result = await service.searchFeatures("东西值多少钱");
    assert.ok(result.hits.some((hit) => hit.feature.id === feature.id));
  } finally {
    await cleanup();
  }
});