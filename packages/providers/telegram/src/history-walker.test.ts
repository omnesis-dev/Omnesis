// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The history walk against the simulated server: pagination, the dialog
 * policy, resumption, pacing, flood waits, the data cutoff, and every way a
 * gap is recovered (`docs/telegram-source.md` §7.2–§7.5, §13 phase 2).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import {
  DAVID,
  JAMIE,
  T0,
  chatOf,
  latestDocs,
  messageIn,
  messageRun,
  privateChatWith,
  syncAll,
  syncRig,
  type SyncRig,
} from "./testing/fixtures.js";
import { isChatIncluded } from "./history-walker.js";
import { TelegramError } from "./client/types.js";
import { HISTORY_MIN_INTERVAL_MS } from "./limits.js";
import { REVOKED_REMEDIATION } from "./provider.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { TgChat, TgMessage } from "./client/types.js";
import type { TelegramSyncCursor } from "./types.js";

const JAMIE_CHAT = privateChatWith(JAMIE);
const DAVID_CHAT = privateChatWith(DAVID);

let rig: SyncRig | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await rig?.dispose();
  rig = undefined;
});

function historyCalls(r: SyncRig, chatId?: number): Array<{ offsetId: number; minId?: number }> {
  return r.sim.calls
    .filter((c) => c.method === "getHistory")
    .map((c) => c.args as { chatId: number; offsetId: number; minId?: number })
    .filter((a) => chatId === undefined || a.chatId === chatId);
}

/** Run a promise to completion while fake timers drive everything it waits on. */
async function drive<T>(promise: Promise<T>, stepMs = 50): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  while (!settled) await vi.advanceTimersByTimeAsync(stepMs);
  return tracked;
}

describe("the bootstrap walk", () => {
  it("pages every chat newest to oldest until an empty page, across many pages", async () => {
    const messages = messageRun(JAMIE_CHAT, JAMIE, 1, 350, T0);
    rig = await syncRig({ users: [JAMIE], chats: [{ chat: JAMIE_CHAT, messages }] });
    const { pages } = await syncAll(rig.source, null);

    // A short page is not the end (mtcute drops empty entries): the empty one is.
    expect(historyCalls(rig).map((c) => c.offsetId)).toEqual([0, 251, 151, 51, 1]);
    expect(rig.provider.getArchive().messageCount()).toBe(350);
    expect(rig.provider.getArchive().getChat(JAMIE_CHAT.id)?.walkState).toBe("done");
    const last = pages.at(-1)!;
    expect(last.progress).toMatchObject({ phase: "incremental", coverage: "complete" });
    // 350 messages a minute apart span one day.
    expect([...latestDocs(pages).keys()]).toEqual([`${JAMIE_CHAT.id}:2026-03-10`]);
  });

  it("takes the most recently active chat first", async () => {
    rig = await syncRig({
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 2, T0) },
        { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 3, 2, T0 + 86_400) },
      ],
    });
    await syncAll(rig.source, null);
    const order = rig.sim.calls
      .filter((c) => c.method === "getHistory")
      .map((c) => (c.args as { chatId: number }).chatId);
    expect([...new Set(order)]).toEqual([DAVID_CHAT.id, JAMIE_CHAT.id]);
  });

  it("includes archived chats, and keeps their archived flag through a live update", async () => {
    const archived = privateChatWith(DAVID, { isArchived: true });
    rig = await syncRig({
      users: [DAVID],
      chats: [{ chat: archived, messages: messageRun(archived, DAVID, 1, 3, T0) }],
    });
    const first = await syncAll(rig.source, null);
    const doc = latestDocs(first.pages).get(`${DAVID.id}:2026-03-10`)!;
    expect(doc.metadata.extra).toMatchObject({ isArchived: true });

    // A live update says nothing about the archive folder; it must not unarchive.
    rig.sim.pushNew(DAVID.id, { text: "Sending the marathon entry form", date: T0 + 600 });
    const second = await syncAll(rig.source, first.cursor);
    expect(rig.provider.getArchive().getChat(DAVID.id)?.isArchived).toBe(true);
    expect(latestDocs(second.pages).get(`${DAVID.id}:2026-03-10`)?.metadata.extra).toMatchObject({
      isArchived: true,
    });
  });

  it("leaves broadcast channels out unless they are switched on, and honours exclusions", async () => {
    const channel = chatOf(-1001000000001, "channel", "Riverside Estate news", {
      username: "riverside_news_example",
    });
    const group = chatOf(-4001000001, "group", "Studio Northstar crew");
    const chats = [
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 2, T0) },
      { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 3, 2, T0) },
      {
        chat: group,
        messages: [messageIn(group, 5, T0, "Rehearsal at six", { senderId: DAVID.id })],
      },
      {
        chat: channel,
        messages: [messageIn(channel, 1, T0, "Gates open at nine", { senderId: channel.id })],
      },
    ];
    rig = await syncRig(
      { users: [JAMIE, DAVID], chats },
      {
        policy: { includeChannels: false, excludedChats: [`@${JAMIE.username}`, String(group.id)] },
      },
    );
    const { pages } = await syncAll(rig.source, null);
    expect([...latestDocs(pages).keys()]).toEqual([`${DAVID.id}:2026-03-10`]);
    const walked = historyCalls(rig).length;
    expect(walked).toBe(2); // one page and the empty one that ends it
    expect(rig.provider.getArchive().getChat(channel.id)?.walkState).toBe("excluded");

    // Channels on, exclusions cleared: the next sync walks what it skipped.
    rig.remake({ policy: { includeChannels: true, excludedChats: [] } });
    const after = await syncAll(rig.source, pages.at(-1)!.cursor);
    expect([...latestDocs(after.pages).keys()].sort()).toEqual(
      [`${JAMIE.id}:2026-03-10`, `${group.id}:2026-03-10`, `${channel.id}:2026-03-10`].sort(),
    );
  });

  it("matches exclusions by marked id or @username, case-insensitively for usernames", () => {
    const policy = { includeChannels: true, excludedChats: ["@Jamie_Lopez_Example", "-4001"] };
    expect(isChatIncluded(JAMIE_CHAT, policy)).toBe(false);
    expect(isChatIncluded(chatOf(-4001, "group", "x"), policy)).toBe(false);
    expect(isChatIncluded(DAVID_CHAT, policy)).toBe(true);
    expect(
      isChatIncluded(chatOf(-1001, "channel", "x"), { ...policy, includeChannels: false }),
    ).toBe(false);
  });

  it("resumes an interrupted walk from its checkpoint without fetching a page twice", async () => {
    const messages = messageRun(JAMIE_CHAT, JAMIE, 1, 350, T0);
    rig = await syncRig(
      { users: [JAMIE], chats: [{ chat: JAMIE_CHAT, messages }] },
      { walkLimits: { requestsPerPage: 2 } },
    );
    const first = await rig.source.sync(null);
    expect(first.hasMore).toBe(true);
    expect(first.progress).toMatchObject({ phase: "bootstrap", coverage: "unknown" });
    // The collector dies after one page landed and its cursor was saved.
    await rig.restart({ walkLimits: { requestsPerPage: 2 } });
    const rest = await syncAll(rig.source, first.cursor);

    const offsets = historyCalls(rig).map((c) => c.offsetId);
    expect(offsets).toEqual([0, 251, 151, 51, 1]);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(rig.provider.getArchive().messageCount()).toBe(350);
    expect(rest.pages.at(-1)!.progress).toMatchObject({ phase: "incremental" });
  });

  it("dedupes a live message the walk also delivers, and keeps a newer one it does not", async () => {
    const messages = messageRun(JAMIE_CHAT, JAMIE, 1, 150, T0);
    rig = await syncRig(
      { users: [JAMIE], chats: [{ chat: JAMIE_CHAT, messages }] },
      { walkLimits: { requestsPerPage: 2 } },
    );
    const first = await rig.source.sync(null);
    // Live while the walk is between pages: a duplicate of an old message the
    // next page holds, and a genuinely new message above the walk.
    rig.sim.emit({ kind: "new", message: messages[10]!, chat: JAMIE_CHAT, users: [JAMIE] });
    const fresh = rig.sim.pushNew(JAMIE_CHAT.id, { text: "Fresh note", date: T0 + 9000 });
    await syncAll(rig.source, first.cursor);

    const archive = rig.provider.getArchive();
    expect(archive.messageCount()).toBe(151);
    expect(archive.hasMessage(JAMIE_CHAT.id, fresh.id)).toBe(true);
    expect(archive.getChat(JAMIE_CHAT.id)?.newestSeenId).toBe(fresh.id);
  });

  it("stops at the data cutoff and stores nothing older", async () => {
    const messages = messageRun(JAMIE_CHAT, JAMIE, 1, 300, T0, 3600); // hourly, ~12.5 days
    const cutoff = new Date((T0 + 150 * 3600) * 1000).toISOString();
    rig = await syncRig(
      { users: [JAMIE], chats: [{ chat: JAMIE_CHAT, messages }] },
      { dataCutoff: cutoff },
    );
    const { pages } = await syncAll(rig.source, null);
    // Page 1 holds ids 300..201, page 2 crosses the cutoff (id 151) and ends the walk.
    expect(historyCalls(rig).map((c) => c.offsetId)).toEqual([0, 201]);
    expect(rig.provider.getArchive().messageCount()).toBe(150);
    for (const doc of latestDocs(pages).values()) {
      expect(doc.sourceCreatedAt >= cutoff).toBe(true);
    }
  });
});

describe("upstream failures", () => {
  it("stops the page on a network failure without throwing, and resumes on the next", async () => {
    rig = await syncRig({
      users: [JAMIE],
      chats: [{ chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) }],
    });
    rig.sim.failNext("getHistory", new TelegramError("network", "Connection reset"));
    const page = await rig.source.sync(null);
    expect(page.hasMore).toBe(false);
    expect(page.progress).toMatchObject({ phase: "bootstrap", coverage: "unknown" });
    const { pages } = await syncAll(rig.source, page.cursor);
    expect(pages.at(-1)!.progress).toMatchObject({ phase: "incremental", coverage: "complete" });
    expect(rig.provider.getArchive().messageCount()).toBe(3);
  });

  it("reports a session Telegram ends mid-walk as the auth failure with its remedy", async () => {
    rig = await syncRig({
      users: [JAMIE],
      chats: [{ chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) }],
    });
    rig.sim.failNext(
      "getHistory",
      new TelegramError("revoked", "SESSION_REVOKED", {
        reason: "SESSION_REVOKED",
        rpc: "SESSION_REVOKED",
      }),
    );
    const failure = await rig.source.sync(null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncError);
    expect(failure).toMatchObject({ kind: "auth", remediation: REVOKED_REMEDIATION });
  });

  it("hands the sync's abort signal to every history request", async () => {
    rig = await syncRig({
      users: [JAMIE],
      chats: [{ chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) }],
    });
    const adapter = rig.provider.getAdapter();
    const seen: Array<AbortSignal | undefined> = [];
    const original = adapter.getHistory.bind(adapter);
    adapter.getHistory = (chatId, opts) => {
      seen.push(opts.signal);
      return original(chatId, opts);
    };
    const controller = new AbortController();
    await rig.source.sync(null, { signal: controller.signal });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("skips a chat Telegram refuses, walks the rest, and offers it again at the next full reconcile", async () => {
    rig = await syncRig({
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0 + 3600) },
        { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 4, 3, T0) },
      ],
    });
    rig.sim.failNext("getHistory", new TelegramError("forbidden", "CHANNEL_PRIVATE"));
    const { pages, cursor } = await syncAll(rig.source, null);
    const archive = rig.provider.getArchive();
    expect(archive.getChat(JAMIE_CHAT.id)?.walkState).toBe("failed");
    expect(archive.getChat(DAVID_CHAT.id)?.walkState).toBe("done");
    expect(pages.at(-1)!.progress).toMatchObject({ phase: "incremental", coverage: "partial" });

    vi.useFakeTimers({ now: Date.now() + 25 * 3600_000, shouldAdvanceTime: true });
    const again = await syncAll(rig.source, cursor);
    expect(archive.getChat(JAMIE_CHAT.id)?.walkState).toBe("done");
    expect(again.pages.at(-1)!.progress).toMatchObject({ coverage: "complete" });
  });
});

describe("pacing and flood waits", () => {
  it("spaces history requests at least the minimum interval apart, across pages", async () => {
    const chats = [JAMIE_CHAT, DAVID_CHAT].map((chat, i) => ({
      chat,
      messages: messageRun(chat, i === 0 ? JAMIE : DAVID, i * 200 + 1, 150, T0),
    }));
    rig = await syncRig(
      { users: [JAMIE, DAVID], chats },
      { clock: undefined, walkLimits: { requestsPerPage: 3 } },
    );
    vi.useFakeTimers({ now: Date.parse("2026-03-11T08:00:00.000Z") });
    let cursor: TelegramSyncCursor | null = null;
    for (let i = 0; i < 4; i++) {
      const page: SyncResult<TelegramSyncCursor> = await drive(rig.source.sync(cursor));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    const upstream = rig.sim.calls.filter(
      (c) => c.method === "getHistory" || c.method === "iterDialogs",
    );
    expect(upstream.length).toBe(7); // dialogs + 3 pages per chat, the last empty
    for (let i = 1; i < upstream.length; i++) {
      expect(upstream[i]!.at - upstream[i - 1]!.at).toBeGreaterThanOrEqual(HISTORY_MIN_INTERVAL_MS);
    }
  });

  it("stops the walk on a flood wait, reports it, drains without upstream calls, and resumes after", async () => {
    const chats = [
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 120, T0) },
      { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 201, 3, T0 - 86_400) },
    ];
    rig = await syncRig(
      { users: [JAMIE, DAVID], chats },
      { clock: undefined, walkLimits: { requestsPerPage: 2 } },
    );
    vi.useFakeTimers({ now: Date.parse("2026-03-11T08:00:00.000Z") });
    // The first page of Jamie lands; Telegram refuses the next request for 15 minutes.
    rig.sim.calls.length = 0;
    const page1 = await drive(rig.source.sync(null));
    expect(page1.hasMore).toBe(true);
    rig.sim.floodWait("getHistory", 900);
    const page2 = await drive(rig.source.sync(page1.cursor));
    expect(page2.hasMore).toBe(false);
    expect(page2.issues).toEqual([
      expect.objectContaining({ kind: "rate-limit", scope: "partition", severity: "info" }),
    ]);
    expect(page2.progress).toMatchObject({ phase: "bootstrap", coverage: "partial" });
    expect(rig.provider.getArchive().floodUntil()).toBeDefined();

    // During the wait a live message still lands, and drains without any upstream read.
    const callsBefore = rig.sim.calls.filter((c) => c.method !== "checkAuthorization").length;
    rig.sim.pushNew(JAMIE_CHAT.id, { text: "Q4 budget review moved to Friday", date: T0 + 9000 });
    const page3 = await drive(rig.source.sync(page2.cursor));
    expect(rig.sim.calls.filter((c) => c.method !== "checkAuthorization").length).toBe(callsBefore);
    expect(page3.documents.map((d) => d.externalId)).toContain(`${JAMIE_CHAT.id}:2026-03-10`);

    // Past the wait the walk picks up where it stopped.
    vi.setSystemTime(Date.now() + 901_000);
    let cursor = page3.cursor;
    for (let i = 0; i < 10; i++) {
      const page = await drive(rig.source.sync(cursor));
      cursor = page.cursor;
      if (!page.hasMore) {
        expect(page.progress).toMatchObject({ phase: "incremental", coverage: "complete" });
        expect(page.issues).toBeUndefined();
        break;
      }
    }
    expect(rig.provider.getArchive().messageCount()).toBe(124);
  });
});

describe("gap recovery", () => {
  async function walked(chats: Array<{ chat: TgChat; messages: TgMessage[] }>): Promise<{
    cursor: TelegramSyncCursor;
  }> {
    rig = await syncRig({ users: [JAMIE, DAVID], chats });
    const { cursor } = await syncAll(rig.source, null);
    return { cursor };
  }

  it("re-pages a chat above its floor after a long outage lost its updates", async () => {
    const { cursor } = await walked([
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 5, T0) },
    ]);
    vi.useFakeTimers({ now: Date.parse("2026-03-11T08:00:00.000Z"), shouldAdvanceTime: true });
    rig!.sim.setConnectionState("offline");
    rig!.sim.dropUpdates(2);
    const lost = [
      rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost while offline, first", date: T0 + 3600 }),
      rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost while offline, second", date: T0 + 3660 }),
    ];
    vi.setSystemTime(Date.now() + 1_000_000);
    rig!.sim.setConnectionState("connected");
    const { pages } = await syncAll(rig!.source, cursor);

    expect(historyCalls(rig!, JAMIE_CHAT.id)).toContainEqual(
      expect.objectContaining({ offsetId: 0, minId: 5 }),
    );
    for (const m of lost)
      expect(rig!.provider.getArchive().hasMessage(JAMIE_CHAT.id, m.id)).toBe(true);
    expect(latestDocs(pages).get(`${JAMIE_CHAT.id}:2026-03-10`)?.content).toContain(
      "Lost while offline, second",
    );
  });

  it("floors the re-page where the chat stood when the connection dropped, not after catch-up", async () => {
    const { cursor } = await walked([
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 5, T0) },
    ]);
    vi.useFakeTimers({ now: Date.parse("2026-03-11T08:00:00.000Z"), shouldAdvanceTime: true });
    rig!.sim.setConnectionState("offline");
    rig!.sim.dropUpdates(2);
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost in the outage, first", date: T0 + 3600 });
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost in the outage, second", date: T0 + 3660 });
    // Catch-up delivers a newer message before the client reports "connected".
    rig!.sim.setConnectionState("updating");
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Delivered by catch-up", date: T0 + 3720 });
    vi.setSystemTime(Date.now() + 1_000_000);
    rig!.sim.setConnectionState("connected");
    await syncAll(rig!.source, cursor);
    const archive = rig!.provider.getArchive();
    for (const id of [6, 7, 8]) expect(archive.hasMessage(JAMIE_CHAT.id, id)).toBe(true);
  });

  it("recovers what arrived while the collector was not running", async () => {
    const { cursor } = await walked([
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 5, T0) },
    ]);
    await rig!.provider.dispose();
    const missed = rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Sent while down", date: T0 + 3600 });
    vi.useFakeTimers({ now: Date.now() + 2 * 3600_000, shouldAdvanceTime: true });
    await rig!.restart();
    await syncAll(rig!.source, cursor);
    expect(rig!.provider.getArchive().hasMessage(JAMIE_CHAT.id, missed.id)).toBe(true);
  });

  it("keeps a chat's gap floor when Telegram refuses its re-page, and recovers later", async () => {
    const { cursor } = await walked([
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 5, T0) },
    ]);
    rig!.sim.dropUpdates(2);
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost one", date: T0 + 3600 });
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Lost two", date: T0 + 3660 });
    rig!.sim.emitGap("account");
    rig!.sim.failNext("getHistory", new TelegramError("unknown", "INTERNAL_SERVER_ERROR"));
    const first = await syncAll(rig!.source, cursor);
    const archive = rig!.provider.getArchive();
    expect(archive.getChat(JAMIE_CHAT.id)).toMatchObject({
      walkState: "failed",
      reconcileFromId: 5,
    });
    // A live message moves newest_seen_id past the hole meanwhile.
    rig!.sim.pushNew(JAMIE_CHAT.id, { text: "Live after the refusal", date: T0 + 3720 });

    vi.useFakeTimers({ now: Date.now() + 25 * 3600_000, shouldAdvanceTime: true });
    await syncAll(rig!.source, first.cursor);
    for (const id of [6, 7, 8]) expect(archive.hasMessage(JAMIE_CHAT.id, id)).toBe(true);
    expect(archive.getChat(JAMIE_CHAT.id)?.walkState).toBe("done");
  });

  it("finds messages lost without any signal at the periodic full reconcile", async () => {
    const { cursor } = await walked([
      { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 5, T0) },
      { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 6, 5, T0) },
    ]);
    rig!.sim.dropUpdates(1);
    const lost = rig!.sim.pushNew(DAVID_CHAT.id, { text: "Silently lost", date: T0 + 3600 });
    // Before the interval nothing is listed again.
    await syncAll(rig!.source, cursor);
    expect(rig!.provider.getArchive().hasMessage(DAVID_CHAT.id, lost.id)).toBe(false);

    vi.useFakeTimers({ now: Date.now() + 25 * 3600_000, shouldAdvanceTime: true });
    rig!.sim.calls.length = 0;
    await syncAll(rig!.source, cursor);
    expect(rig!.provider.getArchive().hasMessage(DAVID_CHAT.id, lost.id)).toBe(true);
    // Only the chat that had something new is re-paged.
    expect(historyCalls(rig!, JAMIE_CHAT.id)).toHaveLength(0);
    expect(historyCalls(rig!, DAVID_CHAT.id)).toHaveLength(2);
  });

  it("re-pages a supergroup when Telegram reports its channel difference too long", async () => {
    const group = chatOf(-1002000000002, "supergroup", "Marathon training club");
    const start = Math.floor(Date.now() / 1000) - 7200;
    const { cursor } = await walked([
      {
        chat: group,
        messages: [1, 2, 3].map((id) =>
          messageIn(group, id, start + id * 60, `Long run plan ${id}`, { senderId: JAMIE.id }),
        ),
      },
    ]);
    rig!.sim.dropUpdates(3);
    for (const n of [1, 2, 3]) {
      rig!.sim.pushNew(group.id, {
        text: `Missed pace update ${n}`,
        senderId: DAVID.id,
        date: start + 600 + n,
      });
    }
    rig!.sim.emitGap({ channelId: group.id });
    const { pages } = await syncAll(rig!.source, cursor);

    expect(historyCalls(rig!, group.id)).toContainEqual(
      expect.objectContaining({ offsetId: 0, minId: 3 }),
    );
    expect(rig!.sim.calls.some((c) => c.method === "getMessages")).toBe(true);
    const day = new Date((start + 603) * 1000).toISOString().slice(0, 10);
    const content = latestDocs(pages).get(`${group.id}:${day}`)?.content ?? "";
    expect(content).toContain("Missed pace update 3");
    expect(rig!.provider.getArchive().getChat(group.id)?.reconcileFromId).toBeUndefined();
  });

  it("finds deletions and edits a gap swallowed with a presence check", async () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = messageRun(JAMIE_CHAT, JAMIE, 1, 4, now - 3600);
    const { cursor } = await walked([{ chat: JAMIE_CHAT, messages: recent }]);
    rig!.sim.silentlyEdit(JAMIE_CHAT.id, 2, "Corrected: the review is on Friday", now - 60);
    rig!.sim.dropUpdates(1);
    rig!.sim.pushDelete(JAMIE_CHAT.id, [3]);
    rig!.sim.emitGap("account");
    await syncAll(rig!.source, cursor);

    const archive = rig!.provider.getArchive();
    expect(rig!.sim.calls.some((c) => c.method === "getMessagesCommon")).toBe(true);
    expect(archive.hasMessage(JAMIE_CHAT.id, 3)).toBe(false);
    expect(archive.getMessages(JAMIE_CHAT.id, [2]).get(2)?.text).toBe(
      "Corrected: the review is on Friday",
    );
    expect(archive.walkSummary().reconcilePending).toBe(false);
  });

  describe("a presence check deletes only on a conclusive answer", () => {
    async function gapped(): Promise<TelegramSyncCursor> {
      const now = Math.floor(Date.now() / 1000);
      const { cursor } = await walked([
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 4, now - 3600) },
      ]);
      rig!.sim.emitGap("account");
      return cursor;
    }

    const surviving = (): number =>
      [1, 2, 3, 4].filter((id) => rig!.provider.getArchive().hasMessage(JAMIE_CHAT.id, id)).length;

    it("deletes nothing when the presence request fails", async () => {
      const cursor = await gapped();
      rig!.sim.failNext("getMessagesCommon", new TelegramError("network", "Connection reset"));
      await syncAll(rig!.source, cursor);
      expect(surviving()).toBe(4);
    });

    it("deletes nothing when the answer does not line up with the ids asked", async () => {
      const cursor = await gapped();
      const adapter = rig!.provider.getAdapter();
      const original = adapter.getMessagesCommon.bind(adapter);
      adapter.getMessagesCommon = async (ids, opts) => (await original(ids, opts)).slice(1);
      await syncAll(rig!.source, cursor);
      expect(surviving()).toBe(4);
      expect(rig!.provider.getArchive().walkSummary().reconcilePending).toBe(false);
    });

    it("deletes nothing when a whole batch comes back empty and the chat no longer reads", async () => {
      const cursor = await gapped();
      const adapter = rig!.provider.getAdapter();
      adapter.getMessagesCommon = (ids) => Promise.resolve(ids.map(() => null));
      const history = adapter.getHistory.bind(adapter);
      adapter.getHistory = (chatId, opts) =>
        opts.offsetId === 0 && opts.limit === 1
          ? Promise.resolve({ messages: [], users: [] })
          : history(chatId, opts);
      await syncAll(rig!.source, cursor);
      expect(surviving()).toBe(4);
    });

    it("deletes a whole batch when the chat still reads past it", async () => {
      const cursor = await gapped();
      const older = messageIn(JAMIE_CHAT, 99, T0 - 86_400, "Older note", { senderId: JAMIE.id });
      const adapter = rig!.provider.getAdapter();
      adapter.getMessagesCommon = (ids) => Promise.resolve(ids.map(() => null));
      adapter.getHistory = (_chatId, opts) =>
        Promise.resolve({ messages: opts.limit === 1 ? [older] : [], users: [] });
      await syncAll(rig!.source, cursor);
      expect(surviving()).toBe(0);
    });

    it("hands the sync's abort signal to the presence request", async () => {
      const cursor = await gapped();
      const adapter = rig!.provider.getAdapter();
      const seen: Array<AbortSignal | undefined> = [];
      const original = adapter.getMessagesCommon.bind(adapter);
      adapter.getMessagesCommon = (ids, opts) => {
        seen.push(opts?.signal);
        return original(ids, opts);
      };
      const controller = new AbortController();
      await rig!.source.sync(cursor, { signal: controller.signal });
      expect(seen).toEqual([controller.signal]);
    });
  });
});
