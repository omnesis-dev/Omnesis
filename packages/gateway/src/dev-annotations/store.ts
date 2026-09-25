// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Developer-annotations store — the operator → engineer feedback channel.
 *
 * When the operator, reviewing their own corpus, spots a data-quality issue or
 * inconsistency on some entity (a mis-parsed document, a spurious loop, a bad
 * brief, a wrong temporal annotation, a weird agent run), they file a short
 * free-text note against that entity from the portal or the mobile apps. These
 * notes are read back by the engineer (via `omnesis dev-annotations`) — NOT by
 * the Omnesis agent — to drive code / prompt / config changes. The whole
 * surface is gated behind `OMNESIS_DEV_MODE`.
 *
 * A note carries a `{ target_type, target_id }` reference plus a denormalized
 * `context` snapshot captured at write time, so the note stays legible even
 * after its target has been edited or deleted (mirrors the `ConversationOrigin`
 * precedent). This is deliberately distinct from `doc_annotations` (the
 * agent-generated, evidence-grounded observation store) — different table,
 * different lifecycle, different reader.
 *
 * House style matches the sibling stores: plain functions over a better-sqlite3
 * handle, explicit `now`, single-writer in production.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * The kinds of entity a developer annotation can point at. Most are addressed
 * by a single opaque id; `route` and `agent_notes` carry no `targetId`
 * (`route` is a free-form note tagged with the screen it was filed from;
 * `agent_notes` targets the singleton steward notes blob, which has no row
 * id).
 */
export const DEV_ANNOTATION_TARGET_TYPES = [
  "document",
  "temporal_annotation",
  "open_loop",
  "retired_loop",
  "brief",
  "agent_run",
  "agent_notes",
  "conversation",
  "firing",
  "route",
] as const;

export type DevAnnotationTargetType = (typeof DEV_ANNOTATION_TARGET_TYPES)[number];

export type DevAnnotationStatus = "open" | "resolved";

/**
 * DDL — idempotent, so it is called both from `runSchemaSetup` (fresh installs)
 * and from the numbered migration that introduced it (upgrades), exactly like
 * `createBriefsStorageTables`.
 */
export function createDevAnnotationsTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_annotations (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT,
      note TEXT NOT NULL,
      context_json TEXT,
      deep_link TEXT,
      client TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_note TEXT
    )
  `);
  // The default list ("open notes, newest first") drives the CLI read path.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_dev_annotations_status ON dev_annotations(status, created_at)",
  );
  // "Notes on this entity" — used to badge a target with its open-note count.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_dev_annotations_target ON dev_annotations(target_type, target_id)",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dev_annotations_retention
      ON dev_annotations(resolved_at, id)
      WHERE status = 'resolved' AND resolved_at IS NOT NULL
  `);
}

/** A denormalized snapshot of the target, captured at write time. */
export type DevAnnotationContext = Record<string, unknown>;

export interface DevAnnotationRow {
  id: string;
  targetType: DevAnnotationTargetType;
  /** Opaque entity id; null for a free-form `route` note. */
  targetId: string | null;
  /** The operator's free-text message. */
  note: string;
  /** Durable snapshot of the target (title/summary/label) at write time. */
  context: DevAnnotationContext | null;
  /** Portal route / app screen the note was filed from. */
  deepLink: string | null;
  /** Which client filed it (`portal` | `ios` | `android`). */
  client: string | null;
  status: DevAnnotationStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** Optional "what I did" note recorded when the annotation is resolved. */
  resolvedNote: string | null;
}

interface DevAnnotationDbRow {
  id: string;
  target_type: string;
  target_id: string | null;
  note: string;
  context_json: string | null;
  deep_link: string | null;
  client: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolved_note: string | null;
}

function rowToDevAnnotation(r: DevAnnotationDbRow): DevAnnotationRow {
  let context: DevAnnotationContext | null = null;
  if (r.context_json) {
    try {
      const parsed: unknown = JSON.parse(r.context_json);
      if (parsed && typeof parsed === "object") context = parsed as DevAnnotationContext;
    } catch {
      // A malformed snapshot should never sink the read — drop it to null.
      context = null;
    }
  }
  return {
    id: r.id,
    targetType: r.target_type as DevAnnotationTargetType,
    targetId: r.target_id,
    note: r.note,
    context,
    deepLink: r.deep_link,
    client: r.client,
    status: r.status === "resolved" ? "resolved" : "open",
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedNote: r.resolved_note,
  };
}

export interface CreateDevAnnotationInput {
  id: string;
  targetType: DevAnnotationTargetType;
  targetId?: string | null;
  note: string;
  context?: DevAnnotationContext | null;
  deepLink?: string | null;
  client?: string | null;
}

export function createDevAnnotation(
  db: Db,
  input: CreateDevAnnotationInput,
  now: number,
): DevAnnotationRow {
  db.prepare<unknown[]>(
    `INSERT INTO dev_annotations (
       id, target_type, target_id, note, context_json, deep_link, client,
       status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    input.id,
    input.targetType,
    input.targetId ?? null,
    input.note,
    input.context == null ? null : JSON.stringify(input.context),
    input.deepLink ?? null,
    input.client ?? null,
    now,
  );
  const created = db
    .prepare<[string], DevAnnotationDbRow>("SELECT * FROM dev_annotations WHERE id = ?")
    .get(input.id);
  if (!created) throw new Error(`dev annotation ${input.id} vanished mid-create`);
  return rowToDevAnnotation(created);
}

export interface ListDevAnnotationsOptions {
  /** Defaults to `open`. Pass `all` to include resolved notes. */
  status?: DevAnnotationStatus | "all";
  targetType?: DevAnnotationTargetType;
  limit?: number;
}

/** Annotations newest-first, filtered by status (default `open`) and type. */
export function listDevAnnotations(
  db: Db,
  options: ListDevAnnotationsOptions = {},
): DevAnnotationRow[] {
  const status = options.status ?? "open";
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (options.targetType) {
    clauses.push("target_type = ?");
    params.push(options.targetType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit && options.limit > 0 ? options.limit : 500;
  params.push(limit);
  return db
    .prepare<unknown[], DevAnnotationDbRow>(
      `SELECT * FROM dev_annotations ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params)
    .map(rowToDevAnnotation);
}

export function getDevAnnotation(db: Db, id: string): DevAnnotationRow | null {
  const row = db
    .prepare<[string], DevAnnotationDbRow>("SELECT * FROM dev_annotations WHERE id = ?")
    .get(id);
  return row ? rowToDevAnnotation(row) : null;
}

/**
 * Mark an annotation resolved. Idempotent and safe on a missing id (returns
 * null); resolving an already-resolved note refreshes its resolution note.
 */
export function resolveDevAnnotation(
  db: Db,
  id: string,
  now: number,
  resolvedNote?: string | null,
): DevAnnotationRow | null {
  db.prepare<[number, string | null, string]>(
    "UPDATE dev_annotations SET status = 'resolved', resolved_at = ?, resolved_note = ? WHERE id = ?",
  ).run(now, resolvedNote ?? null, id);
  return getDevAnnotation(db, id);
}

/** Hard-delete an annotation. Returns whether a row was removed. */
export function deleteDevAnnotation(db: Db, id: string): boolean {
  const info = db.prepare<[string]>("DELETE FROM dev_annotations WHERE id = ?").run(id);
  return info.changes > 0;
}
