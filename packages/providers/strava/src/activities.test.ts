// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { StravaActivitiesSource } from "./activities.js";
import { computeSummaryHash } from "./normalizer-detail.js";
import { activitySchemas } from "./schemas.js";
import type { StravaActivitiesCursor, StravaSummaryActivity } from "./types.js";
import type { StravaClient, ListActivitiesParams } from "./client.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";

function makeActivity(id: number, startDateIso: string): StravaSummaryActivity {
  return {
    id,
    athlete: { id: 42 },
    name: `Activity ${id}`,
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 50,
    type: "Run",
    sport_type: "Run",
    start_date: startDateIso,
    start_date_local: startDateIso.replace("Z", ""),
    has_heartrate: false,
    kudos_count: 0,
    comment_count: 0,
    athlete_count: 1,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
  };
}

/**
 * Mock Strava client that replays a canned sequence of pages from `listActivities`.
 * Records the params passed on each call.
 */
class MockClient {
  public calls: ListActivitiesParams[] = [];
  constructor(private pages: StravaSummaryActivity[][]) {}
  listActivities(params: ListActivitiesParams): Promise<StravaSummaryActivity[]> {
    this.calls.push(params);
    const page = this.pages.shift() ?? [];
    return Promise.resolve(page);
  }
  // Unused methods — satisfy the interface only if called.
  getAthleteDetail(): Promise<never> {
    throw new Error("getAthleteDetail not expected");
  }
  getTokens(): never {
    throw new Error("getTokens not expected");
  }
}

const providerId = ProviderId("strava:42");
const sourceId = SourceId("strava-activities:42");

function makeSource(
  pages: StravaSummaryActivity[][],
  dataCutoff?: string,
  athleteName?: string,
): {
  source: StravaActivitiesSource;
  mock: MockClient;
} {
  const mock = new MockClient(pages);
  const source = new StravaActivitiesSource(
    mock as unknown as StravaClient,
    sourceId,
    providerId,
    dataCutoff,
    athleteName,
  );
  return { source, mock };
}

/**
 * Minimal gateway stub for edit-sweep tests. `storedHashes` maps activity id
 * → the `summary_hash` already persisted in the analytics DB; `queryAnalytics`
 * answers the `SELECT id, summary_hash FROM strava_activities WHERE id IN (…)`
 * issued by the edit-sweep, returning a row only for ids it knows about.
 */
class MockAnalytics implements SourceAnalyticsAccess {
  public queries: string[] = [];
  constructor(private storedHashes: Map<number, string | null>) {}
  query(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    const rows: Record<string, unknown>[] = [];
    for (const [id, hash] of this.storedHashes) {
      if (sql.includes(String(id))) rows.push({ id, summary_hash: hash });
    }
    return Promise.resolve({ columns: ["id", "summary_hash"], rows });
  }
}

function makeSourceWithGateway(
  pages: StravaSummaryActivity[][],
  storedHashes: Map<number, string | null>,
): { source: StravaActivitiesSource; mock: MockClient; gateway: MockAnalytics } {
  const mock = new MockClient(pages);
  // No cast: the facet is small enough to implement outright, which is the
  // point of narrowing it.
  const gateway = new MockAnalytics(storedHashes);
  const source = new StravaActivitiesSource(
    mock as unknown as StravaClient,
    sourceId,
    providerId,
    undefined,
    undefined,
    42,
    gateway,
  );
  return { source, mock, gateway };
}

async function drain(
  source: StravaActivitiesSource,
  initial: StravaActivitiesCursor | null = null,
  maxIterations = 20,
): Promise<{ totalRecords: number; totalDocs: number; finalCursor: StravaActivitiesCursor }> {
  let cursor: StravaActivitiesCursor | null = initial;
  let totalRecords = 0;
  let totalDocs = 0;
  for (let i = 0; i < maxIterations; i++) {
    const result = await source.syncStructured(cursor);
    totalRecords += rowsFor(result, "strava_activities").length;
    totalDocs += result.documents?.length ?? 0;
    cursor = result.cursor as StravaActivitiesCursor;
    if (!result.hasMore) break;
  }
  return { totalRecords, totalDocs, finalCursor: cursor! };
}

describe("StravaActivitiesSource.syncStructured backfill", () => {
  test("paginates backfill until a short page ends it, then flips cursor to incremental", async () => {
    // 3 pages: 100, 100, 42. The short third page ends backfill; hasMore=false.
    // Cursor transitions to incremental so the *next* sync cycle picks up new data.
    const pages: StravaSummaryActivity[][] = [
      Array.from({ length: 100 }, (_, i) => makeActivity(10000 - i, "2026-04-17T00:00:00Z")),
      Array.from({ length: 100 }, (_, i) => makeActivity(9000 - i, "2026-03-01T00:00:00Z")),
      Array.from({ length: 42 }, (_, i) => makeActivity(8000 - i, "2026-01-01T00:00:00Z")),
    ];
    const { source, mock } = makeSource(pages);

    const { totalRecords, totalDocs, finalCursor } = await drain(source);

    expect(totalRecords).toBe(242);
    expect(totalDocs).toBe(242);
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]!.page).toBe(1);
    expect(mock.calls[1]!.page).toBe(2);
    expect(mock.calls[2]!.page).toBe(3);

    expect(finalCursor.phase).toBe("incremental");
    // Newest activity we saw had id 10000 on page 1 (2026-04-17).
    expect(finalCursor.lastActivityTimestamp).toBe(
      Math.floor(new Date("2026-04-17T00:00:00Z").getTime() / 1000),
    );
  });

  test("after transitioning, the next sync call issues an incremental request", async () => {
    const pages: StravaSummaryActivity[][] = [
      Array.from({ length: 42 }, (_, i) => makeActivity(800 - i, "2026-04-17T00:00:00Z")),
      // Next cycle — incremental with `after`
      [],
    ];
    const { source, mock } = makeSource(pages);
    const r1 = await source.syncStructured(null);
    expect(r1.hasMore).toBe(false);
    const cursor = r1.cursor as StravaActivitiesCursor;
    expect(cursor.phase).toBe("incremental");

    await source.syncStructured(cursor);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.page).toBe(1);
    expect(mock.calls[1]!.after).toBeDefined();
    expect(mock.calls[1]!.before).toBeUndefined();
  });

  test("each backfill page reuses the same `before` anchor", async () => {
    const pages: StravaSummaryActivity[][] = [
      Array.from({ length: 100 }, (_, i) => makeActivity(200 - i, "2026-04-17T00:00:00Z")),
      [], // end backfill
    ];
    const { source, mock } = makeSource(pages);
    // First call
    const r1 = await source.syncStructured(null);
    expect(r1.hasMore).toBe(true);
    const c1 = r1.cursor as StravaActivitiesCursor;
    expect(c1.phase).toBe("backfill");
    expect(c1.backfillPage).toBe(2);

    // Second call uses the same backfillBefore
    const r2 = await source.syncStructured(c1);
    expect(r2.hasMore).toBe(false);
    expect(mock.calls[0]!.before).toBe(mock.calls[1]!.before);
  });

  test("applies dataCutoff as `after` parameter", async () => {
    const { source, mock } = makeSource([[]], "2025-01-01T00:00:00.000Z");
    await source.syncStructured(null);
    expect(mock.calls[0]!.after).toBe(
      Math.floor(new Date("2025-01-01T00:00:00.000Z").getTime() / 1000),
    );
  });
});

describe("StravaActivitiesSource.syncStructured incremental", () => {
  test("incremental call uses `after=lastActivityTimestamp`", async () => {
    const { source, mock } = makeSource([[makeActivity(1, "2026-04-18T10:00:00Z")]]);
    const cursor: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      // Set both cadence stamps to recent values to skip the snapshot
      // rewalk and the edit-sweep gates — this test specifically exercises
      // the incremental fetch shape.
      lastSnapshotAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastEditSweepAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    const result = await source.syncStructured(cursor);
    expect(rowsFor(result, "strava_activities")).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(mock.calls[0]!.after).toBe(1700000000);
  });

  test("reports hasMore=true when a full page comes back, advances cursor", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeActivity(i + 1, `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const { source } = makeSource([fullPage, []]);
    const cursor: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 0,
      lastSnapshotAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastEditSweepAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };

    const r1 = await source.syncStructured(cursor);
    expect(r1.hasMore).toBe(true);
    expect(rowsFor(r1, "strava_activities")).toHaveLength(100);

    const r2 = await source.syncStructured(r1.cursor as StravaActivitiesCursor);
    expect(r2.hasMore).toBe(false);
    expect(rowsFor(r2, "strava_activities")).toHaveLength(0);
  });
});

describe("StravaActivitiesSource result shape", () => {
  test("emits records and documents of equal length to the same table", async () => {
    const { source } = makeSource([
      [makeActivity(1, "2026-04-18T10:00:00Z"), makeActivity(2, "2026-04-17T10:00:00Z")],
    ]);
    const result = await source.syncStructured(null);
    expect(tablesWritten(result)).toContain("strava_activities");
    expect(rowsFor(result, "strava_activities").length).toBe(result.documents!.length);
    expect(rowsFor(result, "strava_activities").length).toBe(2);
    expect(result.progress?.phase).toBe("bootstrap");
  });

  test("threads athleteName through to emitted documents as owner PersonMention with LID", async () => {
    const { source } = makeSource(
      [[makeActivity(1, "2026-04-18T10:00:00Z")]],
      undefined,
      "James Bond",
    );
    const result = await source.syncStructured(null);
    expect(result.documents![0]!.metadata.people).toEqual([
      { role: "owner", name: "James Bond", lids: ["strava-athlete:42"] },
    ]);
  });

  test("omits people when no athleteName is provided", async () => {
    const { source } = makeSource([[makeActivity(1, "2026-04-18T10:00:00Z")]]);
    const result = await source.syncStructured(null);
    expect(result.documents![0]!.metadata.people).toBeUndefined();
  });
});

describe("StravaActivitiesSource snapshot reconciliation (rewalk phase)", () => {
  test("a rewalk that comes back much smaller still reconciles", async () => {
    // A rewalk ending on a short page is ambiguous — end of the account, or a
    // page Strava truncated. That ambiguity is about magnitude, and the source
    // cannot resolve it: it has no idea how many activities the gateway holds.
    // Withholding would tell the gateway nothing at all, so the absence would
    // never be marked and the deletion would be cancelled rather than delayed.
    const { source } = makeSource([[makeActivity(1, "2026-04-18T10:00:00Z")]]);
    const result = await source.syncStructured({
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
    } satisfies StravaActivitiesCursor);

    expect(result.presentExternalIds).toEqual(["1"]);
    expect(result.analytics).toEqual(
      activitySchemas.map((schema) => ({
        tableName: schema.tableName,
        records: [],
        presentKeys: [{ [schema.tableName === "strava_activities" ? "id" : "activity_id"]: "1" }],
      })),
    );
  });

  test("an emptied account reconciles to zero", async () => {
    const { source } = makeSource([[]]);
    const result = await source.syncStructured({
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
    } satisfies StravaActivitiesCursor);

    expect(result.presentExternalIds).toEqual([]);
    expect(result.analytics).toEqual(
      activitySchemas.map((schema) => ({
        tableName: schema.tableName,
        records: [],
        presentKeys: [],
      })),
    );
  });

  test("incremental cursor with no lastSnapshotAt enters snapshot-rewalk", async () => {
    // Mock returns a single short page → rewalk completes in one call.
    const { source, mock } = makeSource([
      [makeActivity(1, "2026-04-18T10:00:00Z"), makeActivity(2, "2026-04-17T10:00:00Z")],
    ]);

    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      // no lastSnapshotAt → first incremental cycle, snapshot triggers.
    };
    const result = await source.syncStructured(cur);

    // The snapshot phase doesn't ingest records / documents — it only
    // computes the present-id set.
    expect(rowsFor(result, "strava_activities")).toHaveLength(0);
    expect(result.documents ?? []).toHaveLength(0);
    expect(result.presentExternalIds?.sort()).toEqual(["1", "2"]);

    // Cursor returned to incremental, lastSnapshotAt stamped, transients cleared.
    const c = result.cursor as StravaActivitiesCursor;
    expect(c.phase).toBe("incremental");
    expect(c.lastSnapshotAt).toBeTruthy();
    expect(c.snapshotIds).toBeUndefined();
    expect(c.snapshotPage).toBeUndefined();

    // Used `before=` for the rewalk pin, page 1.
    expect(mock.calls[0]!.before).toBeTypeOf("number");
    expect(mock.calls[0]!.page).toBe(1);
  });

  test("multi-page snapshot accumulates IDs across pages, emits on the final short page", async () => {
    // 100 + 100 + 42 — the final short page ends the rewalk.
    const pages: StravaSummaryActivity[][] = [
      Array.from({ length: 100 }, (_, i) => makeActivity(1000 + i, "2026-04-17T00:00:00Z")),
      Array.from({ length: 100 }, (_, i) => makeActivity(2000 + i, "2026-03-01T00:00:00Z")),
      Array.from({ length: 42 }, (_, i) => makeActivity(3000 + i, "2026-01-01T00:00:00Z")),
    ];
    const { source, mock } = makeSource(pages);

    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
    };

    // First page: 100 results, hasMore=true, no presentExternalIds yet.
    let result = await source.syncStructured(cur);
    expect(result.hasMore).toBe(true);
    expect(result.presentExternalIds).toBeUndefined();
    expect((result.cursor as StravaActivitiesCursor).snapshotIds?.length).toBe(100);

    // Second page: 100 more, still no emission.
    result = await source.syncStructured(result.cursor as StravaActivitiesCursor);
    expect(result.hasMore).toBe(true);
    expect(result.presentExternalIds).toBeUndefined();
    expect((result.cursor as StravaActivitiesCursor).snapshotIds?.length).toBe(200);

    // Third page: short → rewalk completes, presentExternalIds emitted with all 242 ids.
    result = await source.syncStructured(result.cursor as StravaActivitiesCursor);
    expect(result.hasMore).toBe(false);
    expect(result.presentExternalIds?.length).toBe(242);
    expect(result.issues).toEqual([]);

    // Three calls, all using the same `before` pin.
    expect(mock.calls).toHaveLength(3);
    const pin = mock.calls[0]!.before;
    expect(mock.calls[1]!.before).toBe(pin);
    expect(mock.calls[2]!.before).toBe(pin);
  });

  test("recently-snapshotted source skips rewalk and runs incremental as usual", async () => {
    // lastSnapshotAt is 1h ago — well inside the 24h interval. No rewalk.
    const { source, mock } = makeSource([[makeActivity(99, "2026-04-19T10:00:00Z")]]);
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      lastSnapshotAt: recent,
      lastEditSweepAt: recent,
    };

    const result = await source.syncStructured(cur);
    expect(rowsFor(result, "strava_activities").length).toBe(1);
    expect(result.documents!.length).toBe(1);
    expect(result.presentExternalIds).toBeUndefined();
    // Incremental call uses `after`, not `before`.
    expect(mock.calls[0]!.after).toBeDefined();
    expect(mock.calls[0]!.before).toBeUndefined();
    // lastSnapshotAt unchanged.
    expect((result.cursor as StravaActivitiesCursor).lastSnapshotAt).toBe(recent);
  });

  test("incremental cursor with no lastEditSweepAt enters edit-sweep when snapshot is fresh", async () => {
    // Edits to existing activities never appear in the `after=`-driven
    // incremental stream (Strava's `after` filters on start_date, not
    // last_modified). The 6h-cadence edit-sweep re-walks the last 30 days and
    // re-ingests changed activities so the summary_hash diff picks up edits.
    //
    // Without a gateway the sweep can't read the stored hashes to diff
    // against, so — like the other enrichment phases — it is a no-op that
    // stamps the cadence and returns to incremental.
    const { source, mock } = makeSource([
      [makeActivity(11, "2026-04-19T10:00:00Z"), makeActivity(12, "2026-04-18T10:00:00Z")],
    ]);
    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      // Snapshot was just done; only edit-sweep should fire.
      lastSnapshotAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      // No lastEditSweepAt → edit-sweep gate triggers.
    };
    const result = await source.syncStructured(cur);

    // No gateway → no diff possible → no records, but the cadence advances.
    expect(rowsFor(result, "strava_activities").length).toBe(0);
    // Sweep doesn't emit presentExternalIds — that's the snapshot's job.
    expect(result.presentExternalIds).toBeUndefined();
    // Cursor: back to incremental, lastEditSweepAt stamped.
    const c = result.cursor as StravaActivitiesCursor;
    expect(c.phase).toBe("incremental");
    expect(c.lastEditSweepAt).toBeTruthy();
    // No upstream fetch happens on the no-gateway no-op path.
    expect(mock.calls).toHaveLength(0);
  });

  test("recently-edit-swept source stays incremental (no sweep, no rewalk)", async () => {
    const { source, mock } = makeSource([[makeActivity(13, "2026-04-19T10:00:00Z")]]);
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      lastSnapshotAt: recent,
      lastEditSweepAt: recent,
    };
    await source.syncStructured(cur);
    // Single call — incremental — uses lastActivityTimestamp.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.after).toBe(1700000000);
  });

  test("snapshot wins over edit-sweep when both are due", async () => {
    const { source } = makeSource([[makeActivity(14, "2026-04-19T10:00:00Z")]]);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      lastSnapshotAt: stale, // snapshot due
      lastEditSweepAt: stale, // edit-sweep also due
    };
    const result = await source.syncStructured(cur);
    // Snapshot ran (presentExternalIds emitted, records empty).
    expect(result.presentExternalIds).toBeDefined();
    expect(rowsFor(result, "strava_activities")).toHaveLength(0);
  });

  test("stale snapshot (>24h) re-enters rewalk", async () => {
    const { source } = makeSource([[makeActivity(7, "2026-04-19T10:00:00Z")]]);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const cur: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1700000000,
      lastSnapshotAt: stale,
    };

    const result = await source.syncStructured(cur);
    expect(result.presentExternalIds).toEqual(["7"]);
    const c = result.cursor as StravaActivitiesCursor;
    expect(c.lastSnapshotAt).not.toBe(stale);
  });
});

describe("StravaActivitiesSource edit-sweep gates enrichment on summary_hash change", () => {
  // The edit-sweep stamps a fresh summary_hash but must only clear the four
  // `*_fetched_at` enrichment stamps when that hash actually changed. Clearing
  // them unconditionally re-fetches detail+social+zones+streams (≈5 API calls)
  // for every last-30-day activity on every 6h sweep — pure quota waste.

  const enteringCursor = (): StravaActivitiesCursor => ({
    phase: "incremental",
    lastActivityTimestamp: 1700000000,
    // Snapshot just done → only edit-sweep fires.
    lastSnapshotAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    // No lastEditSweepAt → edit-sweep gate triggers.
  });

  test("unchanged activity is NOT re-flagged for enrichment across a sweep", async () => {
    const activity = makeActivity(101, "2026-04-19T10:00:00Z");
    // The analytics DB already holds this activity with its current hash —
    // nothing about its summary changed since the last ingest.
    const stored = new Map<number, string | null>([[101, computeSummaryHash(activity)]]);
    const { source, gateway } = makeSourceWithGateway([[activity]], stored);

    const result = await source.syncStructured(enteringCursor());

    // The sweep did query the stored hashes…
    expect(gateway.queries.some((q) => q.includes("summary_hash"))).toBe(true);
    // …found this activity unchanged, so it emits no record (a true no-op):
    // the stored `*_fetched_at` stamps are left intact and no re-enrichment
    // is triggered. Pre-fix this emitted one record with all four stamps
    // nulled, re-enriching an activity that never changed.
    expect(rowsFor(result, "strava_activities")).toHaveLength(0);
    expect(result.documents ?? []).toHaveLength(0);
    // Cadence still advances so we don't re-sweep immediately.
    const c = result.cursor as StravaActivitiesCursor;
    expect(c.phase).toBe("incremental");
    expect(c.lastEditSweepAt).toBeTruthy();
  });

  test("changed summary IS re-flagged: record emitted with all four stamps nulled", async () => {
    const activity = makeActivity(202, "2026-04-19T10:00:00Z");
    // The stored hash differs (e.g. the activity was renamed on Strava) — the
    // edit-sweep must re-ingest it and clear its enrichment stamps.
    const stored = new Map<number, string | null>([[202, "stale-hash-from-before-the-edit"]]);
    const { source } = makeSourceWithGateway([[activity]], stored);

    const result = await source.syncStructured(enteringCursor());

    expect(rowsFor(result, "strava_activities")).toHaveLength(1);
    const record = rowsFor(result, "strava_activities")[0]!;
    // Freshly-computed hash is stamped…
    expect(record.summary_hash).toBe(computeSummaryHash(activity));
    // …and all four enrichment stamps are nulled so the row flows back
    // through enrich-pending.
    expect(record.detail_fetched_at).toBeNull();
    expect(record.social_fetched_at).toBeNull();
    expect(record.zones_fetched_at).toBeNull();
    expect(record.streams_fetched_at).toBeNull();
  });

  test("a full page of unchanged activities still advances the cursor", async () => {
    // The incremental phase paginates only by moving its high-water mark: it
    // always asks for page 1, so the mark is the sole way forward. If the mark
    // were computed from the activities *ingested* rather than the ones
    // *walked*, a full page in which everything was already stored and
    // unchanged would leave the cursor exactly where it was while still
    // reporting `hasMore` — and the collector's drain loop would ask the same
    // question and get the same page, at the speed of the API, forever.
    const page = Array.from({ length: 100 }, (_, i) =>
      makeActivity(500 + i, `2026-04-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00Z`),
    );
    const stored = new Map<number, string | null>(
      page.map((a) => [a.id, computeSummaryHash(a)] as const),
    );
    const { source } = makeSourceWithGateway([page], stored);

    // Straight to the incremental phase: the snapshot, sweep and athlete
    // refreshes are all recently done, so the priority chain falls through.
    const recently = new Date().toISOString();
    const before: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1,
      lastSnapshotAt: recently,
      lastEditSweepAt: recently,
      lastAthleteRefreshAt: recently,
    };
    const result = await source.syncStructured(before);

    // Nothing to ingest — every activity was already known and unchanged…
    expect(rowsFor(result, "strava_activities")).toHaveLength(0);
    // …and yet the cursor moved past the page it just walked.
    const after = result.cursor as StravaActivitiesCursor;
    expect(after.lastActivityTimestamp).toBeGreaterThan(before.lastActivityTimestamp!);
    const newest = Math.max(
      ...page.map((a) => Math.floor(new Date(a.start_date).getTime() / 1000)),
    );
    expect(after.lastActivityTimestamp).toBe(newest);
  });

  test("mixed page: only the changed activity is re-ingested", async () => {
    const unchanged = makeActivity(301, "2026-04-19T10:00:00Z");
    const changed = makeActivity(302, "2026-04-18T10:00:00Z");
    const stored = new Map<number, string | null>([
      [301, computeSummaryHash(unchanged)],
      [302, "stale-hash"],
    ]);
    const { source } = makeSourceWithGateway([[unchanged, changed]], stored);

    const result = await source.syncStructured(enteringCursor());

    // Exactly one record — for the changed activity only.
    expect(rowsFor(result, "strava_activities")).toHaveLength(1);
    expect(Number(rowsFor(result, "strava_activities")[0]!.id)).toBe(302);
  });
});
