// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  resolveAttachmentConfig,
  type AttachmentExtractFn,
  type ExtractionResult,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { MessageStore, computeMediaRetryDelaySec, type MediaRetryPolicy } from "./message-store.js";
import { WhatsAppMessagesSource, type MediaDownloadFn } from "./messages.js";
import type { StoredMessage } from "./types.js";

const CHAT = "111@s.whatsapp.net";

/** A downloadable voice note (has decryption descriptors). */
function voiceMsg(over: Partial<StoredMessage> & { id: string; timestamp: number }): StoredMessage {
  return {
    chatJid: CHAT,
    senderJid: CHAT,
    senderName: "Maya Reeves",
    fromMe: false,
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
    ...over,
  };
}

function attachmentMsg(
  type: "image" | "document",
  mimeType: string,
  over: Partial<StoredMessage> & { id: string; timestamp: number },
): StoredMessage {
  return {
    chatJid: CHAT,
    senderJid: CHAT,
    senderName: "Maya Reeves",
    fromMe: false,
    type,
    text: "",
    media: {
      mimetype: mimeType,
      filename: type === "document" ? "review.pdf" : undefined,
      fileLength: 4096,
      url: "https://mmg.whatsapp.net/media/abc",
      directPath: "/v/t62.abc/media",
      mediaKey: "AQID",
      mediaKeyTimestamp: 1709900000,
    },
    ...over,
  };
}

function ts(date: string, hour = 12): number {
  return Math.floor(Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1000);
}

describe("computeMediaRetryDelaySec", () => {
  const policy: MediaRetryPolicy = { backoffSec: [60, 300, 1800], maxAttempts: 5 };

  test("follows the schedule, repeating the last entry, then gives up at maxAttempts", () => {
    expect(computeMediaRetryDelaySec(1, policy)).toBe(60);
    expect(computeMediaRetryDelaySec(2, policy)).toBe(300);
    expect(computeMediaRetryDelaySec(3, policy)).toBe(1800);
    expect(computeMediaRetryDelaySec(4, policy)).toBe(1800); // repeats last
    expect(computeMediaRetryDelaySec(5, policy)).toBeNull(); // exhausted → give up
    expect(computeMediaRetryDelaySec(99, policy)).toBeNull();
  });
});

describe("MessageStore media lifecycle", () => {
  let store: MessageStore;
  // Fast policy: immediate retries, give up after 3 transient failures.
  const policy = { retryPolicy: { backoffSec: [10, 20], maxAttempts: 3 } };

  beforeEach(() => {
    store = new MessageStore(undefined, policy);
  });
  afterEach(() => store.close());

  test("enrolls downloadable media as pending/due on insert; leaves non-media and keyless NULL", () => {
    store.addMessages([
      voiceMsg({ id: "vn", timestamp: ts("2026-01-02") }),
      {
        ...voiceMsg({ id: "nokeys", timestamp: ts("2026-01-02") }),
        media: { isVoiceNote: true, seconds: 3 },
      },
      {
        chatJid: CHAT,
        senderJid: CHAT,
        senderName: "Maya Reeves",
        fromMe: false,
        type: "text",
        text: "hi",
        id: "txt",
        timestamp: ts("2026-01-02"),
      },
    ]);
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("pending");
    expect(store.getMessageById(CHAT, "vn")?.mediaNextAttempt).toBe(0);
    expect(store.getMessageById(CHAT, "nokeys")?.mediaState).toBeUndefined();
    expect(store.getMessageById(CHAT, "txt")?.mediaState).toBeUndefined();
  });

  test("a re-delivery of the same message does not reset its media lifecycle", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    store.recordMediaOutcome(CHAT, "vn", { kind: "transcribed", text: "hello" });
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("done");
    // Same id arrives again (e.g. a messages.upsert re-emit).
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("done");
  });

  test("transcribed outcome sets done + transcript; empty text → empty", () => {
    store.addMessages([
      voiceMsg({ id: "a", timestamp: ts("2026-01-02") }),
      voiceMsg({ id: "b", timestamp: ts("2026-01-02") }),
    ]);
    store.recordMediaOutcome(CHAT, "a", { kind: "transcribed", text: "spoken words" });
    store.recordMediaOutcome(CHAT, "b", { kind: "transcribed", text: "" });
    expect(store.getMessageById(CHAT, "a")?.mediaState).toBe("done");
    expect(store.getMessageById(CHAT, "a")?.transcript).toBe("spoken words");
    expect(store.getMessageById(CHAT, "b")?.mediaState).toBe("empty");
    expect(store.getMessageById(CHAT, "b")?.transcript).toBe("");
  });

  test("transient outcome backs off and stays pending; exhausting attempts → unavailable", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "blip" }, 1000);
    let m = store.getMessageById(CHAT, "vn")!;
    expect(m.mediaState).toBe("pending");
    expect(m.mediaNextAttempt).toBe(1010); // 1000 + backoff[0]=10

    store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "blip" }, 2000);
    m = store.getMessageById(CHAT, "vn")!;
    expect(m.mediaState).toBe("pending");
    expect(m.mediaNextAttempt).toBe(2020); // 2000 + backoff[1]=20

    // 3rd transient hits maxAttempts → terminal.
    store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "blip" }, 3000);
    m = store.getMessageById(CHAT, "vn")!;
    expect(m.mediaState).toBe("unavailable");
    expect(m.mediaNextAttempt).toBeUndefined();
  });

  test("process-failed retries indefinitely and never becomes unavailable", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    // Far more failures than maxAttempts (3) — a download-transient would have
    // given up long ago, but a processing gap keeps a live retry scheduled.
    for (let t = 1000; t < 1000 + 50 * 100; t += 100) {
      store.recordMediaOutcome(CHAT, "vn", { kind: "process-failed", error: "no model" }, t);
    }
    const m = store.getMessageById(CHAT, "vn")!;
    expect(m.mediaState).toBe("pending");
    expect(m.mediaNextAttempt).not.toBeUndefined();
  });

  test("terminal outcome marks unavailable immediately, regardless of attempt count", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    store.recordMediaOutcome(CHAT, "vn", { kind: "terminal", error: "media no longer available" });
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("unavailable");
  });

  test("preserves an existing transcript when a re-download fails", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    store.recordMediaOutcome(CHAT, "vn", { kind: "transcribed", text: "keep me" });
    store.recordMediaOutcome(CHAT, "vn", { kind: "terminal", error: "gone" });
    // State moved on, but the spoken text is not lost.
    expect(store.getMessageById(CHAT, "vn")?.transcript).toBe("keep me");
  });

  test("markDueMediaDirty re-dirties only due pending media (backoff respected)", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    // Drain so the day is no longer dirty from the insert.
    const first = store.drain();
    store.drain({ committedSeq: first.emitSeq });
    expect(store.dirtyCount).toBe(0);

    store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "blip" }, 1000); // next=1010
    expect(store.markDueMediaDirty(1005)).toBe(0); // not due yet
    expect(store.dirtyCount).toBe(0);
    expect(store.markDueMediaDirty(1010)).toBe(1); // due
    expect(store.dirtyCount).toBe(1);
  });

  test("markDueMediaDirty never re-arms non-pending (done / unavailable) media", () => {
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    store.recordMediaOutcome(CHAT, "vn", { kind: "terminal", error: "gone" }); // → unavailable
    // The terminal transition re-dirties once (to surface the placeholder);
    // drain that off so we can observe the sweep in isolation.
    const first = store.drain();
    store.drain({ committedSeq: first.emitSeq });
    expect(store.dirtyCount).toBe(0);
    // Even far in the future, a terminal item is never re-armed by the sweep.
    expect(store.markDueMediaDirty(9_999_999_999)).toBe(0);
    expect(store.dirtyCount).toBe(0);
  });

  test("pullForwardMediaRetries makes pending media due now and wakes a sync", () => {
    const onChange = vi.fn();
    store.onChange(onChange);
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
    onChange.mockClear();
    store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "blip" }, 1000); // next=1010

    expect(store.pullForwardMediaRetries()).toBe(1);
    expect(store.getMessageById(CHAT, "vn")?.mediaNextAttempt).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("pullForwardMediaRetries touches only pending media and no-ops (no wake) when none pending", () => {
    const onChange = vi.fn();
    store.onChange(onChange);
    store.addMessages([
      voiceMsg({ id: "done", timestamp: ts("2026-01-02") }),
      voiceMsg({ id: "gone", timestamp: ts("2026-01-02") }),
    ]);
    store.recordMediaOutcome(CHAT, "done", { kind: "transcribed", text: "hi" });
    store.recordMediaOutcome(CHAT, "gone", { kind: "terminal", error: "x" });
    onChange.mockClear();

    // Nothing pending → returns 0 and does NOT fire the change handler.
    expect(store.pullForwardMediaRetries()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    // The done/unavailable items keep their cleared next-attempt.
    expect(store.getMessageById(CHAT, "done")?.mediaNextAttempt).toBeUndefined();
    expect(store.getMessageById(CHAT, "gone")?.mediaNextAttempt).toBeUndefined();
  });

  test("mediaHealthStats counts pending and unavailable", () => {
    store.addMessages([
      voiceMsg({ id: "a", timestamp: ts("2026-01-02") }),
      voiceMsg({ id: "b", timestamp: ts("2026-01-02") }),
      voiceMsg({ id: "c", timestamp: ts("2026-01-02") }),
    ]);
    store.recordMediaOutcome(CHAT, "c", { kind: "terminal", error: "gone" });
    expect(store.mediaHealthStats()).toEqual({ pending: 2, unavailable: 1 });
  });

  test("resetMediaForResync re-enrolls done/unavailable media as pending", () => {
    store.addMessages([
      voiceMsg({ id: "a", timestamp: ts("2026-01-02") }),
      voiceMsg({ id: "b", timestamp: ts("2026-01-02") }),
    ]);
    store.recordMediaOutcome(CHAT, "a", { kind: "transcribed", text: "done" });
    store.recordMediaOutcome(CHAT, "b", { kind: "terminal", error: "gone" });
    store.resetMediaForResync();
    expect(store.getMessageById(CHAT, "a")?.mediaState).toBe("pending");
    expect(store.getMessageById(CHAT, "b")?.mediaState).toBe("pending");
    // The old transcript survives the reset (re-download may fail).
    expect(store.getMessageById(CHAT, "a")?.transcript).toBe("done");
  });
});

describe("MessageStore media-state migration backfill", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-wa-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("backfills done/empty from existing transcripts; leaves the rest NULL", () => {
    // Seed a DB with the pre-media-column schema (transcript exists, media_* don't).
    const db = new Database(join(dir, "store.db"));
    db.exec(`
      CREATE TABLE messages (
        chat_jid TEXT NOT NULL, id TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL,
        type TEXT NOT NULL, text TEXT NOT NULL, media_json TEXT,
        reaction_emoji TEXT, reaction_target_id TEXT, quoted_text TEXT,
        quoted_sender TEXT, deleted INTEGER NOT NULL DEFAULT 0, transcript TEXT,
        PRIMARY KEY (chat_jid, id)
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('user_version', '1');
      INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, type, text, transcript)
        VALUES ('${CHAT}', 'done', '${CHAT}', 'A', 0, 100, 'audio', '', 'spoken');
      INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, type, text, transcript)
        VALUES ('${CHAT}', 'empty', '${CHAT}', 'A', 0, 100, 'audio', '', '');
      INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, type, text, transcript)
        VALUES ('${CHAT}', 'never', '${CHAT}', 'A', 0, 100, 'audio', '', NULL);
    `);
    db.close();

    const store = new MessageStore(dir);
    try {
      expect(store.getMessageById(CHAT, "done")?.mediaState).toBe("done");
      expect(store.getMessageById(CHAT, "empty")?.mediaState).toBe("empty");
      // Never-transcribed legacy audio stays NULL → no archive-wide retry storm.
      expect(store.getMessageById(CHAT, "never")?.mediaState).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("WhatsAppMessagesSource media retry (integration)", () => {
  let store: MessageStore;

  beforeEach(() => {
    // backoff 0 → retries are due immediately on the next sync; give up after 3.
    store = new MessageStore(undefined, { retryPolicy: { backoffSec: [0], maxAttempts: 3 } });
    store.setHistorySyncState("complete");
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function conversation(docs: { metadata: { documentType?: string }; content: string }[]): string {
    return docs.find((d) => d.metadata.documentType === "conversation")?.content ?? "";
  }

  test("blank image OCR is terminal and is not retried", async () => {
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    const extractAttachment: AttachmentExtractFn = vi.fn(async () => ({
      text: "",
      truncated: false,
      noText: true as const,
      extra: { ocr: true },
    }));
    const msg = attachmentMsg("image", "image/png", {
      id: "blank-image",
      timestamp: ts("2026-01-02"),
    });
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      extractAttachment,
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
    });
    store.addMessages([msg]);

    const first = await src.sync(null);
    const parent = first.documents.find((doc) => doc.metadata.documentType === "conversation");
    const attachments = parent?.metadata.extra?.attachments as { reason?: string }[];
    expect(attachments[0]?.reason).toBe("no-text");
    expect(first.documents.some((doc) => doc.metadata.documentType === "attachment")).toBe(false);
    expect(store.getMessageById(CHAT, msg.id)?.mediaState).toBe("empty");

    store.markAllDirty();
    const second = await src.sync(first.cursor);
    const secondParent = second.documents.find(
      (doc) => doc.metadata.documentType === "conversation",
    );
    const secondAttachments = secondParent?.metadata.extra?.attachments as { reason?: string }[];
    expect(secondAttachments[0]?.reason).toBe("no-text");
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(extractAttachment).toHaveBeenCalledOnce();
  });

  test.each([
    {
      label: "image OCR",
      message: () =>
        attachmentMsg("image", "image/png", { id: "img", timestamp: ts("2026-01-02") }),
      firstResult: null,
    },
    {
      label: "sparse PDF OCR",
      message: () =>
        attachmentMsg("document", "application/pdf", {
          id: "pdf",
          timestamp: ts("2026-01-02"),
        }),
      firstResult: {
        text: "native page text",
        pages: 2,
        truncated: false,
        extra: { ocrIncomplete: true },
      } satisfies ExtractionResult,
    },
  ])(
    "$label failure does not block messages and retries without chat activity",
    async ({ message, firstResult }) => {
      let attempt = 0;
      const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
        kind: "ok" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const extractAttachment: AttachmentExtractFn = vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? firstResult
          : { text: "recovered OCR text", pages: 2, truncated: false, extra: { ocr: true } };
      });
      const msg = message();
      const src = new WhatsAppMessagesSource(store, undefined, {
        downloadMedia,
        extractAttachment,
        attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
      });
      store.addMessages([msg]);

      const r1 = await src.sync(null);
      expect(conversation(r1.documents)).not.toBe("");
      expect((r1.cursor as { committedSeq: number }).committedSeq).toBeGreaterThan(0);
      expect(store.getMessageById(CHAT, msg.id)?.mediaState).toBe("pending");

      const r2 = await src.sync(r1.cursor);
      expect(extractAttachment).toHaveBeenCalledTimes(2);
      expect(
        r2.documents.some(
          (d) =>
            d.metadata.documentType === "attachment" && d.content.includes("recovered OCR text"),
        ),
      ).toBe(true);
      expect(store.getMessageById(CHAT, msg.id)?.mediaState).toBe("done");
    },
  );

  test("bounds a durable voice-note backlog while primary messages keep committing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-16T12:00:00.000Z"));
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    let transcript = 0;
    const transcribeAudio = vi.fn(async () => ({ text: `spoken ${++transcript}` }));
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      transcribeAudio,
      mediaAttemptsPerPage: 1,
    });
    store.addMessages([
      voiceMsg({ id: "vn-1", timestamp: ts("2026-01-02", 10) }),
      voiceMsg({ id: "vn-2", timestamp: ts("2026-01-02", 11) }),
      voiceMsg({ id: "vn-3", timestamp: ts("2026-01-02", 12) }),
    ]);

    const r1 = await src.sync(null);
    expect(conversation(r1.documents)).toContain("spoken 1");
    expect((r1.cursor as { committedSeq: number }).committedSeq).toBeGreaterThan(0);
    expect(r1.hasMore).toBe(false);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(store.getMessageById(CHAT, "vn-1")?.mediaState).toBe("done");
    expect(store.getMessageById(CHAT, "vn-2")?.mediaState).toBe("pending");
    expect(store.getMessageById(CHAT, "vn-2")?.mediaNextAttempt).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(store.getMessageById(CHAT, "vn-3")?.mediaState).toBe("pending");

    // No chat activity: the durable retry wake makes the deferred rows due and
    // re-dirties the same day after each committed cursor.
    vi.advanceTimersByTime(61_000);
    const r2 = await src.sync(r1.cursor);
    expect(conversation(r2.documents)).toContain("spoken 2");
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    expect(store.getMessageById(CHAT, "vn-2")?.mediaState).toBe("done");
    expect(store.getMessageById(CHAT, "vn-3")?.mediaState).toBe("pending");

    vi.advanceTimersByTime(61_000);
    const r3 = await src.sync(r2.cursor);
    expect(conversation(r3.documents)).toContain("spoken 3");
    expect(transcribeAudio).toHaveBeenCalledTimes(3);
    expect(store.getMessageById(CHAT, "vn-3")?.mediaState).toBe("done");
  });

  test("shares the durable-media cap between voice transcription and attachments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-16T12:00:00.000Z"));
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    const transcribeAudio = vi.fn(async () => ({ text: "voice transcript" }));
    const extractAttachment: AttachmentExtractFn = vi.fn(async () => ({
      text: "image text",
      pages: 1,
      truncated: false,
    }));
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      transcribeAudio,
      extractAttachment,
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
      mediaAttemptsPerPage: 1,
    });
    store.addMessages([
      voiceMsg({ id: "voice", timestamp: ts("2026-01-02", 10) }),
      attachmentMsg("image", "image/png", {
        id: "image",
        timestamp: ts("2026-01-02", 11),
      }),
    ]);

    const r1 = await src.sync(null);
    expect(conversation(r1.documents)).toContain("voice transcript");
    expect(extractAttachment).not.toHaveBeenCalled();
    expect(store.getMessageById(CHAT, "image")?.mediaState).toBe("pending");

    const immediate = await src.sync(r1.cursor);
    expect(extractAttachment).not.toHaveBeenCalled();
    expect(store.getMessageById(CHAT, "image")?.mediaState).toBe("pending");

    vi.advanceTimersByTime(61_000);
    const r2 = await src.sync(immediate.cursor);
    expect(extractAttachment).toHaveBeenCalledTimes(1);
    expect(r2.documents.some((d) => d.content.includes("image text"))).toBe(true);
    expect(store.getMessageById(CHAT, "image")?.mediaState).toBe("done");
  });

  test("deferred old-media days do not crowd a recent primary message out of pagination", async () => {
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    const transcribeAudio = vi.fn(async () => ({ text: "archived voice note" }));
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      transcribeAudio,
      mediaAttemptsPerPage: 1,
    });
    const start = Date.parse("2025-01-01T12:00:00.000Z") / 1000;
    const oldMedia = Array.from({ length: 201 }, (_, index) =>
      voiceMsg({
        id: `old-${index}`,
        timestamp: start + index * 86_400,
      }),
    );
    store.addMessages([
      ...oldMedia,
      {
        chatJid: CHAT,
        senderJid: CHAT,
        senderName: "Maya Reeves",
        fromMe: false,
        type: "text",
        text: "recent primary message",
        id: "recent",
        timestamp: ts("2026-01-01"),
      },
    ]);

    const r1 = await src.sync(null);
    expect(r1.hasMore).toBe(true);
    expect(r1.documents.some((doc) => doc.content.includes("recent primary message"))).toBe(false);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const deferred = store.getMessageById(CHAT, "old-1");
    expect(deferred?.mediaState).toBe("pending");
    expect(deferred?.mediaNextAttempt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const r2 = await src.sync(r1.cursor);
    expect(r2.documents.some((doc) => doc.content.includes("recent primary message"))).toBe(true);
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
  });

  test("backs off a transient durable processor error without rejecting primary messages", async () => {
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    const transcribeAudio = vi.fn(async () => {
      throw new SyncError("transient", "transcription backend unavailable");
    });
    const src = new WhatsAppMessagesSource(store, undefined, { downloadMedia, transcribeAudio });
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);

    const result = await src.sync(null);
    expect(conversation(result.documents)).toContain("[Voice note, 0:07]");
    expect((result.cursor as { committedSeq: number }).committedSeq).toBeGreaterThan(0);
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("pending");
    expect(store.getMessageById(CHAT, "vn")?.mediaNextAttempt).toBeGreaterThan(0);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid per-page media attempt cap %s",
    (mediaAttemptsPerPage) => {
      expect(() => new WhatsAppMessagesSource(store, undefined, { mediaAttemptsPerPage })).toThrow(
        "mediaAttemptsPerPage must be a positive safe integer",
      );
    },
  );

  test("retries a failed voice note on a later sync WITHOUT any new chat activity", async () => {
    let attempt = 0;
    const downloadMedia: MediaDownloadFn = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? { kind: "transient" as const, error: "cdn 404, phone offline" }
        : { kind: "ok" as const, data: new Uint8Array([1, 2, 3]) };
    });
    const transcribeAudio = vi.fn(async () => ({ text: "recovered words" }));
    const src = new WhatsAppMessagesSource(store, undefined, { downloadMedia, transcribeAudio });

    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);

    const r1 = await src.sync(null);
    expect(conversation(r1.documents)).toContain("[Voice note, 0:07]");
    expect(conversation(r1.documents)).not.toContain("recovered words");

    // Crucially: no new message is added to the chat. The retry sweep alone
    // re-arms the failed note and the second sync recovers it.
    const r2 = await src.sync(r1.cursor);
    expect(downloadMedia).toHaveBeenCalledTimes(2);
    expect(conversation(r2.documents)).toContain("recovered words");
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("done");
  });

  test("a terminal download failure surfaces an explicit 'audio unavailable' placeholder", async () => {
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "terminal" as const,
      error: "media no longer available on phone",
    }));
    const transcribeAudio = vi.fn(async () => ({ text: "never" }));
    const src = new WhatsAppMessagesSource(store, undefined, { downloadMedia, transcribeAudio });

    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);

    await src.sync(null);
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("unavailable");
    expect(transcribeAudio).not.toHaveBeenCalled();

    // The terminal transition re-dirtied the day; the next sync renders the
    // explicit placeholder (no new chat activity needed).
    const r2 = await src.sync(null);
    expect(conversation(r2.documents)).toContain("audio unavailable");
  });

  test("a voice note with no transcriber model yet recovers once one is assigned (never unavailable)", async () => {
    let modelAssigned = false;
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    // Transcriber wired but returns null until a model is "assigned".
    const transcribeAudio = vi.fn(async () => (modelAssigned ? { text: "now transcribed" } : null));
    const src = new WhatsAppMessagesSource(store, undefined, { downloadMedia, transcribeAudio });
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);

    // Several syncs with no model — far past maxAttempts (3) for a download
    // failure — must NOT mark it unavailable (the audio is in hand).
    let cursor = (await src.sync(null)).cursor;
    for (let i = 0; i < 5; i++) cursor = (await src.sync(cursor)).cursor;
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("pending");

    // Assign a model → the next sweep-driven sync recovers it.
    modelAssigned = true;
    const r = await src.sync(cursor);
    expect(conversation(r.documents)).toContain("now transcribed");
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("done");
  });

  test("stops retrying after attempts are exhausted (no infinite re-arm)", async () => {
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "transient" as const,
      error: "still failing",
    }));
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      transcribeAudio: vi.fn(async () => ({ text: "x" })),
    });
    store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);

    // maxAttempts = 3 → 3 failing syncs, then terminal; further syncs don't retry.
    let cursor = (await src.sync(null)).cursor;
    cursor = (await src.sync(cursor)).cursor;
    cursor = (await src.sync(cursor)).cursor;
    expect(store.getMessageById(CHAT, "vn")?.mediaState).toBe("unavailable");
    const callsAtGiveUp = (downloadMedia as ReturnType<typeof vi.fn>).mock.calls.length;

    await src.sync(cursor);
    await src.sync(cursor);
    // No further download attempts once unavailable.
    expect((downloadMedia as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtGiveUp);
  });
});

describe("MessageStore media-retry wake timer", () => {
  test("fires a sync when a pending media's backoff elapses (not before)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new MessageStore(undefined, {
      retryPolicy: { backoffSec: [60], maxAttempts: 3 },
      mediaRetryWake: true,
    });
    const wake = vi.fn();
    store.onChange(wake);
    try {
      store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
      wake.mockClear(); // ignore the insert's own push

      const nowSec = Math.floor(Date.now() / 1000);
      store.recordMediaOutcome(CHAT, "vn", { kind: "transient", error: "x" }, nowSec); // next = +60s

      vi.advanceTimersByTime(59_000);
      expect(wake).not.toHaveBeenCalled(); // backoff hasn't elapsed

      vi.advanceTimersByTime(2_000);
      expect(wake).toHaveBeenCalled(); // woke a sync on the backoff clock, no poll needed
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  test("does not arm the timer when mediaRetryWake is disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new MessageStore(undefined, {
      retryPolicy: { backoffSec: [60], maxAttempts: 3 },
      mediaRetryWake: false,
    });
    const wake = vi.fn();
    store.onChange(wake);
    try {
      store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
      wake.mockClear();
      store.recordMediaOutcome(
        CHAT,
        "vn",
        { kind: "transient", error: "x" },
        Math.floor(Date.now() / 1000),
      );
      vi.advanceTimersByTime(120_000);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  test("re-checks on a steady cadence while an item stays overdue (no tight loop, no stall)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new MessageStore(undefined, {
      retryPolicy: { backoffSec: [60], maxAttempts: 3 },
      mediaRetryWake: true,
    });
    // The wake fires changeHandler but the (test) sync never runs, so the item
    // stays overdue — exactly the post-fire / >sweep-limit overflow case.
    const wake = vi.fn();
    store.onChange(wake);
    try {
      store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]); // pending, due now
      wake.mockClear();
      // Three overdue re-check windows (60s each): fires once per window, not in a
      // tight loop (would be ≫3) and not zero (would be a stall).
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      expect(wake).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  test("arms on onChange for retries that came due while there was no listener (boot)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new MessageStore(undefined, {
      retryPolicy: { backoffSec: [60], maxAttempts: 3 },
      mediaRetryWake: true,
    });
    try {
      // No listener yet: enroll a note and let its backoff elapse, simulating a
      // restart where the retry came due while the collector was down.
      store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
      store.recordMediaOutcome(
        CHAT,
        "vn",
        { kind: "transient", error: "x" },
        Math.floor(Date.now() / 1000),
      );
      vi.advanceTimersByTime(120_000); // backoff elapses, but nobody is listening

      const wake = vi.fn();
      store.onChange(wake); // registering a listener must arm for the already-due item
      vi.advanceTimersByTime(60_000);
      expect(wake).toHaveBeenCalled();
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  test("disarms once nothing is pending (a resolved note schedules no wake)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = new MessageStore(undefined, {
      retryPolicy: { backoffSec: [60], maxAttempts: 3 },
      mediaRetryWake: true,
    });
    const wake = vi.fn();
    store.onChange(wake);
    try {
      store.addMessages([voiceMsg({ id: "vn", timestamp: ts("2026-01-02") })]);
      store.recordMediaOutcome(CHAT, "vn", { kind: "transcribed", text: "done" }); // → done, not pending
      wake.mockClear();
      vi.advanceTimersByTime(600_000);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });
});

describe("attachment timestamps", () => {
  let store: MessageStore;
  beforeEach(() => {
    store = new MessageStore();
  });
  afterEach(() => {
    store.close();
  });

  test("each attachment is dated by the message that carried it, not by the day", async () => {
    // A day-document spans the whole day, so its own timestamps say nothing
    // about when any one file inside it was sent. Two files shared hours apart
    // must stay hours apart, or nothing downstream can tell which one is the
    // later — and therefore the current — piece of evidence.
    const downloadMedia: MediaDownloadFn = vi.fn(async () => ({
      kind: "ok" as const,
      data: new Uint8Array([1, 2, 3]),
    }));
    const extractAttachment: AttachmentExtractFn = vi.fn(async () => ({
      text: "extracted text",
      truncated: false,
      extra: { ocr: true },
    }));
    const src = new WhatsAppMessagesSource(store, undefined, {
      downloadMedia,
      extractAttachment,
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
      // Both files must extract in one pass for their timestamps to be
      // comparable here; the default per-page budget would defer the second.
      mediaAttemptsPerPage: 10,
    });

    store.addMessages([
      attachmentMsg("document", "application/pdf", {
        id: "morning",
        timestamp: ts("2026-01-02", 7),
        media: {
          mimetype: "application/pdf",
          filename: "morning.pdf",
          fileLength: 4096,
          url: "https://mmg.whatsapp.net/media/a",
          directPath: "/v/t62.abc/a",
          mediaKey: "AQID",
          mediaKeyTimestamp: 1709900000,
        },
      }),
      attachmentMsg("document", "application/pdf", {
        id: "evening",
        timestamp: ts("2026-01-02", 17),
        media: {
          mimetype: "application/pdf",
          filename: "evening.pdf",
          fileLength: 2048,
          url: "https://mmg.whatsapp.net/media/b",
          directPath: "/v/t62.abc/b",
          mediaKey: "AQID",
          mediaKeyTimestamp: 1709900000,
        },
      }),
      // A later plain message, so the day extends past both attachments and
      // the day-document's bounds are distinct from either send time.
      {
        chatJid: CHAT,
        senderJid: CHAT,
        senderName: "Maya Reeves",
        fromMe: false,
        type: "text",
        text: "goodnight",
        id: "last",
        timestamp: ts("2026-01-02", 22),
      },
    ]);

    const r = await src.sync(null);
    const atts = r.documents.filter((d) => d.metadata.documentType === "attachment");
    expect(atts).toHaveLength(2);

    const morning = atts.find((d) => d.title === "morning.pdf")!;
    const evening = atts.find((d) => d.title === "evening.pdf")!;
    expect(morning.sourceCreatedAt).toBe("2026-01-02T07:00:00.000Z");
    expect(evening.sourceCreatedAt).toBe("2026-01-02T17:00:00.000Z");

    // The day-document still bounds the whole day — the attachments no longer
    // borrow those bounds at either end.
    const day = r.documents.find((d) => d.metadata.documentType === "conversation")!;
    expect(day.sourceCreatedAt).toBe("2026-01-02T07:00:00.000Z");
    expect(day.sourceUpdatedAt).toBe("2026-01-02T22:00:00.000Z");
    expect(evening.sourceCreatedAt).not.toBe(day.sourceCreatedAt);
    // Pinned to its own send time: the 22:00 message extended the day without
    // rewriting an attachment sent five hours earlier.
    expect(evening.sourceUpdatedAt).toBe("2026-01-02T17:00:00.000Z");
    expect(morning.sourceUpdatedAt).toBe("2026-01-02T07:00:00.000Z");
  });
});
