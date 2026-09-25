// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { WhatsAppMessagesSource } from "./messages.js";
import { MessageStore } from "./message-store.js";
import { whatsappStateSpec } from "./state.js";
import type { StoredMessage } from "./types.js";

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "msg-1",
    chatJid: "12125550199@s.whatsapp.net",
    senderJid: "12125550199@s.whatsapp.net",
    senderName: "Alice",
    fromMe: false,
    timestamp: 1709900000,
    type: "text",
    text: "Hello",
    ...overrides,
  };
}

describe("whatsappStateSpec via the host decorator", () => {
  test("decodes legacy and identified bookmarks but refuses malformed acknowledgements", () => {
    const legacy = { phase: "incremental", lastTimestamp: 0, committedSeq: 1 };
    expect(whatsappStateSpec.decode(legacy)).toEqual(legacy);
    expect(whatsappStateSpec.decode({ ...legacy, storeId: "archive-a" })).not.toBeNull();
    for (const committedSeq of [-1, 0.5, NaN, Infinity]) {
      expect(whatsappStateSpec.decode({ ...legacy, committedSeq })).toBeNull();
    }
    expect(whatsappStateSpec.decode({ ...legacy, storeId: 42 })).toBeNull();
  });
  let store: MessageStore;
  let instance: SourceInstance;

  beforeEach(() => {
    store = new MessageStore();
    const source = new WhatsAppMessagesSource(store);
    // Driven through `withVersionedState` rather than `source.sync` directly,
    // because resolving the stored value is the host's job — calling `sync`
    // with a raw cursor would test a path production never takes.
    instance = { sync: (cursor) => source.sync(cursor) };
  });

  test("first run resolves fresh and writes back an envelope", async () => {
    store.addMessages([makeMsg()]);
    store.addChats([{ jid: "12125550199@s.whatsapp.net", name: "Alice", isGroup: false }]);

    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, whatsappStateSpec, {
      sourceId: "whatsapp-messages:test",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    expect(result.documents).toHaveLength(1);

    const second = await versioned.sync(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
    expect(second.documents).toEqual([]);
  });

  test("a stored value this build cannot make sense of rebootstraps rather than throwing", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, whatsappStateSpec, {
      sourceId: "whatsapp-messages:test",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync({ unrelatedField: 1 } as unknown as Parameters<
      typeof instance.sync
    >[0]);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
    // A rebootstrap behaves like a fresh start, not a thrown error — the
    // source still ran and its result still gets wrapped for next time.
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
