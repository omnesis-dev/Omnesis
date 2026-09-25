// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Smoke tests for the TS wrapper around the portal-JS buildTimeline.
 * The full algorithm is exercised by the JS test file alongside the
 * impl (`packages/gateway/portal/js/lib/graph-timeline.test.ts`); here
 * we only verify:
 *   1. The wrapper hands data through (single seed, single event).
 *   2. `eventTrailFromGraph` constructs a valid `EventTrail` payload.
 *   3. The result validates against the `eventTrailSchema` from
 *      `@omnesis/core` — the boundary the future agent tool will use.
 */

import { describe, expect, it } from "vitest";
import { eventTrailSchema } from "@omnesis/core";
import { buildTimeline, eventTrailFromGraph } from "./buildTimeline.js";
import type { DocumentGraph } from "./DocumentGraphService.js";

function singleSeedGraph(): DocumentGraph {
  return {
    seeds: ["doc:a"],
    vertices: [
      {
        id: "doc:a",
        kind: "document",
        depth: 0,
        documentId: "a",
        title: "Hello",
        sourceId: "src:a",
        sourceUrl: "https://example.test/a",
        sourceCreatedAt: "2026-01-15T10:00:00Z",
      },
    ],
    edges: [],
    truncated: false,
    stats: { visited: 1, fanoutCapHits: 0, maxDepthReached: 0, elapsedMs: 7 },
  };
}

describe("buildTimeline (TS wrapper)", () => {
  it("passes the graph through to the JS impl and types the result", () => {
    const events = buildTimeline(singleSeedGraph());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("seed");
    expect(events[0]?.doc.documentId).toBe("a");
    expect(events[0]?.attachments).toEqual([]);
  });

  it("eventTrailFromGraph builds an EventTrail with seeds, events, truncated, stats", () => {
    const trail = eventTrailFromGraph(singleSeedGraph());
    expect(trail.seeds).toEqual(["doc:a"]);
    expect(trail.events).toHaveLength(1);
    expect(trail.truncated).toBe(false);
    expect(trail.stats).toMatchObject({ visited: 1, elapsedMs: 7, maxDepthReached: 0 });
  });

  it("the EventTrail payload validates against eventTrailSchema", () => {
    const trail = eventTrailFromGraph(singleSeedGraph());
    const result = eventTrailSchema.safeParse(trail);
    expect(result.success).toBe(true);
  });
});
