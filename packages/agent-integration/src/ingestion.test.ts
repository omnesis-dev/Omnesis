// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { DurableIntegrationInbox } from "./inbox.js";
import {
  DurableTranscriptIngestor,
  type AgentConversationMessage,
  type TranscriptPage,
} from "./ingestion.js";

const MESSAGE: AgentConversationMessage = {
  id: "openclaw:local:fictional-session:1",
  harness: "openclaw",
  channel: "local",
  chatId: "fictional-session",
  role: "user",
  text: "Please review the fictional Q4 budget.",
  occurredAt: 1_800_000_000_000,
};

describe("DurableTranscriptIngestor", () => {
  test("advances the cursor only after a successful upload", async () => {
    const state = new DurableIntegrationInbox(":memory:");
    const pages: TranscriptPage[] = [
      { messages: [MESSAGE], nextCursor: "cursor-1", hasMore: false },
    ];
    let failures = 1;
    const ingestor = new DurableTranscriptIngestor({
      stream: "openclaw",
      state,
      source: { readPage: async () => pages[0] },
      sink: {
        push: async () => {
          if (failures-- > 0) throw new Error("fictional gateway outage");
        },
      },
    });
    await expect(ingestor.runOnce()).rejects.toThrow(/outage/);
    expect(state.getCursor("openclaw")).toBeNull();
    await expect(ingestor.runOnce()).resolves.toBe(1);
    expect(state.getCursor("openclaw")).toBe("cursor-1");
    state.close();
  });

  test("pages through a backfill and persists filtered empty progress", async () => {
    const state = new DurableIntegrationInbox(":memory:");
    const seen: Array<string | null> = [];
    const ingestor = new DurableTranscriptIngestor({
      stream: "openclaw",
      state,
      source: {
        readPage: async (cursor) => {
          seen.push(cursor);
          return cursor === null
            ? { messages: [], nextCursor: "cursor-filtered", hasMore: true }
            : { messages: [MESSAGE], nextCursor: "cursor-final", hasMore: false };
        },
      },
      sink: { push: async () => {} },
    });
    expect(await ingestor.runOnce()).toBe(1);
    expect(seen).toEqual([null, "cursor-filtered"]);
    expect(state.getCursor("openclaw")).toBe("cursor-final");
    state.close();
  });

  test("rejects a source that claims more pages without advancing", async () => {
    const state = new DurableIntegrationInbox(":memory:");
    const ingestor = new DurableTranscriptIngestor({
      stream: "openclaw",
      state,
      source: {
        readPage: async () => ({ messages: [], nextCursor: "", hasMore: true }),
      },
      sink: { push: async () => {} },
    });
    await expect(ingestor.runOnce()).rejects.toThrow(/non-advancing/);
    state.close();
  });
});
