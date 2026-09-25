// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { MessageStore } from "./message-store.js";
import { WhatsAppMessagesSource, type WhatsAppMessagesSourceOptions } from "./messages.js";
import type { StoredMessage } from "./types.js";

const CHAT = "conversation@example.com";
const START = Date.parse("2025-01-01T12:00:00.000Z") / 1000;

function mediaMessage(index: number): StoredMessage {
  return {
    id: `media-${index}`,
    chatJid: CHAT,
    senderJid: CHAT,
    senderName: "Fixture",
    fromMe: false,
    timestamp: START + index * 86_400,
    type: "image",
    text: "",
    media: {
      mimetype: "image/png",
      mediaKey: "AQID",
      url: "https://example.com/image.png",
    },
  };
}

const cases: {
  name: string;
  options?: WhatsAppMessagesSourceOptions;
  message?: (message: StoredMessage) => StoredMessage;
}[] = [
  {
    name: "disabled attachments",
    options: { attachmentConfig: resolveAttachmentConfig({ extractAttachments: false }) },
  },
  { name: "missing extractor", options: { extractAttachment: undefined } },
  { name: "missing downloader", options: { downloadMedia: undefined } },
  {
    name: "missing transcriber",
    options: { transcribeAudio: undefined },
    message: (m) => ({ ...m, type: "audio", media: { ...m.media, isVoiceNote: true } }),
  },
  {
    name: "media before source cutoff",
    options: { dataCutoff: "2025-09-01T00:00:00.000Z" },
  },
  {
    name: "non-voice audio",
    message: (m) => ({ ...m, type: "audio", media: { ...m.media, isVoiceNote: false } }),
  },
  {
    name: "attachments without a MIME type",
    message: (m) => ({ ...m, media: { ...m.media, mimetype: undefined } }),
  },
];

describe("WhatsApp media retry eligibility", () => {
  let store: MessageStore;
  const downloadMedia = vi.fn<NonNullable<WhatsAppMessagesSourceOptions["downloadMedia"]>>();
  const extractAttachment =
    vi.fn<NonNullable<WhatsAppMessagesSourceOptions["extractAttachment"]>>();
  const transcribeAudio = vi.fn<NonNullable<WhatsAppMessagesSourceOptions["transcribeAudio"]>>();

  function source(options: WhatsAppMessagesSourceOptions = {}): WhatsAppMessagesSource {
    return new WhatsAppMessagesSource(store, undefined, {
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: true }),
      downloadMedia,
      extractAttachment,
      transcribeAudio,
      ...options,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-02-01T12:00:00.000Z"));
    downloadMedia.mockReset().mockResolvedValue({ kind: "ok", data: new Uint8Array([1, 2, 3]) });
    extractAttachment.mockReset().mockResolvedValue({ text: "recovered image", truncated: false });
    transcribeAudio.mockReset().mockResolvedValue({ text: "recovered voice" });
    store = new MessageStore();
    store.setHistorySyncState("complete");
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  // Optional media must not starve message pagination.
  test.each(cases)("$name cannot requeue old pages or wake useless retries", async (scenario) => {
    const src = source(scenario.options);
    const wake = vi.fn();
    src.onPushEvent(wake);
    const old = Array.from({ length: 201 }, (_, i) => {
      const message = mediaMessage(i);
      return scenario.message?.(message) ?? message;
    });
    store.addMessages([
      ...old,
      {
        ...mediaMessage(202),
        id: "recent",
        type: "text",
        media: undefined,
        timestamp: Date.parse("2026-01-02T12:00:00.000Z") / 1000,
        text: "newest message",
      },
    ]);
    wake.mockClear();
    const pendingBefore = store.getMessageById(CHAT, old[0].id);

    const first = await src.sync(null);
    expect(first.hasMore).toBe(true);
    const second = await src.sync(first.cursor);
    expect(second.documents.some((doc) => doc.content.includes("newest message"))).toBe(true);
    expect(second.hasMore).toBe(false);
    const settled = await src.sync(second.cursor);
    expect(settled.documents).toHaveLength(0);
    expect(settled.hasMore).toBe(false);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(store.mediaHealthStats()).toEqual({ pending: 201, unavailable: 0 });
    expect(store.totalMessages).toBe(202);
    expect(store.getMessageById(CHAT, old[0].id)).toEqual(pendingBefore);

    vi.advanceTimersByTime(120_000);
    expect(wake).not.toHaveBeenCalled();
  });

  test.each(["image", "audio"] as const)(
    "%s cutoff uses exact timestamp, including milliseconds",
    async (type) => {
      const src = source({
        dataCutoff: new Date(START * 1000 + 1).toISOString(),
        mediaAttemptsPerPage: 2,
      });
      store.addMessages(
        [0, 1].map((i) => ({
          ...mediaMessage(i),
          type,
          media: { ...mediaMessage(i).media, isVoiceNote: type === "audio" },
        })),
      );
      const first = await src.sync(null);
      expect(downloadMedia).toHaveBeenCalledOnce();
      expect(store.getMessageById(CHAT, "media-0")?.mediaState).toBe("pending");
      expect(store.getMessageById(CHAT, "media-1")?.mediaState).toBe("done");
      // Transcript persistence dirties its day once more for acknowledgment-safe replay.
      const replay = await src.sync(first.cursor);
      expect(replay.hasMore).toBe(false);
      expect((await src.sync(replay.cursor)).documents).toHaveLength(0);
    },
  );

  test("enabling processors and widening cutoff recovers pending media without new messages", async () => {
    const src = source({
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: false }),
      transcribeAudio: undefined,
      dataCutoff: "2026-01-01T00:00:00.000Z",
    });
    store.addMessages([
      mediaMessage(0),
      { ...mediaMessage(1), type: "audio", media: { ...mediaMessage(1).media, isVoiceNote: true } },
    ]);
    const first = await src.sync(null);
    const settled = await src.sync(first.cursor);
    expect(settled.documents).toHaveLength(0);
    expect(store.dirtyCount).toBe(0);

    const restored = source({ mediaAttemptsPerPage: 2 });
    const wake = vi.fn();
    restored.onPushEvent(wake);
    vi.advanceTimersByTime(60_000);
    expect(wake).toHaveBeenCalledOnce();
    const recovered = await restored.sync(settled.cursor);
    expect(recovered.documents.some((doc) => doc.content.includes("recovered image"))).toBe(true);
    expect(recovered.documents.some((doc) => doc.content.includes("recovered voice"))).toBe(true);
    expect(store.mediaHealthStats()).toEqual({ pending: 0, unavailable: 0 });
  });

  test("ineligible media cannot consume the sweep limit ahead of an eligible retry", async () => {
    store.addMessages([
      ...Array.from({ length: 201 }, (_, i) => mediaMessage(i)),
      {
        ...mediaMessage(202),
        type: "audio",
        media: { ...mediaMessage(202).media, isVoiceNote: true },
      },
    ]);
    // Simulate all primary pages already committed, leaving only media pending.
    let page = store.drain();
    while (page.morePending) page = store.drain({ committedSeq: page.emitSeq });
    store.drain({ committedSeq: page.emitSeq });
    const src = source({
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: false }),
    });
    const result = await src.sync(null);
    expect(result.documents.some((doc) => doc.content.includes("recovered voice"))).toBe(true);
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(extractAttachment).not.toHaveBeenCalled();
  });

  test("failed page replay and a newer same-day message retain acknowledgment safety", async () => {
    const src = source({
      attachmentConfig: resolveAttachmentConfig({ extractAttachments: false }),
    });
    store.addMessages([mediaMessage(0)]);
    const first = await src.sync(null);
    const replay = await src.sync(null); // Gateway rejected the first page.
    expect(replay.documents).toEqual(first.documents);
    store.addMessages([
      {
        ...mediaMessage(0),
        id: "arrival",
        type: "text",
        media: undefined,
        text: "arrived during push",
      },
    ]);
    const next = await src.sync(replay.cursor);
    expect(next.documents[0].content).toContain("arrived during push");
    const settled = await src.sync(next.cursor);
    expect(settled.documents).toHaveLength(0);
  });
});
