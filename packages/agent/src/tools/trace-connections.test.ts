// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createTraceConnectionsTool } from "./trace-connections.js";
import type { EventTrail } from "@omnesis/core";
import type { TrailPort } from "./types.js";

const ctx = { sessionId: "S", messageId: "M" };

function makeTrail(seedIds: string[]): EventTrail {
  return {
    seeds: seedIds.map((id) => `doc:${id}`),
    events: seedIds.map((id) => ({
      eventId: `event:${id}`,
      at: "2026-03-12T09:14:00Z",
      kind: "seed" as const,
      doc: {
        documentId: id,
        title: `Doc ${id}`,
        sourceId: "gmail:user@example.com",
      },
      attachments: [],
      people: [],
      related: [],
    })),
    truncated: false,
    stats: { visited: seedIds.length, elapsedMs: 12, maxDepthReached: 0 },
  };
}

describe("trace_connections tool", () => {
  it("is named trace_connections", () => {
    const tool = createTraceConnectionsTool({ port: { build: async () => makeTrail([]) } });
    expect(tool.name).toBe("trace_connections");
  });

  it("returns an event_trail.built result (legacy wire kind) built from the port", async () => {
    const port: TrailPort = {
      async build(seedIds, opts) {
        expect([...seedIds]).toEqual(["d1"]);
        expect(opts?.depth).toBe(3);
        expect(opts?.fanoutCap).toBe(10);
        return makeTrail(["d1"]);
      },
    };
    const tool = createTraceConnectionsTool({ port });
    const r = await tool.invoke({ seedIds: ["d1"], depth: 3, fanoutCap: 10 }, ctx);
    expect(r.kind).toBe("event_trail.built");
    if (r.kind === "event_trail.built") {
      expect(r.seeds).toEqual(["doc:d1"]);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?.kind).toBe("seed");
    }
  });

  it("passes through multi-seed input order", async () => {
    const port: TrailPort = {
      async build(seedIds) {
        return makeTrail([...seedIds]);
      },
    };
    const tool = createTraceConnectionsTool({ port });
    const r = await tool.invoke({ seedIds: ["d1", "d2", "d3"] }, ctx);
    expect(r.kind).toBe("event_trail.built");
    if (r.kind === "event_trail.built") {
      expect(r.seeds).toEqual(["doc:d1", "doc:d2", "doc:d3"]);
    }
  });

  it("rejects an empty seedIds array", async () => {
    const tool = createTraceConnectionsTool({
      port: { build: async () => makeTrail([]) },
    });
    const r = await tool.invoke({ seedIds: [] }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("rejects more than 5 seeds", async () => {
    const tool = createTraceConnectionsTool({
      port: { build: async () => makeTrail([]) },
    });
    const r = await tool.invoke({ seedIds: ["a", "b", "c", "d", "e", "f"] }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("invalid_args");
  });

  it("returns seed_not_found when the port reports a missing seed", async () => {
    const tool = createTraceConnectionsTool({
      port: {
        build: async () => {
          throw new Error("seed not found: bogus");
        },
      },
    });
    const r = await tool.invoke({ seedIds: ["bogus"] }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("seed_not_found");
  });

  it("returns trail_walk_failed for generic port errors", async () => {
    const tool = createTraceConnectionsTool({
      port: {
        build: async () => {
          throw new Error("boom");
        },
      },
    });
    const r = await tool.invoke({ seedIds: ["d1"] }, ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("trail_walk_failed");
  });
});
