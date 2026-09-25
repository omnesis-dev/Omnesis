// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Near-duplicate document-frequency rebuild, end to end on a real gateway.
 *
 * The DF table is one number per distinct 5-word shingle in the corpus — how
 * many documents contain it — and near-duplicate detection weighs a rare
 * phrase above a common one with it. It is rebuilt whole rather than
 * maintained incrementally, and the rebuild is the heaviest periodic job the
 * gateway runs: it reads every eligible document, shingles it on the CPU
 * pool, accumulates the counts into a staging SQLite file beside the
 * database, and the writer then moves the surviving rows into `near_dup_df`
 * in chunks.
 *
 * Unit tests cover each of those stages against fixtures. What only a real
 * gateway can show is the stages composing: the compute pass writing a
 * staging file the writer can actually open, the build landing as a complete
 * table with its metadata, a second build over the same corpus producing the
 * same answer rather than accumulating on top of the first, and the staging
 * file not surviving the build that made it.
 *
 * Why `e2e-minimal`: the assertions are about the pipeline, not about corpus
 * scale, and this universe is what the other coverage E2Es in this directory
 * boot. A larger universe would cost minutes of wall clock to say the same
 * thing.
 */

import "./synth-env.js";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { nearDupRebuildOnAnyFile, SyntheticE2EHarness } from "./synth-harness.js";

/** Long enough that automatic compute never races the hand-driven ticks. */
const PARKED_PERIOD_MS = 999_999_999;

/** Shortest content the DF scan will read. The production default. */
const MIN_CONTENT_LENGTH = 200;

/**
 * Block until the wall clock has moved past the second `builtAtSec` names.
 * The DF trigger measures age in whole seconds against `near_dup_df_meta`,
 * so a table stamped in the current second is zero seconds old whatever the
 * configured threshold is.
 */
async function waitPastSecond(builtAtSec: number): Promise<void> {
  const target = (builtAtSec + 1) * 1000 + 50;
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

describe("Near-duplicate DF rebuild (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      extraGatewayConfig: {
        nearDuplicates: {
          // Pinned rather than inherited: the rebuild trigger below is a
          // document deliberately shorter than this bound.
          minContentLength: MIN_CONTENT_LENGTH,
          scheduler: {
            computePeriodMs: PARKED_PERIOD_MS,
            computeIdlePeriodMs: PARKED_PERIOD_MS,
            ...nearDupRebuildOnAnyFile(),
          },
        },
      },
    });
    await harness.start();
    await harness.syncAllSources();
    const drained = await harness.stopSyncLoopsAndDrain(60_000);
    expect(drained.timedOut, `collector did not drain (${drained.inflight} in flight)`).toBe(false);
    await harness.convergeNearDuplicates(180_000);
  }, 300_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  /**
   * What a reader sees: the live generation's rows. A rebuild writes the
   * next generation alongside this one and leaves the superseded rows for
   * the sweep, so reading the table without the generation would return
   * two builds at once.
   */
  async function readDf(): Promise<Record<string, number>> {
    const { rows } = await harness.gatewayJson<{ rows: Array<[string, number]> }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT shingle, df FROM near_dup_df
               WHERE algo_version = (SELECT algo_version FROM near_dup_df_meta LIMIT 1)
                 AND generation = (SELECT live_generation FROM near_dup_df_meta LIMIT 1)
               ORDER BY shingle`,
      }),
    });
    return Object.fromEntries(rows);
  }

  /** The generation the meta row publishes to readers. */
  async function readLiveGeneration(): Promise<number> {
    const { rows } = await harness.gatewayJson<{ rows: Array<[number]> }>("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT live_generation FROM near_dup_df_meta LIMIT 1" }),
    });
    return rows[0]?.[0] ?? -1;
  }

  /** When the active algo's DF table was last stamped complete, in unix seconds. */
  async function readBuiltAt(): Promise<number | null> {
    const { rows } = await harness.gatewayJson<{ rows: Array<[number | null]> }>("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT built_at FROM near_dup_df_meta LIMIT 1" }),
    });
    return rows[0]?.[0] ?? null;
  }

  test("the build lands as a complete table with its metadata", async () => {
    const df = await readDf();
    const shingles = Object.keys(df);
    expect(shingles.length, "the DF table is empty after a converged build").toBeGreaterThan(0);
    // Every persisted row is a shingle at least two documents share; a df of
    // 1 carries no information for weighting and is pruned during the build.
    for (const [shingle, count] of Object.entries(df)) {
      expect(count, `${shingle} was persisted with df ${count}`).toBeGreaterThanOrEqual(2);
    }

    const { rows } = await harness.gatewayJson<{
      rows: Array<[number | null, number, number]>;
    }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT built_at, total_docs, unique_shingles FROM near_dup_df_meta LIMIT 1",
      }),
    });
    const [builtAt, totalDocs, uniqueShingles] = rows[0];
    // `built_at` is what the compute drip parks on: until it is stamped, no
    // document is signed at all.
    expect(builtAt).not.toBeNull();
    expect(totalDocs).toBeGreaterThan(0);
    expect(uniqueShingles).toBe(shingles.length);
  });

  test("a second build over the same corpus produces the same table", async () => {
    // Determinism is the property. The failure it catches is a staging file
    // that survives one build and is picked up by the next — the scratch
    // database is written assuming it starts empty, so a build that inherits
    // one either counts the previous corpus a second time or does not
    // complete at all. Both show up here.
    const before = await readDf();
    const builtAtBefore = await readBuiltAt();
    expect(builtAtBefore).not.toBeNull();
    // `built_at` is whole seconds, so a table built during THIS second reads
    // as zero seconds old and no age floor can make it due. Wait for the
    // clock to leave that second — a condition that always arrives, not a
    // guess at how long the gateway takes.
    await waitPastSecond(builtAtBefore!);

    // Ask for the rebuild the way production does: a file-like document
    // arrives. This one is deliberately shorter than `minContentLength`, so
    // it counts as an arrival but contributes no shingles — the corpus the
    // second build measures is the same corpus the first one did, which is
    // what makes the comparison below a comparison of two builds rather
    // than of two different inputs.
    await harness.pushDocuments([
      {
        externalId: "e2e-df-trigger",
        documentType: "file",
        title: "Rebuild trigger",
        content: "Too short to shingle.",
      },
    ]);

    const { result } = await harness.gatewayJson<{ result: { idle?: boolean } }>(
      "/admin/background/run/backfill.nearDupDfRefresh?timeoutMs=180000",
      { method: "POST" },
    );
    // Without this the comparison below could pass having compared one build
    // with itself. A tick reports `idle` both when it declines to rebuild and
    // when the rebuild threw — `runBackfillTick` turns a failure into an idle
    // result and a journal line — so this covers both.
    expect(result.idle, "the second tick completed no rebuild").toBe(false);
    const builtAtAfter = await readBuiltAt();
    expect(builtAtAfter).not.toBeNull();
    expect(builtAtAfter).toBeGreaterThanOrEqual(builtAtBefore ?? 0);

    const after = await readDf();
    expect(after).toEqual(before);
  }, 240_000);

  test("the second build publishes a new generation rather than clearing the old", async () => {
    // The rebuild's cost on the writer is one pointer move, whatever the
    // table's size. What proves it happened is that the generation
    // advanced and readers followed it — on a real gateway, through its own
    // scheduler and writer, not a direct call.
    const generation = await readLiveGeneration();
    expect(generation).toBeGreaterThan(0);

    const { rows } = await harness.gatewayJson<{ rows: Array<[number, number]> }>("/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT generation, COUNT(*) FROM near_dup_df
               WHERE algo_version = (SELECT algo_version FROM near_dup_df_meta LIMIT 1)
               GROUP BY generation ORDER BY generation`,
      }),
    });
    // A generation above the live one is legitimate — a build in flight, or
    // the remains of one that died, which a later build publishes past and
    // the sweep then reclaims. What must hold is that the published one is
    // whole, which is what the rest of this file checks.
    const live = rows.find(([gen]) => gen === generation);
    expect(live, "the published generation holds no rows at all").toBeDefined();
    expect(live?.[1], "the live generation holds no rows").toBeGreaterThan(0);
  }, 120_000);

  test("the staging file does not outlive the build that wrote it", async () => {
    // It is a scratch copy of the corpus's shingles sitting beside the
    // database. Leaving it behind costs disk in proportion to the corpus and
    // keeps derived corpus content on disk with nothing scheduled to remove
    // it.
    const dbDir = dirname(harness.getDbPath());
    const leftovers = readdirSync(dbDir).filter((entry) => entry.startsWith("near-dup-df-staging"));
    expect(leftovers, `staging files left in ${dbDir}`).toEqual([]);
    expect(existsSync(`${dbDir}/near-dup-df-staging.sqlite`)).toBe(false);
  });
});
