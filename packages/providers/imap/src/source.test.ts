// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  deriveAttachmentStableId,
  resolveAttachmentConfig,
  LogLevel,
  setLogLevel,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { ImapEmailSource, validateImapEmailCursor } from "./source.js";
import type {
  ImapAttachmentPart,
  ImapClient,
  ImapMailbox,
  ImapMailboxState,
  ImapMessage,
  ImapEmailCursor,
} from "./source.js";

class FakeImapClient implements ImapClient {
  readonly opened: string[] = [];
  readonly fetched: number[][] = [];
  connectCalls = 0;
  closeCalls = 0;
  private selected = "";

  constructor(
    private readonly mailboxes: ImapMailbox[],
    private readonly states: Record<string, ImapMailboxState>,
    private readonly messages: Record<string, ImapMessage[]>,
  ) {}

  connect(): Promise<void> {
    this.connectCalls += 1;
    return Promise.resolve();
  }

  list(): Promise<ImapMailbox[]> {
    return Promise.resolve(this.mailboxes);
  }

  open(path: string): Promise<ImapMailboxState> {
    this.selected = path;
    this.opened.push(path);
    return Promise.resolve(this.states[path]);
  }

  search(query: { since?: Date; uid?: string }): Promise<number[]> {
    const rows = this.messages[this.selected] ?? [];
    if (query.since) {
      const dayStart = new Date(query.since);
      dayStart.setUTCHours(0, 0, 0, 0);
      return Promise.resolve(
        rows
          .filter((row) => (row.internalDate?.getTime() ?? 0) >= dayStart.getTime())
          .map((row) => row.uid),
      );
    }
    const first = Number(query.uid?.split(":", 1)[0] ?? 1);
    return Promise.resolve(rows.filter((row) => row.uid >= first).map((row) => row.uid));
  }

  fetch(uids: number[]): Promise<ImapMessage[]> {
    this.fetched.push(uids);
    return Promise.resolve(
      (this.messages[this.selected] ?? []).filter((row) => uids.includes(row.uid)),
    );
  }

  readonly metadataOpts: Array<{ attachments?: boolean } | undefined> = [];

  fetchMetadata(
    uids: number[],
    opts?: { attachments?: boolean },
  ): Promise<Array<{ uid: number; date?: Date; attachments?: ImapAttachmentPart[] }>> {
    this.metadataOpts.push(opts);
    return Promise.resolve(
      (this.messages[this.selected] ?? [])
        .filter((row) => uids.includes(row.uid))
        .map((row) => ({
          uid: row.uid,
          date: row.internalDate ?? row.envelope.date,
          ...(opts?.attachments && row.attachments ? { attachments: row.attachments } : {}),
        })),
    );
  }

  readonly attachmentData: Record<string, Uint8Array> = {};
  readonly attachmentFetches: Array<{ uid: number; part: string; maxBytes: number }> = [];

  fetchAttachment(uid: number, part: string, maxBytes: number): Promise<Uint8Array> {
    this.attachmentFetches.push({ uid, part, maxBytes });
    const data = this.attachmentData[`${uid}:${part}`];
    if (!data) return Promise.reject(new Error(`no attachment data for ${uid}:${part}`));
    return Promise.resolve(data);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

function message(uid: number, date: string, subject: string, body: string): ImapMessage {
  const from = { name: "Sender", address: "sender@example.com" };
  const to = { name: "Recipient", address: "recipient@example.org" };
  return {
    uid,
    envelope: {
      subject,
      date: new Date(date),
      from: [from],
      to: [to],
      messageId: `<message-${uid}@example.com>`,
    },
    internalDate: new Date(date),
    references: uid > 1 ? ["<message-1@example.com>"] : undefined,
    text: body,
  };
}

describe("ImapEmailSource", () => {
  it("rejects malformed persisted cursors", () => {
    expect(validateImapEmailCursor({ phase: "incremental", mailboxes: {} })).toEqual({
      phase: "incremental",
      mailboxes: {},
    });
    expect(
      validateImapEmailCursor({
        phase: "incremental",
        mailboxes: { INBOX: { uidValidity: "41", lastUid: -1 } },
      }),
    ).toBeNull();
    expect(
      validateImapEmailCursor({
        phase: "bootstrap",
        mailboxes: {},
        activeMailbox: {
          path: "INBOX",
          uidValidity: "41",
          highWaterUid: 20,
          afterUid: 21,
        },
      }),
    ).toBeNull();
  });

  it("fails closed when the persisted cursor exceeds the mailbox high-water UID", async () => {
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      {},
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(
      source.sync({
        phase: "incremental",
        mailboxes: { INBOX: { uidValidity: "41", lastUid: 5 } },
      }),
    ).rejects.toThrow("cursor exceeds mailbox high-water UID");
  });

  it("fails closed when mailbox UIDNEXT is invalid", async () => {
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: Number.NaN } },
      {},
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null)).rejects.toThrow("invalid UIDNEXT");
  });

  it("fails closed when SEARCH returns duplicate UIDs", async () => {
    const row = message(1, "2026-08-01T09:00:00.000Z", "Duplicate search", "Body");
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [row] },
    );
    client.search = () => Promise.resolve([1, 1]);
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null)).rejects.toThrow("duplicate UID");
  });

  it("caps snapshot UID scanning even when every message predates the cutoff", async () => {
    const uids = Array.from({ length: 250_000 }, (_, index) => index + 1);
    const mailboxes: ImapMailbox[] = ["A", "B", "C"].map((path) => ({
      path,
      flags: new Set(),
    }));
    const states = Object.fromEntries(
      mailboxes.map((mailbox) => [mailbox.path, { uidValidity: "41", uidNext: 250_001 }]),
    );
    const client = new FakeImapClient(mailboxes, states, {});
    client.search = () => Promise.resolve(uids);
    client.fetchMetadata = (page) =>
      Promise.resolve(page.map((uid) => ({ uid, date: new Date("2026-01-01T00:00:00.000Z") })));
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
    );
    const cursor = {
      phase: "incremental" as const,
      mailboxes: {
        A: { uidValidity: "41", lastUid: 250_000 },
        B: { uidValidity: "41", lastUid: 250_000 },
        C: { uidValidity: "41", lastUid: 250_000 },
      },
    };

    const first = await source.sync(cursor);
    const second = await source.sync(first.cursor);

    await expect(source.sync(second.cursor)).rejects.toThrow("safe scanned-UID limit");
  });

  it("fails closed when a server returns an unsafe UID enumeration", async () => {
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 300_000 } },
      {},
    );
    client.search = () => Promise.resolve(Array.from({ length: 250_001 }, (_, index) => index + 1));
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null)).rejects.toThrow("safe UID limit");
  });

  it("closes a connection that finishes after disposal", async () => {
    let releaseConnect: () => void = () => {};
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 52 } },
      {
        INBOX: Array.from({ length: 51 }, (_, index) =>
          message(index + 1, "2026-08-01T09:00:00.000Z", `Message ${index + 1}`, "Body"),
        ),
      },
    );
    client.connect = () => {
      client.connectCalls += 1;
      return connectGate;
    };
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    const sync = source.sync(null);
    await vi.waitFor(() => expect(client.connectCalls).toBe(1));
    const disposal = source.dispose();
    releaseConnect();

    await disposal;
    await expect(sync).rejects.toThrow("lifecycle changed");
    expect(client.closeCalls).toBe(1);
  });

  it("does not connect when the collector already aborted the run", async () => {
    const client = new FakeImapClient([], {}, {});
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(client.connectCalls).toBe(0);
  });

  it("rejects an overlapping tick while a page is still in flight", async () => {
    let releaseList: (mailboxes: ImapMailbox[]) => void = () => {};
    const listGate = new Promise<ImapMailbox[]>((resolve) => {
      releaseList = resolve;
    });
    const client = new FakeImapClient([], {}, {});
    client.list = () => listGate;
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    const first = source.sync(null);
    await vi.waitFor(() => expect(client.connectCalls).toBe(1));

    await expect(source.sync(null)).rejects.toThrow("already in progress");

    releaseList([]);
    await expect(first).resolves.toMatchObject({ documents: [], hasMore: false });
  });

  it("uses the stable external id as thread id when RFC thread headers are absent", async () => {
    const row = message(1, "2026-08-01T09:00:00.000Z", "Standalone", "Body");
    row.envelope.messageId = undefined;
    row.envelope.inReplyTo = undefined;
    row.references = undefined;
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [row] },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    const result = await source.sync(null);

    expect(result.documents[0].metadata.extra?.threadId).toBe("SU5CT1g:41:1");
  });

  it("fails the page when the server duplicates a fetched UID", async () => {
    const row = message(1, "2026-08-01T09:00:00.000Z", "Duplicate", "Body");
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [row] },
    );
    client.fetch = () => Promise.resolve([row, row]);
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null)).rejects.toThrow("duplicate fetched UID");
  });

  it("fails the page when a message has no trustworthy timestamp", async () => {
    const row = message(1, "2026-08-01T09:00:00.000Z", "Missing date", "Body");
    row.internalDate = undefined;
    row.envelope.date = undefined;
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [row] },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    await expect(source.sync(null)).rejects.toThrow("no valid date");
    expect(client.closeCalls).toBe(1);
  });

  it("applies the exact cutoff to the final snapshot despite day-granular SINCE", async () => {
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 3 } },
      {
        INBOX: [
          message(1, "2026-08-01T09:00:00.000Z", "Before cutoff", "Old body"),
          message(2, "2026-08-01T13:00:00.000Z", "After cutoff", "Recent body"),
        ],
      },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      "2026-08-01T12:00:00.000Z",
    );

    const result = await source.sync(null);

    expect(result.documents.map((doc) => doc.title)).toEqual(["After cutoff"]);
    expect(result.presentExternalIds).toEqual(["SU5CT1g:41:2"]);
  });

  it("waits for an in-flight retained connection close during disposal", async () => {
    vi.useFakeTimers();
    try {
      let releaseClose: () => void = () => {};
      const closeGate = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const client = new FakeImapClient(
        [{ path: "INBOX", flags: new Set() }],
        { INBOX: { uidValidity: "41", uidNext: 52 } },
        {
          INBOX: Array.from({ length: 51 }, (_, index) =>
            message(index + 1, "2026-08-01T09:00:00.000Z", `Message ${index + 1}`, "Body"),
          ),
        },
      );
      client.close = () => {
        client.closeCalls += 1;
        return closeGate;
      };
      const source = new ImapEmailSource(
        "imap:account@example.com",
        "imap:account@example.com",
        () => client,
      );
      await source.sync(null);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.closeCalls).toBe(1);

      let disposed = false;
      const disposal = source.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toBe(false);

      releaseClose();
      await disposal;
      expect(client.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a retained page-chain connection when the gateway does not continue", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeImapClient(
        [{ path: "INBOX", flags: new Set() }],
        { INBOX: { uidValidity: "41", uidNext: 52 } },
        {
          INBOX: Array.from({ length: 51 }, (_, index) =>
            message(index + 1, "2026-08-01T09:00:00.000Z", `Message ${index + 1}`, "Body"),
          ),
        },
      );
      const source = new ImapEmailSource(
        "imap:account@example.com",
        "imap:account@example.com",
        () => client,
      );

      const first = await source.sync(null);
      expect(first.hasMore).toBe(true);
      expect(client.closeCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkpoints a bounded bootstrap page before continuing", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      message(
        index + 1,
        `2026-08-${String((index % 19) + 1).padStart(2, "0")}T09:00:00.000Z`,
        `Message ${index + 1}`,
        `Body ${index + 1}`,
      ),
    );
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 52 } },
      { INBOX: rows },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
    );

    const first = await source.sync(null);

    expect(first.documents).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.presentExternalIds).toBeUndefined();
    expect(client.fetched[0]).toHaveLength(50);
    expect(client.connectCalls).toBe(1);
    expect(client.closeCalls).toBe(0);
    // A provider could have already pruned older mail under its own
    // retention policy before this account was ever connected; IMAP gives no
    // signal that happened, so bootstrap can never vouch for full coverage.
    expect(first.progress).toMatchObject({ phase: "bootstrap", coverage: "unknown" });

    const second = await source.sync(first.cursor);

    expect(second.documents.map((doc) => doc.title)).toEqual(["Message 51"]);
    expect(second.hasMore).toBe(false);
    expect(second.presentExternalIds).toHaveLength(51);
    expect(client.connectCalls).toBe(1);
    expect(client.closeCalls).toBe(1);
    expect(second.cursor).toEqual({
      phase: "incremental",
      mailboxes: { INBOX: { uidValidity: "41", lastUid: 51 } },
    });
    // Steady-state incremental sync is just as unable to detect server-side
    // pruning as bootstrap, so the same uncertainty carries forward.
    expect(second.progress).toMatchObject({ phase: "incremental", coverage: "unknown" });
  });

  it("recovers when a mailbox is renamed during a paged bootstrap", async () => {
    const mailboxes: ImapMailbox[] = [{ path: "INBOX", flags: new Set() }];
    const states: Record<string, ImapMailboxState> = {
      INBOX: { uidValidity: "41", uidNext: 52 },
    };
    const messages: Record<string, ImapMessage[]> = {
      INBOX: Array.from({ length: 51 }, (_, index) =>
        message(index + 1, "2026-08-01T09:00:00.000Z", `Before rename ${index + 1}`, "Body"),
      ),
    };
    const client = new FakeImapClient(mailboxes, states, messages);
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );
    const first = await source.sync(null);
    expect(first.hasMore).toBe(true);

    mailboxes.splice(0, 1, { path: "Archive", flags: new Set() });
    states.Archive = { uidValidity: "41", uidNext: 2 };
    messages.Archive = [message(1, "2026-08-02T09:00:00.000Z", "Renamed mailbox", "Renamed body")];

    const second = await source.sync(first.cursor);

    expect(second.documents.map((doc) => doc.title)).toEqual(["Renamed mailbox"]);
    expect(second.hasMore).toBe(false);
    expect(second.cursor).toEqual({
      phase: "incremental",
      mailboxes: { Archive: { uidValidity: "41", lastUid: 1 } },
    });
    expect(second.presentExternalIds).toEqual(["QXJjaGl2ZQ:41:1"]);
  });

  it("an empty LIST never authorizes deleting the account's messages", async () => {
    const mailboxes: ImapMailbox[] = [];
    const client = new FakeImapClient(mailboxes, { INBOX: { uidValidity: "41", uidNext: 1 } }, {});
    const source = new ImapEmailSource("imap:fixture", "imap:fixture", () => client);
    let cursor: ImapEmailCursor = {
      phase: "incremental" as const,
      mailboxes: { INBOX: { uidValidity: "41", lastUid: 12 } },
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await source.sync(cursor);
      expect(result.presentExternalIds).toBeUndefined();
      expect(result.presentClaims).toBeUndefined();
      expect(result.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      expect(result.deletedExternalIds).toEqual([]);
      expect(result.documents).toEqual([]);
      expect(result.hasMore).toBe(false);
      cursor = result.cursor;
    }
    expect(client.opened).toEqual([]);
    mailboxes.push({ path: "INBOX", flags: new Set() });
    const recovered = await source.sync(cursor);
    expect(recovered.presentExternalIds).toEqual([]);
    expect(recovered.issues).toEqual([]);
  });

  it("a successful nonempty LIST prunes removed mailbox state and reconciles its documents", async () => {
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [message(1, "2026-08-01T09:00:00.000Z", "Kept message", "Body")] },
    );
    const source = new ImapEmailSource("imap:fixture", "imap:fixture", () => client);
    let cursor: ImapEmailCursor = {
      phase: "incremental" as const,
      mailboxes: {
        INBOX: { uidValidity: "41", lastUid: 1 },
        Archive: { uidValidity: "42", lastUid: 10 },
      },
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await source.sync(cursor);
      expect(result.cursor.mailboxes).toEqual({ INBOX: { uidValidity: "41", lastUid: 1 } });
      expect(result.presentExternalIds).toEqual(["SU5CT1g:41:1"]);
      expect(result.issues).toEqual([]);
      expect(client.opened).not.toContain("Archive");
      cursor = result.cursor;
    }
  });

  it("finds every renumbered mailbox in one pass and asserts nothing until they settle", async () => {
    const client = new FakeImapClient(
      [
        { path: "Archive", flags: new Set() },
        { path: "INBOX", flags: new Set() },
      ],
      {
        Archive: { uidValidity: "99", uidNext: 2 },
        INBOX: { uidValidity: "42", uidNext: 2 },
      },
      {
        Archive: [message(1, "2026-08-02T09:00:00.000Z", "Reset archive", "Body")],
        INBOX: [message(1, "2026-08-02T10:00:00.000Z", "Pending inbox", "Body")],
      },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    const first = await source.sync({
      phase: "bootstrap",
      // Both mailboxes are on the cursor at a UIDVALIDITY neither still has, so
      // both move. One pass has to find both: aborting at the first would
      // re-queue one per cycle, and an account whose server renumbered
      // everything would settle one mailbox at a time.
      mailboxes: {
        Archive: { uidValidity: "41", lastUid: 5 },
        INBOX: { uidValidity: "40", lastUid: 5 },
      },
      pendingMailboxPaths: [],
    });

    expect(first.hasMore).toBe(true);
    // Archive was renumbered, so nothing this cycle holds for it names anything
    // that still exists — Archive goes back to bootstrap and the cycle asserts
    // nothing at all. Not even a claim for INBOX: this page says there is more,
    // and an assertion about what exists is only valid on a page that ends the
    // enumeration it describes.
    expect(first.presentExternalIds).toBeUndefined();
    expect(first.presentClaims).toBeUndefined();
    expect(first.cursor).toEqual({
      phase: "bootstrap",
      mailboxes: {},
      pendingMailboxPaths: ["Archive", "INBOX"],
    });

    // Both re-bootstrap, one mailbox per call, and the cycle settles.
    let page = await source.sync(first.cursor);
    const titles = [...page.documents.map((doc) => doc.title)];
    const partitions = [...page.documents.map((doc) => doc.partitionKey)];
    for (let i = 0; i < 5 && page.hasMore; i++) {
      page = await source.sync(page.cursor);
      titles.push(...page.documents.map((doc) => doc.title));
      partitions.push(...page.documents.map((doc) => doc.partitionKey));
    }

    expect(page.hasMore).toBe(false);
    expect(titles.sort()).toEqual(["Pending inbox", "Reset archive"]);
    expect(page.cursor.mailboxes).toEqual({
      Archive: { uidValidity: "99", lastUid: 1 },
      INBOX: { uidValidity: "42", lastUid: 1 },
    });
    // Settled: every mailbox read, so the account-wide form is published.
    expect(page.presentExternalIds?.slice().sort()).toEqual(["QXJjaGl2ZQ:99:1", "SU5CT1g:42:1"]);
    // Every message says which mailbox it is in.
    expect(partitions.sort()).toEqual(["Archive", "INBOX"]);
  });

  it("the snapshot ceiling counts the whole account, not one mailbox at a time", async () => {
    // The ceiling bounds the single `presentExternalIds` array this source
    // emits, so it has to count every mailbox already enumerated as well as the
    // one in hand. Counted per mailbox instead, an account of many small
    // mailboxes would sail past it and the guard would never fire.
    const client = new FakeImapClient(
      [
        { path: "INBOX", flags: new Set() },
        { path: "Archive", flags: new Set() },
      ],
      {
        INBOX: { uidValidity: "42", uidNext: 3 },
        Archive: { uidValidity: "43", uidNext: 3 },
      },
      {
        INBOX: [
          message(1, "2026-08-02T10:00:00.000Z", "One", "Body"),
          message(2, "2026-08-02T10:01:00.000Z", "Two", "Body"),
        ],
        Archive: [
          message(1, "2026-08-02T09:00:00.000Z", "Three", "Body"),
          message(2, "2026-08-02T09:01:00.000Z", "Four", "Body"),
        ],
      },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      undefined,
      // Three ids fit; the fourth is one mailbox past the first.
      { maxPresentIds: 3 },
    );

    let page = await source.sync(null);
    let error: unknown;
    for (let i = 0; i < 6 && page.hasMore; i++) {
      page = await source.sync(page.cursor).catch((err: unknown) => {
        error = err;
        return page;
      });
      if (error) break;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("safe snapshot limit (3)");
  });

  it("names every mailbox it could not vouch for, and why", async () => {
    // The mailbox would be withheld anyway — a partition nobody covered is one
    // nobody vouched for — so the only thing the explicit record buys is the
    // reason, and the only place the reason surfaces is the operator's log. An
    // unread mailbox that reads as "not read this cycle" when the truth is
    // "renumbered, and being re-bootstrapped right now" is the difference
    // between a line worth acting on and a line worth ignoring.
    const client = new FakeImapClient(
      [
        { path: "Archive", flags: new Set() },
        { path: "INBOX", flags: new Set() },
      ],
      {
        Archive: { uidValidity: "99", uidNext: 2 },
        INBOX: { uidValidity: "42", uidNext: 2 },
      },
      {
        Archive: [message(1, "2026-08-02T09:00:00.000Z", "Reset archive", "Body")],
        INBOX: [message(1, "2026-08-02T10:00:00.000Z", "Pending inbox", "Body")],
      },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );

    setLogLevel(LogLevel.INFO);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await source.sync({
        phase: "bootstrap",
        mailboxes: { Archive: { uidValidity: "41", lastUid: 5 } },
        pendingMailboxPaths: ["INBOX"],
      });
      const lines = warn.mock.calls.flat().join(" ");
      expect(lines).toContain("Archive");
      expect(lines).toContain("UIDVALIDITY moved");
    } finally {
      warn.mockRestore();
      setLogLevel(LogLevel.WARN);
    }
  });

  it("fetches only newer UIDs and reboots when UIDVALIDITY changes", async () => {
    const incrementalClient = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 4 } },
      {
        INBOX: [
          message(1, "2026-08-01T09:00:00.000Z", "First", "First body"),
          message(3, "2026-08-03T09:00:00.000Z", "Third", "Third body"),
        ],
      },
    );
    const resetClient = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "99", uidNext: 2 } },
      { INBOX: [message(1, "2026-08-04T09:00:00.000Z", "After reset", "Reset body")] },
    );
    let client = incrementalClient;
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
    );

    const incremental = await source.sync({
      phase: "incremental",
      mailboxes: { INBOX: { uidValidity: "41", lastUid: 2 } },
    });

    expect(incremental.documents.map((doc) => doc.title)).toEqual(["Third"]);
    expect(incrementalClient.fetched).toEqual([[3]]);
    expect(incremental.presentExternalIds).toEqual(["SU5CT1g:41:1", "SU5CT1g:41:3"]);

    client = resetClient;
    const reset = await source.sync(incremental.cursor);

    expect(reset.documents.map((doc) => doc.title)).toEqual(["After reset"]);
    expect(resetClient.fetched).toEqual([[1]]);
    expect(reset.cursor).toEqual({
      phase: "incremental",
      mailboxes: { INBOX: { uidValidity: "99", lastUid: 1 } },
    });
    expect(reset.presentExternalIds).toEqual(["SU5CT1g:99:1"]);
  });

  it("bootstraps recent email from selectable non-junk mailboxes", async () => {
    const client = new FakeImapClient(
      [
        { path: "INBOX", flags: new Set() },
        { path: "Drafts", flags: new Set(), specialUse: "\\Drafts" },
        { path: "Junk", flags: new Set(), specialUse: "\\Junk" },
        { path: "Trash", flags: new Set(), specialUse: "\\Trash" },
      ],
      {
        INBOX: { uidValidity: "41", uidNext: 4 },
        Drafts: { uidValidity: "42", uidNext: 1 },
        Junk: { uidValidity: "43", uidNext: 1 },
        Trash: { uidValidity: "44", uidNext: 1 },
      },
      {
        INBOX: [
          message(1, "2026-06-01T09:00:00.000Z", "Old planning note", "Old body"),
          message(2, "2026-08-02T09:00:00.000Z", "Budget review", "Review Q4 budget."),
          message(3, "2026-08-03T10:30:00.000Z", "Workshop", "Meet in the workshop room."),
        ],
      },
    );
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
    );

    const result = await source.sync(null);

    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((doc) => doc.title)).toEqual(["Budget review", "Workshop"]);
    expect(result.documents[0]).toMatchObject({
      sourceId: "imap:account@example.com",
      providerId: "imap:account@example.com",
      externalId: "SU5CT1g:41:2",
      sourceCreatedAt: "2026-08-02T09:00:00.000Z",
      metadata: {
        documentType: "email",
        people: [
          { role: "sender", name: "Sender", emails: ["sender@example.com"] },
          { role: "recipient", name: "Recipient", emails: ["recipient@example.org"] },
        ],
        extra: {
          mailbox: "INBOX",
          uid: 2,
          uidValidity: "41",
          threadId: "<message-1@example.com>",
          references: ["<message-1@example.com>"],
        },
      },
    });
    expect(result.documents[0].content).toContain("Review Q4 budget.");
    expect(result.presentExternalIds).toEqual(["SU5CT1g:41:2", "SU5CT1g:41:3"]);
    expect(result.cursor).toEqual({
      phase: "incremental",
      mailboxes: { INBOX: { uidValidity: "41", lastUid: 3 } },
    });
    expect(client.opened).not.toContain("Drafts");
    expect(client.opened).not.toContain("Junk");
    expect(client.opened).not.toContain("Trash");
  });

  it("derives mail markers and relevance from headers", async () => {
    const bulk = message(2, "2026-08-02T09:00:00.000Z", "Sale", "Deals inside.");
    bulk.listUnsubscribe = "<https://example.com/unsubscribe>";
    bulk.precedence = "bulk";
    bulk.autoSubmitted = "Auto-Generated";
    const automated = message(3, "2026-08-03T09:00:00.000Z", "Build failed", "See run 12.");
    automated.envelope.from = [{ name: "CI", address: "noreply@example.com" }];
    const declined = message(4, "2026-08-04T09:00:00.000Z", "Reply", "Human reply.");
    declined.autoSubmitted = "No (sent by a human)";
    const listed = message(5, "2026-08-05T09:00:00.000Z", "Digest", "This week on the list.");
    listed.precedence = "List";
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 6 } },
      {
        INBOX: [
          message(1, "2026-08-01T09:00:00.000Z", "Plan", "Plain body."),
          bulk,
          automated,
          declined,
          listed,
        ],
      },
    );
    const source = new ImapEmailSource("imap:a@example.com", "imap:a@example.com", () => client);

    const docs = (await source.sync(null)).documents;

    expect(docs[0].metadata).toMatchObject({ relevanceScore: 0.5 });
    expect(docs[0].metadata.bulkMail).toBeUndefined();
    expect(docs[0].metadata.automatedSender).toBeUndefined();
    // 0.5 - 0.25 (List-Unsubscribe) - 0.15 (Precedence: bulk) - 0.3 (Auto-Submitted), clamped.
    expect(docs[1].metadata).toMatchObject({
      relevanceScore: 0,
      bulkMail: true,
      automatedSender: true,
    });
    // A no-reply local part marks the sender automated without any header.
    expect(docs[2].metadata).toMatchObject({ relevanceScore: 0.5, automatedSender: true });
    expect(docs[2].metadata.bulkMail).toBeUndefined();
    // RFC 3834 `Auto-Submitted: no` is an explicit human assertion — any
    // casing, with or without a trailing comment — and costs no relevance.
    expect(docs[3].metadata.automatedSender).toBeUndefined();
    expect(docs[3].metadata.relevanceScore).toBe(0.5);
    // `Precedence: List` (any casing) alone costs exactly its own penalty.
    expect(docs[4].metadata.relevanceScore).toBeCloseTo(0.35);
    expect(docs[4].metadata.bulkMail).toBeUndefined();
    expect(docs[4].metadata.automatedSender).toBeUndefined();
  });

  it("boosts mail in the sent mailbox", async () => {
    const client = new FakeImapClient(
      [{ path: "Sent", flags: new Set(), specialUse: "\\Sent" }],
      { Sent: { uidValidity: "51", uidNext: 2 } },
      { Sent: [message(1, "2026-08-02T09:00:00.000Z", "Outbound", "Wrote this myself.")] },
    );
    const source = new ImapEmailSource("imap:a@example.com", "imap:a@example.com", () => client);

    const docs = (await source.sync(null)).documents;

    expect(docs[0].metadata.relevanceScore).toBeCloseTo(0.9);
  });

  it("promotes schema.org dates from an HTML body", async () => {
    const html =
      `<html><body><script type="application/ld+json">` +
      JSON.stringify({
        "@type": "FlightReservation",
        reservationFor: { "@type": "Flight", departureTime: "2026-10-02T06:00:00Z" },
      }) +
      `</script><script type="application/ld+json">` +
      JSON.stringify({ "@type": "Invoice", paymentDueDate: "2026-09-20" }) +
      `</script><p>Your booking</p></body></html>`;
    const booking = message(1, "2026-08-02T09:00:00.000Z", "Booking", "");
    delete booking.text;
    booking.html = html;
    // A multipart/alternative message: the plain part is the body, but the
    // HTML sibling the client also downloads still gets scanned for markup.
    const alternative = message(3, "2026-08-04T09:00:00.000Z", "Itinerary", "Plain itinerary.");
    alternative.html = html;
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 4 } },
      {
        INBOX: [
          booking,
          message(2, "2026-08-03T09:00:00.000Z", "Plain", "No markup."),
          alternative,
        ],
      },
    );
    const source = new ImapEmailSource("imap:a@example.com", "imap:a@example.com", () => client);

    const docs = (await source.sync(null)).documents;

    expect(docs[0].metadata).toMatchObject({
      scheduledAt: "2026-10-02T06:00:00Z",
      dueAt: "2026-09-20",
    });
    expect(docs[1].metadata.scheduledAt).toBeUndefined();
    expect(docs[1].metadata.dueAt).toBeUndefined();
    expect(docs[2].metadata).toMatchObject({
      scheduledAt: "2026-10-02T06:00:00Z",
      dueAt: "2026-09-20",
    });
    expect(docs[2].content).toContain("Plain itinerary.");
  });

  const attachmentOptions = () => ({
    attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
    extractAttachment: vi.fn(() =>
      Promise.resolve({ text: "Q4 budget: contact david.lin@example.org", truncated: false }),
    ),
  });

  it("extracts eligible attachments into child documents and markers", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Budget", "Numbers attached.");
    mail.attachments = [
      { part: "2", filename: "budget.pdf", mimeType: "application/pdf", size: 2048 },
      { part: "3", filename: "tool.exe", mimeType: "application/x-msdownload", size: 100 },
      { part: "4", filename: "huge.pdf", mimeType: "application/pdf", size: 500_000_000 },
      { part: "5", filename: "nosize.pdf", mimeType: "application/pdf", size: null },
    ];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    client.attachmentData["1:2"] = new TextEncoder().encode("pdf-bytes");
    const options = attachmentOptions();
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      options,
    );

    const result = await source.sync(null);
    const [email, child, ...rest] = result.documents;

    expect(rest).toHaveLength(0);
    expect(options.extractAttachment).toHaveBeenCalledTimes(1);
    // Child contract: derived stable id under /att/, parent linkage, inherited
    // correspondents plus its own extracted mention.
    const stableId = deriveAttachmentStableId("budget.pdf", 2048, "application/pdf");
    expect(child.externalId).toBe(`${email.externalId}/att/${stableId}`);
    expect(child.metadata.documentType).toBe("attachment");
    expect(child.title).toBe("budget.pdf");
    expect((child.metadata.extra as Record<string, unknown>).parentExternalId).toBe(
      email.externalId,
    );
    expect(child.metadata.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "sender" }),
        expect.objectContaining({ role: "recipient" }),
        expect.objectContaining({ role: "mentioned", emails: ["david.lin@example.org"] }),
      ]),
    );
    // Parent carries markers for all four parts, with skip reasons.
    expect(email.content).toContain("**Attachments:**");
    const infos = (email.metadata.extra as Record<string, unknown>).attachments as Array<
      Record<string, unknown>
    >;
    expect(infos.map((i) => [i.filename, i.extracted, i.reason])).toEqual(
      expect.arrayContaining([
        ["budget.pdf", true, undefined],
        ["tool.exe", false, "type-excluded"],
        ["huge.pdf", false, "too-large"],
        ["nosize.pdf", false, "size-unknown"],
      ]),
    );
    // The snapshot names the child so the sweep can never delete it.
    expect(result.presentExternalIds).toContain(`${email.externalId}/att/${stableId}`);
    // Skipped parts have no child documents and no snapshot ids.
    expect(result.presentExternalIds?.filter((id) => id.includes("/att/"))).toHaveLength(1);
  });

  it("records a marker instead of a child when extraction fails, and fails the page on transient errors", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Scan", "See attachment.");
    mail.attachments = [{ part: "2", filename: "scan.pdf", mimeType: "application/pdf", size: 10 }];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    client.attachmentData["1:2"] = new TextEncoder().encode("bytes");
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      {
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        extractAttachment: () => Promise.resolve(null),
      },
    );

    const result = await source.sync(null);

    expect(result.documents).toHaveLength(1);
    const infos = (result.documents[0].metadata.extra as Record<string, unknown>)
      .attachments as Array<Record<string, unknown>>;
    expect(infos[0]).toMatchObject({ extracted: false, reason: "extraction-failed" });
    // The failed extraction is still named by the snapshot — naming a missing
    // document is harmless; failing to name a stored one deletes it.
    expect(result.presentExternalIds?.some((id) => id.includes("/att/"))).toBe(true);

    // A non-transient download error becomes a marker; a transient one fails the page.
    const flaky = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    flaky.fetchAttachment = () =>
      Promise.reject(new SyncError("network", "IMAP server is unreachable"));
    const flakySource = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => flaky,
      undefined,
      attachmentOptions(),
    );
    await expect(flakySource.sync(null)).rejects.toThrow("unreachable");

    const broken = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    broken.fetchAttachment = () => Promise.reject(new Error("part vanished"));
    const brokenSource = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => broken,
      undefined,
      attachmentOptions(),
    );
    const brokenResult = await brokenSource.sync(null);
    const brokenInfos = (brokenResult.documents[0].metadata.extra as Record<string, unknown>)
      .attachments as Array<Record<string, unknown>>;
    expect(brokenInfos[0]).toMatchObject({ extracted: false, reason: "download-failed" });
    expect(brokenResult.documents).toHaveLength(1);
  });

  it("keeps a cutoff-boundary message a day-granular server SINCE would drop", async () => {
    // INTERNALDATE 31 Jul 23:00 -05:00 — the instant (2026-08-01T04:00Z) is
    // past the cutoff, but the stored calendar day is 31 Jul. A server that
    // compares SINCE by that day excludes the message when the cutoff is
    // passed verbatim; on the snapshot path that exclusion is a deletion
    // order for a message the page loop ingested. The widened SINCE keeps
    // it, and the exact instant filter runs client-side.
    const boundary = message(1, "2026-08-01T04:00:00.000Z", "Boundary", "On the line.");
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [boundary] },
    );
    const serverOffsetMs = -5 * 3_600_000;
    const localDay = (d: Date) => Math.floor((d.getTime() + serverOffsetMs) / 86_400_000);
    const sinceDay = (d: Date) => Math.floor(d.getTime() / 86_400_000);
    client.search = (query) => {
      let rows = [boundary];
      if (query.since) {
        const since = query.since;
        rows = rows.filter((row) => localDay(row.internalDate!) >= sinceDay(since));
      }
      return Promise.resolve(rows.map((row) => row.uid));
    };
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
    );

    const result = await source.sync(null);

    expect(result.documents.map((d) => d.title)).toEqual(["Boundary"]);
    expect(result.presentExternalIds).toEqual([result.documents[0].externalId]);
  });

  it("applies the cutoff to attachment children in page and snapshot alike", async () => {
    const oldMail = message(1, "2026-06-01T09:00:00.000Z", "Old", "Ancient.");
    oldMail.attachments = [
      { part: "2", filename: "old.pdf", mimeType: "application/pdf", size: 100 },
    ];
    const newMail = message(2, "2026-08-02T09:00:00.000Z", "New", "Fresh.");
    newMail.attachments = [
      { part: "2", filename: "new.pdf", mimeType: "application/pdf", size: 200 },
    ];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 3 } },
      { INBOX: [oldMail, newMail] },
    );
    client.attachmentData["2:2"] = new TextEncoder().encode("bytes");
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      "2026-08-01T00:00:00.000Z",
      attachmentOptions(),
    );

    const result = await source.sync(null);

    // Only the post-cutoff message and its child exist and are named.
    expect(result.documents.map((d) => d.title)).toEqual(["New", "new.pdf"]);
    const childId = `${result.documents[0].externalId}/att/${deriveAttachmentStableId("new.pdf", 200, "application/pdf")}`;
    expect(result.documents[1].externalId).toBe(childId);
    expect(result.presentExternalIds).toContain(childId);
    expect(result.presentExternalIds?.some((id) => id.includes("old"))).toBe(false);
    expect(result.presentExternalIds?.filter((id) => id.includes("/att/"))).toEqual([childId]);
  });

  it("recovers generic MIME types from the filename with page/snapshot id parity", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Scan", "See attachment.");
    mail.attachments = [
      { part: "2", filename: "report.pdf", mimeType: "application/octet-stream", size: 64 },
    ];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    client.attachmentData["1:2"] = new TextEncoder().encode("bytes");
    const options = attachmentOptions();
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      options,
    );

    const result = await source.sync(null);
    const [email, child] = result.documents;

    // The recovered type feeds extraction, the stable id, and the snapshot.
    expect(options.extractAttachment).toHaveBeenCalledWith(
      expect.anything(),
      "application/pdf",
      expect.anything(),
    );
    expect(child.externalId).toBe(
      `${email.externalId}/att/${deriveAttachmentStableId("report.pdf", 64, "application/pdf")}`,
    );
    expect(result.presentExternalIds).toContain(child.externalId);
  });

  it("plumbs the configured size and text limits into download and extraction", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Note", "Attached.");
    mail.attachments = [{ part: "2", filename: "note.txt", mimeType: "text/plain", size: 64 }];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    client.attachmentData["1:2"] = new TextEncoder().encode("note");
    const extractAttachment = vi.fn(() => Promise.resolve({ text: "note", truncated: false }));
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      {
        attachmentConfig: resolveAttachmentConfig({
          attachmentMaxSizeBytes: 4096,
          attachmentMaxTextLength: 77,
          extractAttachments: true,
        }),
        extractAttachment,
      },
    );

    await source.sync(null);

    expect(client.attachmentFetches).toEqual([{ uid: 1, part: "2", maxBytes: 4096 }]);
    expect(extractAttachment).toHaveBeenCalledWith(expect.anything(), "text/plain", {
      maxTextLength: 77,
    });
  });

  it("records a no-text extraction as a marker, never an empty child", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Photo", "See photo.");
    mail.attachments = [{ part: "2", filename: "photo.png", mimeType: "image/png", size: 64 }];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    client.attachmentData["1:2"] = new TextEncoder().encode("png");
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      {
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        extractAttachment: () =>
          Promise.resolve({ text: "", truncated: false, noText: true as const }),
      },
    );

    const result = await source.sync(null);

    expect(result.documents).toHaveLength(1);
    const infos = (result.documents[0].metadata.extra as Record<string, unknown>)
      .attachments as Array<Record<string, unknown>>;
    expect(infos[0]).toMatchObject({ extracted: false, reason: "no-text" });
    // Still named: the enumeration is a superset of what exists.
    expect(result.presentExternalIds?.some((id) => id.includes("/att/"))).toBe(true);
  });

  it("stays on the cheap snapshot path when extraction is off despite an extractor", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Budget", "Numbers attached.");
    mail.attachments = [
      { part: "2", filename: "budget.pdf", mimeType: "application/pdf", size: 2048 },
    ];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    const extractAttachment = vi.fn();
    const source = new ImapEmailSource(
      "imap:a@example.com",
      "imap:a@example.com",
      () => client,
      undefined,
      {
        attachmentConfig: resolveAttachmentConfig({ extractAttachments: false }),
        extractAttachment,
      },
    );

    const result = await source.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(extractAttachment).not.toHaveBeenCalled();
    expect(client.attachmentFetches).toEqual([]);
    // No cutoff, no attachments: the snapshot never pays for metadata pages.
    expect(client.metadataOpts).toEqual([]);
    expect(result.presentExternalIds?.every((id) => !id.includes("/att/"))).toBe(true);
  });

  it("leaves attachments untouched when extraction is disabled", async () => {
    const mail = message(1, "2026-08-02T09:00:00.000Z", "Budget", "Numbers attached.");
    mail.attachments = [
      { part: "2", filename: "budget.pdf", mimeType: "application/pdf", size: 2048 },
    ];
    const client = new FakeImapClient(
      [{ path: "INBOX", flags: new Set() }],
      { INBOX: { uidValidity: "41", uidNext: 2 } },
      { INBOX: [mail] },
    );
    const source = new ImapEmailSource("imap:a@example.com", "imap:a@example.com", () => client);

    const result = await source.sync(null);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).not.toContain("**Attachments:**");
    expect(
      (result.documents[0].metadata.extra as Record<string, unknown>).attachments,
    ).toBeUndefined();
    expect(result.presentExternalIds?.every((id) => !id.includes("/att/"))).toBe(true);
  });
});
