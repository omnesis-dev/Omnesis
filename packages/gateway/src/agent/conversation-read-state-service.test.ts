// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { directWriteGate } from "../write-gate.js";
import { createConversationReadStateTables } from "./conversation-read-state.js";
import {
  ConversationReadStateService,
  DEFAULT_VIEWING_TTL_MS,
  annotateUnread,
  resolveViewingTtlMs,
  type ConversationReadStateWriter,
} from "./conversation-read-state-service.js";
import type { Db } from "../data/types.js";
import type { OmnesisConfig } from "@omnesis/config";

describe("ConversationReadStateService", () => {
  let db: Database.Database;
  let clock = 0;
  let writes: string[];
  let service: ConversationReadStateService;

  function makeService(viewingTtlMs?: () => number): ConversationReadStateService {
    const gate = directWriteGate(db as unknown as Db);
    // Record which durable writes actually reach the gate, so a test can tell
    // "the state is right" from "the state is right and we paid for it".
    const writer: ConversationReadStateWriter = {
      markConversationSeen: async (id) => {
        writes.push(`seen:${id}`);
        return gate.markConversationSeen(id);
      },
      recordConversationAgentContent: async (id, now) => {
        writes.push(`arrived:${id}`);
        return gate.recordConversationAgentContent(id, now);
      },
      forgetConversationReadState: async (ids) => {
        writes.push(`forget:${ids.join(",")}`);
        return gate.forgetConversationReadState(ids);
      },
    };
    return new ConversationReadStateService({
      db,
      writer,
      now: () => clock,
      ...(viewingTtlMs ? { viewingTtlMs } : {}),
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    createConversationReadStateTables(db);
    clock = 1_000;
    writes = [];
    service = makeService();
  });

  afterEach(() => {
    db.close();
  });

  it("marks a conversation unread when content arrives with nobody watching", async () => {
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("does not mark unread while a client is rendering the conversation", async () => {
    await service.markSeen("conv-a", { viewing: true });
    clock = 2_000;
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("treats content inside a bounded presentation window as viewed", async () => {
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    clock += 4_999;
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("marks a late answer unread after its presentation window expires", async () => {
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    clock += 5_000;
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("a transient presentation does not clear older unread content", async () => {
    await service.agentContentArrived("conv-a");
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("a shorter transient presentation never shortens an existing viewing lease", async () => {
    await service.markSeen("conv-a", { viewing: true });
    service.expectContentViewed("conv-a", "msg-a", 1_000);
    clock += 1_001;
    expect(service.isViewing("conv-a")).toBe(true);
  });

  it("one visual surface leaving does not cancel a transient presentation", async () => {
    await service.markSeen("conv-a", { viewing: true });
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    await service.markSeen("conv-a", { viewing: false });
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("does not reuse a transient presentation for a later turn", async () => {
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    await service.agentContentArrived("conv-a", { messageId: "msg-b" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("can release a transient presentation when its turn has no content", async () => {
    service.expectContentViewed("conv-a", "msg-a", 5_000);
    service.finishExpectedContent("conv-a", "msg-a");
    await service.agentContentArrived("conv-a", { messageId: "msg-a" });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("writes nothing at all for content arriving under the operator's eyes", async () => {
    await service.markSeen("conv-a", { viewing: true });
    writes.length = 0;
    await service.agentContentArrived("conv-a");
    expect(writes).toEqual([]);
  });

  it("marks unread once the client says it stopped rendering", async () => {
    await service.markSeen("conv-a", { viewing: true });
    await service.markSeen("conv-a", { viewing: false });
    clock = 2_000;
    await service.agentContentArrived("conv-a");
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("clears an unread conversation when a client stops rendering it", async () => {
    // Withdrawing the lease still means the operator had it on screen — the
    // portal sends exactly this on navigate-away — so it must read as read.
    await service.agentContentArrived("conv-a");
    await service.markSeen("conv-a", { viewing: false });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("stops believing a viewing mark that was never refreshed", async () => {
    await service.markSeen("conv-a", { viewing: true });
    expect(service.isViewing("conv-a")).toBe(true);
    clock += DEFAULT_VIEWING_TTL_MS + 1;
    expect(service.isViewing("conv-a")).toBe(false);
    await service.agentContentArrived("conv-a");
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("keeps believing a viewing mark that is refreshed", async () => {
    await service.markSeen("conv-a", { viewing: true });
    clock += DEFAULT_VIEWING_TTL_MS - 1;
    await service.markSeen("conv-a", { viewing: true });
    clock += DEFAULT_VIEWING_TTL_MS - 1;
    expect(service.isViewing("conv-a")).toBe(true);
  });

  it("skips the durable write when a held lease is merely refreshed", async () => {
    await service.markSeen("conv-a", { viewing: true });
    writes.length = 0;
    clock += 1_000;
    await service.markSeen("conv-a", { viewing: true });
    // The conversation is already read and already leased, so the refresh has
    // nothing to write — and every write op preempts the writer's background
    // work, so a periodic no-op is not free.
    expect(writes).toEqual([]);
    expect(service.isViewing("conv-a")).toBe(true);
  });

  it("still writes when a refresh has an unread episode to clear", async () => {
    // A lease can be held while content lands, if the arrival raced the
    // expiry — the refresh must not skip the clear.
    await service.markSeen("conv-a", { viewing: true });
    db.prepare(
      "INSERT INTO conversation_read_state (conversation_id, unread_since) VALUES (?, ?)",
    ).run("conv-a", clock);
    writes.length = 0;
    await service.markSeen("conv-a", { viewing: true });
    expect(writes).toEqual(["seen:conv-a"]);
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("keeps viewing state per conversation", async () => {
    await service.markSeen("conv-a", { viewing: true });
    await service.agentContentArrived("conv-a");
    await service.agentContentArrived("conv-b");
    expect(service.unreadAmong(["conv-a", "conv-b"])).toEqual(new Set(["conv-b"]));
  });

  it("clears the dot when the conversation is opened, on any surface", async () => {
    await service.agentContentArrived("conv-a");
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set(["conv-a"]));
    // A second surface opening it is the same call — the state is the
    // gateway's, not the client's.
    await service.markSeen("conv-a", { viewing: true });
    expect(service.unreadAmong(["conv-a"])).toEqual(new Set());
  });

  it("forgets deleted conversations in one write, including their viewing marks", async () => {
    await service.markSeen("conv-a", { viewing: true });
    await service.agentContentArrived("conv-b");
    writes.length = 0;
    await service.forget(["conv-a", "conv-b"]);
    expect(writes).toEqual(["forget:conv-a,conv-b"]);
    expect(service.isViewing("conv-a")).toBe(false);
    expect(service.unreadAmong(["conv-a", "conv-b"])).toEqual(new Set());
  });

  it("honours an overridden viewing window, read fresh each time", async () => {
    let ttl = 10;
    const short = makeService(() => ttl);
    await short.markSeen("conv-a", { viewing: true });
    clock += 11;
    expect(short.isViewing("conv-a")).toBe(false);
    // A live config edit takes effect without rebuilding the service.
    ttl = 10_000;
    await short.markSeen("conv-a", { viewing: true });
    clock += 11;
    expect(short.isViewing("conv-a")).toBe(true);
    expect(short.viewingTtlMs()).toBe(10_000);
  });
});

describe("resolveViewingTtlMs", () => {
  it("falls back to the built-in window when nothing is configured", () => {
    expect(resolveViewingTtlMs(undefined)).toBe(DEFAULT_VIEWING_TTL_MS);
    expect(resolveViewingTtlMs({} as OmnesisConfig)).toBe(DEFAULT_VIEWING_TTL_MS);
  });

  it("reads the operator's configured window", () => {
    expect(resolveViewingTtlMs({ agent: { conversationViewingTtl: "3m" } } as OmnesisConfig)).toBe(
      180_000,
    );
  });
});

describe("annotateUnread", () => {
  it("stamps each row and preserves the cursor", () => {
    const page = {
      conversations: [{ id: "conv-a" }, { id: "conv-b" }],
      nextCursor: "cursor-1",
    };
    expect(annotateUnread(page, { unreadAmong: () => new Set(["conv-b"]) })).toEqual({
      conversations: [
        { id: "conv-a", unread: false },
        { id: "conv-b", unread: true },
      ],
      nextCursor: "cursor-1",
    });
  });

  it("reports everything read when the gateway keeps no read state", () => {
    const page = { conversations: [{ id: "conv-a" }], nextCursor: null };
    expect(annotateUnread(page, undefined)).toEqual({
      conversations: [{ id: "conv-a", unread: false }],
      nextCursor: null,
    });
  });
});
