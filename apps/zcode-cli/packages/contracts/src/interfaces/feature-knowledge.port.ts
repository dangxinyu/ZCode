// ============================================================
// Feature Knowledge Port - 功能点知识库检索/读取/提案边界
// spec: packages/services/specs/feature-knowledge.md
// 实现在 host 域（desktop host 经反向 RPC 提供）；CLI 侧工具只做透传。
// 所有会话可用（端口在场即启用）；提交/拒绝只在 ZCode UI，不在此端口。
// ============================================================

import type {
  ProposeFeatureUpdateInput,
  ProposeFeatureUpdateOutput,
  ReadFeatureDocInput,
  ReadFeatureDocOutput,
  SearchFeaturesInput,
  SearchFeaturesOutput,
} from "../tools/feature-knowledge.js";

export interface FeatureKnowledgeContext {
  /** 发起工具调用的会话；host 记入提案 source_json 与知识库调用记录（usage）。 */
  sessionId: string;
  /** 工具调用 traceId，全程携带供诊断与提案溯源。 */
  traceId?: string;
  /** search 的 usage 类别标记：自动召回传 recall（host 仅命中记录），缺省按主动检索 search。 */
  usageTool?: "search" | "recall";
}

export interface FeatureKnowledgePort {
  /** 三层并联召回（词面/别名/锚点/向量），返回命中来源层。 */
  searchFeatures(
    input: SearchFeaturesInput,
    context: FeatureKnowledgeContext,
  ): Promise<SearchFeaturesOutput>;
  /** 读取功能点完整活文档 + 关联 + 版本摘要。 */
  readFeatureDoc(
    input: ReadFeatureDocInput,
    context: FeatureKnowledgeContext,
  ): Promise<ReadFeatureDocOutput>;
  /** 提交 merge-on-write 提案（append-only pending）；人闸确认后才生效。 */
  proposeFeatureUpdate(
    input: ProposeFeatureUpdateInput,
    context: FeatureKnowledgeContext,
  ): Promise<ProposeFeatureUpdateOutput>;
}