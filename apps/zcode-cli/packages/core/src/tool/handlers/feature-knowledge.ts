// ============================================================
// Feature Knowledge Tool Handlers
// spec: packages/services/specs/feature-knowledge.md
// handler 刻意薄：解析输入 → 断言端口在场 → 透传 featureKnowledgePort。
// 注册门（runtime-tools includeFeatureKnowledge）按端口在场启用，所有会话可用；
// 提案只落 pending 行，提交/拒绝的人闸在 ZCode UI，工具不直接改功能点状态。
// ============================================================

import {
  CoreErrorType,
  SEARCH_FEATURES_TOOL_NAME,
  READ_FEATURE_DOC_TOOL_NAME,
  PROPOSE_FEATURE_UPDATE_TOOL_NAME,
  SearchFeaturesInputJsonSchema,
  SearchFeaturesInputSchema,
  SearchFeaturesOutputJsonSchema,
  SearchFeaturesOutputSchema,
  ReadFeatureDocInputJsonSchema,
  ReadFeatureDocInputSchema,
  ReadFeatureDocOutputJsonSchema,
  ReadFeatureDocOutputSchema,
  ProposeFeatureUpdateInputJsonSchema,
  ProposeFeatureUpdateInputSchema,
  ProposeFeatureUpdateOutputJsonSchema,
  ProposeFeatureUpdateOutputSchema,
  createCoreError,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const FEATURE_KNOWLEDGE_TIMEOUT_MS = 30_000;
const FEATURE_KNOWLEDGE_MODEL_BYTES = 32_000;

type FeatureKnowledgeToolName =
  | typeof SEARCH_FEATURES_TOOL_NAME
  | typeof READ_FEATURE_DOC_TOOL_NAME
  | typeof PROPOSE_FEATURE_UPDATE_TOOL_NAME;

function assertFeatureKnowledgePort(
  context: ToolExecutionContext,
  toolName: FeatureKnowledgeToolName,
): asserts context is ToolExecutionContext & {
  featureKnowledgePort: NonNullable<ToolExecutionContext["featureKnowledgePort"]>;
} {
  if (context.featureKnowledgePort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `FeatureKnowledgePort is not configured for ${toolName}`,
    {
      context: { toolCallId: context.toolCallId, toolName },
      recoverable: false,
    },
  );
}

const searchFeaturesHandler: ToolHandler = async (input, context) => {
  const parsed = SearchFeaturesInputSchema.parse(input);
  assertFeatureKnowledgePort(context, SEARCH_FEATURES_TOOL_NAME);
  return context.featureKnowledgePort.searchFeatures(parsed, {
    sessionId: context.sessionId,
    traceId: context.traceId,
  });
};

const readFeatureDocHandler: ToolHandler = async (input, context) => {
  const parsed = ReadFeatureDocInputSchema.parse(input);
  assertFeatureKnowledgePort(context, READ_FEATURE_DOC_TOOL_NAME);
  return context.featureKnowledgePort.readFeatureDoc(parsed, {
    sessionId: context.sessionId,
    traceId: context.traceId,
  });
};

const proposeFeatureUpdateHandler: ToolHandler = async (input, context) => {
  const parsed = ProposeFeatureUpdateInputSchema.parse(input);
  assertFeatureKnowledgePort(context, PROPOSE_FEATURE_UPDATE_TOOL_NAME);
  return context.featureKnowledgePort.proposeFeatureUpdate(parsed, {
    sessionId: context.sessionId,
    traceId: context.traceId,
  });
};

function featureKnowledgePermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: needsApproval ? "medium" : "low",
    sideEffectScope: needsApproval ? "system" : "none",
    needsApproval,
    patternSources: ["toolName"],
    ...(needsApproval ? {} : { alwaysAllowPatternSources: ["toolName"] as const }),
    denyPriority: "beforeAsk",
  };
}

const featureKnowledgeResultBudget = {
  maxInlineBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
  maxModelBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
    direction: "head" as const,
  },
};

const featureKnowledgeTimeout = {
  defaultMs: FEATURE_KNOWLEDGE_TIMEOUT_MS,
  maxMs: FEATURE_KNOWLEDGE_TIMEOUT_MS,
  allowCallOverride: false,
};

export const searchFeaturesToolEntry: ToolEntry = {
  capability: "Search the feature knowledge base by name, synonym, or code path",
  metadata: {
    name: SEARCH_FEATURES_TOOL_NAME,
    description:
      "Search the feature knowledge base for living documents about feature points. Recall runs over literal text, deposited aliases (synonyms/slang/English), and code anchors (paths/symbols) in parallel; any layer hitting returns the feature. STANDING RULE: before analyzing a requirement, bug, or review, call this first to locate the owning feature point; also use it BEFORE distilling knowledge to find whether a feature point already exists.",
    modelInstructions: [
      "Proactive recall: when the user asks you to analyze/investigate/fix anything, search this knowledge base first (even if an auto-recall reminder is present, re-search with your own refined terms when the reminder looks off-target).",
      "Try the user's actual phrasing first; if it misses, retry with synonyms, the English term, or a code file path you hold. Code-path reverse lookup is a first-class search.",
      "Each hit reports which layer matched (lexical/alias/anchor/vector). semanticEnabled=false means semantic recall is not configured — lexical+alias+anchor still work.",
      "Read the full document with ReadFeatureDoc before deciding to merge into an existing feature or create a new one.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: FEATURE_KNOWLEDGE_TIMEOUT_MS,
    maxOutputBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: searchFeaturesHandler,
  inputSchema: SearchFeaturesInputJsonSchema,
  outputSchema: SearchFeaturesOutputJsonSchema,
  runtimeInputSchema: SearchFeaturesInputSchema,
  runtimeOutputSchema: SearchFeaturesOutputSchema,
  permission: featureKnowledgePermission(
    "featureKnowledge.read",
    "SearchFeatures only reads the feature knowledge base",
    false,
  ),
  resultBudget: featureKnowledgeResultBudget,
  timeout: featureKnowledgeTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SearchFeatures was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const readFeatureDocToolEntry: ToolEntry = {
  capability: "Read a feature point's full living document, relations, and version history",
  metadata: {
    name: READ_FEATURE_DOC_TOOL_NAME,
    description:
      "Read the complete living document of a feature point (by id from SearchFeatures), plus its relations and version summaries. The document is the single current truth; older versions are retained for rollback only.",
    modelInstructions: [
      "Read the old document fully before rewriting: merge-on-write is section-scoped — rewrite only the sections relevant to this work (dedupe/compress within them), keep unrelated sections verbatim, never append a new section.",
      "Preserve fidelity fields when rewriting: code paths, decision rationale (why), and pitfalls must not be lost.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: FEATURE_KNOWLEDGE_TIMEOUT_MS,
    maxOutputBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: readFeatureDocHandler,
  inputSchema: ReadFeatureDocInputJsonSchema,
  outputSchema: ReadFeatureDocOutputJsonSchema,
  runtimeInputSchema: ReadFeatureDocInputSchema,
  runtimeOutputSchema: ReadFeatureDocOutputSchema,
  permission: featureKnowledgePermission(
    "featureKnowledge.read",
    "ReadFeatureDoc only reads a feature point's document",
    false,
  ),
  resultBudget: featureKnowledgeResultBudget,
  timeout: featureKnowledgeTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ReadFeatureDoc was cancelled before the document was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const proposeFeatureUpdateToolEntry: ToolEntry = {
  capability: "Propose a merge-on-write revision of a feature point's living document",
  metadata: {
    name: PROPOSE_FEATURE_UPDATE_TOOL_NAME,
    description:
      "Submit a proposal to create or revise a feature point's living document. This ONLY queues a pending proposal — the feature point itself does not change until a human confirms in the ZCode UI. Produce the COMPLETE new document via section-scoped rewrite (merge-on-write): edit only sections relevant to this work, keep unrelated sections verbatim, deposit aliases so future searches hit, and keep code anchors/relations current.",
    modelInstructions: [
      "Workflow: SearchFeatures to find the entity → ReadFeatureDoc to read the old document → decide merge-into-existing (pass featureId) or create-new (pass name) → rewrite only the relevant sections → call this tool with the full resulting document.",
      "Section-scoped rewrite, do not append: edit only sections touched by this work; keep unrelated sections verbatim (wording and order), no global reorganize, so the confirm diff shows only relevant hunks. Within touched sections dedupe/compress. Fixed sections: 需求背景 / 业务规则 / 代码位置 / 关键修改决策(含 why) / 坑与注意 / 关联功能点. Target ~300 lines.",
      "Fidelity fields (code paths, decision rationale, pitfalls) must survive the rewrite; only repetition and stale detail inside touched sections may be dropped. Stale content in untouched sections: mention it in change_summary, do not edit it.",
      "Always deposit aliases: synonyms, business slang, English names, abbreviations, colloquial terms users might search by.",
      "Hierarchy: prefer merging into the parent feature (category living doc); only create/merge a child feature for an independently searchable subtopic, and add relations {toId: parentId, kind: \"part_of\"}.",
      "If the host reports a base-version conflict, the feature was updated by another proposal — re-read the latest document and propose again on the new base; do not force.",
      "After proposing, tell the user a confirmation is pending in ZCode; do not claim the knowledge base is already updated.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: FEATURE_KNOWLEDGE_TIMEOUT_MS,
    maxOutputBytes: FEATURE_KNOWLEDGE_MODEL_BYTES,
    // 提案写 host 全局知识库（非 workspace 文件）；人闸在 UI 确认，工具本身低风险管理。
    sideEffectScope: "system",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: proposeFeatureUpdateHandler,
  inputSchema: ProposeFeatureUpdateInputJsonSchema,
  outputSchema: ProposeFeatureUpdateOutputJsonSchema,
  runtimeInputSchema: ProposeFeatureUpdateInputSchema,
  runtimeOutputSchema: ProposeFeatureUpdateOutputSchema,
  permission: featureKnowledgePermission(
    "featureKnowledge.propose",
    "ProposeFeatureUpdate queues a pending knowledge proposal; a human confirms it in the ZCode UI",
    false,
  ),
  resultBudget: featureKnowledgeResultBudget,
  timeout: featureKnowledgeTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProposeFeatureUpdate was cancelled before the proposal was queued",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};