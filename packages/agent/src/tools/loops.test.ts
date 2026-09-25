// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createSearchLoopsTool, createFetchLoopTool, createListLoopsTool } from "./loops.js";
import type {
  LoopListPortResult,
  LoopReadPort,
  LoopSearchPortInput,
  LoopSearchPortResult,
} from "./types.js";
import type { LoopDetail } from "@omnesis/core";

const ctx = { sessionId: "s", messageId: "m" };

function makePort(over: Partial<LoopReadPort> = {}): LoopReadPort {
  return {
    async search(input: LoopSearchPortInput): Promise<LoopSearchPortResult> {
      return {
        query: input.query,
        durationMs: 5,
        loops: [
          { loopId: "olp_1", title: "Chase the deposit refund", state: "open", importance: 0.7 },
        ],
      };
    },
    async fetch(loopId: string): Promise<LoopDetail | null> {
      if (loopId !== "olp_1") return null;
      return {
        loopId,
        title: "Chase the deposit refund",
        state: "open",
        importance: 0.7,
        actors: ["Maya Reeves"],
        docIds: ["doc_a"],
        ledger: [{ at: 1, note: "created from the email" }],
      };
    },
    async list(): Promise<LoopListPortResult> {
      return {
        durationMs: 3,
        truncated: false,
        loops: [
          { loopId: "olp_1", title: "Chase the deposit refund", state: "open", importance: 0.7 },
          { loopId: "olp_2", title: "Book the venue", state: "snoozed", importance: 0.5 },
        ],
      };
    },
    ...over,
  };
}

describe("search_loops", () => {
  it("returns a loops.searched result and declares no mutation", async () => {
    const tool = createSearchLoopsTool({ port: makePort() });
    expect(tool.name).toBe("search_loops");
    expect(tool.mutates).toBeUndefined();
    const res = await tool.invoke({ query: "deposit" }, ctx);
    expect(res.kind).toBe("loops.searched");
    if (res.kind === "loops.searched") {
      expect(res.query).toBe("deposit");
      expect(res.loops.map((l) => l.loopId)).toEqual(["olp_1"]);
    }
  });

  it("rejects a blank query", async () => {
    const res = await createSearchLoopsTool({ port: makePort() }).invoke({ query: "   " }, ctx);
    expect(res.kind).toBe("error");
  });

  it("maps a port failure to a clean error result", async () => {
    const port = makePort({
      async search() {
        throw new Error("boom");
      },
    });
    const res = await createSearchLoopsTool({ port }).invoke({ query: "x" }, ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("search_loops_failed");
  });
});

describe("fetch_loop", () => {
  it("returns loop.fetched with the loop when found (read-only)", async () => {
    const tool = createFetchLoopTool({ port: makePort() });
    expect(tool.mutates).toBeUndefined();
    const res = await tool.invoke({ loopId: "olp_1" }, ctx);
    expect(res.kind).toBe("loop.fetched");
    if (res.kind === "loop.fetched") {
      expect(res.loop?.title).toBe("Chase the deposit refund");
      expect(res.loop?.actors).toEqual(["Maya Reeves"]);
    }
  });

  it("returns loop.fetched with no loop for a miss (clean no-match, not an error)", async () => {
    const res = await createFetchLoopTool({ port: makePort() }).invoke({ loopId: "nope" }, ctx);
    expect(res.kind).toBe("loop.fetched");
    if (res.kind === "loop.fetched") expect(res.loop).toBeUndefined();
  });
});

describe("list_loops", () => {
  it("is read-only and returns the complete active set as a structured result", async () => {
    const tool = createListLoopsTool({ port: makePort() });
    expect(tool.name).toBe("list_loops");
    expect(tool.mutates).toBeUndefined();
    const res = await tool.invoke({}, ctx);
    expect(res.kind).toBe("structured");
    if (res.kind === "structured") {
      expect(res.resultType).toBe("loops.listed");
      const data = res.data as {
        count: number;
        truncated: boolean;
        loops: Array<{ loopId: string }>;
      };
      expect(data.count).toBe(2);
      expect(data.truncated).toBe(false);
      expect(data.loops.map((l) => l.loopId)).toEqual(["olp_1", "olp_2"]);
    }
  });

  it("passes the limit through and surfaces truncation", async () => {
    let seenLimit: number | undefined;
    const port = makePort({
      async list(limit): Promise<LoopListPortResult> {
        seenLimit = limit;
        return { durationMs: 1, truncated: true, loops: [] };
      },
    });
    const res = await createListLoopsTool({ port }).invoke({ limit: 5 }, ctx);
    expect(seenLimit).toBe(5);
    if (res.kind === "structured")
      expect((res.data as { truncated: boolean }).truncated).toBe(true);
  });

  it("accepts the max limit (100) but rejects above it — schema matches the advertised ceiling", async () => {
    const ok = await createListLoopsTool({ port: makePort() }).invoke({ limit: 100 }, ctx);
    expect(ok.kind).toBe("structured");
    const tooBig = await createListLoopsTool({ port: makePort() }).invoke({ limit: 101 }, ctx);
    expect(tooBig.kind).toBe("error");
  });

  it("forwards the default limit (30) to the port when none is given", async () => {
    let seenLimit: number | undefined = -1;
    const port = makePort({
      async list(limit): Promise<LoopListPortResult> {
        seenLimit = limit;
        return { durationMs: 1, truncated: false, loops: [] };
      },
    });
    await createListLoopsTool({ port }).invoke({}, ctx);
    expect(seenLimit).toBe(30);
  });

  it("returns a clean empty result (count 0) when nothing is tracked", async () => {
    const port = makePort({
      async list(): Promise<LoopListPortResult> {
        return { durationMs: 1, truncated: false, loops: [] };
      },
    });
    const res = await createListLoopsTool({ port }).invoke({}, ctx);
    expect(res.kind).toBe("structured");
    if (res.kind === "structured") expect((res.data as { count: number }).count).toBe(0);
  });

  it("maps a port throw to a tool error", async () => {
    const port = makePort({
      async list() {
        throw new Error("boom");
      },
    });
    const res = await createListLoopsTool({ port }).invoke({}, ctx);
    expect(res).toMatchObject({ kind: "error", code: "list_loops_failed" });
  });
});
