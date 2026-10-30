// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramMessagesSource.sync()` end to end over the simulated server: what
 * a page emits, what it tombstones, and that the page loop settles.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { SyncError } from "@omnesis/types";
import { resolveAttachmentConfig } from "@omnesis/core";
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
import type { TelegramSyncCursor } from "./types.js";

const JAMIE_CHAT = privateChatWith(JAMIE);
const DAVID_CHAT = privateChatWith(DAVID);
const JAMIE_DAY = `${JAMIE.id}:2026-03-10`;

let rig: SyncRig | undefined;
afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

async function twoChatRig(options = {}): Promise<SyncRig> {
  rig = await syncRig(
    {
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) },
        { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 4, 2, T0 + 86_400) },
      ],
    },
    options,
  );
  return rig;
}

describe("TelegramMessagesSource.sync", () => {
  it("bootstraps every day, then a cursor sync with nothing new emits nothing", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    expect([...latestDocs(boot.pages).keys()].sort()).toEqual(
      [JAMIE_DAY, `${DAVID.id}:2026-03-11`].sort(),
    );
    expect(boot.cursor).toMatchObject({
      phase: "incremental",
      storeId: r.provider.getArchive().storeId,
    });

    const again = await r.source.sync(boot.cursor);
    expect(again.documents).toEqual([]);
    expect(again.deletedExternalIds).toEqual([]);
    expect(again.hasMore).toBe(false);

    r.sim.pushNew(JAMIE_CHAT.id, { text: "Studio Northstar booked", date: T0 + 3600 });
    const one = await r.source.sync(again.cursor);
    expect(one.documents.map((d) => d.externalId)).toEqual([JAMIE_DAY]);
    expect(one.documents[0]!.content).toContain("Studio Northstar booked");
  });

  it("reflects a live edit and a live delete, and tombstones a day left empty", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.sim.pushEdit(JAMIE_CHAT.id, 2, "Q4 budget review is on Friday", T0 + 7200);
    const edited = await r.source.sync(boot.cursor);
    expect(edited.documents[0]!.content).toContain("Q4 budget review is on Friday (edited)");

    r.sim.pushDelete(JAMIE_CHAT.id, [1]);
    const deleted = await r.source.sync(edited.cursor);
    expect(deleted.documents[0]!.content).not.toContain("Note 1 about");

    r.sim.pushDelete(JAMIE_CHAT.id, [2, 3]);
    const emptied = await r.source.sync(deleted.cursor);
    expect(emptied.documents).toEqual([]);
    expect(emptied.deletedExternalIds).toEqual([JAMIE_DAY]);
  });

  it("tombstones a deleted day's ledgered attachments with it", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    const archive = r.provider.getArchive();
    // As a media render would have ledgered them.
    archive.settleAttachments(JAMIE_CHAT.id, "2026-03-10", [`${JAMIE_DAY}/att/abc`], 1);
    r.sim.pushDelete(JAMIE_CHAT.id, [1, 2, 3]);
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds.sort()).toEqual([JAMIE_DAY, `${JAMIE_DAY}/att/abc`].sort());
    const next = await r.source.sync(page.cursor);
    expect(next.deletedExternalIds).toEqual([]);
  });

  it("tombstones every day of a chat that becomes excluded", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.remake({ policy: { includeChannels: false, excludedChats: [String(DAVID.id)] } });
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds).toEqual([`${DAVID.id}:2026-03-11`]);
    expect(page.documents).toEqual([]);
  });

  it("walks channels only once switched on, and removes their days and files when switched off", async () => {
    const channel = chatOf(-1007000000002, "channel", "Stellar Sound announcements");
    const brochure = {
      kind: "document" as const,
      fileId: "brochure",
      fileName: "tour.txt",
      mimeType: "text/plain",
      size: 24,
      isViewOnce: false,
    };
    const extractor = {
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      extractAttachment: (data: Uint8Array) =>
        Promise.resolve({ text: new TextDecoder().decode(data), truncated: false }),
    };
    rig = await syncRig(
      {
        users: [JAMIE],
        chats: [
          { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 2, T0) },
          {
            chat: channel,
            messages: [
              messageIn(channel, 1, T0, "Tour dates are out"),
              messageIn(channel, 2, T0 + 60, "", { media: brochure }),
            ],
          },
        ],
      },
      extractor,
    );
    rig.sim.setMedia("brochure", new TextEncoder().encode("Spring tour in four cities"));
    const off = await syncAll(rig.source, null);
    expect([...latestDocs(off.pages).keys()]).toEqual([JAMIE_DAY]);
    expect(
      rig.sim.calls.some(
        (c) => c.method === "getHistory" && (c.args as { chatId: number }).chatId === channel.id,
      ),
    ).toBe(false);

    const channelDay = `${channel.id}:2026-03-10`;
    rig.remake({ ...extractor, policy: { includeChannels: true, excludedChats: [] } });
    const on = await syncAll(rig.source, off.cursor);
    const published = latestDocs(on.pages);
    expect(published.get(channelDay)?.content).toContain("Tour dates are out");
    const file = [...published.values()].find((d) => d.metadata.documentType === "attachment");
    expect(file?.externalId.startsWith(`${channelDay}/att/`)).toBe(true);
    expect(file?.content).toContain("Spring tour in four cities");

    rig.remake({ ...extractor, policy: { includeChannels: false, excludedChats: [] } });
    const purged = await syncAll(rig.source, on.cursor);
    const removed = purged.pages.flatMap((p) => p.deletedExternalIds);
    expect(removed.sort()).toEqual([channelDay, file!.externalId].sort());
    expect(purged.pages.flatMap((p) => p.documents)).toEqual([]);
    expect(rig.provider.getArchive().getChat(channel.id)?.walkState).toBe("excluded");
    expect(rig.provider.getArchive().hasMessage(channel.id, 1)).toBe(false);

    // Settled: the next page tombstones nothing again.
    const next = await rig.source.sync(purged.cursor);
    expect(next.deletedExternalIds).toEqual([]);
  });

  it("walks past a common-box id two chats claim, every time, without failing the page", async () => {
    rig = await syncRig({
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) },
        // David's chat reuses Jamie's id 2 in the account-wide box.
        { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 2, 1, T0 + 86_400) },
      ],
    });
    const boot = await syncAll(rig.source, null);
    const archive = rig.provider.getArchive();
    expect(archive.idCollisionCount()).toBe(1);
    expect(archive.messageCount()).toBe(3);
    expect(boot.pages.at(-1)!.progress).toMatchObject({ coverage: "complete" });
    // A full reconcile reads it again and still settles.
    archive.requestFullReconcile();
    const again = await syncAll(rig.source, boot.cursor);
    expect(again.pages.at(-1)!.hasMore).toBe(false);
  });

  it("re-emits the outstanding backlog for a cursor from another archive", async () => {
    const r = await twoChatRig();
    await syncAll(r.source, null);
    const foreign: TelegramSyncCursor = {
      phase: "incremental",
      committedSeq: 3,
      storeId: "another-archive",
    };
    // Nothing of this archive was acknowledged under that cursor, so the last
    // page's days come back.
    const page = await r.source.sync(foreign);
    expect(page.documents.length).toBeGreaterThan(0);
  });

  it("publishes the other days when one day cannot render, and keeps that day queued", async () => {
    const r = await twoChatRig();
    const archive = r.provider.getArchive();
    const getUsers = archive.getUsers.bind(archive);
    archive.getUsers = (ids) => {
      if ([...ids].includes(JAMIE.id)) throw new Error("render exploded");
      return getUsers(ids);
    };
    const boot = await syncAll(r.source, null);
    const docs = latestDocs(boot.pages);
    expect([...docs.keys()]).toEqual([`${DAVID.id}:2026-03-11`]);
    expect(boot.pages.at(-1)!.issues).toEqual([
      expect.objectContaining({ scope: "item", count: 1, severity: "warning" }),
    ]);
    // Acknowledged pages never clear it.
    const again = await r.source.sync(boot.cursor);
    expect(archive.quarantinedDayCount()).toBe(1);
    expect(archive.dirtyDayCount()).toBeGreaterThanOrEqual(1);

    archive.getUsers = getUsers;
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: now + 120_000 });
    try {
      const healed = await r.source.sync(again.cursor);
      expect(healed.documents.map((d) => d.externalId)).toEqual([JAMIE_DAY]);
      expect(healed.issues).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tombstones a published day the data cutoff later moved past", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.provider
      .getArchive()
      .settleAttachments(JAMIE_CHAT.id, "2026-03-10", [`${JAMIE_DAY}/att/abc`], 1);
    r.remake({ dataCutoff: new Date((T0 + 86_400) * 1000).toISOString() });
    r.source.onResync();
    const { pages } = await syncAll(r.source, boot.cursor);
    const removed = pages.flatMap((p) => p.deletedExternalIds);
    expect(removed).toEqual(expect.arrayContaining([JAMIE_DAY, `${JAMIE_DAY}/att/abc`]));
    expect([...latestDocs(pages).keys()]).toEqual([`${DAVID.id}:2026-03-11`]);
  });

  it("moves sourceUpdatedAt forward when the day's latest message is deleted", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    const before = latestDocs(boot.pages).get(JAMIE_DAY)!.sourceUpdatedAt!;
    r.sim.pushDelete(JAMIE_CHAT.id, [3]);
    const page = await r.source.sync(boot.cursor);
    const after = page.documents.find((d) => d.externalId === JAMIE_DAY)!.sourceUpdatedAt!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    r.sim.pushNew(JAMIE_CHAT.id, { text: "Studio Northstar booked", date: T0 + 30 });
    const next = await r.source.sync(page.cursor);
    const latest = next.documents.find((d) => d.externalId === JAMIE_DAY)!.sourceUpdatedAt!;
    expect(Date.parse(latest)).toBeGreaterThanOrEqual(Date.parse(after));
  });

  it("re-emits everything on a resync", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.source.onResync();
    const again = await syncAll(r.source, boot.cursor);
    expect(latestDocs(again.pages).size).toBe(2);
  });

  it("never publishes a live message older than the data cutoff", async () => {
    const cutoff = new Date((T0 + 86_400) * 1000).toISOString();
    const r = await twoChatRig({ dataCutoff: cutoff });
    const boot = await syncAll(r.source, null);
    expect([...latestDocs(boot.pages).keys()]).toEqual([`${DAVID.id}:2026-03-11`]);
    r.sim.pushNew(JAMIE_CHAT.id, { text: "An old one", date: T0 });
    const page = await r.source.sync(boot.cursor);
    expect(page.documents).toEqual([]);
    expect(page.deletedExternalIds).toEqual([]);
  });

  it("wakes the host for a live change", async () => {
    const r = await twoChatRig();
    let pushes = 0;
    const off = r.source.onPushEvent(() => pushes++);
    r.sim.pushNew(DAVID_CHAT.id, { text: "Marathon entry form sent" });
    expect(pushes).toBe(1);
    off();
    r.sim.pushNew(DAVID_CHAT.id, { text: "And the receipt" });
    expect(pushes).toBe(1);
  });

  it("does not ask for another page when the walk stopped for its deadline", async () => {
    const r = await twoChatRig();
    const page = await r.source.sync(null, {
      run: {
        id: "run-1",
        reason: "scheduled",
        start: "warm",
        page: 0,
        deadline: Date.now() + 1000,
      },
    } as never);
    expect(page.hasMore).toBe(false);
    // Nothing has been listed, so nothing can be claimed about the history.
    expect(page.progress).toMatchObject({ phase: "bootstrap", coverage: "unknown" });
    expect(r.sim.calls.some((c) => c.method === "iterDialogs")).toBe(false);
  });

  it("confirms the session on a run's first page, not on every continuation page", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    const run = (page: number) =>
      ({ run: { id: "run-media", reason: "scheduled", start: "warm", page } }) as never;
    const checks = () => r.sim.calls.filter((c) => c.method === "checkAuthorization").length;
    const before = checks();
    await r.source.sync(boot.cursor, run(0));
    await r.source.sync(boot.cursor, run(1));
    await r.source.sync(boot.cursor, run(2));
    expect(checks() - before).toBe(1);
    // A new run confirms it again, so a session ended while idle is noticed.
    r.sim.revoke("SESSION_REVOKED");
    await expect(r.source.sync(boot.cursor, run(0))).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncError && err.kind === "auth",
    );
  });

  it("fails as auth once Telegram ends the session", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.sim.revoke("SESSION_REVOKED");
    await expect(r.source.sync(boot.cursor)).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncError && err.kind === "auth",
    );
  });

  it("settles against an unchanged upstream", async () => {
    const group = chatOf(-1004000000004, "supergroup", "Riverside Estate residents");
    rig = await syncRig(
      {
        users: [JAMIE, DAVID],
        chats: [
          { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 250, T0, 600) },
          {
            chat: group,
            messages: [
              messageIn(group, 1, T0, "Bins go out Tuesday", { senderId: DAVID.id }),
              messageIn(group, 2, T0 + 60, "Thanks", { senderId: JAMIE.id, replyToId: 1 }),
            ],
          },
        ],
      },
      { walkLimits: { requestsPerPage: 2 }, drainLimit: 1 },
    );
    const source = rig.source;
    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      settleSteps: 8,
      primaryKey: () => ["externalId"],
      async step(cursor) {
        const page = await source.sync(cursor as TelegramSyncCursor | null);
        return {
          cursor: page.cursor,
          hasMore: page.hasMore,
          records: page.documents.map((doc) => ({
            table: "documents",
            row: {
              externalId: doc.externalId,
              contentHash: doc.contentHash,
              metadata: doc.metadata,
            },
          })),
        };
      },
    });
  });
});
