// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { parseChatStorage } from "./chatstorage-parser.js";
import { buildChatStorageDb, type FixtureCorpus } from "./testing/make-backup.js";
import { APPLE_EPOCH_OFFSET } from "./constants.js";

const OWN = { jid: "15550100001@s.whatsapp.net", name: "Me" };
const CHAT = "15550100123@s.whatsapp.net";
const GROUP = "120000000000000001@g.us";
const MEMBER = "15550100200@s.whatsapp.net";

function ts(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00.000Z`) / 1000);
}

describe("parseChatStorage — field mapping, fallbacks, skips", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function parse(corpus: FixtureCorpus) {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-parsetest-"));
    dirs.push(dir);
    const path = join(dir, "ChatStorage.sqlite");
    writeFileSync(path, buildChatStorageDb(corpus));
    return parseChatStorage(path, OWN);
  }

  it("maps types by code and infers location / document / media for unknown codes", () => {
    const { messages } = parse({
      chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
      members: [],
      messages: [
        { pk: 1, stanzaId: "T1", chatPk: 1, fromMe: 0, ts: ts("2023-01-01"), type: 0, text: "hi" },
        { pk: 2, stanzaId: "T2", chatPk: 1, fromMe: 0, ts: ts("2023-01-02"), type: 14, text: "" },
        // type 4 is contact (mapped); the vcard rides along in the media item.
        {
          pk: 3,
          stanzaId: "T3",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-03"),
          type: 4,
          text: "",
          media: { vcard: "BEGIN:VCARD\nFN:Jamie Lopez\nEND:VCARD" },
        },
        // type 10 is a system notification, not a content message.
        { pk: 4, stanzaId: "T4", chatPk: 1, fromMe: 0, ts: ts("2023-01-04"), type: 10, text: "" },
        // Unknown code with a real local file → inferred document.
        {
          pk: 5,
          stanzaId: "T5",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-05"),
          type: 99,
          text: "",
          media: { localPath: "Media/x/doc.pdf", title: "report.pdf", size: 10 },
        },
        // Unknown code with real (non-zero) coordinates → inferred location.
        {
          pk: 6,
          stanzaId: "T6",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-06"),
          type: 99,
          text: "",
          media: { lat: 51.5, lon: -0.12 },
        },
        // Unknown code with a media item but no file / coords (zero-defaulted
        // columns) → generic "media", NOT a false location and no media block.
        {
          pk: 7,
          stanzaId: "T7",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-07"),
          type: 99,
          text: "",
          media: {},
        },
        // Unknown code with nothing attached → honest unknown:<code>.
        { pk: 8, stanzaId: "T8", chatPk: 1, fromMe: 0, ts: ts("2023-01-08"), type: 99, text: "" },
      ],
    });
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.T1.type).toBe("text");
    expect(byId.T2.type).toBe("deleted");
    expect(byId.T2.deleted).toBe(true);
    expect(byId.T3.type).toBe("contact");
    expect(byId.T4.type).toBe("system");
    expect(byId.T5.type).toBe("document");
    expect(byId.T5.media?.mimetype).toBe("application/pdf");
    expect(byId.T5.media?.filename).toBe("report.pdf"); // ZTITLE preferred over path basename
    expect(byId.T6.type).toBe("location");
    expect(byId.T7.type).toBe("media");
    expect(byId.T7.media).toBeUndefined(); // zero size/duration → no media block
    expect(byId.T8.type).toBe("unknown:99");
  });

  it("treats zero-defaulted media columns as absent (no false location / media block)", () => {
    const { messages } = parse({
      chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
      members: [],
      messages: [
        // A plain text message whose row happens to have an empty media item
        // (size 0, lat/lon 0). It must stay "text" with no media block.
        {
          pk: 1,
          stanzaId: "Z1",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-02-01"),
          type: 0,
          text: "just text",
          media: {},
        },
      ],
    });
    const m = messages[0];
    expect(m.type).toBe("text");
    expect(m.media).toBeUndefined();
  });

  it("does not let a non-zero ZGROUPEVENTTYPE reclassify an ordinary message", () => {
    const { messages } = parse({
      chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
      members: [],
      messages: [
        {
          pk: 1,
          stanzaId: "G1",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-03-01"),
          type: 0,
          text: "hello",
          groupEvent: 2,
        },
      ],
    });
    expect(messages[0].type).toBe("text");
  });

  it("resolves a reply via ZPARENTMESSAGE and tolerates a legacy schema", () => {
    const corpus: FixtureCorpus = {
      chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
      members: [],
      messages: [
        {
          pk: 1,
          stanzaId: "P1",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-04-01"),
          type: 0,
          text: "ping",
        },
        {
          pk: 2,
          stanzaId: "P2",
          chatPk: 1,
          fromMe: 1,
          ts: ts("2023-04-02"),
          type: 0,
          text: "pong",
          parentPk: 1,
        },
      ],
    };
    // Modern schema resolves the quote.
    const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-parsetest-"));
    dirs.push(dir);
    const path = join(dir, "ChatStorage.sqlite");
    writeFileSync(path, buildChatStorageDb(corpus));
    const modern = parseChatStorage(path, OWN);
    const reply = modern.messages.find((m) => m.id === "P2")!;
    expect(reply.quotedText).toBe("ping");
    expect(reply.quotedSender).toBe("Maya Reeves");

    // Legacy schema (no ZFROMJID/ZPUSHNAME/ZPARENTMESSAGE) still parses; the
    // quote is simply absent rather than throwing on a missing column.
    const legacyDir = mkdtempSync(join(tmpdir(), "omnesis-wa-parsetest-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "ChatStorage.sqlite");
    writeFileSync(legacyPath, buildChatStorageDb(corpus, { schema: "legacy" }));
    const legacy = parseChatStorage(legacyPath, OWN);
    expect(legacy.messages.map((m) => m.id).sort()).toEqual(["P1", "P2"]);
    expect(legacy.messages.find((m) => m.id === "P2")!.quotedText).toBeUndefined();
  });

  it("resolves group sender from the member, 1:1 from the chat, fromMe from the account", () => {
    const { messages } = parse({
      chats: [
        { pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" },
        { pk: 2, contactJid: GROUP, partnerName: "Project Falcon" },
      ],
      members: [{ pk: 10, memberJid: MEMBER, contactName: "Jamie Lopez" }],
      messages: [
        { pk: 1, stanzaId: "A", chatPk: 1, fromMe: 0, ts: ts("2023-01-01"), type: 0, text: "in" },
        { pk: 2, stanzaId: "B", chatPk: 1, fromMe: 1, ts: ts("2023-01-02"), type: 0, text: "out" },
        {
          pk: 3,
          stanzaId: "C",
          chatPk: 2,
          fromMe: 0,
          ts: ts("2023-01-03"),
          type: 0,
          text: "grp",
          groupMemberPk: 10,
        },
      ],
    });
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.A.senderJid).toBe(CHAT);
    expect(byId.A.senderName).toBe("Maya Reeves");
    expect(byId.B.fromMe).toBe(true);
    expect(byId.B.senderJid).toBe(OWN.jid);
    expect(byId.C.senderJid).toBe(MEMBER);
    expect(byId.C.senderName).toBe("Jamie Lopez");
    // Mac-time conversion.
    expect(byId.A.timestamp).toBe(ts("2023-01-01"));
  });

  it("skips rows with no stable id, a non-positive date, or an intra-import duplicate", () => {
    const { messages, skipped } = parse({
      chats: [{ pk: 1, contactJid: CHAT, partnerName: "Maya Reeves" }],
      members: [],
      messages: [
        { pk: 1, stanzaId: "OK", chatPk: 1, fromMe: 0, ts: ts("2023-01-01"), type: 0, text: "ok" },
        // No stanza id → unmergeable.
        {
          pk: 2,
          stanzaId: null as unknown as string,
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-02"),
          type: 0,
          text: "x",
        },
        // ts === APPLE_EPOCH_OFFSET → Cocoa time 0 → skipped (would map to 2001-01-01).
        {
          pk: 3,
          stanzaId: "ZERO",
          chatPk: 1,
          fromMe: 0,
          ts: APPLE_EPOCH_OFFSET,
          type: 0,
          text: "y",
        },
        // Duplicate (chat, id) — second occurrence dropped.
        {
          pk: 4,
          stanzaId: "DUP",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-03"),
          type: 0,
          text: "first",
        },
        {
          pk: 5,
          stanzaId: "DUP",
          chatPk: 1,
          fromMe: 0,
          ts: ts("2023-01-04"),
          type: 0,
          text: "second",
        },
      ],
    });
    expect(messages.map((m) => m.id).sort()).toEqual(["DUP", "OK"]);
    expect(messages.find((m) => m.id === "DUP")?.text).toBe("first"); // earliest kept
    expect(skipped).toBe(3); // null-id + zero-date + duplicate
    expect(messages.every((m) => m.timestamp > APPLE_EPOCH_OFFSET)).toBe(true);
  });
});
