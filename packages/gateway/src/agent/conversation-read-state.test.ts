// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createConversationReadStateTables,
  forgetConversationReadState,
  isConversationUnread,
  markConversationOpened,
  readUnreadConversationIds,
  recordAgentMessage,
} from "./conversation-read-state.js";

describe("conversation read state", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createConversationReadStateTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it("is idempotent DDL", () => {
    expect(() => createConversationReadStateTables(db)).not.toThrow();
  });

  it("reports a conversation nobody has touched as read", () => {
    expect(isConversationUnread(db, "conv-a")).toBe(false);
    expect(readUnreadConversationIds(db, ["conv-a"])).toEqual(new Set());
  });

  it("opens an unread episode when agent content lands", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    expect(isConversationUnread(db, "conv-a")).toBe(true);
    expect(readUnreadConversationIds(db, ["conv-a"])).toEqual(new Set(["conv-a"]));
  });

  it("keeps the episode's start when more content lands in the same episode", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    recordAgentMessage(db, "conv-a", 5_000);
    // An episode is "there is something new here", not a message count — the
    // second arrival must not restart it.
    const row = db
      .prepare<
        [string],
        { unread_since: number }
      >("SELECT unread_since FROM conversation_read_state WHERE conversation_id = ?")
      .get("conv-a");
    expect(row?.unread_since).toBe(1_000);
  });

  it("ends the episode when the conversation is opened", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    markConversationOpened(db, "conv-a");
    expect(isConversationUnread(db, "conv-a")).toBe(false);
    expect(readUnreadConversationIds(db, ["conv-a"])).toEqual(new Set());
  });

  it("starts a fresh episode after a read", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    markConversationOpened(db, "conv-a");
    recordAgentMessage(db, "conv-a", 3_000);
    const row = db
      .prepare<
        [string],
        { unread_since: number }
      >("SELECT unread_since FROM conversation_read_state WHERE conversation_id = ?")
      .get("conv-a");
    expect(row?.unread_since).toBe(3_000);
  });

  it("stores nothing for a conversation that was never unread", () => {
    // Marking is a delete, so a mark naming a conversation that does not exist
    // — a stale client, a mistyped id — cannot mint a row that outlives it.
    markConversationOpened(db, "conv-does-not-exist");
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM conversation_read_state")
      .get();
    expect(count?.count).toBe(0);
  });

  it("answers the unread question for a whole page in one read", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    recordAgentMessage(db, "conv-c", 1_000);
    markConversationOpened(db, "conv-b");
    expect(readUnreadConversationIds(db, ["conv-a", "conv-b", "conv-c", "conv-d"])).toEqual(
      new Set(["conv-a", "conv-c"]),
    );
  });

  it("returns nothing for an empty page rather than querying", () => {
    expect(readUnreadConversationIds(db, [])).toEqual(new Set());
  });

  it("answers for a page larger than one query chunk", () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => `conv-${i}`);
    for (const id of ids) recordAgentMessage(db, id, 1_000);
    expect(readUnreadConversationIds(db, ids).size).toBe(1_200);
  });

  it("forgets a batch of deleted conversations", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    recordAgentMessage(db, "conv-b", 1_000);
    recordAgentMessage(db, "conv-c", 1_000);
    forgetConversationReadState(db, ["conv-a", "conv-c"]);
    expect(readUnreadConversationIds(db, ["conv-a", "conv-b", "conv-c"])).toEqual(
      new Set(["conv-b"]),
    );
  });

  it("forgets a batch larger than one query chunk", () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => `conv-${i}`);
    for (const id of ids) recordAgentMessage(db, id, 1_000);
    forgetConversationReadState(db, ids);
    expect(readUnreadConversationIds(db, ids)).toEqual(new Set());
  });

  it("forgets nothing when handed an empty batch", () => {
    recordAgentMessage(db, "conv-a", 1_000);
    forgetConversationReadState(db, []);
    expect(isConversationUnread(db, "conv-a")).toBe(true);
  });
});
