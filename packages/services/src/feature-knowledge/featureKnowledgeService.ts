// 功能点知识库服务工厂（spec: feature-knowledge.md）：repo 之上的 UI 服务面。
// 唯一写入者身份在 repo 提交事务；本层负责 ensureReady、变更广播、语义召回装配与降级。
import { Emitter } from "@zcode/rpc";
import { FEATURE_KNOWLEDGE_CHANGED_BROADCAST_CHANNEL } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { FeatureKnowledgeRepo } from "./featureKnowledgeRepo.js";
import { chunkDocument, fuseByRrf, type RankedCandidate } from "./embeddings.js";
import { readFeatureDocThemePlan, scanFeatureDocs } from "./docScan.js";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FeatureDetail,
  FeatureEmbedder,
  FeatureKnowledgeChanged,
  FeatureKnowledgeSearchResult,
  FeatureQueryExpander,
  IFeatureKnowledgeService,
} from "./featureKnowledge.js";
import type {
  Feature,
  FeatureDocScanResult,
  FeatureDocThemePlan,
  FeatureKbUsage,
  FeatureProposal,
  FeatureSummary,
  KbUsageContext,
  KbUsageTool,
  ProposeInput,
  ProposalStatus,
  SearchHit,
} from "./types.js";

const logger = createServiceLogger("feature-knowledge");
const MAX_QUERY_VARIANTS = 4;
const MAX_PENDING_REINDEX = 50;

export function createFeatureKnowledgeService(options: {
  repo: FeatureKnowledgeRepo;
  broadcastService?: Pick<IBroadcastService, "send">;
  embedder?: FeatureEmbedder;
  expandQuery?: FeatureQueryExpander;
}): IFeatureKnowledgeService {
  const { repo, broadcastService, embedder, expandQuery } = options;
  const emitter = new Emitter<FeatureKnowledgeChanged>();
  let revision = 0;
  let reindexStartedForModel: string | null = null;

  const bump = (
    reason: FeatureKnowledgeChanged["reason"],
    featureId?: string,
    proposalId?: string,
  ): void => {
    revision += 1;
    const change: FeatureKnowledgeChanged = { revision, reason, featureId, proposalId };
    emitter.fire(change);
    // 跨窗口刷新：其他窗口的知识库页/角标靠广播 bump，与本窗口 RPC 事件同源串号。
    void broadcastService
      ?.send({ channel: FEATURE_KNOWLEDGE_CHANGED_BROADCAST_CHANNEL, payload: change })
      .catch((error) => {
        logger.warn("Feature knowledge broadcast failed", {
          event: "feature-knowledge.broadcast.failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  // 提交后异步重建向量：失败不阻塞提交，缺当前版本向量即待重试（启动/下次提交补）。
  const reindexFeature = async (feature: Feature): Promise<void> => {
    if (!embedder) return;
    const chunks = chunkDocument(feature.docMd);
    if (chunks.length === 0) return;
    try {
      const workspaceKey = repo.getVersionHistory(feature.id)[0]?.source.workspaceKey;
      const result = await embedder({ texts: chunks, workspaceKey });
      if (!result || result.vectors.length !== chunks.length) {
        logger.warn("Feature embedding unavailable; marked for retry", {
          event: "feature-knowledge.embed.pending",
          featureId: feature.id,
        });
        return;
      }
      await repo.replaceEmbeddings(
        feature.id,
        feature.currentVersion,
        result.model,
        chunks.map((chunkText, index) => ({ chunkText, vector: result.vectors[index]! })),
      );
      void ensurePendingReindexed(result.model);
    } catch (error) {
      logger.warn("Feature embedding failed; marked for retry", {
        event: "feature-knowledge.embed.failed",
        featureId: feature.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // 启动/换模型后补 embed：已知模型时一次性补齐缺当前版本向量的功能点（有界、串行）。
  const ensurePendingReindexed = async (model: string): Promise<void> => {
    if (!embedder || reindexStartedForModel === model) return;
    reindexStartedForModel = model;
    try {
      const pending = repo.listFeaturesNeedingEmbed(model).slice(0, MAX_PENDING_REINDEX);
      for (const feature of pending) await reindexFeature(feature);
    } catch (error) {
      logger.warn("Pending embedding refresh failed", {
        event: "feature-knowledge.embed.refresh-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // usage best-effort（spec）：sessionId 在场才记录；写失败仅 warn，不阻断主流程、不发广播。
  const recordUsage = (tool: KbUsageTool, context?: KbUsageContext): void => {
    const sessionId = context?.sessionId?.trim();
    if (!sessionId) return;
    void repo
      .recordUsage({ sessionId, workspaceKey: context?.workspaceKey, tool })
      .catch((error) => {
        logger.warn("KB usage record failed", {
          event: "feature-knowledge.usage.failed",
          tool,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const searchWithVector = async (query: string): Promise<FeatureKnowledgeSearchResult> => {
    const baseHits = repo.searchFeatures(query);
    if (!embedder) return { hits: baseHits, semanticEnabled: false };

    let variants = [query];
    if (expandQuery) {
      try {
        const expanded = await expandQuery(query);
        variants = [...new Set([query, ...expanded])].slice(0, MAX_QUERY_VARIANTS);
      } catch {
        /* 扩展失败降级为原 query，词汇桥/语义层仍尽力召回。 */
      }
    }

    let embedded: Awaited<ReturnType<FeatureEmbedder>> = null;
    try {
      embedded = await embedder({ texts: variants });
    } catch (error) {
      logger.warn("Query embedding failed; degrading to lexical layers", {
        event: "feature-knowledge.embed.query-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!embedded || embedded.vectors.length === 0) {
      return { hits: baseHits, semanticEnabled: true };
    }

    // 多组检索词向量各取 top-k，按功能点取最大相似度合并成一路向量排名。
    const vectorBest = new Map<string, number>();
    for (const vector of embedded.vectors) {
      for (const hit of repo.searchVector(vector, embedded.model)) {
        const previous = vectorBest.get(hit.featureId);
        if (previous === undefined || hit.score > previous) {
          vectorBest.set(hit.featureId, hit.score);
        }
      }
    }
    const vectorRanked = [...vectorBest.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([featureId]) => ({ id: featureId, layers: ["vector" as const] }));

    const baseRanked: RankedCandidate[] = baseHits.map((hit) => ({
      id: hit.feature.id,
      layers: hit.layers,
    }));
    const fused = fuseByRrf([baseRanked, vectorRanked]);

    const summaryById = new Map<string, FeatureSummary>(
      baseHits.map((hit) => [hit.feature.id, hit.feature]),
    );
    const hits: SearchHit[] = [];
    for (const candidate of fused) {
      const feature = summaryById.get(candidate.id) ?? repo.getFeature(candidate.id);
      if (!feature) continue;
      hits.push({ feature, layers: candidate.layers, score: candidate.score });
      if (hits.length >= 20) break;
    }
    void ensurePendingReindexed(embedded.model);
    return { hits, semanticEnabled: true };
  };

  return {
    async listFeatures(domain?: string): Promise<FeatureSummary[]> {
      await repo.ensureReady();
      return repo.listFeatures(domain);
    },
    async searchFeatures(query: string, context?: KbUsageContext): Promise<FeatureKnowledgeSearchResult> {
      await repo.ensureReady();
      const result = await searchWithVector(query);
      // 自动召回仅命中记录（spec：未命中不记，避免每轮空召回刷屏）；主动检索始终记录。
      const tool: KbUsageTool = context?.tool === "recall" ? "recall" : "search";
      if (tool !== "recall" || result.hits.length > 0) recordUsage(tool, context);
      return result;
    },
    async scanFeatureDocs(paths: readonly string[]): Promise<FeatureDocScanResult> {
      await repo.ensureReady();
      return scanFeatureDocs(paths, (query, limit) => repo.searchFeatures(query, limit));
    },
    async readDocThemePlan(path: string): Promise<FeatureDocThemePlan | null> {
      return readFeatureDocThemePlan(path);
    },
    async setFeatureParent(featureId: string, parentFeatureId: string | null): Promise<Feature> {
      const feature = await repo.setFeatureParent(featureId, parentFeatureId);
      bump("committed", feature.id, undefined);
      return feature;
    },
    async createFeatureCategory(name: string, domain: string): Promise<Feature> {
      const feature = await repo.createFeatureCategory(name, domain);
      bump("committed", feature.id, undefined);
      void reindexFeature(feature);
      return feature;
    },
    async deleteFeature(id: string): Promise<void> {
      await repo.deleteFeature(id);
      bump("deleted", id, undefined);
    },
    async ensureDocAnalysisWorkspace(): Promise<{ workspacePath: string }> {
      const workspacePath = join(homedir(), "zcode-kb");
      await mkdir(workspacePath, { recursive: true });
      return { workspacePath };
    },
    async readFeature(id: string, context?: KbUsageContext): Promise<FeatureDetail | null> {
      await repo.ensureReady();
      const feature = repo.getFeature(id);
      if (!feature) return null;
      recordUsage("read", context);
      return {
        feature,
        versions: repo.getVersionHistory(id),
        relations: repo.listRelations(id),
      };
    },
    async listProposals(status?: ProposalStatus): Promise<FeatureProposal[]> {
      await repo.ensureReady();
      return repo.listProposals(status);
    },
    async getProposal(id: string): Promise<FeatureProposal | null> {
      await repo.ensureReady();
      return repo.getProposal(id);
    },
    async listUsage(sessionIds: readonly string[]): Promise<FeatureKbUsage[]> {
      await repo.ensureReady();
      return repo.listUsage(sessionIds);
    },
    async propose(input: ProposeInput): Promise<FeatureProposal> {
      const proposal = await repo.propose(input);
      recordUsage("propose", {
        sessionId: input.source?.sessionId,
        workspaceKey: input.source?.workspaceKey,
      });
      bump("proposed", proposal.featureId ?? undefined, proposal.id);
      return proposal;
    },
    async commitProposal(id: string, acceptedSections?: readonly string[]): Promise<Feature> {
      const feature = await repo.commitProposal(id, acceptedSections);
      bump("committed", feature.id, id);
      void reindexFeature(feature);
      return feature;
    },
    async rejectProposal(id: string): Promise<FeatureProposal> {
      const proposal = await repo.rejectProposal(id);
      bump("rejected", proposal.featureId ?? undefined, proposal.id);
      return proposal;
    },
    onDynamicFeatureKnowledgeChanged() {
      return emitter.event;
    },
  };
}