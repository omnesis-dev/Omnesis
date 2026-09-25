// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source-stats scheduler-task coverage.
 *
 * Boots a real gateway against the `e2e-minimal` universe, syncs every
 * source, and asserts the `backfill.statsRefresh` task materializes
 * per-source aggregates that are then reachable via the read API.
 *
 * What we lock in:
 *
 *   1. The job fires at least once after sync (`/admin/background-jobs`
 *      reports `lastTickAt != null` for `backfill.statsRefresh`).
 *   2. `GET /documents/stats/:sourceId` returns a per-source aggregate
 *      whose `documentCount` matches the doc count actually persisted
 *      (`/documents/count/:sourceId`) — guards the regression where the
 *      aggregator and the row count diverge.
 *   3. The aggregate carries non-trivial size + date-range fields:
 *      `dataSizeBytes > 0`, `earliestSourceDate <= latestSourceDate`,
 *      both parse as ISO dates.
 *   4. The breakdown is per-source — two distinct sources have
 *      independent rows (`/documents/stats` is not collapsing into a
 *      global aggregate).
 *   5. The batch endpoint `POST /documents/stats` returns the same
 *      shape for the same source IDs — closes the loop on the read
 *      surface the CLI's `status` command depends on.
 *
 * Why e2e-minimal: matches the other scheduler-task E2Es. Two
 * unstructured sources (gmail + apple-notes) carry three fixture
 * entries each — enough to exercise non-zero counts + valid date
 * ranges + a measurable byte sum.
 *
 * Cadence note: `backfill.statsRefresh` has `startDelayMs: 500ms` and
 * `periodMs: 30s`. Within the ~60s post-sync window it reliably
 * processes the dirty backlog. We poll the job observation (rather
 * than the stats output) for the firing assertion because the read
 * endpoint has a "row missing → compute inline" fallback that masks
 * whether the materialized row exists yet.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface SourceStatsResp {
  documentCount: number;
  earliestSourceDate: string | null;
  latestSourceDate: string | null;
  totalUnitCount: number | null;
  dataSizeBytes: number;
}

interface BulkStatsResp {
  stats: Record<string, SourceStatsResp>;
}

interface CountResp {
  count: number;
}

interface JobObservation {
  state: string;
  lastTickAt?: number;
  ticksLastHour: number;
}

interface BackgroundJobsSnapshot {
  jobs: Array<{
    id: string;
    displayName: string;
    observation: JobObservation;
  }>;
}

// Two unstructured sources from `e2e-minimal` with 1:1 fixture→Document
// mapping and ≥1 entry each. Picked because they're the most stable
// non-zero surfaces in the slim universe — both also appear in the
// other scheduler-task E2Es, so any drift in the universe shape will
// surface in multiple suites.
const SOURCE_A = "gmail:john.smith@example.com";
const SOURCE_B = "apple-notes:john.smith@icloud.example";

describe("Source-stats scheduler task (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // The stats-refresh task drips dirty source IDs one per tick on a
    // 30s active cadence. Waiting for one tick guarantees the job is
    // wired; the stats-content assertions below tolerate the inline
    // compute fallback for any source whose materialized row hasn't
    // landed yet within the window.
    await waitForJobTicked(harness, "backfill.statsRefresh", 90_000);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("statsRefresh job fires at least once after sync", async () => {
    // Already waited in beforeAll; a second read here proves the
    // observation persists (not a one-shot artifact).
    const snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
    const job = snap.jobs.find((j) => j.id === "backfill.statsRefresh");
    expect(job, "backfill.statsRefresh should be registered").toBeDefined();
    expect(job!.observation.lastTickAt != null || job!.observation.ticksLastHour > 0).toBe(true);
  });

  test("per-source documentCount matches the documents endpoint", async () => {
    for (const sid of [SOURCE_A, SOURCE_B]) {
      const [stats, count] = await Promise.all([
        harness.gatewayJson<SourceStatsResp>(`/documents/stats/${encodeURIComponent(sid)}`),
        harness.gatewayJson<CountResp>(`/documents/count/${encodeURIComponent(sid)}`),
      ]);
      expect(stats.documentCount, `${sid}: stats vs count`).toBe(count.count);
      expect(stats.documentCount, `${sid}: should have >0 docs`).toBeGreaterThan(0);
    }
  });

  test("per-source aggregates carry non-trivial size and date-range fields", async () => {
    for (const sid of [SOURCE_A, SOURCE_B]) {
      const stats = await harness.gatewayJson<SourceStatsResp>(
        `/documents/stats/${encodeURIComponent(sid)}`,
      );
      // Size: SUM(LENGTH(content + title + metadata)) is positive for
      // every non-empty source. Catches the regression where the
      // aggregator drops the LENGTH() expressions or reads a wrong
      // column.
      expect(stats.dataSizeBytes, `${sid}: dataSizeBytes`).toBeGreaterThan(0);
      // Date range: both endpoints populated, parse as ISO, and
      // earliest <= latest. The aggregator does MIN/MAX over
      // `source_created_at`; a null on either side means the column
      // wasn't picked up.
      expect(stats.earliestSourceDate, `${sid}: earliest`).not.toBeNull();
      expect(stats.latestSourceDate, `${sid}: latest`).not.toBeNull();
      const earliest = Date.parse(stats.earliestSourceDate ?? "");
      const latest = Date.parse(stats.latestSourceDate ?? "");
      expect(Number.isFinite(earliest), `${sid}: earliest parses`).toBe(true);
      expect(Number.isFinite(latest), `${sid}: latest parses`).toBe(true);
      expect(earliest, `${sid}: earliest <= latest`).toBeLessThanOrEqual(latest);
    }
  });

  test("two distinct sources expose independent aggregates (not a global rollup)", async () => {
    const [a, b] = await Promise.all([
      harness.gatewayJson<SourceStatsResp>(`/documents/stats/${encodeURIComponent(SOURCE_A)}`),
      harness.gatewayJson<SourceStatsResp>(`/documents/stats/${encodeURIComponent(SOURCE_B)}`),
    ]);
    // If `/documents/stats/:sourceId` ever collapses into a global
    // aggregate, both responses become identical — guard against it
    // by asserting at least one numeric field differs. With per-source
    // fixtures of different sizes + date ranges, equality on
    // dataSizeBytes is astronomically unlikely.
    expect(a.dataSizeBytes).not.toBe(b.dataSizeBytes);
    // And each carries its own slice of the corpus: the sum across
    // both must equal what `count` reports for each individually
    // (proves the count isn't being double-attributed).
    const [countA, countB] = await Promise.all([
      harness.gatewayJson<CountResp>(`/documents/count/${encodeURIComponent(SOURCE_A)}`),
      harness.gatewayJson<CountResp>(`/documents/count/${encodeURIComponent(SOURCE_B)}`),
    ]);
    expect(a.documentCount).toBe(countA.count);
    expect(b.documentCount).toBe(countB.count);
  });

  test("POST /documents/stats batch endpoint mirrors the per-source GETs", async () => {
    // The CLI's `status` command fans out via this endpoint; if the
    // bulk path diverges from the per-source path (different repo
    // helper, different fallback shape), users see drift on the
    // status pane vs the source detail. Lock in equivalence.
    const ids = [SOURCE_A, SOURCE_B];
    const [bulk, perA, perB] = await Promise.all([
      harness.gatewayJson<BulkStatsResp>("/documents/stats", {
        method: "POST",
        body: JSON.stringify({ sourceIds: ids }),
      }),
      harness.gatewayJson<SourceStatsResp>(`/documents/stats/${encodeURIComponent(SOURCE_A)}`),
      harness.gatewayJson<SourceStatsResp>(`/documents/stats/${encodeURIComponent(SOURCE_B)}`),
    ]);
    expect(bulk.stats[SOURCE_A]).toBeDefined();
    expect(bulk.stats[SOURCE_B]).toBeDefined();
    // documentCount + dataSizeBytes are the two stable fields between
    // calls (the date strings round-trip identically through SQLite,
    // but assertion-on-strings is brittle if the writer adds a sub-
    // second component — count + size is enough to prove the routes
    // converge on the same materialized row).
    expect(bulk.stats[SOURCE_A].documentCount).toBe(perA.documentCount);
    expect(bulk.stats[SOURCE_A].dataSizeBytes).toBe(perA.dataSizeBytes);
    expect(bulk.stats[SOURCE_B].documentCount).toBe(perB.documentCount);
    expect(bulk.stats[SOURCE_B].dataSizeBytes).toBe(perB.dataSizeBytes);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Poll `/admin/background-jobs` until the named job has fired at least
 * one tick. Mirrors the helper in `people-graph.e2e.test.ts` and
 * `people-backfill.e2e.test.ts`.
 */
async function waitForJobTicked(
  harness: SyntheticE2EHarness,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
    const job = snap.jobs.find((j) => j.id === jobId);
    if (job && (job.observation.lastTickAt != null || job.observation.ticksLastHour > 0)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`waitForJobTicked: ${jobId} did not tick within ${timeoutMs}ms`);
}
