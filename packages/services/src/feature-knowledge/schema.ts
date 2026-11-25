// 功能点知识库独立库 schema 与迁移（spec: feature-knowledge.md）。
// 自有账本从 0001 起，与 tasks-index 完全隔离（避免安装版撞号）。
// 冻结历史语义：已应用迁移的 checksumInput 不可改，新增能力追加新编号。
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const FEATURE_KNOWLEDGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    domain TEXT NOT NULL DEFAULT '',
    anchors_json TEXT NOT NULL DEFAULT '[]',
    doc_md TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feature_versions (
    feature_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    doc_md TEXT NOT NULL,
    change_summary TEXT NOT NULL DEFAULT '',
    source_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, version)
  );
  CREATE TABLE IF NOT EXISTS feature_relations (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('relates','depends','affects')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_feature_relations_to ON feature_relations(to_id);
  CREATE TABLE IF NOT EXISTS feature_proposals (
    id TEXT PRIMARY KEY,
    feature_id TEXT,
    base_version INTEGER,
    proposed_name TEXT NOT NULL DEFAULT '',
    proposed_aliases_json TEXT NOT NULL DEFAULT '[]',
    proposed_domain TEXT NOT NULL DEFAULT '',
    proposed_anchors_json TEXT NOT NULL DEFAULT '[]',
    proposed_relations_json TEXT NOT NULL DEFAULT '[]',
    doc_md TEXT NOT NULL,
    change_summary TEXT NOT NULL DEFAULT '',
    source_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feature_proposals_status
    ON feature_proposals(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS feature_embeddings (
    feature_id TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    vector BLOB NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, chunk_idx)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS features_fts USING fts5(
    feature_id UNINDEXED, name, aliases, doc_md, tokenize='trigram'
  );
`;

// 0002：向量行记录所属文档版本。检索只认当前版本的向量，避免旧版语义污染；
// 缺当前版本向量即「待重试」，提交或启动时补 embed（spec 检索降级语义）。
const FEATURE_EMBEDDINGS_VERSION_SQL = `
  ALTER TABLE feature_embeddings ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
`;

// 0003：part_of 层级关系（大分类父文档 → 子主题文档）。CHECK 约束无法 ALTER，重建表保留数据。
const FEATURE_RELATIONS_PART_OF_SQL = `
  CREATE TABLE feature_relations_new (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('relates','depends','affects','part_of')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  INSERT INTO feature_relations_new SELECT from_id, to_id, kind, created_at FROM feature_relations;
  DROP TABLE feature_relations;
  ALTER TABLE feature_relations_new RENAME TO feature_relations;
  CREATE INDEX IF NOT EXISTS idx_feature_relations_to ON feature_relations(to_id);
`;

const definitions = [
  {
    id: "0001_feature_knowledge_init",
    checksumInput: [FEATURE_KNOWLEDGE_SCHEMA_SQL],
    sql: FEATURE_KNOWLEDGE_SCHEMA_SQL,
  },
  {
    id: "0002_feature_embeddings_version",
    checksumInput: [FEATURE_EMBEDDINGS_VERSION_SQL],
    sql: FEATURE_EMBEDDINGS_VERSION_SQL,
  },
  {
    id: "0003_feature_relations_part_of",
    checksumInput: [FEATURE_RELATIONS_PART_OF_SQL],
    sql: FEATURE_RELATIONS_PART_OF_SQL,
  },
] as const;

function checksumOf(input: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** 库级串行事务内按冻结账本逐项确认；checksum 不符抛错交调用方关闭连接恢复。 */
export function runFeatureKnowledgeMigrations(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS feature_knowledge_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    for (const migration of definitions) {
      const checksum = checksumOf(migration.checksumInput);
      const applied = db
        .prepare("SELECT checksum FROM feature_knowledge_schema_migration WHERE id=?")
        .get(migration.id) as { checksum: string } | undefined;
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(`Feature knowledge migration checksum mismatch: ${migration.id}`);
        }
        continue;
      }
      db.exec(migration.sql);
      db.prepare("INSERT INTO feature_knowledge_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 调用方关闭连接恢复。 */
    }
    throw error;
  }
}