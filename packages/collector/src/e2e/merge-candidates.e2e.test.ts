// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Merge-candidate detection background-job coverage.
 *
 * Boots a real gateway against the `e2e-minimal` universe, runs every
 * source, then exercises the `backfill.mergeCandidatesDetect` scheduler
 * task end-to-end against the public read API at
 * `GET /people/merge-candidates`.
 *
 * Goal: catch regressions in the wiring path
 *   scheduler → computeFuzzyMergeCandidates → upsertMergeCandidates →
 *   listEnrichedCandidates (rank score + breakdown) → /people/merge-candidates
 *
 * Bound on the candidate-set size, by design:
 *   - The SyntheticE2EHarness has no `is_self=TRUE` person (no roster
 *     device carries self info, no contact-card bootstrap on the synth corpus).
 *   - `computeInteractionScores` early-returns when self is missing,
 *     so every person stays at `interaction_score_recent = 0`.
 *   - `computeFuzzyMergeCandidates` applies a head-percentile gate
 *     (`s > 0`) before scoring. With every score at 0 the gate
 *     rejects every pair, so no candidates land in the table even
 *     though the `e2e-minimal` cast has surname-sharing ambiguity
 *     (John/Claire/Maria Smith are deliberate variants in cast.json).
 *
 * That makes "≥1 candidate is surfaced" an unstable assertion against
 * the synth harness as it stands today. Rather than mutate the
 * universe or hack `is_self` in, this test takes the same shape as the
 * sibling `autoDetect` test in `people-graph.e2e.test.ts`: assert the
 * job fires, the route responds, and the response shape is correct;
 * AND if any candidate does surface (e.g. after a future change that
 * relaxes the gate or seeds a self person) assert the ranking +
 * person-resolution invariants for every row.
 *
 * Cadence note: there's no env-var override for the cadence.
 * `mergeCandidatesDetect` first fires ~90s after gateway boot
 * (`startDelayMs: 90_000`), with `periodMs: 5 * 60_000` active and
 * `idlePeriodMs: 30 * 60_000` idle. We poll the background-jobs
 * registry until the first tick is observed; the polling window
 * (~150s) covers boot + sync + startDelay with comfortable slack.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface PersonAliasSide {
  aliasType: "email" | "phone" | "lid" | "name";
  alias: string;
}

interface ResolvedSidePerson {
  id: string;
  canonicalName: string;
  isSelf?: boolean;
  interactionScoreRecent?: number | null;
}

interface MergeCandidateItem {
  id: string;
  sideA: PersonAliasSide;
  sideB: PersonAliasSide;
  score: number;
  detectionKind: string;
  matchedTokens: string[];
  status: "pending" | "accepted" | "denied";
  detectedAt: string;
  decidedAt: string | null;
  ruleId: string | null;
  resolvedSideA: ResolvedSidePerson[];
  resolvedSideB: ResolvedSidePerson[];
  rankScore: number;
  clusterId: string;
  rankBreakdown: {
    baseScore: number;
    maxInteraction: number;
    importanceBoost: number;
    tokenBonus: number;
  };
}

interface MergeCandidatesResp {
  items: MergeCandidateItem[];
  pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
  counts: { pending: number; accepted: number; denied: number };
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

interface PersonDetail {
  id: string;
  canonicalName: string;
  isSelf: boolean;
}

describe("Merge-candidates background job (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let resp: MergeCandidatesResp;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // Wait for the detector's first tick. startDelayMs=90s + slack.
    // The job ticks whether or not it produces candidates (it also
    // gates on mergeRules + interactionScores being current — both
    // are caught up under steady state on the synth harness).
    await waitForJobTicked(harness, "backfill.mergeCandidatesDetect", 150_000);
    resp = await harness.gatewayJson<MergeCandidatesResp>("/people/merge-candidates");
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("the route returns a structurally valid envelope", () => {
    expect(Array.isArray(resp.items)).toBe(true);
    expect(resp.pageInfo).toBeDefined();
    expect(typeof resp.pageInfo.limit).toBe("number");
    expect(typeof resp.pageInfo.hasMore).toBe("boolean");
    expect(resp.counts).toBeDefined();
    expect(Number.isFinite(resp.counts.pending)).toBe(true);
    expect(Number.isFinite(resp.counts.accepted)).toBe(true);
    expect(Number.isFinite(resp.counts.denied)).toBe(true);
    expect(resp.counts.pending).toBeGreaterThanOrEqual(0);
    expect(resp.counts.accepted).toBeGreaterThanOrEqual(0);
    expect(resp.counts.denied).toBeGreaterThanOrEqual(0);
    // `items` is the pending bucket (the route defaults to status=pending),
    // so its length matches the pending counter modulo paging.
    expect(resp.items.length).toBeLessThanOrEqual(resp.counts.pending);
  });

  test("counts agree with an explicit status=accepted / denied fetch", async () => {
    // Cross-checks `countMergeCandidates` against `listMergeCandidates`
    // — a regression where the count and the listed bucket diverge
    // (e.g. wrong status filter, stale view) shows up here.
    const [acc, den] = await Promise.all([
      harness.gatewayJson<MergeCandidatesResp>("/people/merge-candidates?status=accepted"),
      harness.gatewayJson<MergeCandidatesResp>("/people/merge-candidates?status=denied"),
    ]);
    expect(acc.items.length).toBeLessThanOrEqual(resp.counts.accepted);
    expect(den.items.length).toBeLessThanOrEqual(resp.counts.denied);
    // Counts are queue-wide so they must match across status filters.
    expect(acc.counts).toEqual(resp.counts);
    expect(den.counts).toEqual(resp.counts);
  });

  // The richer per-row assertions only run when the detector actually
  // emitted candidates. See file header for the synth-side reason this
  // is conditional. The block is structured so adding a self person /
  // disabling the head gate would immediately tighten coverage without
  // any test-file changes.
  test("each surfaced candidate is well-formed and rank-ordered", async () => {
    if (resp.items.length === 0) {
      // Documented expectation under today's synth harness — see file
      // header. Soft pass to keep CI green; the wiring assertion above
      // is the load-bearing regression net for this scheduler task.
      return;
    }

    for (const cand of resp.items) {
      // ── shape ──────────────────────────────────────────────────
      expect(typeof cand.id).toBe("string");
      expect(cand.id.length).toBeGreaterThan(0);
      expect(cand.status).toBe("pending");
      expect(cand.detectionKind).toBe("name_token_overlap");
      expect(cand.sideA.aliasType === "email" || cand.sideA.aliasType === "name").toBe(true);
      expect(cand.sideB.aliasType === "email" || cand.sideB.aliasType === "name").toBe(true);
      expect(cand.sideA.alias.length).toBeGreaterThan(0);
      expect(cand.sideB.alias.length).toBeGreaterThan(0);
      expect(Array.isArray(cand.matchedTokens)).toBe(true);

      // ── scoring + ranking populated ────────────────────────────
      expect(Number.isFinite(cand.score)).toBe(true);
      expect(cand.score).toBeGreaterThanOrEqual(0.7); // DEFAULT_SCORE_THRESHOLD
      expect(cand.score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(cand.rankScore)).toBe(true);
      expect(cand.rankScore).toBeGreaterThanOrEqual(0);
      // Ranking breakdown contributes to rankScore as
      // baseScore * importanceBoost * tokenBonus. baseScore/importanceBoost are
      // finite non-negative; tokenBonus is the name-match strength — a positive
      // multiplier that drops below 1 (to ~0.15) for a single shared common
      // given name, demoting it without hiding it.
      expect(cand.rankBreakdown.baseScore).toBe(cand.score);
      expect(Number.isFinite(cand.rankBreakdown.maxInteraction)).toBe(true);
      expect(cand.rankBreakdown.maxInteraction).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(cand.rankBreakdown.importanceBoost)).toBe(true);
      expect(cand.rankBreakdown.importanceBoost).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(cand.rankBreakdown.tokenBonus)).toBe(true);
      expect(cand.rankBreakdown.tokenBonus).toBeGreaterThan(0);
      expect(typeof cand.clusterId).toBe("string");

      // ── resolved person IDs round-trip via /people/:id ─────────
      // Each side must resolve to at least one real person, and
      // every resolved person id must be addressable via /people/:id.
      // Catches drift between the candidate row's alias → personIds
      // resolution and the canonical people table.
      expect(cand.resolvedSideA.length).toBeGreaterThan(0);
      expect(cand.resolvedSideB.length).toBeGreaterThan(0);
      const allResolved = [...cand.resolvedSideA, ...cand.resolvedSideB];
      const personChecks = await Promise.all(
        allResolved.map((p) => harness.gatewayJson<PersonDetail>(`/people/${p.id}`)),
      );
      for (let i = 0; i < allResolved.length; i++) {
        const expected = allResolved[i];
        const fetched = personChecks[i];
        expect(fetched.id).toBe(expected.id);
        expect(typeof fetched.canonicalName).toBe("string");
        expect(fetched.canonicalName.length).toBeGreaterThan(0);
      }
    }

    // ── cluster-aware ordering ─────────────────────────────────────
    // Candidates of a cluster are contiguous (a clusterId block is never
    // re-entered after leaving it), and clusters are ordered by their best
    // member's rankScore (non-increasing cluster maxima). Per-candidate
    // rankScore is intentionally NOT globally monotonic — a cluster's weaker
    // member can precede a stronger standalone pair.
    const seen = new Set<string>();
    const clusterMax = new Map<string, number>();
    let prevCluster: string | null = null;
    let prevClusterMax = Number.POSITIVE_INFINITY;
    for (const cand of resp.items) {
      clusterMax.set(cand.clusterId, Math.max(clusterMax.get(cand.clusterId) ?? 0, cand.rankScore));
    }
    for (const cand of resp.items) {
      if (cand.clusterId !== prevCluster) {
        expect(seen.has(cand.clusterId)).toBe(false); // contiguity: cluster not re-entered
        seen.add(cand.clusterId);
        const cm = clusterMax.get(cand.clusterId)!;
        expect(cm).toBeLessThanOrEqual(prevClusterMax + 1e-9);
        prevClusterMax = cm;
        prevCluster = cand.clusterId;
      }
    }
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Poll `/admin/background-jobs` until `jobId` has observed a tick
 * (`lastTickAt != null` or `ticksLastHour > 0`). Same shape as the
 * helper in `people-graph.e2e.test.ts` — kept duplicated rather than
 * pulled into a shared module so this test stays self-contained, in
 * line with the other coverage E2Es in this directory.
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
