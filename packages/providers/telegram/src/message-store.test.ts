// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  ensureStorageKey,
  markStorageEncryptionRequired,
} from "@omnesis/core";
import { TelegramArchive, inspectTelegramStores } from "./message-store.js";
import { RENDER_REVISION } from "./normalizer.js";
import { readTelegramStoreKey, StoreKeyUnavailableError } from "./protected-store.js";
import { TelegramProvider } from "./provider.js";
import { writeSessionRecord } from "./session-store.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import {
  DAVID,
  HELPER_BOT,
  JAMIE,
  SELF,
  T0,
  chatOf,
  messageIn,
  privateChatWith,
  tempConfigDir,
  writeAppCredentials,
} from "./testing/fixtures.js";
import { extractMessage } from "./message-extractor.js";
import type { DrainedDay, MediaScope } from "./message-store.js";
import type { TgChat, TgMediaRef } from "./client/types.js";
import type { StoredMessage } from "./types.js";

const HEADER = "SQLite format 3\0";
const ACCOUNT = String(SELF.id);

function header(path: string): string {
  return readFileSync(path).subarray(0, HEADER.length).toString();
}

describe("TelegramArchive storage", () => {
  let configDir: string;
  let stateDir: string;

  beforeEach(() => {
    configDir = tempConfigDir("archive");
    stateDir = join(configDir, "telegram", ACCOUNT);
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function mintKey(): Promise<void> {
    await ensureInstallRootKey({ backend: "file", configDir });
    await ensureStorageKey("telegram-store", { backend: "file", configDir });
  }

  function openArchive(): TelegramArchive {
    const key = readTelegramStoreKey(configDir);
    try {
      return TelegramArchive.open(stateDir, key);
    } finally {
      key?.fill(0);
    }
  }

  it("creates every table of the schema and a stable archive identity", () => {
    const archive = openArchive();
    const id = archive.storeId;
    archive.close();
    const raw = new Database(join(stateDir, "archive.db"), { readonly: true });
    try {
      const tables = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((t) => t.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "meta",
          "chats",
          "users",
          "messages",
          "pending_deletions",
          "dirty_days",
          "emitted_attachments",
          "topics",
        ]),
      );
    } finally {
      raw.close();
    }
    const reopened = openArchive();
    expect(reopened.storeId).toBe(id);
    expect(reopened.getMeta("schema_version")).toBe("5");
    reopened.close();
  });

  it("encrypts the archive with the telegram-store key, and only that key opens it", async () => {
    await mintKey();
    const archive = openArchive();
    archive.upsertUsers([SELF]);
    archive.close();

    const path = join(stateDir, "archive.db");
    expect(header(path)).not.toBe(HEADER);
    expect(readFileSync(path).includes(Buffer.from("Maya Reeves"))).toBe(false);
    expect(() => {
      const raw = new Database(path, { readonly: true });
      try {
        raw.prepare("SELECT count(*) FROM users").get();
      } finally {
        raw.close();
      }
    }).toThrow();

    const reopened = openArchive();
    expect(reopened.getUser(SELF.id)?.displayName).toBe("Maya Reeves");
    reopened.close();
    expect(inspectTelegramStores(stateDir, configDir)).toEqual([
      { keyName: "telegram-store", label: "Telegram message archive", state: "encrypted" },
      { keyName: "telegram-store", label: "Telegram connection cache", state: "absent" },
    ]);
  });

  it("migrates a plaintext archive once the key exists, keeping its rows and identity", async () => {
    const plain = openArchive();
    plain.upsertUsers([SELF]);
    const id = plain.storeId;
    plain.close();
    expect(header(join(stateDir, "archive.db"))).toBe(HEADER);
    expect(inspectTelegramStores(stateDir, configDir)[0]?.state).toBe("plaintext");

    await mintKey();
    const archive = openArchive();
    expect(archive.storeId).toBe(id);
    expect(archive.getUser(SELF.id)?.displayName).toBe("Maya Reeves");
    archive.close();
    expect(header(join(stateDir, "archive.db"))).not.toBe(HEADER);
    expect(existsSync(join(stateDir, "archive.db.rekey"))).toBe(false);
  });

  it("refuses to open when encryption is required and the key is missing", async () => {
    await markStorageEncryptionRequired(configDir);
    expect(() => readTelegramStoreKey(configDir)).toThrow(StoreKeyUnavailableError);
    expect(() => readTelegramStoreKey(configDir)).toThrow(/omnesis keyring storage-init/u);
  });

  it("writes neither file when the key is missing, and never builds a client", async () => {
    await writeAppCredentials(configDir);
    const sim = new SimulatedTelegram({ self: SELF });
    await writeSessionRecord(
      {
        session: sim.issueSession(SELF.id),
        userId: ACCOUNT,
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
      },
      configDir,
    );
    await markStorageEncryptionRequired(configDir);
    await expect(
      TelegramProvider.open({ accountId: ACCOUNT, configDir, stateDir, factory: sim.factory }),
    ).rejects.toBeInstanceOf(StoreKeyUnavailableError);
    expect(existsSync(join(stateDir, "archive.db"))).toBe(false);
    expect(existsSync(join(stateDir, "mtcute.db"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual(["credentials.json"]);
    expect(sim.devices).toEqual([]);
  });

  it("quarantines a corrupt archive and starts an empty one", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "archive.db"), Buffer.alloc(8192, 7));
    const archive = openArchive();
    expect(archive.storeId).toMatch(/^[0-9a-f-]{36}$/u);
    archive.close();
    expect(readdirSync(stateDir).some((f) => f.startsWith("archive.db.corrupt-"))).toBe(true);
  });
});

describe("TelegramArchive writes and drain", () => {
  let dir: string;
  let clock: number;
  let archive: TelegramArchive;
  const chat: TgChat = privateChatWith(JAMIE);
  const channel: TgChat = chatOf(-1003000000003, "supergroup", "Studio Northstar crew");

  beforeEach(() => {
    dir = tempConfigDir("archive-writes");
    clock = T0 + 86_400;
    archive = TelegramArchive.open(dir, null, { now: () => clock });
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function stored(
    c: TgChat,
    id: number,
    ts: number,
    text: string,
    extra: Partial<StoredMessage> = {},
  ): StoredMessage {
    const m = extractMessage(messageIn(c, id, ts, text, { senderId: JAMIE.id }))!;
    return { ...m, ...extra };
  }

  function live(c: TgChat, m: StoredMessage): boolean {
    return archive.storeLive(c, [JAMIE], m, { id: m.msgId, date: m.ts }, true);
  }

  /** Drain everything pending and acknowledge it, returning what was drained. */
  function drainAll(): DrainedDay[] {
    const first = archive.drain({ committedSeq: 0, limit: 100 });
    archive.drain({ committedSeq: first.emitSeq, limit: 100 });
    return first.days;
  }

  it("publishes every day again once when an older build rendered them", () => {
    live(chat, stored(chat, 1, T0, "Q4 budget review at ten"));
    drainAll();
    expect(archive.dirtyDayCount()).toBe(0);
    // An archive whose days a build before local clock times rendered.
    archive.setMeta("render_revision", "1");
    archive.close();
    archive = TelegramArchive.open(dir, null, { now: () => clock });
    expect(archive.getMeta("render_revision")).toBe(String(RENDER_REVISION));
    expect(drainAll()).toHaveLength(1);
    // The current build's own archive is left alone on the next open.
    archive.close();
    archive = TelegramArchive.open(dir, null, { now: () => clock });
    expect(archive.dirtyDayCount()).toBe(0);
  });

  it("never issues one emitSeq twice across two handles on the archive", () => {
    live(chat, stored(chat, 1, T0, "Q4 budget review at ten"));
    // A rebuilt context opens its handle while the old one is still open.
    const second = TelegramArchive.open(dir, null, { now: () => clock });
    try {
      const a = archive.drain({ committedSeq: 0, limit: 10 });
      const b = second.drain({ committedSeq: a.emitSeq, limit: 10 });
      const c = archive.drain({ committedSeq: b.emitSeq, limit: 10 });
      expect(b.emitSeq).toBe(a.emitSeq + 1);
      expect(c.emitSeq).toBe(b.emitSeq + 1);
      // `b` was a value this archive issued, so it acknowledged the day.
      expect(archive.dirtyDayCount()).toBe(0);
    } finally {
      second.close();
    }
  });

  it("holds back a day whose render failed, keeps it queued across acks, and retries it later", () => {
    live(chat, stored(chat, 1, T0, "Q4 budget review at ten"));
    live(chat, stored(chat, 2, T0 + 86_400, "Heart-rate trend for the week"));
    const first = archive.drain({ committedSeq: 0, limit: 10 });
    expect(first.days).toHaveLength(2);
    expect(archive.quarantineDay(chat.id, "2026-03-10")).toBe(1);
    // The page's acknowledgement clears the day that rendered, not the failed one.
    const held = archive.drain({ committedSeq: first.emitSeq, limit: 10 });
    expect(held).toMatchObject({ days: [], morePending: false });
    expect(archive.dirtyDayCount()).toBe(1);
    expect(archive.quarantinedDayCount()).toBe(1);
    clock += 61;
    const retried = archive.drain({ committedSeq: held.emitSeq, limit: 10 });
    expect(retried.days.map((d) => d.date)).toEqual(["2026-03-10"]);
    expect(archive.quarantineDay(chat.id, "2026-03-10")).toBe(2);
    clock += 61;
    // The second failure waits twice as long.
    expect(archive.drain({ committedSeq: retried.emitSeq, limit: 10 }).days).toEqual([]);
    clock += 60;
    const third = archive.drain({ committedSeq: 0, limit: 10 });
    expect(third.days).toHaveLength(1);
    archive.drain({ committedSeq: third.emitSeq, limit: 10 });
    expect(archive.quarantinedDayCount()).toBe(0);
  });

  it("dates a day's last change by edits, deletions and renamed topics, never by a first write", () => {
    live(chat, stored(chat, 1, T0, "Q4 budget review at ten"));
    expect(drainAll()[0]!.changedAt).toBeUndefined();
    clock += 100;
    live(chat, stored(chat, 1, T0, "Q4 budget review at eleven", { editTs: T0 + 50 }));
    expect(drainAll()[0]!.changedAt).toBe(clock);
    clock += 100;
    archive.deleteMessages("common", [1]);
    expect(drainAll()[0]!.changedAt).toBe(clock);
  });

  it("marks a day dirty on an edit only when the edit is newer", () => {
    live(chat, stored(chat, 1, T0, "Q4 budget review at ten"));
    drainAll();
    expect(live(chat, stored(chat, 1, T0, "Q4 budget review at ten"))).toBe(false);
    expect(archive.dirtyDayCount()).toBe(0);
    expect(live(chat, stored(chat, 1, T0, "Q4 budget review at eleven", { editTs: T0 + 60 }))).toBe(
      true,
    );
    const [day] = archive.drain({ committedSeq: 0, limit: 10 }).days;
    expect(day?.messages[0]).toMatchObject({ text: "Q4 budget review at eleven", editTs: T0 + 60 });
    // An older copy of the message (a late walk page) does not undo the edit.
    expect(live(chat, stored(chat, 1, T0, "Q4 budget review at ten"))).toBe(false);
    expect(archive.getMessages(chat.id, [1]).get(1)?.text).toBe("Q4 budget review at eleven");
  });

  it("keeps the later of two edits made in the same second", () => {
    live(chat, stored(chat, 1, T0, "Draft"));
    live(chat, stored(chat, 1, T0, "First fix", { editTs: T0 + 60 }));
    drainAll();
    expect(live(chat, stored(chat, 1, T0, "Second fix", { editTs: T0 + 60 }))).toBe(true);
    expect(archive.getMessages(chat.id, [1]).get(1)?.text).toBe("Second fix");
    // The same content again is still a no-op.
    drainAll();
    expect(live(chat, stored(chat, 1, T0, "Second fix", { editTs: T0 + 60 }))).toBe(false);
  });

  it("skips a message whose common-box id another chat already holds, instead of failing", () => {
    const other: TgChat = privateChatWith(DAVID);
    live(chat, stored(chat, 7, T0, "Marathon entry form attached"));
    drainAll();
    // Telegram's common box is account-wide, so this should never happen; if
    // it does, the page must not fail on the deletion index for good.
    expect(live(other, stored(other, 7, T0 + 60, "Heart-rate trend for the week"))).toBe(false);
    expect(archive.idCollisionCount()).toBe(1);
    expect(archive.hasMessage(chat.id, 7)).toBe(true);
    expect(archive.hasMessage(other.id, 7)).toBe(false);
    expect(archive.dirtyDayCount()).toBe(0);
    // The same message in its own chat still updates as usual.
    expect(live(chat, stored(chat, 7, T0, "Marathon entry form v2", { editTs: T0 + 90 }))).toBe(
      true,
    );
  });

  it("deletes a common-box message through the id index, with no chat named", () => {
    live(chat, stored(chat, 7, T0, "Marathon entry form attached"));
    drainAll();
    expect(archive.deleteMessages("common", [7])).toBe(1);
    const { days } = archive.drain({ committedSeq: 0, limit: 10 });
    // The deletion is a change of the day: `sourceUpdatedAt` moves with it.
    expect(days).toEqual([
      { chatId: chat.id, date: "2026-03-10", messages: [], ledger: [], changedAt: clock },
    ]);
  });

  it("deletes a channel message only in its own box", () => {
    live(chat, stored(chat, 5, T0, "Private note five"));
    live(channel, stored(channel, 5, T0, "Group note five"));
    drainAll();
    expect(archive.deleteMessages(`channel:${channel.id}`, [5])).toBe(1);
    expect(archive.hasMessage(channel.id, 5)).toBe(false);
    expect(archive.hasMessage(chat.id, 5)).toBe(true);
  });

  it("applies a deletion that arrived before its message when the message arrives", () => {
    expect(archive.deleteMessages("common", [42])).toBe(0);
    expect(archive.pendingDeletionCount()).toBe(1);
    // The walk then delivers the message: it is stored deleted and never published.
    archive.commitWalkPage(chat.id, {
      messages: [stored(chat, 42, T0, "Already gone"), stored(chat, 41, T0 - 60, "Still here")],
      users: [JAMIE],
      rawIds: [42, 41],
      done: true,
    });
    expect(archive.pendingDeletionCount()).toBe(0);
    expect(archive.hasMessage(chat.id, 42)).toBe(false);
    const { days } = archive.drain({ committedSeq: 0, limit: 10 });
    expect(days[0]?.messages.map((m) => m.msgId)).toEqual([41]);
  });

  it("forgets an unmatched deletion after the pending window", () => {
    archive.deleteMessages("common", [99]);
    clock += 31 * 86_400;
    archive.drain({ committedSeq: 0, limit: 10 });
    expect(archive.pendingDeletionCount()).toBe(0);
    live(chat, stored(chat, 99, T0, "Arrived much later"));
    expect(archive.hasMessage(chat.id, 99)).toBe(true);
  });

  it("re-emits until the gateway acknowledges, and treats a foreign sequence as nothing acknowledged", () => {
    live(chat, stored(chat, 1, T0, "Riverside Estate visit"));
    const first = archive.drain({ committedSeq: 0, limit: 10 });
    expect(first.days).toHaveLength(1);
    // The page failed: the cursor did not advance, so the day comes back.
    const retry = archive.drain({ committedSeq: 0, limit: 10 });
    expect(retry.days.map((d) => d.date)).toEqual(["2026-03-10"]);
    expect(retry.emitSeq).toBeGreaterThan(first.emitSeq);
    // A sequence this archive never issued (another archive's cursor) acknowledges nothing.
    expect(archive.drain({ committedSeq: 10_000, limit: 10 }).days).toHaveLength(1);
    const last = archive.drain({ committedSeq: 0, limit: 10 });
    expect(archive.drain({ committedSeq: last.emitSeq, limit: 10 }).days).toHaveLength(0);
    expect(archive.dirtyDayCount()).toBe(0);
  });

  it("pages the drain and reports more pending", () => {
    for (let d = 0; d < 5; d++) live(chat, stored(chat, d + 1, T0 + d * 86_400, `Day ${d}`));
    const page = archive.drain({ committedSeq: 0, limit: 2 });
    expect(page.days.map((d) => d.date)).toEqual(["2026-03-14", "2026-03-13"]);
    expect(page.morePending).toBe(true);
  });

  it("retires ledgered attachments a render no longer produces, until that page is acknowledged", () => {
    live(chat, stored(chat, 1, T0, "Floor plan"));
    const first = archive.drain({ committedSeq: 0, limit: 10 });
    archive.settleAttachments(chat.id, "2026-03-10", ["day/att/a", "day/att/b"], first.emitSeq);
    archive.deleteMessages("common", [1]);
    const second = archive.drain({ committedSeq: first.emitSeq, limit: 10 });
    expect(second.days[0]?.ledger).toEqual(["day/att/a", "day/att/b"]);
    expect(archive.settleAttachments(chat.id, "2026-03-10", [], second.emitSeq)).toEqual([
      "day/att/a",
      "day/att/b",
    ]);
    // Not acknowledged: the day and its retired attachments come back.
    const retry = archive.drain({ committedSeq: first.emitSeq, limit: 10 });
    expect(retry.days[0]?.ledger).toEqual(["day/att/a", "day/att/b"]);
    archive.settleAttachments(chat.id, "2026-03-10", [], retry.emitSeq);
    archive.drain({ committedSeq: retry.emitSeq, limit: 10 });
    archive.markAllDirty();
    expect(archive.drain({ committedSeq: 0, limit: 10 }).days).toEqual([]);
  });

  it("purges an excluded chat's messages and dirties every day they touched", () => {
    live(chat, stored(chat, 1, T0, "One"));
    live(chat, stored(chat, 2, T0 + 86_400, "Two"));
    drainAll();
    expect(archive.applyExclusions(() => false)).toEqual({ purged: 1, restored: 0 });
    const { days } = archive.drain({ committedSeq: 0, limit: 10 });
    expect(days.map((d) => [d.date, d.messages.length])).toEqual([
      ["2026-03-11", 0],
      ["2026-03-10", 0],
    ]);
    expect(archive.getChat(chat.id)?.walkState).toBe("excluded");
    // Live messages of an excluded chat are not kept.
    expect(live(chat, stored(chat, 3, T0, "Three"))).toBe(false);
    expect(archive.applyExclusions(() => true)).toEqual({ purged: 0, restored: 1 });
    expect(archive.getChat(chat.id)).toMatchObject({ walkState: "pending", newestSeenId: 0 });
  });

  it("adds the second schema's columns to an archive the first one created", () => {
    archive.close();
    const path = join(dir, "old");
    mkdirSync(path, { recursive: true });
    const raw = new Database(join(path, "archive.db"));
    raw.exec(
      "CREATE TABLE users (user_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, username TEXT, phone_e164 TEXT, is_bot INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    raw.close();
    archive = TelegramArchive.open(path, null, { now: () => clock });
    archive.upsertUsers([HELPER_BOT]);
    expect(archive.getUser(HELPER_BOT.id)).toMatchObject({ isBot: true, isDeleted: false });
  });
});

describe("TelegramArchive media lifecycle", () => {
  let dir: string;
  let clock: number;
  let archive: TelegramArchive;
  const chat: TgChat = privateChatWith(JAMIE);
  const ALL: MediaScope = { voiceNotes: true, attachments: true };

  beforeEach(() => {
    dir = tempConfigDir("archive-media");
    clock = T0 + 86_400;
    archive = TelegramArchive.open(dir, null, { now: () => clock });
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function withMedia(id: number, ts: number, media: TgMediaRef, editDate?: number): StoredMessage {
    return extractMessage(
      messageIn(chat, id, ts, "", { senderId: JAMIE.id, media, ...(editDate ? { editDate } : {}) }),
    )!;
  }

  function live(m: StoredMessage): boolean {
    return archive.storeLive(chat, [JAMIE], m, { id: m.msgId, date: m.ts }, true);
  }

  const read = (id: number): StoredMessage => archive.getMessages(chat.id, [id]).get(id)!;
  const pdf = (fileId: string, size = 100): TgMediaRef => ({
    kind: "document",
    fileId,
    fileName: "plan.pdf",
    mimeType: "application/pdf",
    size,
    isViewOnce: false,
  });

  it("enrols downloadable voice notes, photos and documents, and nothing else", () => {
    live(withMedia(1, T0, { kind: "voice", fileId: "v", isViewOnce: false }));
    live(withMedia(2, T0, pdf("d")));
    live(withMedia(3, T0, { kind: "video", fileId: "m", isViewOnce: false }));
    live(withMedia(4, T0, { kind: "photo", isViewOnce: false }));
    expect([1, 2, 3, 4].map((id) => read(id).mediaState)).toEqual([
      "pending",
      "pending",
      undefined,
      undefined,
    ]);
    expect(read(1).mediaNextAttempt).toBe(0);
  });

  it("re-arms only the due days in scope, most recent first, bounded by the limit", () => {
    live(withMedia(1, T0, { kind: "voice", fileId: "v", isViewOnce: false }));
    live(withMedia(2, T0 + 86_400, pdf("d")));
    archive.drain({ committedSeq: 0, limit: 10 });
    archive.drain({ committedSeq: 1, limit: 10 });
    expect(archive.dirtyDayCount()).toBe(0);

    expect(archive.markDueMediaDirty({ voiceNotes: true, attachments: false }, 10)).toBe(1);
    const [voiceDay] = archive.drain({ committedSeq: 2, limit: 10 }).days;
    expect(voiceDay?.date).toBe("2026-03-10");
    archive.drain({ committedSeq: 3, limit: 10 });
    expect(archive.markDueMediaDirty(ALL, 1)).toBe(1);
    expect(archive.drain({ committedSeq: 4, limit: 10 }).days.map((d) => d.date)).toEqual([
      "2026-03-11",
    ]);
    // Inside the cutoff only.
    archive.drain({ committedSeq: 5, limit: 10 });
    expect(archive.markDueMediaDirty({ ...ALL, minTs: T0 + 3 * 86_400 }, 10)).toBe(0);
  });

  it("backs a failed download off, gives it up after the last attempt, and never gives up processing", () => {
    live(withMedia(1, T0, pdf("d1")));
    live(withMedia(2, T0, pdf("d2", 200)));
    archive.recordMediaOutcome(chat.id, 1, { kind: "transient", error: "Connection reset" });
    expect(read(1)).toMatchObject({ mediaState: "pending", mediaNextAttempt: clock + 20 });
    expect(archive.nextMediaDue(ALL)).toBe(0);
    archive.recordMediaOutcome(chat.id, 2, { kind: "transient", error: "x", retryAfterSec: 900 });
    expect(read(2).mediaNextAttempt).toBe(clock + 900);
    for (let i = 0; i < 11; i++) {
      archive.recordMediaOutcome(chat.id, 1, { kind: "transient", error: "Connection reset" });
    }
    expect(read(1).mediaState).toBe("unavailable");
    for (let i = 0; i < 20; i++) {
      archive.recordMediaOutcome(chat.id, 2, {
        kind: "process-failed",
        error: "extraction-failed",
      });
    }
    expect(read(2)).toMatchObject({ mediaState: "pending", mediaNextAttempt: clock + 43_200 });
    expect(archive.mediaHealthStats(ALL)).toEqual({
      voiceNotes: { pending: 0, transcriberUnavailable: 0, unavailable: 0 },
      attachments: { pending: 1, unavailable: 1 },
    });
  });

  it("keeps a transcript and an extraction, and a resync processes them again without losing them", () => {
    live(withMedia(1, T0, { kind: "voice", fileId: "v", isViewOnce: false }));
    live(withMedia(2, T0, pdf("d")));
    archive.recordMediaOutcome(chat.id, 1, { kind: "transcribed", text: "Rehearsal at six" });
    archive.recordMediaOutcome(chat.id, 2, {
      kind: "extracted",
      extraction: JSON.stringify({ text: "Floor plan", truncated: false }),
      complete: true,
    });
    expect(read(1)).toMatchObject({ mediaState: "done", transcript: "Rehearsal at six" });
    expect(read(2)).toMatchObject({ mediaState: "done", extraction: { text: "Floor plan" } });
    archive.resetMediaForResync();
    expect(read(1)).toMatchObject({ mediaState: "pending", transcript: "Rehearsal at six" });
    expect(read(2)).toMatchObject({ mediaState: "pending", extraction: { text: "Floor plan" } });
  });

  it("restarts the lifecycle when an edit replaces the media, not when only the reference changes", () => {
    live(withMedia(1, T0, pdf("d1")));
    archive.recordMediaOutcome(chat.id, 1, {
      kind: "extracted",
      extraction: JSON.stringify({ text: "Old plan", truncated: false }),
      complete: true,
    });
    // The same file under a refreshed reference, delivered by an edit of the caption.
    live(withMedia(1, T0, pdf("d1~ref2"), T0 + 60));
    expect(read(1)).toMatchObject({ mediaState: "done", extraction: { text: "Old plan" } });
    // A different file.
    live(withMedia(1, T0, pdf("d9", 999), T0 + 120));
    expect(read(1)).toMatchObject({ mediaState: "pending", mediaNextAttempt: 0 });
    expect(read(1).extraction).toBeUndefined();
  });

  it("holds every download while a download flood wait lasts", () => {
    live(withMedia(1, T0, pdf("d1")));
    archive.recordMediaFlood(300);
    expect(archive.mediaFloodUntil()).toBe(clock + 300);
    expect(archive.markDueMediaDirty(ALL, 10)).toBe(0);
    expect(archive.hasDueMedia(ALL, new Set())).toBe(false);
    expect(archive.nextMediaDue(ALL)).toBe(clock + 300);
    clock += 301;
    expect(archive.hasDueMedia(ALL, new Set())).toBe(true);
    expect(archive.hasDueMedia(ALL, new Set([`${chat.id}:1`]))).toBe(false);
  });

  it("enrols the media a schema-2 archive kept as placeholders", () => {
    live(withMedia(1, T0, pdf("d1")));
    archive.close();
    const raw = new Database(join(dir, "archive.db"));
    raw.exec("UPDATE messages SET media_state = NULL, media_next_attempt = NULL");
    raw.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    raw.close();
    archive = TelegramArchive.open(dir, null, { now: () => clock });
    expect(read(1)).toMatchObject({ mediaState: "pending", mediaNextAttempt: 0 });
    expect(archive.getMeta("schema_version")).toBe("5");
  });
});
