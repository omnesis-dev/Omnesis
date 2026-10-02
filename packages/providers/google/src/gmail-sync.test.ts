// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
import type { AttachmentExtractFn } from "@omnesis/core";
import type { GmailSyncCursor } from "./gmail.js";

function apiError(code: number): Error {
  return Object.assign(new Error(`HTTP ${code}`), { code });
}

/** A mailbox listing served in pages of `pageSize`, newest first. */
function pagedMailbox(ids: string[], pageSize: number) {
  return vi.fn((params: { pageToken?: string }) => {
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const page = ids.slice(start, start + pageSize);
    const next = start + pageSize < ids.length ? String(start + pageSize) : undefined;
    return Promise.resolve({ data: { messages: page.map((id) => ({ id })), nextPageToken: next } });
  });
}

describe("Gmail bootstrap", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
  });

  test("keeps listing past the reported message count until Gmail runs out of pages", async () => {
    const source = createGmailSource(gmail);
    // Gmail reports three messages but serves five, the oldest last.
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 3, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d", "e"], 2);

    const seen: string[] = [];
    let cursor: GmailSyncCursor | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await source.sync(cursor);
      seen.push(...result.documents.map((d) => d.externalId));
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(cursor!.phase).toBe("incremental");
    expect(cursor!.coverage).toBe("complete");
  });

  test("stops at twice the reported count when Gmail keeps serving pages", async () => {
    const source = createGmailSource(gmail);
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 1, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d", "e", "f"], 1);

    let cursor: GmailSyncCursor | null = null;
    let pages = 0;
    for (; pages < 10; pages++) {
      const result = await source.sync(cursor);
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
    }
    expect(pages + 1).toBe(2);
    expect(cursor!.phase).toBe("incremental");
    // Gmail was still serving, so the walk cannot claim it reached everything.
    expect(cursor!.coverage).toBe("unknown");
  });
});

describe("Gmail sync length", () => {
  test("a long first sync pauses after twenty minutes and the next sync carries on", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 6, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d", "e", "f"], 1);
    const source = createGmailSource(gmail);
    let clock = Date.UTC(2026, 0, 1);
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 8 * 60 * 1000));
    try {
      const seen: string[] = [];
      let cursor: GmailSyncCursor | null = null;
      let syncs = 0;
      let pausedMidWalk = false;
      for (; syncs < 10; syncs++) {
        for (let page = 0; page < 10; page++) {
          const result = await source.sync(cursor);
          seen.push(...result.documents.map((d) => d.externalId));
          cursor = result.cursor as GmailSyncCursor;
          if (!result.hasMore) break;
        }
        if (cursor!.phase === "incremental") break;
        pausedMidWalk = true;
        expect(cursor!.pageToken).toBeDefined();
      }
      expect(pausedMidWalk).toBe(true);
      expect(seen).toEqual(["a", "b", "c", "d", "e", "f"]);
      expect(cursor!.phase).toBe("incremental");
    } finally {
      now.mockRestore();
    }
  });
});

describe("Gmail sync budget per host run", () => {
  test("a sync the host abandoned between pages does not shorten the next one", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 6, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d", "e", "f"], 1);
    const source = createGmailSource(gmail);
    let clock = Date.UTC(2026, 0, 1);
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const run = (id: string, page: number) => ({
      run: { id, reason: "scheduled" as const, start: "resume" as const, page },
    });
    try {
      const first = await source.sync(null, run("run-1", 0));
      expect(first.hasMore).toBe(true);
      // The host gives up on run-1 here, without another page and without a throw.
      clock += 25 * 60 * 1000;
      const resumed = await source.sync(first.cursor, run("run-2", 0));
      expect(resumed.hasMore).toBe(true);

      clock += 21 * 60 * 1000;
      const late = await source.sync(resumed.cursor, run("run-2", 1));
      expect(late.hasMore).toBe(false);
      expect((late.cursor as GmailSyncCursor).phase).toBe("bootstrap");
    } finally {
      now.mockRestore();
    }
  });
});

describe("Gmail bootstrap after a refused page token", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const newest = Date.UTC(2026, 5, 10);
  /** Five messages, a day apart, newest first. */
  const mailbox = ["m1", "m2", "m3", "m4", "m5"].map((id, i) => ({
    id,
    receivedAt: newest - i * DAY_MS,
  }));

  function invalidPageToken(): Error {
    return Object.assign(new Error("Invalid pageToken"), { code: 400 });
  }

  /**
   * Lists `mailbox` in pages of two, honouring a `before:<seconds>` bound.
   * Tokens are `<offset>@<before>`; any token named in `refused` is answered
   * with Gmail's 400, once.
   */
  function listing(refused: Set<string>) {
    return vi.fn((params: { pageToken?: string; q?: string }) => {
      if (params.pageToken && refused.delete(params.pageToken)) {
        return Promise.reject(invalidPageToken());
      }
      const before = /before:(\d+)/.exec(params.q ?? "")?.[1];
      const visible = mailbox.filter(
        (m) => before === undefined || m.receivedAt < Number(before) * 1000,
      );
      const start = params.pageToken ? Number(params.pageToken.split("@")[0]) : 0;
      const page = visible.slice(start, start + 2);
      const next = start + 2 < visible.length ? `${start + 2}@${before ?? "top"}` : undefined;
      return Promise.resolve({
        data: { messages: page.map((m) => ({ id: m.id })), nextPageToken: next },
      });
    });
  }

  function gmailFor(refused: Set<string>) {
    const gmail = createMockGmail();
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 5, historyId: "h-1" } }),
    );
    gmail.users.messages.get = vi.fn((params: { id: string }) => {
      const message = mailbox.find((m) => m.id === params.id)!;
      return Promise.resolve({
        data: makeGmailMessage(params.id, { internalDate: String(message.receivedAt) }),
      });
    });
    gmail.users.messages.list = listing(refused);
    return gmail;
  }

  async function walk(
    source: ReturnType<typeof createGmailSource>,
    cursor: GmailSyncCursor | null,
  ): Promise<{ seen: string[]; cursor: GmailSyncCursor }> {
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await source.sync(cursor);
      seen.push(...result.documents.map((d) => d.externalId));
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
    }
    return { seen, cursor: cursor! };
  }

  test("resumes just above the oldest listed message and loses nothing", async () => {
    const refused = new Set(["2@top"]);
    const gmail = gmailFor(refused);
    const source = createGmailSource(gmail);

    const first = await source.sync(null);
    expect(first.documents.map((d) => d.externalId)).toEqual(["m1", "m2"]);
    const paused = first.cursor as GmailSyncCursor;
    expect(paused.pageToken).toBe("2@top");
    expect(paused.oldestListedAt).toBe(new Date(mailbox[1]!.receivedAt).toISOString());

    const { seen, cursor } = await walk(source, paused);
    // A day of overlap re-lists m2; everything older follows, nothing is skipped.
    expect(seen).toEqual(["m2", "m3", "m4", "m5"]);
    expect(cursor.phase).toBe("incremental");
    expect(cursor.coverage).toBe("complete");
    expect(cursor.listBefore).toBeUndefined();
    expect(cursor.oldestListedAt).toBeUndefined();

    const bound = Math.ceil((mailbox[1]!.receivedAt + DAY_MS) / 1000);
    const calls = gmail.users.messages.list.mock.calls.map(
      ([params]: [{ pageToken?: string; q?: string }]) => params,
    );
    expect(calls[1]).toMatchObject({ pageToken: "2@top" });
    expect(calls[2]!.pageToken).toBeUndefined();
    expect(calls[2]!.q).toContain(`before:${bound}`);
    // The resumed listing's own tokens are used with the same bound.
    expect(calls[3]!.q).toContain(`before:${bound}`);
    expect(calls[3]!.pageToken).toBe(`2@${bound}`);
  });

  test("restarts from the newest mail when the walk recorded no oldest message", async () => {
    const gmail = gmailFor(new Set(["2@top"]));
    const source = createGmailSource(gmail);
    const { seen, cursor } = await walk(source, {
      phase: "bootstrap",
      pageToken: "2@top",
      bootstrapHistoryId: "h-1",
      totalMessages: 5,
      processedDocs: 2,
    });
    expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(cursor.phase).toBe("incremental");
    const resumed = gmail.users.messages.list.mock.calls[1]![0] as { q: string };
    expect(resumed.q).not.toContain("before:");
  });

  test("any other 400 still fails the sync", async () => {
    const gmail = gmailFor(new Set());
    gmail.users.messages.list = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Invalid query"), { code: 400 })),
    );
    const source = createGmailSource(gmail);
    await expect(
      source.sync({ phase: "bootstrap", pageToken: "2@top", bootstrapHistoryId: "h-1" }),
    ).rejects.toThrow();
    expect(gmail.users.messages.list).toHaveBeenCalledTimes(1);
  });
});

describe("Gmail messages that disappear", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
  });

  test("a message deleted before it is fetched is deleted, not taken for an expired history", async () => {
    const source = createGmailSource(gmail);
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({
        data: {
          history: [
            { messagesAdded: [{ message: { id: "draft-1" } }, { message: { id: "m-2" } }] },
          ],
          historyId: "h-2",
        },
      }),
    );
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      params.id === "draft-1"
        ? Promise.reject(apiError(404))
        : Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
    const result = await source.sync({ phase: "incremental", historyId: "h-1" });
    expect(result.documents.map((d) => d.externalId)).toEqual(["m-2"]);
    expect(result.deletedExternalIds).toEqual(["draft-1"]);
    const cursor = result.cursor as GmailSyncCursor;
    expect(cursor.phase).toBe("incremental");
    expect(cursor.historyId).toBe("h-2");
    expect(cursor.recoverAfter).toBeUndefined();
  });

  test("a message deleted while a bootstrap page is fetched is skipped", async () => {
    const source = createGmailSource(gmail);
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "gone" }, { id: "kept" }] } }),
    );
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      params.id === "gone"
        ? Promise.reject(apiError(404))
        : Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
    const result = await source.sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual(["kept"]);
  });
});

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function messageWith(
  id: string,
  parts: Array<Record<string, unknown>>,
  html?: string,
): Record<string, unknown> {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "1704067200000",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "Subject", value: "Quarterly plan" },
        { name: "From", value: "maya.reeves@example.com" },
        { name: "To", value: "jamie.lopez@example.org" },
        { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("See attached.") } },
        ...(html ? [{ mimeType: "text/html", body: { data: b64(html) } }] : []),
        ...parts,
      ],
    },
  };
}

describe("Gmail attachments", () => {
  let gmail: ReturnType<typeof createMockGmail>;
  let extract: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gmail = createMockGmail();
    gmail.users.messages.attachments.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: { data: b64(params.id) } }),
    );
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-1" }] } }),
    );
    extract = vi.fn(() => Promise.resolve({ text: "Whiteboard notes", truncated: false }));
  });

  function source() {
    return createGmailSource(gmail, {
      extractAttachment: extract as unknown as AttachmentExtractFn,
      attachmentConfig: {
        enabled: true,
        maxSizeBytes: 25_000_000,
        allowedTypes: ["image/png", "text/plain"],
        maxTextLength: 500_000,
      },
    });
  }

  test("a small image the HTML shows inline is decoration, not an attachment", async () => {
    const logo = {
      filename: "image001.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<logo-1@example.com>" }],
      body: { attachmentId: "att-logo", size: 4_000 },
    };
    const screenshot = {
      filename: "image002.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<shot-1@example.com>" }],
      body: { attachmentId: "att-shot", size: 400_000 },
    };
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: messageWith(
          "m-1",
          [logo, screenshot],
          '<p>See below</p><img src="cid:shot-1@example.com"><p>Maya</p><img src="cid:logo-1@example.com">',
        ),
      }),
    );
    const result = await source().sync(null);
    expect(result.documents[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({ filename: "image002.png", extracted: true }),
    ]);
    expect(result.documents[0]!.content).not.toContain("image001.png");
  });

  test("an inline image whose text adds a phone number the message lacks is kept", async () => {
    const signature = {
      filename: "image001.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<sig-1@example.com>" }],
      body: { attachmentId: "att-sig", size: 6_000 },
    };
    const badge = {
      filename: "image002.png",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<badge-1@example.com>" }],
      body: { attachmentId: "att-badge", size: 3_000 },
    };
    const ocr: Record<string, string> = {
      "att-sig": "Maya\nMobile +44 7700 900123",
      "att-badge": "Maya",
    };
    extract.mockImplementation((data: Uint8Array) =>
      Promise.resolve({ text: ocr[Buffer.from(data).toString()], truncated: false }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: messageWith(
          "m-1",
          [signature, badge],
          '<p>Thanks, Maya</p><img src="cid:sig-1@example.com"><img src="cid:badge-1@example.com">',
        ),
      }),
    );
    const result = await source().sync(null);
    expect(result.documents[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({ filename: "image001.png", extracted: true }),
    ]);
    expect(result.documents.map((d) => d.content).join("\n")).toContain("+44 7700 900123");
  });

  test("a text attachment is extracted in the charset its part declares", async () => {
    const notes = {
      filename: "notes.txt",
      mimeType: "text/plain",
      headers: [
        { name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"; name="notes.txt"' },
      ],
      body: { attachmentId: "att-txt", size: 300 },
    };
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [notes]) }));
    await source().sync(null);
    expect(extract).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "text/plain; charset=ISO-8859-1",
      expect.anything(),
    );
  });

  test("an attachment whose text could not be extracted is recorded as failed", async () => {
    extract.mockResolvedValueOnce(null);
    const scan = {
      filename: "scan.png",
      mimeType: "image/png",
      body: { attachmentId: "att-png", size: 90_000 },
    };
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: messageWith("m-1", [scan]) }));
    const result = await source().sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({
        filename: "scan.png",
        extracted: false,
        reason: "extraction-failed",
      }),
    ]);
  });
});
