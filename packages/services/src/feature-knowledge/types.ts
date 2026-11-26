// 功能点知识库领域类型（spec: packages/services/specs/feature-knowledge.md）。
// repo 层用纯 TS 接口；跨进程/工具边界的 zod 校验在协议与服务层另行声明。

export const RELATION_KINDS = ["relates", "depends", "affects", "part_of"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const PROPOSAL_STATUSES = ["pending", "committed", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 检索命中来源层（spec 检索分层）：词面倒排 / 别名 / 代码锚点 / 语义向量。 */
export const SEARCH_LAYERS = ["lexical", "alias", "anchor", "vector"] as const;
export type SearchLayer = (typeof SEARCH_LAYERS)[number];

/** 活文档保真字段（重写契约不可丢失）：代码路径、关键决策依据、坑与注意。 */
export const FIDELITY_SECTIONS = ["代码位置", "关键修改决策", "坑与注意"] as const;

/** 活文档固定结构（重写模板）。 */
export const DOC_SECTIONS = [
  "需求背景",
  "业务规则",
  "代码位置",
  "关键修改决策",
  "坑与注意",
  "关联功能点",
] as const;

export interface FeatureAnchor {
  repo?: string;
  paths: string[];
  symbols?: string[];
}

export interface FeatureRelationInput {
  toId: string;
  kind: RelationKind;
}

export interface ProposalSource {
  sessionId?: string;
  taskId?: string;
  workspaceKey?: string;
  traceId?: string;
  origin?: "session" | "mcp";
}

export interface Feature {
  id: string;
  name: string;
  aliases: string[];
  domain: string;
  anchors: FeatureAnchor[];
  docMd: string;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  parentFeatureId?: string | null;
}

export interface FeatureSummary {
  id: string;
  name: string;
  domain: string;
  aliases: string[];
  anchors: FeatureAnchor[];
  currentVersion: number;
  updatedAt: number;
  /** part_of 层级：所属父功能点（大分类整篇活文档）；无父=顶层。 */
  parentFeatureId?: string | null;
}

export interface FeatureVersion {
  featureId: string;
  version: number;
  docMd: string;
  changeSummary: string;
  source: ProposalSource;
  createdAt: number;
}

export interface FeatureProposal {
  id: string;
  featureId: string | null;
  baseVersion: number | null;
  proposedName: string;
  proposedAliases: string[];
  proposedDomain: string;
  proposedAnchors: FeatureAnchor[];
  proposedRelations: FeatureRelationInput[];
  /** 功能分类父按名指定（同批新建父尚未提交、无 id 时用）；提交时按名找父，缺则建骨架。 */
  proposedParentName: string;
  docMd: string;
  changeSummary: string;
  source: ProposalSource;
  status: ProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ProposeInput {
  featureId?: string | null;
  proposedName?: string;
  proposedAliases?: string[];
  proposedDomain?: string;
  proposedAnchors?: FeatureAnchor[];
  proposedRelations?: FeatureRelationInput[];
  proposedParentName?: string;
  docMd: string;
  changeSummary?: string;
  source?: ProposalSource;
}

export interface SearchHit {
  feature: FeatureSummary;
  layers: SearchLayer[];
  score: number;
}

/** 稳定错误码（不依赖错误文本做流程判断）。 */
export const KB_ERROR_CODES = {
  notReady: "kb_not_ready",
  proposalNotFound: "kb_proposal_not_found",
  proposalResolved: "kb_proposal_resolved",
  featureNotFound: "kb_feature_not_found",
  baseVersionConflict: "kb_base_version_conflict",
  relationTargetMissing: "kb_relation_target_missing",
  invalidInput: "kb_invalid_input",
} as const;
export type KbErrorCode = (typeof KB_ERROR_CODES)[keyof typeof KB_ERROR_CODES];

export class FeatureKnowledgeError extends Error {
  constructor(
    public readonly code: KbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeatureKnowledgeError";
  }
}
export type {
  FeatureDocScanEntry,
  FeatureDocScanResult,
  FeatureDocTheme,
  FeatureDocThemePlan,
} from "./docScan.js";
