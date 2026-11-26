// 末级功能点删除（spec: feature-knowledge.md 末级右键删除）。
// 自 repo 抽出以守 max-lines；库级事务原子删除投影/账本/关系/索引/向量。
// 提案队列 append-only 不随删：指向已删功能点的 pending 提案提交时按 featureNotFound 拒绝。
import type { DatabaseSync } from "node:sqlite";
import { getFeature } from "./queries.js";
import { FeatureKnowledgeError, KB_ERROR_CODES } from "./types.js";

/** 事务内删除功能点及其全部派生行；有 part_of 子文档的父拒绝删除（UI 末级门禁的 host 兜底）。 */
export function deleteFeatureSync(db: DatabaseSync, id: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const feature = getFeature(db, id);
    if (!feature) {
      throw new FeatureKnowledgeError(KB_ERROR_CODES.featureNotFound, "功能点不存在");
    }
    const child = db
      .prepare("SELECT from_id FROM feature_relations WHERE to_id=? AND kind='part_of' LIMIT 1")
      .get(id) as { from_id: string } | undefined;
    if (child) {
      throw new FeatureKnowledgeError(
        KB_ERROR_CODES.invalidInput,
        "该文档还有子文档，请先处理子文档再删除",
      );
    }
    db.prepare("DELETE FROM feature_embeddings WHERE feature_id=?").run(id);
    db.prepare("DELETE FROM features_fts WHERE feature_id=?").run(id);
    db.prepare("DELETE FROM feature_relations WHERE from_id=? OR to_id=?").run(id, id);
    db.prepare("DELETE FROM feature_versions WHERE feature_id=?").run(id);
    db.prepare("DELETE FROM features WHERE id=?").run(id);
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