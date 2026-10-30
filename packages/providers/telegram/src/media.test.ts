// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Media end to end over the simulated server (`docs/telegram-source.md` §10,
 * §13 phase 3): voice notes transcribed inline, photos and documents as
 * attachment documents, the lifecycle across failures, and the budget that
 * keeps downloads lazy. The transcriber and extractor are deterministic stubs
 * standing in at the host seam; no model runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIBER_UNAVAILABLE, resolveAttachmentConfig } from "@omnesis/core";
import { TelegramError, type TgMediaRef, type TgMessage } from "./client/types.js";
import {
  JAMIE,
  T0,
  latestDocs,
  messageIn,
  messageRun,
  privateChatWith,
  syncAll,
  syncRig,
  type SyncRig,
} from "./testing/fixtures.js";
import type { AttachmentExtractFn, AudioTranscribeFn } from "@omnesis/core";
import type { TelegramMessagesSourceOptions } from "./messages.js";
import type { TelegramSyncCursor } from "./types.js";
import type { SyncResult } from "@omnesis/source-sdk";

const CHAT = privateChatWith(JAMIE);
const DAY = `${JAMIE.id}:2026-03-10`;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

/** The host's speech-to-text: speaks back the bytes it is given. */
function echoTranscriber(): AudioTranscribeFn & ReturnType<typeof vi.fn> {
  return vi.fn((data: Uint8Array) => Promise.resolve({ text: decode(data) })) as never;
}

/** The host's extractor: a photo reads as OCR text, a document as its bytes. */
function echoExtractor(): AttachmentExtractFn & ReturnType<typeof vi.fn> {
  return vi.fn((data: Uint8Array, mime: string) =>
    Promise.resolve({
      text: mime.startsWith("image/") ? `OCR ${decode(data)}` : decode(data),
      truncated: false,
    }),
  ) as never;
}

function voice(fileId: string, durationSec = 7): TgMediaRef {
  return { kind: "voice", fileId, mimeType: "audio/ogg", size: 64, durationSec, isViewOnce: false };
}

function doc(fileId: string, fileName: string, size = 64, mimeType = "text/plain"): TgMediaRef {
  return { kind: "document", fileId, fileName, mimeType, size, isViewOnce: false };
}

function photo(fileId: string, size = 64): TgMediaRef {
  return { kind: "photo", fileId, mimeType: "image/jpeg", size, isViewOnce: false };
}

function from(id: number, ts: number, media: TgMediaRef, text = ""): TgMessage {
  return messageIn(CHAT, id, ts, text, { senderId: JAMIE.id, senderName: "Jamie Lopez", media });
}

let rig: SyncRig | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await rig?.dispose();
  rig = undefined;
});

async function mediaRig(
  messages: TgMessage[],
  bytes: Record<string, string | "gone">,
  options: Partial<TelegramMessagesSourceOptions> = {},
): Promise<SyncRig> {
  rig = await syncRig(
    { users: [JAMIE], chats: [{ chat: CHAT, messages }] },
    {
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      mediaAttemptsPerPage: 10,
      ...options,
    },
  );
  for (const [fileId, content] of Object.entries(bytes)) {
    rig.sim.setMedia(fileId, content === "gone" ? "gone" : utf8(content));
  }
  return rig;
}

/**
 * Archive the corpus first with no media processing (as a host without a
 * transcriber or extractor would), then rebuild the source with `options`.
 */
async function archiveThenEnable(
  r: SyncRig,
  options: Partial<TelegramMessagesSourceOptions>,
): Promise<TelegramSyncCursor> {
  r.remake({ extractAttachment: undefined, transcribeAudio: undefined });
  const { cursor } = await syncAll(r.source, null);
  r.remake(options);
  return cursor;
}

const downloads = (r: SyncRig): number => r.sim.calls.filter((c) => c.method === "download").length;

function dayDoc(pages: SyncResult<TelegramSyncCursor>[]) {
  return latestDocs(pages).get(DAY)!;
}

/** Move the clock past every backoff (Date only; the simulator's timers stay real). */
function advance(seconds: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + seconds * 1000);
}

describe("voice notes", () => {
  it("transcribes a voice note into the day's text, once", async () => {
    const transcribe = echoTranscriber();
    const r = await mediaRig(
      [from(1, T0, voice("v1", 7))],
      { v1: "Rehearsal moved to six" },
      { transcribeAudio: transcribe },
    );
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).content).toContain(
      "Jamie Lopez: [Voice note, 0:07]: Rehearsal moved to six",
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]![2]).toMatchObject({
      context: {
        purpose: "source-audio",
        speaker: {
          identifiers: [{ kind: "lid", value: `telegram-user:${JAMIE.id}` }, expect.anything()],
        },
        conversation: { threadId: String(JAMIE.id) },
      },
    });
    // A later re-render of the day keeps the transcript without downloading again.
    r.sim.pushNew(CHAT.id, { text: "See you there", date: T0 + 60 });
    const again = await r.source.sync(boot.cursor);
    expect(again.documents[0]!.content).toContain("Rehearsal moved to six");
    expect(downloads(r)).toBe(1);
  });

  it("degrades to a placeholder and a warning without a transcriber, and recovers when one appears", async () => {
    let available = false;
    const transcribe = vi.fn((data: Uint8Array) =>
      Promise.resolve(available ? { text: decode(data) } : null),
    );
    const r = await mediaRig(
      [from(1, T0, voice("v1", 65))],
      { v1: "Q4 budget review notes" },
      { transcribeAudio: transcribe },
    );
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).content).toContain("[Voice note, 1:05 — no transcriber available]");
    const last = boot.pages.at(-1)!;
    expect(last.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "transcription-awaiting", severity: "warning", count: 1 }),
      ]),
    );
    const stored = r.provider.getArchive().getMessages(CHAT.id, [1]).get(1)!;
    expect(stored).toMatchObject({
      mediaState: "pending",
      mediaLastError: TRANSCRIBER_UNAVAILABLE,
    });

    available = true;
    advance(3600);
    const later = await syncAll(r.source, boot.cursor);
    expect(dayDoc(later.pages).content).toContain("[Voice note, 1:05]: Q4 budget review notes");
    expect(later.pages.at(-1)!.issues ?? []).toEqual([]);
  });

  it("marks a voice note Telegram no longer has unavailable, without retrying it", async () => {
    const r = await mediaRig(
      [from(1, T0, voice("v1"))],
      { v1: "gone" },
      {
        transcribeAudio: echoTranscriber(),
      },
    );
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).content).toContain("[Voice note, 0:07 — audio unavailable]");
    expect(boot.pages.at(-1)!.issues).toEqual([
      expect.objectContaining({ code: "transcription-audio-unavailable", count: 1 }),
    ]);
    advance(86_400);
    await syncAll(r.source, boot.cursor);
    expect(downloads(r)).toBe(1);
  });

  it("keeps audio, video, stickers and round videos as placeholders, never downloaded", async () => {
    const r = await mediaRig(
      [
        from(1, T0, { kind: "audio", fileId: "a1", durationSec: 200, isViewOnce: false }),
        from(2, T0 + 60, { kind: "video", fileId: "m1", durationSec: 12, isViewOnce: false }),
        from(3, T0 + 120, { kind: "sticker", summary: "🙂", isViewOnce: false }),
        from(4, T0 + 180, { kind: "video_note", fileId: "n1", durationSec: 9, isViewOnce: false }),
        from(5, T0 + 240, { ...photo("p-once"), isViewOnce: true }),
      ],
      {},
      { transcribeAudio: echoTranscriber(), extractAttachment: echoExtractor() },
    );
    const boot = await syncAll(r.source, null);
    const content = dayDoc(boot.pages).content;
    expect(content).toContain("[Audio, 3:20]");
    expect(content).toContain("[Video, 0:12]");
    expect(content).toContain("[Sticker 🙂]");
    expect(content).toContain("[Video message]");
    // View-once media is never stored at all.
    expect(content).not.toContain("[Photo]");
    expect(downloads(r)).toBe(0);
  });
});

describe("attachments", () => {
  it("emits a photo's OCR and a document's text as child documents dated by their message", async () => {
    const r = await mediaRig(
      [from(1, T0, photo("p1"), "floor plan"), from(2, T0 + 3600, doc("d1", "budget.txt"))],
      { p1: "Room 4 is the studio", d1: "Q4 budget review: approved" },
      { extractAttachment: echoExtractor() },
    );
    const boot = await syncAll(r.source, null);
    const docs = latestDocs(boot.pages);
    const children = [...docs.values()].filter((d) => d.metadata.documentType === "attachment");
    expect(children.map((d) => [d.title, d.content, d.sourceCreatedAt]).sort()).toEqual([
      ["budget.txt", "Q4 budget review: approved", new Date((T0 + 3600) * 1000).toISOString()],
      ["photo.jpg", "OCR Room 4 is the studio", new Date(T0 * 1000).toISOString()],
    ]);
    for (const child of children) {
      expect(child.externalId.startsWith(`${DAY}/att/`)).toBe(true);
      expect(child.metadata.extra?.parentExternalId).toBe(DAY);
    }
    const parent = docs.get(DAY)!;
    expect(parent.content).toContain("**Attachments:** photo.jpg");
    expect(parent.metadata.extra?.attachments).toHaveLength(2);
  });

  it("skips an attachment over the size limit without downloading it", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "archive.pdf", 50 * 1024 * 1024, "application/pdf"))],
      { d1: "never fetched" },
      { extractAttachment: echoExtractor() },
    );
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).metadata.extra?.attachments).toEqual([
      expect.objectContaining({ filename: "archive.pdf", extracted: false, reason: "too-large" }),
    ]);
    expect(downloads(r)).toBe(0);
    expect(r.provider.getArchive().getMessages(CHAT.id, [1]).get(1)?.mediaState).toBe("skipped");
  });

  it("refreshes a stale file reference by fetching the message again", async () => {
    const r = await mediaRig([from(1, T0, doc("d1", "budget.txt"))], { d1: "Approved budget" });
    const cursor = await archiveThenEnable(r, { extractAttachment: echoExtractor() });
    // Hours later the reference the archive holds has expired.
    const fresh = r.sim.expireReference(CHAT.id, 1);
    const boot = await syncAll(r.source, cursor);
    const child = [...latestDocs(boot.pages).values()].find((d) => d.title === "budget.txt");
    expect(child?.content).toBe("Approved budget");
    const methods = r.sim.calls.map((c) => c.method);
    expect(methods.filter((m) => m === "download")).toHaveLength(2);
    expect(methods).toContain("getMessages");
    expect(r.provider.getArchive().getMessages(CHAT.id, [1]).get(1)?.media?.fileId).toBe(fresh);
  });

  it("retries an extraction that found no extractor, and keeps text flowing meanwhile", async () => {
    let ready = false;
    const extract = vi.fn((data: Uint8Array) =>
      Promise.resolve(ready ? { text: decode(data), truncated: false } : null),
    );
    const r = await mediaRig(
      [from(1, T0, photo("p1"), "whiteboard")],
      { p1: "ship on the fifth" },
      {
        extractAttachment: extract,
      },
    );
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).content).toContain("whiteboard");
    expect(dayDoc(boot.pages).metadata.extra?.attachments).toEqual([
      expect.objectContaining({ extracted: false, reason: "extraction-failed" }),
    ]);
    ready = true;
    advance(3600);
    const later = await syncAll(r.source, boot.cursor);
    expect([...latestDocs(later.pages).values()].map((d) => d.content)).toContain(
      "ship on the fifth",
    );
  });
});

describe("the media lifecycle", () => {
  it("treats a download flood wait as transient and stops every download until it ends", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "a.txt")), from(2, T0 + 60, doc("d2", "b.txt"))],
      { d1: "first", d2: "second" },
      { extractAttachment: echoExtractor() },
    );
    r.sim.floodWait("download", 300);
    const boot = await syncAll(r.source, null);
    expect(downloads(r)).toBe(1);
    const archive = r.provider.getArchive();
    expect(archive.mediaFloodUntil()).toBeGreaterThan(Date.now() / 1000 + 250);
    const flooded = archive.getMessages(CHAT.id, [1]).get(1)!;
    expect(flooded.mediaState).toBe("pending");
    expect(flooded.mediaNextAttempt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 300);
    // The other download was not even tried, and is not counted against it.
    expect(archive.getMessages(CHAT.id, [2]).get(2)).toMatchObject({
      mediaState: "pending",
      mediaNextAttempt: 0,
    });
    // The text was published all the same.
    expect(dayDoc(boot.pages)).toBeDefined();

    advance(301);
    const later = await syncAll(r.source, boot.cursor);
    const contents = [...latestDocs(later.pages).values()].map((d) => d.content);
    expect(contents).toEqual(expect.arrayContaining(["first", "second"]));
  });

  it("gives up on a file Telegram no longer has, and backs off a transient failure", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "a.txt")), from(2, T0 + 60, doc("d2", "b.txt"))],
      { d1: "gone", d2: "kept" },
      { extractAttachment: echoExtractor() },
    );
    r.sim.failNext("download", new TelegramError("network", "Connection reset"));
    const boot = await syncAll(r.source, null);
    const archive = r.provider.getArchive();
    const state = (id: number) => archive.getMessages(CHAT.id, [id]).get(id)!;
    // The network failure fell on the first file: retried after the first step.
    expect(state(1)).toMatchObject({ mediaState: "pending", mediaLastError: "Connection reset" });
    expect(state(1).mediaNextAttempt).toBeGreaterThan(Date.now() / 1000);
    expect(state(2).mediaState).toBe("done");
    // Not before its backoff ends.
    await syncAll(r.source, boot.cursor);
    expect(downloads(r)).toBe(2);
    advance(30);
    await syncAll(r.source, boot.cursor);
    expect(downloads(r)).toBe(3);
    expect(state(1).mediaState).toBe("unavailable");
  });

  it("starts at most the page budget of downloads, so a bootstrap never bulk-downloads", async () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      from(i + 1, T0 + i * 86_400, doc(`d${i + 1}`, `note-${i + 1}.txt`)),
    );
    const bytes = Object.fromEntries(messages.map((m) => [m.media!.fileId!, `body ${m.id}`]));
    const r = await mediaRig(messages, bytes, {
      extractAttachment: echoExtractor(),
      mediaAttemptsPerPage: 1,
    });
    // Time for the walk, not for a media backlog: this run does one download.
    const page = await r.source.sync(null, {
      run: {
        id: "run-1",
        reason: "scheduled",
        start: "warm",
        page: 0,
        deadline: Date.now() + 10 * 60_000,
      },
    } as never);
    expect(page.documents.filter((d) => d.metadata.documentType === "conversation")).toHaveLength(
      6,
    );
    expect(downloads(r)).toBe(1);
    // Every later page spends one more, most recent day first.
    let cursor = page.cursor;
    for (let i = 0; i < 5; i++) cursor = (await r.source.sync(cursor)).cursor;
    expect(downloads(r)).toBe(6);
  });

  it("keeps a backlog going page after page while the run has time", async () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      from(i + 1, T0 + i * 86_400, doc(`d${i + 1}`, `note-${i + 1}.txt`)),
    );
    const bytes = Object.fromEntries(messages.map((m) => [m.media!.fileId!, `body ${m.id}`]));
    const r = await mediaRig(messages, bytes, {
      extractAttachment: echoExtractor(),
      mediaAttemptsPerPage: 1,
    });
    const run = await syncAll(r.source, null);
    expect(downloads(r)).toBe(4);
    // Never more downloads than pages: one per page, however large the backlog.
    expect(run.pages.length).toBeGreaterThanOrEqual(4);
    const children = [...latestDocs(run.pages).values()].filter(
      (d) => d.metadata.documentType === "attachment",
    );
    expect(children).toHaveLength(4);
  });

  it("leaves media pending when the sync is cancelled mid-download", async () => {
    const r = await mediaRig([from(1, T0, doc("d1", "a.txt"))], { d1: "body" });
    const cursor = await archiveThenEnable(r, { extractAttachment: echoExtractor() });
    const controller = new AbortController();
    controller.abort();
    const page = await r.source.sync(cursor, { signal: controller.signal });
    // The retry sweep re-armed the day; it renders without its attachment.
    expect(page.documents.map((d) => d.externalId)).toEqual([DAY]);
    const stored = r.provider.getArchive().getMessages(CHAT.id, [1]).get(1)!;
    expect(stored).toMatchObject({ mediaState: "pending", mediaNextAttempt: 0 });
    expect(stored.mediaLastError).toBeUndefined();
  });

  it("wakes a sync when the next retry comes due, and not before", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "a.txt"))],
      { d1: "body" },
      {
        extractAttachment: echoExtractor(),
      },
    );
    r.sim.failNext("download", new TelegramError("network", "Connection reset"));
    await syncAll(r.source, null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let wakes = 0;
    const off = r.source.onPushEvent(() => wakes++);
    vi.advanceTimersByTime(18_000);
    expect(wakes).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(wakes).toBe(1);
    off();
    r.source.dispose();
  });

  it("publishes the day's text while every download fails", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "a.txt"), "Here is the contract")],
      { d1: "body" },
      { extractAttachment: echoExtractor(), transcribeAudio: echoTranscriber() },
    );
    for (let i = 0; i < 5; i++) r.sim.failNext("download", new TelegramError("unknown", "boom"));
    const boot = await syncAll(r.source, null);
    expect(dayDoc(boot.pages).content).toContain("Here is the contract");
  });
});

describe("attachment tombstones", () => {
  it("tombstones a deleted message's attachment and keeps a surviving one", async () => {
    const r = await mediaRig(
      [
        from(1, T0, doc("d1", "keep.txt"), "first"),
        from(2, T0 + 60, doc("d2", "drop.txt"), "second"),
        ...messageRun(CHAT, JAMIE, 3, 1, T0 + 120),
      ],
      { d1: "kept body", d2: "dropped body" },
      { extractAttachment: echoExtractor() },
    );
    const boot = await syncAll(r.source, null);
    const children = [...latestDocs(boot.pages).values()].filter(
      (d) => d.metadata.documentType === "attachment",
    );
    const keep = children.find((d) => d.title === "keep.txt")!.externalId;
    const drop = children.find((d) => d.title === "drop.txt")!.externalId;

    r.sim.pushDelete(CHAT.id, [2]);
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds).toEqual([drop]);
    // The surviving attachment is re-emitted from the archive, not downloaded again.
    expect(page.documents.map((d) => d.externalId).sort()).toEqual([DAY, keep].sort());
    expect(downloads(r)).toBe(2);

    // Acknowledged: nothing is tombstoned again.
    const next = await r.source.sync(page.cursor);
    expect(next.deletedExternalIds).toEqual([]);

    // The last messages go: the day and its remaining attachment are tombstoned.
    r.sim.pushDelete(CHAT.id, [1, 3]);
    const emptied = await r.source.sync(next.cursor);
    expect(emptied.deletedExternalIds.sort()).toEqual([DAY, keep].sort());
  });

  it("tombstones a retired attachment again when the page that retired it was not accepted", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "keep.txt"), "first"), from(2, T0 + 60, doc("d2", "drop.txt"))],
      { d1: "kept", d2: "dropped" },
      { extractAttachment: echoExtractor() },
    );
    const boot = await syncAll(r.source, null);
    r.sim.pushDelete(CHAT.id, [2]);
    const lost = await r.source.sync(boot.cursor);
    expect(lost.deletedExternalIds).toHaveLength(1);
    // The gateway never saw that page: the next one starts from the old cursor.
    const retry = await r.source.sync(boot.cursor);
    expect(retry.deletedExternalIds).toEqual(lost.deletedExternalIds);
  });
});

describe("resync", () => {
  it("transcribes every voice note again with the current transcriber", async () => {
    const transcribe = echoTranscriber();
    const r = await mediaRig(
      [from(1, T0, voice("v1"))],
      { v1: "first take" },
      {
        transcribeAudio: transcribe,
      },
    );
    const boot = await syncAll(r.source, null);
    r.sim.setMedia("v1", utf8("second take"));
    r.source.onResync();
    const again = await syncAll(r.source, boot.cursor);
    expect(dayDoc(again.pages).content).toContain("[Voice note, 0:07]: second take");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("keeps an attachment whose file is gone by the time a resync fetches it again", async () => {
    const r = await mediaRig(
      [from(1, T0, doc("d1", "plan.txt"))],
      { d1: "Floor plan v2" },
      {
        extractAttachment: echoExtractor(),
      },
    );
    const boot = await syncAll(r.source, null);
    const child = [...latestDocs(boot.pages).values()].find((d) => d.title === "plan.txt")!;
    r.sim.setMedia("d1", "gone");
    r.source.onResync();
    const again = await syncAll(r.source, boot.cursor);
    const all = again.pages.flatMap((p) => p.deletedExternalIds);
    expect(all).not.toContain(child.externalId);
    expect(latestDocs(again.pages).get(child.externalId)?.content).toBe("Floor plan v2");
  });
});
