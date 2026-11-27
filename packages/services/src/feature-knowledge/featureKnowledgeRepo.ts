// 功能点知识库 repo：独立全局库的唯一写入者（spec: feature-knowledge.md）。
// 单库单写链串行；commit 是库级事务（features/versions/relations/FTS/proposal 原子推进）。
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mergeFeatureDocSections } from "@zcode/shared";
import { getFeatureKnowledgeDatabasePath } from "#src/paths.js";
import { runFeatureKnowledgeMigrations } from "./schema.js";
import { insertProposal } from "./propose.js";
import { deleteFeatureSync } from "./deletion.js";
import { insertCategorySkeletonSync, resolveCategoryParentSync } from "./category.js";
import { encodeVector } from "./embeddings.js";
import { insertKbUsage, listKbUsage } from "./usage.js";
import {
  getFeature,
  getProposal,
  getVersionHistory,
  listFeatures,
  listFeaturesNeedingEmbed,
  listProposals,
  listRelations,
  searchFeatures,
  searchVector,
} from "./queries.js";
import {
  FeatureKnowledgeError,
  KB_ERROR_CODES,
  type Feature,
  type FeatureKbUsage,
  type FeatureProposal,
  type FeatureRelationInput,
  type FeatureSummary,
  type FeatureVersion,
  type KbUsageTool,
  type ProposeInput,
  type ProposalStatus,
  type SearchHit,
} from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export class FeatureKnowledgeRepo {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getFeatureKnowledgeDatabasePath();
    if (this.dbPath && this.dbPath !== path) this.close();
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore close errors */
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChain = Promise.resolve();
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    runFeatureKnowledgeMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) throw new FeatureKnowledgeError(KB_ERROR_CODES.notReady, "知识库尚未初始化");
    return this.db;
  }

  private enqueueWrite<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.writeChain.catch(() => undefined).then(operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---- 读侧（调用方先 ensureReady）----
  getFeature(id: string): Feature | null {
    return getFeature(this.getDatabase(), id);
  }
  listFeatures(domain?: string): FeatureSummary[] {
    return listFeatures(this.getDatabase(), domain);
  }
  getVersionHistory(featureId: string): FeatureVersion[] {
    return getVersionHistory(this.getDatabase(), featureId);
  }
  listRelations(featureId: string): FeatureRelationInput[] {
    return listRelations(this.getDatabase(), featureId);
  }
  getProposal(id: string): FeatureProposal | null {
    return getProposal(this.getDatabase(), id);
  }
  listProposals(status?: ProposalStatus): FeatureProposal[] {
    return listProposals(this.getDatabase(), status);
  }
  searchFeatures(query: string, limit?: number): SearchHit[] {
    return searchFeatures(this.getDatabase(), query, limit);
  }
  searchVector(
    queryVector: readonly number[],
    model: string,
    limit?: number,
  ): Array<{ featureId: string; score: number }> {
    return searchVector(this.getDatabase(), queryVector, model, limit);
  }
  listFeaturesNeedingEmbed(model: string): Feature[] {
    return listFeaturesNeedingEmbed(this.getDatabase(), model);
  }
  /** 知识库调用记录读侧：按会话 id 集合返回 usage 行（会话信息侧栏聚合数据源）。 */
  listUsage(sessionIds: readonly string[]): FeatureKbUsage[] {
    return listKbUsage(this.getDatabase(), sessionIds);
  }

  // ---- 写侧（单写链串行）----
  /** 知识库调用记录（spec usage）：append-only，走单写链，不改功能点状态。 */
  async recordUsage(input: {
    sessionId: string;
    workspaceKey?: string;
    tool: KbUsageTool;
  }): Promise<void> {
    await this.ensureReady();
    await this.enqueueWrite(() => insertKbUsage(this.getDatabase(), input));
  }

  async propose(input: ProposeInput): Promise<FeatureProposal> {
    await this.ensureReady();
    return this.enqueueWrite(() => this.proposeSync(input));
  }

  private proposeSync(input: ProposeInput): FeatureProposal {
    return insertProposal(this.getDatabase(), input);
  }

  async rejectProposal(id: string): Promise<FeatureProposal> {
    await this.ensureReady();
    return this.enqueueWrite(() => {
      const db = this.getDatabase();
      const proposal = getProposal(db, id);
      if (!proposal) {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.proposalNotFound, "提案不存在");
      }
      if (proposal.status !== "pending") {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.proposalResolved, "提案已处理");
      }
      db.prepare("UPDATE feature_proposals SET status='rejected', resolved_at=? WHERE id=?").run(
        Date.now(),
        id,
      );
      return getProposal(db, id)!;
    });
  }

  async commitProposal(id: string, acceptedSections?: readonly string[]): Promise<Feature> {
    await this.ensureReady();
    return this.enqueueWrite(() => this.commitSync(id, acceptedSections));
  }

  private commitSync(id: string, acceptedSections?: readonly string[]): Feature {
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = getProposal(db, id);
      if (!proposal) {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.proposalNotFound, "提案不存在");
      }
      if (proposal.status !== "pending") {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.proposalResolved, "提案已处理");
      }
      const now = Date.now();
      const existing = proposal.featureId ? getFeature(db, proposal.featureId) : null;
      if (proposal.featureId && !existing) {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.featureNotFound, "目标功能点不存在");
      }
      if (existing && proposal.baseVersion !== existing.currentVersion) {
        throw new FeatureKnowledgeError(
          KB_ERROR_CODES.baseVersionConflict,
          "功能点已被其他提案更新，请基于最新版重新提炼",
        );
      }
      const featureId = existing?.id ?? randomUUID();
      const name = proposal.proposedName || existing?.name || "";
      if (!name) {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "功能点名称不能为空");
      }
      const aliases = dedupe([...(existing?.aliases ?? []), ...proposal.proposedAliases]);
      const domain = proposal.proposedDomain || existing?.domain || "";
      const anchors =
        proposal.proposedAnchors.length > 0 ? proposal.proposedAnchors : (existing?.anchors ?? []);
      const version = (existing?.currentVersion ?? 0) + 1;
      // 章节级部分接受：以当前文档为底只替换勾选章节；缺省整份提交（与提案字节一致）。
      const docMd =
        acceptedSections && existing
          ? mergeFeatureDocSections(existing.docMd, proposal.docMd, acceptedSections)
          : proposal.docMd;

      for (const relation of proposal.proposedRelations) {
        if (!getFeature(db, relation.toId)) {
          throw new FeatureKnowledgeError(
            KB_ERROR_CODES.relationTargetMissing,
            `关联目标功能点不存在：${relation.toId}`,
          );
        }
      }

      db.prepare(
        `INSERT INTO feature_versions
          (feature_id, version, doc_md, change_summary, source_json, created_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(featureId, version, docMd, proposal.changeSummary, JSON.stringify(proposal.source), now);

      db.prepare(
        `INSERT INTO features
          (id, name, aliases_json, domain, anchors_json, doc_md, current_version, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, aliases_json=excluded.aliases_json, domain=excluded.domain,
          anchors_json=excluded.anchors_json, doc_md=excluded.doc_md,
          current_version=excluded.current_version, updated_at=excluded.updated_at`,
      ).run(
        featureId,
        name,
        JSON.stringify(aliases),
        domain,
        JSON.stringify(anchors),
        docMd,
        version,
        existing?.createdAt ?? now,
        now,
      );

      for (const relation of proposal.proposedRelations) {
        db.prepare(
          "INSERT OR IGNORE INTO feature_relations (from_id, to_id, kind, created_at) VALUES(?,?,?,?)",
        ).run(featureId, relation.toId, relation.kind, now);
      }

      // 按名挂功能分类父（同批新建父无 id 时的三层归属落地）；替换旧 part_of，保证单父。
      if (proposal.proposedParentName.trim()) {
        const parentId = resolveCategoryParentSync(
          db,
          proposal.proposedParentName,
          domain,
          featureId,
          now,
        );
        db.prepare("DELETE FROM feature_relations WHERE from_id=? AND kind='part_of'").run(featureId);
        db.prepare(
          "INSERT OR IGNORE INTO feature_relations (from_id, to_id, kind, created_at) VALUES(?,?, 'part_of', ?)",
        ).run(featureId, parentId, now);
      }

      db.prepare("DELETE FROM features_fts WHERE feature_id=?").run(featureId);
      db.prepare(
        "INSERT INTO features_fts (feature_id, name, aliases, doc_md) VALUES(?,?,?,?)",
      ).run(featureId, name, aliases.join(" "), docMd);

      db.prepare("UPDATE feature_proposals SET status='committed', resolved_at=? WHERE id=?").run(
        now,
        id,
      );
      db.exec("COMMIT");
      return getFeature(db, featureId)!;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 调用方关闭连接恢复。 */
      }
      throw error;
    }
  }

  /** 重建某功能点当前版本的全部分块向量（异步 embed 成功后调用）；库级事务原子替换。 */
  async setFeatureParent(featureId: string, parentFeatureId: string | null): Promise<Feature> {
    await this.ensureReady();
    return this.enqueueWrite(() => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const feature = getFeature(db, featureId);
        if (!feature) {
          throw new FeatureKnowledgeError(KB_ERROR_CODES.featureNotFound, "功能点不存在");
        }
        if (parentFeatureId) {
          if (parentFeatureId === featureId) {
            throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "不能以自身为父文档");
          }
          if (!getFeature(db, parentFeatureId)) {
            throw new FeatureKnowledgeError(KB_ERROR_CODES.featureNotFound, "父功能点不存在");
          }
          // 环检测：父的祖先链不能包含自己。
          let cursor: string | null = parentFeatureId;
          while (cursor) {
            if (cursor === featureId) {
              throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "层级成环");
            }
            const row = db
              .prepare("SELECT to_id FROM feature_relations WHERE from_id=? AND kind='part_of' LIMIT 1")
              .get(cursor) as { to_id: string } | undefined;
            cursor = row?.to_id ?? null;
          }
        }
        db.prepare("DELETE FROM feature_relations WHERE from_id=? AND kind='part_of'").run(featureId);
        if (parentFeatureId) {
          db.prepare(
            "INSERT INTO feature_relations (from_id, to_id, kind, created_at) VALUES(?,?, 'part_of', ?)",
          ).run(featureId, parentFeatureId, Date.now());
        }
        db.exec("COMMIT");
        return getFeature(db, featureId)!;
      } catch (error) {
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } catch {
          /* 调用方关闭连接恢复 */
        }
        throw error;
      }
    });
  }

  async createFeatureCategory(name: string, domain: string): Promise<Feature> {
    await this.ensureReady();
    return this.enqueueWrite(() => {
      const db = this.getDatabase();
      const trimmed = name.trim();
      if (!trimmed) {
        throw new FeatureKnowledgeError(KB_ERROR_CODES.invalidInput, "名称不能为空");
      }
      const id = insertCategorySkeletonSync(db, trimmed, domain.trim(), Date.now());
      return getFeature(db, id)!;
    });
  }

  /** 末级功能点删除（UI 人闸 + 二次确认）；库级事务，拒绝删有子文档的父。 */
  async deleteFeature(id: string): Promise<void> {
    await this.ensureReady();
    await this.enqueueWrite(() => deleteFeatureSync(this.getDatabase(), id));
  }

  async replaceEmbeddings(
    featureId: string,
    version: number,
    model: string,
    chunks: ReadonlyArray<{ chunkText: string; vector: readonly number[] }>,
  ): Promise<void> {
    await this.ensureReady();
    await this.enqueueWrite(() => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM feature_embeddings WHERE feature_id=?").run(featureId);
        const insert = db.prepare(
          `INSERT INTO feature_embeddings
            (feature_id, chunk_idx, chunk_text, vector, model, created_at, version)
           VALUES(?,?,?,?,?,?,?)`,
        );
        const now = Date.now();
        chunks.forEach((chunk, index) => {
          insert.run(
            featureId,
            index,
            chunk.chunkText,
            encodeVector(chunk.vector),
            model,
            now,
            version,
          );
        });
        db.exec("COMMIT");
      } catch (error) {
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } catch {
          /* 调用方关闭连接恢复。 */
        }
        throw error;
      }
    });
  }
}