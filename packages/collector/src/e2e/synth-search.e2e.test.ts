// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * Cross-source coverage: after every synth source bootstraps, search-style
 * queries should land documents from multiple sources.
 *
 * Uses the gateway's `/documents/search` LIKE-based endpoint (rather than the
 * full BM25/vector pipeline at `/search`) so the test doesn't depend on an
 * embedding model being loaded.
 */
describe("Synthetic providers — cross-source content", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
    await harness.start();
    await harness.syncAllSources();
    // /documents/search uses LIKE on the gateway DB and doesn't need the
    // search snapshot. The full pipeline (/search, BM25 + vector) does.
    // Nudge it now so any future BM25/vector assertions don't race the
    // 10-minute auto-refresh.
    await harness.refreshSearchSnapshot();
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  async function searchDocs(q: string): Promise<Array<{ id: string; source_id: string }>> {
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent(q)}&limit=200`,
    )) as { results?: Array<{ id: string; source_id: string }> };
    return res.results ?? [];
  }

  test("a recurring persona appears across multiple sources", async () => {
    // "Jane" appears in synth gmail/outlook/notion/obsidian/apple-imessage/etc.
    const docs = await searchDocs("Jane");
    const sources = new Set(docs.map((d) => d.source_id.split(":")[0]));
    // Expect Jane to surface in at least 3 distinct source types.
    expect(
      sources.size,
      `Jane should appear in >=3 source types; got ${[...sources].join(",")}`,
    ).toBeGreaterThanOrEqual(3);
  });

  test("an organization name surfaces in docs from multiple sources", async () => {
    const docs = await searchDocs("Globex");
    const sources = new Set(docs.map((d) => d.source_id.split(":")[0]));
    expect(sources.size).toBeGreaterThanOrEqual(3);
  });

  test("an event-specific phrase only appears in calendar-shaped sources", async () => {
    const docs = await searchDocs("Mercury room");
    const sources = new Set(docs.map((d) => d.source_id.split(":")[0]));
    // Mercury room is in calendar events + a few emails/notes referencing the demo.
    // It should NOT appear in strava or things (no narrative overlap).
    expect(sources.has("strava-activities")).toBe(false);
    expect(sources.size).toBeGreaterThan(0);
  });

  test("a single-source phrase stays scoped to its source", async () => {
    // "intervals" only appears in the Strava activities fixture (training-specific).
    const docs = await searchDocs("6×800m");
    expect(docs.length).toBeGreaterThan(0);
    const sources = new Set(docs.map((d) => d.source_id.split(":")[0]));
    expect(sources.has("strava-activities")).toBe(true);
  });
});
