// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed entry point for the timeline builder. The implementation lives
 * in plain JS at `packages/gateway/portal/js/lib/graph-timeline.js` so
 * the browser can load it as-is (the portal has no TS build step); this
 * module is a thin TS wrapper that adds the `TrailEvent` / `EventTrail`
 * shape from `@omnesis/core` for gateway-side consumers.
 *
 * The future `trace_connections` agent tool will:
 *   1. Call `buildDocumentGraph(db, seedIds, opts)` to get the raw
 *      multi-edge subgraph.
 *   2. Hand that graph to `buildTimeline(graph)` here.
 *   3. Wrap the result in an `EventTrail` payload and return it as the
 *      `event_trail.built` tool result.
 *
 * Keeping one canonical implementation (the JS file) means the portal's
 * `/portal/graph` page and the agent tool produce byte-identical
 * timelines — no drift between two parallel codepaths.
 */

// The portal's plain-JS implementation. Vitest + Node ESM happily
// import .js across the package — no .d.ts ships, so we silence the
// implicit-any here and cast the untyped export through `as` once.
// @ts-expect-error — portal JS, no declarations ship alongside.
import * as graphTimelineImpl from "../../portal/js/lib/graph-timeline.js";
import type { DocumentGraph } from "./DocumentGraphService.js";
import type { EventTrail, TrailEvent } from "@omnesis/core";

type BuildTimelineFn = (graph: DocumentGraph) => TrailEvent[];

const buildTimelineImpl = (graphTimelineImpl as { buildTimeline: BuildTimelineFn }).buildTimeline;

/**
 * Chronologically-ordered timeline events for a document graph. Top-
 * level array has one entry per non-attachment document; attachments
 * nest inside their parent's `attachments[]`. See `TrailEvent` in
 * `@omnesis/core` for the full shape.
 */
export function buildTimeline(graph: DocumentGraph): TrailEvent[] {
  return buildTimelineImpl(graph);
}

/**
 * Convenience helper that wraps `buildTimeline()` into the full
 * `EventTrail` payload the agent tool will emit on the wire. Pulls the
 * `seeds[]` and `stats` straight off the graph.
 */
export function eventTrailFromGraph(graph: DocumentGraph): EventTrail {
  return {
    seeds: graph.seeds,
    events: buildTimeline(graph),
    truncated: graph.truncated,
    stats: {
      visited: graph.stats.visited,
      elapsedMs: graph.stats.elapsedMs,
      maxDepthReached: graph.stats.maxDepthReached,
    },
  };
}

export type { EventTrail, TrailEvent } from "@omnesis/core";
