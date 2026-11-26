// 提案 append-only 插入的纯函数（spec: feature-knowledge.md 提案队列多生产者）。
// host repo 与对外 MCP server 共用同一份校验 + INSERT，保证提案写入语义单一来源。
// 调用方负责连接生命周期与事务边界（host 单写链 / MCP BEGIN IMMEDIATE + busy_timeout）。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getFeature, getProposal } from "./queries.js";
import {
  FeatureKnowledgeError,
  KB_ERROR_CODES,
  type FeatureProposal,
  type ProposeInput,
} from "./types.js";

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 校验实体归属后插入一条 pending 提案；不触碰 features/versions/relations（确认前零副作用）。 */
export function insertProposal(db: DatabaseSync, input: ProposeInput): FeatureProposal {
  const docMd = input.docMd?.trim();
  if (!docMd) {
    throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "提案文档不能为空");
  }
  let baseVersion: number | null = null;
  if (input.featureId) {
    const existing = getFeature(db, input.featureId);
    if (!existing) {
      throw new FeatureKnowledgeError(KB_ERROR_CODES.featureNotFound, "目标功能点不存在");
    }
    baseVersion = existing.currentVersion;
  } else if (!input.proposedName?.trim()) {
    throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "新功能点必须提供名称");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO feature_proposals
      (id, feature_id, base_version, proposed_name, proposed_aliases_json, proposed_domain,
       proposed_anchors_json, proposed_relations_json, proposed_parent_name, doc_md, change_summary, source_json,
       status, created_at, resolved_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,NULL)`,
  ).run(
    id,
    input.featureId ?? null,
    baseVersion,
    input.proposedName?.trim() ?? "",
    JSON.stringify(dedupe(input.proposedAliases ?? [])),
    input.proposedDomain?.trim() ?? "",
    JSON.stringify(input.proposedAnchors ?? []),
    JSON.stringify(input.proposedRelations ?? []),
    input.proposedParentName?.trim() ?? "",
    docMd,
    input.changeSummary?.trim() ?? "",
    JSON.stringify(input.source ?? {}),
    Date.now(),
  );
  return getProposal(db, id)!;
}