// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Snapshot absence, end to end.
 *
 * A complete snapshot records omitted rows with a corroboration deadline; a
 * later complete snapshot can revoke those marks, while an incomplete read
 * withholds its snapshot and changes no absence state. The focused phase proves
 * that lifecycle for document and structured sources. The breadth phase derives
 * the participating sources from the synthetic universe and applies the same
 * property to all of them.
 *
 * `OMNESIS_SYNTH_READ_IMPAIRMENT` supplies two property-test modes:
 *
 *   <sourceIdSubstring>:deleted:<n>    omit n records and vouch for the snapshot
 *   <sourceIdSubstring>:degraded:<n>   omit n records and withhold the snapshot
 *
 * The elapsed threshold is deliberately shorter than a sync round trip, while
 * the shipped corroboration count remains in force. Assertions that rows remain
 * stored are made before the corroboration floor; once a mark is due, the test
 * explicitly runs the bounded absence sweep.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { impairedIds } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount } from "./helpers.js";

/** A document-only source used to exercise the absence lifecycle. */
const NOTES = "apple-notes:john.smith@icloud.example";
/** Documents AND analytics rows from one page — the structured twin. */
const CALENDAR = "apple-calendar:john.smith@icloud.example";
/** A synth source whose provider emits incremental tombstones. */
const ONEDRIVE = "onedrive:john.smith@example.com";
/** The breadth half's named source, small enough to assert on by identity. */
const THINGS = "things:local";

/**
 * Snapshots that must agree before an absence is due. Left at the shipped
 * value: it is what gives every phase of the mark lifecycle a window in which
 * "nothing was deleted" is a claim about the gateway rather than about when the
 * sweep last ran.
 */
const MIN_OBSERVATIONS = 3;

const ABSENCE_CONFIG = {
  gateway: {
    snapshotAbsence: {
      minObservations: MIN_OBSERVATIONS,
      // The elapsed floor is spent by the sync round trip itself, so no test
      // sleeps. It also sets the observation-spacing rule the gateway derives
      // from these two numbers (minAge / minObservations = 3ms), which must
      // stay well under the gap between two syncs or consecutive snapshots
      // would stop counting as independent evidence.
      minAge: "10ms",
      maxMarksPerSnapshot: 200,
      deletionGrace: "1ms",
    },
  },
};

let harness: SyntheticE2EHarness;

/** Run `fn` with a read impairment in force, and always take it back down. */
async function underImpairment(spec: string | null, fn: () => Promise<void>): Promise<void> {
  if (spec) process.env.OMNESIS_SYNTH_READ_IMPAIRMENT = spec;
  else delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
  try {
    await fn();
  } finally {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
  }
}

/** One source's sync, with the given read impairment in force. */
async function syncUnder(sourceId: string, spec: string | null): Promise<void> {
  await underImpairment(spec, () => harness.triggerSyncAndWait(sourceId, 60_000));
}

/** Every source's sync, with the given read impairment in force. */
async function syncAllUnder(spec: string | null): Promise<void> {
  await underImpairment(spec, () => harness.syncAllSources(240_000));
}

function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
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

/** Documents the gateway actually stores, per source. */
function storedCounts(): Map<string, number> {
  return readDb(
    (db) =>
      new Map(
        db
          .prepare<[], { source_id: string; n: number }>(
            "SELECT source_id, COUNT(*) AS n FROM documents GROUP BY source_id",
          )
          .all()
          .map((r) => [r.source_id, r.n] as const),
      ),
  );
}

function totalDocuments(): number {
  return readDb(
    (db) => db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get()!.n,
  );
}

/** Pending absences a source currently carries. */
function pendingAbsences(sourceId: string): Array<{ externalId: string; observations: number }> {
  return readDb((db) =>
    db
      .prepare<[string], { external_id: string; observations: number }>(
        "SELECT external_id, observations FROM document_absences WHERE source_id = ? ORDER BY external_id",
      )
      .all(sourceId)
      .map((r) => ({ externalId: r.external_id, observations: r.observations })),
  );
}

/** Pending absences per source, across the whole corpus. */
function absencesBySource(): Map<string, number> {
  return readDb(
    (db) =>
      new Map(
        db
          .prepare<[], { source_id: string; n: number }>(
            "SELECT source_id, COUNT(*) AS n FROM document_absences GROUP BY source_id",
          )
          .all()
          .map((r) => [r.source_id, r.n] as const),
      ),
  );
}

/** Ids the absence sweep recorded before deleting. */
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

/**
 * One sweep cycle. The task alternates the document and analytics planes so
 * neither batch is the length of both, so a cycle is one tick of each.
 */
async function runSweep(cycles = 1): Promise<void> {
  for (let i = 0; i < cycles * 2; i++) {
    await harness.gatewayJson("/admin/background/run/absence.sweep", { method: "POST" });
  }
}

/**
 * Sweep until a full cycle deletes nothing further. One tick takes one bounded
 * batch by design, so a backlog larger than a batch drains over cycles; a fixed
 * cycle count would silently under-sweep the day a universe grows.
 */
async function drainSweep(maxCycles = 8): Promise<void> {
  let previous = -1;
  for (let i = 0; i < maxCycles; i++) {
    await runSweep();
    const total = totalDocuments();
    if (total === previous) return;
    previous = total;
  }
  throw new Error(`the absence sweep was still deleting after ${maxCycles} cycles`);
}

/** Rows the structured twin's analytics table holds. */
async function analyticsIds(): Promise<string[]> {
  const result = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT id FROM apple_calendar_events ORDER BY id" }),
  });
  return result.rows.map((r) => String(r[0]));
}

/** Pending analytics absence keys for the calendar twin. */
async function analyticsPendingIds(): Promise<string[]> {
  const result = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
    method: "POST",
    body: JSON.stringify({
      sql:
        "SELECT key_value FROM _analytics_absences " +
        `WHERE source_id = '${CALENDAR}' AND table_name = 'apple_calendar_events' ` +
        "ORDER BY key_value",
    }),
  });
  return result.rows.map((row) => String(row[0]));
}

describe("snapshot absence (e2e-minimal universe, one collector)", () => {
  beforeAll(async () => {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      extraGatewayConfig: ABSENCE_CONFIG,
    });
    await harness.start();
    await harness.triggerSyncAndWait(NOTES, 60_000);
    await harness.triggerSyncAndWait(CALENDAR, 60_000);
  }, 240_000);

  afterAll(async () => {
    delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
    await harness.destroy();
  }, 15_000);

  describe("one source, end to end", () => {
    let calendarBaselineDocuments: string[] = [];
    let calendarBaselineRows: string[] = [];
    let calendarVanished = "";
    test("the fixture corpus is in place before anything goes missing", async () => {
      expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, NOTES)).toBe(3);
      expect(storedIds(NOTES)).toHaveLength(3);
      expect(pendingAbsences(NOTES)).toEqual([]);
    });

    test("a source reporting fewer items than the gateway holds loses none of them", async () => {
      const before = storedIds(NOTES);
      await syncUnder(NOTES, "apple-notes:deleted:1");
      // Captured while it is still true of the last read: `impairedIds` reports
      // what a read did, and every later sync overwrites it.
      const vanished = impairedIds(NOTES);

      expect(vanished).toHaveLength(1);
      // The corpus is untouched, and the omission is on record instead.
      expect(storedIds(NOTES)).toEqual(before);
      expect(pendingAbsences(NOTES)).toEqual([{ externalId: vanished[0]!, observations: 1 }]);
    });

    test("one corroborating snapshot short, the sweep still takes nothing", async () => {
      const before = storedIds(NOTES);
      await runSweep();
      expect(storedIds(NOTES)).toEqual(before);
      expect(auditedIds()).toEqual([]);
    });

    test("a snapshot naming the document again clears the mark for good", async () => {
      const before = storedIds(NOTES);
      // The source recovers: its store reports everything again.
      await syncUnder(NOTES, null);

      expect(pendingAbsences(NOTES)).toEqual([]);
      await runSweep();
      expect(storedIds(NOTES)).toEqual(before);
    });

    test("a source that withholds its snapshot deletes nothing, and that is not an error", async () => {
      // The read is impoverished AND the source declines to vouch for it, so it
      // sends no snapshot. Nothing may be recorded, let alone deleted: an
      // absence the gateway was never told about is not an absence.
      const before = storedIds(NOTES);
      await syncUnder(NOTES, "apple-notes:degraded:1");

      expect(impairedIds(NOTES)).toHaveLength(1);
      expect(storedIds(NOTES)).toEqual(before);
      expect(pendingAbsences(NOTES)).toEqual([]);
      // The sync succeeded — withholding is the contract, not a failure.
      expect(await harness.getSyncState(NOTES)).not.toBeNull();
      await runSweep();
      expect(storedIds(NOTES)).toEqual(before);
    });

    test("the deadline fires: a corroborated absence is deleted through the ordinary path", async () => {
      const before = storedIds(NOTES);

      // Every snapshot but the last leaves the absence short of the floor, so
      // "the corpus is untouched" here is a claim about the gateway rather than
      // about when the sweep last ran.
      let vanished = "";
      for (let observation = 1; observation < MIN_OBSERVATIONS; observation++) {
        await syncUnder(NOTES, "apple-notes:deleted:1");
        vanished = impairedIds(NOTES)[0]!;
        expect(storedIds(NOTES)).toEqual(before);
        expect(pendingAbsences(NOTES)).toEqual([
          { externalId: vanished, observations: observation },
        ]);
      }

      // The snapshot that spends the deadline.
      await syncUnder(NOTES, "apple-notes:deleted:1");
      await runSweep();

      expect(storedIds(NOTES)).toEqual(before.filter((id) => id !== vanished));
      expect(pendingAbsences(NOTES)).toEqual([]);
      // And the loss is auditable after the fact.
      expect(auditedIds()).toEqual([vanished]);
    }, 120_000);

    test("a source tombstone deletes at once through the collector path", async () => {
      // OneDrive's synth delta endpoint emits a genuine deleted facet on its
      // next incremental tick. This drives provider -> SyncResult -> collector
      // -> /documents/with-cursor rather than calling the delete route directly.
      await syncUnder(ONEDRIVE, null);
      const before = storedIds(ONEDRIVE);
      expect(before).toHaveLength(3);
      const doomed = "onedrive-file-002";
      expect(before).toContain(doomed);

      process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE = doomed;
      try {
        await harness.triggerSyncAndWait(ONEDRIVE, 60_000);
      } finally {
        delete process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE;
      }

      expect(storedIds(ONEDRIVE)).toEqual(before.filter((id) => id !== doomed));
      expect(pendingAbsences(ONEDRIVE)).toEqual([]);

      // Restore the shared universe for the breadth phase that follows.
      await harness.gatewayJson(`/documents/delete-all/source/${encodeURIComponent(ONEDRIVE)}`, {
        method: "POST",
      });
      await harness.triggerSyncAndWait(ONEDRIVE, 120_000);
      expect(storedIds(ONEDRIVE)).toEqual(before);
    }, 180_000);

    test("the structured twin: an impoverished read costs the analytics table nothing", async () => {
      const beforeDocs = storedIds(CALENDAR);
      const beforeRows = await analyticsIds();
      expect(beforeRows.length).toBeGreaterThan(0);
      calendarBaselineDocuments = beforeDocs;
      calendarBaselineRows = beforeRows;

      let vanished = "";
      for (let observation = 1; observation < MIN_OBSERVATIONS; observation++) {
        await syncUnder(CALENDAR, "apple-calendar:deleted:1");
        vanished = impairedIds(CALENDAR)[0]!;
        // Both planes hold their ground while the absence is short of the
        // floor, and a sweep in that window takes nothing from either.
        await runSweep();
        expect(await analyticsIds()).toEqual(beforeRows);
        expect(storedIds(CALENDAR)).toEqual(beforeDocs);
      }
      expect(beforeRows).toContain(vanished);
      calendarVanished = vanished;

      // The snapshot that spends the deadline, on both planes at once.
      await syncUnder(CALENDAR, "apple-calendar:deleted:1");
      await drainSweep();

      expect(await analyticsIds()).toEqual(beforeRows.filter((id) => id !== vanished));
      expect(storedIds(CALENDAR)).toEqual(beforeDocs.filter((id) => id !== vanished));
    }, 120_000);

    test("the structured twin recovers when the source does", async () => {
      // The row is gone, but the source now reports it again: the next sync
      // re-ingests it and no absence is left behind.
      await syncUnder(CALENDAR, null);
      expect(pendingAbsences(CALENDAR)).toEqual([]);
      expect(await analyticsPendingIds()).toEqual([]);
      expect(calendarVanished).not.toBe("");
      expect(storedIds(CALENDAR)).toEqual(calendarBaselineDocuments);
      expect(calendarBaselineDocuments).toContain(calendarVanished);
      expect(await analyticsIds()).toEqual(calendarBaselineRows);
    });
  });

  describe("every source in the universe", () => {
    /** The corpus with every source reading cleanly. */
    let baseline: Map<string, number>;
    let baselineThingsIds: string[];
    /** After one vouched-for shrunken snapshot — short of the floor. */
    let afterOneVouch: Map<string, number>;
    let marksAfterOneVouch: Map<string, number>;
    /** After the floor is reached and the deadline spent. */
    let afterDeleted: Map<string, number>;
    let thingsVanished: string[];
    let thingsAfterDeleted: string[];
    /**
     * Sources that provably reconcile deletions: they lost documents once the
     * source had vouched, often enough, for an enumeration the impairment shrank.
     */
    let reconcilers: string[];
    /** The corpus once every read is whole again. */
    let restored: Map<string, number>;
    /** After the same records go missing without the source vouching. */
    let afterDegraded: Map<string, number>;
    let marksAfterDegraded: Map<string, number>;
    let thingsAfterDegraded: string[];

    beforeAll(async () => {
      // The phase above left two sources mid-lifecycle; heal everything and
      // take the baseline from a corpus every source has just vouched for in
      // full.
      await syncAllUnder(null);
      baseline = storedCounts();
      baselineThingsIds = storedIds(THINGS);

      // One vouched-for shrunken snapshot from every source at once. Short of
      // the corroboration floor, so nothing is due and nothing may go.
      await syncAllUnder("*:deleted:2");
      afterOneVouch = storedCounts();
      marksAfterOneVouch = absencesBySource();

      // Corroborate to the floor and spend the deadline. This is the positive
      // control: it *derives* the set of sources this phase can say anything
      // about, rather than listing them. A twin that stops reconciling, or one
      // added tomorrow that never starts, changes the set instead of quietly
      // sitting outside a hand-written array.
      for (let observation = 1; observation < MIN_OBSERVATIONS; observation++) {
        await syncAllUnder("*:deleted:2");
      }
      // Captured while it is still true of the last read; the sweeps and syncs
      // that follow overwrite it.
      thingsVanished = impairedIds(THINGS);
      await drainSweep();
      afterDeleted = storedCounts();
      thingsAfterDeleted = storedIds(THINGS);
      reconcilers = [...baseline]
        .filter(([sourceId, count]) => count > 0 && (afterDeleted.get(sourceId) ?? 0) < count)
        .map(([sourceId]) => sourceId)
        .sort();

      // Put the corpus back, then repeat the identical impairment as many
      // times, with the one difference that matters: the source no longer
      // vouches.
      await syncAllUnder(null);
      restored = storedCounts();
      for (let observation = 0; observation < MIN_OBSERVATIONS; observation++) {
        await syncAllUnder("*:degraded:2");
      }
      marksAfterDegraded = absencesBySource();
      await drainSweep();
      afterDegraded = storedCounts();
      thingsAfterDegraded = storedIds(THINGS);
    }, 900_000);

    test("the baseline sync stored documents for a meaningful number of sources", () => {
      // A floor under the sweep itself. Every assertion below quantifies over
      // `baseline`, so a harness that silently ingested nothing would make the
      // whole phase vacuous.
      const withDocuments = [...baseline].filter(([, n]) => n > 0);
      expect(withDocuments.length).toBeGreaterThanOrEqual(10);
      expect(baseline.get(THINGS)).toBe(3);
    });

    test("one vouched-for shrunken snapshot marks widely and deletes nothing", () => {
      // Half one of the positive control, and the half that catches the
      // original bug head-on: the omissions are seen and recorded right across
      // the universe, and not one of them is applied.
      const lost = [...baseline]
        .filter(([sourceId, count]) => (afterOneVouch.get(sourceId) ?? 0) < count)
        .map(([sourceId, count]) => `${sourceId}: ${count} → ${afterOneVouch.get(sourceId) ?? 0}`);
      expect(
        lost,
        "a single snapshot is never enough evidence to delete, however confidently the source vouches",
      ).toEqual([]);
      expect(
        marksAfterOneVouch.size,
        `only ${marksAfterOneVouch.size} source(s) recorded an absence: ` +
          `${[...marksAfterOneVouch.keys()].join(", ") || "none"} — ` +
          "either the impairment is inert or the twins stopped publishing snapshots",
      ).toBeGreaterThanOrEqual(8);
      expect([...marksAfterOneVouch.keys()]).toContain(THINGS);
    });

    test("corroborated to the floor, the deadline turns those marks into deletions", () => {
      // Half two. Each of these sources demonstrably deletes stored documents
      // once it has vouched for a shrunken enumeration often enough — which is
      // what makes their survival in the degraded half evidence of anything at
      // all. An impairment knob that did nothing, or a sweep that never fired,
      // would empty this list and redden here rather than sailing through a
      // "nothing was deleted" assertion.
      expect(
        reconcilers.length,
        `only ${reconcilers.length} source(s) reconciled: ${reconcilers.join(", ") || "none"} — ` +
          "either the deadline never came due or the sweep is not deleting",
      ).toBeGreaterThanOrEqual(8);
      expect(reconcilers).toContain(THINGS);
      // The sweep deletes what the marks named, not whatever else it found.
      const unmarked = reconcilers.filter((sourceId) => !marksAfterOneVouch.has(sourceId));
      expect(unmarked, "a source lost documents that no snapshot had marked absent").toEqual([]);
    });

    test("the corpus comes back once the reads are whole again", () => {
      const short = [...baseline]
        .filter(([sourceId, count]) => (restored.get(sourceId) ?? 0) < count)
        .map(([sourceId, count]) => `${sourceId}: ${count} → ${restored.get(sourceId) ?? 0}`);
      expect(short, "a source that reads cleanly again re-sends what the sweep took").toEqual([]);
    });

    test("none of those sources loses a document when the same read is degraded", () => {
      // Identical records missing, and as many rounds of it; the only
      // difference is that the source no longer claims to have enumerated
      // everything.
      const lost: string[] = [];
      for (const sourceId of reconcilers) {
        const before = restored.get(sourceId) ?? 0;
        const now = afterDegraded.get(sourceId) ?? 0;
        if (now < before) lost.push(`${sourceId}: ${before} → ${now}`);
      }
      expect(
        lost,
        "a source that could not read all of itself must withhold its snapshot, " +
          "so nothing it failed to enumerate may be deleted",
      ).toEqual([]);
    });

    test("a withheld snapshot does not even start a deadline", () => {
      // Stronger than "nothing was deleted", and the reason the degraded half
      // cannot be satisfied by a sweep that simply never ran: with no snapshot
      // there is no assertion to record, so no mark exists to come due later.
      expect(
        [...marksAfterDegraded].map(([sourceId, n]) => `${sourceId}: ${n}`),
        "an absence the gateway was never told about is not an absence",
      ).toEqual([]);
    });

    test("no other source loses documents either", () => {
      // The wider sweep, over every source the universe carries rather than
      // only the ones proven to reconcile. Weaker evidence per source, but it
      // is what catches a source that starts deleting for some reason nobody
      // predicted.
      const lost: string[] = [];
      for (const [sourceId, count] of restored) {
        const now = afterDegraded.get(sourceId) ?? 0;
        if (now < count) lost.push(`${sourceId}: ${count} → ${now}`);
      }
      expect(lost).toEqual([]);
    });

    test("the deletion is exactly the records the source stopped naming", () => {
      // Identities, not counts. "One document survived" and "the right document
      // survived" are different claims, and only the second one is the
      // contract.
      expect(thingsVanished).toHaveLength(2);
      expect(thingsAfterDeleted).toEqual(
        baselineThingsIds.filter((id) => !thingsVanished.includes(id)),
      );
    });

    test("the records a degraded read could not see are still stored, by id", () => {
      const vanished = impairedIds(THINGS);
      expect(vanished).toHaveLength(2);
      for (const id of vanished) {
        expect(
          thingsAfterDegraded,
          `${id} was hidden from the read, not deleted from the source`,
        ).toContain(id);
      }
      expect(thingsAfterDegraded).toEqual(baselineThingsIds);
    });
  });

  /**
   * A snapshot narrowed to the partitions the source could actually read.
   *
   * The whole-source form above is all-or-nothing: one unreadable store
   * withholds deletion detection for every store that was read, for as long as
   * the broken one stays broken. A claim narrows the assertion, and the property
   * has two halves that a test has to prove together — sweeping the right
   * partition looks exactly like sweeping nothing unless the same cycle does
   * both.
   *
   * The `partitioned` impairment produces exactly that cycle: the `odd`
   * partition is unreadable and unclaimed, while the `even` partition is read,
   * claimed in full, and short some records.
   */
  describe("per-partition snapshot claims (e2e-minimal universe)", () => {
    let evenIds: string[];
    let oddIds: string[];

    beforeAll(async () => {
      // Nested inside the harness's own describe, and healing the source
      // first: the phase above leaves it mid-lifecycle, and a sibling describe
      // would run after that harness had been destroyed — which is a
      // `beforeAll` that throws and three tests reported as skipped.
      //
      // Every synthetic document carries its partition, healthy cycles
      // included, so the claims below reach documents ingested before any
      // impairment.
      delete process.env.OMNESIS_SYNTH_READ_IMPAIRMENT;
      await harness.triggerSyncAndWait(NOTES, 60_000);
      const rows = readDb((db) =>
        db
          .prepare<
            [string],
            { external_id: string; partition_key: string }
          >("SELECT external_id, partition_key FROM documents WHERE source_id = ? ORDER BY external_id")
          .all(NOTES),
      );
      evenIds = rows.filter((r) => r.partition_key === "even").map((r) => r.external_id);
      oddIds = rows.filter((r) => r.partition_key === "odd").map((r) => r.external_id);
    }, 120_000);

    test("a healthy cycle stamps every document with the partition it came from", () => {
      // Without this the claims below would name partitions no stored document
      // is in, and the sweep would touch nothing — which passes for the wrong
      // reason.
      expect(evenIds.length).toBeGreaterThan(0);
      expect(oddIds.length).toBeGreaterThan(0);
    });

    test("a deletion in the readable partition is found while the other is unreadable", async () => {
      const before = storedIds(NOTES);
      // One record gone from `even`; `odd` cannot be read at all.
      for (let i = 0; i < MIN_OBSERVATIONS; i++) {
        await syncUnder(NOTES, `${NOTES}:partitioned:1`);
      }
      const vanished = impairedIds(NOTES);
      expect(vanished).toHaveLength(1);
      expect(evenIds).toContain(vanished[0]);

      // Only the record from the claimed partition is marked. Nothing in `odd`
      // is evidence of anything, however many cycles omit it.
      const marked = pendingAbsences(NOTES).map((a) => a.externalId);
      expect(marked).toEqual(vanished);

      await drainSweep();

      expect(storedIds(NOTES)).toEqual(before.filter((id) => !vanished.includes(id)));
      // Said the other way round, because this is the half the old shape could
      // not have: every record in the store that would not open is still here.
      for (const id of oddIds) expect(storedIds(NOTES)).toContain(id);
    }, 180_000);

    test("the unreadable partition recovers, and so does the note that was swept", async () => {
      // The corpus is whole again — not merely unchanged. The note the cycles
      // above deleted was deleted because the source stopped naming it, and a
      // repaired read names it again, so it comes back. The claim worth making
      // is that the healthy corpus is exactly what the healthy cycle produced,
      // in both partitions: asserting "nothing changed" would instead be
      // asserting that the repair did nothing.
      await syncUnder(NOTES, null);
      expect(storedIds(NOTES).sort()).toEqual([...evenIds, ...oddIds].sort());
    }, 120_000);
  });
});
