// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The bootstrap walk through a Telegram data export session
 * (`docs/telegram-source.md` §14 phase 4): the happy path, the export
 * Telegram holds back until the owner approves it, a walk cancelled half way,
 * and a session that ends under the walk.
 */

import { afterEach, describe, expect, it } from "vitest";
import { TelegramError } from "./client/types.js";
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
import type { TelegramMessagesSourceOptions } from "./messages.js";

const JAMIE_CHAT = privateChatWith(JAMIE);
const DAVID_CHAT = privateChatWith(DAVID);
const CHANNEL = chatOf(-1007000000001, "channel", "Stellar Sound announcements");

let rig: SyncRig | undefined;
afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

const methods = (r: SyncRig, ...names: string[]): string[] =>
  r.sim.calls.map((c) => c.method).filter((m) => names.includes(m));

async function takeoutRig(
  options: Partial<TelegramMessagesSourceOptions> = {},
  count = 250,
): Promise<SyncRig> {
  rig = await syncRig(
    {
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, count, T0) },
        { chat: CHANNEL, messages: [messageIn(CHANNEL, 1, T0, "Tour dates announced")] },
      ],
    },
    { takeout: true, ...options },
  );
  return rig;
}

describe("the bootstrap walk through a data export", () => {
  it("reads history through the export, never downloads through it, and finishes it once", async () => {
    const r = await takeoutRig();
    const { pages } = await syncAll(r.source, null);

    expect(r.sim.takeoutScopes).toEqual([
      { messageUsers: true, messageChats: true, messageMegagroups: true, messageChannels: false },
    ]);
    // Every backward page went through the export; none the normal way.
    expect(methods(r, "initTakeout", "getHistory", "finishTakeout")).toEqual([
      "initTakeout",
      "finishTakeout",
    ]);
    expect(methods(r, "takeoutGetHistory")).toHaveLength(4);
    expect(r.sim.calls.find((c) => c.method === "finishTakeout")?.args).toEqual({ success: true });
    expect(r.provider.getArchive().messageCount()).toBe(250);
    expect(r.provider.getArchive().takeoutState().state).toBe("done");
    expect(pages.at(-1)!.progress).toMatchObject({ phase: "incremental", coverage: "complete" });
    expect(pages.every((p) => p.issues === undefined)).toBe(true);

    // A chat that turns up after the export finished is walked the normal way,
    // without asking Telegram (and the owner's devices) for another export.
    r.sim.account(Number(r.provider.accountId)).chats!.push({
      chat: DAVID_CHAT,
      messages: messageRun(DAVID_CHAT, DAVID, 900, 2, T0 + 86_400),
    });
    r.sim.pushNew(DAVID_CHAT.id, {
      text: "Riverside Estate visit is confirmed",
      date: T0 + 90_000,
    });
    await syncAll(r.source, pages.at(-1)!.cursor);
    expect(r.provider.getArchive().getChat(DAVID_CHAT.id)?.walkState).toBe("done");
    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(methods(r, "getHistory").length).toBeGreaterThan(0);
  });

  it("covers broadcast channels only when they are switched on", async () => {
    const r = await takeoutRig({ policy: { includeChannels: true, excludedChats: [] } });
    const { pages } = await syncAll(r.source, null);
    expect(r.sim.takeoutScopes[0]).toMatchObject({ messageChannels: true });
    expect(
      r.sim.calls
        .filter((c) => c.method === "takeoutGetHistory")
        .some((c) => (c.args as { chatId: number }).chatId === CHANNEL.id),
    ).toBe(true);
    expect(latestDocs(pages).has(`${CHANNEL.id}:2026-03-10`)).toBe(true);
  });

  it("walks the normal way while Telegram holds the export back, and says how to approve it", async () => {
    const r = await takeoutRig({ walkLimits: { requestsPerPage: 3 } }, 600);
    r.sim.delayTakeout(86_400);
    const first = await r.source.sync(null);

    // The walk did not wait for the export.
    expect(methods(r, "getHistory").length).toBeGreaterThan(0);
    expect(methods(r, "takeoutGetHistory")).toEqual([]);
    expect(r.provider.getArchive().takeoutState().state).toBe("delayed");
    expect(first.issues).toEqual([
      expect.objectContaining({
        kind: "permission",
        scope: "partition",
        severity: "info",
        remediation: expect.objectContaining({
          summary: "Telegram asks you to approve the history export",
        }),
      }),
    ]);
    // Neither the walk's nor the media's flood wait is involved.
    expect(r.provider.getArchive().floodUntil()).toBeUndefined();
    expect(r.provider.getArchive().mediaFloodUntil()).toBeUndefined();

    // Not asked again before the retry time.
    const second = await r.source.sync(first.cursor);
    expect(methods(r, "initTakeout")).toHaveLength(1);

    // The owner approves and resyncs: the export is asked for again and used.
    r.source.onResync();
    const third = await r.source.sync(second.cursor);
    expect(methods(r, "initTakeout")).toHaveLength(2);
    expect(methods(r, "takeoutGetHistory").length).toBeGreaterThan(0);
    expect(third.issues).toBeUndefined();

    const rest = await syncAll(r.source, third.cursor);
    expect(r.provider.getArchive().messageCount()).toBe(600);
    expect(rest.pages.at(-1)!.progress).toMatchObject({ coverage: "complete" });
  });

  it("settles a held-back export when the walk finished without it", async () => {
    const r = await takeoutRig({}, 20);
    r.sim.delayTakeout(86_400);
    const { pages } = await syncAll(r.source, null);
    expect(r.provider.getArchive().takeoutState().state).toBe("done");
    // No approval prompt is left once there is nothing to walk.
    expect(pages.at(-1)!.issues).toBeUndefined();
  });

  it("resumes a walk cancelled half way from its checkpoint, through the same export", async () => {
    const r = await takeoutRig();
    const controller = new AbortController();
    let sleeps = 0;
    r.remake({
      takeout: true,
      clock: {
        now: () => Date.now(),
        // Cancel while waiting for the third request: the dialogs and the export
        // were asked for, and one page landed.
        sleep: () => {
          if (++sleeps === 3) controller.abort();
          return Promise.resolve();
        },
      },
    });
    const cancelled = await r.source.sync(null, { signal: controller.signal });
    expect(cancelled.hasMore).toBe(false);
    expect(r.provider.getArchive().getChat(JAMIE_CHAT.id)?.walkState).toBe("walking");

    r.remake({ takeout: true });
    await syncAll(r.source, cancelled.cursor);
    const offsets = r.sim.calls
      .filter((c) => c.method === "takeoutGetHistory")
      .map((c) => (c.args as { offsetId: number }).offsetId);
    expect(offsets).toEqual([0, 151, 51, 1]);
    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(r.provider.getArchive().messageCount()).toBe(250);
  });

  it("carries on the normal way when the export ends under the walk", async () => {
    const r = await takeoutRig({ walkLimits: { requestsPerPage: 3 } });
    const first = await r.source.sync(null);
    expect(methods(r, "takeoutGetHistory")).toHaveLength(1);
    r.sim.endTakeouts();
    await syncAll(r.source, first.cursor);

    expect(r.provider.getArchive().takeoutState().state).toBe("unavailable");
    expect(methods(r, "getHistory").length).toBeGreaterThan(0);
    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(r.provider.getArchive().messageCount()).toBe(250);
  });

  it("continues the same export after the context is rebuilt or restarted", async () => {
    const r = await takeoutRig({ walkLimits: { requestsPerPage: 3 } });
    const first = await r.source.sync(null);
    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(r.provider.getArchive().takeoutState().state).toBe("active");
    // A config change, an enable or a re-authentication opens a new context.
    await r.restart({ takeout: true, walkLimits: { requestsPerPage: 3 } });
    await syncAll(r.source, first.cursor);

    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(methods(r, "getHistory")).toEqual([]);
    expect(methods(r, "finishTakeout")).toHaveLength(1);
    expect(r.provider.getArchive().takeoutState().state).toBe("done");
    expect(r.provider.getArchive().takeoutSession()).toBeUndefined();
    expect(r.provider.getArchive().messageCount()).toBe(250);
  });

  it("reads the normal way when a resumed export is no longer honoured", async () => {
    const r = await takeoutRig({ walkLimits: { requestsPerPage: 3 } });
    const first = await r.source.sync(null);
    r.sim.endTakeouts();
    await r.restart({ takeout: true, walkLimits: { requestsPerPage: 3 } });
    await syncAll(r.source, first.cursor);

    expect(methods(r, "initTakeout")).toHaveLength(1);
    expect(r.provider.getArchive().takeoutState().state).toBe("unavailable");
    expect(r.provider.getArchive().messageCount()).toBe(250);
  });

  it("walks the normal way when Telegram refuses an export outright", async () => {
    const r = await takeoutRig();
    r.sim.failNext("initTakeout", new TelegramError("unknown", "Telegram error 400 SOMETHING"));
    await syncAll(r.source, null);
    expect(r.provider.getArchive().takeoutState().state).toBe("unavailable");
    expect(r.provider.getArchive().messageCount()).toBe(250);
    expect(r.provider.getArchive().getChat(JAMIE_CHAT.id)?.walkState).toBe("done");
  });
});
