import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeatureKnowledgeRepo } from "../src/feature-knowledge/featureKnowledgeRepo.js";
import { createFeatureKnowledgeService } from "../src/feature-knowledge/featureKnowledgeService.js";
import type { FeatureKnowledgeChanged } from "../src/feature-knowledge/featureKnowledge.js";
import { FEATURE_KNOWLEDGE_CHANGED_BROADCAST_CHANNEL } from "@zcode/shared";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-feature-kb-svc-"));
  const repo = new FeatureKnowledgeRepo(join(dir, "feature-knowledge.sqlite"));
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const service = createFeatureKnowledgeService({
    repo,
    broadcastService: {
      send: async (message) => {
        broadcasts.push({ channel: message.channel, payload: message.payload });
      },
    },
  });
  const changes: FeatureKnowledgeChanged[] = [];
  const subscription = service.onDynamicFeatureKnowledgeChanged()((change) => changes.push(change));
  return {
    service,
    broadcasts,
    changes,
    async cleanup() {
      subscription.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("提案/提交/拒绝驱动事件与跨窗口广播", async () => {
  const { service, broadcasts, changes, cleanup } = await setup();
  try {
    const proposal = await service.propose({ proposedName: "成本核算", docMd: "doc" });
    assert.equal(changes.at(-1)?.reason, "proposed");
    assert.equal(changes.at(-1)?.proposalId, proposal.id);

    const feature = await service.commitProposal(proposal.id);
    assert.equal(changes.at(-1)?.reason, "committed");
    assert.equal(changes.at(-1)?.featureId, feature.id);

    const rejected = await service.propose({ proposedName: "另一功能", docMd: "doc" });
    await service.rejectProposal(rejected.id);
    assert.equal(changes.at(-1)?.reason, "rejected");

    assert.deepEqual(
      changes.map((change) => change.revision),
      [1, 2, 3, 4],
    );
    assert.ok(broadcasts.every((b) => b.channel === FEATURE_KNOWLEDGE_CHANGED_BROADCAST_CHANNEL));
    assert.equal(broadcasts.length, 4);
  } finally {
    await cleanup();
  }
});

test("readFeature 返回文档 + 版本历史 + 关联；search 标注语义层未启用", async () => {
  const { service, cleanup } = await setup();
  try {
    const base = await service.propose({ proposedName: "库存核算", docMd: "v1" });
    const feature = await service.commitProposal(base.id);
    const update = await service.propose({
      featureId: feature.id,
      docMd: "v2",
      proposedRelations: [],
    });
    await service.commitProposal(update.id);

    const detail = await service.readFeature(feature.id);
    assert.ok(detail);
    assert.equal(detail.feature.docMd, "v2");
    assert.deepEqual(detail.versions.map((version) => version.version), [2, 1]);

    const result = await service.searchFeatures("库存核算");
    assert.equal(result.semanticEnabled, false);
    assert.ok(result.hits.some((hit) => hit.feature.id === feature.id));
    assert.equal(await service.readFeature("missing"), null);
  } finally {
    await cleanup();
  }
});

test("listFeatures / listProposals 按状态过滤", async () => {
  const { service, cleanup } = await setup();
  try {
    const pending = await service.propose({ proposedName: "待确认", docMd: "doc" });
    await service.propose({ proposedName: "已提交", docMd: "doc" }).then((p) => service.commitProposal(p.id));
    const pendingList = await service.listProposals("pending");
    assert.deepEqual(pendingList.map((p) => p.id), [pending.id]);
    const features = await service.listFeatures();
    assert.equal(features.length, 1);
    assert.equal(features[0].name, "已提交");
  } finally {
    await cleanup();
  }
});