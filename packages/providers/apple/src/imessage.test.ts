// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { resolveAttachmentConfig } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import { AppleProvider } from "./provider.js";
import { AppleIMessageSource } from "./imessage.js";
import type { AttachmentExtractFn } from "@omnesis/core";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// iMessage dates are nanoseconds since 2001-01-01
// Helper: convert a JS Date to iMessage nanoseconds
function dateToImessageNs(date: Date): number {
  const unixSeconds = date.getTime() / 1000;
  const appleSeconds = unixSeconds - 978307200;
  return appleSeconds * 1e9;
}

const DATE_2024_03_08_10AM = dateToImessageNs(new Date("2024-03-08T10:00:00Z"));
const DATE_2024_03_08_11AM = dateToImessageNs(new Date("2024-03-08T11:00:00Z"));
const DATE_2024_03_09_10AM = dateToImessageNs(new Date("2024-03-09T10:00:00Z"));

/**
 * Build a minimal typedstream attributedBody blob for testing.
 */
function buildAttributedBody(text: string): Buffer {
  const prefix = Buffer.from([0x04, 0x0b, ...Buffer.from("streamtype")]);
  const nsString = Buffer.from("NSString");
  const classMarker = Buffer.from([0x01, 0x94, 0x84, 0x01]);
  const textBuf = Buffer.from(text, "utf-8");
  let lengthBytes: Buffer;
  if (textBuf.length < 0x80) {
    lengthBytes = Buffer.from([textBuf.length]);
  } else {
    lengthBytes = Buffer.from([0x81, (textBuf.length >> 8) & 0xff, textBuf.length & 0xff]);
  }
  const marker = Buffer.from([0x2b]);
  return Buffer.concat([prefix, nsString, classMarker, marker, lengthBytes, textBuf]);
}

/**
 * Create a test chat.db with the core tables.
 */
function createTestDb(dbPath: string): Db {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT,
      country TEXT,
      service TEXT
    );

    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      style INTEGER,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT
    );

    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER DEFAULT 0,
      date INTEGER DEFAULT 0,
      is_from_me INTEGER DEFAULT 0,
      is_system_message INTEGER DEFAULT 0,
      service TEXT DEFAULT 'iMessage',
      cache_has_attachments INTEGER DEFAULT 0,
      associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0,
      associated_message_emoji TEXT,
      reply_to_guid TEXT,
      thread_originator_guid TEXT,
      group_title TEXT
    );

    CREATE TABLE chat_message_join (
      chat_id INTEGER,
      message_id INTEGER
    );

    CREATE TABLE chat_handle_join (
      chat_id INTEGER,
      handle_id INTEGER
    );

    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER DEFAULT 0
    );

    CREATE TABLE message_attachment_join (
      message_id INTEGER,
      attachment_id INTEGER
    );

  `);

  return db;
}

function insertHandle(db: Db, rowId: number, id: string, service = "iMessage") {
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(rowId, id, service);
}

function insertChat(
  db: Db,
  rowId: number,
  chatIdentifier: string,
  opts: { style?: number; displayName?: string; service?: string; handleIds?: number[] } = {},
) {
  db.prepare(
    "INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    rowId,
    `chat-${rowId}`,
    opts.style ?? 45,
    chatIdentifier,
    opts.service ?? "iMessage",
    opts.displayName ?? null,
  );
  // Wire chat_handle_join rows so the new handleCount-based isGroup
  // derivation can see this chat's participants. Tests opting into group
  // shape pass `handleIds: [1, 2, 3]`; 1-on-1 tests pass `[1]`.
  for (const handleId of opts.handleIds ?? []) {
    db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(
      rowId,
      handleId,
    );
  }
}

function insertMessage(
  db: Db,
  rowId: number,
  chatId: number,
  opts: {
    text?: string | null;
    attributedBody?: Buffer | null;
    handleId?: number;
    date?: number;
    isFromMe?: boolean;
    isSystemMessage?: boolean;
    service?: string;
    hasAttachments?: boolean;
    associatedMessageGuid?: string;
    associatedMessageType?: number;
    associatedMessageEmoji?: string;
    guid?: string;
  } = {},
) {
  const guid = opts.guid ?? `msg-${rowId}`;
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me,
       is_system_message, service, cache_has_attachments, associated_message_guid,
       associated_message_type, associated_message_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowId,
    guid,
    opts.text ?? null,
    opts.attributedBody ?? null,
    opts.handleId ?? 0,
    opts.date ?? DATE_2024_03_08_10AM,
    opts.isFromMe ? 1 : 0,
    opts.isSystemMessage ? 1 : 0,
    opts.service ?? "iMessage",
    opts.hasAttachments ? 1 : 0,
    opts.associatedMessageGuid ?? null,
    opts.associatedMessageType ?? 0,
    opts.associatedMessageEmoji ?? null,
  );
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(
    chatId,
    rowId,
  );
}

function insertAttachment(
  db: Db,
  attId: number,
  messageId: number,
  opts: {
    filename?: string;
    mimeType?: string;
    transferName?: string;
    totalBytes?: number;
    guid?: string;
  } = {},
) {
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    attId,
    opts.guid ?? `att-${attId}`,
    opts.filename ?? null,
    opts.mimeType ?? null,
    opts.transferName ?? null,
    opts.totalBytes ?? 0,
  );
  db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(
    messageId,
    attId,
  );
}

describe("AppleIMessageSource", () => {
  let tmpDir: string;
  let testDb: Db;
  let provider: AppleProvider;
  let source: AppleIMessageSource;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-imessage-test-"));
    const dbPath = join(tmpDir, "chat.db");
    testDb = createTestDb(dbPath);

    // Add a basic handle and chat
    insertHandle(testDb, 1, "+14085550123");
    insertHandle(testDb, 2, "friend@example.com");
    insertChat(testDb, 1, "+14085550123", { style: 43, handleIds: [1] });
    insertChat(testDb, 2, "chat-group-1", { style: 45, displayName: "Family", handleIds: [1, 2] });

    provider = new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent.sqlite"),
      remindersDirPath: join(tmpDir, "nonexistent-dir"),
      imessageDbPath: dbPath,
      accountId: "test@icloud.com",
    });
    await provider.initialize();
    await provider.authenticate();
    source = new AppleIMessageSource(provider, {
      sourceId: "apple-imessage:test@icloud.com",
      providerId: "apple:test@icloud.com",
    });
  });

  afterEach(async () => {
    testDb.close();
    await provider.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("apple-imessage:test@icloud.com"));
    expect(source.providerId).toBe(ProviderId("apple:test@icloud.com"));
  });

  test("returns empty result when no messages", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("syncs a single text message", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Hello there!",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toContain("+14085550123");
    expect(doc.title).toContain("2024-03-08");
    expect(doc.content).toContain("Hello there!");
    expect(doc.externalId).toBe("+14085550123:2024-03-08");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.extra?.messageCount).toBe(1);
  });

  test("extracts text from attributedBody when text is null", async () => {
    insertMessage(testDb, 1, 1, {
      text: null,
      attributedBody: buildAttributedBody("Body from attributed"),
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Body from attributed");
  });

  test("groups messages per-day-per-chat", async () => {
    // Same chat, same day → 1 document
    insertMessage(testDb, 1, 1, { text: "Hello", handleId: 1, date: DATE_2024_03_08_10AM });
    insertMessage(testDb, 2, 1, { text: "Hi!", isFromMe: true, date: DATE_2024_03_08_11AM });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Hello");
    expect(result.documents[0].content).toContain("Hi!");
    expect(result.documents[0].metadata.extra?.messageCount).toBe(2);
  });

  test("different chats produce different documents", async () => {
    insertMessage(testDb, 1, 1, { text: "Chat 1 msg", handleId: 1, date: DATE_2024_03_08_10AM });
    insertMessage(testDb, 2, 2, { text: "Chat 2 msg", handleId: 2, date: DATE_2024_03_08_10AM });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);

    const titles = result.documents.map((d) => d.title);
    expect(titles.some((t) => t.includes("+14085550123"))).toBe(true);
    expect(titles.some((t) => t.includes("Family"))).toBe(true);
  });

  test("two Mac stores converge on 1:1, group, and attachment identities despite different local row ids", async () => {
    testDb.prepare("UPDATE chat SET chat_identifier = ? WHERE ROWID = 2").run("cloud-group-chat");
    insertMessage(testDb, 100, 1, {
      guid: "cloud-message-one-to-one",
      text: "The fictional review is ready.",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });
    insertMessage(testDb, 200, 2, {
      guid: "cloud-message-group",
      text: "Please read the attached outline.",
      handleId: 2,
      date: DATE_2024_03_08_11AM,
      hasAttachments: true,
    });
    const firstAttachmentDir = join(tmpDir, "first-host");
    mkdirSync(firstAttachmentDir);
    const firstAttachmentPath = join(firstAttachmentDir, "outline.pdf");
    writeFileSync(firstAttachmentPath, "fictional outline");
    insertAttachment(testDb, 300, 200, {
      guid: "local-attachment-guid-a",
      filename: firstAttachmentPath,
      mimeType: "application/pdf",
      transferName: "outline.pdf",
      totalBytes: 2048,
    });

    const replicaPath = join(tmpDir, "chat-replica.db");
    const replicaDb = createTestDb(replicaPath);
    insertHandle(replicaDb, 101, "+14085550123");
    insertHandle(replicaDb, 202, "friend@example.com");
    insertChat(replicaDb, 110, "+14085550123", { style: 43, handleIds: [101] });
    insertChat(replicaDb, 220, "cloud-group-chat", {
      style: 45,
      displayName: "Family",
      handleIds: [101, 202],
    });
    insertMessage(replicaDb, 1100, 110, {
      guid: "cloud-message-one-to-one",
      text: "The fictional review is ready.",
      handleId: 101,
      date: DATE_2024_03_08_10AM,
    });
    insertMessage(replicaDb, 2200, 220, {
      guid: "cloud-message-group",
      text: "Please read the attached outline.",
      handleId: 202,
      date: DATE_2024_03_08_11AM,
      hasAttachments: true,
    });
    const secondAttachmentDir = join(tmpDir, "second-host");
    mkdirSync(secondAttachmentDir);
    const secondAttachmentPath = join(secondAttachmentDir, "outline.pdf");
    writeFileSync(secondAttachmentPath, "fictional outline");
    insertAttachment(replicaDb, 3300, 2200, {
      guid: "local-attachment-guid-b",
      filename: secondAttachmentPath,
      mimeType: "application/pdf",
      transferName: "outline.pdf",
      totalBytes: 2048,
    });
    const replicaProvider = new AppleProvider({
      notesDbPath: join(tmpDir, "nonexistent-notes-replica"),
      remindersDirPath: join(tmpDir, "nonexistent-reminders-replica"),
      imessageDbPath: replicaPath,
      accountId: "test@icloud.example",
    });
    const extractAttachment: AttachmentExtractFn = async () => ({
      text: "Extracted fictional outline",
      pages: 1,
      truncated: false,
    });
    const firstSource = new AppleIMessageSource(provider, {
      sourceId: "apple-imessage:test@icloud.example",
      providerId: "apple:test@icloud.example",
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
      extractAttachment,
    });
    try {
      await replicaProvider.initialize();
      await replicaProvider.authenticate();
      const replicaSource = new AppleIMessageSource(replicaProvider, {
        sourceId: "apple-imessage:test@icloud.example",
        providerId: "apple:test@icloud.example",
        attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
        extractAttachment,
      });
      try {
        // Cloud-synchronized identifiers and content are identical while
        // every SQLite-local primary key, foreign key, GUID, and path differs.
        const first = await firstSource.sync(null);
        const second = await replicaSource.sync(null);
        const byExternalId = <T extends { externalId: string }>(documents: T[]) =>
          [...documents].sort((a, b) => a.externalId.localeCompare(b.externalId));
        const firstDocuments = byExternalId(first.documents);
        const secondDocuments = byExternalId(second.documents);
        expect(secondDocuments).toEqual(firstDocuments);
        expect(firstDocuments.map((document) => document.externalId)).toEqual([
          "+14085550123:2024-03-08",
          "cloud-group-chat:2024-03-08",
          expect.stringMatching(/^cloud-group-chat:2024-03-08\/att\//),
        ]);
        expect([...(first.presentExternalIds ?? [])].sort()).toEqual(
          firstDocuments.map((document) => document.externalId),
        );
        expect([...(second.presentExternalIds ?? [])].sort()).toEqual(
          [...(first.presentExternalIds ?? [])].sort(),
        );
        expect(second.cursor).not.toEqual(first.cursor);
      } finally {
        replicaSource.dispose();
      }
    } finally {
      firstSource.dispose();
      replicaDb.close();
      await replicaProvider.disconnect();
    }
  });

  test("different days produce different documents", async () => {
    insertMessage(testDb, 1, 1, { text: "Day 1", handleId: 1, date: DATE_2024_03_08_10AM });
    insertMessage(testDb, 2, 1, { text: "Day 2", handleId: 1, date: DATE_2024_03_09_10AM });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.some((d) => d.externalId.includes("2024-03-08"))).toBe(true);
    expect(result.documents.some((d) => d.externalId.includes("2024-03-09"))).toBe(true);
  });

  test("incremental sync only returns new messages", async () => {
    insertMessage(testDb, 1, 1, { text: "Old msg", handleId: 1, date: DATE_2024_03_08_10AM });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // No new messages
    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);

    // Add a new message
    insertMessage(testDb, 2, 1, { text: "New msg", handleId: 1, date: DATE_2024_03_09_10AM });

    const r3 = await source.sync(r2.cursor);
    expect(r3.documents).toHaveLength(1);
    expect(r3.documents[0].content).toContain("New msg");
  });

  test("incremental sync re-emits full day document with new messages", async () => {
    insertMessage(testDb, 1, 1, { text: "First", handleId: 1, date: DATE_2024_03_08_10AM });

    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Add second message on same day
    insertMessage(testDb, 2, 1, { text: "Second", handleId: 1, date: DATE_2024_03_08_11AM });

    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    // The document should contain BOTH messages
    expect(r2.documents[0].content).toContain("First");
    expect(r2.documents[0].content).toContain("Second");
  });

  test("re-bootstraps when chat.db is rebuilt and ROWIDs regress", async () => {
    const dbPath = join(tmpDir, "chat.db");
    insertMessage(testDb, 5, 1, {
      text: "Before rebuild",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });

    const first = await source.sync(null);
    expect((first.cursor as { lastRowId: number }).lastRowId).toBe(5);

    testDb.close();
    rmSync(dbPath, { force: true });
    testDb = createTestDb(dbPath);
    insertHandle(testDb, 1, "+14085550123");
    insertHandle(testDb, 2, "friend@example.com");
    insertChat(testDb, 1, "+14085550123", { style: 43, handleIds: [1] });
    insertChat(testDb, 2, "chat-group-1", {
      style: 45,
      displayName: "Family",
      handleIds: [1, 2],
    });
    insertMessage(testDb, 1, 1, {
      text: "After rebuild",
      handleId: 1,
      date: DATE_2024_03_09_10AM,
    });

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0].content).toContain("After rebuild");
    expect((second.cursor as { lastRowId: number }).lastRowId).toBe(1);
  });

  test("re-probes optional message columns when chat.db is replaced", async () => {
    const dbPath = join(tmpDir, "chat.db");
    insertMessage(testDb, 5, 1, {
      text: "Before schema swap",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });

    const first = await source.sync(null);
    expect((first.cursor as { lastRowId: number }).lastRowId).toBe(5);

    testDb.close();
    rmSync(dbPath, { force: true });
    testDb = createTestDb(dbPath);
    insertHandle(testDb, 1, "+14085550123");
    insertChat(testDb, 1, "+14085550123", { style: 43, handleIds: [1] });
    insertMessage(testDb, 1, 1, {
      text: "After schema swap",
      handleId: 1,
      date: DATE_2024_03_09_10AM,
    });
    testDb.prepare("ALTER TABLE message DROP COLUMN cache_has_attachments").run();

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0].content).toContain("After schema swap");
  });

  test("renders from_me messages as 'You'", async () => {
    insertMessage(testDb, 1, 1, { text: "Sent by me", isFromMe: true, date: DATE_2024_03_08_10AM });

    const result = await source.sync(null);
    expect(result.documents[0].content).toContain("You: Sent by me");
  });

  test("renders attachments as placeholders", async () => {
    insertMessage(testDb, 1, 1, {
      text: null,
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      hasAttachments: true,
    });
    insertAttachment(testDb, 1, 1, {
      filename: "~/Library/Messages/Attachments/photo.jpg",
      mimeType: "image/jpeg",
      transferName: "IMG_001.jpg",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("[Image: IMG_001.jpg]");
  });

  test("uses attachment join rows even when cache_has_attachments is false", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Cache flag drift",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      hasAttachments: false,
    });
    insertAttachment(testDb, 1, 1, {
      filename: "~/Library/Messages/Attachments/photo.jpg",
      mimeType: "image/jpeg",
      transferName: "IMG_002.jpg",
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("[Image: IMG_002.jpg]");
  });

  describe("inline audio transcription", () => {
    /** Write a fake audio clip on disk and insert a chat.db audio attachment pointing at it. */
    function insertAudioMessage(audioPath: string): void {
      writeFileSync(audioPath, Buffer.from("fake-audio-bytes"));
      insertMessage(testDb, 1, 1, {
        text: null,
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: audioPath,
        mimeType: "audio/x-caf",
        transferName: "Audio Message.caf",
        totalBytes: 16,
      });
    }

    test("transcribes a voice clip and renders it inline in the conversation", async () => {
      const audioPath = join(tmpDir, "clip.caf");
      insertAudioMessage(audioPath);

      const transcribeAudio = vi.fn(async () => ({ text: "Running ten late", durationSec: 42 }));
      const src = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        transcribeAudio,
        configDir: tmpDir,
      });

      const result = await src.sync(null);
      expect(transcribeAudio).toHaveBeenCalledOnce();
      expect(result.documents[0].content).toContain("[Audio, 0:42]: Running ten late");
      src.dispose();
    });

    test("keeps the placeholder when no transcriber is wired (STT off)", async () => {
      const audioPath = join(tmpDir, "clip.caf");
      insertAudioMessage(audioPath);

      const result = await source.sync(null);
      expect(result.documents[0].content).toContain("[Audio: Audio Message.caf]");
    });

    test("a second sync reuses the persisted transcript and does not re-transcribe", async () => {
      const audioPath = join(tmpDir, "clip.caf");
      insertAudioMessage(audioPath);

      const transcribeAudio = vi.fn(async () => ({ text: "cached words", durationSec: 10 }));

      // First instance transcribes and persists to the sidecar under tmpDir.
      const first = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        transcribeAudio,
        configDir: tmpDir,
      });
      const firstResult = await first.sync(null);
      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      expect(firstResult.documents[0].content).toContain("[Audio, 0:10]: cached words");
      first.dispose();

      // A fresh instance sharing the same configDir hits the sidecar — no
      // second transcriber call, same rendered transcript.
      const second = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        transcribeAudio,
        configDir: tmpDir,
      });
      const secondResult = await second.sync(null);
      expect(transcribeAudio).toHaveBeenCalledTimes(1); // not called again
      expect(secondResult.documents[0].content).toContain("[Audio, 0:10]: cached words");
      second.dispose();
    });

    test("audio is not emitted as an attachment child-doc (handled inline only)", async () => {
      const audioPath = join(tmpDir, "clip.caf");
      insertAudioMessage(audioPath);

      const transcribeAudio = vi.fn(async () => ({ text: "spoken", durationSec: 5 }));
      // Even with attachment extraction enabled and an extractor wired, audio
      // must not produce a child doc — its types are kept out of the allow-list
      // for a conversation source.
      const extractAttachment: AttachmentExtractFn = vi.fn(async () => ({
        text: "should not run for audio",
        truncated: false,
      }));
      const src = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        extractAttachment,
        transcribeAudio,
        configDir: tmpDir,
      });

      const result = await src.sync(null);
      // Exactly one doc: the conversation. No attachment child doc for the audio.
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
      expect(extractAttachment).not.toHaveBeenCalled();
      src.dispose();
    });
  });

  test("renders tapback reactions", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Great news!",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      guid: "original-guid",
    });
    insertMessage(testDb, 2, 1, {
      text: 'Loved "Great news!"',
      isFromMe: true,
      date: DATE_2024_03_08_11AM,
      associatedMessageGuid: "p:0/original-guid",
      associatedMessageType: 2000,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Great news!");
    expect(result.documents[0].content).toContain("→ You Loved");
    // Tapback should not be counted as a regular message
    expect(result.documents[0].metadata.extra?.messageCount).toBe(1);
  });

  test("renders emoji tapbacks", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Check this",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      guid: "orig",
    });
    insertMessage(testDb, 2, 1, {
      text: 'Reacted ❤️ to "Check this"',
      handleId: 2,
      date: DATE_2024_03_08_11AM,
      associatedMessageGuid: "orig",
      associatedMessageType: 2006,
      associatedMessageEmoji: "❤️",
    });

    const result = await source.sync(null);
    expect(result.documents[0].content).toContain("→");
    expect(result.documents[0].content).toContain("❤️");
  });

  test("skips tapback removal messages", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Hello",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      guid: "g1",
    });
    // Tapback removal (type 3000)
    insertMessage(testDb, 2, 1, {
      text: "",
      isFromMe: true,
      date: DATE_2024_03_08_11AM,
      associatedMessageGuid: "p:0/g1",
      associatedMessageType: 3000,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    // Should not render the removal
    expect(result.documents[0].content).not.toContain("→");
  });

  test("tapback removal cancels an earlier tapback on incremental sync", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Decision approved",
      handleId: 1,
      date: DATE_2024_03_08_10AM,
      guid: "decision-guid",
    });
    insertMessage(testDb, 2, 1, {
      text: 'Liked "Decision approved"',
      handleId: 2,
      date: DATE_2024_03_08_11AM,
      associatedMessageGuid: "p:0/decision-guid",
      associatedMessageType: 2001,
    });

    const first = await source.sync(null);
    expect(first.documents[0].content).toContain("→ friend@example.com Liked");

    insertMessage(testDb, 3, 1, {
      text: "",
      handleId: 2,
      date: DATE_2024_03_08_11AM + 1_000_000_000,
      associatedMessageGuid: "p:0/decision-guid",
      associatedMessageType: 3001,
    });

    const second = await source.sync(first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0].content).toContain("Decision approved");
    expect(second.documents[0].content).not.toContain("→");
  });

  test("cross-day tapbacks render on the target message day only", async () => {
    insertMessage(testDb, 1, 1, {
      text: "Friday plan",
      handleId: 1,
      date: DATE_2024_03_08_11AM,
      guid: "friday-plan",
    });
    insertMessage(testDb, 2, 1, {
      text: 'Loved "Friday plan"',
      isFromMe: true,
      date: DATE_2024_03_09_10AM,
      associatedMessageGuid: "p:0/friday-plan",
      associatedMessageType: 2000,
    });

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("+14085550123:2024-03-08");
    expect(result.documents[0].content).toContain("→ You Loved");
  });

  test("renders system messages in italics", async () => {
    insertMessage(testDb, 1, 2, {
      text: "Alice named the conversation",
      isSystemMessage: true,
      date: DATE_2024_03_08_10AM,
    });

    const result = await source.sync(null);
    expect(result.documents[0].content).toContain("_Alice named the conversation_");
  });

  test("group chat shows display name", async () => {
    insertMessage(testDb, 1, 2, { text: "Hey everyone", handleId: 2, date: DATE_2024_03_08_10AM });

    const result = await source.sync(null);
    expect(result.documents[0].title).toContain("Family");
    expect(result.documents[0].content).toContain("**Group:** Family");
    expect(result.documents[0].metadata.extra?.isGroup).toBe(true);
  });

  test("group chat deep link opens the existing conversation at the day's message", async () => {
    // A roster-addressed link would start a new message; the message guid
    // read from chat.db opens the group itself.
    insertHandle(testDb, 20, "+14085550123");
    insertHandle(testDb, 21, "maya.reeves@example.com");
    insertChat(testDb, 20, "northstar-group", {
      style: 43,
      displayName: "Project Northstar",
      handleIds: [20, 21],
    });
    insertMessage(testDb, 200, 20, {
      text: "Kickoff tomorrow",
      handleId: 20,
      date: DATE_2024_03_08_10AM + 3_000_000_000,
    });

    const result = await source.sync(null);
    const group = result.documents.find((d) => d.title.includes("Project Northstar"));
    expect(group).toBeDefined();
    expect(group!.metadata.sourceUrl).toBe("messages://open?message-guid=msg-200");
  });

  test("group chat people metadata includes silent roster members", async () => {
    insertHandle(testDb, 30, "sarah.mendez@example.com");
    insertHandle(testDb, 31, "jamie.lopez@example.com");
    insertChat(testDb, 30, "quiet-roster-group", {
      style: 43,
      displayName: "planning sync",
      handleIds: [30, 31],
    });
    insertMessage(testDb, 300, 30, {
      text: "Only one person spoke",
      handleId: 30,
      date: DATE_2024_03_08_10AM + 4_000_000_000,
    });

    const result = await source.sync(null);
    const group = result.documents.find((d) => d.title.includes("planning sync"));
    expect(group).toBeDefined();
    expect(group!.metadata.extra?.participantHandles).toEqual([
      "jamie.lopez@example.com",
      "sarah.mendez@example.com",
    ]);
    const people = group!.metadata.people ?? [];
    expect(people.some((p) => p.emails?.includes("jamie.lopez@example.com"))).toBe(true);
    expect(people.some((p) => p.emails?.includes("sarah.mendez@example.com"))).toBe(true);
  });

  test("isGroup is derived from handle_count, not chat.style (regression for inverted-style macOS)", async () => {
    // Reproduces apple-imessage-chat-style-mapping-inverted: macOS 25.3
    // chat.db ships with style=45 meaning 1-on-1 (opposite of historical
    // documentation). Build two chats whose `style` lies but whose
    // chat_handle_join sizes are honest.
    insertHandle(testDb, 10, "+14085550167");
    insertHandle(testDb, 11, "alice@icloud.com");
    insertHandle(testDb, 12, "friend@example.com");
    // Style=45 but only one handle → must be a 1-on-1 (the user's
    // observed reality on macOS 25.3).
    insertChat(testDb, 10, "+14085550167", { style: 45, handleIds: [10] });
    // Style=43 but multiple handles → must be a group (the inverse case).
    insertChat(testDb, 11, "lab-group", {
      style: 43,
      displayName: "Lab",
      handleIds: [11, 12],
    });
    insertMessage(testDb, 100, 10, {
      text: "Hi",
      handleId: 10,
      date: DATE_2024_03_08_10AM + 1_000_000_000,
    });
    insertMessage(testDb, 101, 11, {
      text: "Group hi",
      handleId: 11,
      date: DATE_2024_03_08_10AM + 2_000_000_000,
    });

    const result = await source.sync(null);
    const oneOnOne = result.documents.find((d) => d.title.includes("+14085550167"));
    const group = result.documents.find((d) => d.title.includes("Lab"));
    expect(oneOnOne).toBeDefined();
    expect(group).toBeDefined();
    expect(oneOnOne!.metadata.extra?.isGroup).toBe(false);
    expect(group!.metadata.extra?.isGroup).toBe(true);
  });

  test("reports bootstrap progress", async () => {
    insertMessage(testDb, 1, 1, { text: "Msg", handleId: 1, date: DATE_2024_03_08_10AM });

    const result = await source.sync(null);
    expect(result.progress?.phase).toBe("bootstrap");
    expect(result.progress?.total).toBe(1);
    // The message-retention setting can prune chat.db without a trace this
    // source can read,
    // so it can never vouch for its own history — every round says so.
    expect(result.progress?.coverage).toBe("unknown");

    // No new messages → no queue, but coverage is still reported.
    const r2 = await source.sync(result.cursor);
    expect(r2.progress?.phase).toBe("incremental");
    expect(r2.progress?.processed).toBe(0);
    expect(r2.progress?.total).toBeUndefined();
    expect(r2.progress?.coverage).toBe("unknown");
  });

  test("reports incremental progress when new messages arrive", async () => {
    insertMessage(testDb, 1, 1, { text: "First", handleId: 1, date: DATE_2024_03_08_10AM });

    const r1 = await source.sync(null);

    // New message after the cursor watermark.
    insertMessage(testDb, 2, 1, {
      text: "Second",
      handleId: 1,
      date: DATE_2024_03_08_10AM + 1_000_000_000,
    });

    const r2 = await source.sync(r1.cursor);
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.total).toBe(1);
    expect(r2.progress!.coverage).toBe("unknown");
  });

  test("handles messages with both text and attributedBody", async () => {
    // When both exist, text column takes precedence
    insertMessage(testDb, 1, 1, {
      text: "Text column",
      attributedBody: buildAttributedBody("Attributed column"),
      handleId: 1,
      date: DATE_2024_03_08_10AM,
    });

    const result = await source.sync(null);
    expect(result.documents[0].content).toContain("Text column");
  });

  test("skips orphaned messages without chat", async () => {
    // Insert message without chat_message_join
    testDb
      .prepare(
        `INSERT INTO message (ROWID, guid, text, date, is_from_me, service, associated_message_type)
       VALUES (99, 'orphan', 'orphaned msg', ?, 0, 'iMessage', 0)`,
      )
      .run(DATE_2024_03_08_10AM);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
  });

  describe("attachment extraction", () => {
    let attTmpDir: string;
    let mockExtract: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      attTmpDir = mkdtempSync(join(tmpdir(), "imessage-att-"));
    });

    afterEach(() => {
      rmSync(attTmpDir, { recursive: true, force: true });
    });

    function createAttSource(extractFn?: AttachmentExtractFn) {
      return new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
        extractAttachment: extractFn,
      });
    }

    test("extracts PDF and creates separate attachment document", async () => {
      const pdfPath = join(attTmpDir, "report.pdf");
      writeFileSync(pdfPath, "fake pdf content");

      insertMessage(testDb, 1, 1, {
        text: "Here's the report",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "report.pdf",
        totalBytes: 1024,
      });

      mockExtract = vi.fn(async () => ({ text: "Extracted PDF text", pages: 3, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(2);
      const convDoc = result.documents.find((d) => d.metadata.documentType === "conversation");
      const attDoc = result.documents.find((d) => d.metadata.documentType === "attachment");

      expect(convDoc).toBeDefined();
      expect(attDoc).toBeDefined();
      expect(attDoc!.title).toBe("report.pdf");
      expect(attDoc!.content).toBe("Extracted PDF text");
      expect(attDoc!.metadata.extra?.parentExternalId).toBe(convDoc!.externalId);
      expect(attDoc!.metadata.extra?.mimeType).toBe("application/pdf");
      expect(attDoc!.metadata.extra?.pages).toBe(3);
    });

    test("dates each attachment by the message that carried it, not by the day", async () => {
      // The parent is a whole day of chat, so its timestamps bound the day and
      // say nothing about when any one file was sent. Two files hours apart
      // must stay hours apart, or nothing downstream can tell which is the
      // later — and therefore the current — piece of evidence.
      const morningPath = join(attTmpDir, "morning.pdf");
      const eveningPath = join(attTmpDir, "evening.pdf");
      writeFileSync(morningPath, "fake pdf content");
      writeFileSync(eveningPath, "other pdf content");

      insertMessage(testDb, 1, 1, {
        text: "First",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: morningPath,
        mimeType: "application/pdf",
        transferName: "morning.pdf",
        totalBytes: 1024,
      });
      insertMessage(testDb, 2, 1, {
        text: "Later",
        handleId: 1,
        date: DATE_2024_03_08_11AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 2, 2, {
        filename: eveningPath,
        mimeType: "application/pdf",
        transferName: "evening.pdf",
        totalBytes: 2048,
      });

      const attSource = createAttSource(
        vi.fn(async () => ({ text: "Extracted text", truncated: false })) as AttachmentExtractFn,
      );
      const result = await attSource.sync(null);
      const atts = result.documents.filter((d) => d.metadata.documentType === "attachment");
      expect(atts).toHaveLength(2);

      const morning = atts.find((d) => d.title === "morning.pdf")!;
      const evening = atts.find((d) => d.title === "evening.pdf")!;
      expect(morning.sourceCreatedAt).toBe("2024-03-08T10:00:00.000Z");
      expect(evening.sourceCreatedAt).toBe("2024-03-08T11:00:00.000Z");
      // Pinned to its own send time, so a later message extending the day
      // cannot rewrite an attachment sent earlier in it.
      expect(evening.sourceUpdatedAt).toBe("2024-03-08T11:00:00.000Z");
      expect(morning.sourceUpdatedAt).toBe("2024-03-08T10:00:00.000Z");
    });

    test("snapshot reconciliation includes extracted attachment child documents", async () => {
      const pdfPath = join(attTmpDir, "brief.pdf");
      writeFileSync(pdfPath, "fake pdf content");

      insertMessage(testDb, 1, 1, {
        text: "Here's the brief",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "brief.pdf",
        totalBytes: 2048,
      });

      mockExtract = vi.fn(async () => ({ text: "Extracted brief", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);
      const attachmentDoc = result.documents.find((d) => d.metadata.documentType === "attachment");

      expect(attachmentDoc).toBeDefined();
      expect(result.presentExternalIds).toContain("+14085550123:2024-03-08");
      expect(result.presentExternalIds).toContain(attachmentDoc!.externalId);
    });

    test("retries extraction when an iMessage attachment file appears after the row", async () => {
      const pdfPath = join(attTmpDir, "late.pdf");

      insertMessage(testDb, 1, 1, {
        text: "File is still downloading",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "late.pdf",
        totalBytes: 64,
      });

      mockExtract = vi.fn(async () => ({
        text: "Late extracted text",
        pages: 1,
        truncated: false,
      }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const first = await attSource.sync(null);
      expect(first.documents).toHaveLength(1);
      expect(mockExtract).not.toHaveBeenCalled();
      expect(first.documents[0].metadata.extra?.attachments).toEqual([
        expect.objectContaining({ filename: "late.pdf", reason: "download-failed" }),
      ]);

      writeFileSync(pdfPath, "now local");

      const second = await attSource.sync(first.cursor);
      expect(second.documents).toHaveLength(2);
      expect(mockExtract).toHaveBeenCalledOnce();
      const attachmentDoc = second.documents.find((d) => d.metadata.documentType === "attachment");
      expect(attachmentDoc?.content).toBe("Late extracted text");
    });

    test("skips extraction when disabled (default config)", async () => {
      insertMessage(testDb, 1, 1, {
        text: "With attachment",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: "/tmp/fake.pdf",
        mimeType: "application/pdf",
        transferName: "fake.pdf",
        totalBytes: 100,
      });

      // Default source — no extraction config
      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
    });

    test("handles missing file gracefully", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Missing file",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: "/nonexistent/path/report.pdf",
        mimeType: "application/pdf",
        transferName: "report.pdf",
        totalBytes: 1024,
      });

      mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const doc = result.documents[0];
      expect(doc.metadata.documentType).toBe("conversation");
      const atts = doc.metadata.extra?.attachments as any[];
      expect(atts).toBeDefined();
      expect(atts[0].reason).toBe("download-failed");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("skips unsupported MIME types", async () => {
      const clipPath = join(attTmpDir, "clip.mp4");
      writeFileSync(clipPath, "fake video");

      insertMessage(testDb, 1, 1, {
        text: "Video",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: clipPath,
        mimeType: "video/mp4",
        transferName: "clip.mp4",
        totalBytes: 5000,
      });

      mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("type-excluded");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("skips oversized attachments", async () => {
      const pdfPath = join(attTmpDir, "huge.pdf");
      writeFileSync(pdfPath, "x");

      insertMessage(testDb, 1, 1, {
        text: "Huge file",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "huge.pdf",
        totalBytes: 100_000_000, // 100MB
      });

      mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("too-large");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("handles null mimeType", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Unknown type",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: "/tmp/whatever",
        transferName: "mystery.bin",
        totalBytes: 100,
        // no mimeType
      });

      mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("type-excluded");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("expands ~ in file paths", async () => {
      // Create a temp file in the actual home directory
      const subDir = join(homedir(), ".omnesis-test-tmp");
      mkdirSync(subDir, { recursive: true });
      const pdfPath = join(subDir, "test.pdf");
      writeFileSync(pdfPath, "pdf content");

      try {
        const tildeFilename = `~/.omnesis-test-tmp/test.pdf`;
        insertMessage(testDb, 1, 1, {
          text: "Tilde path",
          handleId: 1,
          date: DATE_2024_03_08_10AM,
          hasAttachments: true,
        });
        insertAttachment(testDb, 1, 1, {
          filename: tildeFilename,
          mimeType: "application/pdf",
          transferName: "test.pdf",
          totalBytes: 512,
        });

        mockExtract = vi.fn(async () => ({ text: "Extracted", pages: 1, truncated: false }));
        const attSource = createAttSource(mockExtract as AttachmentExtractFn);
        const result = await attSource.sync(null);

        expect(result.documents).toHaveLength(2);
        expect(mockExtract).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(subDir, { recursive: true, force: true });
      }
    });

    test("multiple attachments from different messages", async () => {
      const pdf1 = join(attTmpDir, "doc1.pdf");
      const pdf2 = join(attTmpDir, "doc2.pdf");
      writeFileSync(pdf1, "pdf 1");
      writeFileSync(pdf2, "pdf 2");

      insertMessage(testDb, 1, 1, {
        text: "First msg",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdf1,
        mimeType: "application/pdf",
        transferName: "doc1.pdf",
        totalBytes: 500,
      });

      insertMessage(testDb, 2, 1, {
        text: "Second msg",
        handleId: 1,
        date: DATE_2024_03_08_11AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 2, 2, {
        filename: pdf2,
        mimeType: "application/pdf",
        transferName: "doc2.pdf",
        totalBytes: 600,
      });

      mockExtract = vi.fn(async () => ({ text: "Extracted text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(3); // 1 conversation + 2 attachments
      const attDocs = result.documents.filter((d) => d.metadata.documentType === "attachment");
      expect(attDocs).toHaveLength(2);
      expect(mockExtract).toHaveBeenCalledTimes(2);
    });

    test("parent doc includes attachment markers", async () => {
      const pdfPath = join(attTmpDir, "report.pdf");
      writeFileSync(pdfPath, "content");

      insertMessage(testDb, 1, 1, {
        text: "Check this",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "report.pdf",
        totalBytes: 1024,
      });

      mockExtract = vi.fn(async () => ({ text: "Text", pages: 1, truncated: false }));
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      const convDoc = result.documents.find((d) => d.metadata.documentType === "conversation")!;
      expect(convDoc.content).toContain("**Attachments:**");
      expect(convDoc.content).toContain("report.pdf");
      expect(convDoc.content).toContain("PDF");
      expect(convDoc.content).toContain("1KB");
    });

    test("extraction failure logged and skipped", async () => {
      const pdfPath = join(attTmpDir, "bad.pdf");
      writeFileSync(pdfPath, "corrupt");

      insertMessage(testDb, 1, 1, {
        text: "Bad file",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: pdfPath,
        mimeType: "application/pdf",
        transferName: "bad.pdf",
        totalBytes: 100,
      });

      mockExtract = vi.fn(async () => null);
      const attSource = createAttSource(mockExtract as AttachmentExtractFn);
      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("extraction-failed");
      expect(atts[0].extracted).toBe(false);
    });

    test("records successful OCR with no text without creating an attachment document", async () => {
      const imagePath = join(attTmpDir, "blank.png");
      writeFileSync(imagePath, "image data");
      insertMessage(testDb, 1, 1, {
        text: "Attached image",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: imagePath,
        mimeType: "image/png",
        transferName: "blank.png",
        totalBytes: 100,
      });

      mockExtract = vi.fn(() =>
        Promise.resolve({ text: "", truncated: false, noText: true as const }),
      );
      const result = await createAttSource(mockExtract as AttachmentExtractFn).sync(null);

      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0]).toMatchObject({
        filename: "blank.png",
        extracted: false,
        reason: "no-text",
      });
    });
  });

  describe("dataCutoff", () => {
    test("excludes messages sent before the cutoff", async () => {
      // Message on 2024-03-08 (before cutoff)
      insertMessage(testDb, 1, 1, {
        text: "Old message",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });
      // Message on 2024-03-09 (at or after cutoff)
      insertMessage(testDb, 2, 1, {
        text: "New message",
        handleId: 1,
        date: DATE_2024_03_09_10AM,
      });

      const cutoffSource = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("New message");
      expect(result.documents[0].content).not.toContain("Old message");
    });

    test("includes all messages when no cutoff is set", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Old message",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });
      insertMessage(testDb, 2, 1, {
        text: "New message",
        handleId: 1,
        date: DATE_2024_03_09_10AM,
      });

      const result = await source.sync(null);
      // Both messages produce documents (two different days)
      expect(result.documents).toHaveLength(2);
    });

    test("advances cursor past filtered-out messages", async () => {
      // Two old messages before cutoff
      insertMessage(testDb, 1, 1, {
        text: "Old 1",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });
      insertMessage(testDb, 2, 1, {
        text: "Old 2",
        handleId: 1,
        date: DATE_2024_03_08_11AM,
      });

      const cutoffSource = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(0);
      // Cursor should have advanced past row 2 even though messages were filtered
      const cursor = result.cursor as { lastRowId: number };
      expect(cursor.lastRowId).toBe(2);
    });

    test("bootstrap bumps cursor past pre-cutoff rows in one shot, no walk", async () => {
      // 5 old messages, 1 recent. Without the cutoff bump, bootstrap paged through all 6
      // ROWIDs even though only 1 produced a doc. With the cutoff bump,
      // ROWIDs 1..5 are skipped and the fetch starts from ROWID 6.
      for (let i = 1; i <= 5; i++) {
        insertMessage(testDb, i, 1, {
          text: `Old ${i}`,
          handleId: 1,
          date: DATE_2024_03_08_10AM,
        });
      }
      insertMessage(testDb, 6, 1, {
        text: "Recent",
        handleId: 1,
        date: DATE_2024_03_09_10AM,
      });

      const cutoffSource = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("Recent");
      // Cursor lands on the recent message's ROWID — proof the bump
      // didn't skip past anything within the post-cutoff range.
      const cursor = result.cursor as { lastRowId: number };
      expect(cursor.lastRowId).toBe(6);
    });

    test("cutoff bootstrap does not skip lower-ROWID recent messages when old rows were restored later", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Recent but low rowid",
        handleId: 1,
        date: DATE_2024_03_09_10AM,
      });
      insertMessage(testDb, 2, 1, {
        text: "Restored old row",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });

      const cutoffSource = new AppleIMessageSource(provider, {
        sourceId: "apple-imessage:test@icloud.com",
        providerId: "apple:test@icloud.com",
        dataCutoff: "2024-03-09T00:00:00Z",
      });
      const result = await cutoffSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("Recent but low rowid");
      expect(result.documents[0].content).not.toContain("Restored old row");
      const cursor = result.cursor as { lastRowId: number };
      expect(cursor.lastRowId).toBe(2);
    });
  });

  describe("snapshot reconciliation", () => {
    test("emits presentExternalIds covering every (chat, day) pair on bootstrap completion", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Mar 8 morning",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });
      insertMessage(testDb, 2, 1, {
        text: "Mar 8 evening",
        handleId: 1,
        date: DATE_2024_03_08_11AM,
      });
      insertMessage(testDb, 3, 2, { text: "Mar 9 group", handleId: 2, date: DATE_2024_03_09_10AM });

      const result = await source.sync(null);
      expect(result.hasMore).toBe(false);
      // 3 messages → 2 day-keys (chat 1: Mar 8, chat 2: Mar 9).
      expect(result.issues).toEqual([]);
      // Mar 8 has 2 messages but they collapse into one (chat, date) pair.
      expect(result.presentExternalIds?.sort()).toEqual([
        "+14085550123:2024-03-08",
        "chat-group-1:2024-03-09",
      ]);
    });

    test("hard-deleted messages drop from the snapshot — gateway will reconcile the day-doc", async () => {
      insertMessage(testDb, 1, 1, { text: "Keep", handleId: 1, date: DATE_2024_03_08_10AM });
      insertMessage(testDb, 2, 1, { text: "Doomed", handleId: 1, date: DATE_2024_03_09_10AM });

      const first = await source.sync(null);
      expect(first.presentExternalIds?.sort()).toEqual([
        "+14085550123:2024-03-08",
        "+14085550123:2024-03-09",
      ]);

      // iMessage hard-deletes the row entirely on permanent delete.
      testDb.prepare("DELETE FROM message WHERE ROWID = 2").run();
      testDb.prepare("DELETE FROM chat_message_join WHERE message_id = 2").run();

      // The tail ROWID regressed, so the source re-bootstraps and re-emits
      // the surviving day while the snapshot omits the deleted day.
      const second = await source.sync(first.cursor);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0].content).toContain("Keep");
      expect(second.presentExternalIds).toEqual(["+14085550123:2024-03-08"]);
    });

    test("deleting one message from a non-empty day re-emits the changed day document", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Keep this",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });
      insertMessage(testDb, 2, 1, {
        text: "Remove this",
        handleId: 1,
        date: DATE_2024_03_08_11AM,
      });

      const first = await source.sync(null);
      expect(first.documents[0].content).toContain("Remove this");

      testDb.prepare("DELETE FROM message WHERE ROWID = 2").run();
      testDb.prepare("DELETE FROM chat_message_join WHERE message_id = 2").run();

      const second = await source.sync(first.cursor);
      expect(second.presentExternalIds).toEqual(["+14085550123:2024-03-08"]);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0].content).toContain("Keep this");
      expect(second.documents[0].content).not.toContain("Remove this");
      expect(second.documents[0].metadata.extra?.messageCount).toBe(1);
    });

    test("editing an existing message row re-emits the changed day document without a new ROWID", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Draft wording",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });

      const first = await source.sync(null);
      expect(first.documents[0].content).toContain("Draft wording");

      testDb.prepare("UPDATE message SET text = ? WHERE ROWID = 1").run("Edited wording");

      const second = await source.sync(first.cursor);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0].content).toContain("Edited wording");
      expect(second.documents[0].content).not.toContain("Draft wording");
    });

    test("legacy cursors without day signatures re-emit current day documents once", async () => {
      insertMessage(testDb, 1, 1, {
        text: "Before upgrade",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
      });

      const first = await source.sync(null);
      testDb.prepare("UPDATE message SET text = ? WHERE ROWID = 1").run("After upgrade");
      const { lastDaySignatures: _lastDaySignatures, ...legacyCursor } = first.cursor as {
        lastRowId: number;
        lastSnapshotSignature?: string;
        lastDaySignatures?: Record<string, string>;
      };

      const second = await source.sync(legacyCursor);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0].content).toContain("After upgrade");
      expect(second.documents[0].content).not.toContain("Before upgrade");
      expect(
        (second.cursor as { lastDaySignatures?: Record<string, string> }).lastDaySignatures,
      ).toBeDefined();
    });

    test("group roster changes re-emit the changed day document without a new message ROWID", async () => {
      insertHandle(testDb, 40, "sarah.mendez@example.com");
      insertHandle(testDb, 41, "jamie.lopez@example.com");
      insertHandle(testDb, 42, "david.lin@example.com");
      insertChat(testDb, 40, "snapshot-roster-group", {
        style: 43,
        displayName: "release planning",
        handleIds: [40, 41],
      });
      insertMessage(testDb, 40, 40, {
        text: "Initial roster",
        handleId: 40,
        date: DATE_2024_03_08_10AM,
      });

      const first = await source.sync(null);
      expect(first.documents[0].metadata.extra?.participantHandles).toEqual([
        "jamie.lopez@example.com",
        "sarah.mendez@example.com",
      ]);

      testDb.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(40, 42);

      const second = await source.sync(first.cursor);
      const group = second.documents.find(
        (doc) => doc.externalId === "snapshot-roster-group:2024-03-08",
      );
      expect(group).toBeDefined();
      expect(group!.metadata.extra?.participantHandles).toEqual([
        "david.lin@example.com",
        "jamie.lopez@example.com",
        "sarah.mendez@example.com",
      ]);
    });

    test("attachment metadata changes re-emit the changed day document without a new message ROWID", async () => {
      insertMessage(testDb, 1, 1, {
        text: "See attachment",
        handleId: 1,
        date: DATE_2024_03_08_10AM,
        hasAttachments: true,
      });
      insertAttachment(testDb, 1, 1, {
        filename: "~/Library/Messages/Attachments/report.pdf",
        mimeType: "application/pdf",
        transferName: "old-name.pdf",
        totalBytes: 100,
      });

      const first = await source.sync(null);
      expect(first.documents[0].content).toContain("[PDF: old-name.pdf]");

      testDb.prepare("UPDATE attachment SET transfer_name = ? WHERE ROWID = 1").run("new-name.pdf");

      const second = await source.sync(first.cursor);
      expect(second.documents).toHaveLength(1);
      expect(second.documents[0].content).toContain("[PDF: new-name.pdf]");
      expect(second.documents[0].content).not.toContain("[PDF: old-name.pdf]");
    });

    test("paginated bootstrap (hasMore=true) does NOT emit presentExternalIds", async () => {
      // Force pagination: PAGE_SIZE = 500. Insert 501.
      // Seeding runs in a single transaction: each bare INSERT would otherwise
      // commit (and fsync) on its own, which costs tens of seconds for 501 rows.
      testDb.transaction(() => {
        for (let i = 1; i <= 501; i++) {
          insertMessage(testDb, i, 1, {
            text: `m${i}`,
            handleId: 1,
            // One minute apart, so the whole run lands on a single day and the
            // count of distinct day keys differs from the message count.
            date: DATE_2024_03_08_10AM + i * 60 * 1_000_000_000,
          });
        }
      })();

      const r1 = await source.sync(null);
      expect(r1.hasMore).toBe(true);
      expect(r1.presentExternalIds).toBeUndefined();

      const r2 = await source.sync(r1.cursor);
      expect(r2.hasMore).toBe(false);
      expect(r2.presentExternalIds).toBeDefined();
      expect(r2.presentExternalIds!.length).toBeGreaterThan(0);
    });

    test("system-only days stay in the snapshot because the source emits them", async () => {
      insertMessage(testDb, 1, 1, { text: "Real", handleId: 1, date: DATE_2024_03_08_10AM });
      insertMessage(testDb, 2, 1, {
        text: "System",
        handleId: 1,
        date: DATE_2024_03_09_10AM,
        isSystemMessage: true,
      });

      const result = await source.sync(null);
      expect(result.presentExternalIds?.sort()).toEqual([
        "+14085550123:2024-03-08",
        "+14085550123:2024-03-09",
      ]);
    });
  });
});
