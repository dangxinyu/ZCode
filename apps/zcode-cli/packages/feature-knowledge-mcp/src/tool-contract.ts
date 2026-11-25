// 对外 MCP 工具契约（spec: feature-knowledge.md「对外 MCP server」）。
// 四个工具：search_features / read_feature / propose_feature_update / get_proposal_status。
// zod 为单一输入真相，inputSchema 由 z.toJSONSchema 派生；不暴露 commit/reject。
import { z } from "zod";

export const FEATURE_KNOWLEDGE_SERVER_NAME = "feature_knowledge";
export const FEATURE_KNOWLEDGE_SERVER_VERSION = "0.1.0";
export const FEATURE_KNOWLEDGE_SERVER_INSTRUCTIONS =
  "功能点知识库（活文档）外部接口。search_features 按关键词/别名/代码路径检索功能点；" +
  "read_feature 读完整活文档与版本/关联；propose_feature_update 提交合并提案（append-only，需人在 ZCode 确认）；" +
  "get_proposal_status 轮询提案是否 committed/rejected。提交与拒绝只在 ZCode UI 完成，本服务不暴露。";

const anchorSchema = z.object({
  repo: z.string().optional(),
  paths: z.array(z.string()),
  symbols: z.array(z.string()).optional(),
});

const relationSchema = z.object({
  toId: z.string().min(1),
  kind: z.enum(["relates", "depends", "affects", "part_of"]),
});

export const searchFeaturesInputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const readFeatureInputSchema = z.object({ id: z.string().min(1) }).strict();

export const proposeFeatureUpdateInputSchema = z
  .object({
    featureId: z.string().min(1).nullable().optional(),
    proposedName: z.string().optional(),
    proposedAliases: z.array(z.string()).optional(),
    proposedDomain: z.string().optional(),
    proposedAnchors: z.array(anchorSchema).optional(),
    proposedRelations: z.array(relationSchema).optional(),
    docMd: z.string().min(1),
    changeSummary: z.string().optional(),
  })
  .strict();

export const getProposalStatusInputSchema = z.object({ id: z.string().min(1) }).strict();

export const TOOL_DESCRIPTIONS = {
  search_features:
    "检索功能点（词面倒排 + 别名 + 代码锚点并联召回）。query 可为业务词、同义词或代码路径；返回候选 id/name/domain/摘要/命中层。",
  read_feature:
    "按 id 读功能点完整活文档（需求背景/业务规则/代码位置/关键修改决策/坑与注意/关联功能点）+ 版本历史 + 关联。",
  propose_feature_update:
    "提交功能点合并提案（append-only，pending）。带 featureId 合并到已有功能点，缺省则新建（须 proposedName）。docMd 为段落级重写后的完整新文档：只改与本次工作相关的章节，无关章节逐字保留。需人在 ZCode 确认后生效。",
  get_proposal_status:
    "按提案 id 轮询状态（pending/committed/rejected）。外部工具据此判断提案是否已被人确认。",
} as const;