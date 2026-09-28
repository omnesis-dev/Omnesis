// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { GMAIL_OUTPUT_REVISION } from "./constants.js";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
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

describe("Gmail rewalk", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
    gmail.users.messages.get = vi.fn((params: { id: string }) =>
      Promise.resolve({ data: makeGmailMessage(params.id) }),
    );
  });

  test("a mailbox indexed under an older output revision is walked again beside incremental sync", async () => {
    const source = createGmailSource(gmail);
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d", "e"], 2);
    let cursor: GmailSyncCursor = {
      phase: "incremental",
      historyId: "h-1",
      coverage: "complete",
    };
    const emitted: string[] = [];
    let pages = 0;
    for (;;) {
      const result = await source.sync(cursor);
      pages += 1;
      emitted.push(...result.documents.map((d) => d.externalId));
      cursor = result.cursor as GmailSyncCursor;
      if (!result.hasMore) break;
      expect(result.progress?.phase).toBe("refresh");
      expect(cursor.outputRevision).toBeUndefined();
    }
    expect(pages).toBe(3);
    expect(emitted).toEqual(["a", "b", "c", "d", "e"]);
    expect(cursor.outputRevision).toBe(GMAIL_OUTPUT_REVISION);
    expect(cursor.rewalk).toBeUndefined();
    expect(cursor.coverage).toBe("complete");

    // Once current, incremental sync lists nothing.
    gmail.users.messages.list.mockClear();
    const next = await source.sync(cursor);
    expect(next.hasMore).toBe(false);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
  });

  test("a rewalk page token Gmail no longer accepts starts the rewalk over", async () => {
    const source = createGmailSource(gmail);
    gmail.users.messages.list = vi.fn(() => Promise.reject(apiError(400)));
    const result = await source.sync({
      phase: "incremental",
      historyId: "h-1",
      rewalk: { pageToken: "stale", processed: 300 },
    } as GmailSyncCursor);
    expect(result.hasMore).toBe(true);
    expect((result.cursor as GmailSyncCursor).rewalk).toEqual({ processed: 0 });
  });

  test("a bootstrap that ends on the message count hands its remaining pages to a rewalk", async () => {
    const source = createGmailSource(gmail);
    // Gmail reports two messages but keeps serving pages.
    gmail.users.getProfile = vi.fn(() =>
      Promise.resolve({ data: { messagesTotal: 2, historyId: "h-1" } }),
    );
    gmail.users.messages.list = pagedMailbox(["a", "b", "c", "d"], 2);

    const first = await source.sync(null);
    const cursor = first.cursor as GmailSyncCursor;
    expect(first.hasMore).toBe(false);
    expect(cursor.phase).toBe("incremental");
    expect(cursor.coverage).toBe("unknown");
    expect(cursor.rewalk).toEqual({ pageToken: "2", processed: 2 });

    const second = await source.sync(cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual(["c", "d"]);
    const settled = second.cursor as GmailSyncCursor;
    expect(settled.rewalk).toBeUndefined();
    expect(settled.coverage).toBe("complete");
    expect(settled.outputRevision).toBe(GMAIL_OUTPUT_REVISION);
  });

  test("a recovery bootstrap keeps the mailbox's revision and its pending rewalk", async () => {
    const source = createGmailSource(gmail);
    gmail.users.history.list = vi.fn(() => Promise.reject(apiError(404)));
    const handed = await source.sync({
      phase: "incremental",
      historyId: "h-1",
      lastSyncAt: "2026-05-30T00:00:00.000Z",
      outputRevision: 1,
      rewalk: { pageToken: "40", processed: 4000 },
    } as GmailSyncCursor);
    const recovery = handed.cursor as GmailSyncCursor;
    expect(recovery.phase).toBe("bootstrap");
    expect(recovery.rewalk).toEqual({ pageToken: "40", processed: 4000 });

    gmail.users.messages.list = vi.fn(() => Promise.resolve({ data: { messages: [{ id: "a" }] } }));
    const done = (await source.sync(recovery)).cursor as GmailSyncCursor;
    expect(done.phase).toBe("incremental");
    expect(done.outputRevision).toBe(1);
    expect(done.rewalk).toEqual({ pageToken: "40", processed: 4000 });
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
    const result = await source.sync({
      phase: "incremental",
      historyId: "h-1",
      outputRevision: GMAIL_OUTPUT_REVISION,
    } as GmailSyncCursor);
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
