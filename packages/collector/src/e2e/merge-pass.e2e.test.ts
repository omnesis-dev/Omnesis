// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Auto-detected merge propagation (the `mergePass` cluster).
 *
 * Companion to `people-graph.e2e.test.ts`, which exercises the
 * **user-issued** merge-rule path. This file exercises the
 * **system-rule** path: rules with `kind='system'` (what
 * `backfill.autoDetect` would emit for a cross-identifier candidate)
 * still need `mergeRulesEval` to derive `people.merged_into`, and a
 * regression in that propagation would otherwise go unnoticed.
 *
 * Trigger story: there is no `/admin/<task>/run-now` route on the
 * gateway, and `e2e-minimal` doesn't override the scheduler cadences,
 * so we can't force-fire `backfill.autoDetect` (5 min cadence) or
 * `backfill.mergeRulesEval` (60 s active / 15 s start-delay) directly
 * — same constraint `people-graph.e2e.test.ts` works around. We use
 * the same pattern: observe `/admin/background-jobs` to assert the
 * jobs are wired, then POST a `kind='system'` rule and poll the
 * people rows until eval has propagated within the 60 s active tick
 * + slack. This mirrors how `autoDetectTask` writes system rules
 * which then flow into `mergeRulesEvalTask` on its next active tick.
 *
 * Today's `computeAutoDetectedRules` only emits *tautology*
 * candidates (sideA===sideB on a shared identifier), which collapse
 * into `physicalMergePeopleByAlias` and DELETE the loser row — they
 * never populate `merged_into`. The cross-identifier path that does
 * populate `merged_into` lives in `upsertAutoDetectedRules` and is
 * preserved for future fuzzy-bridge detectors (see the comment in
 * `domain/merge/auto-detect.ts`). We inject a `kind='system'` rule
 * directly so this regression net protects that path even before a
 * detector exists that would emit one in steady state.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createLogger } from "@omnesis/core";
import { SyntheticE2EHarness } from "./synth-harness.js";

const log = createLogger("collector:e2e:merge-pass");

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
  sideA: PersonAlias;
  sideB: PersonAlias;
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

describe("Auto-detect merge propagation (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // People resolution is async — wait until both Jane and Emma are
    // findable before any per-person assertions run.
    await Promise.all([
      waitForPersonByName(harness, "Jane Doe", 30_000),
      waitForPersonByName(harness, "Emma Park", 30_000),
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("mergePass cluster jobs are wired and tick", async () => {
    // `autoDetect` start-delay is 30 s, `mergeRulesEval` is 15 s.
    // Both should tick within the 90 s window with slack to spare.
    await Promise.all([
      waitForJobTicked(harness, "backfill.autoDetect", 90_000),
      waitForJobTicked(harness, "backfill.mergeRulesEval", 90_000),
    ]);
  }, 120_000);

  test("kind=system rule propagates into people.merged_into and the loser redirects", async () => {
    // Pick two distinct people that resolved with at least one email
    // alias attached. We seed the system rule across their emails
    // (cross-identifier shape — same kind of bridge a fuzzy-bridge
    // auto-detector would emit). Aliases must be present BEFORE the
    // POST, otherwise the eval pass sees no people on either side
    // and silently succeeds with no propagation.
    const [janeHits, emmaHits] = await Promise.all([
      harness.gatewayJson<PeopleSearchResp>("/people/search?q=Jane%20Doe&limit=1"),
      harness.gatewayJson<PeopleSearchResp>("/people/search?q=Emma%20Park&limit=1"),
    ]);
    const jane = janeHits.items[0];
    const emma = emmaHits.items[0];
    expect(jane, "Jane Doe should resolve in the people graph").toBeDefined();
    expect(emma, "Emma Park should resolve in the people graph").toBeDefined();
    expect(jane.id).not.toBe(emma.id);

    const janeEmail = await waitForEmailAlias(harness, jane.id, 30_000);
    const emmaEmail = await waitForEmailAlias(harness, emma.id, 30_000);
    expect(janeEmail.alias).not.toBe(emmaEmail.alias);

    log.info(
      `seeding kind=system rule: ${janeEmail.aliasType}=${janeEmail.alias} <-> ${emmaEmail.aliasType}=${emmaEmail.alias}`,
    );
    const created = await harness.gatewayJson<CreateMergeRuleResp>("/people/merge-rules", {
      method: "POST",
      body: JSON.stringify({
        sideA: janeEmail,
        sideB: emmaEmail,
        winnerSide: "a",
        kind: "system",
        reason: "merge-pass.e2e: seeded system rule for propagation coverage",
      }),
    });
    expect(created.rule.id).toBeTruthy();
    expect(created.rule.kind).toBe("system");

    try {
      // 1. GET /people/merge-rules?kind=system surfaces our rule.
      // Polled because the rules-list read is cheap but the prior
      // POST and this GET aren't strictly ordered against any
      // background bookkeeping — keeps the assertion resilient.
      const systemRules = await waitForSystemRule(harness, created.rule.id, 10_000);
      const ours = systemRules.find((r) => r.id === created.rule.id);
      expect(ours, "the seeded kind=system rule should be listed").toBeDefined();
      expect(ours?.kind).toBe("system");
      expect(ours?.active).toBe(true);

      // 2. mergeRulesEval propagates the rule into `people.merged_into`.
      // Active cadence is 60 s; 90 s window leaves slack for the OCC
      // dirty-bump → next-tick path.
      const { winner, loser } = await waitForMergePropagation(harness, jane.id, emma.id, 90_000);

      // 3. The loser row carries `merged_into = winner` and the
      // canonical fans the loser in via `mergedFrom`.
      const [loserDetail, winnerDetail] = await Promise.all([
        harness.gatewayJson<PersonDetail>(`/people/${loser}`),
        harness.gatewayJson<PersonDetail>(`/people/${winner}`),
      ]);
      expect(loserDetail.mergedInto).toBe(winner);
      expect(winnerDetail.mergedInto).toBeNull();
      expect(winnerDetail.mergedFrom.some((p) => p.id === loser)).toBe(true);
    } finally {
      try {
        await harness.gatewayJson(`/people/merge-rules/${created.rule.id}`, { method: "DELETE" });
      } catch {
        /* harness teardown will clean up */
      }
    }
  }, 180_000);
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
 * one tick. Same pattern as `people-graph.e2e.test.ts` — observing the
 * registry's `lastTickAt` is the synth-friendly proxy for "the
 * scheduler is running this job."
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
 * Poll /people/:id until at least one email alias is attached, then
 * return the first one. Eval needs aliases present on both sides
 * before it can resolve a rule into person ids.
 */
async function waitForEmailAlias(
  harness: SyntheticE2EHarness,
  id: string,
  timeoutMs: number,
): Promise<PersonAlias> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await harness.gatewayJson<PersonDetail>(`/people/${id}`);
    const email = detail.aliases.find((a) => a.aliasType === "email");
    if (email) return { aliasType: email.aliasType, alias: email.alias };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForEmailAlias: ${id} never gained an email alias within ${timeoutMs}ms`);
}

/**
 * Poll /people/merge-rules?kind=system until the named rule id shows
 * up. Guards against any brief lag between POST commit and the
 * read-side index seeing the row.
 */
async function waitForSystemRule(
  harness: SyntheticE2EHarness,
  ruleId: string,
  timeoutMs: number,
): Promise<MergeRule[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await harness.gatewayJson<MergeRulesResp>("/people/merge-rules?kind=system");
    if (resp.rules.some((r) => r.id === ruleId)) return resp.rules;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForSystemRule: ${ruleId} did not show up within ${timeoutMs}ms`);
}

/**
 * Poll the two person rows until one of them has `merged_into`
 * pointing at the other. Returns {winner, loser}: which is which
 * depends on the rule evaluator's canonical pick (is_self > earliest
 * first_seen > lexicographic id), so the test shouldn't pre-commit.
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
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `waitForMergePropagation: neither ${idA} nor ${idB} got merged_into the other within ${timeoutMs}ms`,
  );
}
