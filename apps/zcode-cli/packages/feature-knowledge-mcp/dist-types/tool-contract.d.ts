import { z } from "zod";
export declare const FEATURE_KNOWLEDGE_SERVER_NAME = "feature_knowledge";
export declare const FEATURE_KNOWLEDGE_SERVER_VERSION = "0.1.0";
export declare const FEATURE_KNOWLEDGE_SERVER_INSTRUCTIONS: string;
export declare const searchFeaturesInputSchema: z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const readFeatureInputSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strict>;
export declare const proposeFeatureUpdateInputSchema: z.ZodObject<{
    featureId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    proposedName: z.ZodOptional<z.ZodString>;
    proposedAliases: z.ZodOptional<z.ZodArray<z.ZodString>>;
    proposedDomain: z.ZodOptional<z.ZodString>;
    proposedAnchors: z.ZodOptional<z.ZodArray<z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        paths: z.ZodArray<z.ZodString>;
        symbols: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    proposedRelations: z.ZodOptional<z.ZodArray<z.ZodObject<{
        toId: z.ZodString;
        kind: z.ZodEnum<{
            relates: "relates";
            depends: "depends";
            affects: "affects";
        }>;
    }, z.core.$strip>>>;
    docMd: z.ZodString;
    changeSummary: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const getProposalStatusInputSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strict>;
export declare const TOOL_DESCRIPTIONS: {
    readonly search_features: "检索功能点（词面倒排 + 别名 + 代码锚点并联召回）。query 可为业务词、同义词或代码路径；返回候选 id/name/domain/摘要/命中层。";
    readonly read_feature: "按 id 读功能点完整活文档（需求背景/业务规则/代码位置/关键修改决策/坑与注意/关联功能点）+ 版本历史 + 关联。";
    readonly propose_feature_update: "提交功能点合并提案（append-only，pending）。带 featureId 合并到已有功能点，缺省则新建（须 proposedName）。docMd 为整篇重写后的新文档。需人在 ZCode 确认后生效。";
    readonly get_proposal_status: "按提案 id 轮询状态（pending/committed/rejected）。外部工具据此判断提案是否已被人确认。";
};
//# sourceMappingURL=tool-contract.d.ts.map