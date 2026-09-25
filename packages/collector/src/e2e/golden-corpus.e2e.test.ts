// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Golden-corpus regression net.
 *
 * Boots a real gateway against the `e2e-minimal` universe (slim,
 * deterministic synthetic corpus — see docs/universes.md), syncs every
 * source, and snapshots a fixed list of canonical operations:
 *
 *   - per-source document count
 *   - the source list and source-meta surface
 *   - search results for known queries that span source families
 *   - the "self" person card + the people graph top-by-interaction
 *   - per-person doc fan-out for the most-mentioned counterpart
 *
 * Snapshots are normalized (UUIDs, timestamps, and a few server-set
 * fields stripped) so the assertion stays stable across boots. Any
 * real change in behavior — ranking shift, link-extraction tweak,
 * people-resolution edge case, count column drift — surfaces as a
 * snapshot diff that has to be reviewed in the PR. Run
 * `npx vitest run packages/collector/src/e2e/golden-corpus.e2e.test.ts -u`
 * to accept intentional updates.
 *
 * Why e2e-minimal: the rich `default` corpus has demo-padded fixtures
 * whose sizes drift as scenarios are added. Minimal is bounded —
 * 3 entries per unstructured source — so snapshots survive
 * unrelated demo work.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface StatusResp {
  documents: {
    total: number;
    bySource: Record<string, number>;
  };
}

interface DocSearchHit {
  id: string;
  source_id: string;
  title: string;
  source_created_at?: string;
}

interface DocSearchResp {
  results: DocSearchHit[];
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

const AUTHORITATIVE_IDENTITY_SOURCE_IDS = [
  "google-contacts:john.smith@example.com",
  "apple-contacts:john.smith@icloud.example",
  // A commit carries a GitHub login and the author's real git email on one
  // identity, so it is the only GitHub source that can attach a login to the
  // person who owns that mailbox. A thread carries the login and a display
  // name alone — GitHub's API exposes no email for a thread's author — so a
  // login first seen on a thread becomes a person of its own, and the later
  // commit will not force those two together. Commits therefore sync first,
  // making it deterministic which contributors are bridged.
  "github-commits:john-smith",
] as const;

describe("Golden-corpus regression net (e2e-minimal)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      // The production auto-detect cadence is five minutes. This suite needs
      // a post-ingestion scan inside its bounded setup window, even when the
      // initial 30-second scan lands while source sync is still running.
      extraGatewayConfig: {
        gateway: {
          backfill: {
            autoDetect: { interval: "5s" },
            interactionScores: { interval: "5s", idleDelay: "5s" },
            mergePass: { interval: "5s" },
          },
        },
      },
    });
    await harness.start();
    // Establish the universe's authoritative identities before partial
    // mentions from mail, chat, meetings, and GitHub threads arrive. A mention spanning
    // identifiers that already belong to different people deliberately does
    // not merge them: a real contact card may contain a family member's phone
    // or a shared address. Syncing and resolving these sources first
    // gives this regression corpus one deterministic identity graph without
    // weakening that production safety boundary.
    const allSourceIds = harness.getSourceIds();
    for (const sourceId of AUTHORITATIVE_IDENTITY_SOURCE_IDS) {
      expect(allSourceIds, `missing authoritative identity source ${sourceId}`).toContain(sourceId);
    }
    await Promise.all(
      AUTHORITATIVE_IDENTITY_SOURCE_IDS.map((sourceId) =>
        harness.triggerSyncAndWait(sourceId, 90_000),
      ),
    );
    await waitForPeopleResolutionBacklog(harness, 90_000);

    // Sync every remaining source so the gateway has documents + people +
    // index chunks to query. People resolution is a background writer-handler;
    // stop ingestion after the explicit sync so no realtime work can mutate
    // the graph while the snapshots run.
    const authoritative = new Set<string>(AUTHORITATIVE_IDENTITY_SOURCE_IDS);
    await Promise.all(
      allSourceIds
        .filter((sourceId) => !authoritative.has(sourceId))
        .map((sourceId) => harness.triggerSyncAndWait(sourceId, 90_000)),
    );
    const drainedSync = await harness.stopSyncLoopsAndDrain(60_000);
    expect(
      drainedSync.timedOut,
      `collector did not drain (started with ${drainedSync.inflight} syncs in flight)`,
    ).toBe(false);
    await waitForPeopleResolutionBacklog(harness, 90_000);
    await harness.refreshSearchSnapshot();
    // Wait for the EXACT people-graph query the snapshot reads to be
    // stable across consecutive polls. Just waiting for Jane Doe to be
    // findable was not enough: between her landing as a row and the
    // snapshot read, the autoDetect (startDelayMs=30s) + mergeRulesEval
    // (every 60s) tasks can merge her into another person — or shift
    // doc_count via the mergePass refresh — and the top-N changes. By
    // polling for steady-state we surf past whatever timing the
    // backgrounds are in.
    await waitForPeopleGraphConvergence(harness, 150_000);
    await waitForPeopleGraphStable(harness, 30_000);
    const quiesced = await harness.gatewayJson<{ quiesced: boolean }>(
      "/admin/background/quiesce-periodics",
      { method: "POST" },
    );
    expect(quiesced.quiesced).toBe(true);
    // Periodic roots are stopped, but background dispatch remains enabled so
    // already-running roots can finish any nested IO/CPU/writer work.
    await waitForSchedulerIdle(harness, 90_000);
    const pause = await harness.gatewayJson<{ paused: boolean }>("/admin/background/pause", {
      method: "POST",
    });
    expect(pause.paused).toBe(true);
    // The post-pause read is authoritative: an auto-detect/eval/merge task
    // that was already in flight may legitimately have changed the graph
    // while the scheduler drained. With dispatch paused and the collector
    // stopped, these stable reads prove the snapshot state is frozen.
    await waitForPeopleGraphStable(harness, 30_000);
    await expectJaneIdentityConverged(harness);
  }, 900_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("per-source document count matches the universe fixtures", async () => {
    const status = await harness.gatewayJson<StatusResp>("/status");
    const bySource = sortObjectKeys(status.documents.bySource);
    expect({ total: status.documents.total, bySource }).toMatchSnapshot();
  });

  test("a healthy full sync leaves no document marked absent", () => {
    // Every snapshot in this run enumerated its source completely, so the
    // absence ledger must be empty. It is the tripwire for the opposite of the
    // bug this rule fixes: a change that made ordinary syncs record absences
    // would put every document in the corpus on a deletion clock, and this
    // assertion is what notices before the deadline does.
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const pending = db
        .prepare<
          [],
          { source_id: string; external_id: string }
        >("SELECT source_id, external_id FROM document_absences ORDER BY source_id, external_id")
        .all();
      expect(pending).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the source list contains every descriptor the universe declares", () => {
    const ids = harness.getSourceIds().sort();
    expect(ids).toMatchSnapshot();
  });

  test('search "vendor evaluation" spans the expected source families', async () => {
    const top = await searchTop(harness, "vendor evaluation", 8);
    expect(top).toMatchSnapshot();
  });

  test('search "Globex" surfaces docs across notes, drive, calendar, and chat', async () => {
    const top = await searchTop(harness, "Globex", 8);
    expect(top).toMatchSnapshot();
  });

  test('search "marathon training" finds the single matching gmail', async () => {
    const top = await searchTop(harness, "marathon training", 5);
    expect(top).toMatchSnapshot();
  });

  // Note: there's no /people/self snapshot here. No roster device carries
  // self emails or phones and nothing bootstraps a contact card, so
  // `is_self` is unset on every person row and `/people/self` returns 404.
  // Self info on a device would change the universe content (and brittlely
  // couple this test to the self bootstrap), so we focus on Jane Doe as a stable
  // non-self counterpart instead.

  test("Jane Doe — full person card with aliases", async () => {
    const results = await harness.gatewayJson<PeopleSearchResp>(
      "/people/search?q=Jane%20Doe&limit=3",
    );
    const jane = results.items[0];
    expect(jane, "Jane Doe should be findable in the people graph").toBeDefined();
    const card = await harness.gatewayJson<{
      canonicalName: string;
      isSelf: boolean;
      aliases?: Array<{ aliasType: string; alias: string }>;
    }>(`/people/${jane.id}`);
    // The card snapshot focuses on the alias identity contract; the frozen
    // setup invariant separately verifies the curated canonical name.
    expect({
      isSelf: card.isSelf,
      aliasesByType: groupAliases(card.aliases ?? []),
    }).toMatchSnapshot();
  });

  test("people graph — top non-self people by document count + alias signature", async () => {
    // Empty query returns the unfiltered list; we strip self and keep the
    // top N. Each row is identified by its sorted name-alias signature
    // (deterministic via INSERT OR IGNORE), keeping this ranking snapshot
    // independent of canonical-name selection. The ranker leaves equal-ranked
    // people (same interaction score AND doc_count) in arbitrary storage
    // order, and person ids are per-run random, so we re-sort the rows below
    // by a deterministic key before snapshotting to avoid tie-order flicker.
    const results = await harness.gatewayJson<PeopleSearchResp>("/people/search?q=&limit=30");
    const top = await Promise.all(
      results.items
        .filter((p) => !p.isSelf)
        .slice(0, 10)
        .map(async (p) => {
          const card = await harness.gatewayJson<{
            aliases?: Array<{ aliasType: string; alias: string }>;
          }>(`/people/${p.id}`);
          const nameAliases = (card.aliases ?? [])
            .filter((a) => a.aliasType === "name")
            .map((a) => a.alias)
            .sort();
          return {
            // Use the stable name alias (or the first email alias if no name)
            // as the deterministic identifier for this row.
            identifyingName:
              nameAliases[0] ??
              (card.aliases ?? []).find((a) => a.aliasType === "email")?.alias ??
              "<unknown>",
            documentCount: p.documentCount,
            aliasCount: p.aliasCount,
          };
        }),
    );
    // The API order ties on equal documentCount, so the relative order of
    // same-doc-count people flickers run-to-run (Promise.all resolution +
    // background-score timing). Re-sort by a fully deterministic key
    // (documentCount, aliasCount, identifyingName) so the snapshot is stable.
    top.sort(
      (a, b) =>
        b.documentCount - a.documentCount ||
        b.aliasCount - a.aliasCount ||
        a.identifyingName.localeCompare(b.identifyingName),
    );
    expect(top).toMatchSnapshot();
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function searchTop(
  harness: SyntheticE2EHarness,
  query: string,
  limit: number,
): Promise<Array<{ sourceId: string; title: string }>> {
  // /documents/search is the LIKE-based search (substring over `content`),
  // not the full BM25+vector pipeline at POST /search. We use it because
  // the E2E harness boots the gateway without an embedding model, so the
  // vector index is empty — POST /search would return zero results. LIKE
  // is deterministic across runs (ordered by source_created_at DESC) and
  // covers what a regression test cares about: "do queries reach the
  // expected documents and source families?" — see synth-search.e2e.ts
  // for the same trade-off.
  const res = await harness.gatewayJson<DocSearchResp>(
    `/documents/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return (res.results ?? []).map((h) => ({
    sourceId: h.source_id,
    title: h.title,
  }));
}

function groupAliases(
  aliases: Array<{ aliasType: string; alias: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of aliases) {
    (out[a.aliasType] ??= []).push(a.alias);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))) as T;
}

async function expectJaneIdentityConverged(harness: SyntheticE2EHarness): Promise<void> {
  const aliasesResult = await harness.gatewayJson<{ rows: unknown[][] }>("/sql", {
    method: "POST",
    body: JSON.stringify({
      sql: `SELECT pa.alias_type, pa.alias, p.id
            FROM person_aliases pa
            JOIN people p ON p.id = pa.person_id
            WHERE (pa.alias_type = 'email' AND pa.alias IN (
              'jane.doe@acme.example', 'jane.doe@example.org'
            ))
               OR (pa.alias_type = 'phone' AND pa.alias = '+15550101')
               OR (pa.alias_type = 'lid' AND pa.alias IN (
                 '100200301@lid', 'github:jane-doe'
               ))
            ORDER BY pa.alias_type, pa.alias`,
    }),
  });

  const aliases = [
    ...new Set(
      aliasesResult.rows.map(([aliasType, alias]) => `${String(aliasType)}:${String(alias)}`),
    ),
  ].sort();
  expect(aliases, "all authoritative Jane identifiers should be present").toEqual([
    "email:jane.doe@acme.example",
    "email:jane.doe@example.org",
    "lid:100200301@lid",
    "lid:github:jane-doe",
    "phone:+15550101",
  ]);

  const peopleResult = await harness.gatewayJson<{ rows: unknown[][] }>("/sql", {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT id, merged_into, canonical_name FROM people" }),
  });
  const peopleById = new Map(
    peopleResult.rows.map(([personId, mergedInto, canonicalName]) => [
      String(personId),
      {
        mergedInto: mergedInto === null ? null : String(mergedInto),
        canonicalName: String(canonicalName),
      },
    ]),
  );
  const resolveCanonical = (personId: string): string => {
    let current = personId;
    for (let hop = 0; hop < 10; hop += 1) {
      const person = peopleById.get(current);
      if (!person) throw new Error(`Jane identity points to missing person ${current}`);
      if (person.mergedInto === null) return current;
      current = person.mergedInto;
    }
    return current;
  };
  const canonicalIds = new Set(
    aliasesResult.rows.map(([, , personId]) => resolveCanonical(String(personId))),
  );
  expect(
    canonicalIds.size,
    `Jane identifiers resolved to multiple canonical people: ${JSON.stringify(aliasesResult.rows)}`,
  ).toBe(1);
  const canonicalId = canonicalIds.values().next().value;
  expect(canonicalId, "Jane identity should have a canonical person").toBeDefined();
  const canonical = peopleById.get(canonicalId!);
  expect(canonical, `Jane identity points to missing canonical ${canonicalId}`).toBeDefined();
  expect(canonical?.mergedInto, "Jane canonical should be an unmerged root").toBeNull();
  expect(canonical?.canonicalName).toBe("Jane Doe");
}

interface SchedulerMetricsSnap {
  perRunner: Array<{
    runner: string;
    inFlight: number;
  }>;
}

/**
 * Poll the unfiltered `/people/search` endpoint until the top-N rows
 * are stable across many consecutive reads.
 *
 * People resolution runs as a background writer-handler, and on top of
 * that the gateway runs four background tasks that can move or rank people
 * around the graph and silently empty `/people/search` (which filters
 * `WHERE merged_into IS NULL`):
 *
 *   - `backfill.autoDetect` (startDelayMs=30s, period=5min) — scans
 *     for shared-identifier merge candidates and inserts system rules
 *   - `backfill.mergeRulesEval` (startDelayMs=15s, period=60s) — applies
 *     `merge_rules` to `person_equivalences` + `people.merged_into`
 *   - `backfill.peopleCountsRefresh` (startDelayMs=60s, period=10min) — refreshes
 *     materialized `people.doc_count`
 *   - `backfill.interactionScoresRefresh` — refreshes the default ranking
 *     used by the unfiltered people search below
 *
 * Just waiting for a single person to be findable was too weak — the
 * graph kept mutating after the wait returned and snapshots picked up
 * an intermediate state. Polling for repeated identical reads of the
 * snapshot query also wasn't enough: it can lock onto a pre-merge
 * window, after which `mergeRulesEval` flips half the rows'
 * `merged_into` and `/people/search` goes empty.
 *
 * The caller separately establishes the gateway-side people backlog and
 * identity/ranking completion chain. This helper then requires the top-N
 * people-search result to be identical across 5 reads taken ≥1s apart.
 *
 * The caller freezes background dispatch and drains in-flight scheduler
 * work after this convergence check, then calls this helper again against
 * the frozen graph before snapshots run.
 */
async function waitForPeopleGraphStable(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let stableReads = 0;
  while (Date.now() < deadline) {
    const res = await harness.gatewayJson<PeopleSearchResp>("/people/search?q=&limit=30");
    const key = JSON.stringify(
      res.items.map((p) => ({
        isSelf: p.isSelf,
        aliasCount: p.aliasCount,
        documentCount: p.documentCount,
        canonicalName: p.canonicalName,
      })),
    );
    if (key === lastKey) {
      stableReads += 1;
      if (stableReads >= 5 && res.items.length > 0) return;
    } else {
      stableReads = 1;
      lastKey = key;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `waitForPeopleGraphStable: people graph did not stabilize within ${timeoutMs}ms (lastKey=${lastKey.slice(0, 500)})`,
  );
}

async function waitForPeopleResolutionBacklog(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveEmptyReads = 0;
  let lastUnresolved = -1;
  while (Date.now() < deadline) {
    const result = await harness.gatewayJson<{ rows: unknown[][] }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT COUNT(*) FROM documents WHERE people_resolved_at IS NULL",
      }),
    });
    lastUnresolved = Number(result.rows[0]?.[0] ?? -1);
    consecutiveEmptyReads = lastUnresolved === 0 ? consecutiveEmptyReads + 1 : 0;
    if (consecutiveEmptyReads >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `waitForPeopleResolutionBacklog: ${lastUnresolved} unresolved documents after ${timeoutMs}ms`,
  );
}

async function waitForPeopleGraphConvergence(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastAutoResult: PeriodicResult | undefined;
  let mutationGeneration: number | undefined;
  for (let pass = 1; pass <= 5 && Date.now() < deadline; pass += 1) {
    lastAutoResult = await runPeriodic(
      harness,
      "backfill.autoDetect",
      Math.max(1, deadline - Date.now()),
    );
    if (
      lastAutoResult.successful !== true ||
      typeof lastAutoResult.inserted !== "number" ||
      typeof lastAutoResult.mutationGeneration !== "number"
    ) {
      throw new Error(
        `backfill.autoDetect did not complete successfully: ${JSON.stringify(lastAutoResult)}`,
      );
    }
    const mutatedSinceLastStage =
      mutationGeneration === undefined || lastAutoResult.mutationGeneration !== mutationGeneration;
    mutationGeneration = lastAutoResult.mutationGeneration;

    // A zero-generation change after the prior merge pass proves that neither
    // a pre-existing in-flight auto tick nor its awaited trailing tick found
    // work. The previous pass already refreshed all derived state.
    if (pass > 1 && !mutatedSinceLastStage) return;

    await runOccPeriodicToCaughtUp(harness, "backfill.mergeRulesEval", "merge_rules", deadline);
    await Promise.all([
      runOccPeriodicToCaughtUp(
        harness,
        "backfill.interactionScoresRefresh",
        "interaction_scores",
        deadline,
      ),
      runSweepToCompletion(harness, "backfill.peopleCountsRefresh", deadline),
    ]);
  }
  throw new Error(
    `waitForPeopleGraphConvergence: no fixed point after 5 passes (last auto result ${JSON.stringify(lastAutoResult)})`,
  );
}

interface PeriodicResult {
  idle: boolean;
  successful?: true;
  inserted?: number;
  mutationGeneration?: number;
}

async function runPeriodic(
  harness: SyntheticE2EHarness,
  taskName: string,
  timeoutMs: number,
): Promise<PeriodicResult> {
  const boundedTimeoutMs = Math.max(1, Math.min(120_000, timeoutMs));
  const response = await harness.gatewayJson<{ result: PeriodicResult }>(
    `/admin/background/run/${encodeURIComponent(taskName)}?timeoutMs=${boundedTimeoutMs}`,
    { method: "POST", signal: AbortSignal.timeout(boundedTimeoutMs + 1_000) },
  );
  return response.result;
}

async function runOccPeriodicToCaughtUp(
  harness: SyntheticE2EHarness,
  taskName: string,
  refreshJob: "merge_rules" | "interaction_scores",
  deadline: number,
): Promise<void> {
  let lastMeta: unknown[] | undefined;
  let lastResult: PeriodicResult | undefined;
  while (Date.now() < deadline) {
    const periodicResult = await runPeriodic(harness, taskName, Math.max(1, deadline - Date.now()));
    lastResult = periodicResult;
    const result = await harness.gatewayJson<{ rows: unknown[][] }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT dirty_version, last_computed_version FROM refresh_meta WHERE job = '${refreshJob}'`,
      }),
    });
    lastMeta = result.rows[0];
    if (Number(lastMeta?.[0]) === Number(lastMeta?.[1])) return;
    await new Promise((resolve) => setTimeout(resolve, periodicResult.idle ? 250 : 50));
  }
  throw new Error(
    `${taskName} did not catch up before the convergence deadline (result=${JSON.stringify(lastResult)}, meta=${lastMeta})`,
  );
}

async function runSweepToCompletion(
  harness: SyntheticE2EHarness,
  taskName: string,
  deadline: number,
): Promise<void> {
  let lastResult: PeriodicResult | undefined;
  while (Date.now() < deadline) {
    lastResult = await runPeriodic(harness, taskName, Math.max(1, deadline - Date.now()));
    if (lastResult.successful !== true) {
      throw new Error(`${taskName} did not complete successfully: ${JSON.stringify(lastResult)}`);
    }
    if (lastResult.idle) return;
  }
  throw new Error(`${taskName} did not complete its sweep (${JSON.stringify(lastResult)})`);
}

async function waitForSchedulerIdle(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveIdleReads = 0;
  let lastSnapshot: SchedulerMetricsSnap | undefined;
  while (Date.now() < deadline) {
    lastSnapshot = await harness.gatewayJson<SchedulerMetricsSnap>("/admin/scheduler-metrics");
    const idle =
      lastSnapshot.perRunner.length > 0 &&
      lastSnapshot.perRunner.every((runner) => runner.inFlight === 0);
    consecutiveIdleReads = idle ? consecutiveIdleReads + 1 : 0;
    if (consecutiveIdleReads >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `waitForSchedulerIdle: scheduler did not drain within ${timeoutMs}ms (${JSON.stringify(
      lastSnapshot?.perRunner ?? [],
    )})`,
  );
}
