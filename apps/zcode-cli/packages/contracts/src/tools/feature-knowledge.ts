// ============================================================
// Feature knowledge tools - 功能点知识库检索/读取/提案
// spec: packages/services/specs/feature-knowledge.md
// 所有会话可用（端口在场即启用，非编排专属）。读 = 只读；提案 = append-only
// 落 pending 提案，提交/拒绝只在 ZCode UI 人闸，工具不直接改功能点状态。
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const SEARCH_FEATURES_TOOL_NAME = "SearchFeatures";
export const READ_FEATURE_DOC_TOOL_NAME = "ReadFeatureDoc";
export const PROPOSE_FEATURE_UPDATE_TOOL_NAME = "ProposeFeatureUpdate";

const featureAnchorSchema = z
  .object({
    repo: z.string().optional().describe("Repository name the paths belong to (optional)."),
    paths: z.array(z.string()).describe("Code file paths implementing this feature."),
    symbols: z.array(z.string()).optional().describe("Key function/class symbols (optional)."),
  })
  .strict();
export type FeatureAnchorContract = z.infer<typeof featureAnchorSchema>;

const featureRelationSchema = z
  .object({
    toId: nonEmptyString.describe("id of the related feature (must already exist)."),
    kind: z.enum(["relates", "depends", "affects", "part_of"]),
  })
  .strict();
export type FeatureRelationContract = z.infer<typeof featureRelationSchema>;

const featureSummarySchema = z
  .object({
    id: nonEmptyString,
    name: z.string(),
    domain: z.string(),
    aliases: z.array(z.string()),
    anchors: z.array(featureAnchorSchema),
    currentVersion: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    parentFeatureId: nonEmptyString.nullable().optional(),
  })
  .strict();

export const SearchFeaturesInputSchema = z
  .object({
    query: nonEmptyString.describe(
      "What to look up: a feature name, a business synonym/slang term, or a code file path/symbol. The index recalls by literal text, aliases, and code anchors; try several phrasings if the first misses.",
    ),
    limit: z.number().int().positive().max(50).optional().describe("Max hits (default 20)."),
  })
  .strict();
export type SearchFeaturesInput = z.infer<typeof SearchFeaturesInputSchema>;
export const SearchFeaturesInputJsonSchema = toToolJsonSchema(SearchFeaturesInputSchema);

export const SearchFeaturesOutputSchema = z
  .object({
    hits: z.array(
      z
        .object({
          feature: featureSummarySchema,
          layers: z.array(z.enum(["lexical", "alias", "anchor", "vector"])),
          score: z.number(),
        })
        .strict(),
    ),
    semanticEnabled: z.boolean().describe("False when semantic recall is not configured."),
    message: nonEmptyString,
  })
  .strict();
export type SearchFeaturesOutput = z.infer<typeof SearchFeaturesOutputSchema>;
export const SearchFeaturesOutputJsonSchema = toToolJsonSchema(SearchFeaturesOutputSchema);

export const ReadFeatureDocInputSchema = z
  .object({
    featureId: nonEmptyString.describe("id returned by SearchFeatures."),
  })
  .strict();
export type ReadFeatureDocInput = z.infer<typeof ReadFeatureDocInputSchema>;
export const ReadFeatureDocInputJsonSchema = toToolJsonSchema(ReadFeatureDocInputSchema);

export const ReadFeatureDocOutputSchema = z
  .object({
    found: z.boolean(),
    feature: featureSummarySchema
      .extend({ docMd: z.string(), createdAt: z.number().int().nonnegative() })
      .nullable(),
    relations: z.array(featureRelationSchema),
    versions: z.array(
      z
        .object({
          version: z.number().int().nonnegative(),
          changeSummary: z.string(),
          createdAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    message: nonEmptyString,
  })
  .strict();
export type ReadFeatureDocOutput = z.infer<typeof ReadFeatureDocOutputSchema>;
export const ReadFeatureDocOutputJsonSchema = toToolJsonSchema(ReadFeatureDocOutputSchema);

export const ProposeFeatureUpdateInputSchema = z
  .object({
    featureId: nonEmptyString
      .optional()
      .describe("Existing feature to merge into (from SearchFeatures). Omit to create a new feature."),
    name: z.string().optional().describe("Feature name. Required when creating a new feature."),
    aliases: z
      .array(z.string())
      .optional()
      .describe(
        "Synonyms/slang/English/abbreviations users might search by. REQUIRED practice: deposit how people actually refer to this feature so future searches hit.",
      ),
    domain: z.string().optional().describe("Business domain grouping (e.g. 供应链)."),
    anchors: z.array(featureAnchorSchema).optional().describe("Code paths/symbols implementing it."),
    relations: z.array(featureRelationSchema).optional().describe("Links to existing features."),
    docMd: nonEmptyString.describe(
      "The COMPLETE new living document after a section-scoped rewrite (merge-on-write, not an appended section). Fixed sections: 需求背景 / 业务规则 / 代码位置 / 关键修改决策(含 why) / 坑与注意 / 关联功能点. Read the old doc first; rewrite only sections relevant to this work (dedupe/compress within them) and keep unrelated sections verbatim (wording and order) so the confirm diff shows only relevant hunks. Fidelity fields (code paths, decision rationale, pitfalls) must NOT be lost. Target ~300 lines.",
    ),
    changeSummary: z.string().optional().describe("One-line summary of what this revision changes."),
  })
  .strict();
export type ProposeFeatureUpdateInput = z.infer<typeof ProposeFeatureUpdateInputSchema>;
export const ProposeFeatureUpdateInputJsonSchema = toToolJsonSchema(ProposeFeatureUpdateInputSchema);

export const ProposeFeatureUpdateOutputSchema = z
  .object({
    proposalId: nonEmptyString,
    status: z.enum(["pending", "committed", "rejected"]),
    featureId: nonEmptyString.nullable(),
    message: nonEmptyString,
  })
  .strict();
export type ProposeFeatureUpdateOutput = z.infer<typeof ProposeFeatureUpdateOutputSchema>;
export const ProposeFeatureUpdateOutputJsonSchema = toToolJsonSchema(
  ProposeFeatureUpdateOutputSchema,
);