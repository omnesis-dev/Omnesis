// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../schema.js";
import {
  deleteAllBySource,
  deleteDocuments,
  upsertWithCursor,
  upsertWithCursorYieldable,
} from "./DocumentRepository.js";
import type { DocumentTemporalProjectionSpec } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { Db } from "../types.js";

const SOURCE_ID = "example-events:account";
const PROVIDER_ID = "example-provider";
const SPECS: DocumentTemporalProjectionSpec[] = [
  {
    slot: "planned",
    start: "scheduledAt",
    kind: "event",
    modality: "scheduled",
  },
  {
    slot: "due",
    start: "dueAt",
    kind: "deadline",
    modality: "asserted",
    status: "active",
  },
];

/**
 * A declaration exercising the fuller projection shape: a bounded interval, a
 * carried time zone, a kind resolved per document rather than fixed, and a slot
 * anchored on the document's own event time.
 */
const RICH_SPECS: DocumentTemporalProjectionSpec[] = [
  {
    slot: "booking",
    start: "scheduledAt",
    end: "endsAt",
    timeZone: "timeZone",
    // A floating time zone describes a whole-day observance; a zoned one is a
    // booked slot.
    kind: { from: "timeZone", map: { floating: "event" }, default: "appointment" },
    modality: "scheduled",
  },
  {
    slot: "captured",
    start: "$semanticTime",
    kind: "episode",
    modality: "observed",
  },
];

interface DocumentDates {
  scheduledAt?: string;
  dueAt?: string;
  endsAt?: string;
  timeZone?: string;
}

function document(
  externalId: string,
  metadata: DocumentDates,
  title = `Item ${externalId}`,
): DocumentInput {
  return {
    providerId: PROVIDER_ID as DocumentInput["providerId"],
    sourceId: SOURCE_ID as DocumentInput["sourceId"],
    externalId,
    title,
    content: "Invented test content.",
    contentHash: `hash-${externalId}-${title}`,
    metadata: { documentType: "event", ...metadata },
    sourceCreatedAt: "2026-07-01T08:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
  };
}

function write(db: Db, documents: DocumentInput[], specs = SPECS): void {
  upsertWithCursor(db, {
    providerId: PROVIDER_ID,
    sourceId: SOURCE_ID,
    documents,
    documentTemporalProjections: specs,
    hasMore: false,
    cursor: { complete: true },
  });
}

interface ProjectionRow {
  id: string;
  document_id: string;
  document_external_id: string;
  slot: string;
  start_ms: number;
  end_exclusive_ms: number;
  start_canonical: string;
  end_canonical: string;
  precision: string;
  all_day: number;
  time_zone: string | null;
  label: string;
  kind: string;
  modality: string;
  status: string;
}

describe("document temporal projection ingestion", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  function rows(): ProjectionRow[] {
    return db
      .prepare<[], ProjectionRow>("SELECT * FROM document_temporal_projections ORDER BY slot")
      .all();
  }

  test("materializes date and instant slots with stable tp_ ids", () => {
    write(db, [
      document("alpha", {
        scheduledAt: "2026-07-23",
        dueAt: "2026-07-24T10:30:00+02:00",
      }),
    ]);

    const first = rows();
    expect(first).toHaveLength(2);
    expect(first.every((row) => /^tp_[0-9a-f]{32}$/.test(row.id))).toBe(true);
    const due = first.find((row) => row.slot === "due")!;
    expect(due).toMatchObject({
      start_canonical: "2026-07-24T08:30:00.000Z",
      end_canonical: "2026-07-24T08:30:00.000Z",
      precision: "instant",
      all_day: 0,
      kind: "deadline",
      modality: "asserted",
      status: "active",
    });
    // A fact with no declared end is a point: the stored interval is empty, so
    // its duration is honestly zero.
    expect(due.end_exclusive_ms - due.start_ms).toBe(0);
    const planned = first.find((row) => row.slot === "planned")!;
    expect(planned).toMatchObject({
      start_canonical: "2026-07-23",
      end_canonical: "2026-07-24",
      precision: "day",
      all_day: 1,
    });
    expect(planned.end_exclusive_ms - planned.start_ms).toBe(86_400_000);

    write(db, [document("alpha", { scheduledAt: "2026-07-25" }, "Updated item")]);
    const second = rows();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      id: planned.id,
      slot: "planned",
      start_canonical: "2026-07-25",
      label: "Updated item",
    });
  });

  test("projects bounded intervals, the carried time zone, and mapped kinds", () => {
    write(
      db,
      [
        document("zoned", {
          scheduledAt: "2026-07-24T09:00:00Z",
          endsAt: "2026-07-24T10:30:00Z",
          timeZone: "America/New_York",
        }),
        document("floating", {
          scheduledAt: "2026-07-25",
          endsAt: "2026-07-27",
          timeZone: "floating",
        }),
      ],
      RICH_SPECS,
    );

    const byKey = new Map(rows().map((row) => [`${row.document_external_id}/${row.slot}`, row]));
    expect([...byKey.keys()].sort()).toEqual([
      "floating/booking",
      "floating/captured",
      "zoned/booking",
      "zoned/captured",
    ]);

    const zoned = byKey.get("zoned/booking")!;
    expect(zoned).toMatchObject({
      start_canonical: "2026-07-24T09:00:00.000Z",
      end_canonical: "2026-07-24T10:30:00.000Z",
      precision: "instant",
      all_day: 0,
      time_zone: "America/New_York",
      // The map misses, so the declared default stands.
      kind: "appointment",
      modality: "scheduled",
      // Absent from the declaration, so the store's own default applies.
      status: "active",
    });
    expect(zoned.end_exclusive_ms - zoned.start_ms).toBe(5_400_000);

    // The same slot resolves a different kind from this document's own value,
    // and a start written as a bare day makes the whole fact a calendar range.
    const floating = byKey.get("floating/booking")!;
    expect(floating).toMatchObject({
      start_canonical: "2026-07-25",
      end_canonical: "2026-07-27",
      precision: "day",
      all_day: 1,
      time_zone: "floating",
      kind: "event",
    });
    expect(floating.end_exclusive_ms - floating.start_ms).toBe(2 * 86_400_000);

    // `$semanticTime` on a document is the document's own event time.
    expect(byKey.get("zoned/captured")).toMatchObject({
      start_canonical: "2026-07-01T08:00:00.000Z",
      end_canonical: "2026-07-01T08:00:00.000Z",
      precision: "instant",
      time_zone: null,
      kind: "episode",
      modality: "observed",
      label: "Item zoned",
    });
  });

  test("updates the document and retires its projection when a new date is unusable", () => {
    write(db, [document("alpha", { scheduledAt: "2026-07-23" }, "Before")]);
    expect(rows()).toHaveLength(1);

    // The document is what is being stored; the projection is derived from it.
    // A date the source can no longer place must not hold back the update.
    write(db, [document("alpha", { scheduledAt: "2026-07-32T08:00:00Z" }, "After")]);

    const title = () =>
      db
        .prepare<[], { title: string }>("SELECT title FROM documents WHERE external_id = 'alpha'")
        .get()?.title;
    expect(title()).toBe("After");
    // The prior projection is gone rather than left asserting a fact the
    // current document no longer carries.
    expect(rows()).toEqual([]);

    // A calendar day that does not exist takes the day path, and behaves the same.
    write(db, [document("alpha", { scheduledAt: "2026-02-30" }, "Also after")]);
    expect(title()).toBe("Also after");
    expect(rows()).toEqual([]);

    // A usable date after an unusable one projects again.
    write(db, [document("alpha", { scheduledAt: "2026-07-25" }, "Recovered")]);
    expect(title()).toBe("Recovered");
    expect(rows().map((r) => r.start_canonical)).toEqual(["2026-07-25"]);
  });

  test("registers coverage on an empty page without backfilling existing documents", () => {
    // Simulate a document written by a collector predating the declaration.
    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [document("legacy", { scheduledAt: "2026-07-23" })],
      hasMore: false,
      cursor: { page: 1 },
    });
    expect(rows()).toEqual([]);

    write(db, []);
    expect(rows()).toEqual([]);
    expect(
      db
        .prepare<
          [],
          { slots_json: string; last_materialized_at: string | null; last_sync_at: string }
        >("SELECT * FROM document_temporal_projection_sources")
        .get(),
    ).toMatchObject({
      slots_json: '["due","planned"]',
      last_materialized_at: null,
    });
  });

  test("FK-cascades on document deletion and removes coverage on source removal", () => {
    write(db, [document("alpha", { dueAt: "2026-07-24T12:00:00Z" })]);
    const originalId = rows()[0].id;

    deleteDocuments(db, PROVIDER_ID, SOURCE_ID, ["alpha"]);
    expect(rows()).toEqual([]);

    // A recreated document is a new row, so its projection is keyed to that
    // row rather than to the id the deleted one held. Nothing depends on the
    // old key: the cascade already removed everything it named.
    write(db, [document("alpha", { dueAt: "2026-07-25T12:00:00Z" })]);
    const recreated = rows()[0];
    expect(recreated.id).not.toBe(originalId);
    expect(recreated.document_id).toBe(
      db.prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id = 'alpha'").get()
        ?.id,
    );
    expect(recreated.end_canonical).toBe("2026-07-25T12:00:00.000Z");
    expect(deleteAllBySource(db, SOURCE_ID)).toBe(1);
    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT * FROM document_temporal_projection_sources").all()).toEqual([]);
  });

  test("materializes every chunk of the yieldable cursor path", () => {
    const result = upsertWithCursorYieldable(
      db,
      {
        providerId: PROVIDER_ID,
        sourceId: SOURCE_ID,
        documents: [
          document("one", { scheduledAt: "2026-07-21" }),
          document("two", { scheduledAt: "2026-07-22" }),
          document("three", { scheduledAt: "2026-07-23" }),
        ],
        documentTemporalProjections: SPECS,
        hasMore: false,
        cursor: { complete: true },
      },
      { token: { requested: () => false }, chunkSize: 1 },
    );

    expect(result.kind).toBe("done");
    expect(rows().map((row) => row.start_canonical)).toEqual([
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ]);
  });

  test("an explicit empty declaration retires projections and coverage", () => {
    write(db, [document("alpha", { scheduledAt: "2026-07-23" })]);
    expect(rows()).toHaveLength(1);

    write(db, [], []);

    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT * FROM document_temporal_projection_sources").all()).toEqual([]);
  });
});

describe("a date that cannot be canonicalized never costs the document", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  const storedIds = (): string[] =>
    db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM documents ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);

  const projectedSlots = (): string[] =>
    db
      .prepare<[], { slot: string }>("SELECT slot FROM document_temporal_projections ORDER BY slot")
      .all()
      .map((r) => r.slot);

  // A source lifts dates out of third-party content, so an unusable value is
  // ordinary input. If it reached the caller the page would fail, the sync
  // cursor would stay where it was, and the source would re-fetch the same
  // document forever.
  test("ingests a document whose declared date names no instant", () => {
    expect(() =>
      write(db, [document("wall-clock", { scheduledAt: "2026-08-14T19:00" })]),
    ).not.toThrow();
    expect(storedIds()).toEqual(["wall-clock"]);
    expect(projectedSlots()).toEqual([]);
  });

  test("keeps the rest of the page and the document's other slots", () => {
    write(db, [
      document("first", { scheduledAt: "2026-08-01T09:00:00.000Z" }),
      document("mixed", { scheduledAt: "not a date at all", dueAt: "2026-08-20" }),
      document("last", { scheduledAt: "2026-08-03T09:00:00.000Z" }),
    ]);

    expect(storedIds()).toEqual(["first", "last", "mixed"]);
    // The unusable slot is dropped; the usable one on the same document is not.
    const mixed = db
      .prepare<[string], { slot: string }>(
        "SELECT slot FROM document_temporal_projections WHERE document_external_id = ?",
      )
      .all("mixed")
      .map((r) => r.slot);
    expect(mixed).toEqual(["due"]);
  });

  test("still ingests when a later page repeats the same unusable value", () => {
    const poison = document("poison", { scheduledAt: "2026-08-14T19:00" });
    write(db, [poison]);
    expect(() => write(db, [poison])).not.toThrow();
    expect(storedIds()).toEqual(["poison"]);
  });
});

describe("two documents that differ only in provider each keep their projections", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  const OTHER_PROVIDER = "example-provider-second";

  function underProvider(providerId: string, externalId: string): DocumentInput {
    return {
      ...document(externalId, { scheduledAt: "2026-08-14T09:00:00.000Z" }),
      providerId: providerId as DocumentInput["providerId"],
    };
  }

  // A document is identified by (providerId, sourceId, externalId). Two rows
  // sharing the last two are distinct documents, and each owns its own
  // projections.
  test("both are stored and neither loses its projection", () => {
    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [underProvider(PROVIDER_ID, "shared-external-id")],
      documentTemporalProjections: SPECS,
      hasMore: false,
      cursor: { complete: true },
    });

    expect(() =>
      upsertWithCursor(db, {
        providerId: OTHER_PROVIDER,
        sourceId: SOURCE_ID,
        documents: [underProvider(OTHER_PROVIDER, "shared-external-id")],
        documentTemporalProjections: SPECS,
        hasMore: false,
        cursor: { complete: true },
      }),
    ).not.toThrow();

    const rows = db
      .prepare<
        [],
        { id: string; document_id: string; slot: string }
      >("SELECT id, document_id, slot FROM document_temporal_projections ORDER BY document_id")
      .all();

    // One projection per document, under distinct ids.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.document_id)).size).toBe(2);
    expect(rows.every((r) => r.slot === "planned")).toBe(true);
  });

  test("a stale replica cannot replace the winning document's temporal projection", () => {
    const fresh = {
      ...document("replicated", { scheduledAt: "2026-09-10T09:00:00.000Z" }, "Fresh"),
      sourceUpdatedAt: "2026-08-02T00:00:00.000Z",
    };
    const stale = {
      ...document("replicated", { scheduledAt: "2026-08-10T09:00:00.000Z" }, "Stale"),
      sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
    };
    const policy = "source-updated-at" as const;

    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [fresh],
      documentTemporalProjections: SPECS,
      replicaVersionPolicy: policy,
      hasMore: false,
      cursor: { complete: true },
    });
    const result = upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [stale],
      documentTemporalProjections: SPECS,
      replicaVersionPolicy: policy,
      hasMore: false,
      cursor: { complete: true },
    });

    expect(result.ignoredReplicaDocuments).toEqual([
      { sourceId: SOURCE_ID, externalId: "replicated" },
    ]);
    expect(
      db
        .prepare<[], { title: string; start_canonical: string }>(
          `SELECT d.title, p.start_canonical
             FROM documents d
             JOIN document_temporal_projections p ON p.document_id = d.id
            WHERE d.external_id = 'replicated'`,
        )
        .get(),
    ).toEqual({ title: "Fresh", start_canonical: "2026-09-10T09:00:00.000Z" });
  });

  test("identical winning replica evidence repairs a missing temporal projection", () => {
    const winning = {
      ...document("replicated-repair", { scheduledAt: "2026-09-10T09:00:00.000Z" }, "Winner"),
      sourceUpdatedAt: "2026-08-02T00:00:00.000Z",
    };
    const args = {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [winning],
      documentTemporalProjections: SPECS,
      replicaVersionPolicy: "source-updated-at" as const,
      hasMore: false,
      cursor: { complete: true },
    };
    upsertWithCursor(db, args);
    db.prepare(
      `DELETE FROM document_temporal_projections
        WHERE document_external_id = 'replicated-repair'`,
    ).run();

    const replay = upsertWithCursor(db, args);
    expect(replay.ignoredReplicaDocuments).toEqual([]);
    expect(
      db
        .prepare<[], { start_canonical: string }>(
          `SELECT start_canonical FROM document_temporal_projections
            WHERE document_external_id = 'replicated-repair'`,
        )
        .get(),
    ).toEqual({ start_canonical: "2026-09-10T09:00:00.000Z" });
  });

  test("re-projecting one of them replaces only its own row", () => {
    for (const p of [PROVIDER_ID, OTHER_PROVIDER]) {
      upsertWithCursor(db, {
        providerId: p,
        sourceId: SOURCE_ID,
        documents: [underProvider(p, "shared-external-id")],
        documentTemporalProjections: SPECS,
        hasMore: false,
        cursor: { complete: true },
      });
    }
    const before = db
      .prepare<[], { id: string }>("SELECT id FROM document_temporal_projections ORDER BY id")
      .all();

    upsertWithCursor(db, {
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      documents: [
        {
          ...underProvider(PROVIDER_ID, "shared-external-id"),
          metadata: { documentType: "event", scheduledAt: "2026-09-01T09:00:00.000Z" },
        },
      ],
      documentTemporalProjections: SPECS,
      hasMore: false,
      cursor: { complete: true },
    });

    const after = db
      .prepare<[], { id: string; provider_id: string; start_canonical: string }>(
        `SELECT p.id, d.provider_id, p.start_canonical
           FROM document_temporal_projections p
           JOIN documents d ON d.id = p.document_id
          ORDER BY d.provider_id`,
      )
      .all();
    // Ids are stable across re-projection, and the date moved on exactly the
    // document that was re-projected — naming which row holds which, so a
    // write landing on the sibling cannot pass.
    expect([...after].map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.map((r) => [r.provider_id, r.start_canonical])).toEqual([
      [PROVIDER_ID, "2026-09-01T09:00:00.000Z"],
      [OTHER_PROVIDER, "2026-08-14T09:00:00.000Z"],
    ]);
  });
});
