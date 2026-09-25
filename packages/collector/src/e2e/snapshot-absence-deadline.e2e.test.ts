// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Spending an absence deadline — the currencies, the grace, and the cascade.
 *
 * `snapshot-absence.e2e.test.ts` owns the mark lifecycle: an omission is
 * recorded, a reappearance revokes it, a withheld snapshot records nothing. To
 * get there it collapses both deadline currencies to nearly zero — a 3ms
 * observation spacing and a 1ms deletion grace — so the properties that only
 * exist while those currencies are LARGE are invisible to it, and so is
 * everything that leaves with a row once the deadline is finally spent.
 *
 * This file configures them large instead, and asserts what they buy:
 *
 *   - **Spacing.** `observations` counts snapshots, not sync attempts. Two
 *     complete snapshots arriving closer together than
 *     `floor(minAge / minObservations)` must record the omission and not count
 *     it twice, on the document plane and the analytics plane alike — a source
 *     that re-enumerates itself every few minutes must not reach the
 *     corroboration floor in an afternoon. The counting is proved by moving
 *     that one knob and sending the same snapshot a third time: `marked: 0`
 *     alone is also what a refused write epoch or a stale scope revision
 *     produces, so on its own it proves nothing about spacing.
 *   - **The grace.** `deletionGrace` is measured from the gateway's own boot,
 *     not from when a mark came due, and it is read once, when the sweep task
 *     is constructed. A restart that finds absences already past both
 *     currencies holds every new deletion while collectors reconnect and get
 *     their chance to revoke stale evidence — and still drains a crash-left
 *     cascade outbox immediately, in that same window, or a crash mid-cascade
 *     leaves the search index quoting documents that are gone.
 *   - **Idleness is a property of the sweep, not of a tick.** One plane is
 *     nearly always empty while the other has work. A tick reporting its own
 *     emptiness as the sweep's would re-arm the periodic at the ten-minute idle
 *     period and drain the other plane at one batch per ten minutes.
 *   - **The cascade.** The sweep is the only deletion path where the SQLite
 *     commit and the `index.db` / cognitive-state purge are separated by a
 *     commit boundary and a durable outbox, and the only one where an analytics
 *     row's temporal projection has to be removed by hand — DuckDB has no
 *     cascade, and the projection is what the unified temporal API answers
 *     from. A regression in any of them deletes the row and leaves the content
 *     retrievable.
 *
 * These need a real gateway process rather than a unit test because each is a
 * claim about wiring no unit can see: the grace is anchored on boot, so only a
 * genuine restart re-anchors it; the idle flag matters only because a real
 * Scheduler re-arms on it; the cascade crosses three stores and a worker
 * boundary; and the spacing has to survive the trip from `omnesis.json` through
 * `resolveRuntimeSettings` into two independently written planes.
 *
 * Every wait gates on an observable — a row in `omnesis.db` or `index.db`, a
 * value in DuckDB, or the sweep's own returned verdict. Where a deadline is the
 * subject it is moved by rewriting config and restarting rather than waited
 * out, and durable state is planted only inside `restartGateway`'s
 * `whileStopped` window, while the gateway is down and no second writer exists.
 */

import "./synth-env.js";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";

/** A document-only source: the standing absence the grace tests hold and spend. */
const NOTES = "apple-notes:john.smith@icloud.example";
/** Documents AND analytics rows from one page — where both planes are visible. */
const CALENDAR = "apple-calendar:john.smith@icloud.example";
/** The calendar's structured twin, keyed on the event id. */
const CALENDAR_TABLE = "apple_calendar_events";
/** `pushDocument`'s default source — the crash fixture's document lives here. */
const PUSH_SOURCE = "synthetic:test@example.com";

/**
 * The corroboration knobs every test starts from: one observation, a 10ms
 * elapsed floor. A mark is therefore due almost as soon as it is made, which is
 * what makes the grace the only thing standing between a mark and a deletion.
 */
const THRESHOLDS = { minObservations: 1, minAge: "10ms", maxMarksPerSnapshot: 200 } as const;

/** The gateway config for a boot with `deletionGrace` set to `grace`. */
function bootConfig(grace: string): Readonly<Record<string, unknown>> {
  return { gateway: { snapshotAbsence: { ...THRESHOLDS, deletionGrace: grace } } };
}

/**
 * Longer than this file's whole runtime. For every test up to the one that
 * spends it, no absence can turn into a deletion however slow the box is —
 * which removes a whole class of "the machine was loaded so a mark matured
 * early" flake, and makes "nothing was deleted" a claim about the gateway.
 */
const LONG_GRACE = "30m";

let harness: SyntheticE2EHarness;

/**
 * The config the harness reassembles `omnesis.json` from on the next boot.
 *
 * `deletionGrace` is the one knob `PATCH /admin/config` cannot move: the sweep
 * captures `deletionAllowedAt = clock() + deletionGraceMs` when the task is
 * constructed, so the value only changes for a gateway that boots again. The
 * harness re-writes `omnesis.json` from this field on every `startGateway`, so
 * rewriting the file inside `whileStopped` would be clobbered on the way back
 * up: the field itself is what has to change. It is not part of the harness's
 * public surface, so it is reached through a narrow structural cast.
 */
interface HarnessBootConfigSlot {
  extraGatewayConfig?: Readonly<Record<string, unknown>>;
}
function setBootConfig(config: Readonly<Record<string, unknown>>): void {
  (harness as unknown as HarnessBootConfigSlot).extraGatewayConfig = config;
}

// ── Reading the three stores ───────────────────────────────────────────────

function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Chunk rows `index.db` holds for a document. Throws rather than answering 0:
 * 0 is the value half the assertions here want, so a handle that failed to open
 * must never be able to satisfy one.
 */
function indexChunkCount(documentId: string): number {
  const db = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
  try {
    return db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?")
      .get(documentId)!.n;
  } finally {
    db.close();
  }
}

/**
 * The same count for a polling predicate. The indexer worker writes `index.db`
 * while this reads it, so a flush can hand a second connection SQLITE_BUSY;
 * `null` means "ask again", never "there are none".
 */
function settledIndexChunkCount(documentId: string): number | null {
  try {
    return indexChunkCount(documentId);
  } catch {
    return null;
  }
}

/** External ids the gateway holds for a source, straight from SQLite. */
function storedIds(sourceId: string): string[] {
  return readDb((db) =>
    db
      .prepare<[string], { external_id: string }>(
        "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
      )
      .all(sourceId)
      .map((r) => r.external_id),
  );
}

function documentIdFor(sourceId: string, externalId: string): string {
  const row = readDb((db) =>
    db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
      .get(sourceId, externalId),
  );
  if (!row) throw new Error(`no document ${externalId} stored for ${sourceId}`);
  return row.id;
}

/** Pending document absences for a source, as `externalId → observations`. */
function documentAbsences(sourceId: string): Array<{ externalId: string; observations: number }> {
  return readDb((db) =>
    db
      .prepare<[string], { external_id: string; observations: number }>(
        "SELECT external_id, observations FROM document_absences WHERE source_id = ? ORDER BY external_id",
      )
      .all(sourceId)
      .map((r) => ({ externalId: r.external_id, observations: r.observations })),
  );
}

/**
 * Document absences the sweep would find due right now, evaluated with the
 * gateway's own predicate (`listDueAbsences`): the live scope generation, the
 * corroboration floor, and the elapsed floor. Asserting a mark is due by the
 * same rule the sweep uses is what makes "and it was not deleted" mean the
 * grace held it rather than that it was never eligible.
 */
function dueDocumentAbsences(
  minObservations = THRESHOLDS.minObservations,
  minAgeMs = 10,
): string[] {
  return readDb((db) =>
    db
      .prepare<[number, number], { document_id: string }>(
        `SELECT a.document_id
           FROM document_absence_scopes AS s
           CROSS JOIN document_absences AS a
          WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
            AND a.stream_id = s.stream_id AND a.generation = s.generation
            AND a.observations >= ? AND a.first_absent_at <= ?
          ORDER BY a.first_absent_at`,
      )
      .all(minObservations, Date.now() - minAgeMs)
      .map((r) => r.document_id),
  );
}

/** Ids the sweep recorded before deleting. */
function auditedIds(): string[] {
  return readDb((db) =>
    db
      .prepare<[], { external_ids: string }>(
        "SELECT external_ids FROM snapshot_absence_deletions ORDER BY id",
      )
      .all()
      .flatMap((r) => JSON.parse(r.external_ids) as string[])
      .sort(),
  );
}

/** Durable cascade obligations still owed to the index and cognition stores. */
function outboxRows(): number {
  return readDb(
    (db) =>
      db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM snapshot_absence_cascade_outbox")
        .get()!.n,
  );
}

/** Annotation ids still stored, of the planted fixture. */
function storedAnnotationIds(ids: readonly string[]): string[] {
  return readDb((db) =>
    db
      .prepare<string[], { id: string }>(
        `SELECT id FROM doc_annotations WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
      )
      .all(...ids)
      .map((r) => r.id),
  );
}

/** Evidence atoms still stored, of the planted fixture. */
function storedAnnotationEvidenceIds(ids: readonly string[]): string[] {
  return readDb((db) =>
    db
      .prepare<string[], { annotation_id: string }>(
        `SELECT DISTINCT annotation_id FROM doc_annotation_evidence
          WHERE annotation_id IN (${ids.map(() => "?").join(", ")}) ORDER BY annotation_id`,
      )
      .all(...ids)
      .map((r) => r.annotation_id),
  );
}

async function analyticsRows(sql: string): Promise<unknown[][]> {
  const result = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  return result.rows;
}

/** Row keys the calendar's structured twin holds. */
async function analyticsIds(): Promise<string[]> {
  const rows = await analyticsRows(`SELECT id FROM ${CALENDAR_TABLE} ORDER BY id`);
  return rows.map((r) => String(r[0]));
}

/** Pending analytics absence keys for the calendar twin. */
async function analyticsAbsenceKeys(): Promise<string[]> {
  const rows = await analyticsRows(
    "SELECT key_value FROM _analytics_absences " +
      `WHERE source_id = '${CALENDAR}' AND table_name = '${CALENDAR_TABLE}' ORDER BY key_value`,
  );
  return rows.map((r) => String(r[0]));
}

/** Corroboration count the analytics ledger holds for one key. BIGINT, so cast. */
async function analyticsObservations(keyValue: string): Promise<number | null> {
  const rows = await analyticsRows(
    "SELECT observations FROM _analytics_absences " +
      `WHERE source_id = '${CALENDAR}' AND table_name = '${CALENDAR_TABLE}' ` +
      `AND key_value = '${keyValue}'`,
  );
  return rows.length === 0 ? null : Number(rows[0]![0]);
}

/**
 * The calendar's temporal projections, by the document each is bound to. The
 * projection is materialized as part of the analytics row write, not by a
 * background task, so nothing here needs to wait for it.
 */
async function projectionExternalIds(): Promise<string[]> {
  const rows = await analyticsRows(
    "SELECT bound_document_external_id FROM _temporal_projections " +
      `WHERE source_id = '${CALENDAR}' ORDER BY bound_document_external_id`,
  );
  return rows.map((r) => String(r[0]));
}

// ── Driving the gateway ────────────────────────────────────────────────────

/** What a snapshot changed, as both planes report it. */
interface AbsenceOutcome {
  marked: number;
  cleared: number;
  absent: number;
  stored: number;
  snapshot: number;
}

async function wipeEpochFor(sourceId: string): Promise<number> {
  const state = await harness.gatewayJson<{ wipeEpoch: number }>(
    `/sync-state/${encodeURIComponent(sourceId)}`,
  );
  return state.wipeEpoch;
}

/**
 * One complete document snapshot over HTTP.
 *
 * The epoch is read immediately before the call and passed verbatim — the
 * bootstrap token carries `write:*`, so the route trusts the body's
 * `writeEpoch` and a mismatched one is answered with a silent
 * `{deleted: 0, deletedIds: []}` carrying no `absence` at all. Requiring the
 * `absence` object here rather than at each call site is what turns that
 * silence into a failure instead of into an assertion nobody made.
 *
 * `observationId` identifies the snapshot rather than the attempt, so passing
 * one makes a redelivery a repeat instead of fresh corroboration. Callers that
 * omit it get a distinct observation each time, which is what the spacing rule
 * below is asserted against.
 */
async function reconcileDocuments(
  sourceId: string,
  presentExternalIds: readonly string[],
  observationId?: string,
): Promise<AbsenceOutcome> {
  const writeEpoch = await wipeEpochFor(sourceId);
  const res = await harness.gatewayJson<{ absence?: AbsenceOutcome }>("/documents/reconcile", {
    method: "POST",
    body: JSON.stringify({
      providerId: providerIds.get(sourceId),
      sourceId,
      presentExternalIds: [...presentExternalIds],
      writeEpoch,
      ...(observationId === undefined ? {} : { observationId }),
    }),
  });
  expect(
    res.absence,
    `the snapshot for ${sourceId} was refused before it was diffed`,
  ).toBeDefined();
  return res.absence!;
}

/**
 * One complete analytics snapshot for the calendar twin. `records: []` with no
 * schema makes the page pure reconcile — no data work reaches DuckDB — and the
 * analytics plane, unlike the document one, does honour `observationId`.
 */
async function reconcileAnalytics(
  presentIds: readonly string[],
  observationId: string,
): Promise<AbsenceOutcome> {
  const writeEpoch = await wipeEpochFor(CALENDAR);
  const res = await harness.gatewayJson<{ absence?: AbsenceOutcome }>("/analytics/ingest", {
    method: "POST",
    body: JSON.stringify({
      tableName: CALENDAR_TABLE,
      records: [],
      sourceId: CALENDAR,
      presentIds: [...presentIds],
      writeEpoch,
      observationId,
    }),
  });
  expect(res.absence, "the analytics snapshot was refused before it was diffed").toBeDefined();
  return res.absence!;
}

/** Move the corroboration knobs. Committed synchronously, so the next call sees them. */
async function patchAbsence(patch: Record<string, unknown>): Promise<void> {
  await harness.gatewayJson("/admin/config", {
    method: "PATCH",
    body: JSON.stringify({ gateway: { snapshotAbsence: patch } }),
  });
}

/** Run one sweep tick and return the composite idle flag the scheduler re-arms on. */
async function kickSweep(): Promise<boolean> {
  const res = await harness.gatewayJson<{ result: { idle: boolean } }>(
    "/admin/background/run/absence.sweep?timeoutMs=30000",
    { method: "POST" },
  );
  return res.result.idle;
}

/**
 * A kick issued from inside a polling predicate. `kickAndWait` rejects on its
 * own timeout and on a periodic that is momentarily unarmed; swallowing that
 * keeps the surrounding wait failing with the condition it was waiting for
 * rather than with an unrelated-looking rejection.
 */
async function tryKickSweep(): Promise<void> {
  try {
    await kickSweep();
  } catch {
    /* the next poll kicks again */
  }
}

/** provider_id per source, read once — the reconcile route needs it. */
const providerIds = new Map<string, string>();
let calendarDocIds: string[] = [];
let calendarRowIds: string[] = [];
let noteIds: string[] = [];

describe("snapshot absence: the deadline's currencies and what a swept row takes with it", () => {
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      // Without an assigned embedder the indexer worker returns before it
      // starts, and `index.db` is never written — not even its FTS table — so
      // every chunk assertion below would be asserting against a store nothing
      // ever populated.
      embedderBackend: "fake",
      extraGatewayConfig: bootConfig(LONG_GRACE),
    });
    await harness.start();
    await harness.triggerSyncAndWait(NOTES, 120_000);
    await harness.triggerSyncAndWait(CALENDAR, 120_000);
    // Every snapshot from here is sent deliberately over HTTP, so the victims
    // are named rather than inferred from fixture ordering. Close the door on
    // the collector re-ingesting anything mid-test.
    const drained = await harness.stopSyncLoopsAndDrain(60_000);
    expect(drained.timedOut).toBe(false);

    for (const sourceId of [NOTES, CALENDAR]) {
      const scopes = readDb((db) =>
        db
          .prepare<
            [string],
            { provider_id: string; stream_id: string }
          >("SELECT DISTINCT provider_id, stream_id FROM documents WHERE source_id = ?")
          .all(sourceId),
      );
      // A snapshot is scoped to one (provider, source, stream). If a future
      // universe made either source partitioned or multi-provider, every
      // reconcile below would silently describe a scope holding nothing —
      // so that change must redden here instead.
      expect(scopes, `${sourceId} must occupy exactly one absence scope`).toHaveLength(1);
      expect(scopes[0]!.stream_id).toBe("");
      providerIds.set(sourceId, scopes[0]!.provider_id);
    }

    noteIds = storedIds(NOTES);
    calendarDocIds = storedIds(CALENDAR);
    calendarRowIds = await analyticsIds();
    expect(noteIds.length).toBeGreaterThanOrEqual(3);
    expect(calendarRowIds.length).toBeGreaterThanOrEqual(3);
    // The twin's keys are the event documents' external ids, which is what lets
    // one victim be named on both planes at once.
    for (const id of calendarRowIds) expect(calendarDocIds).toContain(id);
    expect(documentAbsences(NOTES)).toEqual([]);
    expect(documentAbsences(CALENDAR)).toEqual([]);
    expect(await analyticsAbsenceKeys()).toEqual([]);
  }, 600_000);

  afterAll(async () => {
    await harness.destroy();
  }, 30_000);

  test("a second snapshot inside the observation-spacing window is recorded as absent, and deliberately not counted", async () => {
    // spacing = floor(minAge / minObservations) = 60s, far longer than this
    // test's whole runtime — so the window is entered and left by moving the
    // knob, never by waiting on a clock.
    await patchAbsence({ minObservations: 2, minAge: "120s" });
    const doomed = calendarRowIds.at(-1)!;
    const present = calendarDocIds.filter((id) => id !== doomed);
    const presentRows = calendarRowIds.filter((id) => id !== doomed);

    const firstDocs = await reconcileDocuments(CALENDAR, present);
    const firstRows = await reconcileAnalytics(presentRows, "spacing-a");
    expect(firstDocs.marked).toBe(1);
    expect(firstRows.marked).toBe(1);

    const secondDocs = await reconcileDocuments(CALENDAR, present);
    const secondRows = await reconcileAnalytics(presentRows, "spacing-b");
    const secondRoundAt = Date.now();
    // `absent: 1` proves the row was seen and diffed; `marked: 0` proves the
    // gateway then declined to count what it had just seen.
    expect(secondDocs.absent).toBe(1);
    expect(secondDocs.marked).toBe(0);
    expect(secondRows.absent).toBe(1);
    expect(secondRows.marked).toBe(0);
    expect(documentAbsences(CALENDAR)).toEqual([{ externalId: doomed, observations: 1 }]);
    expect(await analyticsObservations(doomed)).toBe(1);
    // Neither plane lost anything: a snapshot records, it never deletes.
    expect(storedIds(CALENDAR)).toEqual(calendarDocIds);
    expect(await analyticsIds()).toEqual(calendarRowIds);

    // The counterfactual, and the only thing that makes the pair above a
    // statement about spacing. `marked: 0` is also what a refused write epoch,
    // a duplicate observation receipt or a stale scope revision returns, and
    // `absent` — computed on the read side — survives all three. So: the same
    // snapshot, the same corpus, the same epoch, one moved knob.
    await patchAbsence({ minObservations: 1, minAge: "10ms" });
    await waitForCondition(
      () => Date.now() - secondRoundAt >= 10,
      5_000,
      "the shortened 10ms observation-spacing window to lapse",
    );
    const thirdDocs = await reconcileDocuments(CALENDAR, present);
    const thirdRows = await reconcileAnalytics(presentRows, "spacing-c");
    expect(thirdDocs.marked).toBe(1);
    expect(thirdRows.marked).toBe(1);
    expect(documentAbsences(CALENDAR)).toEqual([{ externalId: doomed, observations: 2 }]);
    expect(await analyticsObservations(doomed)).toBe(2);

    // Hand the rest of the file a corpus with no pending marks. The revocation
    // is both the cleanup and a small assertion: a mark that could not be
    // revoked would spend itself the moment the grace is lifted, three tests
    // from here, and take a calendar document nobody intended.
    const restoredDocs = await reconcileDocuments(CALENDAR, calendarDocIds);
    const restoredRows = await reconcileAnalytics(calendarRowIds, "spacing-restore");
    expect(restoredDocs.cleared).toBe(1);
    expect(restoredRows.cleared).toBe(1);
    expect(documentAbsences(CALENDAR)).toEqual([]);
    expect(await analyticsAbsenceKeys()).toEqual([]);
  }, 120_000);

  // The absence the next two tests share: created and held here under a long
  // grace, spent there under a short one. Neither test alone can separate "the
  // grace held it" from "the mark was never due" or "the sweep never ran".
  let doomedNote = "";
  let doomedNoteDocId = "";
  /** Annotation fixture, planted while the gateway is down; consumed by the cascade test. */
  const SUBJECT_ANNOTATION = "anno-subject-event3";
  const EVIDENCE_ANNOTATION = "anno-evidence-event3";
  const CONTROL_ANNOTATION = "anno-control-event1";
  const ANNOTATIONS = [SUBJECT_ANNOTATION, EVIDENCE_ANNOTATION, CONTROL_ANNOTATION];

  test("a redelivered snapshot is a repeat, not a second corroboration", async () => {
    // The spacing rule alone cannot tell a retry apart from a genuine second
    // look — both arrive inside the window. `observationId` is what carries
    // that distinction, so a collector retrying a page it already sent must
    // not push the row closer to the deletion floor.
    await patchAbsence({ minObservations: 3, minAge: "1ms" });
    const doomed = calendarRowIds.at(-1)!;
    const present = calendarDocIds.filter((id) => id !== doomed);

    const first = await reconcileDocuments(CALENDAR, present, "retry-receipt-1");
    expect(first.marked).toBe(1);
    const afterFirst = documentAbsences(CALENDAR);
    expect(afterFirst).toHaveLength(1);
    const observationsAfterFirst = afterFirst[0]!.observations;

    // The same snapshot again, under the same identity: the gateway has
    // already banked this observation, so nothing about the row may move.
    const repeat = await reconcileDocuments(CALENDAR, present, "retry-receipt-1");
    expect(repeat.marked).toBe(0);
    expect(documentAbsences(CALENDAR)[0]!.observations).toBe(observationsAfterFirst);

    // A genuinely new look, under a new identity, does count — otherwise the
    // assertion above would hold for a route that had simply stopped working.
    const fresh = await reconcileDocuments(CALENDAR, present, "retry-receipt-2");
    expect(fresh.marked + fresh.absent).toBeGreaterThan(0);
    expect(documentAbsences(CALENDAR)[0]!.observations).toBeGreaterThan(observationsAfterFirst);

    await reconcileDocuments(CALENDAR, calendarDocIds);
  }, 180_000);

  test("after a restart a due absence waits out the deletion grace while a crash-left cascade drains at once", async () => {
    // The crash story: a sweep committed its delete and died before the index
    // and cognition stores caught up, leaving the durable obligation behind.
    const victimExternalId = "absence-outbox-victim";
    await harness.pushDocument({
      externalId: victimExternalId,
      title: "Quarterly budget notes",
      content:
        "The quarterly budget review is out for comment; the hardware line is " +
        "still unowned. Replies to finance@example.com before the end of the week.",
    });
    const victimId = documentIdFor(PUSH_SOURCE, victimExternalId);
    await waitForCondition(
      () => (settledIndexChunkCount(victimId) ?? -1) > 0,
      120_000,
      `index chunks for ${victimExternalId}`,
    );
    // Load-bearing: this is what stops the post-restart assertion from being
    // satisfied by a world where the fixture never landed at all.
    expect(indexChunkCount(victimId)).toBeGreaterThan(0);

    const event1DocId = documentIdFor(CALENDAR, calendarRowIds[0]!);
    const event3DocId = documentIdFor(CALENDAR, calendarRowIds.at(-1)!);
    await harness.restartGateway(() => {
      const db = new Database(harness.getDbPath());
      // Every foreign key into `documents` is CASCADE or SET NULL, so the raw
      // delete below leaves nothing dangling — except `doc_annotations.doc_id`,
      // which has no foreign key at all. That is exactly why the annotations
      // planted here are evidence: only the sweep's cognitive-state cascade can
      // remove them.
      db.pragma("foreign_keys = ON");
      try {
        db.transaction(() => {
          db.prepare("DELETE FROM documents WHERE id = ?").run(victimId);
          db.prepare(
            "INSERT INTO snapshot_absence_cascade_outbox (created_at, document_ids) VALUES (?, ?)",
          ).run(Date.now(), JSON.stringify([victimId]));

          const annotation = db.prepare(
            `INSERT INTO doc_annotations
               (id, doc_id, claim_type, claim_text, evidence_doc_id, evidence_quote,
                confidence, created_by_run, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const atom = db.prepare(
            `INSERT INTO doc_annotation_evidence
               (annotation_id, position, evidence_doc_id, evidence_quote)
             VALUES (?, ?, ?, ?)`,
          );
          const now = Date.now();
          // Subject: dies with the document it is about.
          annotation.run(
            SUBJECT_ANNOTATION,
            event3DocId,
            "topic",
            "a home visit is booked for the morning",
            event3DocId,
            "engineer arriving between 08:30 and 09:00",
            0.8,
            "run-absence-fixture",
            now,
          );
          atom.run(SUBJECT_ANNOTATION, 0, event3DocId, "engineer arriving between 08:30 and 09:00");
          // Evidence: about a surviving document, but grounded on the doomed
          // one. The purge matches the CHILD evidence table, never the parent's
          // scalar mirror, so the atom is what has to carry it.
          annotation.run(
            EVIDENCE_ANNOTATION,
            event1DocId,
            "topic",
            "the week's appointments are spread across two calendars",
            event3DocId,
            "engineer arriving between 08:30 and 09:00",
            0.6,
            "run-absence-fixture",
            now,
          );
          atom.run(
            EVIDENCE_ANNOTATION,
            0,
            event3DocId,
            "engineer arriving between 08:30 and 09:00",
          );
          // Control: grounded entirely on a document nothing deletes.
          annotation.run(
            CONTROL_ANNOTATION,
            event1DocId,
            "topic",
            "a routine appointment is on the calendar",
            event1DocId,
            "Six-month check-up",
            0.7,
            "run-absence-fixture",
            now,
          );
          atom.run(CONTROL_ANNOTATION, 0, event1DocId, "Six-month check-up");
        }).immediate();
      } finally {
        db.close();
      }
    });
    expect(storedAnnotationIds(ANNOTATIONS)).toEqual([...ANNOTATIONS].sort());
    // The crash transaction landed: the row is gone from SQLite while its
    // chunks are still in `index.db` — the exact state a crash between the
    // sweep's commit and its cascade leaves behind. Without this the drain
    // assertion below would also be satisfied by a fixture that rolled back.
    expect(storedIds(PUSH_SOURCE)).not.toContain(victimExternalId);

    // Half one: the durable obligation drains at once, on a tick armed at
    // `startDelayMs: 0`, WHILE the grace is in force — the second half of this
    // test is what shows it is. Nothing at boot would purge these orphaned
    // chunks otherwise: `reconcileIndexForGatewaySchema` skips unless the
    // gateway schema version advanced, and `reconcileDeletedDocuments` is armed
    // an hour out.
    await waitForCondition(
      () => outboxRows() === 0 && settledIndexChunkCount(victimId) === 0,
      120_000,
      "the crash-left cascade to drain and take the orphaned index chunks with it",
    );

    // Half two: a NEW deletion, on the same gateway, in the same window.
    doomedNote = noteIds.at(-1)!;
    doomedNoteDocId = documentIdFor(NOTES, doomedNote);
    const marked = await reconcileDocuments(
      NOTES,
      noteIds.filter((id) => id !== doomedNote),
    );
    expect(marked.marked).toBe(1);
    await waitForCondition(
      () => dueDocumentAbsences().includes(doomedNoteDocId),
      30_000,
      `${doomedNote} to become due by the sweep's own predicate`,
    );

    const verdicts: boolean[] = [];
    for (let i = 0; i < 4; i++) verdicts.push(await kickSweep());
    // Not decoration: the grace deliberately keeps the sweep on its five-second
    // active cadence, so a five-minute grace is not overshot by a ten-minute
    // idle re-arm.
    expect(verdicts).toEqual([false, false, false, false]);
    expect(storedIds(NOTES)).toEqual(noteIds);
    expect(auditedIds()).toEqual([]);
    expect(dueDocumentAbsences()).toContain(doomedNoteDocId);
  }, 300_000);

  test("the same absence and the same corpus: only a spent grace lets the sweep take it", async () => {
    expect(dueDocumentAbsences()).toContain(doomedNoteDocId);
    const calendarBefore = storedIds(CALENDAR);

    // One knob moves. Same process lineage, same `omnesis.db`, same `index.db`,
    // the same standing mark, the same thresholds.
    setBootConfig(bootConfig("1ms"));
    await harness.restartGateway();

    await waitForCondition(
      async () => {
        await tryKickSweep();
        return !storedIds(NOTES).includes(doomedNote);
      },
      120_000,
      `${doomedNote} to be swept once the grace is spent`,
    );
    expect(storedIds(NOTES)).toEqual(noteIds.filter((id) => id !== doomedNote));
    expect(documentAbsences(NOTES)).toEqual([]);
    // The sweep took what the mark named, and nothing else.
    expect(auditedIds()).toEqual([doomedNote]);
    expect(storedIds(CALENDAR)).toEqual(calendarBefore);
  }, 300_000);

  test("a swept row takes its index chunks, its annotations and its temporal projection with it", async () => {
    const [event1, event2, event3] = calendarRowIds as [string, string, string];
    const event1DocId = documentIdFor(CALENDAR, event1);
    const event3DocId = documentIdFor(CALENDAR, event3);

    // Preconditions, so none of the assertions below can be satisfied by a
    // store that was already empty.
    await waitForCondition(
      () => (settledIndexChunkCount(event3DocId) ?? -1) > 0,
      120_000,
      `index chunks for ${event3}`,
    );
    expect(indexChunkCount(event1DocId)).toBeGreaterThan(0);
    expect(storedAnnotationIds(ANNOTATIONS)).toEqual([...ANNOTATIONS].sort());
    expect(await projectionExternalIds()).toEqual(calendarRowIds);

    // Event 3 is omitted from BOTH snapshots; event 2 from the analytics one
    // only, so the two cascades can be told apart; event 1 from neither.
    const survivingDocs = calendarDocIds.filter((id) => id !== event3);
    const survivingRows = calendarRowIds.filter((id) => id !== event2 && id !== event3);
    const marked = await reconcileDocuments(CALENDAR, survivingDocs);
    expect(marked.marked).toBe(1);
    const markedRows = await reconcileAnalytics(survivingRows, "cascade-a");
    expect(markedRows.marked).toBe(2);

    await waitForCondition(
      async () => {
        await tryKickSweep();
        return (
          !storedIds(CALENDAR).includes(event3) &&
          settledIndexChunkCount(event3DocId) === 0 &&
          (await analyticsIds()).length === survivingRows.length
        );
      },
      180_000,
      "the corroborated calendar absences to be swept from both planes",
    );

    // The document plane: exactly what the mark named. Event 2 is the control
    // that shows an analytics-plane deletion does not reach across into the
    // document corpus.
    expect(storedIds(CALENDAR)).toEqual(survivingDocs);
    // The index: targeted, not a table wipe — a search over the removed content
    // has nothing left to return, while the surviving event is still findable.
    expect(indexChunkCount(event3DocId)).toBe(0);
    expect(indexChunkCount(event1DocId)).toBeGreaterThan(0);
    // Cognitive state: the annotation about the deleted document and the one
    // merely grounded on it both go; the control does not.
    expect(storedAnnotationIds(ANNOTATIONS)).toEqual([CONTROL_ANNOTATION]);
    expect(storedAnnotationEvidenceIds(ANNOTATIONS)).toEqual([CONTROL_ANNOTATION]);
    // The analytics plane, and the read model the unified temporal API answers
    // from. Event 2's projection goes with its row even though its document
    // survives — DuckDB has no cascade, so an orphaned projection is what a
    // regression here leaves behind, and there is no row behind it to notice.
    expect(await analyticsIds()).toEqual(survivingRows);
    expect(await projectionExternalIds()).toEqual(survivingRows);
    expect(await analyticsAbsenceKeys()).toEqual([]);
    expect(auditedIds()).toEqual([doomedNote, event3].sort());

    // The complement of the idle assertions elsewhere: with both planes empty
    // the composite flag must go idle, so neither test can be satisfied by a
    // flag hardwired one way.
    expect(await kickSweep()).toBe(true);
    expect(await kickSweep()).toBe(true);
  }, 300_000);

  test("an empty analytics plane cannot report the sweep idle while the document plane still has work", async () => {
    // Both planes are quiet, and the grace is long spent — so the only work in
    // the gateway is durable cascade work, which only the document phase sees.
    expect(dueDocumentAbsences()).toEqual([]);
    expect(await analyticsAbsenceKeys()).toEqual([]);
    const PLANTED = 24;

    await harness.restartGateway(() => {
      const db = new Database(harness.getDbPath());
      try {
        db.transaction(() => {
          const insert = db.prepare(
            "INSERT INTO snapshot_absence_cascade_outbox (created_at, document_ids) VALUES (?, ?)",
          );
          // Ids that match nothing: finishing one of these cascades is a delete
          // that removes no rows plus two acknowledgements, so the backlog is
          // work without being a deletion.
          for (let i = 0; i < PLANTED; i++) {
            insert.run(Date.now(), JSON.stringify([`absence-idle-probe-${i}`]));
          }
        }).immediate();
      } finally {
        db.close();
      }
    });

    // Find a tick that provably belonged to the document phase and provably
    // found work — which is what removes any need to know where `phaseIndex`
    // happens to be. A config edit alone kicks this periodic, so counting from
    // a known phase would be guesswork either way.
    let previous = outboxRows();
    expect(previous).toBeGreaterThan(8);
    let sawDocumentWork = false;
    for (let i = 0; i < 8 && !sawDocumentWork; i++) {
      await kickSweep();
      const remaining = outboxRows();
      sawDocumentWork = remaining < previous;
      previous = remaining;
    }
    expect(sawDocumentWork, "no kick reached the document phase's durable-cascade branch").toBe(
      true,
    );

    // The phases strictly alternate, so half of these ticks are analytics ticks
    // whose OWN `checked` is 0 — the reading that would report the whole sweep
    // idle if a phase's verdict were per-tick rather than remembered. A tick
    // that leaves the outbox where it found it is one of them, which is how
    // this counts them without being told which phase ran; the sweep reports
    // only its composite. The outbox is re-read around every kick, so "the
    // document phase still owes work" is a measurement, not an assumption.
    let analyticsTicks = 0;
    for (let i = 0; i < 6; i++) {
      const before = outboxRows();
      const idle = await kickSweep();
      const after = outboxRows();
      if (after === before) analyticsTicks += 1;
      expect(after, "the backlog drained faster than the assertion window").toBeGreaterThan(0);
      expect(idle, "an empty analytics tick reported the whole sweep idle").toBe(false);
    }
    expect(
      analyticsTicks,
      "every observed tick did document work, so the analytics phase never reported anything",
    ).toBeGreaterThan(0);

    // And the backlog does drain, on the active cadence the flag keeps it on —
    // after which the composite goes idle again. The document phase is what
    // holds it false, so idleness returns only once a document tick finds the
    // outbox empty: one more reason the flag is a property of the sweep rather
    // than of whichever tick happened to run last.
    await waitForCondition(
      async () => {
        await tryKickSweep();
        return outboxRows() === 0;
      },
      180_000,
      "the planted cascade backlog to drain",
    );
    await waitForCondition(
      async () => {
        try {
          return await kickSweep();
        } catch {
          return false;
        }
      },
      60_000,
      "the sweep to report itself idle once its backlog is gone",
    );
  }, 300_000);
});
