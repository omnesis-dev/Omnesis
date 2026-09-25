// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createEntityContextTool } from "./entity-context.js";
import type { EntityContextPort, EntityContextResult, EntityContextSeed } from "./types.js";
import type { ToolContext } from "../backend.js";

const ctx: ToolContext = { abortSignal: new AbortController().signal } as ToolContext;

function portReturning(
  result: EntityContextResult,
  spy?: (s: EntityContextSeed, o?: { depth?: number }) => void,
): EntityContextPort {
  return {
    reap: async (seed, opts) => {
      spy?.(seed, opts);
      return result;
    },
  };
}
const EMPTY: EntityContextResult = {
  seed: null,
  loops: [],
  documents: [],
  people: [],
  temporalAnnotations: [],
  truncated: false,
  counts: { loops: 0, documents: 0, people: 0, temporalAnnotations: 0 },
};

describe("entity_context tool", () => {
  it("is read-only (no mutates flag) and named entity_context", () => {
    const tool = createEntityContextTool({ port: portReturning(EMPTY) });
    expect(tool.name).toBe("entity_context");
    expect(tool.mutates).toBeUndefined();
  });

  it("dispatches the parsed seed + depth to the port and wraps the result as structured", async () => {
    const spy = vi.fn();
    const result: EntityContextResult = {
      ...EMPTY,
      seed: { kind: "loop", id: "loop_1", label: "Chase refund" },
      loops: [{ loopId: "loop_2", title: "Related", state: "open" }],
      counts: { loops: 1, documents: 0, people: 0, temporalAnnotations: 0 },
    };
    const tool = createEntityContextTool({ port: portReturning(result, spy) });
    const out = await tool.invoke({ kind: "loop", id: "loop_1", depth: 2 }, ctx);
    expect(spy).toHaveBeenCalledWith({ kind: "loop", id: "loop_1" }, { depth: 2 });
    expect(out).toMatchObject({
      kind: "structured",
      resultType: "entity_context.reaped",
      data: result,
    });
  });

  it("rejects an unknown seed kind at the schema boundary", async () => {
    const tool = createEntityContextTool({ port: portReturning(EMPTY) });
    const out = await tool.invoke({ kind: "brief", id: "x" }, ctx);
    expect(out.kind).toBe("error");
  });

  it("rejects a missing id", async () => {
    const tool = createEntityContextTool({ port: portReturning(EMPTY) });
    const out = await tool.invoke({ kind: "person" }, ctx);
    expect(out.kind).toBe("error");
  });

  it("rejects an out-of-range depth", async () => {
    const tool = createEntityContextTool({ port: portReturning(EMPTY) });
    const out = await tool.invoke({ kind: "person", id: "p1", depth: 9 }, ctx);
    expect(out.kind).toBe("error");
  });

  it("maps a port throw to a tool error rather than propagating", async () => {
    const tool = createEntityContextTool({
      port: {
        reap: async () => {
          throw new Error("boom");
        },
      },
    });
    const out = await tool.invoke({ kind: "document", id: "d1" }, ctx);
    expect(out).toMatchObject({ kind: "error", code: "entity_context_failed" });
  });
});
