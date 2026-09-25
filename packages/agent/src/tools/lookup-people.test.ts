// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createLookupPeopleTool } from "./lookup-people.js";
import type { PersonPort, PersonPortInput, PersonPortResult } from "./types.js";

const ctx = { sessionId: "s", messageId: "m" };

function makePort(over: Partial<PersonPort> = {}): PersonPort {
  return {
    async lookup(input: PersonPortInput): Promise<PersonPortResult> {
      return {
        query: input.query,
        durationMs: 12,
        results: [
          {
            canonicalId: "p_maria_work",
            displayName: "Maria Smith",
            aliases: ["maria.smith@acme.com", "+15550133"],
            emailCount: 12,
            chatCount: 3,
            lastInteraction: 1_726_345_600_000,
            interactionScore: 0.82,
          },
          {
            canonicalId: "p_maria_personal",
            displayName: "Maria Smith",
            aliases: ["maria@smith.family"],
            emailCount: 4,
            lastInteraction: 1_710_000_000_000,
            interactionScore: 0.21,
          },
        ],
      };
    },
    ...over,
  };
}

describe("createLookupPeopleTool", () => {
  it("returns a person.results tool result preserving order and all candidates", async () => {
    const tool = createLookupPeopleTool({ port: makePort() });
    const out = await tool.invoke({ query: "Maria Smith" }, ctx);
    expect(out.kind).toBe("person.results");
    if (out.kind === "person.results") {
      expect(out.query).toBe("Maria Smith");
      expect(out.durationMs).toBe(12);
      expect(out.results).toHaveLength(2);
      expect(out.results[0]?.canonicalId).toBe("p_maria_work");
      expect(out.results[1]?.canonicalId).toBe("p_maria_personal");
    }
  });

  it("rejects empty query with an invalid_args error", async () => {
    const tool = createLookupPeopleTool({ port: makePort() });
    const out = await tool.invoke({ query: "" }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("invalid_args");
  });

  it("rejects whitespace-only query with an invalid_args error", async () => {
    const tool = createLookupPeopleTool({ port: makePort() });
    const out = await tool.invoke({ query: "   \t  " }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("invalid_args");
  });

  it("rejects limit > LOOKUP_PEOPLE_MAX_LIMIT with an invalid_args error", async () => {
    const tool = createLookupPeopleTool({ port: makePort() });
    const out = await tool.invoke({ query: "x", limit: 50 }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("invalid_args");
  });

  it("surfaces port failures as lookup_failed errors", async () => {
    const tool = createLookupPeopleTool({
      port: {
        async lookup() {
          throw new Error("boom");
        },
      },
    });
    const out = await tool.invoke({ query: "x" }, ctx);
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("lookup_failed");
      expect(out.message).toBe("boom");
    }
  });

  it("passes the explicit limit arg through to the port verbatim", async () => {
    let received: PersonPortInput | undefined;
    const tool = createLookupPeopleTool({
      port: {
        async lookup(input) {
          received = input;
          return { query: input.query, durationMs: 0, results: [] };
        },
      },
    });
    await tool.invoke({ query: "alex", limit: 8 }, ctx);
    expect(received).toEqual({ query: "alex", limit: 8 });
  });

  it("trims surrounding whitespace from the query before invoking the port", async () => {
    let received: PersonPortInput | undefined;
    const tool = createLookupPeopleTool({
      port: {
        async lookup(input) {
          received = input;
          return { query: input.query, durationMs: 0, results: [] };
        },
      },
    });
    await tool.invoke({ query: "  Maria Smith  " }, ctx);
    expect(received?.query).toBe("Maria Smith");
  });

  it("applies the configured defaultLimit when no limit is passed", async () => {
    let received: PersonPortInput | undefined;
    const tool = createLookupPeopleTool({
      defaultLimit: 7,
      port: {
        async lookup(input) {
          received = input;
          return { query: input.query, durationMs: 0, results: [] };
        },
      },
    });
    await tool.invoke({ query: "alex" }, ctx);
    expect(received?.limit).toBe(7);
  });

  it("accepts empty results as a successful (not error) call", async () => {
    const tool = createLookupPeopleTool({
      port: {
        async lookup() {
          return { query: "nobody", durationMs: 5, results: [] };
        },
      },
    });
    const out = await tool.invoke({ query: "nobody" }, ctx);
    expect(out.kind).toBe("person.results");
    if (out.kind === "person.results") {
      expect(out.results).toHaveLength(0);
    }
  });
});
