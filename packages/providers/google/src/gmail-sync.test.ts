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
