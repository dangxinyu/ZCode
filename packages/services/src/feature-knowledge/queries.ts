// 功能点知识库读侧：行映射 + 列表/读取/检索（spec: feature-knowledge.md）。
// M1 实现词面倒排（FTS5 trigram）+ 别名 + 代码锚点三层；语义向量层在 M4 并入。
import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, decodeVector } from "./embeddings.js";
import {
  type Feature,
  type FeatureAnchor,
  type FeatureProposal,
  type FeatureRelationInput,
  type FeatureSummary,
  type FeatureVersion,
  type ProposalSource,
  type ProposalStatus,
  type RelationKind,
  type SearchHit,
  type SearchLayer,
  RELATION_KINDS,
} from "./types.js";

interface FeatureRow {
  id: string;
  name: string;
  aliases_json: string;
  domain: string;
  anchors_json: string;
  doc_md: string;
  current_version: number;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toSummary(row: FeatureRow, parentFeatureId: string | null = null): FeatureSummary {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    aliases: parseJson<string[]>(row.aliases_json, []),
    anchors: parseJson<FeatureAnchor[]>(row.anchors_json, []),
    currentVersion: row.current_version,
    updatedAt: row.updated_at,
    parentFeatureId,
  };
}

function parentMap(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare("SELECT from_id, to_id FROM feature_relations WHERE kind='part_of'")
    .all() as Array<{ from_id: string; to_id: string }>;
  return new Map(rows.map((r) => [r.from_id, r.to_id]));
}

export function toFeature(row: FeatureRow, parentFeatureId: string | null = null): Feature {
  return { ...toSummary(row, parentFeatureId), docMd: row.doc_md, createdAt: row.created_at };
}

export function getFeature(db: DatabaseSync, id: string): Feature | null {
  const row = db.prepare("SELECT * FROM features WHERE id=?").get(id) as FeatureRow | undefined;
  if (!row) return null;
  const parent = db
    .prepare("SELECT to_id FROM feature_relations WHERE from_id=? AND kind='part_of' LIMIT 1")
    .get(id) as { to_id: string } | undefined;
  return toFeature(row, parent?.to_id ?? null);
}

export function listFeatures(db: DatabaseSync, domain?: string): FeatureSummary[] {
  const rows = (
    domain
      ? db
          .prepare("SELECT * FROM features WHERE domain=? ORDER BY updated_at DESC")
          .all(domain)
      : db.prepare("SELECT * FROM features ORDER BY updated_at DESC").all()
  ) as unknown as FeatureRow[];
  const parents = parentMap(db);
  return rows.map((row) => toSummary(row, parents.get(row.id) ?? null));
}

export function getVersionHistory(db: DatabaseSync, featureId: string): FeatureVersion[] {
  const rows = db
    .prepare("SELECT * FROM feature_versions WHERE feature_id=? ORDER BY version DESC")
    .all(featureId) as Array<{
    feature_id: string;
    version: number;
    doc_md: string;
    change_summary: string;
    source_json: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    featureId: row.feature_id,
    version: row.version,
    docMd: row.doc_md,
    changeSummary: row.change_summary,
    source: parseJson<ProposalSource>(row.source_json, {}),
    createdAt: row.created_at,
  }));
}

export function listRelations(db: DatabaseSync, featureId: string): FeatureRelationInput[] {
  const rows = db
    .prepare("SELECT to_id, kind FROM feature_relations WHERE from_id=? ORDER BY created_at")
    .all(featureId) as Array<{ to_id: string; kind: RelationKind }>;
  return rows.map((row) => ({ toId: row.to_id, kind: row.kind }));
}

interface ProposalRow {
  id: string;
  feature_id: string | null;
  base_version: number | null;
  proposed_name: string;
  proposed_aliases_json: string;
  proposed_domain: string;
  proposed_anchors_json: string;
  proposed_relations_json: string;
  doc_md: string;
  change_summary: string;
  source_json: string;
  status: ProposalStatus;
  created_at: number;
  resolved_at: number | null;
}

export function toProposal(row: ProposalRow): FeatureProposal {
  return {
    id: row.id,
    featureId: row.feature_id,
    baseVersion: row.base_version,
    proposedName: row.proposed_name,
    proposedAliases: parseJson<string[]>(row.proposed_aliases_json, []),
    proposedDomain: row.proposed_domain,
    proposedAnchors: parseJson<FeatureAnchor[]>(row.proposed_anchors_json, []),
    proposedRelations: parseJson<FeatureRelationInput[]>(row.proposed_relations_json, []).filter(
      (relation) => RELATION_KINDS.includes(relation.kind),
    ),
    docMd: row.doc_md,
    changeSummary: row.change_summary,
    source: parseJson<ProposalSource>(row.source_json, {}),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function getProposal(db: DatabaseSync, id: string): FeatureProposal | null {
  const row = db.prepare("SELECT * FROM feature_proposals WHERE id=?").get(id) as
    | ProposalRow
    | undefined;
  return row ? toProposal(row) : null;
}

export function listProposals(db: DatabaseSync, status?: ProposalStatus): FeatureProposal[] {
  const rows = (
    status
      ? db
          .prepare("SELECT * FROM feature_proposals WHERE status=? ORDER BY created_at DESC")
          .all(status)
      : db.prepare("SELECT * FROM feature_proposals ORDER BY created_at DESC").all()
  ) as unknown as ProposalRow[];
  return rows.map(toProposal);
}

const LAYER_WEIGHT: Record<SearchLayer, number> = {
  lexical: 3,
  alias: 2.5,
  anchor: 2,
  vector: 3,
};

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** 三层并行召回 + 加权融合（向量层 M4 并入）。命中即标层，无静默空结果由服务层兜底。 */
export function searchFeatures(db: DatabaseSync, query: string, limit = 20): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const candidates = new Map<string, { layers: Set<SearchLayer>; score: number }>();
  const add = (id: string, layer: SearchLayer, rank = 0): void => {
    const entry = candidates.get(id) ?? { layers: new Set<SearchLayer>(), score: 0 };
    if (!entry.layers.has(layer)) {
      entry.layers.add(layer);
      entry.score += LAYER_WEIGHT[layer];
    }
    entry.score += rank;
    candidates.set(id, entry);
  };

  // 词面倒排：trigram 需 >=3 字符；更短查询降级 LIKE 兜底。
  if ([...trimmed].length >= 3) {
    const match = `"${trimmed.replace(/"/g, '""')}"`;
    const rows = db
      .prepare(
        "SELECT feature_id, bm25(features_fts) AS rank FROM features_fts WHERE features_fts MATCH ? ORDER BY rank LIMIT 100",
      )
      .all(match) as Array<{ feature_id: string; rank: number }>;
    for (const row of rows) add(row.feature_id, "lexical", 1 / (1 + Math.max(0, row.rank)));
  } else {
    const pattern = likePattern(trimmed);
    const rows = db
      .prepare("SELECT id FROM features WHERE name LIKE ? ESCAPE '\\' OR doc_md LIKE ? ESCAPE '\\'")
      .all(pattern, pattern) as Array<{ id: string }>;
    for (const row of rows) add(row.id, "lexical");
  }

  // 别名层：query 命中别名或名称子串。
  const aliasPattern = likePattern(trimmed);
  const aliasRows = db
    .prepare(
      "SELECT id FROM features WHERE aliases_json LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
    )
    .all(aliasPattern, aliasPattern) as Array<{ id: string }>;
  for (const row of aliasRows) add(row.id, "alias");

  // 代码锚点层：query 命中路径/符号。
  const anchorRows = db
    .prepare("SELECT id FROM features WHERE anchors_json LIKE ? ESCAPE '\\'")
    .all(aliasPattern) as Array<{ id: string }>;
  for (const row of anchorRows) add(row.id, "anchor");

  const hits: SearchHit[] = [];
  for (const [id, entry] of candidates) {
    const row = db.prepare("SELECT * FROM features WHERE id=?").get(id) as FeatureRow | undefined;
    if (!row) continue;
    hits.push({
      feature: toSummary(row),
      layers: [...entry.layers],
      score: entry.score,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.feature.updatedAt - a.feature.updatedAt);
  return hits.slice(0, limit);
}

/**
 * 语义向量层：只认当前版本且同模型的向量（旧版/异模型空间不可比）。
 * 逐块 cosine，按功能点取最大块相似度聚合，top-k。corpus 小，JS 内算。
 */
export function searchVector(
  db: DatabaseSync,
  queryVector: readonly number[],
  model: string,
  limit = 20,
): Array<{ featureId: string; score: number }> {
  if (queryVector.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT e.feature_id AS feature_id, e.vector AS vector
       FROM feature_embeddings e JOIN features f ON f.id = e.feature_id
       WHERE e.version = f.current_version AND e.model = ?`,
    )
    .all(model) as Array<{ feature_id: string; vector: Uint8Array }>;
  const best = new Map<string, number>();
  for (const row of rows) {
    const score = cosineSimilarity(queryVector, decodeVector(row.vector));
    const previous = best.get(row.feature_id);
    if (previous === undefined || score > previous) best.set(row.feature_id, score);
  }
  return [...best.entries()]
    .map(([featureId, score]) => ({ featureId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 待补 embed 的功能点：有正文但缺当前版本 + 当前模型的向量（提交失败/启动/换模型）。 */
export function listFeaturesNeedingEmbed(db: DatabaseSync, model: string): Feature[] {
  const rows = db
    .prepare(
      `SELECT f.* FROM features f
       WHERE f.current_version > 0 AND f.doc_md <> ''
         AND NOT EXISTS (
           SELECT 1 FROM feature_embeddings e
           WHERE e.feature_id = f.id AND e.version = f.current_version AND e.model = ?
         )
       ORDER BY f.updated_at DESC`,
    )
    .all(model) as unknown as FeatureRow[];
  return rows.map((row) => toFeature(row));
}