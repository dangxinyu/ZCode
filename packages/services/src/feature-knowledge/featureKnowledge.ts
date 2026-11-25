// 功能点知识库 host 服务面（spec: packages/services/specs/feature-knowledge.md）。
// renderer 经 ProxyChannel 直连（OffPeakTask 同款范式）；commit/reject 仅 UI 人闸，
// CLI 反向 RPC 只读 + propose，不进本服务面的写路径。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  Feature,
  FeatureDocScanResult,
  FeatureDocThemePlan,
  FeatureProposal,
  FeatureRelationInput,
  FeatureSummary,
  FeatureVersion,
  ProposeInput,
  ProposalStatus,
  SearchHit,
} from "./types.js";

export interface FeatureKnowledgeChanged {
  revision: number;
  reason: "proposed" | "committed" | "rejected";
  featureId?: string;
  proposalId?: string;
}

export interface FeatureDetail {
  feature: Feature;
  versions: FeatureVersion[];
  relations: FeatureRelationInput[];
}

export interface FeatureKnowledgeSearchResult {
  hits: SearchHit[];
  /** 语义向量层是否启用（未配 embedding 时 false，UI 明示降级，不静默假装满足）。 */
  semanticEnabled: boolean;
}

/** 一次性 embedding 通道结果（host 经 CLI provider runtime 调 /embeddings）。 */
export interface FeatureEmbedTextResult {
  vectors: number[][];
  model: string;
}

/**
 * 语义召回依赖（host 注入，非 RPC 面）：未提供 → 降级词面+词汇桥层。
 * 返回 null 表示本次不可用（未配置/调用失败），服务层据此降级且不阻塞。
 */
export type FeatureEmbedder = (input: {
  texts: string[];
  workspaceKey?: string;
}) => Promise<FeatureEmbedTextResult | null>;

/** 查询扩展（词汇桥层 UI 侧）：把口语翻成多组检索词；未提供则只用原 query。 */
export type FeatureQueryExpander = (query: string, workspaceKey?: string) => Promise<string[]>;

export interface IFeatureKnowledgeService {
  listFeatures(domain?: string): Promise<FeatureSummary[]>;
  searchFeatures(query: string): Promise<FeatureKnowledgeSearchResult>;
  /** 文档来源提炼扫描阶段：目录展开 + 标题/开头行 + 候选归属（>20 份供清单勾选）。 */
  scanFeatureDocs(paths: readonly string[]): Promise<FeatureDocScanResult>;
  /** 读侦察子智能体落盘的主题计划（主题↔文档↔功能点多对多）；未产出返回 null。 */
  readDocThemePlan(path: string): Promise<FeatureDocThemePlan | null>;
  /** 文档分析专用工作区 ~/zcode-kb（用户指定 2026-11-25）：不存在则创建，session 建在这里。 */
  ensureDocAnalysisWorkspace(): Promise<{ workspacePath: string }>;
  /** 手动层级管理（用户确认 2026-11-25）：设置/清除 part_of 父文档；元数据变更不走提案闸。 */
  setFeatureParent(featureId: string, parentFeatureId: string | null): Promise<Feature>;
  /** 新建大分类父文档骨架（空活文档固定结构），供挂子主题。 */
  createFeatureCategory(name: string, domain: string): Promise<Feature>;
  readFeature(id: string): Promise<FeatureDetail | null>;
  listProposals(status?: ProposalStatus): Promise<FeatureProposal[]>;
  getProposal(id: string): Promise<FeatureProposal | null>;
  propose(input: ProposeInput): Promise<FeatureProposal>;
  /** acceptedSections 缺省整份提交；提供时以当前文档为底只替换勾选章节（章节级部分接受）。 */
  commitProposal(id: string, acceptedSections?: readonly string[]): Promise<Feature>;
  rejectProposal(id: string): Promise<FeatureProposal>;
  /** ProxyChannel onDynamic* 约定：RPC 自动识别为动态事件，bump 串号驱动 UI 重查。 */
  onDynamicFeatureKnowledgeChanged(): Event<FeatureKnowledgeChanged>;
}

export const IFeatureKnowledgeService = createServiceDescriptor<IFeatureKnowledgeService>(
  ServiceChannels.FeatureKnowledge,
);