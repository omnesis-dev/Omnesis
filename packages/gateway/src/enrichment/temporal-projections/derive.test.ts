// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shared derivation's plane-independent policy.
 *
 * "A record that carries no start owns no projection" belongs to the
 * derivation, not to either store, so the analytics plane and the document
 * plane cannot disagree about an absent date. These tests drive both planes
 * through their own entry points and assert the same outcome.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { deriveAnalyticsProjection } from "../../analytics/temporal-projection-derivation.js";
import { runSchemaSetup } from "../../data/schema.js";
import { upsertWithCursor } from "../../data/repositories/DocumentRepository.js";
import { deriveTemporalFact } from "./derive.js";
import type {
  AnalyticsTableSchema,
  AnalyticsTemporalProjectionSpec,
  DocumentTemporalProjectionSpec,
} from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { Db } from "../../data/types.js";

/** The three shapes a source uses to say "this record has no such date". */
const ABSENT_STARTS: ReadonlyArray<[label: string, value: unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
];

// ── Analytics plane ──────────────────────────────────────────────────

const ANALYTICS_SPEC: AnalyticsTemporalProjectionSpec = {
  slot: "logged",
  start: "$semanticTime",
  kind: "event",
  modality: "observed",
};

const ANALYTICS_SCHEMA: AnalyticsTableSchema = {
  tableName: "workshop_sessions",
  displayName: "Workshop sessions",
  description: "One row per booked workshop session.",
  columns: [
    { name: "session_id", type: "VARCHAR", description: "Session identifier" },
    { name: "held_at", type: "TIMESTAMPTZ", description: "When the session ran", nullable: true },
    { name: "title", type: "VARCHAR", description: "Session title" },
  ],
  primaryKey: ["session_id"],
  semanticTimeColumn: "held_at",
  record: { titleColumns: ["title"], keyColumns: ["session_id"] },
  temporalProjection: ANALYTICS_SPEC,
};

function analyticsProjection(record: Record<string, unknown>) {
  return deriveAnalyticsProjection({
    schema: ANALYTICS_SCHEMA,
    spec: ANALYTICS_SPEC,
    sourceId: "workshops:studio-northstar",
    record,
    recordKey: JSON.stringify({ session_id: String(record.session_id) }),
    projectedAt: "2026-07-26T12:00:00.000Z",
  });
}

// ── Document plane ───────────────────────────────────────────────────

const PROVIDER_ID = "example-provider";
const SOURCE_ID = "example-events:account";

const DOCUMENT_SPECS: DocumentTemporalProjectionSpec[] = [
  { slot: "due", start: "dueAt", kind: "deadline", modality: "asserted" },
];

function documentInput(externalId: string, dueAt: unknown, status?: string): DocumentInput {
  return {
    providerId: PROVIDER_ID as DocumentInput["providerId"],
    sourceId: SOURCE_ID as DocumentInput["sourceId"],
    externalId,
    title: `Task ${externalId}`,
    content: "Invented test content.",
    contentHash: `hash-${externalId}`,
    metadata: { documentType: "event", dueAt, status } as DocumentInput["metadata"],
    sourceCreatedAt: "2026-07-01T08:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
  };
}

describe("a record that carries no start owns no projection", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  test.each(ABSENT_STARTS)("the derivation declines a %s start", (_label, value) => {
    expect(
      deriveTemporalFact({
        spec: ANALYTICS_SPEC,
        read: (ref) => (ref === "$semanticTime" ? value : undefined),
        fallbackLabel: "Fallback",
        context: "unit",
      }),
    ).toBeNull();
  });

  test.each(ABSENT_STARTS)("the analytics plane declines a %s start", (_label, value) => {
    expect(analyticsProjection({ session_id: "s-1", held_at: value, title: "Kiln firing" })).toBe(
      null,
    );
  });

  test.each(ABSENT_STARTS)("the document plane declines a %s start", (_label, value) => {
    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [documentInput("no-date", value), documentInput("dated", "2026-08-04T10:00:00Z")],
      documentTemporalProjections: DOCUMENT_SPECS,
      hasMore: false,
      cursor: { complete: true },
    });

    const projected = db
      .prepare<
        [],
        { document_external_id: string }
      >("SELECT document_external_id FROM document_temporal_projections")
      .all();
    expect(projected.map((row) => row.document_external_id)).toEqual(["dated"]);
  });

  test("both planes still project a record that does carry a start", () => {
    const analytics = analyticsProjection({
      session_id: "s-2",
      held_at: "2026-08-04T10:00:00Z",
      title: "Kiln firing",
    });
    expect(analytics).toMatchObject({
      slot: "logged",
      start_canonical: "2026-08-04T10:00:00.000Z",
      kind: "event",
      modality: "observed",
    });

    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [documentInput("dated", "2026-08-04T10:00:00Z")],
      documentTemporalProjections: DOCUMENT_SPECS,
      hasMore: false,
      cursor: { complete: true },
    });
    expect(
      db
        .prepare<
          [],
          { slot: string; start_canonical: string }
        >("SELECT slot, start_canonical FROM document_temporal_projections")
        .all(),
    ).toEqual([{ slot: "due", start_canonical: "2026-08-04T10:00:00.000Z" }]);
  });

  test("maps lifecycle status while inferring all-day and omitting undated records", () => {
    const lifecycleSpec: DocumentTemporalProjectionSpec[] = [
      {
        ...DOCUMENT_SPECS[0]!,
        status: {
          from: "status",
          map: { open: "active", completed: "completed", canceled: "cancelled" },
          default: "active",
        },
      },
    ];
    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [
        documentInput("open", "2026-08-04", "open"),
        documentInput("completed", "2026-08-05T10:00:00Z", "completed"),
        documentInput("canceled", "2026-08-06", "canceled"),
        documentInput("undated", undefined, "open"),
      ],
      documentTemporalProjections: lifecycleSpec,
      hasMore: false,
      cursor: { complete: true },
    });

    expect(
      db
        .prepare<[], { document_external_id: string; status: string; all_day: number }>(
          `SELECT document_external_id, status, all_day
           FROM document_temporal_projections
           ORDER BY start_ms`,
        )
        .all(),
    ).toEqual([
      { document_external_id: "open", status: "active", all_day: 1 },
      { document_external_id: "completed", status: "completed", all_day: 0 },
      { document_external_id: "canceled", status: "cancelled", all_day: 1 },
    ]);
  });

  test("a present but unparseable start is an error, not a decline", () => {
    // Declining an absent date must not also swallow a malformed one: a value
    // the source did write and we cannot read is a contract violation.
    expect(() =>
      analyticsProjection({ session_id: "s-3", held_at: "not-a-date", title: "Kiln firing" }),
    ).toThrow();
  });
});
