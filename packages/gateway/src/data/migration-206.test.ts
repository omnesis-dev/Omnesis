// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  createAgentMessagesTables,
  listBucketMessages,
} from "../sources/agent-conversations/storage.js";
import { buildDocument } from "../sources/agent-conversations/upsert.js";
import { addConversationAuthors } from "./migration-206-conversation-authors.js";

it("upgrades old ledger rows without inventing ownership and rerenders them safely", () => {
  const db = new Database(":memory:");
  try {
    createAgentMessagesTables(db);
    db.exec("ALTER TABLE agent_messages DROP COLUMN author_json");
    db.prepare(
      `INSERT INTO agent_messages (id,harness,channel,chat_id,day,role,text,occurred_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      "legacy-1",
      "hermes",
      "slack",
      "room-1",
      "2026-07-20",
      "user",
      "A room member's old message",
      "2026-07-20T09:00:00.000Z",
    );
    addConversationAuthors(db);
    addConversationAuthors(db);
    const bucket = { harness: "hermes", channel: "slack", chatId: "room-1", day: "2026-07-20" };
    const rows = listBucketMessages(db, bucket);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("A room member's old message");
    expect(rows[0].author).toBeUndefined();
    expect(db.prepare("SELECT author_json FROM agent_messages").get()).toEqual({
      author_json: null,
    });
    const doc = buildDocument(bucket, { platform: "slack", chatId: "room-1" }, rows);
    expect(doc.content).toContain("Unknown participant");
    expect(doc.content).not.toContain("· You");
  } finally {
    db.close();
  }
});
