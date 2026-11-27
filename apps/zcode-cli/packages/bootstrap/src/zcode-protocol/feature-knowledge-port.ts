import {
  type FeatureKnowledgePort,
  type ProposeFeatureUpdateOutput,
  type ReadFeatureDocOutput,
  type SearchFeaturesOutput,
} from "@zcode/contracts";
import {
  zcodeFeatureKnowledgeSearchParamsSchema,
  zcodeFeatureKnowledgeSearchResultSchema,
  zcodeFeatureKnowledgeReadParamsSchema,
  zcodeFeatureKnowledgeReadResultSchema,
  zcodeFeatureKnowledgeProposeParamsSchema,
  zcodeFeatureKnowledgeProposeResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 功能点知识库端口（spec: packages/services/specs/feature-knowledge.md）。
 * CLI 侧工具只透传；检索/读取/提案落库由 host 域经 featureKnowledge/* 反向请求执行。
 * 端口对 taskType 不做判断——core 的 includeFeatureKnowledge 门（端口在场）是唯一曝光面，
 * 所有会话可用。提交/拒绝不在端口内（仅 ZCode UI 人闸）。
 */
export function createProtocolFeatureKnowledgePort(
  context: ZCodeProtocolAgentServerContext,
): FeatureKnowledgePort {
  return {
    async searchFeatures(input, taskContext): Promise<SearchFeaturesOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.featureKnowledgeSearch,
        zcodeFeatureKnowledgeSearchParamsSchema.parse({
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          // usage 记录（spec）：透传会话 id；自动召回标记 recall，host 仅命中记录。
          sessionId: taskContext.sessionId,
          ...(taskContext.usageTool ? { tool: taskContext.usageTool } : {}),
        }),
        zcodeFeatureKnowledgeSearchResultSchema,
      );
      return {
        hits: result.hits,
        semanticEnabled: result.semanticEnabled,
        message:
          result.hits.length > 0
            ? `Found ${result.hits.length} feature point(s). Read the full document with ReadFeatureDoc before merging or rewriting.${result.semanticEnabled ? "" : " Semantic recall is not configured; lexical/alias/anchor layers are active."}`
            : "No feature point matched. Try another phrasing, a synonym, or a code path; if none exists, propose a new feature.",
      };
    },
    async readFeatureDoc(input, taskContext): Promise<ReadFeatureDocOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.featureKnowledgeRead,
        zcodeFeatureKnowledgeReadParamsSchema.parse({
          featureId: input.featureId,
          sessionId: taskContext.sessionId,
        }),
        zcodeFeatureKnowledgeReadResultSchema,
      );
      return {
        found: result.feature !== null,
        feature: result.feature,
        relations: result.relations,
        versions: result.versions.map((version) => ({
          version: version.version,
          changeSummary: version.changeSummary,
          createdAt: version.createdAt,
        })),
        message: result.feature
          ? `Feature "${result.feature.name}" (version ${result.feature.currentVersion}). On update rewrite only the sections relevant to this work and keep unrelated sections verbatim (wording and order); preserve code paths, decision rationale, and pitfalls.`
          : "Feature point not found.",
      };
    },
    async proposeFeatureUpdate(input, taskContext): Promise<ProposeFeatureUpdateOutput> {
      const result = await context.requestClient(
        zcodeProtocolMethods.featureKnowledgePropose,
        zcodeFeatureKnowledgeProposeParamsSchema.parse({
          sessionId: taskContext.sessionId,
          ...(taskContext.traceId ? { traceId: taskContext.traceId } : {}),
          ...(input.featureId ? { featureId: input.featureId } : {}),
          ...(input.name !== undefined ? { proposedName: input.name } : {}),
          ...(input.aliases !== undefined ? { proposedAliases: input.aliases } : {}),
          ...(input.domain !== undefined ? { proposedDomain: input.domain } : {}),
          ...(input.anchors !== undefined ? { proposedAnchors: input.anchors } : {}),
          ...(input.relations !== undefined ? { proposedRelations: input.relations } : {}),
          ...(input.parentName !== undefined ? { proposedParentName: input.parentName } : {}),
          docMd: input.docMd,
          ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
        }),
        zcodeFeatureKnowledgeProposeResultSchema,
      );
      return {
        proposalId: result.proposalId,
        status: result.status,
        featureId: result.featureId,
        message:
          "Proposal queued as pending. The feature point is NOT updated yet — a human must confirm it in the ZCode UI. Tell the user a confirmation is pending.",
      };
    },
  };
}