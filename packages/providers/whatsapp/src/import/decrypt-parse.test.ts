// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { decryptChatStorage, WrongBackupPasswordError } from "./ios-backup-decrypt.js";
import { parseChatStorage } from "./chatstorage-parser.js";
import { aesUnwrap } from "./keybag.js";
import {
  buildChatStorageDb,
  makeEncryptedBackup,
  type FixtureCorpus,
} from "./testing/make-backup.js";

const OWN = { jid: "15550100001@s.whatsapp.net", name: "Me" };
const ONE_TO_ONE = "15550100123@s.whatsapp.net";
const GROUP = "120000000000000001@g.us";
const MEMBER = "15550100200@s.whatsapp.net";

function ts(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00.000Z`) / 1000);
}

const CORPUS: FixtureCorpus = {
  chats: [
    { pk: 1, contactJid: ONE_TO_ONE, partnerName: "Maya Reeves" },
    { pk: 2, contactJid: GROUP, partnerName: "Project Falcon" },
  ],
  members: [{ pk: 10, memberJid: MEMBER, contactName: "Jamie Lopez" }],
  messages: [
    {
      pk: 1,
      stanzaId: "AAAA1111BBBB2222C",
      chatPk: 1,
      fromMe: 0,
      ts: ts("2022-06-23"),
      type: 0,
      text: "Hey there",
    },
    {
      pk: 2,
      stanzaId: "DDDD3333EEEE4444F",
      chatPk: 1,
      fromMe: 1,
      ts: ts("2022-06-24"),
      type: 0,
      text: "Hi Maya",
    },
    {
      pk: 3,
      stanzaId: "GGGG5555HHHH6666I",
      chatPk: 2,
      fromMe: 0,
      ts: ts("2023-01-10"),
      type: 0,
      text: "Group hello",
      groupMemberPk: 10,
    },
    {
      pk: 4,
      stanzaId: "JJJJ7777KKKK8888L",
      chatPk: 1,
      fromMe: 0,
      ts: ts("2023-02-01"),
      type: 1,
      text: "",
      media: { localPath: "Media/abc/photo.jpg", size: 12345 },
    },
    {
      pk: 5,
      stanzaId: "MMMM9999NNNN0000P",
      chatPk: 1,
      fromMe: 1,
      ts: ts("2023-02-02"),
      type: 0,
      text: "Replying",
      parentPk: 1, // reply to pk 1 ("Hey there")
    },
    // No stanza id → unmergeable → skipped.
    {
      pk: 6,
      stanzaId: null as unknown as string,
      chatPk: 1,
      fromMe: 0,
      ts: ts("2023-02-03"),
      type: 6,
      text: "system",
    },
  ],
};

describe("iOS backup decrypt + ChatStorage parse (#588)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("round-trips: build encrypted backup → decrypt → exact ChatStorage bytes", () => {
    const chatStorageBytes = buildChatStorageDb(CORPUS);
    const dir = makeEncryptedBackup({ chatStorageBytes, password: "hunter2-correct-horse" });
    dirs.push(dir);

    const decrypted = decryptChatStorage(dir, "hunter2-correct-horse");
    expect(decrypted.equals(chatStorageBytes)).toBe(true);
    expect(decrypted.subarray(0, 16).toString("ascii")).toBe("SQLite format 3\0");
  });

  it("parses the decrypted ChatStorage into StoredMessages with correct fields", () => {
    const chatStorageBytes = buildChatStorageDb(CORPUS);
    const dir = makeEncryptedBackup({ chatStorageBytes, password: "pw" });
    dirs.push(dir);
    const decrypted = decryptChatStorage(dir, "pw");

    const work = mkdtempSync(join(tmpdir(), "omnesis-wa-parse-"));
    dirs.push(work);
    const dbPath = join(work, "ChatStorage.sqlite");
    writeFileSync(dbPath, decrypted);

    const { messages, skipped } = parseChatStorage(dbPath, OWN);

    expect(skipped).toBe(1); // the no-stanza-id row
    expect(messages).toHaveLength(5);

    const m1 = messages.find((m) => m.id === "AAAA1111BBBB2222C")!;
    expect(m1.chatJid).toBe(ONE_TO_ONE);
    expect(m1.fromMe).toBe(false);
    expect(m1.senderJid).toBe(ONE_TO_ONE);
    expect(m1.senderName).toBe("Maya Reeves");
    expect(m1.type).toBe("text");
    expect(m1.text).toBe("Hey there");
    expect(m1.timestamp).toBe(ts("2022-06-23"));

    const m2 = messages.find((m) => m.id === "DDDD3333EEEE4444F")!;
    expect(m2.fromMe).toBe(true);
    expect(m2.senderJid).toBe(OWN.jid);
    expect(m2.senderName).toBe(OWN.name);

    const m3 = messages.find((m) => m.id === "GGGG5555HHHH6666I")!;
    expect(m3.chatJid).toBe(GROUP);
    expect(m3.senderJid).toBe(MEMBER);
    expect(m3.senderName).toBe("Jamie Lopez");

    const m4 = messages.find((m) => m.id === "JJJJ7777KKKK8888L")!;
    expect(m4.type).toBe("image");
    expect(m4.media?.filename).toBe("photo.jpg");
    expect(m4.media?.fileLength).toBe(12345);
    expect(m4.media?.mimetype).toBe("image/jpeg");

    const m5 = messages.find((m) => m.id === "MMMM9999NNNN0000P")!;
    expect(m5.quotedText).toBe("Hey there"); // resolved via ZPARENTMESSAGE
    expect(m5.quotedSender).toBe("Maya Reeves");
  });

  it("throws WrongBackupPasswordError on a wrong password", () => {
    const chatStorageBytes = buildChatStorageDb(CORPUS);
    const dir = makeEncryptedBackup({ chatStorageBytes, password: "correct" });
    dirs.push(dir);
    expect(() => decryptChatStorage(dir, "wrong")).toThrow(WrongBackupPasswordError);
  });

  it("decrypts a backup whose Manifest.plist is XML (the fallback read path)", () => {
    // The default fixture is binary (matching real iOS); this covers the XML
    // branch of readManifestPlist explicitly.
    const chatStorageBytes = buildChatStorageDb(CORPUS);
    const dir = makeEncryptedBackup({ chatStorageBytes, password: "pw", manifestFormat: "xml" });
    dirs.push(dir);
    expect(decryptChatStorage(dir, "pw").equals(chatStorageBytes)).toBe(true);
  });

  it("aesUnwrap matches the RFC 3394 §4.6 AES-256/256 test vector", () => {
    const kek = Buffer.from(
      "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F",
      "hex",
    );
    const expected = Buffer.from(
      "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F",
      "hex",
    );
    const wrapped = Buffer.from(
      "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21",
      "hex",
    );
    expect(aesUnwrap(kek, wrapped).equals(expected)).toBe(true);
  });
});
