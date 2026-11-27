// 知识库调用记录（spec usage）：append-only 写入 + 按会话集合查询。
// 唯一写入者是 host 服务（工具链路携带 sessionId 时记录）；MCP ro 直读与 UI 搜索框不记。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FeatureKbUsage, KbUsageTool } from "./types.js";

/** 单次查询会话 id 上限（协议 listUsage 同口径）：父会话 + 子会话集合有界。 */
export const MAX_USAGE_SESSION_IDS = 64;

interface UsageRow {
  id: string;
  session_id: string;
  workspace_key: string;
  tool: KbUsageTool;
  created_at: number;
}

export function insertKbUsage(
  db: DatabaseSync,
  input: { sessionId: string; workspaceKey?: string; tool: KbUsageTool },
): void {
  db.prepare(
    `INSERT INTO feature_kb_usage (id, session_id, workspace_key, tool, created_at)
     VALUES(?,?,?,?,?)`,
  ).run(randomUUID(), input.sessionId, input.workspaceKey ?? "", input.tool, Date.now());
}

export function listKbUsage(db: DatabaseSync, sessionIds: readonly string[]): FeatureKbUsage[] {
  const ids = [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))].slice(
    0,
    MAX_USAGE_SESSION_IDS,
  );
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM feature_kb_usage WHERE session_id IN (${placeholders})
       ORDER BY created_at DESC`,
    )
    .all(...ids) as unknown as UsageRow[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    workspaceKey: row.workspace_key,
    tool: row.tool,
    createdAt: row.created_at,
  }));
}