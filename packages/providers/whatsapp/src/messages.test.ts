// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import { WhatsAppMessagesSource } from "./messages.js";
import { MessageStore } from "./message-store.js";
import type { MediaDownloadFn, WhatsAppMessagesSourceOptions } from "./messages.js";
import type { StoredMessage } from "./types.js";
import type { AttachmentExtractFn } from "@omnesis/core";

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "msg-1",
    chatJid: "1234@s.whatsapp.net",
    senderJid: "1234@s.whatsapp.net",
    senderName: "Alice",
    fromMe: false,
    timestamp: 1709900000,
    type: "text",
    text: "Hello",
    ...overrides,
  };
}

describe("WhatsAppMessagesSource", () => {
  let store: MessageStore;
  let source: WhatsAppMessagesSource;

  beforeEach(() => {
    store = new MessageStore();
    source = new WhatsAppMessagesSource(store);
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("whatsapp-messages"));
    expect(source.providerId).toBe(ProviderId("whatsapp"));
  });

  test.each(["foreign", "legacy"])(
    "a %s cursor cannot acknowledge this archive's pending page",
    async (kind) => {
      store.addMessages([makeMsg()]);
      const first = await source.sync(null);
      const cursor = { ...first.cursor };
      if (kind === "legacy") delete cursor.storeId;
      else cursor.storeId = "another-archive";
      const replay = await source.sync(cursor);
      expect(replay.documents).toEqual(first.documents);
      expect(replay.cursor.storeId).toBe(store.storeId);
      const confirmed = await source.sync(replay.cursor);
      expect(confirmed.documents).toEqual([]);
    },
  );

  test("a failed post replays its page using the last confirmed archive cursor", async () => {
    const confirmed = await source.sync(null);
    store.addMessages([makeMsg()]);
    const failed = await source.sync(confirmed.cursor);
    const replay = await source.sync(confirmed.cursor);
    expect(replay.documents).toEqual(failed.documents);
    expect(replay.cursor.storeId).toBe(store.storeId);
    expect((await source.sync(replay.cursor)).documents).toEqual([]);
  });

  test("returns empty result when no messages buffered", async () => {
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(0);
    expect(result.hasMore).toBe(true); // history sync not complete
  });

  test("produces documents from buffered messages", async () => {
    store.addMessages([
      makeMsg({ id: "1", text: "Hello" }),
      makeMsg({ id: "2", text: "World", timestamp: 1709900060 }),
    ]);
    store.addChats([{ jid: "1234@s.whatsapp.net", name: "Alice", isGroup: false }]);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toBe("1234@s.whatsapp.net:2024-03-08");
    expect(result.documents[0].content).toContain("Hello");
    expect(result.documents[0].content).toContain("World");
  });

  test("groups messages from different chats into separate documents", async () => {
    store.addMessages([
      makeMsg({ id: "1", chatJid: "aaa@s.whatsapp.net" }),
      makeMsg({ id: "2", chatJid: "bbb@s.whatsapp.net" }),
    ]);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);
  });

  test("groups messages from different days into separate documents", async () => {
    store.addMessages([
      makeMsg({ id: "1", timestamp: 1709900000 }), // 2024-03-08
      makeMsg({ id: "2", timestamp: 1709900000 + 86400 }), // 2024-03-09
    ]);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);
  });

  test("reports hasMore=true during bootstrap", async () => {
    store.addMessages([makeMsg()]);
    store.setHistorySyncState("streaming");

    const result = await source.sync(null);
    expect(result.hasMore).toBe(true);
    expect(result.progress?.phase).toBe("bootstrap");
  });

  test("reports incremental progress when new messages buffered", async () => {
    // Drain the bootstrap so we're firmly in incremental mode.
    store.setHistorySyncState("complete");
    store.addMessages([makeMsg({ id: "boot" })]);
    const r1 = await source.sync(null);
    expect(r1.hasMore).toBe(false);

    // Push a new message into the buffer (push-based incremental).
    store.addMessages([makeMsg({ id: "live", timestamp: 1709900000 + 60 })]);

    const r2 = await source.sync(r1.cursor);
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.processed).toBeGreaterThan(0);
  });

  test("reports hasMore=false after history sync complete and buffer empty", async () => {
    store.addMessages([makeMsg()]);
    store.setHistorySyncState("complete");

    const result = await source.sync(null);
    expect(result.hasMore).toBe(false);

    const cursor = result.cursor as any;
    expect(cursor.phase).toBe("incremental");
    expect(cursor.committedSeq).toBeGreaterThan(0);
  });

  test("second sync only returns new messages", async () => {
    store.addMessages([makeMsg({ id: "1" })]);
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // No new messages
    store.setHistorySyncState("complete");
    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);

    // New message arrives
    store.addMessages([makeMsg({ id: "2", timestamp: 1709900100 })]);
    const r3 = await source.sync(r2.cursor);
    expect(r3.documents).toHaveLength(1);
  });

  test("re-emits a day when the prior POST failed (cursor not advanced)", async () => {
    store.setHistorySyncState("complete");
    store.addMessages([makeMsg({ id: "1" })]);
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Simulate a failed gateway POST: the engine does NOT persist r1.cursor, so
    // the next cycle calls sync() with the ORIGINAL cursor — the day must
    // re-emit (commit-gating; no silent loss).
    const r2 = await source.sync(null);
    expect(r2.documents).toHaveLength(1);

    // A confirmed commit (cursor advances) then clears it.
    const r3 = await source.sync(r2.cursor);
    expect(r3.documents).toHaveLength(0);
  });

  test("coverage reflects history-sync state: 'unknown' mid-bootstrap, 'complete' when sealed, 'partial' when interrupted", async () => {
    // Still streaming — the window may yet complete or stall, so the corpus's
    // wholeness genuinely isn't known yet.
    store.setHistorySyncState("streaming");
    store.addMessages([makeMsg({ id: "0" })]);
    const r0 = await source.sync(null);
    expect(r0.progress?.coverage).toBe("unknown");

    store.setHistorySyncState("complete");
    store.addMessages([makeMsg({ id: "1", timestamp: 1709900050 })]);
    const r1 = await source.sync(r0.cursor);
    // The recent-window sync is sealed → the synced corpus is whole.
    expect(r1.progress?.coverage).toBe("complete");

    // An interrupted bootstrap is truncated → surface "partial" so the UI can
    // point at re-pair / the backup import.
    store.setHistorySyncState("interrupted");
    store.addMessages([makeMsg({ id: "2", timestamp: 1709900100 })]);
    const r2 = await source.sync(r1.cursor);
    expect(r2.progress?.coverage).toBe("partial");
  });

  test("reports 'unknown' coverage even on a quiet poll with no new messages", async () => {
    // Still streaming, but this particular poll drains nothing (e.g. the
    // phone hasn't sent anything new since the last check). `progress` must
    // still surface the bootstrap's unresolved coverage rather than going
    // silent — an absent field reads as "not applicable", which is false here.
    store.setHistorySyncState("streaming");
    const r = await source.sync(null);
    expect(r.documents).toHaveLength(0);
    expect(r.progress?.coverage).toBe("unknown");
  });

  test("the page that first knows the history is whole says so, having drained nothing", async () => {
    // The seal fires on a quiet timer — no batches for two minutes, or a
    // settle window for an account that received none — so by construction the
    // page that first knows is a page with nothing to report. Gating the claim
    // on having processed something withheld precisely the all-clear, and left
    // a sealed account describing itself as unable to tell.
    store.setHistorySyncState("streaming");
    store.addMessages([makeMsg({ id: "0" })]);
    const r0 = await source.sync(null);
    expect(r0.progress?.coverage).toBe("unknown");

    store.setHistorySyncState("complete");
    const sealed = await source.sync(r0.cursor);
    expect(sealed.documents).toHaveLength(0);
    expect(sealed.progress?.coverage).toBe("complete");
  });

  test("every page names the same subject, so a revision reads as one", async () => {
    // The host combines claims from different subjects by keeping the weakest
    // and treats a repeat of one subject as a revision. WhatsApp has one
    // subject, so its bootstrap pages must agree on the name or the seal would
    // be outranked by the pages that preceded it.
    store.setHistorySyncState("streaming");
    store.addMessages([makeMsg({ id: "0" })]);
    const r0 = await source.sync(null);
    store.setHistorySyncState("complete");
    const r1 = await source.sync(r0.cursor);
    expect(r0.progress?.coverageSubject).toBeDefined();
    expect(r1.progress?.coverageSubject).toBe(r0.progress?.coverageSubject);
  });

  test("tombstones a day-doc when every message in it is deleted", async () => {
    store.setHistorySyncState("complete");
    store.addMessages([makeMsg({ id: "1", text: "see https://example.com" })]);
    const r1 = await source.sync(null);
    expect(r1.documents).toHaveLength(1);
    const dayKey = r1.documents[0].externalId; // 1234@s.whatsapp.net:2024-03-08

    // Delete the only message in the day, then sync again (committed cursor).
    store.markDeleted("1234@s.whatsapp.net", "1", makeMsg().timestamp);
    const r2 = await source.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toContain(dayKey);
  });

  test("cursor tracks lastTimestamp", async () => {
    store.addMessages([
      makeMsg({ id: "1", timestamp: 1000 }),
      makeMsg({ id: "2", timestamp: 2000 }),
    ]);

    const result = await source.sync(null);
    const cursor = result.cursor as any;
    expect(cursor.lastTimestamp).toBe(2000);
  });

  describe("attachment extraction", () => {
    function makeDocMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
      return {
        id: "doc-msg-1",
        chatJid: "1234@s.whatsapp.net",
        senderJid: "1234@s.whatsapp.net",
        senderName: "Alice",
        fromMe: false,
        timestamp: 1709900000,
        type: "document",
        text: "Here's the report",
        media: {
          mimetype: "application/pdf",
          filename: "report.pdf",
          fileLength: 2048,
          url: "https://mmg.whatsapp.net/doc/abc",
          directPath: "/v/t62.abc/doc",
          mediaKey: "AQID", // base64 of [1,2,3]
          mediaKeyTimestamp: 1709900000,
        },
        ...overrides,
      };
    }

    function createAttSource(opts: {
      downloadMedia?: MediaDownloadFn;
      extractAttachment?: AttachmentExtractFn;
      mediaAttemptsPerPage?: number;
    }) {
      return new WhatsAppMessagesSource(store, undefined, {
        attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
        ...opts,
      });
    }

    test("extracts document attachment and creates separate document", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({
        text: "Extracted PDF text",
        pages: 3,
        truncated: false,
      }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([makeDocMsg()]);
      store.addChats([{ jid: "1234@s.whatsapp.net", name: "Alice", isGroup: false }]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(2);

      const convDoc = result.documents.find((d) => d.metadata.documentType === "conversation");
      const attDoc = result.documents.find((d) => d.metadata.documentType === "attachment");
      expect(convDoc).toBeDefined();
      expect(attDoc).toBeDefined();
      expect(attDoc!.title).toBe("report.pdf");
      expect(attDoc!.content).toBe("Extracted PDF text");
      expect(attDoc!.metadata.extra?.parentExternalId).toBe(convDoc!.externalId);
    });

    test("skips extraction when disabled", async () => {
      const defaultSource = new WhatsAppMessagesSource(store);
      store.addMessages([makeDocMsg()]);

      const result = await defaultSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
    });

    test("handles download failure", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "transient" as const,
        error: "download-failed",
      }));
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([makeDocMsg()]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("download-failed");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("handles expired URL (download throws)", async () => {
      const mockDownload = vi.fn(async () => {
        throw new Error("URL expired");
      });
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([makeDocMsg()]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("OCRs an image attachment into a separate document", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({
        text: "I like bananas",
        pages: 1,
        truncated: false,
      }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      // An image (a photo of text) flows through the same path as a document:
      // download → extract (OCR) → child attachment doc.
      store.addMessages([
        makeMsg({
          type: "image",
          text: "",
          media: {
            mimetype: "image/jpeg",
            fileLength: 1000,
            url: "https://mmg.whatsapp.net/img/abc",
            directPath: "/v/t62.abc/img",
            mediaKey: "AQID",
            mediaKeyTimestamp: 1709900000,
          },
        }),
      ]);
      store.addChats([{ jid: "1234@s.whatsapp.net", name: "Alice", isGroup: false }]);

      const result = await attSource.sync(null);
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockExtract).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "image/jpeg", {
        maxTextLength: expect.any(Number),
      });

      const attDoc = result.documents.find((d) => d.metadata.documentType === "attachment");
      expect(attDoc).toBeDefined();
      // No filename on the image → default "photo", matching the inline placeholder.
      expect(attDoc!.title).toBe("photo");
      expect(attDoc!.content).toBe("I like bananas");
    });

    test("does not extract audio or video messages (handled inline / no extractor)", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([
        makeMsg({
          id: "audio-1",
          type: "audio",
          media: { mimetype: "audio/ogg", fileLength: 1000, isVoiceNote: true },
        }),
        makeMsg({
          id: "video-1",
          type: "video",
          timestamp: 1709900060,
          media: { mimetype: "video/mp4", fileLength: 1000 },
        }),
      ]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("conversation");
      expect(mockExtract).not.toHaveBeenCalled();
    });

    test("skips unsupported MIME types", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([
        makeDocMsg({
          media: {
            mimetype: "application/zip",
            filename: "archive.zip",
            fileLength: 1000,
            url: "https://example.com",
            mediaKey: "abc",
          },
        }),
      ]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("type-excluded");
      expect(mockDownload).not.toHaveBeenCalled();
    });

    test("skips oversized documents", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([
        makeDocMsg({
          media: {
            mimetype: "application/pdf",
            filename: "huge.pdf",
            fileLength: 100_000_000,
            url: "https://example.com",
            mediaKey: "abc",
          },
        }),
      ]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("too-large");
      expect(mockDownload).not.toHaveBeenCalled();
    });

    test("multiple document messages produce multiple attachment docs", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({ text: "Extracted", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
        mediaAttemptsPerPage: 2,
      });

      store.addMessages([
        makeDocMsg({ id: "doc-1", timestamp: 1709900000 }),
        makeDocMsg({
          id: "doc-2",
          timestamp: 1709900060,
          media: {
            mimetype: "application/pdf",
            filename: "invoice.pdf",
            fileLength: 1024,
            url: "https://example.com",
            mediaKey: "abc",
          },
        }),
      ]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(3); // 1 conversation + 2 attachments
      const attDocs = result.documents.filter((d) => d.metadata.documentType === "attachment");
      expect(attDocs).toHaveLength(2);
    });

    test("extraction failure returns null", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => null);
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([makeDocMsg()]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("extraction-failed");
    });

    test("skips when no download keys", async () => {
      const mockDownload = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const mockExtract = vi.fn(async () => ({ text: "text", pages: 1, truncated: false }));
      const attSource = createAttSource({
        downloadMedia: mockDownload as MediaDownloadFn,
        extractAttachment: mockExtract as AttachmentExtractFn,
      });

      store.addMessages([
        makeDocMsg({
          media: {
            mimetype: "application/pdf",
            filename: "report.pdf",
            fileLength: 1024,
            // no url, directPath, or mediaKey
          },
        }),
      ]);

      const result = await attSource.sync(null);
      expect(result.documents).toHaveLength(1);
      const atts = result.documents[0].metadata.extra?.attachments as any[];
      expect(atts[0].reason).toBe("download-failed");
      expect(mockDownload).not.toHaveBeenCalled();
    });
  });

  describe("dataCutoff", () => {
    test("filters out documents older than the cutoff", async () => {
      // timestamp 1709900000 = 2024-03-08T14:13:20Z
      const cutoff = "2024-03-09T00:00:00Z";
      const cutoffSource = new WhatsAppMessagesSource(store, undefined, { dataCutoff: cutoff });

      store.addMessages([
        makeMsg({ id: "1", timestamp: 1709900000 }), // 2024-03-08 — before cutoff
      ]);

      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(0);
    });

    test("keeps documents at or after the cutoff", async () => {
      // 2024-03-09T00:00:00Z = 1709942400
      const cutoff = "2024-03-09T00:00:00Z";
      const cutoffSource = new WhatsAppMessagesSource(store, undefined, { dataCutoff: cutoff });

      store.addMessages([
        makeMsg({ id: "1", timestamp: 1709942400 }), // exactly at cutoff
        makeMsg({ id: "2", timestamp: 1709942460 }), // 1 minute after
      ]);

      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("Hello");
    });

    test("filters old messages but keeps recent ones from the same day-chat", async () => {
      // Mix of old and new messages in different day-chat keys
      const cutoff = "2024-03-09T00:00:00Z";
      const cutoffSource = new WhatsAppMessagesSource(store, undefined, { dataCutoff: cutoff });

      store.addMessages([
        makeMsg({ id: "old", timestamp: 1709900000 }), // 2024-03-08 — before cutoff
        makeMsg({ id: "new", timestamp: 1709942400 + 3600 }), // 2024-03-09 — after cutoff
      ]);

      const result = await cutoffSource.sync(null);
      // Should have 1 document (2024-03-09) but not the 2024-03-08 one
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toContain("2024-03-09");
    });

    test("does not filter when no cutoff is set", async () => {
      const noCutoffSource = new WhatsAppMessagesSource(store);

      store.addMessages([
        makeMsg({ id: "1", timestamp: 1000 }), // very old
      ]);

      const result = await noCutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
    });
  });

  describe("voice-note transcription", () => {
    function makeVoiceMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
      return makeMsg({
        id: "vn-1",
        type: "audio",
        text: "",
        media: {
          mimetype: "audio/ogg; codecs=opus",
          isVoiceNote: true,
          seconds: 7,
          fileLength: 4096,
          url: "https://mmg.whatsapp.net/aud/abc",
          directPath: "/v/t62.abc/aud",
          mediaKey: "AQID",
          mediaKeyTimestamp: 1709900000,
        },
        ...overrides,
      });
    }

    function makeSource(opts: {
      transcribeAudio?: WhatsAppMessagesSourceOptions["transcribeAudio"];
      downloadMedia?: MediaDownloadFn;
    }) {
      return new WhatsAppMessagesSource(store, undefined, opts);
    }

    test("transcribes a voice note and injects the transcript inline into the day-chat", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => ({ text: "let's meet at noon tomorrow" }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg()]);

      const result = await src.sync(null);
      expect(downloadMedia).toHaveBeenCalledTimes(1);
      expect(transcribeAudio).toHaveBeenCalledWith(
        new Uint8Array([1, 2, 3]),
        "audio/ogg; codecs=opus",
      );
      const doc = result.documents.find((d) => d.metadata.documentType === "conversation")!;
      expect(doc.content).toContain("Voice note");
      expect(doc.content).toContain("let's meet at noon tomorrow");
    });

    test("renders just the placeholder when no transcriber is wired (no audio download)", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const src = makeSource({ downloadMedia }); // no transcribeAudio
      store.addMessages([makeVoiceMsg()]);

      const result = await src.sync(null);
      expect(downloadMedia).not.toHaveBeenCalled();
      const doc = result.documents[0];
      expect(doc.content).toContain("[Voice note, 0:07]");
    });

    test("does not re-transcribe an already-transcribed voice note on re-emit", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => ({ text: "first pass" }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg({ timestamp: 1709900000 })]);

      const r1 = await src.sync(null);
      expect(transcribeAudio).toHaveBeenCalledTimes(1);

      // Re-dirty the same day with a later message and re-emit.
      store.addMessages([makeMsg({ id: "txt", timestamp: 1709900100, text: "ok" })]);
      const r2 = await src.sync(r1.cursor);
      expect(transcribeAudio).toHaveBeenCalledTimes(1); // not re-transcribed
      const doc = r2.documents.find((d) => d.metadata.documentType === "conversation")!;
      expect(doc.content).toContain("first pass");
    });

    test("persists an empty (no-speech) transcript and does not retry it", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => ({ text: "   " })); // whitespace → ""
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg({ timestamp: 1709900000 })]);

      const r1 = await src.sync(null);
      expect(transcribeAudio).toHaveBeenCalledTimes(1);

      store.addMessages([makeMsg({ id: "txt", timestamp: 1709900100 })]);
      await src.sync(r1.cursor);
      expect(transcribeAudio).toHaveBeenCalledTimes(1); // "" is a final result
    });

    test("a null transcription result leaves the placeholder and retries (not persisted)", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => null); // gateway disabled/unavailable
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg()]);

      const result = await src.sync(null);
      const doc = result.documents[0];
      expect(doc.content).toContain("[Voice note, 0:07]");
      expect(doc.content).not.toMatch(/\[Voice note, 0:07\]: ./);
    });

    test("a failed download leaves the placeholder", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "transient" as const,
        error: "download-failed",
      })) as MediaDownloadFn; // expired media
      const transcribeAudio = vi.fn(async () => ({ text: "should not happen" }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg()]);

      const result = await src.sync(null);
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(result.documents[0].content).toContain("[Voice note, 0:07]");
    });

    test("skips a voice note lacking download descriptors (metadata-only / imported)", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => ({ text: "should not run" }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      // No mediaKey / url / directPath — nothing to fetch or decrypt.
      store.addMessages([
        makeVoiceMsg({
          media: { mimetype: "audio/ogg; codecs=opus", isVoiceNote: true, seconds: 5 },
        }),
      ]);

      const result = await src.sync(null);
      expect(downloadMedia).not.toHaveBeenCalled();
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(result.documents[0].content).toContain("[Voice note, 0:05]");
    });

    test("resync re-transcribes existing voice notes with the new model", async () => {
      const downloadMedia = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      })) as MediaDownloadFn;
      let call = 0;
      const transcribeAudio = vi.fn(async () => ({
        text: call++ === 0 ? "old model" : "new model",
      }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg()]);

      const r1 = await src.sync(null);
      expect(r1.documents[0].content).toContain("old model");

      src.onResync(); // arms in-place re-transcription
      const r2 = await src.sync(r1.cursor);
      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      expect(r2.documents[0].content).toContain("new model");
    });

    test("resync keeps the existing transcript when the audio can no longer be downloaded", async () => {
      let downloadOk = true;
      const downloadMedia = vi.fn(async () =>
        downloadOk
          ? { kind: "ok" as const, data: new Uint8Array([1, 2, 3]) }
          : { kind: "transient" as const, error: "expired" },
      ) as MediaDownloadFn;
      const transcribeAudio = vi.fn(async () => ({ text: "kept transcript" }));
      const src = makeSource({ downloadMedia, transcribeAudio });
      store.addMessages([makeVoiceMsg()]);

      const r1 = await src.sync(null);
      expect(r1.documents[0].content).toContain("kept transcript");

      downloadOk = false; // media now expired on the CDN
      src.onResync();
      const r2 = await src.sync(r1.cursor);
      // Re-transcription couldn't fetch the audio — the old transcript survives.
      expect(r2.documents[0].content).toContain("kept transcript");
    });
  });
});
