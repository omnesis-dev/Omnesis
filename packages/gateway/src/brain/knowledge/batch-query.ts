// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError } from "../../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../../http/pagination-cursor.js";
import type { MaintenanceTier } from "./planner.js";
import type { KnowledgeWorkReason } from "./work.js";
import type Database from "better-sqlite3";

export type KnowledgeBatchStatus = "pending" | "running" | "completed" | "deferred" | "abandoned";
export interface KnowledgeBatchListOptions {
  reason?: KnowledgeWorkReason;
  tier?: MaintenanceTier;
  status?: KnowledgeBatchStatus | "all" | "active" | "history";
  cursor?: string;
  limit?: number;
}
interface BatchRow {
  id: string;
  runId: string;
  tier: MaintenanceTier;
  status: KnowledgeBatchStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  reasonsJson: string;
}
const projection = `b.id,b.run_id AS runId,b.tier,b.status,b.revision,
  b.created_at AS createdAt,b.updated_at AS updatedAt,b.finished_at AS finishedAt,
  (SELECT json_group_array(reason) FROM
    (SELECT DISTINCT w.reason FROM knowledge_work w WHERE w.batch_id=b.id ORDER BY w.reason)) AS reasonsJson`;
function item(row: BatchRow) {
  const { reasonsJson, ...batch } = row;
  return { ...batch, reasons: JSON.parse(reasonsJson) as KnowledgeWorkReason[] };
}

/** Reader indexes also install idempotently when upgrading an existing store. */
export function createKnowledgeBatchReadIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS knowledge_work_batch_reason ON knowledge_work(batch_id,reason);
    CREATE INDEX IF NOT EXISTS knowledge_batches_created ON knowledge_batches(created_at DESC,id);`);
}

/** Exact work reasons match before LIMIT; a mixed batch exposes every retained reason. */
export function readKnowledgeBatches(
  db: Database.Database,
  options: KnowledgeBatchListOptions = {},
) {
  return db.transaction(() => {
    if (options.cursor && options.cursor.length > 2048)
      throw new BadRequestError("Invalid pagination cursor");
    const scope = JSON.stringify({
      reason: options.reason ?? null,
      tier: options.tier ?? null,
      status: options.status ?? null,
    });
    const cursor = decodePageCursor(options.cursor, "knowledge-batches", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const candidate = payload as Record<string, unknown>;
      if (
        candidate.scope !== scope ||
        typeof candidate.id !== "string" ||
        candidate.id.length > 256 ||
        typeof candidate.at !== "number" ||
        !Number.isSafeInteger(candidate.at)
      )
        return null;
      return { id: candidate.id, at: candidate.at };
    });
    const limit = Math.max(1, Math.min(100, options.limit ?? 30));
    const clauses: string[] = [];
    const values: Record<string, string | number> = { limit: limit + 1 };
    if (options.reason) {
      clauses.push(
        "EXISTS(SELECT 1 FROM knowledge_work w WHERE w.batch_id=b.id AND w.reason=@reason)",
      );
      values.reason = options.reason;
    }
    if (options.tier) {
      clauses.push("b.tier=@tier");
      values.tier = options.tier;
    }
    if (options.status === "active") clauses.push("b.status IN ('pending','running')");
    else if (options.status === "history")
      clauses.push("b.status IN ('completed','deferred','abandoned')");
    else if (options.status && options.status !== "all") {
      clauses.push("b.status=@status");
      values.status = options.status;
    }
    if (cursor) {
      clauses.push("(b.created_at<@at OR (b.created_at=@at AND b.id>@id))");
      values.at = cursor.at;
      values.id = cursor.id;
    }
    const rows = db
      .prepare<Record<string, string | number>, BatchRow>(
        `SELECT ${projection} FROM knowledge_batches b ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY b.created_at DESC,b.id LIMIT @limit`,
      )
      .all(values);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    return {
      items: page.map(item),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodePageCursor("knowledge-batches", { scope, id: last.id, at: last.createdAt })
          : null,
    };
  })();
}

/** Detail shares the same reason provenance as the filtered list. */
export function readKnowledgeBatch(db: Database.Database, id: string) {
  const row = db
    .prepare<[string], BatchRow>(`SELECT ${projection} FROM knowledge_batches b WHERE b.id=?`)
    .get(id);
  return row ? item(row) : null;
}
