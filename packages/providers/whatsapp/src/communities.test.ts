// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WhatsAppProvider } from "./provider.js";
import { FakeWhatsAppServer, type FakeCorpus } from "./testing/fake-server.js";

const ME_JID = "15550100001:0@s.whatsapp.net";
const ACCOUNT = "+15550100001";
const CHAT = "15550100777@s.whatsapp.net";

function ts(date: string, hour = 12): number {
  return Math.floor(Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1000);
}

describe("WhatsApp communities — provider + fake integration", () => {
  let dir: string;
  let provider: WhatsAppProvider | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ts("2026-02-01")));
    dir = mkdtempSync(join(tmpdir(), "omnesis-wa-comm-"));
  });
  afterEach(async () => {
    // disconnect() ends the socket and closes the store, but its Baileys drain
    // wait must be advanced under fake timers.
    if (provider) {
      const dp = provider.disconnect();
      await vi.advanceTimersByTimeAsync(2_100);
      await dp;
      provider = null;
    }
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(_corpus: FakeCorpus, fake: FakeWhatsAppServer): Promise<WhatsAppProvider> {
    const p = new WhatsAppProvider(ACCOUNT, dir, fake.factory);
    await p.initialize();
    const authP = p.authenticate();
    await vi.advanceTimersByTimeAsync(1);
    fake.connect();
    await authP;
    provider = p;
    return p;
  }

  it("scope refresh fetches current upstream membership instead of trusting a cached roster", async () => {
    const corpus: FakeCorpus = {
      meJid: ME_JID,
      chats: [
        {
          jid: "100@g.us",
          name: "scope group",
          isGroup: true,
          participants: [ME_JID],
          messages: [],
        },
      ],
    };
    const fake = new FakeWhatsAppServer(corpus);
    const p = await connect(corpus, fake);
    p.getStore().updateGroupRoster("100@g.us", [CHAT]);
    const fresh = await p.refreshScopeGroupRosters(["100@g.us"]);
    expect([...fresh]).toEqual(["100@g.us"]);
    expect(p.getStore().getChat("100@g.us")?.participants).toEqual([ME_JID]);
  });

  it("scope refresh gives no witness for malformed or stale-generation upstream replies", async () => {
    const fake = new FakeWhatsAppServer({ meJid: ME_JID, chats: [] });
    const base = fake.factory;
    let resolve: (value: unknown) => void = () => {};
    let malformed = true;
    const p = new WhatsAppProvider(ACCOUNT, dir, {
      createSocket: async (authDir) => {
        const result = await base.createSocket(authDir);
        result.sock.groupMetadata = async () =>
          malformed
            ? { subject: "scope group" }
            : new Promise((done) => {
                resolve = done;
              });
        return result;
      },
    });
    await p.initialize();
    const authentication = p.authenticate();
    await vi.advanceTimersByTimeAsync(1);
    fake.connect();
    await authentication;
    provider = p;
    p.getStore().addChats([{ jid: "100@g.us", name: "scope group", isGroup: true }]);
    p.getStore().updateGroupRoster("100@g.us", [CHAT]);
    expect(await p.refreshScopeGroupRosters(["100@g.us"])).toEqual(new Set());
    malformed = false;
    const pending = p.refreshScopeGroupRosters(["100@g.us"]);
    await Promise.resolve();
    await p.suspend();
    resolve({ participants: [{ id: ME_JID }] });
    expect(await pending).toEqual(new Set());
    expect(p.getStore().getChat("100@g.us")?.participants).toEqual([CHAT]);
  });

  it("tags communities from group metadata (linkedParent), even when the community API returns nothing", async () => {
    // Reproduces the live case: communityFetchAllParticipating() returns {},
    // but the groups' own metadata carries isCommunity / linkedParent, picked up
    // on the roster refresh at history-complete.
    const corpus: FakeCorpus = {
      meJid: ME_JID,
      chats: [
        {
          jid: "100@g.us",
          name: "Riverside Collective",
          isGroup: true,
          isCommunity: true,
          messages: [{ id: "a", ts: ts("2026-01-10") }],
        },
        {
          jid: "200@g.us",
          name: "General Chat",
          isGroup: true,
          linkedParent: "100@g.us",
          messages: [{ id: "b", ts: ts("2026-01-10") }],
        },
      ],
      // No `communities` block → communityFetchAllParticipating returns {}.
    };
    const fake = new FakeWhatsAppServer(corpus);
    const p = await connect(corpus, fake);
    fake.pushInitialHistory({ terminate: "isLatest" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(p.getStore().getChat("100@g.us")?.kind).toBe("community");
    const sub = p.getStore().getChat("200@g.us");
    expect(sub?.kind).toBe("community-subgroup");
    expect(sub?.parentCommunityJid).toBe("100@g.us");
  });

  it("enumerates communities and tags sub-groups via the community API", async () => {
    const corpus: FakeCorpus = {
      meJid: ME_JID,
      chats: [
        { jid: CHAT, name: "Jamie Lopez", messages: [{ id: "a", ts: ts("2026-01-10") }] },
        { jid: "200@g.us", name: "Announcements", isGroup: true, messages: [] },
      ],
      communities: [{ jid: "100@g.us", name: "Town Square", subGroups: ["200@g.us"] }],
    };
    const fake = new FakeWhatsAppServer(corpus);
    const p = await connect(corpus, fake);
    fake.pushInitialHistory({ terminate: "isLatest" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(p.getStore().getChat("100@g.us")?.kind).toBe("community");
    const sub = p.getStore().getChat("200@g.us");
    expect(sub?.kind).toBe("community-subgroup");
    expect(sub?.parentCommunityJid).toBe("100@g.us");
  });
});
