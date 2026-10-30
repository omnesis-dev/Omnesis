// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { parseMsgstore } from "./msgstore-parser.js";
import { buildMsgstoreDb, type AndroidFixtureCorpus } from "./testing/make-android-backup.js";
import type { StoredMessage } from "../types.js";

const OWN = { jid: "15550100001@s.whatsapp.net", name: "Me" };
const CHAT = "15550100123@s.whatsapp.net";
const GROUP = "120000000000000001@g.us";
const MEMBER = "15550100200@s.whatsapp.net";

describe.each(["modern", "legacy"] as const)("parseMsgstore — %s schema", (schema) => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function parse(corpus: AndroidFixtureCorpus): { messages: StoredMessage[]; skipped: number } {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-parsetest-"));
    dirs.push(dir);
    const path = join(dir, "msgstore.db");
    writeFileSync(path, buildMsgstoreDb(corpus, { schema }));
    const messages: StoredMessage[] = [];
    const { skipped } = parseMsgstore(path, OWN, {
      batchSize: 2,
      onBatch: (batch) => messages.push(...batch),
    });
    return { messages, skipped };
  }

  it("maps known type codes and infers media for an unknown code with a file path", () => {
    const { messages } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        { id: 1, keyId: "T1", chatId: 1, fromMe: 0, tsMs: 1_700_000_000_000, type: 0, text: "hi" },
        { id: 2, keyId: "T2", chatId: 1, fromMe: 0, tsMs: 1_700_000_001_000, type: 1, text: "" },
        {
          id: 3,
          keyId: "T3",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_002_000,
          type: 99,
          text: "",
          media: { filePath: "Media/x/report.pdf", mimeType: "application/pdf" },
        },
        { id: 4, keyId: "T4", chatId: 1, fromMe: 0, tsMs: 1_700_000_003_000, type: 15, text: "" },
        {
          id: 5,
          keyId: "T5",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_004_000,
          type: 9,
          text: "",
          media: { filePath: "Media/x/budget.pdf", mimeType: "application/pdf" },
        },
        { id: 6, keyId: "T6", chatId: 1, fromMe: 0, tsMs: 1_700_000_005_000, type: 7, text: "" },
      ],
    });

    expect(messages.find((m) => m.id === "T1")?.type).toBe("text");
    expect(messages.find((m) => m.id === "T2")?.type).toBe("image");
    const m3 = messages.find((m) => m.id === "T3")!;
    expect(m3.type).toBe("media");
    expect(m3.media?.filename).toBe("report.pdf");
    expect(m3.media?.mimetype).toBe("application/pdf");
    const m4 = messages.find((m) => m.id === "T4")!;
    expect(m4.type).toBe("deleted");
    expect(m4.deleted).toBe(true);
    expect(messages.find((m) => m.id === "T5")?.type).toBe("document");
    expect(messages.find((m) => m.id === "T6")?.type).toBe("system");
  });

  it("resolves 1:1 and group senders", () => {
    const { messages } = parse({
      chats: [
        { id: 1, jid: CHAT },
        { id: 2, jid: GROUP },
      ],
      messages: [
        { id: 1, keyId: "A1", chatId: 1, fromMe: 0, tsMs: 1_700_000_000_000, type: 0, text: "hi" },
        { id: 2, keyId: "A2", chatId: 1, fromMe: 1, tsMs: 1_700_000_001_000, type: 0, text: "yo" },
        {
          id: 3,
          keyId: "A3",
          chatId: 2,
          fromMe: 0,
          tsMs: 1_700_000_002_000,
          type: 0,
          text: "group hi",
          senderJid: MEMBER,
        },
      ],
    });

    const m1 = messages.find((m) => m.id === "A1")!;
    expect(m1.senderJid).toBe(CHAT);
    expect(m1.fromMe).toBe(false);

    const m2 = messages.find((m) => m.id === "A2")!;
    expect(m2.fromMe).toBe(true);
    expect(m2.senderJid).toBe(OWN.jid);
    expect(m2.senderName).toBe(OWN.name);

    const m3 = messages.find((m) => m.id === "A3")!;
    expect(m3.chatJid).toBe(GROUP);
    expect(m3.senderJid).toBe(MEMBER);
  });

  it("resolves a reply via the quoted satellite row", () => {
    const { messages } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        {
          id: 1,
          keyId: "R1",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_000_000,
          type: 0,
          text: "original",
        },
        {
          id: 2,
          keyId: "R2",
          chatId: 1,
          fromMe: 1,
          tsMs: 1_700_000_001_000,
          type: 0,
          text: "reply",
          quoted: { keyId: "R1", text: "original", senderJid: CHAT },
        },
      ],
    });
    const reply = messages.find((m) => m.id === "R2")!;
    expect(reply.quotedText).toBe("original");
    // The quote row's own id is 1, the same as the original message's: only
    // the reply carries it.
    expect(messages.find((m) => m.id === "R1")!.quotedText).toBeUndefined();
  });

  it("attaches a media row to its own message, not one sharing its row id", () => {
    const { messages } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        { id: 1, keyId: "J1", chatId: 1, fromMe: 0, tsMs: 1_700_000_000_000, type: 0, text: "hi" },
        {
          id: 2,
          keyId: "J2",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_001_000,
          type: 1,
          text: "",
          media: { filePath: "Media/x/photo.jpg", mimeType: "image/jpeg", fileSize: 999 },
        },
      ],
    });
    expect(messages.find((m) => m.id === "J1")!.media).toBeUndefined();
    expect(messages.find((m) => m.id === "J2")!.media?.filename).toBe("photo.jpg");
  });

  it("imports a media caption as the message text", () => {
    const { messages } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        {
          id: 1,
          keyId: "C1",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_000_000,
          type: 1,
          text: null,
          caption: "harbour at dawn",
          media: { filePath: "Media/x/photo.jpg", mimeType: "image/jpeg" },
        },
        { id: 2, keyId: "C2", chatId: 1, fromMe: 0, tsMs: 1_700_000_001_000, type: 0, text: "hi" },
      ],
    });
    expect(messages.find((m) => m.id === "C1")!.text).toBe("harbour at dawn");
    expect(messages.find((m) => m.id === "C2")!.text).toBe("hi");
  });

  it("never sets downloadable-media fields (metadata-only attachments)", () => {
    const { messages } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        {
          id: 1,
          keyId: "M1",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_000_000,
          type: 1,
          text: "",
          media: { filePath: "Media/x/photo.jpg", mimeType: "image/jpeg", fileSize: 999 },
        },
      ],
    });
    const m = messages.find((m) => m.id === "M1")!;
    expect(m.media?.fileLength).toBe(999);
    expect(m.media?.mediaKey).toBeUndefined();
    expect(m.media?.url).toBeUndefined();
    expect(m.media?.directPath).toBeUndefined();
  });

  it("skips rows with no key_id, a non-positive timestamp, or an intra-import duplicate", () => {
    const { messages, skipped } = parse({
      chats: [{ id: 1, jid: CHAT }],
      messages: [
        { id: 1, keyId: "", chatId: 1, fromMe: 0, tsMs: 1_700_000_000_000, type: 0, text: "no id" },
        { id: 2, keyId: "S2", chatId: 1, fromMe: 0, tsMs: 0, type: 0, text: "bad ts" },
        {
          id: 3,
          keyId: "S3",
          chatId: 1,
          fromMe: 0,
          tsMs: 1_700_000_001_000,
          type: 0,
          text: "first",
        },
        { id: 4, keyId: "S3", chatId: 1, fromMe: 0, tsMs: 1_700_000_002_000, type: 0, text: "dup" },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe("S3");
    expect(skipped).toBe(3);
  });

  it("streams across multiple batches", () => {
    const batches: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-parsetest-batch-"));
    dirs.push(dir);
    const path = join(dir, "msgstore.db");
    const corpus: AndroidFixtureCorpus = {
      chats: [{ id: 1, jid: CHAT }],
      messages: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        keyId: `B${i}`,
        chatId: 1,
        fromMe: 0 as const,
        tsMs: 1_700_000_000_000 + i * 1000,
        type: 0,
        text: `msg ${i}`,
      })),
    };
    writeFileSync(path, buildMsgstoreDb(corpus, { schema }));
    const { skipped } = parseMsgstore(path, OWN, {
      batchSize: 2,
      onBatch: (batch) => batches.push(batch.length),
    });
    expect(skipped).toBe(0);
    expect(batches).toEqual([2, 2, 1]);
  });
});
