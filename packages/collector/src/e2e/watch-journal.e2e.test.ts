// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Watch journal, produced by a real gateway.
 *
 * The materializer's unit tests drive it against a hand-built database. This
 * one drives it the only other way that matters: a spawned gateway, real
 * sources, the real ingest path, the real bus, the real scheduler — because
 * every commitment in the journal contract is about the substrate's actual
 * behaviour, and a materializer that satisfies a fixture and not the substrate
 * has satisfied nothing.
 *
 * The cases are the failures the contract exists to prevent, each one observed
 * on the shipped path before this runtime existed:
 *
 * - a document event carrying no person ids, because resolution had not
 *   finished when the bus fired;
 * - a row counted again on every sync page, and again on every re-bootstrap;
 * - a source's own bookkeeping column moving and reading as news, which needs
 *   the whole provider-schema-to-catalog round trip to be worth testing;
 * - a live event misread as history, which silences a watch with nothing to
 *   see;
 * - an update storm on one document, where every individual event was correct
 *   and the sequence said the same thing four times.
 *
 * Nothing here asserts a firing. In shadow mode the journal is the whole
 * output: it is written, and nothing reads it.
 */

import "./synth-env.js";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

interface JournalRow {
  seq: number;
  kind: string;
  occurred_at: string;
  observed_at: string;
  payload: string;
}

interface DocEventPayload {
  op: "created" | "updated";
  docId: string;
  sourceId: string;
  documentType: string | null;
  title: string;
  contentChanged: boolean;
  changedFields: string[];
  metadata: Record<string, unknown>;
  people: { personId: string | null; role: string; isSelf: boolean }[];
  degraded?: boolean;
}

interface AnalyticsRowPayload {
  op: "inserted" | "updated";
  table: string;
  sourceId: string;
  pk: Record<string, unknown>;
  row: Record<string, unknown>;
  backfill?: boolean;
}

const TABLE = "e2e_watch2_payments";
const VOLATILE_TABLE = "e2e_watch2_activities";
const STORM_EXTERNAL_ID = "watch2-storm-1";

describe("the watch journal (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let journalPath: string;

  beforeAll(async () => {
    // The whole subsystem is gated: without this the gateway creates no file,
    // subscribes to nothing, and registers no task.
    harness = new SyntheticE2EHarness({ gatewayMode: "experimental", universe: "e2e-minimal" });
    await harness.start();
    journalPath = join(harness.getConfigDir(), "watch.db");
    await harness.syncAllSources();
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("a real sync produces document events with settled people", async () => {
    // Waiting for "any document event" would return on the first note or
    // bookmark — documents with no people at all — and then assert something
    // about people. The wait polls exactly what the assertion needs.
    const events = await waitFor(
      "a document event carrying a resolved person",
      () => read(journalPath).filter((e) => e.kind === "doc.event"),
      (found) =>
        found.some((e) =>
          (JSON.parse(e.payload) as DocEventPayload).people.some((p) => p.personId !== null),
        ),
      120_000,
    );

    for (const event of events) {
      const payload = JSON.parse(event.payload) as DocEventPayload;
      // Every mention is either resolved to a canonical id or the event says
      // out loud that it shipped without them. A null id on an event that does
      // not admit to being degraded is the failure this contract exists for:
      // a person-keyed predicate that silently matches nothing.
      const unresolved = payload.people.filter((p) => p.personId === null);
      if (unresolved.length > 0) {
        expect(
          payload.degraded,
          `${payload.docId} carries unresolved people without saying so`,
        ).toBe(true);
      }
      expect(payload.docId).toMatch(/^[0-9a-f-]{36}$/);
      expect(payload.op === "created" || payload.op === "updated").toBe(true);
    }

    const withPeople = events
      .map((e) => JSON.parse(e.payload) as DocEventPayload)
      .filter((p) => p.people.length > 0);
    expect(
      withPeople.some((p) => p.people.some((mention) => mention.personId !== null)),
      "no document event in the whole sync resolved a single person",
    ).toBe(true);
  }, 180_000);

  test("an analytics row re-pushed unchanged is journaled once", async () => {
    const row = {
      id: "watch2-txn-1",
      amount: 42.5,
      transacted_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
    };
    await harness.pushAnalyticsRow(TABLE, row, { primaryKey: ["id"] });
    await waitFor(
      "the first arrival of watch2-txn-1 to be journaled",
      () => rowsFor(journalPath, TABLE, "watch2-txn-1"),
      (found) => found.length === 1,
      60_000,
    );

    // The same row again, exactly as a second sync page would deliver it.
    await harness.pushAnalyticsRow(TABLE, row, { primaryKey: ["id"] });
    await harness.pushAnalyticsRow(TABLE, row, { primaryKey: ["id"] });
    await drainedThrough(harness, journalPath);

    expect(
      rowsFor(journalPath, TABLE, "watch2-txn-1").length,
      "a re-delivered row was journaled again",
    ).toBe(1);

    // A real change is still news.
    await harness.pushAnalyticsRow(TABLE, { ...row, amount: 99.5 }, { primaryKey: ["id"] });
    const afterChange = await waitFor(
      "the changed amount on watch2-txn-1 to be journaled",
      () => rowsFor(journalPath, TABLE, "watch2-txn-1"),
      (found) => found.length === 2,
      60_000,
    );
    expect(afterChange.map((p) => p.op)).toEqual(["inserted", "updated"]);
  }, 180_000);

  test("a live push is never mistaken for a source replaying its history", async () => {
    // Both readings of the flag are pinned in `replaying-history.test.ts`,
    // where the signals can be stated directly. What only a real gateway can
    // check is the direction that fails silently: a live event classified as
    // history is dropped by every arrival watch, with nothing to see.
    //
    // Two sources, reaching the classification along different routes. One has
    // synced and reports an incremental phase, so the sync registry knows it.
    // The other is a source id the registry has never heard of — no phase, no
    // import — which is what anything pushing without the collector's sync
    // machinery looks like. Both are live, and a classification that read
    // either as history would silence a watch with nothing to see.
    const live = harness.getSourceIds().find((id) => id.startsWith("plaid:"));
    expect(live, "the universe has no synced source to attribute a live row to").toBeDefined();

    const cases: { id: string; table: string; sourceId: string; why: string }[] = [
      {
        id: "watch2-live-1",
        table: `${TABLE}_plaid`,
        sourceId: live!,
        why: "a caught-up source",
      },
      {
        id: "watch2-push-1",
        table: `${TABLE}_push`,
        sourceId: "never-synced:nobody@example.com",
        why: "a source that pushes without ever syncing",
      },
    ];

    for (const { id, table, sourceId, why } of cases) {
      await harness.pushAnalyticsRow(
        table,
        { id, amount: 8, transacted_at: new Date().toISOString() },
        { primaryKey: ["id"], sourceId },
      );
      const arrived = await waitFor(
        `the row from ${why} to be journaled`,
        () => rowsFor(journalPath, table, id),
        (found) => found.length === 1,
        60_000,
      );
      expect(arrived[0]?.backfill, `${why} had its live row read as history`).toBeUndefined();
    }
  }, 180_000);

  test("an update storm on one document says something new exactly once", async () => {
    // What this checks is the journal's fidelity, not a judgement it makes:
    // `contentChanged` is the bus's verdict, computed from the content hashes
    // either side of the write, and the materializer carries it through
    // verbatim. The value of the case is that the runtime's one-firing-per-
    // episode rule reads exactly this field, so a journal that garbled it
    // would break that rule with nothing else showing.
    const base = {
      externalId: STORM_EXTERNAL_ID,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: "Spring works — quote",
      content: "The quote for the spring works is attached.",
    };
    await harness.pushDocument(base);
    await waitFor(
      "the storm document's first event to be journaled",
      () => docEventsFor(journalPath),
      (found) => found.length === 1,
      60_000,
    );

    // Four bookkeeping updates: a label moves, a flag flips, the source
    // re-stamps its own metadata. The body never changes.
    for (let i = 0; i < 4; i += 1) {
      await harness.pushDocument({ ...base, metadata: { tags: [`pass-${i}`] } });
    }
    // A positive barrier on the documents themselves. The analytics sentinel
    // would not do here: documents and rows sit in separate queues, and a
    // document deferred for people settlement can still be waiting when a row
    // pushed after it has drained — so a "nothing extra was said" assertion
    // would pass because the work had not happened.
    const events = await waitFor(
      "all five of the storm document's events to be journaled",
      () => docEventsFor(journalPath),
      (found) => found.length === 5,
      60_000,
    );
    const said = events.filter((e) => e.contentChanged);
    expect(
      said.length,
      `the storm reported ${said.length} content changes; the document said one thing`,
    ).toBe(1);
    expect(said[0]?.op, "the one thing it said was not the arrival").toBe("created");

    // And a real revision is heard.
    await harness.pushDocument({ ...base, content: "The revised quote is attached." });
    const afterRevision = await waitFor(
      "the storm document's revision to be journaled",
      () => docEventsFor(journalPath),
      (found) => found.filter((e) => e.contentChanged).length === 2,
      60_000,
    );
    const revision = afterRevision.filter((e) => e.contentChanged).at(-1);
    expect(revision?.op, "a revision of a known document was journaled as a creation").toBe(
      "updated",
    );
    // The updates are journaled as updates rather than dropped or duplicated:
    // a materializer that emitted nothing for them, or one that emitted forty,
    // would satisfy the content-change count above just as well. The creation
    // is asserted exactly — there is only ever one — while the update count is
    // a floor, because the startup sweep legitimately re-emits the newest
    // timestamp group as an extra `updated`.
    const ops = afterRevision.map((e) => e.op);
    expect(
      ops.filter((op) => op === "created"),
      "the arrival was journaled more than once",
    ).toEqual(["created"]);
    expect(ops.length, "an update went missing between the pushes and the journal").toBe(6);
  }, 180_000);

  test("a volatile column declared by a source really reaches the dedup hash", async () => {
    // The seam this closes: the unit tests hand the materializer a schema
    // object directly, so nothing exercises provider schema → ingest →
    // DuckDB catalog → journal. If the catalog dropped `volatile` on the round
    // trip, every unit test would stay green and the churn the flag exists to
    // stop would come straight back.
    const schema: AnalyticsTableSchema = {
      tableName: VOLATILE_TABLE,
      displayName: "Enriched activities",
      description: "One row per activity, re-stamped by an enrichment pass",
      columns: [
        { name: "id", type: "VARCHAR", description: "identity" },
        { name: "distance_m", type: "DOUBLE", description: "how far" },
        { name: "recorded_at", type: "TIMESTAMPTZ", description: "when" },
        {
          name: "detail_fetched_at",
          type: "TIMESTAMPTZ",
          description: "when the detail was last fetched",
          nullable: true,
          volatile: true,
        },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "recorded_at",
    };
    const activity = {
      id: "watch2-activity-1",
      distance_m: 10_000,
      recorded_at: new Date().toISOString(),
      detail_fetched_at: new Date().toISOString(),
    };

    await harness.pushAnalyticsRow(VOLATILE_TABLE, activity, { schema });
    await waitFor(
      "the activity's first arrival to be journaled",
      () => rowsFor(journalPath, VOLATILE_TABLE, activity.id),
      (found) => found.length === 1,
      60_000,
    );

    // The enrichment pass runs: the stamp moves, nothing a person would
    // recognise does.
    await harness.pushAnalyticsRow(
      VOLATILE_TABLE,
      { ...activity, detail_fetched_at: new Date(Date.now() + 3_600_000).toISOString() },
      { schema },
    );
    await drainedThrough(harness, journalPath);
    expect(
      rowsFor(journalPath, VOLATILE_TABLE, activity.id).length,
      "the declared volatile column did not survive the catalog round trip",
    ).toBe(1);

    // And a column that means something still speaks.
    await harness.pushAnalyticsRow(VOLATILE_TABLE, { ...activity, distance_m: 12_000 }, { schema });
    const heard = await waitFor(
      "the changed distance to be journaled",
      () => rowsFor(journalPath, VOLATILE_TABLE, activity.id),
      (found) => found.length === 2,
      60_000,
    );
    expect(heard.map((r) => r.op)).toEqual(["inserted", "updated"]);
  }, 180_000);

  test("the journal is a plain ordered sequence with both clocks on every event", async () => {
    const rows = read(journalPath);
    expect(rows.length).toBeGreaterThan(0);

    let previous = 0;
    for (const row of rows) {
      expect(row.seq, "sequence numbers are not strictly increasing").toBeGreaterThan(previous);
      previous = row.seq;
      // `observed_at` is processing time and only moves forward; `occurred_at`
      // is semantic and may run backwards whenever a source backfills. Both
      // must be real instants — a NaN date would silently switch off every
      // ordering comparison downstream rather than failing one.
      expect(Number.isNaN(Date.parse(row.occurred_at))).toBe(false);
      expect(Number.isNaN(Date.parse(row.observed_at))).toBe(false);
    }
  });
});

/** Read the journal through its own connection — the gateway holds the file. */
function read(path: string): JournalRow[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare<
        [],
        JournalRow
      >("SELECT seq, kind, occurred_at, observed_at, payload FROM watch_events ORDER BY seq ASC")
      .all();
  } finally {
    db.close();
  }
}

function rowsFor(path: string, table: string, id: string): AnalyticsRowPayload[] {
  return read(path)
    .filter((e) => e.kind === "analytics.row")
    .map((e) => JSON.parse(e.payload) as AnalyticsRowPayload)
    .filter((p) => p.table === table && p.pk["id"] === id);
}

function docEventsFor(path: string): DocEventPayload[] {
  // The journal carries no external id — it is not something a watch can ask
  // about — so the document is found by the id its first event announced.
  const docId = stormDocId(path);
  if (!docId) return [];
  return read(path)
    .filter((e) => e.kind === "doc.event")
    .map((e) => JSON.parse(e.payload) as DocEventPayload)
    .filter((p) => p.docId === docId);
}

/**
 * The document id the storm's pushes resolve to, once one has landed.
 *
 * Cached only once it is known. Caching an empty answer would pin the filter
 * to a document that does not exist yet, and every later read would agree with
 * it — a wait that can never finish for a reason the failure would not name.
 */
let cachedStormDocId: string | null = null;
function stormDocId(path: string): string {
  if (cachedStormDocId) return cachedStormDocId;
  const first = read(path)
    .filter((e) => e.kind === "doc.event")
    .map((e) => JSON.parse(e.payload) as DocEventPayload)
    .find((p) => p.title.startsWith("Spring works"));
  if (first) cachedStormDocId = first.docId;
  return cachedStormDocId ?? "";
}

/**
 * Wait until the drain has caught up.
 *
 * The materializer ticks every two seconds and defers a document until its
 * people settle, so "the gateway accepted the push" and "the journal holds the
 * event" are different moments. Nothing here polls a clock as a proxy for
 * progress: each caller waits on the condition it actually cares about.
 */
async function waitFor<T>(
  what: string,
  read: () => T,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = read();
  }
  if (!done(last)) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  return last;
}

/**
 * Prove the drain has caught up with everything pushed so far.
 *
 * Asserting that something did NOT land needs a positive barrier, not a
 * timeout: waiting for the journal to "stop growing" passes just as happily
 * when the work has not started, and the journal keeps growing anyway as the
 * indexer's sweep lands `doc.indexed` events behind the test's back.
 *
 * So a sentinel row is pushed and waited for. The queue is FIFO, so the
 * sentinel appearing proves everything queued before it has drained — and the
 * wait throws if it never does, rather than returning quietly.
 */
let sentinels = 0;
async function drainedThrough(harness: SyntheticE2EHarness, path: string): Promise<void> {
  sentinels += 1;
  const id = `watch2-sentinel-${sentinels}`;
  await harness.pushAnalyticsRow(
    TABLE,
    { id, amount: 0, transacted_at: new Date().toISOString() },
    { primaryKey: ["id"] },
  );
  await waitFor(
    `the drain to reach sentinel ${id}`,
    () => rowsFor(path, TABLE, id),
    (found) => found.length === 1,
    60_000,
  );
}
