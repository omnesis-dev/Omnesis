// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadActiveUniverse } from "@omnesis/providers-synth-common";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { getDocumentCount, getSourceStats } from "./helpers.js";

/**
 * Smoke test for the synthetic-providers framework: bring up an isolated
 * gateway with synth providers loaded, sync every source once, and assert that
 * the full pipeline (discovery → instantiation → cursor-driven sync → gateway
 * ingest) ends in a consistent state.
 *
 * Most synth fixtures ship ~10 entries / source — with BATCH_SIZE=5, that
 * means at least two sync pages, exercising both cursor advancement and the
 * final page's `presentExternalIds` snapshot reconcile. Some sources (gmail,
 * whatsapp-messages, google-drive) have grown beyond 10 to support specific
 * demo scenarios; the assertions below derive the expected doc count from
 * the active universe's fixture files rather than hardcoding 10, so demo
 * authors can extend fixtures without breaking this suite.
 */

/**
 * Count the Documents an unstructured synth provider emits from its fixture
 * files under `<universe>/sources/<sourceType>/`: one parent Document per
 * fixture entry — in a bare entry array or in each entry array of a grouped
 * fixture — plus one child Document per attachment on that entry (the
 * providers map an attachment-bearing entry to `[parentDoc, attachmentDoc]`
 * — see each provider's fixtures.ts under packages/providers-synth and
 * packages/core/src/attachments.ts). This equals the expected gateway
 * `documentCount` after a full sync for 1:1(+attachments) sources. Sources
 * with 1:N fanout (notion-databases) or zero-Document structured sources
 * (apple-health, screen-time) are excluded from the equality check below
 * and don't use this helper.
 */
function fixtureEntryCount(sourceType: string): number {
  const universe = loadActiveUniverse();
  const dir = join(universe.dir, "sources", sourceType);
  let count = 0;
  for (const f of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf-8")) as unknown;
    for (const entries of entryArrays(data)) {
      count += entries.length; // one parent Document per fixture entry
      for (const entry of entries) {
        const atts = (entry as { attachments?: unknown[] }).attachments;
        if (Array.isArray(atts)) count += atts.length; // one child Document per attachment
      }
    }
  }
  return count;
}

/**
 * The entry arrays of one fixture file. A fixture is either a bare array of
 * entries, or an object grouping several kinds of entry alongside scalar
 * context — GitHub's `{ repo, threads[], discussions[] }`, where the repo
 * names the coordinates the entries belong to and each entry is one Document.
 * Nested arrays are entry arrays in their own right, so both shapes size the
 * same way.
 */
function entryArrays(data: unknown): unknown[][] {
  if (Array.isArray(data)) return [data];
  if (data === null || typeof data !== "object") return [];
  return Object.values(data).filter((v): v is unknown[] => Array.isArray(v));
}
describe("Synthetic providers — full pipeline", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
    await harness.start();
  }, 60000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("discovery loaded synth providers under their real sourceType names", () => {
    const ids = harness.getDescriptors().map((d) => String(d.id));
    expect(ids).toContain("gmail");
    expect(ids).toContain("google-calendar");
    expect(ids).toContain("outlook-calendar");
    expect(ids).toContain("core-location-visits");
    expect(ids).toContain("apple-notes");
    expect(ids).toContain("notion-pages");
    expect(ids).toContain("things");
    expect(ids).toContain("whatsapp-messages");
    expect(ids).toContain("strava-activities");
    expect(ids).toContain("outlook-email");
    expect(ids).toContain("apple-health");
    expect(ids).toContain("screen-time");
    expect(ids).toContain("browser-history");
    expect(ids).toContain("notion-databases");
    // Nothing should be prefixed with "demo" or "synth"
    for (const id of ids) {
      expect(id).not.toMatch(/^(demo|synth)/);
    }
  });

  test("source IDs use reserved account aliases", () => {
    const sourceIds = harness.getSourceIds();
    expect(sourceIds).toContain("gmail:john.smith@example.com");
    expect(sourceIds).toContain("outlook-email:john.smith@example.com");
    expect(sourceIds).toContain("outlook-calendar:john.smith@example.com");
    expect(sourceIds).toContain("core-location-visits:ios-synth-johnsmith");
    expect(sourceIds).toContain("apple-notes:john.smith@icloud.example");
  });

  test("every synth source completes a full bootstrap and persists its cursor", async () => {
    const sourceIds = harness.getSourceIds();
    // The complete default universe drives 31 sources concurrently, including
    // the high-volume health/history twins. Under CI contention the last
    // source can finish after 30 seconds even while making steady progress.
    await harness.syncAllSources();

    // Unstructured synth sources map each fixture entry to one Document, so
    // the expected gateway doc count equals the number of entries in the
    // source's fixture file(s). Excluded: 1:N-fanout sources (notion-databases
    // emits 1 summary doc per database + 1 doc per row) and the zero-Document
    // structured sources (apple-health, health-connect and screen-time emit
    // only DuckDB rows).
    // All shapes should still have a persisted cursor and a non-erroring sync.
    const SOURCE_TYPE_RX = /^([^:]+):/;
    const NON_ONE_TO_ONE_TYPES = new Set([
      "apple-health",
      "health-connect",
      "screen-time",
      "browser-history",
      "notion-databases",
      "strava-activities",
      // Finance structured sources emit documents only for transactions;
      // their accounts/balances/holdings fixture files feed DuckDB rows.
      // Plaid's and Coinbase's fixtures group API response pages, so their
      // arrays count pages rather than one entry per Document.
      "enable-banking-accounts",
      "lunchflow-accounts",
      "coinbase",
      "plaid",
      // A recurring calendar entry is one fixture entry and N documents: the
      // series master is a template rather than an event, and `calendarView`
      // expands it into an occurrence apiece. `outlook-calendar.e2e.test.ts`
      // pins the exact counts, including which of the two is the document.
      "outlook-calendar",
    ]);
    for (const id of sourceIds) {
      const type = id.match(SOURCE_TYPE_RX)?.[1] ?? id;
      const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, id);
      if (NON_ONE_TO_ONE_TYPES.has(type)) {
        expect(count, `${id}: doc count should be ≥ 0`).toBeGreaterThanOrEqual(0);
      } else {
        const expected = fixtureEntryCount(type);
        expect(count, `${id} should have ${expected} documents (the fixture entry count)`).toBe(
          expected,
        );
      }
      const state = await harness.getSyncState(id);
      expect(state, `${id} should have a persisted cursor`).not.toBeNull();
    }

    const watermarks = await harness.gatewayJson<{
      items: Array<{ sourceId: string; streamId: string; guarantee: string; generation: number }>;
    }>("/admin/watermarks");
    const bySource = new Map(watermarks.items.map((row) => [row.sourceId, row]));
    for (const id of sourceIds) {
      const watermark = bySource.get(id);
      expect(watermark, `${id} should advertise a V1 source watermark`).toBeDefined();
      expect(watermark?.streamId).toBe("default");
      expect(watermark?.guarantee).toBe("observation");
      expect(watermark?.generation).toBeGreaterThan(0);
    }

    const oneSource = sourceIds[0]!;
    const filtered = await harness.gatewayJson<{
      items: Array<{ sourceId: string; streamId: string }>;
    }>(`/admin/watermarks?sourceId=${encodeURIComponent(oneSource)}`);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({ sourceId: oneSource, streamId: "default" });
  }, 180000);

  test("re-triggering sync is idempotent — no duplicate documents", async () => {
    const sample = "gmail:john.smith@example.com";
    const before = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sample);
    await harness.triggerSyncAndWait(sample, 30000);
    const after = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sample);
    expect(after).toBe(before);
  }, 60000);

  test("source stats reflect the fixture content", async () => {
    const stats = await getSourceStats(
      harness.gatewayUrl,
      harness.apiKey,
      "gmail:john.smith@example.com",
    );
    expect(stats.documentCount).toBe(fixtureEntryCount("gmail"));
    expect(stats.dataSizeBytes).toBeGreaterThan(0);
    expect(stats.earliestSourceDate).not.toBeNull();
    expect(stats.latestSourceDate).not.toBeNull();
  });
});
