// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * People-graph background-job coverage.
 *
 * Boots a real gateway against the `e2e-minimal` universe and asserts
 * three background jobs do their jobs:
 *
 *   1. `interactionScoresRefreshTask` — the job actually fires. We
 *      observe via `/admin/background-jobs` rather than the score
 *      values themselves: no roster device in the synth E2E harness carries
 *      self info and nothing bootstraps a contact card, so `is_self` is unset on every
 *      person, and `computeInteractionScores` short-circuits to an
 *      empty snapshot. The job still ticks normally; we check
 *      `lastTickAt != null` as proof of wiring.
 *   2. `mergeRulesEvalTask` — a user-issued POST to
 *      `/people/merge-rules` kicks the eval task directly
 *      (PersonService → Scheduler.kickPeriodic), so `people.merged_into`
 *      lands on the loser within seconds. The 30s budget is
 *      loaded-CI slack, not cadence — a regression back to
 *      periodic-only pickup (60s active / 5m idle) fails this test.
 *   3. `autoDetectTask` — the admin endpoint
 *      `GET /people/merge-rules?kind=system` returns a parseable
 *      array. Weak assertion (the e2e-minimal cast is too small to
 *      reliably surface system rules in the test window) but a real
 *      wiring smoke: the task didn't crash, the route works, the
 *      response shape is correct.
 *
 * Cadence note: there's no env-var override for these jobs.
 * `interactionScoresRefresh` first fires ~10s after boot then every
 * 60s; `mergeRulesEval` ~15s after boot then every 60s; `autoDetect`
 * ~30s after boot then every 5 min. User-issued merge-rule mutations
 * additionally kick `mergeRulesEval` immediately — the propagation
 * budget in test 2 relies on that.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface PersonAlias {
  aliasType: string;
  alias: string;
}

interface PersonSummary {
  id: string;
  canonicalName: string;
  isSelf: boolean;
  aliasCount: number;
  documentCount: number;
}

interface PeopleSearchResp {
  items: PersonSummary[];
}

interface PersonDetail {
  id: string;
  canonicalName: string;
  isSelf: boolean;
  aliases: PersonAlias[];
  mergedInto: string | null;
  mergedFrom: Array<{ id: string; canonicalName: string }>;
}

interface MergeRule {
  id: string;
  kind: "system" | "user";
  active: boolean;
}

interface MergeRulesResp {
  rules: MergeRule[];
}

interface CreateMergeRuleResp {
  rule: MergeRule;
  created: boolean;
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

describe("People-graph background jobs (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // People resolution is a background writer-handler — wait until
    // Jane Doe is findable before any per-person assertions run.
    await waitForPersonByName(harness, "Jane Doe", 30_000);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("interactionScoresRefresh job fires at least once", async () => {
    // The synth harness has no `is_self=TRUE` person, so the score
    // table will be empty (see computeInteractionScores in
    // InteractionScoreService.ts — early-returns when self is missing).
    // Observe via the registry instead: the job still ticks, and
    // `lastTickAt` becoming non-null proves the scheduler ran it.
    // 90s gives the 10s startDelay + first 60s active tick room.
    await waitForJobTicked(harness, "backfill.interactionScoresRefresh", 90_000);
  }, 120_000);

  test("mergeRulesEval propagates a user-issued merge rule into people.merged_into", async () => {
    // Resolve Jane Doe + Emma Park separately via the search endpoint
    // (matches against any alias — works regardless of which alias
    // got picked as the flickering canonical_name). Both have
    // bidirectional WhatsApp threads and dedicated contact entries
    // in the e2e-minimal cast.
    const [janeHits, emmaHits] = await Promise.all([
      harness.gatewayJson<PeopleSearchResp>("/people/search?q=Jane%20Doe&limit=1"),
      harness.gatewayJson<PeopleSearchResp>("/people/search?q=Emma%20Park&limit=1"),
    ]);
    const jane = janeHits.items[0];
    const emma = emmaHits.items[0];
    expect(jane, "Jane Doe should resolve in the people graph").toBeDefined();
    expect(emma, "Emma Park should resolve in the people graph").toBeDefined();
    expect(jane.id).not.toBe(emma.id);

    // Wait for both people to have their name alias attached. The
    // backfill writer-handler resolves a doc's PersonMentions and
    // inserts aliases; if we POST the rule before the name alias has
    // landed, the eval pass finds nothing to merge and silently
    // succeeds — propagation never happens.
    const janeDetail = await waitForNameAlias(harness, jane.id, "Jane Doe", 30_000);
    const emmaDetail = await waitForNameAlias(harness, emma.id, "Emma Park", 30_000);
    const janeNameAlias = janeDetail.aliases.find((a) => a.aliasType === "name");
    const emmaNameAlias = emmaDetail.aliases.find((a) => a.aliasType === "name");
    expect(janeNameAlias).toBeDefined();
    expect(emmaNameAlias).toBeDefined();

    const created = await harness.gatewayJson<CreateMergeRuleResp>("/people/merge-rules", {
      method: "POST",
      body: JSON.stringify({
        sideA: janeNameAlias,
        sideB: emmaNameAlias,
        winnerSide: "a",
        kind: "user",
        reason: "people-graph.e2e: forced merge for eval coverage",
      }),
    });
    expect(created.rule.id).toBeTruthy();
    expect(created.rule.kind).toBe("user");

    try {
      const { winner, loser } = await waitForMergePropagation(harness, jane.id, emma.id, 30_000);
      const [loserDetail, winnerDetail] = await Promise.all([
        harness.gatewayJson<PersonDetail>(`/people/${loser}`),
        harness.gatewayJson<PersonDetail>(`/people/${winner}`),
      ]);
      expect(loserDetail.mergedInto).toBe(winner);
      expect(winnerDetail.mergedFrom.some((p) => p.id === loser)).toBe(true);

      // Un-merge: rule deletion kicks the eval too, so the merge must
      // dissolve within the same budget.
      const del = await harness.gatewayJson<{ deleted: boolean }>(
        `/people/merge-rules/${created.rule.id}`,
        { method: "DELETE" },
      );
      expect(del.deleted).toBe(true);
      await waitForUnmerge(harness, jane.id, emma.id, 30_000);
    } finally {
      // Idempotent cleanup for the failure paths above.
      try {
        await harness.gatewayJson(`/people/merge-rules/${created.rule.id}`, { method: "DELETE" });
      } catch {
        /* harness teardown will clean up */
      }
    }
  }, 180_000);

  test("autoDetect endpoint returns a parseable kind=system rules array", async () => {
    // The job runs every 5 min (30s startDelay), so we may or may not
    // observe entries within the test window — we only assert the
    // route works and the response shape is correct. Catches a regression
    // where the task crashes and leaves the route in a broken state.
    const resp = await harness.gatewayJson<MergeRulesResp>("/people/merge-rules?kind=system");
    expect(Array.isArray(resp.rules)).toBe(true);
    for (const rule of resp.rules) {
      expect(rule.kind).toBe("system");
      expect(typeof rule.active).toBe("boolean");
    }
  });

  /**
   * The scheduler's priority contract, on a gateway that is running one.
   *
   * `/admin/background/run` kicks a periodic from inside an HTTP request and
   * waits for that tick — the same shape as the portal's merge fast lane,
   * which kicks these sweeps so they do not sit out their idle backoff. The
   * kick means "run sooner", not "run as me": a promoted sweep would take
   * the io slot reserved for interactive reads, and since a periodic re-arms
   * its own timer, a promotion that leaked would stay leaked for every later
   * tick. Unit tests pin the mechanism; this pins the outcome on a running
   * gateway.
   */
  test("a sweep kicked from a user request still runs as background work", async () => {
    const task = "backfill.peopleCountsRefresh";
    // Run it once from a user-priority request and wait for that very tick,
    // so the sample below is the one this kick produced.
    await harness.gatewayJson(`/admin/background/run/${task}?timeoutMs=60000`, { method: "POST" });

    const snapshot = await harness.gatewayJson<{
      perTask?: Array<{ name: string; countByPriority: Record<string, number>; count: number }>;
    }>("/admin/scheduler-metrics?window=15");
    const seen = (snapshot.perTask ?? []).filter(
      (t) => t.name === task || t.name === "io.peopleCountsChunk",
    );

    // An empty set proves nothing; say so rather than passing silently.
    expect(seen.length, "the kicked sweep produced no sample").toBeGreaterThan(0);
    for (const entry of seen) {
      const { user, realtime } = entry.countByPriority;
      expect(
        { user, realtime },
        `${entry.name} ran promoted: ${JSON.stringify(entry.countByPriority)}`,
      ).toEqual({ user: 0, realtime: 0 });
    }
  }, 120_000);
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function waitForPersonByName(
  harness: SyntheticE2EHarness,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await harness.gatewayJson<{ items?: unknown[] }>(
      `/people/search?q=${encodeURIComponent(name)}&limit=3`,
    );
    if ((res.items ?? []).length > 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForPersonByName: ${name} did not appear within ${timeoutMs}ms`);
}

/**
 * Poll /admin/background-jobs until the named job has fired at least
 * one tick (`lastTickAt != null`). The synth-friendly way to assert
 * "the scheduler is running this job," which matters more than what
 * the job wrote when the underlying data shape (no self person)
 * makes the OUTPUT trivially zero.
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

/**
 * Poll /people/:id until the expected name alias is attached. The
 * people-backfill writer-handler is async, so name aliases land some
 * time after the person row appears. Returns the detail when the
 * alias is present.
 */
async function waitForNameAlias(
  harness: SyntheticE2EHarness,
  id: string,
  expectedName: string,
  timeoutMs: number,
): Promise<PersonDetail> {
  const deadline = Date.now() + timeoutMs;
  const expectedLower = expectedName.toLowerCase();
  while (Date.now() < deadline) {
    const detail = await harness.gatewayJson<PersonDetail>(`/people/${id}`);
    const has = detail.aliases.some(
      (a) => a.aliasType === "name" && a.alias.toLowerCase() === expectedLower,
    );
    if (has) return detail;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForNameAlias: ${id} never picked up name="${expectedName}" within ${timeoutMs}ms`,
  );
}

/**
 * Poll the two person rows until one of them has `merged_into` pointing
 * at the other. Returns {winner, loser} ids (which one is which depends
 * on whether canonicalize-and-evaluate flipped the sides — the test
 * shouldn't pre-commit to a direction).
 */
async function waitForMergePropagation(
  harness: SyntheticE2EHarness,
  idA: string,
  idB: string,
  timeoutMs: number,
): Promise<{ winner: string; loser: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [a, b] = await Promise.all([
      harness.gatewayJson<PersonDetail>(`/people/${idA}`),
      harness.gatewayJson<PersonDetail>(`/people/${idB}`),
    ]);
    if (a.mergedInto === idB) return { winner: idB, loser: idA };
    if (b.mergedInto === idA) return { winner: idA, loser: idB };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForMergePropagation: neither ${idA} nor ${idB} got merged_into the other within ${timeoutMs}ms`,
  );
}

/** Poll both person rows until neither carries a merged_into pointer. */
async function waitForUnmerge(
  harness: SyntheticE2EHarness,
  idA: string,
  idB: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [a, b] = await Promise.all([
      harness.gatewayJson<PersonDetail>(`/people/${idA}`),
      harness.gatewayJson<PersonDetail>(`/people/${idB}`),
    ]);
    if (a.mergedInto === null && b.mergedInto === null) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForUnmerge: ${idA} / ${idB} still merged after ${timeoutMs}ms`);
}
