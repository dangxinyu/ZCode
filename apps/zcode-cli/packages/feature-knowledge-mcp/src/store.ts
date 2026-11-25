// 对外 MCP 的数据访问（spec: feature-knowledge.md「对外 MCP」）。
// 读 = ro 连接直读 SQLite；提案 = 独立 rw 连接 append-only 插入（BEGIN IMMEDIATE + busy_timeout）。
// 库不存在 → 明确错误，绝不静默建空库；不暴露 commit/reject（人闸只在 ZCode UI）。
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  FeatureKnowledgeError,
  KB_ERROR_CODES,
  getFeature,
  getFeatureKnowledgeDatabasePath,
  getProposal,
  getVersionHistory,
  insertProposal,
  listRelations,
  searchFeatures,
  type Feature,
  type FeatureProposal,
  type FeatureRelationInput,
  type FeatureVersion,
  type ProposeInput,
  type ProposalStatus,
  type SearchHit,
} from "@zcode/services/feature-knowledge";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const BUSY_TIMEOUT_MS = 5000;

export interface FeatureReadResult {
  feature: Feature;
  versions: FeatureVersion[];
  relations: FeatureRelationInput[];
}

export interface ProposalStatusResult {
  id: string;
  status: ProposalStatus;
  featureId: string | null;
  proposedName: string;
  baseVersion: number | null;
  resolvedAt: number | null;
}

export class FeatureKnowledgeMcpStore {
  private readDb: DatabaseSyncInstance | null = null;

  constructor(private readonly dbPath: string = getFeatureKnowledgeDatabasePath()) {}

  private assertExists(): void {
    if (!existsSync(this.dbPath)) {
      throw new FeatureKnowledgeError(
        KB_ERROR_CODES.notReady,
        `功能点知识库不存在（${this.dbPath}）。请先启动 ZCode 初始化知识库后再使用外部 MCP。`,
      );
    }
  }

  private reader(): DatabaseSyncInstance {
    this.assertExists();
    if (!this.readDb) {
      this.readDb = new DatabaseSync(this.dbPath, { readOnly: true });
      this.readDb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    return this.readDb;
  }

  search(query: string, limit?: number): SearchHit[] {
    return searchFeatures(this.reader(), query, limit);
  }

  read(id: string): FeatureReadResult | null {
    const db = this.reader();
    const feature = getFeature(db, id);
    if (!feature) return null;
    return { feature, versions: getVersionHistory(db, id), relations: listRelations(db, id) };
  }

  proposalStatus(id: string): ProposalStatusResult | null {
    const proposal = getProposal(this.reader(), id);
    if (!proposal) return null;
    return {
      id: proposal.id,
      status: proposal.status,
      featureId: proposal.featureId,
      proposedName: proposal.proposedName,
      baseVersion: proposal.baseVersion,
      resolvedAt: proposal.resolvedAt,
    };
  }

  propose(input: ProposeInput): FeatureProposal {
    this.assertExists();
    const db = new DatabaseSync(this.dbPath);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const proposal = insertProposal(db, input);
        db.exec("COMMIT");
        return proposal;
      } catch (error) {
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } catch {
          /* 关闭连接恢复。 */
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  close(): void {
    try {
      this.readDb?.close();
    } catch {
      /* ignore close errors */
    }
    this.readDb = null;
  }
}