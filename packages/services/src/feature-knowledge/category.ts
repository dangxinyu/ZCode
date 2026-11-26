// 功能分类骨架与按名挂父（spec: feature-knowledge.md 三层归属 / parentName）。
// 自 repo 抽出以守 max-lines；createFeatureCategory 与 commit 按名挂父共用同一骨架来源。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FeatureKnowledgeError, KB_ERROR_CODES } from "./types.js";

const CATEGORY_SKELETON_DOC = `## 需求背景\n\n## 业务规则\n\n## 代码位置\n\n## 关键修改决策（含 why）\n\n## 坑与注意\n\n## 关联功能点\n`;

// 事务内建功能分类骨架（空固定结构 + v1 + FTS）。
export function insertCategorySkeletonSync(
  db: DatabaseSync,
  name: string,
  domain: string,
  now: number,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO features (id, name, aliases_json, domain, anchors_json, doc_md, current_version, created_at, updated_at)
     VALUES(?,?,?,?,?,?,1,?,?)`,
  ).run(id, name, "[]", domain, "[]", CATEGORY_SKELETON_DOC, now, now);
  db.prepare(
    `INSERT INTO feature_versions (feature_id, version, doc_md, change_summary, source_json, created_at)
     VALUES(?,1,?,?,?,?)`,
  ).run(id, CATEGORY_SKELETON_DOC, "新建大分类父文档骨架", JSON.stringify({ origin: "session" }), now);
  db.prepare("INSERT INTO features_fts (feature_id, name, aliases, doc_md) VALUES(?,?,?,?)").run(
    id,
    name,
    "",
    CATEGORY_SKELETON_DOC,
  );
  return id;
}

// 按名在同域找功能分类父；缺则建骨架。同批新建父尚未提交无 id，故用名而非 toId 挂父。
export function resolveCategoryParentSync(
  db: DatabaseSync,
  parentName: string,
  domain: string,
  childId: string,
  now: number,
): string {
  const trimmed = parentName.trim();
  const row = db
    .prepare("SELECT id FROM features WHERE name=? AND domain=? LIMIT 1")
    .get(trimmed, domain) as { id: string } | undefined;
  const parentId = row?.id ?? insertCategorySkeletonSync(db, trimmed, domain, now);
  if (parentId === childId) {
    throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "不能以自身为父文档");
  }
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === childId) {
      throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "层级成环");
    }
    const ancestor = db
      .prepare("SELECT to_id FROM feature_relations WHERE from_id=? AND kind='part_of' LIMIT 1")
      .get(cursor) as { to_id: string } | undefined;
    cursor = ancestor?.to_id ?? null;
  }
  return parentId;
}