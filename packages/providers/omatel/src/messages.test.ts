// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tableWrites } from "@omnesis/source-sdk";
import { syncMessages } from "./messages.js";
import {
  addConversation,
  addMessage,
  at,
  omatelFixture,
  providerId,
  sourceId,
  type OmatelFixture,
} from "./testing/fixtures.js";
import type { OmatelCursor } from "./group-sync.js";

const PEER = "+12025550141";
const OTHER = "+12025550142";
const THIRD = "+12025550143";

let fx: OmatelFixture;
beforeEach(() => {
  fx = omatelFixture();
});
afterEach(() => fx.cleanup());

function cycle(cursor: OmatelCursor | null) {
  const pages = [];
  let next = cursor;
  for (;;) {
    const page = syncMessages(next, { dataDir: fx.dir, sourceId, providerId });
    pages.push(page);
    next = page.cursor;
    if (!page.hasMore) return { pages, cursor: next, last: page };
  }
}

const write = (page: ReturnType<typeof syncMessages>) =>
  tableWrites(page.analytics)[0] ?? { tableName: "omatel_messages", records: [] };

describe("omatel messages", () => {
  it("renders one conversation document per contact and UTC day", () => {
    const db = fx.messages();
    const c = addConversation(db, PEER, "maya");
    addMessage(db, c, {
      direction: "in",
      body: "are we still on for the run?",
      at: at("2026-03-04T07:50"),
    });
    addMessage(db, c, {
      direction: "out",
      body: "yes, 8 at the park",
      at: at("2026-03-04T07:52"),
      state: "delivered",
    });
    addMessage(db, c, { direction: "in", body: "see you", at: at("2026-03-05T06:00") });

    const { last } = cycle(null);

    expect(last.documents?.map((d) => d.externalId)).toEqual([
      `sms:${PEER}:2026-03-04`,
      `sms:${PEER}:2026-03-05`,
    ]);
    const doc = last.documents![0]!;
    expect(doc.title).toBe("SMS with maya — 2026-03-04");
    expect(doc.content).toBe(
      ["**07:50** maya: are we still on for the run?", "**07:52** You: yes, 8 at the park"].join(
        "\n",
      ),
    );
    expect(doc.metadata).toMatchObject({
      documentType: "conversation",
      tags: ["SMS"],
      people: [
        { role: "participant", name: "You", isSelf: true },
        { role: "participant", phones: [PEER], name: "maya" },
      ],
      extra: {
        conversationId: PEER,
        chatName: "maya",
        isGroup: false,
        messageCount: 2,
        service: "SMS",
        participants: [PEER],
        date: "2026-03-04",
      },
    });
    expect(doc.sourceUpdatedAt).toBe("2026-03-04T07:52:00.000Z");

    const rows = write(last);
    expect(rows.tableName).toBe("omatel_messages");
    expect(rows.records![1]).toEqual({
      id: "2",
      date: "2026-03-04",
      time: "2026-03-04T07:52:00.000Z",
      conversation: PEER,
      direction: "outgoing",
      transport: "sms",
      state: "delivered",
      counterparty: PEER,
      characters: 18,
      attachments: 0,
    });
    // The text stays in the searchable documents, not the table.
    expect(rows.records!.every((r) => !("body" in r))).toBe(true);
    expect(rows.presentKeys).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("names the sender of each message in a group, and lists every member", () => {
    const db = fx.messages();
    const c = addConversation(db, `${OTHER},${THIRD}`, "trail crew", [OTHER, THIRD]);
    addMessage(db, c, {
      direction: "in",
      sender: OTHER,
      body: "saturday?",
      at: at("2026-03-04T10:00"),
    });
    addMessage(db, c, {
      direction: "in",
      sender: THIRD,
      body: "works for me",
      at: at("2026-03-04T10:05"),
    });

    const doc = cycle(null).last.documents![0]!;

    expect(doc.content).toBe(`**10:00** ${OTHER}: saturday?\n**10:05** ${THIRD}: works for me`);
    expect(doc.metadata.extra).toMatchObject({ isGroup: true, chatName: "trail crew" });
    expect(doc.metadata.people).toEqual([
      { role: "participant", name: "You", isSelf: true },
      { role: "participant", phones: [OTHER] },
      { role: "participant", phones: [THIRD] },
    ]);
  });

  it("marks outgoing messages that are not sent yet, and lists MMS attachments", () => {
    const db = fx.messages();
    const c = addConversation(db, PEER);
    addMessage(db, c, {
      direction: "out",
      body: "on my way",
      at: at("2026-03-04T09:00"),
      state: "sending",
    });
    addMessage(db, c, {
      direction: "out",
      body: "hello?",
      at: at("2026-03-04T09:01"),
      state: "failed",
    });
    const mms = addMessage(db, c, {
      direction: "in",
      body: "",
      at: at("2026-03-04T09:02"),
      transport: "mms",
    });
    db.prepare("INSERT INTO parts (message_id, mime, file) VALUES (?, ?, ?)").run(
      mms,
      "image/jpeg",
      "parts/7/sunset.jpg",
    );

    const { last } = cycle(null);
    const doc = last.documents![0]!;

    expect(doc.title).toBe(`SMS with ${PEER} — 2026-03-04`);
    expect(doc.content).toBe(
      [
        "**09:00** You: on my way _(sending)_",
        "**09:01** You: hello? _(not sent)_",
        `**09:02** ${PEER}: [Image: sunset.jpg]`,
      ].join("\n"),
    );
    expect(write(last).records![2]).toMatchObject({
      transport: "mms",
      attachments: 1,
      characters: 0,
    });
  });

  it("re-renders only the conversation day whose message was delivered", () => {
    const db = fx.messages();
    const a = addConversation(db, PEER);
    const b = addConversation(db, OTHER);
    const pending = addMessage(db, a, {
      direction: "out",
      body: "running late",
      at: at("2026-03-04T09:00"),
      state: "sent",
    });
    addMessage(db, b, { direction: "in", body: "ok", at: at("2026-03-04T09:00") });
    const first = cycle(null);

    db.prepare("UPDATE messages SET state = 'delivered' WHERE id = ?").run(pending);
    const next = cycle(first.cursor);

    expect(next.last.documents?.map((d) => d.externalId)).toEqual([`sms:${PEER}:2026-03-04`]);
    expect(write(next.last).records).toEqual([
      expect.objectContaining({ id: String(pending), state: "delivered" }),
    ]);
  });

  it("deletes the documents of a conversation the owner deleted", () => {
    const db = fx.messages();
    const a = addConversation(db, PEER);
    const b = addConversation(db, OTHER);
    addMessage(db, a, { direction: "in", body: "first", at: at("2026-03-04T09:00") });
    addMessage(db, a, { direction: "in", body: "second", at: at("2026-03-06T09:00") });
    const kept = addMessage(db, b, { direction: "in", body: "third", at: at("2026-03-06T09:00") });
    const first = cycle(null);

    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM conversations WHERE id = ?").run(a);
    const next = cycle(first.cursor);

    expect(next.last.deletedExternalIds).toEqual([
      `sms:${PEER}:2026-03-04`,
      `sms:${PEER}:2026-03-06`,
    ]);
    expect(next.last.documents).toEqual([]);
    expect(write(next.last).presentKeys).toEqual([{ id: String(kept) }]);
  });

  it("re-renders a conversation whose title changed", () => {
    const db = fx.messages();
    const c = addConversation(db, PEER);
    addMessage(db, c, { direction: "in", body: "hi", at: at("2026-03-04T09:00") });
    const first = cycle(null);

    db.prepare("UPDATE conversations SET title = 'dentist' WHERE id = ?").run(c);
    const next = cycle(first.cursor);

    expect(next.last.documents![0]!.title).toBe("SMS with dentist — 2026-03-04");
  });

  it("refuses a messages.db newer than the schema it reads", () => {
    fx.messages().pragma("user_version = 2");

    expect(() => cycle(null)).toThrow(/schema 2, newer than the 1/);
  });
});
