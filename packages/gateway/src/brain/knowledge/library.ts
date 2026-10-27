// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError, NotFoundError, StalePageCursorError } from "../../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../../http/pagination-cursor.js";
import { readKnowledgeSubjectRef } from "./subject-ref.js";
import { knowledgeNodeFence, knowledgeOwnerReadPredicate } from "./storage-fence.js";
import type { KnowledgeNodeKind } from "./types.js";
import type Database from "better-sqlite3";

export interface KnowledgeLibraryOptions {
  kind?: KnowledgeNodeKind;
  /** Live browsing tolerates intervening edits; refresh reveals items moved above the cursor. */
  consistency?: "strict" | "live";
  status?: string;
  cursor?: string;
  limit?: number;
}
interface LibraryRow {
  id: string;
  kind: KnowledgeNodeKind;
  libraryType: "knowledge" | "loop" | "observation" | "retired-loop";
  title: string;
  plainText: string;
  updatedAt: number;
  validity: string | null;
  canonicalFields: string;
  state: string | null;
}
function librarySql(db: Database.Database): string {
  return `
    SELECT n.id,n.kind,'knowledge' AS libraryType,n.title,n.plain_text AS plainText,n.updated_at AS updatedAt,n.validity,n.fields_json AS canonicalFields,NULL AS state
    FROM knowledge_nodes n WHERE n.kind NOT IN ('loop','observation') AND ${knowledgeOwnerReadPredicate(db, "n.id")}
    UNION ALL
    SELECT l.id,'loop','loop',l.title,l.description,l.last_update,NULL,
      json_object('state',l.state,'importance',l.importance,'deadline',json(l.deadline_json),'createdAt',l.created_at,'retiredAt',r.retired_at,'recurrenceCount',r.recurrence_count,'cadenceDays',r.cadence_days),l.state
    FROM open_loops l LEFT JOIN retired_loops r ON r.id=l.id WHERE ${knowledgeOwnerReadPredicate(db, "l.id")}
    UNION ALL
    SELECT o.id,'observation','observation',o.summary,o.why,o.updated_at,NULL,
      json_object('state',o.state,'closeReason',o.close_reason,'createdAt',o.created_at,'createdByRun',o.created_by_run,'userAuthored',json(CASE WHEN o.user_authored=1 THEN 'true' ELSE 'false' END),'windowStart',o.window_start,'relevantUntil',o.relevant_until,'notedScores',json(o.noted_scores_json),'scores',json(o.scores_json),'wouldPushAt',o.would_push_at,'shippedAt',o.shipped_at,'shippedConversationId',o.shipped_conversation_id,'shippedMessageId',o.shipped_message_id,'userAction',o.user_action,'closedAt',o.closed_at),o.state
    FROM observations o WHERE ${knowledgeOwnerReadPredicate(db, "o.id")}
    UNION ALL
    SELECT 'retired-loop:'||r.id,'loop','retired-loop',r.title,r.description,r.retired_at,NULL,
      json_object('retired',json('true'),'originalLoopId',r.id,'state',r.outcome,'importance',r.importance,'deadline',json(r.deadline_json),'createdAt',r.created_at,'retiredAt',r.retired_at,'recurrenceCount',r.recurrence_count,'cadenceDays',r.cadence_days,'actors',json(r.actors_json),'involved',json(r.involved_json)),r.outcome
    FROM retired_loops r WHERE NOT EXISTS(SELECT 1 FROM open_loops l WHERE l.id=r.id) AND ${knowledgeOwnerReadPredicate(db, "r.id")}`;
}
function item(row: LibraryRow) {
  return { ...row, canonicalFields: JSON.parse(row.canonicalFields) as Record<string, unknown> };
}
function statusPredicate(kind: KnowledgeNodeKind | undefined, status: string | undefined): string {
  if (!status || status === "all") return "1";
  if (kind === "loop") {
    if (status === "retired") return "libraryType='retired-loop'";
    if (status === "active") return "libraryType='loop' AND state IN ('open','snoozed')";
    if (status === "resolved") return "libraryType='loop' AND state IN ('done','dismissed')";
    if (["open", "snoozed", "done", "dismissed", "decayed", "deleted"].includes(status))
      return "state=@status";
  }
  if (kind === "observation") {
    if (status === "open") return "state IN ('live','held')";
    if (["live", "held", "shipped", "dropped"].includes(status)) return "state=@status";
  }
  throw new BadRequestError("Invalid Library status for this kind");
}
/** One ordered, privacy-filtered server page; canonical owners replace their mirrors. */
export function readKnowledgeLibrary(db: Database.Database, options: KnowledgeLibraryOptions = {}) {
  return db.transaction(() => {
    const limit = Math.max(1, Math.min(100, options.limit ?? 30));
    const filter = statusPredicate(options.kind, options.status);
    const consistency = options.consistency ?? "strict";
    const revision =
      consistency === "live"
        ? ""
        : db
            .prepare<[], { revision: string }>(
              "SELECT COALESCE(group_concat(collection||':'||revision,','),'') || ':changes:' || COALESCE((SELECT seq FROM sqlite_sequence WHERE name='knowledge_changes'),0) AS revision FROM (SELECT collection,revision FROM knowledge_reconciliation_revisions ORDER BY collection)",
            )
            .get()!.revision;
    const scope = JSON.stringify({
      kind: options.kind ?? null,
      status: options.status ?? null,
      consistency,
    });
    const cursor = decodePageCursor(options.cursor, "knowledge-library", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const c = payload as Record<string, unknown>;
      if (
        c.scope !== scope ||
        typeof c.revision !== "string" ||
        typeof c.id !== "string" ||
        typeof c.type !== "string" ||
        typeof c.at !== "number" ||
        !Number.isSafeInteger(c.at)
      )
        return null;
      return { id: c.id, at: c.at, type: c.type, revision: c.revision };
    });
    if (consistency === "strict" && cursor && cursor.revision !== revision)
      throw new StalePageCursorError();
    const rows = db
      .prepare<Record<string, string | number | null>, LibraryRow>(
        `SELECT * FROM (${librarySql(db)}) WHERE (@kind IS NULL OR kind=@kind) AND ${filter} AND (@at IS NULL OR updatedAt<@at OR (updatedAt=@at AND (id<@id OR (id=@id AND libraryType<@type)))) ORDER BY updatedAt DESC,id DESC,libraryType DESC LIMIT @limit`,
      )
      .all({
        kind: options.kind ?? null,
        status: options.status ?? null,
        at: cursor?.at ?? null,
        id: cursor?.id ?? null,
        type: cursor?.type ?? null,
        limit: limit + 1,
      });
    const hasMore = rows.length > limit;
    const mirrorValidity = db.prepare<[string, string], { validity: string }>(
      "SELECT validity FROM knowledge_nodes WHERE id=? AND kind=?",
    );
    const items = rows.slice(0, limit).map((row) => {
      const value = { ...item(row), subjectRef: readKnowledgeSubjectRef(db, row.id, row.kind) };
      // Canonical cards retain their synthesis freshness without manufacturing
      // a freshness verdict for owners that have never had a mirror.
      if (row.libraryType === "loop" || row.libraryType === "observation")
        value.validity = mirrorValidity.get(row.id, row.kind)?.validity ?? null;
      if (value.validity !== null && knowledgeNodeFence(db, row.id).stale) value.validity = "stale";
      return value;
    });
    const last = items.at(-1);
    return {
      items,
      pageInfo: {
        consistency,
        hasMore,
        limit,
        nextCursor:
          hasMore && last
            ? encodePageCursor("knowledge-library", {
                scope,
                revision,
                at: last.updatedAt,
                id: last.id,
                type: last.libraryType,
              })
            : null,
      },
    };
  })();
}
export function readKnowledgeLibraryRetirement(db: Database.Database, id: string) {
  const row = db
    .prepare<[string], LibraryRow>(
      `SELECT * FROM (${librarySql(db)}) WHERE id=? AND libraryType='retired-loop'`,
    )
    .get(id);
  if (!row) throw new NotFoundError("Library entry not found");
  return item(row);
}
