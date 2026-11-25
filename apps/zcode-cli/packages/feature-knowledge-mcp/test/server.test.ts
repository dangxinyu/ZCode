// 对外 MCP 契约测试（spec: feature-knowledge.md 测试与验证「MCP server 契约测试」）。
// 四工具输入输出、ro 直读、提案 append-only、错误形态；commit/reject 不暴露。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INVALID_PARAMS } from "@modelcontextprotocol/server";
import { FeatureKnowledgeRepo, KB_ERROR_CODES } from "@zcode/services/feature-knowledge";
import { callFeatureKnowledgeTool, type ToolCallResult } from "../src/server.js";
import { FeatureKnowledgeMcpStore } from "../src/store.js";

const DOC = "# 库存成本核算\n\n## 需求背景\n核算存货成本。\n\n## 代码位置\nsrc/cost/calc.ts\n";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fkb-mcp-"));
  const dbPath = join(dir, "feature-knowledge.sqlite");
  const repo = new FeatureKnowledgeRepo(dbPath);
  await repo.ensureReady();
  const proposal = await repo.propose({
    proposedName: "库存成本核算",
    proposedAliases: ["存货计价", "存货成本"],
    proposedDomain: "供应链",
    proposedAnchors: [{ paths: ["src/cost/calc.ts"] }],
    docMd: DOC,
    changeSummary: "init",
  });
  const feature = await repo.commitProposal(proposal.id);
  const store = new FeatureKnowledgeMcpStore(dbPath);
  return {
    dir,
    dbPath,
    repo,
    store,
    feature,
    async cleanup() {
      store.close();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function payload(result: ToolCallResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("search_features：词面 / 别名 / 代码锚点各自命中并标层", async () => {
  const { store, feature, cleanup } = await setup();
  try {
    const lexical = payload(callFeatureKnowledgeTool(store, "search_features", { query: "库存成本核算" }));
    const lexicalHits = lexical.hits as Array<{ feature: { id: string }; layers: string[] }>;
    assert.ok(lexicalHits.some((hit) => hit.feature.id === feature.id && hit.layers.includes("lexical")));

    const alias = payload(callFeatureKnowledgeTool(store, "search_features", { query: "存货计价" }));
    const aliasHits = alias.hits as Array<{ feature: { id: string }; layers: string[] }>;
    assert.ok(aliasHits.some((hit) => hit.feature.id === feature.id && hit.layers.includes("alias")));

    const anchor = payload(callFeatureKnowledgeTool(store, "search_features", { query: "src/cost/calc.ts" }));
    const anchorHits = anchor.hits as Array<{ feature: { id: string }; layers: string[] }>;
    assert.ok(anchorHits.some((hit) => hit.feature.id === feature.id && hit.layers.includes("anchor")));
    assert.equal(lexical.semanticEnabled, false);
  } finally {
    await cleanup();
  }
});

test("read_feature：返回完整活文档 + 版本历史", async () => {
  const { store, feature, cleanup } = await setup();
  try {
    const result = payload(callFeatureKnowledgeTool(store, "read_feature", { id: feature.id }));
    const readFeature = result.feature as { docMd: string; name: string };
    assert.equal(readFeature.docMd, DOC.trim());
    assert.equal(readFeature.name, "库存成本核算");
    assert.equal((result.versions as unknown[]).length, 1);
  } finally {
    await cleanup();
  }
});

test("read_feature：不存在 → featureNotFound 错误结果", async () => {
  const { store, cleanup } = await setup();
  try {
    const result = callFeatureKnowledgeTool(store, "read_feature", { id: "missing" });
    assert.equal(result.isError, true);
    assert.equal((payload(result).error as { code: string }).code, KB_ERROR_CODES.featureNotFound);
  } finally {
    await cleanup();
  }
});

test("propose_feature_update：合并提案 append-only，确认前功能点零变化", async () => {
  const { store, repo, feature, cleanup } = await setup();
  try {
    const result = payload(
      callFeatureKnowledgeTool(store, "propose_feature_update", {
        featureId: feature.id,
        docMd: "# 库存成本核算（重写）\n新内容",
        changeSummary: "rewrite",
        proposedAliases: ["库存计价"],
      }),
    );
    assert.equal(result.status, "pending");
    assert.equal(result.featureId, feature.id);
    assert.equal(result.baseVersion, 1);
    const pending = repo.listProposals("pending");
    assert.ok(pending.some((proposal) => proposal.id === result.proposalId));
    assert.equal(repo.getFeature(feature.id)?.currentVersion, 1);
  } finally {
    await cleanup();
  }
});

test("propose_feature_update：新建（无 featureId）须 proposedName", async () => {
  const { store, cleanup } = await setup();
  try {
    const ok = payload(
      callFeatureKnowledgeTool(store, "propose_feature_update", {
        proposedName: "新功能点",
        docMd: "# 新功能点\n正文",
      }),
    );
    assert.equal(ok.status, "pending");
    assert.equal(ok.featureId, null);

    const bad = callFeatureKnowledgeTool(store, "propose_feature_update", { docMd: "无名称" });
    assert.equal(bad.isError, true);
    assert.equal((payload(bad).error as { code: string }).code, KB_ERROR_CODES.invalidInput);
  } finally {
    await cleanup();
  }
});

test("propose_feature_update：目标功能点不存在 → featureNotFound", async () => {
  const { store, cleanup } = await setup();
  try {
    const result = callFeatureKnowledgeTool(store, "propose_feature_update", {
      featureId: "missing",
      docMd: "正文",
    });
    assert.equal(result.isError, true);
    assert.equal((payload(result).error as { code: string }).code, KB_ERROR_CODES.featureNotFound);
  } finally {
    await cleanup();
  }
});

test("get_proposal_status：pending → 人确认 → committed", async () => {
  const { store, repo, feature, cleanup } = await setup();
  try {
    const proposed = payload(
      callFeatureKnowledgeTool(store, "propose_feature_update", {
        featureId: feature.id,
        docMd: "重写正文",
      }),
    );
    const proposalId = proposed.proposalId as string;
    const before = payload(callFeatureKnowledgeTool(store, "get_proposal_status", { id: proposalId }));
    assert.equal(before.status, "pending");

    await repo.commitProposal(proposalId);
    const after = payload(callFeatureKnowledgeTool(store, "get_proposal_status", { id: proposalId }));
    assert.equal(after.status, "committed");
  } finally {
    await cleanup();
  }
});

test("get_proposal_status：不存在 → proposalNotFound", async () => {
  const { store, cleanup } = await setup();
  try {
    const result = callFeatureKnowledgeTool(store, "get_proposal_status", { id: "missing" });
    assert.equal(result.isError, true);
    assert.equal((payload(result).error as { code: string }).code, KB_ERROR_CODES.proposalNotFound);
  } finally {
    await cleanup();
  }
});

test("库不存在 → notReady，且不静默建空库", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fkb-mcp-missing-"));
  const dbPath = join(dir, "absent.sqlite");
  const store = new FeatureKnowledgeMcpStore(dbPath);
  try {
    const result = callFeatureKnowledgeTool(store, "search_features", { query: " anything" });
    assert.equal(result.isError, true);
    assert.equal((payload(result).error as { code: string }).code, KB_ERROR_CODES.notReady);
    assert.equal(existsSync(dbPath), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("输入校验：缺 query → INVALID_PARAMS", async () => {
  const { store, cleanup } = await setup();
  try {
    assert.throws(
      () => callFeatureKnowledgeTool(store, "search_features", {}),
      (error: unknown) => (error as { code?: unknown }).code === INVALID_PARAMS,
    );
  } finally {
    await cleanup();
  }
});

test("commit/reject 不暴露：未知工具 → INVALID_PARAMS，store 无写侧方法", async () => {
  const { store, cleanup } = await setup();
  try {
    assert.throws(
      () => callFeatureKnowledgeTool(store, "commit_proposal", { id: "x" }),
      (error: unknown) => (error as { code?: unknown }).code === INVALID_PARAMS,
    );
    assert.equal((store as unknown as Record<string, unknown>).commitProposal, undefined);
    assert.equal((store as unknown as Record<string, unknown>).rejectProposal, undefined);
  } finally {
    await cleanup();
  }
});

test("host 关闭后 ro 仍可读（WAL  checkpoint 后直读主库）", async () => {
  const { store, repo, feature, cleanup } = await setup();
  try {
    repo.close();
    const result = payload(callFeatureKnowledgeTool(store, "read_feature", { id: feature.id }));
    assert.equal((result.feature as { id: string }).id, feature.id);
  } finally {
    await cleanup();
  }
});