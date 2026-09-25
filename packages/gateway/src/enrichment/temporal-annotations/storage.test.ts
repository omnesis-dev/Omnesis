// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { createOpenLoop, deleteOpenLoop } from "../../brain/storage/open-loops.js";
import {
  expandCanonical,
  insertTemporalAnnotation,
  queryTemporalAnnotationOverlap,
  queryTemporalAnnotationWindow,
  getTemporalAnnotationById,
  hasLiveTemporalAnnotationsForDoc,
  invalidateTemporalAnnotationsForDoc,
  updateTemporalAnnotation,
  invalidateTemporalAnnotation,
  cascadeTemporalAnnotationPrivacyDelete,
  countTemporalAnnotations,
  listTemporalAnnotationsForLoop,
  listTemporalAnnotationsForPerson,
  listTemporalAnnotationsForDoc,
  listTemporalAnnotationEvidence,
  listTemporalAnnotationsAwaitingRefile,
  markTemporalAnnotationsRefilePresented,
  listUngroundedTemporalAnnotationsForDoc,
  type CreateTemporalAnnotationInput,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput } from "@omnesis/types";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}
function makeDoc(id: string): DocumentInput {
  return {
    providerId: "test" as DocumentInput["providerId"],
    sourceId: "test:acct" as DocumentInput["sourceId"],
    externalId: id,
    title: "Renewal notice",
    content: "body",
    contentHash: `hash-${id}`,
    metadata: {},
    sourceCreatedAt: "2024-01-01T10:00:00.000Z",
    sourceUpdatedAt: "2024-01-01T10:00:00.000Z",
  };
}

// A day inside 2026-07 and its ms; and the "now" reference.
const JULY_8_2026 = Date.UTC(2026, 6, 8);

describe("temporal annotation expandCanonical", () => {
  it("expands a year to Jan 1 .. Dec 31", () => {
    expect(expandCanonical("2026")).toEqual({
      startMs: Date.UTC(2026, 0, 1),
      endMs: Date.UTC(2027, 0, 1) - 1,
      precision: "year",
    });
  });
  it("expands a month to its first .. last day", () => {
    expect(expandCanonical("2026-07")).toEqual({
      startMs: Date.UTC(2026, 6, 1),
      endMs: Date.UTC(2026, 7, 1) - 1,
      precision: "month",
    });
  });
  it("expands a day to that whole day", () => {
    expect(expandCanonical("2026-07-08")).toEqual({
      startMs: Date.UTC(2026, 6, 8),
      endMs: Date.UTC(2026, 6, 9) - 1,
      precision: "day",
    });
  });
  it("keeps an ISO instant as a point", () => {
    const iso = "2026-07-08T14:30:00.000Z";
    const t = Date.parse(iso);
    expect(expandCanonical(iso)).toEqual({ startMs: t, endMs: t, precision: "instant" });
  });
  it("rejects garbage", () => {
    expect(expandCanonical("next tuesday")).toBeNull();
    expect(expandCanonical("07/08")).toBeNull();
  });
});

describe("temporal annotation storage", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    upsertDocuments(db, [makeDoc("d1"), makeDoc("d2")]);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function docId(ext: string): string {
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }

  it("inserts an entry with doc links and reads it back by overlap", () => {
    const d1 = docId("d1");
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_1",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "passport expires",
        kind: "expiry",
        documentIds: [d1, "nonexistent-doc"],
        createdByRun: "run_a",
      },
      1_700_000_000_000,
    );
    // Point query inside the day hits it.
    const hits = queryTemporalAnnotationOverlap(db, JULY_8_2026, JULY_8_2026);
    expect(hits).toHaveLength(1);
    expect(hits[0].sentence).toBe("passport expires");
    // Only the real doc is linked (the dangling id is dropped).
    expect(hits[0].documentIds).toEqual([d1]);
  });

  it("overlap: a now..now+7d window catches a straddling month and a precise day", () => {
    const month = expandCanonical("2026-07")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_month",
        intervalStartMs: month.startMs,
        intervalEndMs: month.endMs,
        precision: "month",
        canonical: "2026-07",
        sentence: "July thing",
        documentIds: [],
        createdByRun: "r",
      },
      1,
    );
    const far = expandCanonical("2026-12-25")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_far",
        intervalStartMs: far.startMs,
        intervalEndMs: far.endMs,
        precision: "day",
        canonical: "2026-12-25",
        sentence: "Christmas",
        documentIds: [],
        createdByRun: "r",
      },
      1,
    );
    const weekEnd = JULY_8_2026 + 7 * 86_400_000;
    const hits = queryTemporalAnnotationOverlap(db, JULY_8_2026, weekEnd);
    // The month straddles the window; the December day does not.
    expect(hits.map((h) => h.id)).toEqual(["tix_month"]);
  });

  it("update re-times an entry and replaces its doc links", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_u",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "old",
        documentIds: [d1],
        projectionIds: ["tp_one", "not-a-projection"],
        createdByRun: "r",
      },
      1,
    );
    expect(getTemporalAnnotationById(db, "tix_u")).toMatchObject({
      projectionIds: ["tp_one"],
      revision: 1,
    });
    const moved = expandCanonical("2026-09-01")!;
    const ok = updateTemporalAnnotation(
      db,
      "tix_u",
      {
        intervalStartMs: moved.startMs,
        intervalEndMs: moved.endMs,
        precision: "day",
        canonical: "2026-09-01",
        sentence: "rescheduled",
        documentIds: [d2],
        projectionIds: ["tp_two"],
      },
      2,
    );
    expect(ok).toBe(true);
    // No longer overlaps July 8...
    expect(queryTemporalAnnotationOverlap(db, JULY_8_2026, JULY_8_2026)).toHaveLength(0);
    // ...but does on Sep 1, with the new sentence + swapped doc.
    const sep = queryTemporalAnnotationOverlap(db, Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 1));
    expect(sep[0].sentence).toBe("rescheduled");
    expect(sep[0].documentIds).toEqual([d2]);
    expect(sep[0].projectionIds).toEqual(["tp_two"]);
    expect(sep[0].revision).toBe(2);

    expect(invalidateTemporalAnnotation(db, "tix_u", 3)).toBe(true);
    expect(
      db.prepare("SELECT revision FROM temporal_annotations WHERE id = 'tix_u'").get(),
    ).toEqual({ revision: 3 });
  });

  it("update returns false for an unknown/invalidated id", () => {
    expect(updateTemporalAnnotation(db, "nope", { sentence: "x" }, 1)).toBe(false);
  });

  it("invalidate (delete) removes an entry from queries but keeps it out of live counts", () => {
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_del",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "cancel me",
        documentIds: [],
        createdByRun: "r",
      },
      1,
    );
    expect(invalidateTemporalAnnotation(db, "tix_del", 2)).toBe(true);
    expect(queryTemporalAnnotationOverlap(db, JULY_8_2026, JULY_8_2026)).toHaveLength(0);
    expect(countTemporalAnnotations(db)).toBe(0);
    // A second delete is a no-op.
    expect(invalidateTemporalAnnotation(db, "tix_del", 3)).toBe(false);
  });

  it("privacy cascade hard-purges entries citing a deleted document, sparing doc-less ones", () => {
    const d1 = docId("d1");
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_linked",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "derived from d1",
        documentIds: [d1],
        createdByRun: "r",
      },
      1,
    );
    insertTemporalAnnotation(
      db,
      {
        id: "tix_docless",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: "agent-added, no source",
        documentIds: [],
        createdByRun: "r",
      },
      1,
    );
    const purged = cascadeTemporalAnnotationPrivacyDelete(db, [d1]);
    expect(purged).toEqual(["tix_linked"]);
    const remaining = queryTemporalAnnotationOverlap(db, JULY_8_2026, JULY_8_2026);
    expect(remaining.map((r) => r.id)).toEqual(["tix_docless"]);
    // The link row is gone too (ON DELETE CASCADE).
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM temporal_annotation_documents").get() as {
        c: number;
      },
    ).toEqual({ c: 0 });
  });

  it("the privacy cascade purges an annotation AFTER its document row is gone", () => {
    const d1 = docId("d1");
    const day = expandCanonical("2026")!;
    insertTemporalAnnotation(
      db,
      {
        id: "tix_fk",
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "year",
        canonical: "2026",
        sentence: "from d1",
        documentIds: [d1],
        createdByRun: "r",
      },
      1,
    );
    // The production ordering: the write gate deletes the document rows
    // FIRST, and only then does the service run the purge over the returned
    // ids. The link row must therefore survive a raw document delete —
    // deliberately no FK on `document_id` — or the purge finds nothing and
    // an annotation about a deleted document stays live and queryable.
    db.prepare("DELETE FROM documents WHERE id = ?").run(d1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM temporal_annotation_documents WHERE document_id = ?")
        .get(d1),
    ).toEqual({ c: 1 });

    const purged = cascadeTemporalAnnotationPrivacyDelete(db, [d1]);
    expect(purged).toEqual(["tix_fk"]);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM temporal_annotations WHERE id = 'tix_fk'").get(),
    ).toEqual({ c: 0 });
    // The links die with their annotation (the annotation-side FK stays).
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM temporal_annotation_documents WHERE document_id = ?")
        .get(d1),
    ).toEqual({ c: 0 });
  });
});

describe("temporal annotation window / doc-invalidation reads", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    upsertDocuments(db, [makeDoc("d1"), makeDoc("d2")]);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function docId(ext: string): string {
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }

  /** A day entry on 2026-07-08 unless the override re-times it. */
  function seed(id: string, over: Partial<CreateTemporalAnnotationInput> = {}, now = 1_000): void {
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id,
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: `entry ${id}`,
        documentIds: [],
        createdByRun: "r",
        ...over,
      },
      now,
    );
  }

  describe("queryTemporalAnnotationWindow", () => {
    it("includes entries straddling either window edge (inclusive), excludes disjoint ones", () => {
      const wStart = Date.UTC(2026, 6, 10);
      const wEnd = Date.UTC(2026, 6, 20);
      // Ends exactly on the window's first ms — still overlaps.
      seed("tix_left", { intervalStartMs: Date.UTC(2026, 6, 5), intervalEndMs: wStart });
      // Starts exactly on the window's last ms — still overlaps.
      seed("tix_right", { intervalStartMs: wEnd, intervalEndMs: Date.UTC(2026, 6, 25) });
      // Encloses the whole window.
      seed("tix_enclose", {
        intervalStartMs: Date.UTC(2026, 6, 1),
        intervalEndMs: Date.UTC(2026, 6, 31),
      });
      // Fully inside.
      seed("tix_inside", {
        intervalStartMs: Date.UTC(2026, 6, 12),
        intervalEndMs: Date.UTC(2026, 6, 13),
      });
      // Ends 1ms before the window / starts 1ms after it — disjoint.
      seed("tix_before", { intervalStartMs: Date.UTC(2026, 6, 1), intervalEndMs: wStart - 1 });
      seed("tix_after", { intervalStartMs: wEnd + 1, intervalEndMs: Date.UTC(2026, 6, 25) });

      const hits = queryTemporalAnnotationWindow(db, { startMs: wStart, endMs: wEnd });
      // Ordered by interval start ascending.
      expect(hits.map((h) => h.id)).toEqual(["tix_enclose", "tix_left", "tix_inside", "tix_right"]);
    });

    it("kinds filter narrows to the requested set (a NULL kind never matches a filter)", () => {
      seed("tix_deadline", { kind: "deadline" });
      seed("tix_expiry", { kind: "expiry" });
      seed("tix_event", { kind: "event" });
      seed("tix_kindless", { kind: null });

      const day = expandCanonical("2026-07-08")!;
      const hits = queryTemporalAnnotationWindow(db, {
        startMs: day.startMs,
        endMs: day.endMs,
        kinds: ["deadline", "expiry"],
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["tix_deadline", "tix_expiry"]);
    });

    it("empty-string kind tokens are dropped, leaving the filter off", () => {
      seed("tix_deadline", { kind: "deadline" });
      seed("tix_kindless", { kind: null });
      const day = expandCanonical("2026-07-08")!;
      const hits = queryTemporalAnnotationWindow(db, {
        startMs: day.startMs,
        endMs: day.endMs,
        kinds: ["", ""],
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["tix_deadline", "tix_kindless"]);
    });

    it("an over-max limit clamps instead of throwing or zeroing the read", () => {
      for (let i = 0; i < 5; i++) seed(`tix_${String(i).padStart(2, "0")}`);
      const day = expandCanonical("2026-07-08")!;
      const hits = queryTemporalAnnotationWindow(db, {
        startMs: day.startMs,
        endMs: day.endMs,
        limit: 99_999,
      });
      expect(hits).toHaveLength(5);
    });

    it("limit caps the result count and clamps to a floor of 1", () => {
      seed("tix_1", { intervalStartMs: Date.UTC(2026, 6, 8), intervalEndMs: Date.UTC(2026, 6, 8) });
      seed("tix_2", { intervalStartMs: Date.UTC(2026, 6, 9), intervalEndMs: Date.UTC(2026, 6, 9) });
      seed("tix_3", {
        intervalStartMs: Date.UTC(2026, 6, 10),
        intervalEndMs: Date.UTC(2026, 6, 10),
      });
      const window = { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 6, 31) };
      // Caps at `limit`, keeping the chronologically-first entries.
      expect(queryTemporalAnnotationWindow(db, { ...window, limit: 2 }).map((h) => h.id)).toEqual([
        "tix_1",
        "tix_2",
      ]);
      // A nonsensical limit clamps to 1 rather than returning nothing.
      expect(queryTemporalAnnotationWindow(db, { ...window, limit: 0 })).toHaveLength(1);
    });

    it("orders by interval start, then id as the stable tiebreaker", () => {
      // Same start, ids inserted in reverse lexicographic order.
      seed("tix_b", { intervalStartMs: Date.UTC(2026, 6, 8), intervalEndMs: Date.UTC(2026, 6, 8) });
      seed("tix_a", { intervalStartMs: Date.UTC(2026, 6, 8), intervalEndMs: Date.UTC(2026, 6, 8) });
      // Earlier start inserted last still leads.
      seed("tix_c", { intervalStartMs: Date.UTC(2026, 6, 7), intervalEndMs: Date.UTC(2026, 6, 7) });

      const hits = queryTemporalAnnotationWindow(db, {
        startMs: Date.UTC(2026, 6, 1),
        endMs: Date.UTC(2026, 6, 31),
      });
      expect(hits.map((h) => h.id)).toEqual(["tix_c", "tix_a", "tix_b"]);
    });

    it("excludes invalidated entries", () => {
      seed("tix_live");
      seed("tix_dead");
      expect(invalidateTemporalAnnotation(db, "tix_dead", 2)).toBe(true);
      const day = expandCanonical("2026-07-08")!;
      const hits = queryTemporalAnnotationWindow(db, { startMs: day.startMs, endMs: day.endMs });
      expect(hits.map((h) => h.id)).toEqual(["tix_live"]);
    });
  });

  describe("getTemporalAnnotationById", () => {
    it("returns a live entry; invalidated and unknown ids are null", () => {
      const d1 = docId("d1");
      seed("tix_live", { kind: "expiry", documentIds: [d1] }, 1234);
      const e = getTemporalAnnotationById(db, "tix_live");
      expect(e).toMatchObject({
        id: "tix_live",
        kind: "expiry",
        createdAt: 1234,
        updatedAt: 1234,
        documentIds: [d1],
      });
      expect(getTemporalAnnotationById(db, "tix_missing")).toBeNull();
      invalidateTemporalAnnotation(db, "tix_live", 2000);
      expect(getTemporalAnnotationById(db, "tix_live")).toBeNull();
    });
  });

  describe("hasLiveTemporalAnnotationsForDoc / invalidateTemporalAnnotationsForDoc", () => {
    it("hasLive sees only live entries citing that document", () => {
      const d1 = docId("d1");
      const d2 = docId("d2");
      expect(hasLiveTemporalAnnotationsForDoc(db, d1)).toBe(false);
      seed("tix_d1", { documentIds: [d1] });
      expect(hasLiveTemporalAnnotationsForDoc(db, d1)).toBe(true);
      expect(hasLiveTemporalAnnotationsForDoc(db, d2)).toBe(false);
      invalidateTemporalAnnotation(db, "tix_d1", 2);
      expect(hasLiveTemporalAnnotationsForDoc(db, d1)).toBe(false);
    });

    it("invalidates entries whose atoms all break, keeps ungrounded ones, and is idempotent", () => {
      const d1 = docId("d1");
      const d2 = docId("d2");
      seed("tix_d1a", {
        documentIds: [d1],
        evidence: [{ docId: d1, quote: "a quote the document never held" }],
      });
      seed("tix_d1b", {
        documentIds: [d1],
        evidence: [{ docId: d1, quote: "another absent quote" }],
      });
      // Atom-less: the change carries no evidence against it → kept.
      seed("tix_d1_plain", { documentIds: [d1] });
      seed("tix_d2", { documentIds: [d2] });
      seed("tix_docless");

      expect(invalidateTemporalAnnotationsForDoc(db, d1, 2000)).toEqual({
        invalidated: 2,
        kept: 1,
        atomsBroken: 2,
        atomsHealed: 0,
        resurrected: 0,
      });
      expect(getTemporalAnnotationById(db, "tix_d1a")).toBeNull();
      expect(getTemporalAnnotationById(db, "tix_d1b")).toBeNull();
      expect(getTemporalAnnotationById(db, "tix_d1_plain")).not.toBeNull();
      // Entries citing another doc — or none — are untouched.
      expect(getTemporalAnnotationById(db, "tix_d2")).not.toBeNull();
      expect(getTemporalAnnotationById(db, "tix_docless")).not.toBeNull();
      // Idempotent: the casualties stay down, the ungrounded entry stays kept.
      expect(invalidateTemporalAnnotationsForDoc(db, d1, 3000)).toEqual({
        invalidated: 0,
        kept: 1,
        atomsBroken: 0,
        atomsHealed: 0,
        resurrected: 0,
      });
    });

    it("spares an entry re-timed AFTER the content-change event (updated_at <= now guard)", () => {
      const d1 = docId("d1");
      const absent = (q: string) => [{ docId: d1, quote: q }];
      seed("tix_old", { documentIds: [d1], evidence: absent("first absent quote") }, 1000);
      seed("tix_retimed", { documentIds: [d1], evidence: absent("second absent quote") }, 1000);
      // The agent re-times tix_retimed against the NEW content; that write
      // lands on the writer before the queued invalidate does.
      expect(
        updateTemporalAnnotation(
          db,
          "tix_retimed",
          { sentence: "re-timed against new content" },
          3000,
        ),
      ).toBe(true);

      // The invalidate carries the (earlier) event time — only the stale entry drops.
      expect(invalidateTemporalAnnotationsForDoc(db, d1, 2000)).toMatchObject({ invalidated: 1 });
      expect(getTemporalAnnotationById(db, "tix_old")).toBeNull();
      expect(getTemporalAnnotationById(db, "tix_retimed")).not.toBeNull();
      // A later event time catches the re-timed entry too.
      expect(invalidateTemporalAnnotationsForDoc(db, d1, 5000)).toMatchObject({ invalidated: 1 });
      expect(getTemporalAnnotationById(db, "tix_retimed")).toBeNull();
    });
  });

  describe("entry ↔ loop / person backlinks", () => {
    const day = expandCanonical("2026-07-08")!;
    function seedEntry(id: string, over: Partial<CreateTemporalAnnotationInput> = {}): void {
      insertTemporalAnnotation(
        db,
        {
          id,
          intervalStartMs: day.startMs,
          intervalEndMs: day.endMs,
          precision: "day",
          canonical: "2026-07-08",
          sentence: "deadline",
          kind: "deadline",
          documentIds: [],
          createdByRun: "run_a",
          ...over,
        },
        1_000,
      );
    }
    function seedLoop(id: string): void {
      createOpenLoop(
        db,
        { id, createdByRun: "run_a", confidence: 0.9, importance: 0.5, title: "L", docs: [] },
        1_000,
      );
    }

    it("links existing loops + arbitrary people, drops unknown loops, hydrates both", () => {
      seedLoop("olp_1");
      seedEntry("tix_1", {
        loopIds: ["olp_1", "olp_missing"],
        personIds: ["per_a", "per_b"],
      });
      const e = getTemporalAnnotationById(db, "tix_1")!;
      // Unknown loop dropped (FK-checked); people written as-is (no FK).
      expect(e.loopIds).toEqual(["olp_1"]);
      expect(e.personIds).toEqual(["per_a", "per_b"]);
    });

    it("reverse readers return live linked entries, excluding invalidated + unlinked", () => {
      seedLoop("olp_1");
      seedEntry("tix_live", { loopIds: ["olp_1"], personIds: ["per_a"] });
      seedEntry("tix_dead", { loopIds: ["olp_1"], personIds: ["per_a"] });
      seedEntry("tix_other", { loopIds: [], personIds: [] });
      invalidateTemporalAnnotation(db, "tix_dead", 2_000);

      expect(listTemporalAnnotationsForLoop(db, "olp_1").map((e) => e.id)).toEqual(["tix_live"]);
      expect(listTemporalAnnotationsForPerson(db, "per_a").map((e) => e.id)).toEqual(["tix_live"]);
      expect(listTemporalAnnotationsForLoop(db, "olp_none")).toEqual([]);
      expect(listTemporalAnnotationsForPerson(db, "per_none")).toEqual([]);
    });

    it("merge-equivalence: entries linked to a merged-away id surface once on the canonical", () => {
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at, merged_into)
         VALUES ('per_canon','C','test','2026-01-01','2026-01-01','2026-01-01','2026-01-01',NULL),
                ('per_loser','L','test','2026-01-01','2026-01-01','2026-01-01','2026-01-01','per_canon')`,
      ).run();
      seedEntry("tix_loser", { personIds: ["per_loser"] }); // authored against the loser
      seedEntry("tix_both", { personIds: ["per_canon", "per_loser"] }); // linked to both
      // Merge-recall (would FAIL on the old `WHERE person_id = ?`): the loser's
      // entry surfaces on the canonical; the both-linked entry appears EXACTLY
      // once (GROUP BY, not double via the merge OR-clause).
      expect(
        listTemporalAnnotationsForPerson(db, "per_canon")
          .map((e) => e.id)
          .sort(),
      ).toEqual(["tix_both", "tix_loser"]);
    });

    it("loop delete cascades its entry_loops rows; the entry survives", () => {
      seedLoop("olp_1");
      seedEntry("tix_1", { loopIds: ["olp_1"] });
      expect(listTemporalAnnotationsForLoop(db, "olp_1")).toHaveLength(1);
      deleteOpenLoop(db, "olp_1");
      // The join row is gone (FK ON DELETE CASCADE), but the entry remains.
      expect(listTemporalAnnotationsForLoop(db, "olp_1")).toEqual([]);
      expect(getTemporalAnnotationById(db, "tix_1")).not.toBeNull();
    });

    it("privacy-delete of a cited doc cascades the entry AND its loop/person links", () => {
      seedLoop("olp_1");
      const d1 = docId("d1");
      seedEntry("tix_1", { documentIds: [d1], loopIds: ["olp_1"], personIds: ["per_a"] });
      cascadeTemporalAnnotationPrivacyDelete(db, [d1]);
      expect(getTemporalAnnotationById(db, "tix_1")).toBeNull();
      expect(listTemporalAnnotationsForLoop(db, "olp_1")).toEqual([]);
      expect(listTemporalAnnotationsForPerson(db, "per_a")).toEqual([]);
    });

    it("update replaces loop/person link sets wholesale; omitting leaves them intact", () => {
      seedLoop("olp_1");
      seedLoop("olp_2");
      seedEntry("tix_1", { loopIds: ["olp_1"], personIds: ["per_a"] });
      // Replace loops, leave people untouched (omitted).
      updateTemporalAnnotation(db, "tix_1", { loopIds: ["olp_2"] }, 3_000);
      let e = getTemporalAnnotationById(db, "tix_1")!;
      expect(e.loopIds).toEqual(["olp_2"]);
      expect(e.personIds).toEqual(["per_a"]);
      // Clear people with an empty array.
      updateTemporalAnnotation(db, "tix_1", { personIds: [] }, 4_000);
      e = getTemporalAnnotationById(db, "tix_1")!;
      expect(e.personIds).toEqual([]);
    });

    it("listTemporalAnnotationsForDoc returns live entries citing a doc, excluding invalidated", () => {
      const d1 = docId("d1");
      seedEntry("tix_a", { documentIds: [d1] });
      seedEntry("tix_b", { documentIds: [d1] });
      seedEntry("tix_c", { documentIds: [] });
      invalidateTemporalAnnotation(db, "tix_b", 2_000);
      const ids = listTemporalAnnotationsForDoc(db, d1).map((e) => e.id);
      expect(ids).toEqual(["tix_a"]);
      expect(listTemporalAnnotationsForDoc(db, docId("d2"))).toEqual([]);
    });
  });
});

describe("temporal annotation evidence + surgical invalidation", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    upsertDocuments(db, [makeDoc("d1"), makeDoc("d2")]);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function docId(ext: string): string {
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }

  /** Unique content hash per rewrite — the quote-match LRU keys on it. */
  function setDocContent(id: string, content: string): void {
    db.prepare("UPDATE documents SET content = ?, content_hash = ? WHERE id = ?").run(
      content,
      `hash-${randomUUID()}`,
      id,
    );
  }

  function setDocMetadata(id: string, metadata: Record<string, unknown>): void {
    db.prepare("UPDATE documents SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }

  function seed(id: string, over: Partial<CreateTemporalAnnotationInput> = {}, now = 1_000): void {
    const day = expandCanonical("2026-07-08")!;
    insertTemporalAnnotation(
      db,
      {
        id,
        intervalStartMs: day.startMs,
        intervalEndMs: day.endMs,
        precision: "day",
        canonical: "2026-07-08",
        sentence: `entry ${id}`,
        documentIds: [],
        createdByRun: "r",
        ...over,
      },
      now,
    );
  }

  it("evidence atoms round-trip on insert; dangling doc ids are dropped", () => {
    const d1 = docId("d1");
    seed("tix_ev", {
      documentIds: [d1],
      evidence: [
        { docId: d1, quote: "race day is 2026-09-20" },
        { docId: "nonexistent-doc", quote: "never lands" },
      ],
    });
    expect(listTemporalAnnotationEvidence(db, "tix_ev")).toEqual([
      {
        annotationId: "tix_ev",
        position: 0,
        documentId: d1,
        quote: "race day is 2026-09-20",
        brokenAt: null,
      },
    ]);
  });

  it("update with evidence replaces the atom set and UNIONS its doc into the links", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    seed("tix_ev", { documentIds: [d1], evidence: [{ docId: d1, quote: "old quote" }] });

    // Re-ground on d2 without supplying documentIds: the atom set is
    // replaced, and d2 joins the links WITHOUT dropping the standing d1 link.
    expect(
      updateTemporalAnnotation(
        db,
        "tix_ev",
        { evidence: [{ docId: d2, quote: "new quote" }] },
        2_000,
      ),
    ).toBe(true);
    expect(listTemporalAnnotationEvidence(db, "tix_ev")).toEqual([
      { annotationId: "tix_ev", position: 0, documentId: d2, quote: "new quote", brokenAt: null },
    ]);
    expect(getTemporalAnnotationById(db, "tix_ev")!.documentIds).toEqual([d1, d2].sort());

    // A simultaneous documentIds replacement still keeps the evidence doc.
    expect(
      updateTemporalAnnotation(
        db,
        "tix_ev",
        { documentIds: [d1], evidence: [{ docId: d2, quote: "newer quote" }] },
        3_000,
      ),
    ).toBe(true);
    expect(getTemporalAnnotationById(db, "tix_ev")!.documentIds).toEqual([d1, d2].sort());

    // Omitted evidence leaves the atom set untouched.
    expect(updateTemporalAnnotation(db, "tix_ev", { sentence: "still grounded" }, 4_000)).toBe(
      true,
    );
    expect(listTemporalAnnotationEvidence(db, "tix_ev").map((e) => e.quote)).toEqual([
      "newer quote",
    ]);
  });

  it("churn survival: a surviving quote keeps the entry; a dropped quote breaks and invalidates", () => {
    const d1 = docId("d1");
    setDocContent(
      d1,
      "Team dinner confirmed for 2026-07-20 at the riverside venue. See you there.",
    );
    seed("tix_churn", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "dinner confirmed for 2026-07-20" }],
    });

    // Appended-to doc (a chat thread's daily doc growing): the quote survives.
    setDocContent(
      d1,
      "Team dinner confirmed for 2026-07-20 at the riverside venue. See you there. Maya: bringing dessert.",
    );
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_churn")).not.toBeNull();
    expect(listTemporalAnnotationEvidence(db, "tix_churn")[0]!.brokenAt).toBeNull();

    // Rewrite that drops the quote: the only atom breaks, the entry dies.
    setDocContent(d1, "Dinner moved to 2026-07-27, venue to be confirmed.");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 3_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_churn")).toBeNull();
    expect(listTemporalAnnotationEvidence(db, "tix_churn")[0]!.brokenAt).toBe(3_000);
  });

  it("evidence on doc A keeps the entry through churn on linked doc B", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Invoice INV-2041 due 2026-08-15.");
    seed("tix_ab", {
      documentIds: [d1, d2],
      evidence: [{ docId: d1, quote: "due 2026-08-15" }],
    });
    setDocContent(d2, "completely rewritten body");
    expect(invalidateTemporalAnnotationsForDoc(db, d2, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_ab")).not.toBeNull();
  });

  it("a curly-apostrophe quote survives churn on a straight-apostrophe doc", () => {
    const d1 = docId("d1");
    setDocContent(d1, "Registration doesn't close until 2026-09-01. More entries welcome.");
    // The agent quoted the doc with a typographic apostrophe — the shared
    // normalizer folds it, so the atom is judged live, not broken.
    seed("tix_curly", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "doesn’t close until 2026-09-01" }],
    });
    setDocContent(d1, "Registration doesn't close until 2026-09-01. Fee unchanged.");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_curly")).not.toBeNull();
  });

  it("a vanished document breaks its atoms; other-doc atoms still carry the entry", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Workshop on 2026-07-30.");
    setDocContent(d2, "Reminder: workshop 2026-07-30.");
    seed("tix_two", {
      documentIds: [d1, d2],
      evidence: [
        { docId: d1, quote: "Workshop on 2026-07-30" },
        { docId: d2, quote: "workshop 2026-07-30" },
      ],
    });
    // Simulate a deletion path no cascade saw: the doc row vanishes but the
    // link row stays (FK enforcement off mimics a raw maintenance delete).
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM documents WHERE id = ?").run(d1);
    db.pragma("foreign_keys = ON");

    // Doc gone → no quote survives → d1's atom breaks; d2's still grounds it.
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_two")).not.toBeNull();
    const atoms = listTemporalAnnotationEvidence(db, "tix_two");
    expect(atoms.find((a) => a.documentId === d1)!.brokenAt).toBe(2_000);
    expect(atoms.find((a) => a.documentId === d2)!.brokenAt).toBeNull();
  });

  it("no-evidence entries: kept on content change, invalidated when the doc row is gone", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    // Content changed but the entry carries no quote to judge it by: the
    // linked doc may be merely supporting (the entry's real basis elsewhere),
    // so the change is no evidence against it — the entry is KEPT and the
    // data run the same change wakes re-checks it.
    seed("tix_plain", { documentIds: [d1] });
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_plain")).not.toBeNull();

    // The doc row itself vanished via a path no cascade saw: nothing is left
    // to re-check against, so the ungrounded entry blanket-invalidates.
    seed("tix_gone", { documentIds: [d2] });
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM documents WHERE id = ?").run(d2);
    db.pragma("foreign_keys = ON");
    expect(invalidateTemporalAnnotationsForDoc(db, d2, 3_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_gone")).toBeNull();

    // Evidence still judges: a broken quote invalidates its entry while the
    // ungrounded sibling keeps being kept.
    setDocContent(d1, "rewrite without the quote");
    seed("tix_ev", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "a quote the rewrite dropped" }],
    });
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 5_000)).toEqual({
      invalidated: 1,
      kept: 1,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_ev")).toBeNull();
    expect(getTemporalAnnotationById(db, "tix_plain")).not.toBeNull();
  });

  it("listTemporalAnnotationsAwaitingRefile lists every unpresented casualty, newest first", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    // Each entry is grounded in its own word of the document; rewrites drop
    // one word at a time so the churn passes stamp distinct invalidation
    // times ("omega" always survives, keeping tix_live alive).
    setDocContent(d1, "alpha beta gamma delta omega");
    for (const [id, quote] of [
      ["tix_early", "alpha"],
      ["tix_a", "beta"],
      ["tix_b", "gamma"],
      ["tix_c", "delta"],
      ["tix_live", "omega"],
    ] as const) {
      seed(id, { documentIds: [d1], kind: "deadline", evidence: [{ docId: d1, quote }] }, 100);
    }
    for (const [content, at] of [
      ["beta gamma delta omega", 500],
      ["gamma delta omega", 1_000],
      ["delta omega", 2_000],
      ["omega", 3_000],
    ] as const) {
      setDocContent(d1, content);
      expect(invalidateTemporalAnnotationsForDoc(db, d1, at)).toMatchObject({ invalidated: 1 });
    }
    // A deliberate delete inside the window never surfaces in the read.
    seed("tix_removed", { documentIds: [d1], kind: "deadline" }, 100);
    invalidateTemporalAnnotation(db, "tix_removed", 2_600);
    // Churn on the OTHER doc stays out of d1's read.
    setDocContent(d2, "sigma");
    seed("tix_other_doc", { documentIds: [d2], evidence: [{ docId: d2, quote: "sigma" }] }, 100);
    setDocContent(d2, "tau");
    expect(invalidateTemporalAnnotationsForDoc(db, d2, 2_500)).toMatchObject({ invalidated: 1 });

    // No time bound: EVERY unpresented content-change casualty is listed.
    // The invalidation is stamped at document-event time, before the run it
    // wakes even exists — a window keyed on run timestamps would open after
    // the very event it is meant to catch.
    const hits = listTemporalAnnotationsAwaitingRefile(db, d1, 10);
    expect(hits.map((h) => h.id)).toEqual(["tix_c", "tix_b", "tix_a", "tix_early"]);
    expect(hits[0]).toMatchObject({
      id: "tix_c",
      sentence: "entry tix_c",
      canonical: "2026-07-08",
      kind: "deadline",
      invalidatedAt: 3_000,
    });
    // The limit clips from the most recent end.
    expect(listTemporalAnnotationsAwaitingRefile(db, d1, 2).map((h) => h.id)).toEqual([
      "tix_c",
      "tix_b",
    ]);

    // Presented-run retirement: a casualty presented to a COMPLETED run is
    // settled; a failed (or still-pending) presentation re-presents. A stamp
    // whose run row no longer exists also counts as settled — unsettled rows
    // are never pruned, so a dangling stamp can only mean the retention
    // sweep removed a settled presenting run, and its decision stands.
    const insertRun = db.prepare(
      "INSERT INTO cognition_runs (id, kind, status, next_attempt_at, enqueued_at) VALUES (?, 'data', ?, 0, 0)",
    );
    insertRun.run("run_done", "completed");
    insertRun.run("run_failed", "failed");
    markTemporalAnnotationsRefilePresented(db, ["tix_c", "tix_b"], "run_done");
    markTemporalAnnotationsRefilePresented(db, ["tix_a"], "run_failed");
    markTemporalAnnotationsRefilePresented(db, ["tix_early"], "run_pruned_by_retention");
    expect(listTemporalAnnotationsAwaitingRefile(db, d1, 10).map((h) => h.id)).toEqual(["tix_a"]);

    // A fresh invalidation clears the marker: tix_c's word returns (heal +
    // resurrect), then drops again — the new casualty is pending once more
    // even though its earlier presentation completed.
    setDocContent(d1, "delta omega");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 4_000)).toMatchObject({ resurrected: 1 });
    setDocContent(d1, "omega");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 5_000)).toMatchObject({ invalidated: 1 });
    expect(listTemporalAnnotationsAwaitingRefile(db, d1, 10).map((h) => h.id)).toEqual([
      "tix_c",
      "tix_a",
    ]);
  });

  it("a casualty tied to the doc only through an evidence atom is still presented", () => {
    const d1 = docId("d1");
    setDocContent(d1, "Studio rewiring completes 2027-02-10.");
    seed("tix_atom_tie", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "completes 2027-02-10" }],
    });
    // A link row lost via a path the store never saw: the atom must still key
    // the re-file read, mirroring the invalidator's own candidacy.
    db.prepare(
      "DELETE FROM temporal_annotation_documents WHERE annotation_id = 'tix_atom_tie'",
    ).run();
    setDocContent(d1, "rewiring rescheduled");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toMatchObject({ invalidated: 1 });
    expect(listTemporalAnnotationsAwaitingRefile(db, d1, 10).map((h) => h.id)).toEqual([
      "tix_atom_tie",
    ]);
  });

  it("listUngroundedTemporalAnnotationsForDoc lists live atom-less entries citing the doc", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Fixture content carrying the quote.");
    setDocContent(d2, "Sibling fixture.");
    seed("tix_ungrounded", { documentIds: [d1] });
    seed("tix_grounded", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "carrying the quote" }],
    });
    seed("tix_other", { documentIds: [d2] });
    expect(listUngroundedTemporalAnnotationsForDoc(db, d1, 10).map((h) => h.id)).toEqual([
      "tix_ungrounded",
    ]);

    // Re-grounding is the intended exit: an update that supplies evidence
    // gives the entry an unbroken atom, and it leaves the ungrounded read.
    expect(
      updateTemporalAnnotation(
        db,
        "tix_ungrounded",
        { evidence: [{ docId: d1, quote: "carrying the quote" }] },
        1_500,
      ),
    ).toBe(true);
    expect(listUngroundedTemporalAnnotationsForDoc(db, d1, 10)).toEqual([]);

    // An entry never sits in both reads at once: break the grounded
    // sibling's quote and it moves from neither list to the re-file read.
    setDocContent(d1, "fixture content rewritten");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toMatchObject({ invalidated: 2 });
    expect(listUngroundedTemporalAnnotationsForDoc(db, d1, 10)).toEqual([]);
    expect(
      listTemporalAnnotationsAwaitingRefile(db, d1, 10)
        .map((h) => h.id)
        .sort(),
    ).toEqual(["tix_grounded", "tix_ungrounded"]);
  });

  it("re-pointed links never detach a grounded entry (live atoms' docs are re-unioned)", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Keynote scheduled for 2026-11-03 at the main hall.");
    seed("tix_repoint", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "scheduled for 2026-11-03" }],
    });

    // The steward re-points the link set at d2 without re-grounding; the live
    // atom's doc is re-unioned, so the entry stays keyed to d1.
    expect(updateTemporalAnnotation(db, "tix_repoint", { documentIds: [d2] }, 1_500)).toBe(true);
    expect(getTemporalAnnotationById(db, "tix_repoint")!.documentIds).toEqual([d1, d2].sort());

    // d1 rewritten without the quote → the entry is still judged, and dies.
    setDocContent(d1, "schedule to be confirmed");
    expect(hasLiveTemporalAnnotationsForDoc(db, d1)).toBe(true);
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_repoint")).toBeNull();
  });

  it("evidence atoms key the guard and the candidate read when the link row is gone", () => {
    const d1 = docId("d1");
    setDocContent(d1, "Lease ends 2026-12-31.");
    seed("tix_atomkey", { documentIds: [d1], evidence: [{ docId: d1, quote: "ends 2026-12-31" }] });
    // Model link/atom drift (a link row lost via a path the store never saw):
    // the atom must still key both reads.
    db.prepare(
      "DELETE FROM temporal_annotation_documents WHERE annotation_id = 'tix_atomkey'",
    ).run();

    expect(hasLiveTemporalAnnotationsForDoc(db, d1)).toBe(true);
    setDocContent(d1, "lease terms updated");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_atomkey")).toBeNull();
  });

  it("an atom whose own evidence doc vanished no longer grounds the entry", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Fair on 2026-08-22.");
    setDocContent(d2, "Fair confirmed for 2026-08-22.");
    seed("tix_vanish", {
      documentIds: [d1, d2],
      evidence: [
        { docId: d1, quote: "on 2026-08-22" },
        { docId: d2, quote: "confirmed for 2026-08-22" },
      ],
    });
    // d2's row vanishes via a path no cascade saw.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM documents WHERE id = ?").run(d2);
    db.pragma("foreign_keys = ON");

    // Churn on d1 drops its quote; the d2 atom cannot carry the entry —
    // its document no longer exists.
    setDocContent(d1, "date moved");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 2,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_vanish")).toBeNull();
  });

  it("stamps 'content_change' on churn casualties and 'deleted' on deliberate removals", () => {
    const d1 = docId("d1");
    const cause = (id: string): string | null =>
      (
        db
          .prepare<
            [string],
            { c: string | null }
          >("SELECT invalidation_cause AS c FROM temporal_annotations WHERE id = ?")
          .get(id) as { c: string | null }
      ).c;
    seed("tix_churned", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "a quote the document never held" }],
    });
    seed("tix_removed", { documentIds: [d1] });
    expect(cause("tix_churned")).toBeNull();

    invalidateTemporalAnnotation(db, "tix_removed", 1_500);
    expect(cause("tix_removed")).toBe("deleted");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toMatchObject({ invalidated: 1 });
    expect(cause("tix_churned")).toBe("content_change");
  });

  it("a transient quote removal round-trips: the entry resurrects when the quote returns", () => {
    const d1 = docId("d1");
    setDocContent(d1, "Dentist appointment on 2026-08-14 at the riverside practice.");
    seed("tix_round", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "appointment on 2026-08-14" }],
    });

    // The quoted message is deleted: the only atom breaks, the entry dies.
    setDocContent(d1, "placeholder while the appointment is re-planned");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 1,
      kept: 0,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_round")).toBeNull();

    // The message is restored: the atom heals and the entry revives.
    setDocContent(d1, "Dentist appointment on 2026-08-14 at the riverside practice.");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 3_000)).toEqual({
      invalidated: 0,
      kept: 0,
      atomsBroken: 0,
      atomsHealed: 1,
      resurrected: 1,
    });
    const revived = getTemporalAnnotationById(db, "tix_round");
    expect(revived).not.toBeNull();
    // Invalidate + resurrect each bumped the revision; the cause is cleared.
    expect(revived!.revision).toBe(3);
    expect(
      db
        .prepare("SELECT invalidation_cause AS c FROM temporal_annotations WHERE id = 'tix_round'")
        .get(),
    ).toEqual({ c: null });
    expect(listTemporalAnnotationEvidence(db, "tix_round")[0]!.brokenAt).toBeNull();
  });

  it("a deliberately deleted entry never resurrects and never re-surfaces in the re-file read", () => {
    const d1 = docId("d1");
    setDocContent(d1, "Board review on 2026-10-02.");
    seed("tix_final", {
      documentIds: [d1],
      evidence: [{ docId: d1, quote: "review on 2026-10-02" }],
    });
    invalidateTemporalAnnotation(db, "tix_final", 2_000);

    // The quote is (still) present after a later change — the deleted entry
    // stays down all the same.
    setDocContent(d1, "Board review on 2026-10-02. Agenda attached.");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 3_000)).toEqual({
      invalidated: 0,
      kept: 0,
      atomsBroken: 0,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_final")).toBeNull();
    expect(listTemporalAnnotationsAwaitingRefile(db, d1, 10)).toEqual([]);
  });

  it("a healed atom counts toward survival on a later sibling-doc change", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    setDocContent(d1, "Retreat begins 2026-09-05.");
    setDocContent(d2, "Reminder: retreat starts 2026-09-05.");
    seed("tix_heal", {
      documentIds: [d1, d2],
      evidence: [
        { docId: d1, quote: "begins 2026-09-05" },
        { docId: d2, quote: "starts 2026-09-05" },
      ],
    });

    // d1 transiently loses its quote: that atom breaks, d2 carries the entry.
    setDocContent(d1, "retreat date under discussion");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 2_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });

    // d1 changes back: the atom heals on the still-live entry.
    setDocContent(d1, "Retreat begins 2026-09-05.");
    expect(invalidateTemporalAnnotationsForDoc(db, d1, 3_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 0,
      atomsHealed: 1,
      resurrected: 0,
    });

    // Now d2 drops its quote — the healed d1 atom keeps the entry alive.
    setDocContent(d2, "reminder withdrawn");
    expect(invalidateTemporalAnnotationsForDoc(db, d2, 4_000)).toEqual({
      invalidated: 0,
      kept: 1,
      atomsBroken: 1,
      atomsHealed: 0,
      resurrected: 0,
    });
    expect(getTemporalAnnotationById(db, "tix_heal")).not.toBeNull();
  });

  it("privacy cascade leaves no orphan evidence rows", () => {
    const d1 = docId("d1");
    const d2 = docId("d2");
    // tix_gone cites d1 (purged with it); tix_stays links only d2 but carries
    // a raw evidence atom citing d1 (no link row — bypasses the purge key).
    seed("tix_gone", {
      documentIds: [d1, d2],
      evidence: [
        { docId: d1, quote: "q1" },
        { docId: d2, quote: "q2" },
      ],
    });
    seed("tix_stays", { documentIds: [d2], evidence: [{ docId: d2, quote: "q3" }] });
    db.prepare(
      "INSERT INTO temporal_annotation_evidence (annotation_id, position, document_id, quote) VALUES ('tix_stays', 1, ?, 'embeds d1 content')",
    ).run(d1);

    expect(cascadeTemporalAnnotationPrivacyDelete(db, [d1])).toEqual(["tix_gone"]);
    // The purged annotation's atoms are gone, and the surviving annotation
    // lost exactly the atom that embedded the deleted doc's content.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM temporal_annotation_evidence WHERE document_id = ?")
          .get(d1) as { c: number }
      ).c,
    ).toBe(0);
    expect(listTemporalAnnotationEvidence(db, "tix_gone")).toEqual([]);
    expect(listTemporalAnnotationEvidence(db, "tix_stays").map((e) => e.quote)).toEqual(["q3"]);
  });
});
