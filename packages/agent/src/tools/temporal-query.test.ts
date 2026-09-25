// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { ACCEPTED_TEMPORAL_KINDS, hostTimeZone } from "@omnesis/core";
import { zodToJsonSchema } from "../zod-to-json-schema.js";
import { createTemporalQueryTool, TEMPORAL_QUERY_MAX_LIMIT } from "./temporal.js";
import type { TemporalReadPort } from "./types.js";
import type { TemporalQueryInput, TemporalQueryResult } from "@omnesis/core";

const ctx = { sessionId: "S", messageId: "M" };

const EMPTY_RESULT: TemporalQueryResult = {
  type: "temporal.results",
  window: {
    start: "2026-07-23T00:00:00.000Z",
    endExclusive: "2026-07-24T00:00:00.000Z",
    timeZone: "UTC",
  },
  summary: { anchored: 0, spanning: 0 },
  items: [],
  coverage: { projectionSources: [], specialistSources: [], annotations: { selective: true } },
  truncated: false,
};

/** A read port that records the exact validated query it was handed. */
function recordingPort(): {
  port: TemporalReadPort;
  seenInput: () => TemporalQueryInput | undefined;
} {
  let seen: TemporalQueryInput | undefined;
  return {
    seenInput: () => seen,
    port: {
      async query(input): Promise<TemporalQueryResult> {
        seen = input;
        return EMPTY_RESULT;
      },
    },
  };
}

describe("temporal_query contract", () => {
  it("delegates the exact temporal query to the gateway port", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const input: TemporalQueryInput = {
      from: "2026-07-23",
      to: "+1d",
      timeZone: "Europe/London",
      origins: ["projection", "annotation"],
      kinds: ["visit", "appointment"],
      modalities: ["observed", "scheduled"],
      statuses: ["active", "completed"],
      sourceIds: ["calendar:example"],
      documentIds: ["doc_example"],
      entityIds: ["person_example"],
      limit: 100,
      cursor: "opaque",
    };
    const result = await tool.invoke(input, ctx);

    expect(result.kind).toBe("structured");
    expect(seenInput()).toEqual(input);
    if (result.kind === "structured") {
      expect(result.resultType).toBe("temporal.results");
      expect(result.data).toEqual(EMPTY_RESULT);
    }
  });

  it("accepts a retired kind spelling and hands the port the canonical one", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const result = await tool.invoke(
      { from: "2026-07-23", timeZone: "UTC", kinds: ["calendar_event", "episodic"] },
      ctx,
    );

    expect(result.kind).toBe("structured");
    expect(seenInput()?.kinds).toEqual(["appointment", "episode"]);
  });

  it("rejects a kind outside the vocabulary", async () => {
    const { port } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const result = await tool.invoke({ from: "now", timeZone: "UTC", kinds: ["meeting"] }, ctx);

    expect(result.kind).toBe("error");
  });

  it("advertises the whole accepted kind vocabulary to the model", () => {
    const { port } = recordingPort();
    const tool = createTemporalQueryTool({ port });
    const js = zodToJsonSchema(tool.schema) as {
      properties?: { kinds?: { items?: { enum?: string[] } } };
    };

    expect(js.properties?.kinds?.items?.enum).toEqual([...ACCEPTED_TEMPORAL_KINDS]);
  });

  it("rejects limits outside the exact 1-100 contract", async () => {
    const { port } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const base = { from: "now", timeZone: "UTC" };
    expect((await tool.invoke({ ...base, limit: 0 }, ctx)).kind).toBe("error");
    expect((await tool.invoke({ ...base, limit: 1.5 }, ctx)).kind).toBe("error");
    expect((await tool.invoke({ ...base, limit: TEMPORAL_QUERY_MAX_LIMIT + 1 }, ctx)).kind).toBe(
      "error",
    );
  });

  it("advertises from/timeZone and limit as optional, with an integer limit", () => {
    const { port } = recordingPort();
    const tool = createTemporalQueryTool({ port });
    const js = zodToJsonSchema(tool.schema) as {
      properties?: { limit?: { type?: string } };
      required?: string[];
    };

    expect(js.properties?.limit?.type).toBe("integer");
    expect(js.required ?? []).not.toContain("from");
    expect(js.required ?? []).not.toContain("timeZone");
    expect(js.required ?? []).not.toContain("limit");
  });

  it("defaults an omitted range to now in a zone the runtime can resolve", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    expect((await tool.invoke({}, ctx)).kind).toBe("structured");
    expect(seenInput()).toMatchObject({ from: "now" });
    expect(() => {
      new Intl.DateTimeFormat("en", { timeZone: seenInput()?.timeZone });
    }).not.toThrow();
  });

  // "What's on today" has to mean the caller's today. Framing the window in
  // the host's zone answers about a different day for anyone far enough east
  // or west of the machine holding the corpus.
  it("frames an unqualified window in the caller's zone, not the host's", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const result = await tool.invoke({ from: "2026-08-02" }, { ...ctx, timeZone: "Asia/Tokyo" });

    expect(result.kind).toBe("structured");
    expect(seenInput()?.timeZone).toBe("Asia/Tokyo");
  });

  it("lets an explicit argument override the caller's zone, for a question about elsewhere", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    const result = await tool.invoke(
      { from: "2026-08-02", timeZone: "Europe/London" },
      { ...ctx, timeZone: "Asia/Tokyo" },
    );

    expect(result.kind).toBe("structured");
    expect(seenInput()?.timeZone).toBe("Europe/London");
  });

  it("falls back to the host's zone when the session carries none", async () => {
    const { port, seenInput } = recordingPort();
    const tool = createTemporalQueryTool({ port });

    expect((await tool.invoke({ from: "2026-08-02" }, ctx)).kind).toBe("structured");
    expect(seenInput()?.timeZone).toBe(hostTimeZone());
  });
});
