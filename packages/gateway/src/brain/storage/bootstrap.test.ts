// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../../enrichment/dates/storage.js";
import { cognitionAuthoredDocumentTypes } from "../cognition-authored.js";
import {
  fetchBootstrapBatch,
  countPendingBootstrap,
  markDocsBootstrapProcessed,
  readmitFailedBootstrapDoc,
  bootstrapCorpusByMonth,
  BOOTSTRAP_EXCLUDE_DOC_TYPES,
  BOOTSTRAP_TERMINAL_READMISSIONS,
} from "./bootstrap.js";
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

/** A doc with a chosen documentType, ingest time, and source date. */
function makeDoc(ext: string, documentType: string, sourceCreatedAt: string): DocumentInput {
  return {
    providerId: "test" as DocumentInput["providerId"],
    sourceId: "test:acct" as DocumentInput["sourceId"],
    externalId: ext,
    title: "t",
    content: "body",
    contentHash: `hash-${ext}`,
    metadata: { documentType },
    sourceCreatedAt,
    sourceUpdatedAt: sourceCreatedAt,
  };
}

// Far-future so the period-end test always passes regardless of test clock.
const FUTURE = "2099-06-01";
const PAST = "2000-01-01";

describe("bootstrap work-list", () => {
  let db: Db;
  let path: string;
  // A floor far in the future: every fixture datum is older, so all of them
  // are on bootstrap's side of the live/historical boundary.
  const CUTOFF = "2100-01-01T00:00:00.000Z";

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function idOf(ext: string): string {
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }
  function giveDate(ext: string, resolvedStart: string): void {
    applyExtractedDates(db, [
      {
        truncated: false,
        id: idOf(ext),
        dates: [
          {
            kind: "date",
            resolvedStart,
            resolvedEnd: null,
            relative: false,
            text: resolvedStart,
            timex: resolvedStart,
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
  }

  it("selects email docs with a future date; excludes web docs and no-date/past docs", () => {
    upsertDocuments(db, [
      makeDoc("email-future", "email", "2020-01-01T00:00:00.000Z"),
      makeDoc("email-past", "email", "2019-01-01T00:00:00.000Z"),
      makeDoc("email-nodate", "email", "2018-01-01T00:00:00.000Z"),
      makeDoc("web-future", "webpage", "2021-01-01T00:00:00.000Z"),
      makeDoc("photo-future", "photo", "2017-01-01T00:00:00.000Z"),
    ]);
    giveDate("email-future", FUTURE);
    giveDate("email-past", PAST);
    // email-nodate: no extracted dates at all
    applyExtractedDates(db, [{ id: idOf("email-nodate"), dates: [] }]);
    giveDate("web-future", FUTURE);
    giveDate("photo-future", FUTURE);

    const rows = fetchBootstrapBatch(db, { recencyFloor: CUTOFF, batchSize: 50 });
    const exts = rows.map(
      (r) =>
        (
          db
            .prepare<
              [string],
              { external_id: string }
            >("SELECT external_id FROM documents WHERE id = ?")
            .get(r.docId) as { external_id: string }
        ).external_id,
    );
    expect(exts.sort()).toEqual(["email-future", "photo-future"]);
    expect(BOOTSTRAP_EXCLUDE_DOC_TYPES.has("webpage")).toBe(true);
  });

  it("excludes a cognition-authored source whose type it shares with the corpus", () => {
    // The type filter alone cannot catch an agent transcript: its type is
    // `conversation`, exactly like a real messaging thread. Only the source
    // column separates them, and the real thread must still be picked up.
    const transcript: DocumentInput = {
      ...makeDoc("chat-future", "conversation", "2015-01-01T00:00:00.000Z"),
      sourceId: "omnesis-chat" as DocumentInput["sourceId"],
      providerId: "system" as DocumentInput["providerId"],
    };
    const realThread: DocumentInput = {
      ...makeDoc("wa-future", "conversation", "2015-01-01T00:00:00.000Z"),
      sourceId: "whatsapp-messages:+15550100123" as DocumentInput["sourceId"],
      providerId: "whatsapp" as DocumentInput["providerId"],
    };
    upsertDocuments(db, [transcript, realThread]);
    giveDate("chat-future", FUTURE);
    giveDate("wa-future", FUTURE);

    const batch = fetchBootstrapBatch(db, { recencyFloor: CUTOFF, batchSize: 50 });
    const ids = batch.map((r) => r.docId);
    expect(ids).toContain(idOf("wa-future"));
    expect(ids).not.toContain(idOf("chat-future"));
    // The count query must scan the same population as the batch query, or the
    // enqueuer's backlog cap disagrees with what it can actually fetch.
    expect(countPendingBootstrap(db, CUTOFF)).toBe(batch.length);
  });

  it("excludes every exclusive cognition-authored document type, read from the registry", () => {
    // The retrospective lane must not buy a run to reason over the engine's own
    // output either. Driven by the registry rather than a literal, so
    // registering another source protects this lane without a second edit.
    const mirrorTypes = cognitionAuthoredDocumentTypes();
    expect(mirrorTypes.length).toBeGreaterThan(0);
    for (const type of mirrorTypes) {
      expect(BOOTSTRAP_EXCLUDE_DOC_TYPES.has(type)).toBe(true);
    }
  });

  it("orders recent → oldest by default, oldest → recent when asked", () => {
    upsertDocuments(db, [
      makeDoc("older", "email", "2015-01-01T00:00:00.000Z"),
      makeDoc("newer", "email", "2022-01-01T00:00:00.000Z"),
    ]);
    giveDate("older", FUTURE);
    giveDate("newer", FUTURE);
    const recent = fetchBootstrapBatch(db, { recencyFloor: CUTOFF, batchSize: 50 });
    expect(recent.map((r) => r.docId)).toEqual([idOf("newer"), idOf("older")]);
    const oldest = fetchBootstrapBatch(db, {
      recencyFloor: CUTOFF,
      batchSize: 50,
      direction: "oldest-first",
    });
    expect(oldest.map((r) => r.docId)).toEqual([idOf("older"), idOf("newer")]);
  });

  it("takes exactly the datums the live waker will not", () => {
    // The boundary is the datum's own timestamp, so the two lanes partition
    // the corpus: inside the recency window is the waker's, outside is this
    // lane's. Nothing is covered twice, and — the bug this replaced — nothing
    // is covered by neither because it arrived after some ingestion cutoff.
    upsertDocuments(db, [makeDoc("old", "email", "2020-01-01T00:00:00.000Z")]);
    giveDate("old", FUTURE);

    // A floor BEFORE the datum → the waker owns it → bootstrap declines.
    const floorBefore = "1990-01-01T00:00:00.000Z";
    expect(fetchBootstrapBatch(db, { recencyFloor: floorBefore, batchSize: 50 })).toHaveLength(0);
    expect(countPendingBootstrap(db, floorBefore)).toBe(0);

    // A floor AFTER it → outside the window → bootstrap's.
    expect(countPendingBootstrap(db, CUTOFF)).toBe(1);
  });

  it("selects a freshly-ingested document whose datum is old", () => {
    // The coverage hole: a source connected today backfills years of history.
    // Every one of those documents is ingested NOW — after any ingestion
    // cutoff — while its datum is far outside the waker's window. Under the
    // old rule neither lane took it, permanently and silently.
    upsertDocuments(db, [makeDoc("backfilled", "email", "2019-05-05T00:00:00.000Z")]);
    giveDate("backfilled", FUTURE);
    db.prepare("UPDATE documents SET ingested_at = ? WHERE external_id = 'backfilled'").run(
      new Date().toISOString(),
    );

    const floor = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = fetchBootstrapBatch(db, { recencyFloor: floor, batchSize: 50 });
    expect(rows.map((r) => r.docId)).toHaveLength(1);
  });

  it("marking a doc processed removes it from the work-list and count", () => {
    upsertDocuments(db, [makeDoc("d", "email", "2020-01-01T00:00:00.000Z")]);
    giveDate("d", FUTURE);
    expect(countPendingBootstrap(db, CUTOFF)).toBe(1);
    const marked = markDocsBootstrapProcessed(db, [idOf("d")], "2100-02-02T00:00:00.000Z");
    expect(marked).toBe(1);
    expect(countPendingBootstrap(db, CUTOFF)).toBe(0);
    expect(fetchBootstrapBatch(db, { recencyFloor: CUTOFF, batchSize: 50 })).toHaveLength(0);
    // Marking again is a no-op (set once).
    expect(markDocsBootstrapProcessed(db, [idOf("d")], "2100-03-03T00:00:00.000Z")).toBe(0);
  });

  it("keys mod dates on their value: a future 'after' qualifies, a past 'since' does not", () => {
    upsertDocuments(db, [
      makeDoc("after-future", "email", "2020-01-01T00:00:00.000Z"),
      makeDoc("since-past", "email", "2020-01-01T00:00:00.000Z"),
    ]);
    // "after 2099" — an open-ended future bound → still relevant.
    applyExtractedDates(db, [
      {
        truncated: false,
        id: idOf("after-future"),
        dates: [
          {
            kind: "date",
            resolvedStart: FUTURE,
            resolvedEnd: null,
            mod: "after",
            relative: false,
            text: "after 2099",
            timex: FUTURE,
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
    // "since 2000" — a past anchor, NOT a future date → excluded.
    applyExtractedDates(db, [
      {
        truncated: false,
        id: idOf("since-past"),
        dates: [
          {
            kind: "date",
            resolvedStart: PAST,
            resolvedEnd: null,
            mod: "since",
            relative: false,
            text: "since 2000",
            timex: PAST,
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
    expect(countPendingBootstrap(db, CUTOFF)).toBe(1);
    expect(fetchBootstrapBatch(db, { recencyFloor: CUTOFF, batchSize: 50 })).toHaveLength(1);
  });
});

describe("re-admission after a terminal run failure", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function seedDoc(ext: string): string {
    upsertDocuments(db, [makeDoc(ext, "email", PAST)]);
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }

  /** One settled bootstrap run against a document, as the drainer leaves it. */
  function seedRun(docId: string, status: "failed" | "completed"): void {
    db.prepare(
      `INSERT INTO cognition_runs (id, kind, payload_json, dedupe_key, status, attempts,
         next_attempt_at, enqueued_at, cycle_anchor_at)
       VALUES (?, 'bootstrap', '{}', ?, ?, 5, 0, 0, 0)`,
    ).run(randomUUID(), `bootstrap:doc:${docId}`, status);
  }

  function markerOf(docId: string): string | null {
    return (
      db
        .prepare<
          [string],
          { bootstrap_processed_at: string | null }
        >("SELECT bootstrap_processed_at FROM documents WHERE id = ?")
        .get(docId)?.bootstrap_processed_at ?? null
    );
  }

  it("lifts the marker so the enqueuer can select the document again", () => {
    // The defect this exists for: the marker is set at enqueue, so a run that
    // then fails leaves the document marked without ever being reasoned over,
    // and the enqueuer selects on the marker being absent.
    const docId = seedDoc("a");
    markDocsBootstrapProcessed(db, [docId], "2026-01-01T00:00:00.000Z");
    seedRun(docId, "failed");
    expect(readmitFailedBootstrapDoc(db, docId)).toBe(true);
    expect(markerOf(docId)).toBeNull();
  });

  it("stops re-admitting a document that keeps failing", () => {
    // A document that fails on its own content fails the same way every time.
    // Unbounded lifting would cycle it through the lane forever, spending real
    // money per attempt and starving the rest of the backlog.
    const docId = seedDoc("b");
    for (let i = 1; i <= BOOTSTRAP_TERMINAL_READMISSIONS; i++) {
      markDocsBootstrapProcessed(db, [docId], "2026-01-01T00:00:00.000Z");
      seedRun(docId, "failed");
      expect(readmitFailedBootstrapDoc(db, docId)).toBe(true);
    }
    markDocsBootstrapProcessed(db, [docId], "2026-01-01T00:00:00.000Z");
    seedRun(docId, "failed");
    expect(readmitFailedBootstrapDoc(db, docId)).toBe(false);
    // And the marker stands, so the lane leaves it alone from here.
    expect(markerOf(docId)).not.toBeNull();
  });

  it("counts only this document's failures", () => {
    // The bound is per document; one poisoned document must not spend another
    // document's budget.
    const a = seedDoc("c");
    const b = seedDoc("d");
    for (let i = 0; i < 5; i++) seedRun(a, "failed");
    markDocsBootstrapProcessed(db, [b], "2026-01-01T00:00:00.000Z");
    seedRun(b, "failed");
    expect(readmitFailedBootstrapDoc(db, b)).toBe(true);
  });

  it("re-admitted documents come back on the work list", () => {
    // The end-to-end point: lifting the marker is only meaningful if the
    // selection query then returns the document.
    const docId = seedDoc("e");
    // A still-relevant future date, which the selection predicate requires.
    applyExtractedDates(db, [
      {
        truncated: false,
        id: docId,
        dates: [
          {
            kind: "date",
            resolvedStart: FUTURE,
            resolvedEnd: null,
            relative: false,
            text: FUTURE,
            timex: FUTURE,
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
    markDocsBootstrapProcessed(db, [docId], "2026-01-01T00:00:00.000Z");
    expect(countPendingBootstrap(db, "2100-01-01T00:00:00.000Z")).toBe(0);
    seedRun(docId, "failed");
    readmitFailedBootstrapDoc(db, docId);
    expect(countPendingBootstrap(db, "2100-01-01T00:00:00.000Z")).toBe(1);
  });
});

describe("the corpus month by month", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function seed(ext: string, at: string): string {
    upsertDocuments(db, [makeDoc(ext, "email", at)]);
    return (
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(ext) as { id: string }
    ).id;
  }

  /** Run the extraction pass over a document, finding `dates` (possibly none). */
  function scan(id: string, dates: string[]): void {
    applyExtractedDates(db, [
      {
        truncated: false,
        id,
        dates: dates.map((d) => ({
          kind: "date" as const,
          resolvedStart: d,
          resolvedEnd: null,
          relative: false,
          text: d,
          timex: d,
          charStart: 0,
          charEnd: 4,
        })),
      },
    ]);
  }

  const CUTOFF = "2100-01-01T00:00:00.000Z";
  const TODAY = "2026-08-24";
  const row = () => bootstrapCorpusByMonth(db, CUTOFF, TODAY)[0]!;

  it("a scan that found no date is NOT the same as no scan", () => {
    // The defect this exists for. Extraction that finds nothing writes no rows
    // to `document_extracted_dates`, so "has no rows" means "scanned, nothing
    // found" just as often as "never scanned". Reading it as the latter
    // reported an install whose extraction was entirely complete as having
    // 78,650 documents nobody had looked at.
    scan(seed("scanned-empty", "2020-01-15T00:00:00.000Z"), []);
    expect(row()).toMatchObject({ unscanned: 0, discarded: 1, owed: 0 });
  });

  it("a document the pass has never reached is unscanned", () => {
    seed("never-scanned", "2020-01-15T00:00:00.000Z");
    expect(row()).toMatchObject({ unscanned: 1, discarded: 0, owed: 0 });
  });

  it("a still-future date makes it a candidate the lane owes", () => {
    scan(seed("future", "2020-01-15T00:00:00.000Z"), ["2099-06-01"]);
    expect(row()).toMatchObject({ owed: 1, discarded: 0, unscanned: 0 });
  });

  it("a date already past is nothing ahead", () => {
    scan(seed("past", "2020-01-15T00:00:00.000Z"), ["2001-06-01"]);
    expect(row()).toMatchObject({ discarded: 1, owed: 0, unscanned: 0 });
  });

  it("a coarse date counts until the END of its period, as the lane counts it", () => {
    // The bug this exists for. The lane pads a coarse date up to its period
    // end — a document dated `2026` is a candidate until 31 December — and the
    // timeline compared the stored value directly. `'2026-08'` sorts before
    // `'2026-08-24'`, so a whole month of candidates dropped out of the
    // picture while the lane still intended to read them.
    scan(seed("year-only", "2020-01-15T00:00:00.000Z"), ["2026"]);
    scan(seed("month-only", "2020-01-16T00:00:00.000Z"), ["2026-08"]);
    const r = bootstrapCorpusByMonth(db, CUTOFF, "2026-08-24")[0]!;
    expect(r).toMatchObject({ owed: 2, discarded: 0 });
  });

  it("a coarse date whose period has passed is nothing ahead", () => {
    scan(seed("old-year", "2020-01-15T00:00:00.000Z"), ["2019"]);
    scan(seed("old-month", "2020-01-16T00:00:00.000Z"), ["2026-07"]);
    const r = bootstrapCorpusByMonth(db, CUTOFF, "2026-08-24")[0]!;
    expect(r).toMatchObject({ owed: 0, discarded: 2 });
  });

  it("the timeline agrees with the work list the lane actually selects", () => {
    // The two run different SQL over the same population, so they can drift.
    // The only defence is asserting they agree — this caught a 16-document
    // disagreement on a live corpus.
    const today = (db.prepare("SELECT date('now') AS value").get() as { value: string }).value;
    const currentYear = today.slice(0, 4);
    const currentMonth = today.slice(0, 7);
    const priorMonthDate = new Date(`${currentMonth}-01T00:00:00.000Z`);
    priorMonthDate.setUTCMonth(priorMonthDate.getUTCMonth() - 1);
    const priorMonth = priorMonthDate.toISOString().slice(0, 7);
    for (const [ext, date] of [
      ["c1", currentYear],
      ["c2", currentMonth],
      ["c3", "2099-06-01"],
      ["c4", "2019"],
      ["c5", priorMonth],
      ["c6", "2001-01-01"],
    ] as const) {
      scan(seed(ext, "2020-02-01T00:00:00.000Z"), [date]);
    }
    seed("c7", "2020-02-02T00:00:00.000Z"); // never scanned
    const owed = bootstrapCorpusByMonth(db, CUTOFF, today).reduce((n, m) => n + m.owed, 0);
    expect(owed).toBe(countPendingBootstrap(db, CUTOFF));
  });

  it("every document lands in exactly one band", () => {
    // The bands are a partition. A document counted twice would inflate a
    // month's column; one counted nowhere would make the corpus look smaller
    // than it is.
    scan(seed("a", "2020-01-02T00:00:00.000Z"), []);
    scan(seed("b", "2020-01-03T00:00:00.000Z"), ["2099-06-01"]);
    scan(seed("c", "2020-01-04T00:00:00.000Z"), ["2001-06-01"]);
    seed("d", "2020-01-05T00:00:00.000Z");
    const r = row();
    expect(r.unscanned + r.discarded + r.owed + r.reviewed + r.failed).toBe(4);
  });
});
