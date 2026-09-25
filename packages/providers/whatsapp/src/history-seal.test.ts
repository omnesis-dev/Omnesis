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

function corpus(over?: Partial<FakeCorpus>): FakeCorpus {
  return {
    meJid: ME_JID,
    chats: [
      {
        jid: CHAT,
        name: "Jamie Lopez",
        messages: [
          { id: "m1", ts: ts("2026-01-02", 9), text: "morning" },
          { id: "m2", ts: ts("2026-01-02", 10), text: "you around?" },
        ],
      },
    ],
    ...over,
  };
}

function ts(date: string, hour = 12): number {
  return Math.floor(Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1000);
}

describe("WhatsApp history-sync seal (#579 tri-state)", () => {
  let dir: string;
  let provider: WhatsAppProvider | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "omnesis-wa-seal-"));
  });

  afterEach(() => {
    provider?.getStore().close();
    provider = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(fake: FakeWhatsAppServer): Promise<WhatsAppProvider> {
    const p = new WhatsAppProvider(ACCOUNT, dir, fake.factory);
    await p.initialize();
    const authP = p.authenticate();
    await vi.advanceTimersByTimeAsync(1); // flush createSocket + listener registration
    fake.connect();
    await authP;
    provider = p;
    return p;
  }

  it("seals complete on isLatest and stores the history", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    fake.pushInitialHistory({ terminate: "isLatest" });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("complete");
    expect(p.getStore().totalMessages).toBe(2);
  });

  it("seals complete on an explicit messaging-history.status", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    fake.pushInitialHistory({ terminate: "status" });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("complete");
  });

  it("marks INTERRUPTED (not complete) when a deep-history stream stalls", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    // Deep history started (RECENT chunks) but never completed.
    fake.pushInitialHistory({ terminate: "interrupt", syncType: 3 /* RECENT */ });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("streaming"); // still waiting
    // Quiet-gap (120s) fires → interrupted, NOT complete (the #579 fix).
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.getStore().historySyncState).toBe("interrupted");
    expect(p.getStore().historySyncComplete).toBe(false);
    // Messages that DID arrive are preserved.
    expect(p.getStore().totalMessages).toBe(2);
  });

  it("marks INTERRUPTED synchronously on a paused milestone (no quiet-gap wait)", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    // Deep history started (RECENT chunks), then the server reports `paused`:
    // the provider resolves to interrupted right away, with no timer advance.
    fake.pushInitialHistory({ terminate: "paused", syncType: 3 /* RECENT */ });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("interrupted");
    expect(p.getStore().historySyncComplete).toBe(false);
    // Messages that DID arrive are preserved.
    expect(p.getStore().totalMessages).toBe(2);
  });

  it("treats a bootstrap-only small account as complete, not interrupted", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    fake.pushInitialHistory({ terminate: "bootstrap-only" });
    await vi.advanceTimersByTimeAsync(1);
    // Bootstrap complete seen, no deep history → resolves to complete on quiet.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.getStore().historySyncState).toBe("complete");
  });

  it("does NOT seal complete when chats are known but no messages arrived", async () => {
    // The chat list reaches a linked device long before message history does.
    // A push that delivers the chats and then stops is not an empty account,
    // and sealing it complete reports a corpus of four messages as synced.
    const fake = new FakeWhatsAppServer({ meJid: ME_JID, chats: [] });
    const p = await connect(fake);
    // The chat list lands ahead of any message history — this is the shape a
    // stalled push leaves behind.
    p.getStore().updateGroupRosters(new Map([["fixture-group-roster", []]]));
    expect(p.getStore().totalChats).toBeGreaterThan(0);
    expect(p.getStore().totalMessages).toBe(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

    expect(p.getStore().historySyncState).toBe("interrupted");
    expect(p.getStore().historySyncComplete).toBe(false);
  });

  it("treats an empty/new account (no batches) as complete", async () => {
    const fake = new FakeWhatsAppServer({ meJid: ME_JID, chats: [] });
    const p = await connect(fake);
    // No history push at all → the 5-min settle timer resolves to complete.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(p.getStore().historySyncState).toBe("complete");
  });

  it("a reconnect's history is not sealed by the previous connection's timer", async () => {
    // The settle timer is a backstop for one connection's silence. A drop
    // restarts the history push, so a timer armed before it is counting down
    // against a stream that no longer exists — and left running it sealed the
    // fresh attempt as finished seconds after it began, which is how a paired
    // account reports "synced" holding almost nothing.
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(p.getStore().historySyncState).toBe("streaming");

    fake.close();
    await vi.advanceTimersByTimeAsync(70_000); // exceed the max reconnect backoff
    fake.connect();
    await vi.advanceTimersByTimeAsync(1);

    // Past the first connection's 5-minute mark, 30 seconds into the second.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(p.getStore().historySyncState).toBe("streaming");
    expect(p.getStore().historySyncComplete).toBe(false);

    // The second connection's own window still governs it.
    fake.pushInitialHistory({ terminate: "isLatest" });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("complete");
    expect(p.getStore().totalMessages).toBe(2);
  });

  it("re-enters streaming on reconnect after an interrupted pass", async () => {
    const fake = new FakeWhatsAppServer(corpus());
    const p = await connect(fake);
    fake.pushInitialHistory({ terminate: "interrupt", syncType: 3 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.getStore().historySyncState).toBe("interrupted");

    // A real reconnect (close → backoff → new socket) re-expects history
    // because interrupted != complete; the provider re-enters streaming.
    fake.close();
    await vi.advanceTimersByTimeAsync(70_000); // exceed the max reconnect backoff
    expect(p.getStore().historySyncState).toBe("streaming");
    fake.connect();
    await vi.advanceTimersByTimeAsync(1);
    // This time it completes.
    fake.pushInitialHistory({ terminate: "isLatest" });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getStore().historySyncState).toBe("complete");
  });
});
