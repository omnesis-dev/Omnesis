// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Link-extraction background-job coverage.
 *
 * Boots a real gateway against the `e2e-minimal` synthetic universe,
 * syncs every source, and asserts the `linkBackfill` +
 * `linkStatsRefresh` jobs both fire and populate `document_links` +
 * the materialized `link_stats` row.
 *
 * Why e2e-minimal: matches the other coverage E2Es in this directory
 * (golden-corpus, cli, people-graph). Its chrome-bookmarks fixture
 * carries the only deterministic guaranteed-URL surface (three rows,
 * each with a `url` field), which is enough to drive linkBackfill
 * past zero — what we need for the assertion. The default universe
 * has more URLs but doubles the boot cost, and the marginal coverage
 * isn't worth the RAM and wall-clock hit.
 *
 * Cadence note: there's no env-var override for `linkReconcileIntervalMs`
 * (5 min default). `linkBackfill` runs every 1s, and `linkStatsRefresh`
 * every 30s. Within the ~90s test window we reliably observe
 * `linkBackfill` drain + `linkStats` populate; `linkReconcile` may or
 * may not have fired yet (its first tick is 30s after boot), so the
 * test asserts only that the resolved/unresolved fields are
 * structurally valid numbers — not specific resolved counts.
 */

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface LinkStatsResp {
  totalLinks: number;
  resolvedLinks: number;
  unresolvedLinks: number;
  byType: Record<string, { total: number; resolved: number }>;
}

const EAGER_THREAD_SOURCE_ID = "synthetic:test@example.com";
const EAGER_THREAD_ID = "thread-eager-resolution";

describe("Link-extraction background jobs (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let stats: LinkStatsResp;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.syncAllSources();
    // The universe's thread ids are intentionally all distinct, so none of
    // its part-of-thread links has a possible target. Add a same-source pair
    // whose target documents are committed together before link extraction
    // sees either one. This makes eager read-side resolution a fixture
    // invariant instead of depending on unrelated universe content.
    await harness.pushDocuments([
      {
        sourceId: EAGER_THREAD_SOURCE_ID,
        externalId: "eager-thread-message-a",
        title: "Project update",
        content: "Maya shared the revised project outline.",
        metadata: { extra: { threadId: EAGER_THREAD_ID } },
      },
      {
        sourceId: EAGER_THREAD_SOURCE_ID,
        externalId: "eager-thread-message-b",
        title: "Re: Project update",
        content: "Jamie confirmed the next review step.",
        metadata: { extra: { threadId: EAGER_THREAD_ID } },
      },
    ]);
    await waitForEagerThreadResolution(harness, 120_000);
    // Wait for linkBackfill to extract links into document_links, then
    // for /links/stats to reflect them. The endpoint does on-demand
    // compute when stale (see `readMaterializedLinkStats`), so once
    // linkBackfill has applied at least one batch a GET returns the
    // current totals — no need to wait for linkStatsRefresh.
    stats = await waitForLinkStatsPopulated(harness, 120_000);
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("linkBackfill populates document_links", () => {
    expect(stats.totalLinks).toBeGreaterThan(0);
  });

  test("byType breakdown is non-empty and structurally valid", () => {
    const types = Object.keys(stats.byType);
    expect(types.length).toBeGreaterThan(0);
    // Each value is a {total, resolved} pair; both fields must be
    // finite non-negative numbers.
    for (const t of types) {
      const v = stats.byType[t];
      expect(Number.isFinite(v.total) && v.total >= 0).toBe(true);
      expect(Number.isFinite(v.resolved) && v.resolved >= 0).toBe(true);
      expect(v.resolved).toBeLessThanOrEqual(v.total);
    }
  });

  // Resolution moved off the writer and onto the read handle, so the writer
  // must receive the targets for the deterministic same-thread pair added in
  // setup. The universe also carries intentionally orphaned thread ids, hence
  // the lower bounds instead of resolved === total for the whole type.
  test("non-url links arrive already resolved, not merely stored", () => {
    const threads = stats.byType["part-of-thread"];
    expect(threads?.total ?? 0).toBeGreaterThanOrEqual(2);
    expect(threads?.resolved ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("link_stats aggregates are consistent", () => {
    // resolved + unresolved should sum to total — invariant maintained
    // by `computeLinkStats` regardless of whether linkReconcile has
    // fired yet. Asserts the stats endpoint returns coherent numbers,
    // not that any specific link was resolved.
    expect(stats.resolvedLinks + stats.unresolvedLinks).toBe(stats.totalLinks);
    expect(Number.isFinite(stats.resolvedLinks)).toBe(true);
    expect(Number.isFinite(stats.unresolvedLinks)).toBe(true);
  });

  test("chrome-bookmarks declares `bookmarks → webpage` edges that park in pending_edges", () => {
    // e2e-minimal has chrome-bookmarks fixtures but no captured `web` page, so
    // each bookmark's declared edge to the canonical webpage entity has nowhere
    // to resolve yet and must wait in `pending_edges` — proving the full
    // provider → collector → `applyDeclaredEdges` chain holds the forward
    // reference (it resolves later when the extension captures the page).
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = db
        .prepare<
          [],
          { c: number }
        >("SELECT COUNT(*) AS c FROM pending_edges WHERE link_type = 'bookmarks' AND target_source_id = 'web'")
        .get();
      // The fixture carries three bookmarks, each declaring one edge.
      expect(rows?.c ?? 0).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("body URL mentions do not create pending web-source edges", () => {
    // Only first-class source declarations such as `bookmarks` and `visited`
    // wait for a future browser-extension capture. URLs extracted from document
    // bodies do not create a durable pending backlog.
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM pending_edges WHERE link_type = 'url' AND target_source_id = 'web'")
        .get();
      expect(row?.count ?? 0).toBe(0);
    } finally {
      db.close();
    }
  });
});

/**
 * Poll `/links/stats` until `totalLinks` is positive. The endpoint
 * does on-demand recomputation when its OCC dirty version is ahead of
 * the materialized snapshot (see `readMaterializedLinkStats`), so a
 * single GET returns the current truth as soon as linkBackfill has
 * applied at least one batch to `document_links`. linkBackfill ticks
 * every 1s and drains in batches of 5 — for the 52-doc e2e-minimal
 * corpus the first batch lands within seconds.
 *
 * The wait used to require two consecutive equal reads, on the theory
 * that the linkBackfill drain would shift the value mid-poll. In
 * practice the GET path is atomic (single read-handle transaction) so
 * "is it positive yet?" is the right invariant — the stability check
 * never matched any real flake.
 */
async function waitForLinkStatsPopulated(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<LinkStatsResp> {
  const deadline = Date.now() + timeoutMs;
  let last: LinkStatsResp | undefined;
  let stableFor = 0;
  // The first link to land says only that extraction started. Every
  // assertion below is about the pipeline's RESULT — which types it
  // produced and whether it resolved them — so the snapshot has to be
  // taken once it stops growing, not once it begins. Three consecutive
  // unchanged reads is the settle signal; the alternative, gating on the
  // property each test asserts, would make the wait and the assertion the
  // same statement and prove nothing.
  while (Date.now() < deadline) {
    const s = await harness.gatewayJson<LinkStatsResp>("/links/stats");
    const unchanged =
      last !== undefined &&
      s.totalLinks === last.totalLinks &&
      JSON.stringify(s.byType) === JSON.stringify(last.byType);
    stableFor = unchanged ? stableFor + 1 : 0;
    last = s;
    if (s.totalLinks > 0 && stableFor >= 3) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForLinkStatsPopulated: link stats never settled above zero within ${timeoutMs}ms (last: ${JSON.stringify(
      last,
    )})`,
  );
}

async function waitForEagerThreadResolution(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<void> {
  const db = new Database(harness.getDbPath(), { readonly: true });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const row = db
        .prepare<[string, string], { total: number; resolved: number }>(
          `SELECT COUNT(*) AS total,
                  COUNT(target_doc_id) AS resolved
             FROM document_links
             JOIN documents ON documents.id = document_links.source_doc_id
            WHERE documents.source_id = ?
              AND link_type = 'part-of-thread'
              AND normalized_target = ?`,
        )
        .get(EAGER_THREAD_SOURCE_ID, EAGER_THREAD_ID);
      if ((row?.total ?? 0) === 2 && row?.resolved === 2) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    db.close();
  }
  throw new Error("eager same-source thread links did not resolve within the deadline");
}
