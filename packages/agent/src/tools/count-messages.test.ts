// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { hostTimeZone } from "@omnesis/core";
import { COUNT_MESSAGES_MAX_LIMIT, createCountMessagesTool } from "./count-messages.js";
import type { MessageCountPort, MessageCountPortInput, MessageCountPortResult } from "./types.js";

const ctx = { sessionId: "S", messageId: "M" };

const RESULT: MessageCountPortResult = {
  people: [
    {
      personId: "p-maya",
      name: "Maya",
      messages: 195,
      groupMessages: 0,
      documents: 2,
      sentByYou: 0,
      sentByThem: 0,
      sourceIds: ["demo-chat:acct"],
      lastAt: "2026-10-20T08:00:00.000Z",
    },
  ],
  totalPeople: 1,
  truncated: false,
  sources: [
    { sourceId: "demo-chat:acct", documents: 2, messages: 195, countedPer: "declared-count" },
  ],
  selfKnown: true,
  window: {
    from: "2026-10-19T00:00:00.000Z",
    toExclusive: "2026-10-26T00:00:00.000Z",
    timeZone: "UTC",
  },
  durationMs: 1,
};

function recordingPort(): {
  port: MessageCountPort;
  seen: () => MessageCountPortInput | undefined;
} {
  let seen: MessageCountPortInput | undefined;
  return {
    seen: () => seen,
    port: {
      async count(input) {
        seen = input;
        return RESULT;
      },
    },
  };
}

describe("count_messages", () => {
  it("is read-only", () => {
    expect(createCountMessagesTool({ port: recordingPort().port }).mutates).toBe(false);
  });

  it("hands the port the window, the caller's zone and a default limit", async () => {
    const { port, seen } = recordingPort();
    const tool = createCountMessagesTool({ port });
    const result = await tool.invoke(
      { from: "2026-10-19", to: "2026-10-26" },
      { ...ctx, timeZone: "Europe/Paris" },
    );
    expect(seen()).toEqual({
      from: "2026-10-19",
      to: "2026-10-26",
      timeZone: "Europe/Paris",
      limit: 10,
    });
    expect(result).toEqual({ kind: "structured", resultType: "messages.counted", data: RESULT });
  });

  it("falls back to the host zone and passes source restrictions through", async () => {
    const { port, seen } = recordingPort();
    const tool = createCountMessagesTool({ port });
    await tool.invoke({ from: "-7d", sourceIds: ["demo-mail:acct"], limit: 3 }, ctx);
    expect(seen()).toEqual({
      from: "-7d",
      timeZone: hostTimeZone(),
      sourceIds: ["demo-mail:acct"],
      limit: 3,
    });
  });

  it("rejects malformed arguments without calling the port", async () => {
    const { port, seen } = recordingPort();
    const tool = createCountMessagesTool({ port });
    for (const args of [{}, { from: "" }, { from: "-7d", limit: COUNT_MESSAGES_MAX_LIMIT + 1 }]) {
      const result = await tool.invoke(args, ctx);
      expect(result).toMatchObject({ kind: "error", code: "invalid_args" });
    }
    expect(seen()).toBeUndefined();
  });

  it("reports a port failure as a tool error", async () => {
    const tool = createCountMessagesTool({
      port: {
        async count() {
          throw new Error("Invalid from");
        },
      },
    });
    expect(await tool.invoke({ from: "soon" }, ctx)).toEqual({
      kind: "error",
      code: "count_failed",
      message: "Invalid from",
    });
  });
});
