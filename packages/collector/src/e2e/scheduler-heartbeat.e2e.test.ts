// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduler heartbeat — blanket safety net for the background-jobs
 * registry. Boots a real gateway against the `e2e-minimal` universe,
 * pulls the live list of registered jobs from
 * `/admin/background-jobs`, then polls until every job whose cadence
 * is short enough to fire within the observation window has ticked at
 * least once.
 *
 * Goal: catch the regression class "someone unregistered or broke a
 * background job" without per-job assertions. A new job appearing in
 * the registry is automatically picked up — either it fits in the
 * window (and we assert it ticks) or it falls into the excluded
 * long-cadence bucket (and the test logs it so it doesn't silently
 * fall out of coverage).
 *
 * Exclusion rule (cadence-derived, NOT a hardcoded list):
 *   - `periodic` with `intervalMs > MAX_ACTIVE_CADENCE_MS` → excluded
 *   - `drip` with `activeMs > MAX_ACTIVE_CADENCE_MS` → excluded
 *   - `continuous` with `nominalIntervalMs > MAX_ACTIVE_CADENCE_MS` → excluded
 *   - `on-demand` → excluded (won't fire without an explicit trigger)
 *   - `wake-driven` → excluded (no guarantee a wake arrives in-window)
 *   - jobs whose `state === "disabled"` at boot → excluded
 *   - jobs whose first tick is deferred past the window
 *     (`startDelayMs > OBSERVATION_WINDOW_MS`) → excluded; they cannot tick
 *     in time by design
 *
 * At the time of writing (May 2026) the excluded set is:
 *   - `backfill.linkReconcile` (5 min)
 *   - `backfill.peopleCountsRefresh` (10 min)
 *   - `backfill.autoDetect` (5 min)
 *   - `backfill.mergeCandidatesDetect` (5 min)
 *   - `backfill.catalogRefresh` (5 min)
 *   - `backfill.nearDupAlgoSweep` (drip, 30s active / 1 h idle — NOT excluded; first tick fires ~60s after boot)
 *   - `backfill.nearDupDfRefresh` (drip — EXCLUDED; startDelay 120s > 90s window, the DF full-corpus scan is deferred so it doesn't starve the indexer at boot)
 *   - `devices.cleanupExpiredPairings.tick` (1 h)
 *   - `tokens.cleanupExpiredSessions.tick` (1 h)
 *   - `authFlows.cleanup.tick` (5 min)
 *   - `indexer.cycle` (continuous, 5 min nominal)
 *   - `indexer.reconcile-deleted` (1 h)
 *   - `indexer.reindex-missing` (1 h)
 *   - `indexer.wake` (wake-driven)
 *
 * Anything new that appears in `/admin/background-jobs` falls into
 * the cadence buckets above automatically; the test asserts that EVERY
 * non-excluded job ticked, so an unregistered or wedged job fails the
 * suite no matter who added it.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createLogger, type Logger } from "@omnesis/core";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * Upper bound on a job's active cadence for it to be in scope. Any
 * `periodic.intervalMs`, `drip.activeMs`, or `continuous.nominalIntervalMs`
 * above this value is excluded — it won't reliably tick within the test
 * window. Snug to the ~90s observation budget so the suite stays under
 * the 120s ceiling.
 */
const MAX_ACTIVE_CADENCE_MS = 90_000;

/** Window the heartbeat poller waits for every covered job to tick. */
const OBSERVATION_WINDOW_MS = 90_000;

type JobCadence =
  | { mode: "periodic"; intervalMs: number; startDelayMs?: number }
  | { mode: "drip"; activeMs: number; idleMs: number; startDelayMs?: number }
  | { mode: "wake-driven"; debounceMs: number }
  | { mode: "continuous"; nominalIntervalMs?: number }
  | { mode: "on-demand" };

interface JobObservation {
  state: "running" | "idle" | "disabled" | "erroring" | "unknown";
  inFlight: boolean;
  lastTickAt?: number;
  lastError?: { message: string; at: number };
  ticksLastHour: number;
}

interface BackgroundJobsSnapshot {
  generatedAt: string;
  jobs: Array<{
    id: string;
    displayName: string;
    category: string;
    cadence: JobCadence;
    observation: JobObservation;
  }>;
}

const log: Logger = createLogger("e2e:scheduler-heartbeat");

describe("Scheduler heartbeat (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let initialSnapshot: BackgroundJobsSnapshot;
  let covered: BackgroundJobsSnapshot["jobs"];
  let excluded: Array<{ id: string; reason: string }>;
  let finalSnapshot: BackgroundJobsSnapshot;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    // Drive at least one full sync so document-driven jobs have work
    // to tick against. Backfill jobs short-circuit when there are zero
    // documents; we want a representative steady-state graph.
    await harness.syncAllSources();

    // Snapshot the registry once sync finished so we discover every
    // job the gateway boot wired in. A new job added later picks up
    // here automatically.
    //
    // Poll until non-empty rather than reading once: the gateway brings
    // its HTTP port up (health check passes, sync runs) *before* the
    // scheduler-backed jobs call `registry.registerAll(...)` during boot,
    // and the registry's cached snapshot refreshes on a 2s tick. So the
    // endpoint can legitimately report an empty registry for a brief
    // window after the server is reachable — racing sync completion on a
    // loaded runner. Polling closes that race; a registry that genuinely
    // never populates still times out here and trips the assertion below.
    initialSnapshot = await waitForRegistryPopulated(harness, 30_000);
    expect(initialSnapshot.jobs.length).toBeGreaterThan(0);

    const split = partitionByCadence(initialSnapshot.jobs);
    covered = split.covered;
    excluded = split.excluded;
    log.info(
      `Discovered ${initialSnapshot.jobs.length} jobs; covering ${covered.length}, excluding ${excluded.length}`,
    );

    finalSnapshot = await waitForAllJobsToTick(harness, covered, OBSERVATION_WINDOW_MS);
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("at least one job is covered (registry isn't empty)", () => {
    expect(covered.length).toBeGreaterThan(0);
  });

  test("every covered job ticked within the observation window", () => {
    const missing: string[] = [];
    for (const job of covered) {
      const observed = finalSnapshot.jobs.find((j) => j.id === job.id);
      const ticked =
        observed != null &&
        (observed.observation.lastTickAt != null || observed.observation.ticksLastHour > 0);
      if (!ticked) missing.push(job.id);
    }
    expect(
      missing,
      `Jobs that never ticked within ${OBSERVATION_WINDOW_MS}ms: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("no covered job reported an error on its most recent tick", () => {
    const erroring: Array<{ id: string; message: string }> = [];
    for (const job of covered) {
      const observed = finalSnapshot.jobs.find((j) => j.id === job.id);
      if (!observed) continue;
      if (observed.observation.state === "erroring" || observed.observation.lastError != null) {
        erroring.push({
          id: job.id,
          message: observed.observation.lastError?.message ?? "state=erroring",
        });
      }
    }
    expect(
      erroring,
      `Jobs reporting errors: ${erroring.map((e) => `${e.id} (${e.message})`).join("; ")}`,
    ).toEqual([]);
  });

  test("exclusion list is intentional (every excluded job has a cadence reason)", () => {
    // Documenting the contract: nothing falls out of coverage by
    // accident. Every excluded job must carry a reason string the
    // cadence partitioner stamped on it.
    for (const ex of excluded) {
      expect(ex.reason, `excluded job ${ex.id} missing a reason`).toBeTruthy();
    }
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Poll `/admin/background-jobs` until the registry reports at least one
 * job. Scheduler-backed jobs register into the registry during gateway
 * boot, *after* the HTTP server starts listening — and the registry's
 * cached snapshot only refreshes every couple of seconds. A health-gated
 * harness can therefore observe an empty registry for a brief window
 * right after boot. Polling removes that race while preserving the
 * regression net: if registration never happens, this times out with an
 * empty snapshot and the caller's assertion fails.
 */
async function waitForRegistryPopulated(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<BackgroundJobsSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
  while (snap.jobs.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
  }
  return snap;
}

/**
 * Split the registry into jobs we expect to tick within the observation
 * window vs. jobs whose cadence is too long (or who are disabled, or
 * who are wake/on-demand). Decision is derived from each job's
 * `cadence` field — no hardcoded id allowlist — so a new job added
 * later picks up automatically.
 */
function partitionByCadence(jobs: BackgroundJobsSnapshot["jobs"]): {
  covered: BackgroundJobsSnapshot["jobs"];
  excluded: Array<{ id: string; reason: string }>;
} {
  const covered: BackgroundJobsSnapshot["jobs"] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  for (const job of jobs) {
    if (job.observation.state === "disabled") {
      excluded.push({ id: job.id, reason: "disabled at boot" });
      continue;
    }
    const c = job.cadence;
    // A job whose first tick is deliberately deferred past the observation
    // window cannot tick in time by design (e.g. nearDupDfRefresh's 120s
    // startDelay keeps the DF full-corpus scan from starving the indexer at
    // boot). Exclude it rather than demanding a tick the product intentionally
    // prevents — this still fails the suite if a job that *should* tick wedges.
    if (
      (c.mode === "periodic" || c.mode === "drip") &&
      (c.startDelayMs ?? 0) > OBSERVATION_WINDOW_MS
    ) {
      excluded.push({
        id: job.id,
        reason: `startDelay ${c.startDelayMs}ms > ${OBSERVATION_WINDOW_MS}ms — first tick beyond window`,
      });
      continue;
    }
    switch (c.mode) {
      case "periodic":
        if (c.intervalMs > MAX_ACTIVE_CADENCE_MS) {
          excluded.push({
            id: job.id,
            reason: `periodic ${c.intervalMs}ms > ${MAX_ACTIVE_CADENCE_MS}ms`,
          });
        } else {
          covered.push(job);
        }
        break;
      case "drip":
        if (c.activeMs > MAX_ACTIVE_CADENCE_MS) {
          excluded.push({
            id: job.id,
            reason: `drip active=${c.activeMs}ms > ${MAX_ACTIVE_CADENCE_MS}ms`,
          });
        } else {
          covered.push(job);
        }
        break;
      case "continuous": {
        const nominal = c.nominalIntervalMs ?? Number.MAX_SAFE_INTEGER;
        if (nominal > MAX_ACTIVE_CADENCE_MS) {
          excluded.push({
            id: job.id,
            reason: `continuous nominal=${nominal}ms > ${MAX_ACTIVE_CADENCE_MS}ms`,
          });
        } else {
          covered.push(job);
        }
        break;
      }
      case "wake-driven":
        excluded.push({ id: job.id, reason: "wake-driven — no guaranteed in-window tick" });
        break;
      case "on-demand":
        excluded.push({ id: job.id, reason: "on-demand — only runs when triggered" });
        break;
      default: {
        // Exhaustiveness: a future cadence variant must declare its
        // bucket explicitly. We default to excluding so a new mode
        // doesn't silently fail the suite — but we log loudly so the
        // partitioner gets updated.
        const _exhaustive: never = c;
        void _exhaustive;
        excluded.push({ id: job.id, reason: "unknown cadence mode" });
      }
    }
  }
  return { covered, excluded };
}

/**
 * Poll `/admin/background-jobs` until every covered job has ticked at
 * least once. Returns the final snapshot so the assertions can inspect
 * per-job state without re-fetching.
 */
async function waitForAllJobsToTick(
  harness: SyntheticE2EHarness,
  covered: BackgroundJobsSnapshot["jobs"],
  timeoutMs: number,
): Promise<BackgroundJobsSnapshot> {
  const expectedIds = new Set(covered.map((j) => j.id));
  const deadline = Date.now() + timeoutMs;
  let snap: BackgroundJobsSnapshot | null = null;
  while (Date.now() < deadline) {
    snap = await harness.gatewayJson<BackgroundJobsSnapshot>("/admin/background-jobs");
    const pending: string[] = [];
    for (const id of expectedIds) {
      const job = snap.jobs.find((j) => j.id === id);
      const ticked =
        job != null && (job.observation.lastTickAt != null || job.observation.ticksLastHour > 0);
      if (!ticked) pending.push(id);
    }
    if (pending.length === 0) return snap;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!snap) {
    throw new Error(`waitForAllJobsToTick: never read a snapshot within ${timeoutMs}ms`);
  }
  // Return the last snapshot anyway — the assertion below renders the
  // missing-jobs list with their ids, which is the diagnostic we want.
  return snap;
}
